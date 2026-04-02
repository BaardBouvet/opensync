# Auth

Centralized authentication management. Connectors never handle tokens or secrets directly.

## Design Principles

- **Single Writer, Many Readers**: Only one process refreshes tokens at a time
- **Connectors are auth-ignorant**: They just call `ctx.http()` and it works
- **Full traceability**: Auth headers are auto-injected but masked in the request journal

## Auth Types

### 1. OAuth2 (Centralized)

The engine manages the full OAuth2 lifecycle: initial authorization, token storage, automatic refresh.

```typescript
class OAuthTokenManager {
  getAccessToken(connectorInstanceId: string): Promise<string>;
  storeTokens(connectorInstanceId: string, tokens: { accessToken, refreshToken?, expiresAt? }): Promise<void>;
}
```

**Token storage**: `oauth_tokens` table with `access_token`, `refresh_token`, `expires_at`, `locked_at`.

**Refresh flow**:
1. `getAccessToken()` checks if token is expired (or within 5-minute buffer)
2. If expired: acquire lock (`locked_at` column), call token endpoint, store new tokens, release lock
3. If locked by another process: wait 500ms, retry from cache (the other process probably just refreshed)
4. Return valid access token

**Lock mechanism**: `UPDATE oauth_tokens SET locked_at = now() WHERE connector_instance_id = ? AND (locked_at IS NULL OR locked_at < now() - 30s)`. If no rows updated, lock is held by someone else.

**Token injection**: The `ctx.http` wrapper checks for OAuth config, calls `getAccessToken()`, and adds `Authorization: Bearer <token>` to every outgoing request.

### 2. API Key / Bearer Token (Static)

Simple: token stored in `connector_instances.config` (encrypted), injected into `ctx.http` as a header.

### 3. Bespoke Auth (prepareRequest Hook)

For systems with non-standard auth: HMAC signing, session tokens, custom headers, certificate-based auth.

```typescript
prepareRequest?(req: Request, ctx: SyncContext): Promise<Request>;
```

Called before every outbound HTTP request made via `ctx.http`. The connector can:

**Session tokens**: Login once, store session in `ctx.state`, refresh when expired:
```typescript
async prepareRequest(req, ctx) {
  let session = await ctx.state.get('session_id');
  if (!session) {
    const loginRes = await fetch(`${ctx.config.baseUrl}/auth`, {
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
1. If connector has `prepareRequest` → call it (bespoke auth)
2. Else if OAuth is configured for this instance → inject bearer token
3. Else if API key is in config → inject as header
4. Else → send without auth

## Environment-Specific Auth

Different environments (test/prod) may have different auth configs. The `connector_instances` table stores per-instance config including auth credentials. The connector's `metadata.environments` maps names to base URLs.

When a user configures an instance, they choose the environment and provide the corresponding credentials. The engine resolves the base URL and injects it into `ctx.config.baseUrl`.

## Security

- Tokens are stored in SQLite. For production use, sensitive fields in `connector_instances.config` and `oauth_tokens` should be encrypted at rest.
- The request journal automatically masks `Authorization` headers — the token value is replaced with `[REDACTED]`.
- `prepareRequest` receives a cloned request — the original is preserved for logging purposes (pre-auth).
