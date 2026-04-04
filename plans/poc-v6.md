# Plan: POC v6 — OAuth2, prepareRequest, and Lookup-Merge ETag

**Status:** `planned`
**Depends on:** v5 POC (ctx.http, request journal, ctx.state)
**Absorbs:** `lookup-merge-etag.md` plan (connector foundation validated here)

## Goal

Validate three things in one POC:

1. The two remaining auth patterns: OAuth2 (centralized, engine-managed) and `prepareRequest`
   (bespoke, connector-managed). After v6, all three auth paths are proven — `ctx.http` is
   complete and connectors can be written against it with confidence.
2. The connector-side foundation for ETag / optimistic-lock writes: `ReadRecord.version` flowing
   through the engine's dispatch loop and arriving as `UpdateRecord.version` at the connector.
   The full engine retry-on-412 machinery is out of scope; this POC establishes that the
   connector contract is right before building the surrounding machinery.

The mock API server from v5 is extended to support both an OAuth2 token endpoint and a
signature-based auth variant, so each auth path can be tested without external dependencies.
The same mock-erp server also exposes ETag headers on lookup responses and validates
`If-Match` on writes, so the ETag threading can be tested end-to-end at the connector layer.

---

## The Three Auth Paths (recap)

`ctx.http` resolves auth in this priority order before making every request:

```
1. connector has prepareRequest?  → call it, skip everything else
2. metadata.auth.type === 'oauth2'   → inject Bearer token (refresh if expired)
3. metadata.auth.type === 'api-key'  → inject static key as Bearer header
4. metadata.auth.type === 'none'     → no auth header
```

v5 validated path 3. v6 validates paths 1 and 2, and validates that path 1 correctly short-circuits
paths 2 and 3.

---

## What v6 Validates

### 1. OAuth2 — Token Lifecycle

The engine manages the full OAuth2 Client Credentials flow (machine-to-machine, no browser
redirect needed for the POC). The connector declares `metadata.auth.type = 'oauth2'` and
implements `getOAuthConfig()`.

Flow to validate end-to-end:

```
Engine start
  → calls connector.getOAuthConfig(ctx)
  → checks oauth_tokens table: no token yet
  → POST /oauth/token (client_credentials grant)
  → stores { access_token, expires_at } in oauth_tokens
  → ctx.http calls use Bearer token automatically

Token expires (simulated)
  → ctx.http detects expires_at within 5-minute buffer
  → acquires lock (UPDATE oauth_tokens SET locked_at = ...)
  → POST /oauth/token to refresh
  → stores new token, clears locked_at

Concurrent refresh (simulated with two async tasks)
  → Task A acquires lock, starts refresh
  → Task B sees locked_at set, waits 500ms, reads refreshed token from DB
  → Both tasks proceed with valid token, only one refresh call made
```

Questions to resolve:
- The lock is a SQLite `UPDATE ... WHERE locked_at IS NULL OR locked_at < now() - 30s`
  and "affected rows === 1" check. SQLite serializes writes, so this is safe even in Bun's
  single-event-loop async model — but verify it with a concurrent test.
- What happens when the token endpoint itself returns an error? The engine should surface this
  as a connector-level error (not crash), trip the circuit breaker if it persists.
- Does `getOAuthConfig()` receive current `ctx.config` correctly, so the connector can derive
  the token endpoint from `ctx.config.baseUrl`? Validate with a dynamic URL (mock server port
  injected at test time).

### 2. OAuth2 — Scope Union

The spec says required scopes are the union of `auth.scopes` + entity scopes + action scopes.
v6 should validate that the correct scope set is sent in the token request.

This is a connector-level declaration, but the engine must assemble it. Simple to test:
mock server's `/oauth/token` echoes back the requested scopes; assert the engine sent the
right union.

### 3. `prepareRequest` — Session Token Pattern

A mock connector that doesn't use OAuth but needs to log in first:

```
First request
  → ctx.state.get('session') → null
  → POST /auth with user/pass credentials
  → stores session token in ctx.state
  → retries original request with X-Session header

Subsequent requests
  → ctx.state.get('session') → token
  → injects header directly, no extra login call

Session expiry (simulated: mock server returns 401)
  → connector invalidates ctx.state.get('session')
  → refreshes via POST /auth
  → retries
```

The critical thing to validate: **no recursion**. The `POST /auth` call inside `prepareRequest`
goes through `ctx.http`, which must not call `prepareRequest` again — otherwise login calls
trigger more login calls indefinitely. The spec says `prepareRequest` calls bypass the hook.
Verify this with a test that asserts `/auth` is called exactly once per session.

### 4. `prepareRequest` — HMAC Signing

