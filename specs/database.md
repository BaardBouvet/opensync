# Database Schema

All state lives in a single SQLite file. Drizzle ORM for type-safe access. JSONB for flexible
field storage.

## SQLite Adapter

The engine never imports a SQLite driver directly. A single `openDb()` function at boot detects
the environment and returns a Drizzle instance:

```typescript
// packages/engine/src/db/open.ts

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

export type SqliteDb = BaseSQLiteDatabase<"sync", Record<string, never>>;

export async function openDb(path: string): Promise<SqliteDb> {
  if (typeof globalThis.Bun !== "undefined") {
    // bun:sqlite — built into the runtime, works in compiled binaries.
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    return drizzle(new Database(path)) as SqliteDb;
  }
  // better-sqlite3 — native binding, works on Node.js 18+ and Bun.
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  return drizzle(new Database(path)) as SqliteDb;
}
```

All engine code uses `SqliteDb` (Drizzle's `BaseSQLiteDatabase`). Both drivers satisfy this type.
The rest of the engine is completely unaware of which driver is running.

**Why not a hand-written adapter interface?** Drizzle already abstracts both drivers behind an
identical query API. Adding another layer would be redundant. The only variation point is
initialization — `openDb()` is that layer.

---

## Configuration

- **WAL mode** enabled for concurrent read/write
- **Foreign keys** enforced
- **UUIDs** generated via `crypto.randomUUID()` (Node.js built-in)
- **Timestamps** stored as ISO 8601 text. Field-level timestamps (`FieldEntry.ts`) use epoch milliseconds for LWW precision.

## Tables

### entities

Global identity hub. One row per unique real-world entity.

```sql
CREATE TABLE entities (
  id TEXT PRIMARY KEY,                          -- uuid
  entity_type TEXT NOT NULL,                    -- 'contact', 'company', 'deal'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### entity_links

Maps global IDs to external IDs per system. The spokes of hub-and-spoke.

```sql
CREATE TABLE entity_links (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  connector_instance_id TEXT NOT NULL REFERENCES connector_instances(id),
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(connector_instance_id, external_id)   -- one external ID per instance
);
```

### shadow_state

Field-level tracking per entity per system. The engine's memory.

```sql
CREATE TABLE shadow_state (
  id TEXT PRIMARY KEY,
  entity_link_id TEXT NOT NULL REFERENCES entity_links(id),
  field_data TEXT NOT NULL,                     -- JSONB: { field: { val, prev, ts, src } }
  last_sync_at TEXT NOT NULL,
  deleted_at TEXT,                              -- soft delete timestamp
  UNIQUE(entity_link_id)
);
```

`field_data` JSONB structure:
```json
{
  "email": { "val": "ola@test.no", "prev": "old@test.no", "ts": 1711993200, "src": "hubspot-1" },
  "phone": { "val": "99887766", "prev": null, "ts": 1711993500, "src": "fiken-1" }
}
```

### connector_instances

Configured connections to external systems.

```sql
CREATE TABLE connector_instances (
  id TEXT PRIMARY KEY,
  connector_name TEXT NOT NULL,                 -- 'hubspot', 'fiken', 'mock-crm'
  display_name TEXT NOT NULL,                   -- 'HubSpot Production'
  config TEXT NOT NULL,                         -- JSONB: { baseUrl, foretakId, ... }
  environment TEXT DEFAULT 'production',
  status TEXT NOT NULL DEFAULT 'active',        -- 'active', 'paused', 'error'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### sync_channels

Defines what syncs — one channel per entity type being synced.

```sql
CREATE TABLE sync_channels (
  id TEXT PRIMARY KEY,
  name TEXT,
  entity_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPERATIONAL',   -- 'OPERATIONAL', 'DEGRADED', 'TRIPPED'
  circuit_breaker_config TEXT,                  -- JSONB: thresholds
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### sync_channel_members

Which connector instances participate in a channel.

```sql
CREATE TABLE sync_channel_members (
  channel_id TEXT NOT NULL REFERENCES sync_channels(id),
  connector_instance_id TEXT NOT NULL REFERENCES connector_instances(id),
  role_config TEXT,                             -- JSONB: { master_fields: [...], strategy_overrides: {...} }
  PRIMARY KEY (channel_id, connector_instance_id)
);
```

### sync_jobs

SQLite-backed job queue.

```sql
CREATE TABLE sync_jobs (
  id TEXT PRIMARY KEY,
  channel_id TEXT REFERENCES sync_channels(id),
  source_instance_id TEXT REFERENCES connector_instances(id),
  job_type TEXT NOT NULL DEFAULT 'sync',        -- 'sync', 'full_sync', 'webhook', 'discovery'
  status TEXT NOT NULL DEFAULT 'pending',        -- 'pending', 'processing', 'completed', 'failed'
  payload TEXT,                                  -- JSONB
  result TEXT,                                   -- JSONB: PipelineResult
  priority INTEGER DEFAULT 0,
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### webhook_queue

Incoming webhooks queued for async processing.

```sql
CREATE TABLE webhook_queue (
  id TEXT PRIMARY KEY,
  connector_instance_id TEXT NOT NULL,
  raw_payload TEXT NOT NULL,                    -- JSONB: raw webhook body
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### request_journal

Every outbound HTTP call made by connectors via `ctx.http`.

```sql
CREATE TABLE request_journal (
  id TEXT PRIMARY KEY,
  connector_instance_id TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  request_body TEXT,
  response_status INTEGER,
  response_body TEXT,
  duration_ms INTEGER,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### transaction_log

Every outbound mutation for undo/rollback.

```sql
CREATE TABLE transaction_log (
  id TEXT PRIMARY KEY,
  entity_link_id TEXT,
  action TEXT NOT NULL,                         -- 'create', 'update', 'delete'
  target_instance_id TEXT NOT NULL,
  data_before TEXT,                             -- JSONB: state before mutation
  data_after TEXT,                              -- JSONB: state after mutation
  batch_id TEXT,                                -- groups ops from same sync cycle
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### oauth_tokens

Centralized token storage.

```sql
CREATE TABLE oauth_tokens (
  connector_instance_id TEXT PRIMARY KEY REFERENCES connector_instances(id),
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  locked_at TEXT                                -- refresh lock (see auth.md)
);
```

### instance_meta

Per-instance persistent key-value store. Powers `ctx.state` in connectors.

> **Also known as `connector_state`** in the v4 POC. The production schema uses `instance_meta` to avoid ambiguity with `connector_instances`.

```sql
CREATE TABLE instance_meta (
  connector_instance_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,                                   -- JSONB
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (connector_instance_id, key)
);
```

### stream_state

Watermark/cursor tracking. Stores the `since` value for delta syncs per entity per instance.

```sql
CREATE TABLE stream_state (
  connector_instance_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  cursor TEXT,                                  -- JSONB: connector-specific cursor data
  last_fetched_at TEXT,
  PRIMARY KEY (connector_instance_id, entity_type)
);
```

### idempotency_keys

Dedup keys with TTL to prevent duplicate processing.

```sql
CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
```

### sync_runs

Per-cycle summary metrics. One row per `(batch_id, channel_id, connector_id)` pass, recording how many records were inserted, updated, skipped, deferred, and errored. Used by `opensync status` and pipeline logs.

```sql
CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  inserted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  deferred INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
```

### dead_letter

Records that have exhausted all retry attempts and are parked for manual inspection and replay. See [safety.md — Dead Letter Queue](safety.md) for the retry policy and CLI commands.

```sql
CREATE TABLE dead_letter (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  external_id TEXT NOT NULL,
  canonical_id TEXT,
  action TEXT NOT NULL,       -- 'insert', 'update', 'delete'
  payload TEXT NOT NULL,      -- JSONB: the record or ID that failed
  error TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_failed_at TEXT NOT NULL,
  last_failed_at TEXT NOT NULL
);
```

## Indexes

Key indexes for query performance:

```sql
CREATE INDEX idx_entity_links_entity ON entity_links(entity_id);
CREATE INDEX idx_entity_links_external ON entity_links(connector_instance_id, external_id);
CREATE INDEX idx_shadow_state_link ON shadow_state(entity_link_id);
CREATE INDEX idx_sync_jobs_status ON sync_jobs(status, run_at);
CREATE INDEX idx_webhook_queue_status ON webhook_queue(status, created_at);
CREATE INDEX idx_transaction_log_batch ON transaction_log(batch_id);
CREATE INDEX idx_transaction_log_entity ON transaction_log(entity_link_id);
CREATE INDEX idx_request_journal_instance ON request_journal(connector_instance_id, timestamp);
CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);
```

## Migrations

Drizzle Kit generates migrations from schema changes. Each new feature that adds or modifies tables produces a numbered migration file in `packages/engine/src/db/migrations/`.
