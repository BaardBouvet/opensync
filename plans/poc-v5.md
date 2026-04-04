# Plan: POC v5 — HTTP, Webhooks, and Request Journal

**Status:** `planned`
**Depends on:** v4 POC (SQLite state layer)

## Goal

Validate the HTTP surface: `ctx.http`, the request journal, auth injection, and the webhook
receive-and-queue flow. Introduce a real HTTP connector (a local mock API server) so these
surfaces can be exercised with actual network calls.

The jsonfiles connector is deliberately I/O-only — it makes no HTTP calls and has no auth. v5
is the first POC where the engine touches a network, which surfaces a different class of
problems: latency, failures, retries, credential management, and webhook delivery timing.

---

## The Test Target: A Local Mock API Server

Rather than wiring to a real SaaS (credentials, rate limits, data risks), v5 introduces a small
local HTTP server that behaves like a real API. This is the `mock-crm` connector referenced in the
overview spec.

The mock server exposes:
- `GET  /contacts?since=<iso>`   — poll for changed contacts (returns JSON array)
- `POST /contacts`               — create a contact, returns `{ id, ... }`
- `PUT  /contacts/:id`           — update a contact
- `POST /webhooks/subscribe`     — register a webhook URL
- `DELETE /webhooks/:id`         — deregister
- Test-only: `POST /__trigger`   — manually fire a webhook to the registered URL

Auth: static `Authorization: Bearer <token>` header (API key pattern, simplest possible).

The server runs in-process during tests (`Bun.serve` or Hono) and is started/stopped per test
suite. No external process needed.

---

## What v5 Validates

### 1. `ctx.http` wrapper

The engine injects a `ctx.http` function into every connector. It wraps `fetch()` with:
- Auth header injection (from `ctx.config.apiKey` or token manager)
- Automatic logging to the request journal (before + after each call)
- Credential masking in the journal (API keys, bearer tokens never appear in plain text)

v5 answers:
- Does the `ctx.http` interface feel right for connector authors?
- Does masking work — can we verify the journal row never contains the raw token?
- How do we handle non-2xx responses — throw, or return with status?

### 2. Request Journal

The first time the journal is populated with real data. Every `GET /contacts` poll and every
`POST /contacts` write should produce a row:

```
connector_id | method | url                     | status | duration_ms | request_body | response_body
mock-crm     | GET    | http://localhost:4000/… | 200    | 12          | null         | [{"id":…}]
mock-crm     | POST   | http://localhost:4000/… | 201    | 8           | {"name":…}   | {"id":"xyz"}
```

Questions to resolve:
- Full response body, or truncated? (GDPR / size tradeoff)
- Should request bodies be stored? (outbound mutations expose the data being written)
- How do we correlate a journal row to the `transaction_log` row it produced?

### 3. Webhook Receive-and-Queue

The engine runs a lightweight HTTP server on a local port. The mock API calls that URL when
contacts change.

Flow to validate:
1. Mock API server fires `POST /webhooks/<connectorId>` to the engine's webhook server
2. Engine writes raw payload to `webhook_queue` immediately, responds `200`
3. Webhook processor dequeues, calls `connector.handleWebhook(req, ctx)`
4. Normalized records enter the sync pipeline (same path as polled records)

Questions to resolve:
- Should the webhook server and the poll loop run in the same process or different?
  (Hypothesis: same process, different async tasks — simpler, no IPC needed for POC)
- How does the engine's webhook URL get communicated to the connector's `onEnable()`?
  (`ctx.webhookUrl` is the answer — validate it feels natural to use)
- What happens if the engine is down when a webhook arrives? The mock server queues it and
  retries — but the engine has no queue on its side either. For the POC, just test the
  happy path; retry semantics are a v6+ concern.

### 4. Thin vs Thick Webhooks

The mock connector will implement both patterns to validate the interface:
- **Thick**: webhook payload contains the full contact — `handleWebhook()` just normalises it
- **Thin**: webhook payload contains only `{ id, event }` — `handleWebhook()` calls `ctx.http`
  to fetch the full record

This matters because thin webhooks add API calls to the journal, which tests the correlation
between webhook processing and request journal entries.

### 5. Auth Injection

`ctx.http` should transparently inject the API key on every request. The connector itself never
reads `ctx.config.apiKey` directly in its `read()`/`insert()`/`update()` methods.

Test: verify all journal rows for the mock-crm connector have the `Authorization` header present
but redacted in the stored `request_headers`.

---

## Surfaces Explicitly Out of Scope for v5

- **OAuth2** — session token and API key patterns are sufficient. OAuth adds token refresh, lock
  contention, and redirect flows. That's a dedicated POC.
