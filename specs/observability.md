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

The journal stores response bodies which may contain personal data. Configurable retention policy (e.g. 30 days). Connectors can flag fields as sensitive for masking.

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
