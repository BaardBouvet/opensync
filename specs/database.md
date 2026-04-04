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

## `channel_onboarding_status`

Records when each `(channel_id, entity)` pair was first onboarded. `identity_map` is the
authoritative source for channel *readiness* (the cross-link query); this table records
*when* it became ready, which is used by the observability layer.

```sql
CREATE TABLE channel_onboarding_status (
  channel_id       TEXT PRIMARY KEY,
  entity           TEXT NOT NULL,
  marked_ready_at  TEXT NOT NULL
);
```

---

## `circuit_breaker_events`

Append-only log of circuit-breaker state transitions. One row per event per channel.
See `specs/safety.md` for the circuit-breaker policy.

```sql
CREATE TABLE circuit_breaker_events (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL,
  event        TEXT NOT NULL,   -- 'tripped' | 'reset' | 'degraded'
  reason       TEXT,
  occurred_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

---

## SQLite Adapter

The engine never imports a SQLite driver directly. All engine code types against the `Db`
adapter interface defined in `packages/engine/src/db/index.ts`. A single synchronous
`openDb()` function detects the runtime and returns the appropriate implementation.
No ORM is used — all queries are raw parameterised SQL.

```typescript
// packages/engine/src/db/index.ts

export interface DbStatement<T> {
  get(...params: unknown[]): T | undefined;
  all(...params: unknown[]): T[];
  run(...params: unknown[]): void;
}

export interface Db {
  prepare<T = Record<string, unknown>>(sql: string): DbStatement<T>;
  transaction<T>(fn: () => T): () => T;
  exec(sql: string): void;
  close(): void;
}

export function openDb(path: string): Db {
  if (typeof (globalThis as Record<string, unknown>)["Bun"] !== "undefined") {
    return _openBunSqlite(path);   // bun:sqlite — built into the Bun runtime
  }
  return _openBetterSqlite3(path); // better-sqlite3 — native binding for Node.js 18+
}
```

Both internal implementations enable WAL mode and foreign-key enforcement immediately after
opening the file:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
```

The rest of the engine calls only `db.prepare()`, `db.exec()`, `db.transaction()`, and
`db.close()` — it is unaware of which driver is running.