A mock connector where every request must be signed:

```
ctx.http("POST /data", { body: '{"name":"Alice"}' })
  → prepareRequest clones body, computes HMAC-SHA256
  → adds X-Signature header to request
  → mock server validates signature, returns 200 or 401
```

What this tests beyond the signing itself:
- `req.clone()` is needed before reading the body — validate the stream is not consumed
- Signed headers must not appear in the journal in plain text (masking still applies)
- The original unmodified request object is logged (pre-prepareRequest), so the journal row
  shows the request the connector intended, not the wire format

### 5. `prepareRequest` short-circuits built-in auth

If a connector declares both `prepareRequest` and `metadata.auth.type = 'oauth2'`, the
`prepareRequest` hook runs and the OAuth token injection is skipped entirely. Verify this
explicitly — a connector should be able to handle its own auth without the engine interfering.

---

## What v6 Validates (continued): Lookup-Merge ETag

This section covers the connector-foundation half of the `lookup-merge-etag.md` plan. The engine
machinery (retry-on-412, `prefetchBeforeWrite` channel option, storing `version` in `shadow_state`)
is explicitly deferred. What v6 does establish:

### 6. `ReadRecord.version` — connector captures ETag from lookup

`mock-erp` returns an `ETag` header on every `GET /employees/:id` response. The `mock-erp`
connector's `lookup()` implementation captures it:

```typescript
return {
  id,
  data,
  version: res.headers.get('ETag') ?? undefined,
};
```

The `ReadRecord` type gains an optional `version` field (additive, no existing connector
impacted). The engine stores it alongside the lookup result in a local map during the dispatch
pass, then populates `UpdateRecord.version` before calling `connector.update()`.

What v6 proves:
- The field flows from `lookup()` result → engine dispatch loop → `UpdateRecord` without loss.
- Connectors that omit `version` (e.g. the existing jsonfiles connector) are completely
  unaffected — the field is absent on both ends, no behavioral change.

### 7. `UpdateRecord.version` — connector uses ETag for conditional write

The `mock-erp` connector's `update()` method forwards `version` as an `If-Match` header if
present, and otherwise sends the write without it:

```typescript
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (record.version) headers['If-Match'] = record.version;
const res = await ctx.http(`${base}/employees/${record.id}`, {
  method: 'PUT',
  headers,
  body: JSON.stringify({ ...snapshot, ...record.data }),
});
if (res.status === 412) {
  yield { id: record.id, error: '412 Precondition Failed — record modified concurrently' };
  continue;
}
```

`mock-erp` validates the `If-Match` header server-side (returns 412 if the stored ETag doesn't
match the request). A test-control endpoint `POST /__mutate-employee/:id` modifies a record
out-of-band to advance the server's ETag, enabling the 412 path to be exercised deterministically.

### 8. `UpdateRecord.snapshot` — full-replace PUT connector avoids double lookup

`mock-erp` only supports full-replace PUT (no PATCH). The connector needs the entire existing
record to merge changes into before writing. Because the engine already called `lookup()` for
conflict detection (or `prefetchBeforeWrite`), it can populate `UpdateRecord.snapshot` with the
full live record, sparing the connector a second fetch.

`UpdateRecord` gains an optional `snapshot` field. The engine populates it when it has a live
lookup result for the record in the current dispatch pass; otherwise it is absent and the connector
falls back to its own `fetchOne()` call. v6 tests both paths (snapshot present → no extra fetch;
snapshot absent → connector does its own fetch).

What v6 proves:
- The snapshot is the same data the connector would have fetched itself (no divergence).
- When snapshot is absent the connector still works correctly (graceful degradation).
- No existing connector (`mock-crm`, jsonfiles) is impacted by the additive field.

### 9. 412 result is a per-record error, not a throw

When the server returns 412, the connector yields `{ id, error: '412 ...' }` rather than
throwing. The engine treats this as a per-record failure and marks the record for retry on the
next cycle, without aborting the rest of the write run. v6 tests:
- The 412 record produces an `action: 'error'` in `IngestResult.records`.
- The remaining records in the same batch are still written successfully.

---

## Mock SaaS Servers

v6 introduces a second mock SaaS alongside mock-crm from v5. Running two distinct servers with
different auth patterns reflects the real scenario: syncing between systems that each have their
own auth contract.

### `mock-crm` (from v5, unchanged)

API key auth. Unchanged from v5. The engine connects to it using the static `api-key` path in
`ctx.http`.

### `mock-erp` (new in v6)

A second in-process Hono server representing an ERP system. Exposes the same contact-like entity
(`employees`, to keep it distinct from CRM `contacts`) but protected by OAuth2 Client Credentials.
Also has a legacy session-based variant for testing `prepareRequest`.

