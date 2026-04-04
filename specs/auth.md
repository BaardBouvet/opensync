# Auth

Centralized authentication management. Connectors never handle tokens or secrets directly.

## Design Principles

- **Single Writer, Many Readers**: Only one process refreshes tokens at a time
- **Connectors are auth-ignorant**: They just call `ctx.http()` and it works
- **Full traceability**: Auth headers are auto-injected but masked in the request journal

## Auth Types

### 1. OAuth2 (Centralized)

Declared in the connector with `metadata.auth = { type: 'oauth2' }`. The engine manages the full OAuth2 lifecycle: initial authorization, token storage, automatic refresh. Required scopes are computed as the union of `auth.scopes`, the scopes of all enabled entities, and the scopes of all enabled actions — see the SDK spec for details.

Auth endpoints are provided by the connector's `getOAuthConfig(ctx)` method, which receives `ctx.config` (including `baseUrl` resolved for the selected environment). This lets connectors derive auth URLs dynamically rather than hardcoding them — useful when the token endpoint is relative to the API base URL.

```typescript
class OAuthTokenManager {
  getAccessToken(connectorInstanceId: string): Promise<string>;
  storeTokens(connectorInstanceId: string, tokens: { accessToken, refreshToken?, expiresAt? }): Promise<void>;
}
```

**Token storage**: `oauth_tokens` table with `access_token`, `refresh_token`, `expires_at`, `locked_at`.

> **Why a dedicated table, not `connector_state`?** The `locked_at` column implements a
> SQLite-serialised mutex for concurrent-safe token refresh (see Lock mechanism below). This
> pattern requires an atomic `UPDATE … WHERE locked_at IS NULL` which would be awkward in a
> generic KV store like `connector_state`. The dedicated table also keeps token expiry
> queries simple.
>
> **Connectors cannot access `oauth_tokens`**: this table is engine-internal. Connector code
> never receives raw tokens — it calls `ctx.http()` and auth injection happens automatically.
> Connectors that need session state (non-OAuth bespoke auth) use `ctx.state` for that data.

**Refresh flow**:
1. `getAccessToken()` checks if token is expired (or within 5-minute buffer)
2. If expired: acquire lock (`locked_at` column), call token endpoint, store new tokens, release lock
3. If locked by another process: wait 500ms, retry from cache (the other process probably just refreshed)
4. Return valid access token

**Lock mechanism**: `UPDATE oauth_tokens SET locked_at = now() WHERE connector_instance_id = ? AND (locked_at IS NULL OR locked_at < now() - 30s)`. If no rows updated, lock is held by someone else.

**Token injection**: The `ctx.http` wrapper checks for OAuth config, calls `getAccessToken()`, and adds `Authorization: Bearer <token>` to every outgoing request.

### 2. API Key / Bearer Token (Static)

Simple: token stored in the `auth:` key of `opensync.json` (see §Credentials in opensync.json),
injected into `ctx.http` as a header. The engine reads `apiKey`, `api_key`, or `accessToken`
from the resolved auth credentials.

### 3. Bespoke Auth (prepareRequest Hook)

For systems with non-standard auth: HMAC signing, session tokens, custom headers, certificate-based auth.

```typescript
prepareRequest?(req: Request, ctx: ConnectorContext): Promise<Request>;
```

Called before every outbound HTTP request made via `ctx.http`. `ctx.http` is available inside `prepareRequest` — requests made through it are logged normally but skip `prepareRequest` itself, so there is no recursion.

**Session tokens**: Login once, store session in `ctx.state`, refresh when expired:
```typescript
async prepareRequest(req, ctx) {
  let session = await ctx.state.get('session_id');
  if (!session) {
    const loginRes = await ctx.http(`${ctx.config.baseUrl}/auth`, {
      method: 'POST',
      body: JSON.stringify({ user: ctx.config.user, pass: ctx.config.pass })
    });
    session = (await loginRes.json()).token;
    await ctx.state.set('session_id', session);
  }
  const newReq = new Request(req, { headers: { ...Object.fromEntries(req.headers), 'X-Session': session } });
  return newReq;
}
```

**HMAC signing**: Read the body, compute signature, add header:
```typescript
async prepareRequest(req, ctx) {
  const body = await req.clone().text();
  const signature = createHmac('sha256', ctx.config.secret).update(body).digest('hex');
  return new Request(req.url, {
    method: req.method,
    headers: { ...Object.fromEntries(req.headers), 'X-Signature': signature },
    body
  });
}
```

## Auth Priority

When `ctx.http` makes a request:
1. If connector has `prepareRequest` → call it (bespoke auth, skips built-in injection)
2. Else based on `metadata.auth.type`:
   - `oauth2` → inject `Authorization: Bearer <access_token>` (refresh if expired)
   - `api-key` → inject the stored key as `Authorization: Bearer <key>` (or `auth.header` if specified)
   - `basic` → inject `Authorization: Basic <base64(user:pass)>`
   - `none` → no auth header injected

## Credentials in opensync.json

Auth credentials are declared in `opensync.json` under a top-level `auth` key per connector,
**separate** from the connector's `config`. This separation is intentional: a connector may
have its own `config` key named `apiKey` (e.g. a connector that exposes a key as part of its
domain model, unrelated to auth). Merging credentials into `config` would cause silent
collisions. The engine auth layer reads exclusively from `auth`; `config` is passed untouched
to `ctx.config` inside the connector.

```json
{
  "connectors": {
    "crm": {
      "plugin": "./connectors/my-crm/src/index.ts",
      "auth": {
        "apiKey": "${CRM_API_KEY}"
      },
      "config": {
        "baseUrl": "https://api.example.com"
      }
    },
    "erp": {
      "plugin": "./connectors/my-erp/src/index.ts",
      "auth": {
        "clientId": "${ERP_CLIENT_ID}",
        "clientSecret": "${ERP_CLIENT_SECRET}"
      },
      "config": {
        "baseUrl": "https://erp.example.com"
      }
    }
  }
}
```

The `${VAR}` interpolation is applied to all string values in `auth` before they reach the
engine. The `auth` values are resolved at load time and held in `ConnectorInstance.auth`
through to `makeWiredInstance` — the connector never sees credentials directly.

Recognised auth credential keys:
- `apiKey` (also `api_key`, `accessToken`) — API key / bearer token (static)
- `clientId` (also `client_id`) + `clientSecret` (also `client_secret`) — OAuth2 client credentials

## Environment-Specific Auth

Different environments (test/prod) may have different base URLs and therefore different auth endpoints. The `connector_instances` table stores per-instance config including auth credentials. The connector's `metadata.environments` maps environment names to base URLs.

When a user configures an instance, they choose the environment. The engine resolves `baseUrl` into `ctx.config.baseUrl` and passes it to `getOAuthConfig(ctx)`. The connector constructs environment-correct auth endpoints from it — no per-environment URL overrides needed in metadata.

## Security

- Tokens are stored in SQLite. For production use, sensitive fields in `connector_instances.config` and `oauth_tokens` should be encrypted at rest.
- The request journal automatically masks `Authorization` headers — the token value is replaced with `[REDACTED]`.
- `prepareRequest` receives a cloned request — the original is preserved for logging purposes (pre-auth).
