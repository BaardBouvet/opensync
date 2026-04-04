# Database Schema

All engine state lives in a single SQLite file. WAL mode enabled. No ORM — raw SQL via
`bun:sqlite` (or `better-sqlite3` on Node). Proven across POC v0–v9.

---

## Configuration

- **WAL mode** enabled: `PRAGMA journal_mode = WAL`
- **Foreign keys** enforced: `PRAGMA foreign_keys = ON`
- **UUIDs** generated via `crypto.randomUUID()`
- **Timestamps** stored as ISO 8601 text (`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
- **Field-level timestamps** (`FieldEntry.ts`) use epoch milliseconds for LWW precision

---

## Tables

### `identity_map`

The hub: maps every external ID to a shared canonical UUID. One row per
`(connector_id, external_id)` pair. Two connectors "know about" the same real-world entity
when they share the same `canonical_id`.

```sql
CREATE TABLE identity_map (
  canonical_id  TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  PRIMARY KEY (canonical_id, connector_id),
  UNIQUE (connector_id, external_id)
);
```

A connector is **onboarded** into a channel when it has at least one `canonical_id` that
appears in more than one row (i.e. is shared with ≥1 other connector). Provisionally-collected
connectors have self-only rows that don't meet this threshold.

`dbMergeCanonicals(keepId, dropId)` atomically redirects all rows with `canonical_id = dropId`
to `keepId`. Used by `onboard()` and `addConnector()`.

---

### `watermarks`

Per-connector, per-entity read cursor. Passed back as `since` on the next `read()` call.

```sql
CREATE TABLE watermarks (
  connector_id  TEXT NOT NULL,
  entity_name   TEXT NOT NULL,
  since         TEXT NOT NULL,
  PRIMARY KEY (connector_id, entity_name)
);
```

Advanced atomically with shadow state writes at the end of each successful ingest batch.

---

### `shadow_state`

Field-level tracking per connector per record. The engine's memory — stores the last known
value of every field for every record in every connected system.

```sql
CREATE TABLE shadow_state (
  connector_id    TEXT NOT NULL,
  entity_name     TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  canonical_id    TEXT NOT NULL,
  canonical_data  TEXT NOT NULL,   -- JSON: FieldData
  deleted_at      TEXT,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (connector_id, entity_name, external_id)
);
```

`canonical_data` structure (`FieldData`):

```typescript
type FieldData = Record<string, FieldEntry>;

interface FieldEntry {
  val:  unknown;   // current value
  prev: unknown;   // previous value (for rollback)
  ts:   number;    // epoch ms when last written
  src:  string;    // connector_id that last wrote this field
}
```

Example:
```json
{
  "email": { "val": "ola@example.com", "prev": "old@example.com", "ts": 1711993200000, "src": "hubspot" },
  "phone": { "val": "99887766",        "prev": null,              "ts": 1711993500000, "src": "fiken" }
}
```

Associations are stored as a special `__assoc__` field containing a stable JSON-serialised
sentinel of the sorted association list. This lets the diff engine detect association changes
without parsing individual foreign keys.

---

### `connector_state`

Per-connector persistent key-value store. Powers `ctx.state` in connectors.

```sql
CREATE TABLE connector_state (
  connector_id  TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,   -- JSON
  PRIMARY KEY (connector_id, key)
);
```

---

### `transaction_log`

Append-only audit trail. One row per successful write (insert or update) to any target connector.
Used for rollback. See `rollback.md`.

```sql
CREATE TABLE transaction_log (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  entity_name   TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  canonical_id  TEXT NOT NULL,
  action        TEXT NOT NULL,   -- 'insert' | 'update'
  data_before   TEXT,            -- JSON: FieldData before the write (null for inserts)
  data_after    TEXT NOT NULL,   -- JSON: FieldData after the write
  synced_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

`data_before` is the target's previous `shadow_state.canonical_data`. Together with `data_after`
it is sufficient to reconstruct the exact diff and replay or undo the mutation.

---

### `sync_runs`

Per-batch summary metrics. One row per `(batch_id, channel_id, connector_id)` ingest pass.

```sql
CREATE TABLE sync_runs (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  inserted      INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  deferred      INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL
);
```

---

### `request_journal`

Every outbound HTTP call made by connectors via `ctx.http`. Credentials masked before storage.

```sql
CREATE TABLE request_journal (
  id               TEXT PRIMARY KEY,
  connector_id     TEXT NOT NULL,
  batch_id         TEXT,
  trigger          TEXT,           -- 'poll' | 'webhook' | 'on_enable' | 'on_disable' | 'oauth_refresh'
  method           TEXT NOT NULL,
  url              TEXT NOT NULL,
  request_body     TEXT,
  request_headers  TEXT,           -- JSON: { header: value } with sensitive values as "[REDACTED]"
  response_status  INTEGER NOT NULL,
  response_body    TEXT,
  duration_ms      INTEGER NOT NULL,
  called_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

Response bodies are capped at 65 536 bytes.

---

### `webhook_queue`

Inbound webhook payloads queued for async processing. The HTTP server writes here and responds
200 immediately. `processWebhookQueue()` drains the queue.

```sql
CREATE TABLE webhook_queue (
  id            TEXT PRIMARY KEY,
  connector_id  TEXT NOT NULL,
  raw_payload   TEXT NOT NULL,
  batch_id      TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'processing' | 'completed' | 'failed'
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at  TEXT
);
```

---

### `oauth_tokens`

Centralised token cache. One row per connector. Includes a `locked_at` column used as a
SQLite-serialised mutex to prevent concurrent token refreshes.

```sql
CREATE TABLE oauth_tokens (
  connector_id    TEXT PRIMARY KEY,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT,
  expires_at      TEXT,
  locked_at       TEXT   -- set during refresh; NULL when idle
);
```

The lock protocol: `UPDATE ... SET locked_at = now WHERE locked_at IS NULL OR locked_at < now - 30s`.
`changes === 1` → lock acquired. SQLite's serialised write model makes this race-free.

---

### `onboarding_log`

Append-only diagnostics for `discover()`, `onboard()`, and `addConnector()` operations.

```sql
CREATE TABLE onboarding_log (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL,
  entity          TEXT NOT NULL,
  action          TEXT NOT NULL,           -- 'discover' | 'onboard' | 'add-connector'
  matched         INTEGER,
  unique_count    INTEGER,
  linked          INTEGER,
  shadows_seeded  INTEGER,
  started_at      TEXT NOT NULL,
  finished_at     TEXT NOT NULL
);
```

---

## Key Queries

### Is a channel ready for sync?

```sql
SELECT COUNT(*) FROM (
  SELECT canonical_id FROM identity_map
  WHERE connector_id IN (?, ?, ...)
  GROUP BY canonical_id
  HAVING COUNT(DISTINCT connector_id) > 1
)
-- result > 0 → at least two connectors share a canonical → ready
```

### Which connectors are onboarded?

```sql
SELECT DISTINCT connector_id FROM identity_map
WHERE connector_id IN (?, ?, ...)
  AND canonical_id IN (
    SELECT canonical_id FROM identity_map
    WHERE connector_id IN (?, ?, ...)
    GROUP BY canonical_id
    HAVING COUNT(DISTINCT connector_id) > 1
  )
```

### Fan-out guard (which targets are cross-linked?)

Same query as above — computed once per `_processRecords` call and used to filter the target list.

### What is the current canonical value for a record?

```sql
SELECT ss.canonical_data
FROM shadow_state ss
JOIN identity_map im ON im.connector_id = ss.connector_id AND im.external_id = ss.external_id
WHERE im.canonical_id = ?
  AND ss.deleted_at IS NULL
```

The first non-null value per field wins (field values merged across all linked shadows).

---

## No `channel_onboarding_status` Table

Earlier POC versions (v7–v8) maintained a `channel_onboarding_status` table with a `ready`
flag. It is **not** in the production schema. `identity_map` is the sole source of truth for
channel readiness — a cross-link query is sufficient and always authoritative. A separate flag
table added complexity without adding information.

---

## Drizzle ORM

The existing `specs/overview.md` references Drizzle ORM. That was a pre-POC decision. The
POCs use raw `bun:sqlite` SQL throughout, and the raw SQL pattern is what gets implemented.
Drizzle may be introduced later if type-safe query builders add value, but it is not a
dependency of the initial implementation.


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
