# Plan: POC v6 — OAuth2 and the prepareRequest Hook

**Status:** `planned`
**Depends on:** v5 POC (ctx.http, request journal, ctx.state)

## Goal

Validate the two remaining auth patterns: OAuth2 (centralized, engine-managed) and `prepareRequest`
(bespoke, connector-managed). After v6, all three auth paths are proven — `ctx.http` is complete
and connectors can be written against it with confidence.

The mock API server from v5 is extended to support both an OAuth2 token endpoint and a
signature-based auth variant, so each path can be tested without external dependencies.

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
POST /employees                 — requires Authorization: Bearer <token>
PUT  /employees/:id             — requires Authorization: Bearer <token>

POST /session/login             — returns { session: "<token>" }  (prepareRequest variant)
GET  /employees/legacy?since=…  — requires X-Session: <token>     (prepareRequest variant)

POST /signed/employees          — requires X-Signature HMAC header (prepareRequest HMAC variant)

POST /__expire-token            — test-only: mark current token as expired on mock server's side
POST /__invalidate-session      — test-only: invalidate the session token
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

---

## Work Items

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

---

## Open Questions

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