- **`prepareRequest` hook** — HMAC signing, session tokens. Deferred.
- **Webhook signature validation** — the mock server signs nothing. Test the happy path only.
- **Retry / exponential backoff** on failed webhook processing — validate the queue, not the
  retry loop.
- **Webhook health monitoring** — "heartbeat lost" warnings are a UI/status concern. Deferred.
- **Rate limiting / 429 handling** — the mock server never rate-limits.

---

## The Mock CRM Connector

Lives at `connectors/mock-crm/`. Implements the `Connector` interface using `ctx.http`:

```typescript
// connectors/mock-crm/src/index.ts
export default {
  metadata: {
    name: "mock-crm",
    version: "0.1.0",
    auth: { type: "apiKey", header: "Authorization", prefix: "Bearer" },
  },

  getEntities(ctx): EntityDefinition[] {
    return [{
      name: "contacts",

      async *read(ctx, since) {
        const url = since
          ? `${ctx.config.baseUrl}/contacts?since=${encodeURIComponent(since)}`
          : `${ctx.config.baseUrl}/contacts`;
        const res = await ctx.http(url);
        const records = await res.json();
        yield { records, since: new Date().toISOString() };
      },

      async *insert(records, ctx) {
        for await (const record of records) {
          const res = await ctx.http(`${ctx.config.baseUrl}/contacts`, {
            method: "POST",
            body: JSON.stringify(record.data),
          });
          const created = await res.json();
          yield { id: created.id, data: created };
        }
      },

      // handleWebhook lives on the Connector, not EntityDefinition (see SDK spec)
    }];
  },

  async handleWebhook(req, ctx) {
    const payload = await req.json();
    // Thick webhook — full contact in payload
    return [{ entity: "contacts", records: [{ id: payload.id, data: payload }] }];
  },

  async onEnable(ctx) {
    const res = await ctx.http(`${ctx.config.baseUrl}/webhooks/subscribe`, {
      method: "POST",
      body: JSON.stringify({ url: ctx.webhookUrl }),
    });
    const { subscriptionId } = await res.json();
    await ctx.state.set("webhookSubscriptionId", subscriptionId);
  },

  async onDisable(ctx) {
    const id = await ctx.state.get("webhookSubscriptionId");
    if (id) {
      await ctx.http(`${ctx.config.baseUrl}/webhooks/${id}`, { method: "DELETE" });
      await ctx.state.delete("webhookSubscriptionId");
    }
  },
} satisfies Connector;
```

---

## New SQLite Tables (beyond v4)

### `request_journal`

```sql
CREATE TABLE request_journal (
  id              TEXT PRIMARY KEY,
  connector_id    TEXT NOT NULL,
  batch_id        TEXT,                    -- links to transaction_log if this call produced a write
  method          TEXT NOT NULL,
  url             TEXT NOT NULL,
  request_body    TEXT,                    -- JSON, null for GET
  request_headers TEXT,                    -- JSON, sensitive values replaced with "[REDACTED]"
  response_status INTEGER NOT NULL,
  response_body   TEXT,                    -- truncated at 64KB
  duration_ms     INTEGER NOT NULL,
  called_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

### `webhook_queue`

```sql
CREATE TABLE webhook_queue (
  id              TEXT PRIMARY KEY,
  connector_id    TEXT NOT NULL,
  raw_payload     TEXT NOT NULL,           -- JSON, as received
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | completed | failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at    TEXT
);
```

---

## Work Items

1. `mock-crm` API server (Hono, in-process, start/stop for tests)
2. `connectors/mock-crm/` connector implementation
3. `ctx.http` implementation — wraps `fetch()`, injects auth, logs to request journal
4. Auth injection: API key / bearer pattern from `ctx.config`
5. Credential masking in journal writes
6. Request journal table + writes in `ctx.http`
7. Webhook server (Hono, single route `POST /webhooks/:connectorId`)
8. `webhook_queue` table
9. Webhook processor — dequeue loop, call `connector.handleWebhook()`, feed pipeline
10. `ctx.webhookUrl` injected at engine start, derived from server port
11. `onEnable()` / `onDisable()` connector lifecycle calls at startup/shutdown
12. Thin webhook variant — `handleWebhook()` calls `ctx.http` to enrich, verify journal row appears
13. `batch_id` correlation between `request_journal` and `transaction_log`
14. Tests:
    - Poll cycle produces correct request journal rows
    - Inserted records produce journal rows with masked credentials
    - Webhook receive → queue → process → sync pipeline (happy path)
    - Thin webhook produces additional journal row for the enrichment fetch
    - Journal rows never contain raw API key value

---

## Open Questions

- **Response body storage policy**: Always store, store only on error, or configurable?
  Impact on storage size vs. debuggability. Start with "always, truncate at 64KB".
- **`batch_id` on journal rows**: A journal row from a poll call happens *before* writes, so
  it can't know the `batch_id` of the writes it will produce. Options: (a) generate `batch_id`
  at the start of each cycle, pass it through, (b) update journal rows retroactively after writes.
  Option (a) is cleaner.
- **Webhook server port**: Hardcoded for POC (`4001`), or detected from `openlink.json`? Hardcode
  for now, make it configurable as part of the real engine.
- **In-process vs separate process for webhook server**: Same process for the POC (simplest).
  Production: same process is fine unless horizontal scaling is needed.

---

## Addendum: `trigger` column on `request_journal`

**Resolved during implementation.**

### Problem

After the first run, the `request_journal` table contained rows with `batch_id = null` for
lifecycle calls (`onEnable`, `onDisable`). There was no way to tell why an HTTP call was made
without reading the URL — a `POST /webhooks/subscribe` looked identical to a `POST /contacts`
if you squinted.

### Decision: add a `trigger` column

```sql
ALTER TABLE request_journal ADD COLUMN trigger TEXT;
-- values: 'poll' | 'webhook' | 'on_enable' | 'on_disable'
```

A nullable `TEXT` discriminator. Exactly one of `batch_id` or `trigger` tends to be the
primary correlation handle for any given row:

| Context                | `trigger`    | `batch_id`       |
|------------------------|-------------|------------------|
| `ingest()` poll cycle  | `poll`      | set (links to tx_log writes) |
| `processWebhookQueue()`| `webhook`   | set (one per webhook row)    |
| `onEnable()`           | `on_enable` | null             |
| `onDisable()`          | `on_disable`| null             |

This is a purely additive, non-breaking schema change. All existing rows receive `NULL`,
which is correct — they pre-date the column.

### Implementation

`makeTrackedFetch()` accepts a `triggerRef: { current: JournalTrigger | undefined }` alongside
the existing `batchIdRef`. `ConnectorInstance` carries both refs. The engine sets them before
each operation and (for lifecycle calls) clears them in a `finally` block:

```typescript
// ingest()
source.batchIdRef.current = opts.batchId;
source.triggerRef.current = "poll";

