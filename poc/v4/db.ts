/**
 * OpenSync POC v4 — SQLite database layer
 *
 * Uses bun:sqlite directly (no ORM) for the POC.
 * The openDb() signature is compatible with the dual-driver adapter spec in
 * specs/database.md — swapping in better-sqlite3 or Drizzle is an additive change.
 */
import { Database } from "bun:sqlite";

export type Db = Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  bootstrap(db);
  return db;
}

// ─── Schema bootstrap ─────────────────────────────────────────────────────────

function bootstrap(db: Db): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS identity_map (
      canonical_id  TEXT NOT NULL,
      connector_id  TEXT NOT NULL,
      external_id   TEXT NOT NULL,
      PRIMARY KEY (canonical_id, connector_id),
      UNIQUE (connector_id, external_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS watermarks (
      connector_id  TEXT NOT NULL,
      entity_name   TEXT NOT NULL,
      since         TEXT NOT NULL,
      PRIMARY KEY (connector_id, entity_name)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS shadow_state (
      connector_id    TEXT NOT NULL,
      entity_name     TEXT NOT NULL,
      external_id     TEXT NOT NULL,
      canonical_id    TEXT NOT NULL,
      canonical_data  TEXT NOT NULL,
      deleted_at      TEXT,
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (connector_id, entity_name, external_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS connector_state (
      connector_id  TEXT NOT NULL,
      key           TEXT NOT NULL,
      value         TEXT NOT NULL,
      PRIMARY KEY (connector_id, key)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transaction_log (
      id            TEXT PRIMARY KEY,
      batch_id      TEXT NOT NULL,
      connector_id  TEXT NOT NULL,
      entity_name   TEXT NOT NULL,
      external_id   TEXT NOT NULL,
      canonical_id  TEXT NOT NULL,
      action        TEXT NOT NULL,
      data_before   TEXT,
      data_after    TEXT,
      synced_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_runs (
      id              TEXT PRIMARY KEY,
      batch_id        TEXT NOT NULL,
      channel_id      TEXT NOT NULL,
      connector_id    TEXT NOT NULL,
      inserted        INTEGER NOT NULL DEFAULT 0,
      updated         INTEGER NOT NULL DEFAULT 0,
      skipped         INTEGER NOT NULL DEFAULT 0,
      deferred        INTEGER NOT NULL DEFAULT 0,
      errors          INTEGER NOT NULL DEFAULT 0,
      started_at      TEXT NOT NULL,
      finished_at     TEXT NOT NULL
    )
  `);
}

// ─── Identity map ─────────────────────────────────────────────────────────────

export function dbGetCanonicalId(
  db: Db,
  connectorId: string,
  externalId: string,
): string | undefined {
  const row = db
    .query<{ canonical_id: string }, [string, string]>(
      "SELECT canonical_id FROM identity_map WHERE connector_id = ? AND external_id = ?",
    )
    .get(connectorId, externalId);
  return row?.canonical_id;
}

export function dbGetExternalId(
  db: Db,
  canonicalId: string,
  connectorId: string,
): string | undefined {
  const row = db
    .query<{ external_id: string }, [string, string]>(
      "SELECT external_id FROM identity_map WHERE canonical_id = ? AND connector_id = ?",
    )
    .get(canonicalId, connectorId);
  return row?.external_id;
}

export function dbLinkIdentity(
  db: Db,
  canonicalId: string,
  connectorId: string,
  externalId: string,
): void {
  db.run(
    `INSERT INTO identity_map (canonical_id, connector_id, external_id)
     VALUES (?, ?, ?)
     ON CONFLICT (connector_id, external_id) DO UPDATE SET canonical_id = excluded.canonical_id`,
    [canonicalId, connectorId, externalId],
  );
}

// ─── Watermarks ───────────────────────────────────────────────────────────────

export function dbGetWatermark(
  db: Db,
  connectorId: string,
  entityName: string,
): string | undefined {
  const row = db
    .query<{ since: string }, [string, string]>(
      "SELECT since FROM watermarks WHERE connector_id = ? AND entity_name = ?",
    )
    .get(connectorId, entityName);
  return row?.since;
}

export function dbSetWatermark(
  db: Db,
  connectorId: string,
  entityName: string,
  since: string,
): void {
  db.run(
    `INSERT INTO watermarks (connector_id, entity_name, since)
     VALUES (?, ?, ?)
     ON CONFLICT (connector_id, entity_name) DO UPDATE SET since = excluded.since`,
    [connectorId, entityName, since],
  );
}

// ─── Shadow state ─────────────────────────────────────────────────────────────
//
// canonical_data is stored as a field-level map:
//   { [fieldName]: { val: unknown; prev: unknown; ts: number; src: string } }
//
// The `__assoc__` key carries a JSON-serialised sorted association array for
// change detection on association-only updates (same sentinel as buildFingerprint).
//
// This structure is required by rollback (prev), conflict resolution (ts, src),
// data access queries (src, ts per field), and FieldDiff event emission.

export interface FieldEntry {
  val: unknown;
  prev: unknown;
  ts: number;   // epoch ms
  src: string;  // connectorId that last wrote this field
}

export type FieldData = Record<string, FieldEntry>;

export interface ShadowRow {
  fieldData: FieldData;
  deletedAt: string | null;
}

export function dbGetShadow(
  db: Db,
  connectorId: string,
  entityName: string,
  externalId: string,
): FieldData | undefined {
  const row = db
    .query<{ canonical_data: string; deleted_at: string | null }, [string, string, string]>(
      "SELECT canonical_data, deleted_at FROM shadow_state WHERE connector_id = ? AND entity_name = ? AND external_id = ?",
    )
    .get(connectorId, entityName, externalId);
  if (!row) return undefined;
  // A deleted row still has FieldData; callers that need to check resurrection
  // can call dbGetShadowRow() instead. dbGetShadow() returns the data as-is —
  // the engine checks deleted_at via dbGetShadowRow() when needed.
  return JSON.parse(row.canonical_data) as FieldData;
}

/**
 * Like dbGetShadow but also returns the deleted_at timestamp.
 * Used by the ingest resurrection check.
 */
export function dbGetShadowRow(
  db: Db,
  connectorId: string,
  entityName: string,
  externalId: string,
): ShadowRow | undefined {
  const row = db
    .query<{ canonical_data: string; deleted_at: string | null }, [string, string, string]>(
      "SELECT canonical_data, deleted_at FROM shadow_state WHERE connector_id = ? AND entity_name = ? AND external_id = ?",
    )
    .get(connectorId, entityName, externalId);
  if (!row) return undefined;
  return { fieldData: JSON.parse(row.canonical_data) as FieldData, deletedAt: row.deleted_at };
}

export function dbSetShadow(
  db: Db,
  connectorId: string,
  entityName: string,
  externalId: string,
  canonicalId: string,
  fieldData: FieldData,
): void {
  db.run(
    `INSERT INTO shadow_state (connector_id, entity_name, external_id, canonical_id, canonical_data, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT (connector_id, entity_name, external_id) DO UPDATE SET
       canonical_id   = excluded.canonical_id,
       canonical_data = excluded.canonical_data,
       deleted_at     = NULL,
       updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    [connectorId, entityName, externalId, canonicalId, JSON.stringify(fieldData)],
  );
}

/**
 * Mark a shadow_state row as deleted without removing it.
 * Preserves the row for resurrection detection and transaction log data_before.
 */
export function dbMarkShadowDeleted(
  db: Db,
  connectorId: string,
  entityName: string,
  externalId: string,
): void {
  db.run(
    `UPDATE shadow_state SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE connector_id = ? AND entity_name = ? AND external_id = ?`,
    [connectorId, entityName, externalId],
  );
}

/**
 * Extract a plain canonical record (field name → value) from a FieldData shadow.
 * Used when the engine needs the plain value map (e.g. for outbound writes).
 */
export function shadowToCanonical(fd: FieldData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, entry] of Object.entries(fd)) {
    if (k !== "__assoc__") out[k] = entry.val;
  }
  return out;
}

/**
 * Build a new FieldData by merging incoming canonical fields into an existing shadow.
 * Fields not present in `incoming` are carried forward unchanged.
 * The `__assoc__` sentinel is handled separately via assocSentinel.
 *
 * @param existing  Current FieldData from shadow_state (undefined if record is new)
 * @param incoming  Plain canonical values from the current ingest pass
 * @param src       connectorId that is writing these fields
 * @param ts        Epoch ms timestamp for this write
 * @param assocSentinel  Serialised association string (or undefined if no associations)
 */
export function buildFieldData(
  existing: FieldData | undefined,
  incoming: Record<string, unknown>,
  src: string,
  ts: number,
  assocSentinel: string | undefined,
): FieldData {
  const fd: FieldData = existing ? { ...existing } : {};
  for (const [k, val] of Object.entries(incoming)) {
    const prev = fd[k]?.val ?? null;
    fd[k] = { val, prev, ts, src };
  }
  if (assocSentinel !== undefined) {
    const prev = fd["__assoc__"]?.val ?? null;
    fd["__assoc__"] = { val: assocSentinel, prev, ts, src };
  }
  return fd;
}

// ─── Transaction log ──────────────────────────────────────────────────────────

export function dbLogTransaction(
  db: Db,
  entry: {
    batchId: string;
    connectorId: string;
    entityName: string;
    externalId: string;
    canonicalId: string;
    action: "insert" | "update";
    dataBefore: FieldData | undefined;
    dataAfter: FieldData;
  },
): void {
  db.run(
    `INSERT INTO transaction_log
       (id, batch_id, connector_id, entity_name, external_id, canonical_id, action, data_before, data_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      entry.batchId,
      entry.connectorId,
      entry.entityName,
      entry.externalId,
      entry.canonicalId,
      entry.action,
      entry.dataBefore !== undefined ? JSON.stringify(entry.dataBefore) : null,
      JSON.stringify(entry.dataAfter),
    ],
  );
}

// ─── Sync runs ────────────────────────────────────────────────────────────────

export function dbLogSyncRun(
  db: Db,
  entry: {
    batchId: string;
    channelId: string;
    connectorId: string;
    inserted: number;
    updated: number;
    skipped: number;
    deferred: number;
    errors: number;
    startedAt: string;
    finishedAt: string;
  },
): void {
  db.run(
    `INSERT INTO sync_runs
       (id, batch_id, channel_id, connector_id, inserted, updated, skipped, deferred, errors, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      entry.batchId,
      entry.channelId,
      entry.connectorId,
      entry.inserted,
      entry.updated,
      entry.skipped,
      entry.deferred,
      entry.errors,
      entry.startedAt,
      entry.finishedAt,
    ],
  );
}

// ─── Identity field matching (Probe 1) ───────────────────────────────────────

/**
 * Query shadow_state for any row in a *different* connector that has
 * `fieldName.val === value` for the given entity.
 *
 * canonical_data is stored as FieldData: { [field]: { val, prev, ts, src } }
 * so the JSON path to check is `'$.' || fieldName || '.val'`.
 *
 * Returns the canonical_id of the matching row, or undefined if none found.
 */
export function dbFindCanonicalByField(
  db: Db,
  entityName: string,
  excludeConnectorId: string,
  fieldName: string,
  value: unknown,
): string | undefined {
  // JSON_EXTRACT on a stored JSON string returns the unquoted scalar value,
  // so bind the raw value (string/number/boolean), not JSON.stringify(value).
  const raw = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : JSON.stringify(value);
  const row = db
    .query<{ canonical_id: string }, [string, string, string, string | number | boolean]>(
      `SELECT canonical_id FROM shadow_state
       WHERE entity_name = ?
         AND connector_id != ?
         AND JSON_EXTRACT(canonical_data, '$.' || ? || '.val') = ?
       LIMIT 1`,
    )
    .get(entityName, excludeConnectorId, fieldName, raw);
  return row?.canonical_id;
}

/**
 * Merge two canonical IDs into one by repointing all `identity_map` and
 * `shadow_state` rows from `dropId` to `keepId`.
 *
 * Called when field-value identity matching discovers that two previously
 * separate canonical UUIDs actually represent the same entity.
 */
export function dbMergeCanonicals(db: Db, keepId: string, dropId: string): void {
  db.run(
    "UPDATE identity_map SET canonical_id = ? WHERE canonical_id = ?",
    [keepId, dropId],
  );
  db.run(
    "UPDATE shadow_state SET canonical_id = ? WHERE canonical_id = ?",
    [keepId, dropId],
  );
}

// ─── Connector state (ctx.state) ──────────────────────────────────────────────
export function makeConnectorState(db: Db, connectorId: string) {
  return {
    get(key: string): unknown | undefined {
      const row = db
        .query<{ value: string }, [string, string]>(
          "SELECT value FROM connector_state WHERE connector_id = ? AND key = ?",
        )
        .get(connectorId, key);
      return row ? (JSON.parse(row.value) as unknown) : undefined;
    },
    set(key: string, value: unknown): void {
      db.run(
        `INSERT INTO connector_state (connector_id, key, value)
         VALUES (?, ?, ?)
         ON CONFLICT (connector_id, key) DO UPDATE SET value = excluded.value`,
        [connectorId, key, JSON.stringify(value)],
      );
    },
    delete(key: string): void {
      db.run(
        "DELETE FROM connector_state WHERE connector_id = ? AND key = ?",
        [connectorId, key],
      );
    },
  };
}
