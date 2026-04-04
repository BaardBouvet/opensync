# v6 Lessons Learned

## What v6 was

Validated the two remaining auth patterns (OAuth2 client-credentials and `prepareRequest`
bespoke auth) and the ETag threading model (`ReadRecord.version` → `UpdateRecord.version`).
Extended the v5 mock server to expose a token endpoint, signature-based auth, and ETag
headers on read/write. After v6, the full `ctx.http` auth matrix was proven.

## What worked

### OAuth2 token lifecycle is fully engine-managed

The connector declares `metadata.auth.type = 'oauth2'` and implements `getOAuthConfig()`.
The engine handles everything else: initial token acquisition, storing in `oauth_tokens`,
injecting the Bearer header, and transparent refresh before expiry. The connector never
sees credentials — it only sees successful HTTP calls. This is the correct separation.

The lock mechanism (preventing concurrent refresh races when multiple parallel reads
fire at token expiry) worked correctly in tests. The `oauth_tokens` table with a
`locked_until` column is the right pattern.

### `prepareRequest` correctly short-circuits engine-managed auth

When a connector implements `prepareRequest`, it receives the raw `Request` object and
returns a modified one. The engine injects this before any auth logic. Connectors using
HMAC signatures, session cookies, or multi-step auth flows can implement any scheme
they need without engine changes. The priority order (`prepareRequest` first, then
OAuth2, then API key) is correct.

### ETag threading through the dispatch loop

`ReadRecord.version` is stored in `shadow_state.version` when a record is ingested.
When the engine dispatches an update to a connector, it includes `version` in
`UpdateRecord`. The connector can then send `If-Match: <etag>` and handle 412. This
proves the connector contract is right for optimistic locking — the engine doesn't
need to know what the version field means, only that it exists and flows through.

### Auth tested end-to-end with no external services

All three auth paths (API key from v5, OAuth2, prepareRequest) were validated against
in-process mock servers. Zero external credentials, zero network dependency, fully
deterministic tests.

## What broke down

### 412 retry machinery not implemented

The POC proved that `version` flows correctly to the connector, but when the connector
gets a 412 (ETag mismatch — the record was updated externally since last read), the
engine has no retry-after-re-read loop. The connector throws an error and the batch
fails. Production needs: receive 412 → re-read the record → update shadow state →
retry the dispatch. Specified in `specs/safety.md`; not implemented yet.

### OAuth2 scope handling not tested

`getOAuthConfig()` can return a `scopes` array, but all token requests in v6 used
no-scope client credentials. A connector requiring specific scopes (e.g. Google APIs)
was not validated. The token manager implementation should handle scope in the request
but this was not confirmed.

### `prepareRequest` async error path not fully handled

If `prepareRequest` throws (e.g. signature generation fails), the error propagated
correctly but was not attributed to the connector in the request journal. The request
journal row showed a generic error rather than indicating which connector's
`prepareRequest` failed.

### No token revocation on `onDisable`

When a connector is disabled, its OAuth tokens remain in `oauth_tokens`. The engine
does not call a revocation endpoint. For connectors that issue long-lived tokens, this
is a security gap. The spec (`specs/auth.md`) documents the expected cleanup behaviour.