// onEnable()
instance.triggerRef.current = "on_enable";
try { await instance.connector.onEnable(instance.ctx); }
finally { instance.triggerRef.current = undefined; }

// processWebhookQueue()
instance.batchIdRef.current = batchId;       // one UUID per webhook row
instance.triggerRef.current = "webhook";
```

### Why not reuse `batch_id` for lifecycle events?

`batch_id` is semantically tied to a set of writes that atomically advanced the state. A
lifecycle event (`onEnable`) makes HTTP calls but produces no `transaction_log` rows — there is
nothing to group. Overloading `batch_id` with a sentinel string like `"lifecycle:on_enable"`
would break the FK intent of the column. A separate `trigger` column keeps the semantics clean.

---

## Addendum: `batch_id` on `webhook_queue`

**Resolved during implementation.**

### Problem

After processing, a `webhook_queue` row had no `batch_id`. The `request_journal` rows produced
by `handleWebhook` carried a `batch_id` (written at processing time), but there was no way to
navigate *from* the queue row *to* those journal rows — or to the `sync_runs` and
`transaction_log` rows that share the same UUID.

### Decision: add `batch_id TEXT` to `webhook_queue`

```sql
ALTER TABLE webhook_queue ADD COLUMN batch_id TEXT;
```

The UUID is generated *before* `dbMarkWebhookProcessing()` and written to the queue row at the
same moment it is propagated into `batchIdRef`. This gives a single join key across all four
observability tables for any webhook-triggered operation:

```sql
-- "what did processing this webhook cause?"
SELECT r.*
FROM   webhook_queue w
JOIN   request_journal r  ON r.batch_id = w.batch_id
WHERE  w.id = '<webhook-uuid>';

-- or via sync_runs / transaction_log
SELECT t.*
FROM   webhook_queue w
JOIN   transaction_log t ON t.batch_id = w.batch_id
WHERE  w.id = '<webhook-uuid>';
```

### Why not also add `webhook_id` to `sync_runs`?

`sync_runs.batch_id` already equals `webhook_queue.batch_id` for webhook-triggered runs — the
join is implicit. Adding a redundant `webhook_id` FK would duplicate information without adding
expressive power.

### Implementation

`processWebhookQueue()` now generates `batchId` before marking the row as processing:

```typescript
const batchId = crypto.randomUUID();
dbMarkWebhookProcessing(this.db, row.id, batchId);   // writes batch_id to queue row
if (instance.batchIdRef) instance.batchIdRef.current = batchId;  // propagates to ctx.http
```

`dbMarkWebhookProcessing` signature changed to `(db, id, batchId)`.

