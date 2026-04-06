# Observability

Full visibility into what the engine is doing, has done, and why.

## Request Journal

Every outbound HTTP call made via `ctx.http` is automatically logged.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Entry ID |
| connector_instance_id | FK | Which connector made the call |
| method | text | GET, POST, PATCH, DELETE |
| url | text | Full URL |
| request_body | text | Request body (sensitive headers masked) |
| response_status | integer | HTTP status code |
| response_body | text | Response body |
| duration_ms | integer | Round-trip time |
| timestamp | datetime | When the call was made |

### What this enables

- **Debugging**: Click on a synced record → see every API call that touched it
- **Performance**: Find slow API calls, identify rate-limited connectors
- **Audit trail**: Prove exactly what was sent to a system and when
- **Offline replay**: Reproduce issues without calling the live API

### Privacy / GDPR

The journal stores response bodies which may contain personal data.

**Retention policy**: Configurable per deployment (default: 30 days). Rows older than the retention window are deleted by a background pruning job.

**Body storage policy**: Request and response bodies are stored by default, truncated to 64 KB each. Connectors can opt out per-request by returning a special header in the response (future). The raw body is the primary way to reproduce an API error offline, so truncation is preferable to omission.

**Credential masking**: The `Authorization` header and any field listed as `secret: true` in the connector's `configSchema` are replaced with `[REDACTED]` before the row is written. Fields are masked in both `request_body` and `response_body`.

### Correlating Journal Rows to Transaction Log

Each `request_journal` row carries a `batch_id` that is shared with the `transaction_log` rows produced in the same sync cycle. To see all mutations that a specific API call caused:

```sql
SELECT tl.*
FROM transaction_log tl
JOIN request_journal rj ON tl.batch_id = rj.batch_id
WHERE rj.id = '<journal-row-id>';
```

To go the other direction — find the API calls that produced a specific transaction:

```sql
SELECT rj.*
FROM request_journal rj
WHERE rj.batch_id = (
  SELECT batch_id FROM transaction_log WHERE id = '<transaction-id>'
);
```

The `batch_id` is a UUID generated at the start of each sync cycle and stamped on every `sync_runs`, `transaction_log`, and `request_journal` row produced in that cycle.

## Pipeline Logs

Each sync job produces a structured log of what happened at each pipeline stage.

```typescript
interface PipelineResult {
  processed: number;
  created: number;
  updated: number;
  skipped: number;     // echo suppressed
  conflicts: number;
  errors: Array<{ entityId: string; error: string }>;
}
```

Stored in the `sync_jobs` table alongside job metadata. The combination of job results + request journal + transaction log gives a complete picture of any sync operation.

## Structured SyncEvent Payloads

`ingest()` returns `IngestResult.records: RecordSyncResult[]`.  Each result carries structured
payload fields so callers can render rich event logs without additional DB queries.

See `specs/sync-engine.md § RecordSyncResult` for the full type definition.

### Event types and their payloads

| action | sourceData | sourceShadow | before | after |
|--------|-----------|-------------|--------|-------|
| `read` | ✓ incoming canonical values | ✓ last known shadow (diff source) | — | — |
| `insert` | — | — | — | ✓ written canonical values |
| `update` | — | — | ✓ previous target shadow | ✓ written canonical values |
| `skip` | — | — | — | — |
| `defer` | — | — | — | — |
| `error` | — | — | — | — |

`sourceData` and `sourceShadow` together enable "what changed" display:
- New records: `sourceData` is populated, `sourceShadow` is `undefined` → all fields are new.
- Changed records: both are populated → caller computes `Object.keys(sourceData).filter(k => sourceData[k] !== sourceShadow[k])`.

`before` and `after` on `update` results enable "field diff" display on target writes.

## Structured Logging

All engine output uses structured JSON logging (pino).

```typescript
interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}
```

Every log entry includes context:
- `sync_id`: Correlation ID for the current sync cycle
- `connector`: Which connector
- `entity_type`: What's being synced
- `stage`: Where in the pipeline (ingest, transform, diff, resolve, dispatch)

## Introspection

### Record History

For any entity, the engine can show:
1. **Identity links**: Which external IDs in which systems
2. **Shadow state**: Current field values, previous values, timestamps, sources
3. **Transaction log**: Every change ever made, with before/after data
4. **Request journal**: Every API call related to this entity

This powers the CLI's `opensync inspect <entity-id>` command.

### Channel Health

Per sync channel:
- **Status**: OPERATIONAL / DEGRADED / TRIPPED
- **Circuit breaker reason**: Why it tripped
- **Queue depth**: How many jobs pending
- **Last sync**: When, how many records, success/failure
- **Error rate**: Recent failure percentage
- **Webhook health**: Last received, success rate

### Connector Health

Per connector instance:
- **Status**: active / paused / error
- **Last successful sync**: timestamp
- **API response times**: average from request journal
- **Rate limit hits**: count of 429 responses
- **Token status**: valid / expiring / expired / refresh failed

## Database as Dashboard

Since everything lives in SQLite, developers can use any SQL tool (TablePlus, Beekeeper Studio, VS Code SQLite extension) to explore the engine's state.

Useful queries:
```sql
-- Next 5 pending jobs
SELECT * FROM sync_jobs WHERE status = 'pending' ORDER BY run_at ASC LIMIT 5;

-- Recent errors
SELECT * FROM sync_jobs WHERE status = 'failed' ORDER BY created_at DESC LIMIT 10;

-- All API calls for a specific entity
SELECT rj.* FROM request_journal rj
JOIN entity_links el ON rj.connector_instance_id = el.connector_instance_id
WHERE el.entity_id = 'uuid-123'
ORDER BY rj.timestamp DESC;

-- Circuit breaker status
SELECT id, entity_type, status FROM sync_channels;

-- Webhook queue depth
SELECT connector_instance_id, status, COUNT(*) FROM webhook_queue GROUP BY 1, 2;
```
