# Webhooks

Real-time sync via push notifications from source systems.

## Design: Queue-First

Webhooks are **never processed inline**. The HTTP handler immediately writes to a queue and responds 200. A separate worker processes the queue asynchronously.

Why:
- Source systems time out if you take too long to respond (typically 5-30s)
- If processing crashes midway, the webhook data is safely in the queue for retry
- Handles webhook storms (e.g. 100k contacts imported → 100k webhooks in 1 minute)

## Flow

```
Source System
    │
    ▼ HTTP POST
[Webhook Server]
    │  1. Validate signature
    │  2. Write raw payload to webhook_queue
    │  3. Respond 200 OK immediately
    │
    ▼ (async)
[Webhook Processor]
    │  1. Dequeue entry
    │  2. Call connector.handleWebhook(req, ctx) → NormalizedRecord[]
    │  3. For thin webhooks: call connector.fetch() to enrich
    │  4. Feed into normal sync pipeline
    │
    ▼
[Sync Pipeline]  ─── same as polling flow from here
```

## Thin vs Thick Webhooks

**Thick webhooks** include the full object in the payload. The connector's `handleWebhook()` just normalizes it.

**Thin webhooks** include only an ID and event type (e.g. Stripe: `{ "type": "customer.created", "data": { "id": "cus_456" } }`). The connector calls `ctx.http` to fetch the full object before returning `NormalizedRecord[]`.

Both types look identical to the engine after `handleWebhook()` returns.

## Webhook Server

```typescript
class WebhookServer {
  constructor(db: OpenSyncDB, port?: number);
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

Routes:
- `POST /webhooks/:connectorInstanceId` — receive webhook, queue it
- `GET /health` — health check

Lightweight — Node.js built-in `http` or a minimal framework like Hono.

## Webhook Queue

```sql
CREATE TABLE webhook_queue (
  id TEXT PRIMARY KEY,
  connector_instance_id TEXT NOT NULL,
  raw_payload JSON NOT NULL,
  status TEXT DEFAULT 'pending',    -- pending, processing, completed, failed
  attempts INTEGER DEFAULT 0,
  error TEXT,
  created_at DATETIME DEFAULT (datetime('now'))
);
```

The processor polls this table and processes entries. Failed entries are retried with exponential backoff (up to `maxAttempts`).

## Signature Validation

Connectors handle their own signature validation inside `handleWebhook()`. They have access to `ctx.config.webhookSecret` and the raw `Request` object.

```typescript
// Inside a connector's handleWebhook:
async handleWebhook(req: Request, ctx: SyncContext) {
  const signature = req.headers.get('X-Hub-Signature');
  const body = await req.text();
  if (!verifyHmac(body, ctx.config.webhookSecret, signature)) {
    throw new AuthError('Invalid webhook signature');
  }
  // ... parse and normalize
}
```

## Lifecycle — Registration and Teardown

Connectors can register/deregister webhooks when activated or deactivated.

```typescript
lifecycle?: {
  onEnable(ctx: SyncContext): Promise<void>;   // register webhook URL with source API
  onDisable(ctx: SyncContext): Promise<void>;  // deregister webhook
}
```

The engine provides `ctx.webhookUrl` — the URL where it receives webhooks for this instance.

### Storage of Registration State

Connectors store webhook registration IDs (subscription IDs, etc.) in `ctx.state`. Example:

```typescript
async onEnable(ctx: SyncContext) {
  const res = await ctx.http('https://api.hubspot.com/webhooks/v1/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ targetUrl: ctx.webhookUrl, events: ['contact.creation'] })
  });
  const { subscriptionId } = await res.json();
  await ctx.state.set('webhookSubscriptionId', subscriptionId);
}

async onDisable(ctx: SyncContext) {
  const subscriptionId = await ctx.state.get('webhookSubscriptionId');
  await ctx.http(`https://api.hubspot.com/webhooks/v1/subscriptions/${subscriptionId}`, {
    method: 'DELETE'
  });
  await ctx.state.delete('webhookSubscriptionId');
}
```

### Teardown Before Re-enable

If a webhook registration is in a bad state, the engine calls `onDisable()` first, then `onEnable()`. This ensures clean re-registration.

## Monitoring

### Webhook Delivery Health

The engine tracks per-instance webhook delivery:
- Last received timestamp
- Success/failure rate of recent processings
- If no webhook received for longer than expected → "heartbeat lost" warning

Shown in `opensync status`:
```
Webhooks:
  hubspot-prod    last received: 30s ago    health: OK
  fiken-prod      last received: 3h ago     health: WARNING (expected interval: 1h)
  erp-legacy      no webhooks configured
```

### Registration Health

Webhook registrations can go stale — the source system may have purged them, credentials may have rotated, or the webhook URL may have changed. The engine monitors registration health:

**Connectors can optionally implement a registration check:**

```typescript
interface OpenSyncConnector {
  // ... existing methods
  lifecycle?: {
    onEnable(ctx: SyncContext): Promise<void>;
    onDisable(ctx: SyncContext): Promise<void>;
    checkRegistration?(ctx: SyncContext): Promise<WebhookRegistrationStatus>;
  };
}

interface WebhookRegistrationStatus {
  healthy: boolean;
  registrationId?: string;
  details?: string;        // e.g. "subscription active, expires 2026-05-01"
}
```

Example implementation:
```typescript
async checkRegistration(ctx: SyncContext) {
  const subscriptionId = await ctx.state.get('webhookSubscriptionId');
  if (!subscriptionId) return { healthy: false, details: 'no subscription stored' };

  const res = await ctx.http(`https://api.hubspot.com/webhooks/v1/subscriptions/${subscriptionId}`);
  if (res.status === 404) return { healthy: false, details: 'subscription not found' };

  const sub = await res.json();
  return {
    healthy: sub.active === true,
    registrationId: subscriptionId,
    details: `status: ${sub.active ? 'active' : 'inactive'}`
  };
}
```

**Auto-recovery flow:**

When the engine detects an unhealthy registration (via periodic check or heartbeat timeout):

1. Call `lifecycle.onDisable(ctx)` — clean up any stale state
2. Call `lifecycle.onEnable(ctx)` — re-register from scratch
3. Log the recovery in request journal
4. If re-registration fails → set connector instance status to `error`, alert via structured log

**Check schedule:**

Registration health checks run periodically (configurable, default every 30 minutes). They also run on engine startup — if the engine was offline, registrations may have expired.

```yaml
channels:
  - name: "Contact Sync"
    members:
      - instance: hubspot-prod
        webhooks:
          registration_check_interval_seconds: 1800   # 30 min
          heartbeat_timeout_seconds: 3600              # alert if no webhook in 1 hour
```

### Reconciliation Polling

Webhooks are inherently unreliable (networks fail, services restart, messages get lost). The engine runs a periodic **full poll** (e.g. daily) as a safety net to catch anything webhooks missed.

This is configurable per channel — some systems have very reliable webhooks, others don't.

## Offline Replay

Since webhooks are persisted in `webhook_queue`, developers can:
- Replay failed webhooks by resetting status to `pending`
- Test connector changes by replaying historical webhooks
- Debug issues offline — no need for the source system to re-send