```
mock-erp endpoints:

POST /oauth/token
  body: { grant_type, client_id, client_secret, scope }
  response: { access_token, token_type, expires_in, scope }

GET  /employees?since=<iso>     — requires Authorization: Bearer <token>
GET  /employees/:id             — requires Bearer; returns ETag header
POST /employees                 — requires Bearer
PUT  /employees/:id             — requires Bearer; validates If-Match if present, returns 412 on mismatch

POST /session/login             — returns { session: "<token>" }  (prepareRequest variant)
GET  /employees/legacy?since=…  — requires X-Session: <token>     (prepareRequest variant)

POST /signed/employees          — requires X-Signature HMAC header (prepareRequest HMAC variant)

POST /__expire-token            — test-only: mark current token as expired on mock server's side
POST /__invalidate-session      — test-only: invalidate the session token
POST /__mutate-employee/:id     — test-only: modify a field out-of-band to advance the stored ETag
```

`mock-erp` is started alongside `mock-crm` in the same test process, on a different port.
`openlink.json` for the v6 POC has two connector entries:

```json
{
  "connectors": {
    "crm": {
      "plugin": "@opensync/connector-mock-crm",
      "config": { "baseUrl": "http://localhost:4000", "apiKey": "test-key" }
    },
    "erp": {
      "plugin": "@opensync/connector-mock-erp",
      "config": {
        "baseUrl": "http://localhost:4001",
        "clientId": "opensync-test",
        "clientSecret": "secret"
      }
    }
  }
}
```

The v6 sync scenario: `contacts` in mock-crm ↔ `employees` in mock-erp, synced through a
`people` channel. Each connector uses a completely different auth path — the sync pipeline and
field mapping are the same as v3/v4/v5; only the auth layer differs.

### `connectors/mock-erp/`

New connector package alongside `connectors/mock-crm/`. Implements `Connector` with
`metadata.auth.type = 'oauth2'`, `getOAuthConfig()`, and the `getEntities()` definition for
`employees`. Also exports a `prepareRequest` variant (as a separate named export or a factory
function) for the session-token and HMAC tests.

---

## Mock Server Extensions (beyond v5)

All new endpoints live on `mock-erp` (port 4001). `mock-crm` (port 4000) is unchanged from v5.
The `/__expire-token` and `/__invalidate-session` test-control endpoints are only active in the
test build of mock-erp.

---

## New SQLite Tables (beyond v5)

### `oauth_tokens`

```sql
CREATE TABLE oauth_tokens (
  connector_id    TEXT PRIMARY KEY,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT,
  expires_at      TEXT,            -- ISO 8601; null means non-expiring
  locked_at       TEXT             -- set during refresh; cleared after
);
```

No new tables for `prepareRequest` — it uses `ctx.state` (the `connector_state` table from v4).

No new tables for ETag — `version` values are carried in the engine's in-memory dispatch
context for the duration of the current ingest pass. Storing `version` in `shadow_state` is an
open question deferred to the full engine (see Open Questions).

---

## SDK Changes (additive, planned here — implemented when v6 is built)

| Item | Type |
|------|------|
| Add `version?: string` to `ReadRecord` | Additive — existing connectors unaffected |
| Add `version?: string` to `UpdateRecord` | Additive — existing connectors unaffected |
| Add `snapshot?: Record<string, unknown>` to `UpdateRecord` | Additive |
| Engine: copy `version` from `lookup()` result into `UpdateRecord` during dispatch | Engine internals |
| Engine: populate `snapshot` on `UpdateRecord` when lookup result is available | Engine internals |

---

## Work Items

### Auth (OAuth2 + prepareRequest)

1. `mock-erp` API server (Hono, in-process, start/stop for tests) — port 4001
2. `connectors/mock-erp/` connector package — OAuth2, `getOAuthConfig()`, `employees` entity
3. `openlink.json` for v6 POC — two connectors (crm: api-key, erp: oauth2)
4. `mappings/` for v6 POC — `people` channel mapping crm `contacts` ↔ erp `employees`
5. `OAuthTokenManager` class — `getAccessToken()`, `storeTokens()`, lock/retry logic
6. `oauth_tokens` table
7. `ctx.http` OAuth path — detect `metadata.auth.type === 'oauth2'`, call token manager
8. Scope union assembly from `metadata.auth.scopes` + entity scopes + action scopes
9. Test: full token lifecycle (acquire → use → expire → refresh) against mock-erp
10. Test: concurrent refresh — lock contention, only one `/oauth/token` call made
11. Test: token endpoint error → connector-level error, not crash
12. Test: end-to-end sync crm↔erp — api-key auth on one side, oauth2 on the other
13. `ctx.http` `prepareRequest` path — call hook, skip built-in auth injection
14. Non-recursion guard — `ctx.http` calls inside `prepareRequest` skip the hook
15. Session token `prepareRequest` variant against mock-erp `/session/login`
16. Test: session login called exactly once per session (no recursion)
17. Test: 401 from mock-erp → session invalidated, re-login, retry
18. HMAC signing `prepareRequest` variant against mock-erp `/signed/employees`
19. Test: body not consumed before signing; signature validates on server
20. Test: pre-hook request logged in journal (not post-hook wire format)
21. Test: `prepareRequest` presence suppresses OAuth injection

