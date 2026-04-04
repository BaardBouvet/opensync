# v5 Lessons Learned

## What v5 was

First POC to touch a network. Introduced `ctx.http` (a tracked fetch wrapper with auth
injection and request journal logging), connector lifecycle hooks (`onEnable`/`onDisable`/
`handleWebhook`), an in-process webhook receiver backed by a `webhook_queue`, and a local
mock CRM HTTP server to exercise all of this without external dependencies.

## What worked

### `ctx.http` is the right boundary for auth + observability

Injecting a tracked fetch wrapper into every connector call means:
- Auth headers are applied once in the engine, not duplicated in each connector
- Every outbound HTTP call appears in `request_journal` automatically
- Credential masking (keys and tokens never logged in plain text) is enforced centrally
- Connector authors never import `fetch` directly — they call `ctx.http()` which has
  the same signature

The interface felt natural for connector authors. Adding a new connector with API-key
auth required only declaring `metadata.auth.type = 'api-key'` — the header injection
happened automatically.

### Webhook queue decouples receive from process

The in-process receiver writes to `webhook_queue` immediately (fast, no blocking).
`processWebhookQueue()` dequeues and runs each payload through the connector's
`handleWebhook` hook followed by the normal sync pipeline. This separation means:
- Webhook delivery never blocks the poll loop
- Failed processing leaves the row in the queue for retry
- The queue is observable — you can see unprocessed events

### Mock server pattern for HTTP connectors

Running a real in-process HTTP server (`mock-crm-server.ts`) rather than using mocks
exercised the actual connector read/write code paths including pagination, error
responses, and webhook delivery. Problems that would have been hidden by mocks
surfaced immediately (e.g. the server returning 201 on create but 200 on update — the
connector had to handle both).

### `batch_id` correlation in request journal

Tagging every request journal row with the `batch_id` of the ingest cycle that
triggered it made it possible to answer "which HTTP calls did this sync batch make?"
This is the traceability model that carries into production.

## What broke down

### `onEnable`/`onDisable` semantics were underspecified

The hooks were called correctly but the contract was unclear: should `onEnable` wait
for webhook subscription to succeed before returning? What happens if the webhook
endpoint is unreachable? The hooks returned `void`; production needs them to be
async and to surface errors into the engine's error channel.

### Webhook replay on startup not tested

If the engine restarts with unprocessed rows in `webhook_queue`, they should be
processed on startup. This was not validated in v5 — the queue was always empty at
test startup. The production engine needs an explicit drain-on-boot step.

### No retry on failed webhook processing

A connector's `handleWebhook` throwing an error left the row in `webhook_queue`
unprocessed, with no retry or dead-letter logic. The spec (`specs/webhooks.md`)
defines the retry model; v5 only validated the happy path.

### Auth injection tested for API key only

OAuth2 and `prepareRequest` were designed but not validated in v5. The full auth
matrix (API key ✅, OAuth2 ⬜, prepareRequest ⬜) was completed in v6.