### Lookup-Merge ETag (connector foundation)

22. Add `version?: string` to `ReadRecord` in `packages/sdk/src/types.ts`
23. Add `version?: string` and `snapshot?: Record<string, unknown>` to `UpdateRecord`
24. `mock-erp`: `GET /employees/:id` returns `ETag` header; `PUT /employees/:id` validates
    `If-Match` and returns 412 on mismatch; `POST /__mutate-employee/:id` test-control endpoint
25. Engine dispatch loop: after `lookup()`, carry `version` and full live record in a local map
    keyed by record ID; attach both to `UpdateRecord` before calling `connector.update()`
26. `mock-erp` connector `lookup()`: capture `ETag` header → `ReadRecord.version`
27. `mock-erp` connector `update()`: forward `version` as `If-Match`; yield per-record error on 412;
    use `snapshot` for merge if present, otherwise fall back to internal `fetchOne()`
28. Test: `version` present in `UpdateRecord` when `lookup()` returns it (end-to-end threading)
29. Test: `snapshot` present in `UpdateRecord` when engine pre-fetched; connector skips own fetch
30. Test: `snapshot` absent → connector performs its own fetch (graceful degradation)
31. Test: 412 path — out-of-band mutation → `If-Match` fails → per-record error, rest of batch succeeds
32. Test: connector that omits `version` entirely (mock-crm / jsonfiles) — no behavioral change

---

## Open Questions

### Auth

- **Authorization Code flow**: Client Credentials (machine-to-machine) is fine for the POC.
  Authorization Code (user consent, browser redirect) is needed for real HubSpot/Fiken
  connectors. That flow requires a local redirect server or a CLI `opensync auth <connectorId>`
  command to open a browser. Defer to a dedicated auth POC or the real engine.
- **Token encryption at rest**: The spec says sensitive fields should be encrypted. For the POC,
  plain text is fine — but the `oauth_tokens` table design should leave room for an `encrypted`
  flag or a separate secrets backend. Don't bake in plaintext as an assumption.
- **`prepareRequest` and response handling**: The current spec only covers request mutation.
  Should `prepareRequest` also be able to inspect the response — e.g. to detect a 401 and retry?
  Or is that a separate `handleResponse` hook? This is the 401-retry pattern for session tokens.
  Tentative answer: handle it inside `prepareRequest` by checking `ctx.state`, but the interface
  needs to be specified before implementation.
- **Scope computation timing**: Scopes are declared per entity and action. Do we compute the union
  at `onEnable()` time (static, based on current channel membership) or at every token request
  (dynamic)? Static at enable time is simpler and matches how real OAuth apps work (scopes
  approved once at authorization time).

### Lookup-Merge ETag

- **Always pre-fetch or only on conflict detection?** Pre-fetching unconditionally costs one
  `lookup()` call per updated record per cycle. Proposed default for v6: only populate
  `version`/`snapshot` when the engine already called `lookup()` for conflict detection in
  the current pass. A per-channel `prefetchBeforeWrite` option (and full deferred
  implementation) is deferred to the real engine.
- **Store `version` in `shadow_state`?** Storing it would let the engine re-use the last-seen
  version across cycles without a fresh lookup. But ETags must reflect the record *as it is now*,
  not as of the last sync. Tentative: yes, store alongside `canonical_data` for staleness
  detection, but still do a fresh `lookup()` before write when `prefetchBeforeWrite` is enabled.
  Not needed for the v6 POC — defer.
- **`If-Unmodified-Since` as a fallback?** For APIs without ETag but with `updatedAt`, the
  connector could use `updatedAt` from the lookup as `If-Unmodified-Since`. Weaker (1-second
  granularity) but still better than nothing. Leave entirely to the connector for now; no engine
  support needed.
- **Engine retry on 412**: The full retry-on-412 loop (fresh lookup → re-dispatch on next cycle)
  is explicitly out of scope for v6. The 412 result surfaces as a per-record error in
  `IngestResult`; the retry machinery is a follow-on task.
