/**
 * OpenSync POC v6 — SQLite database layer
 *
 * Extends v5 with one new table:
 *   oauth_tokens  — access token + refresh token cache for OAuth2 connectors
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

  // ── v5: request journal ───────────────────────────────────────────────────

  db.run(`
    CREATE TABLE IF NOT EXISTS request_journal (
      id               TEXT PRIMARY KEY,
      connector_id     TEXT NOT NULL,
      batch_id         TEXT,
      trigger          TEXT,
      method           TEXT NOT NULL,
      url              TEXT NOT NULL,
      request_body     TEXT,
      request_headers  TEXT,
      response_status  INTEGER NOT NULL,
      response_body    TEXT,
      duration_ms      INTEGER NOT NULL,
      called_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  // Migration: add trigger column to existing databases that pre-date it
  const cols = db.query<{ name: string }, []>(
    "PRAGMA table_info(request_journal)",
  ).all();
  if (!cols.some((c) => c.name === "trigger")) {
    db.run("ALTER TABLE request_journal ADD COLUMN trigger TEXT");
  }

  // ── v5: webhook queue ─────────────────────────────────────────────────────

  db.run(`
    CREATE TABLE IF NOT EXISTS webhook_queue (
      id            TEXT PRIMARY KEY,
      connector_id  TEXT NOT NULL,
      raw_payload   TEXT NOT NULL,
      batch_id      TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      attempts      INTEGER NOT NULL DEFAULT 0,
      error         TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      processed_at  TEXT
    )
  `);

  // Migration: add batch_id column to existing webhook_queue tables that pre-date it
  const wqCols = db.query<{ name: string }, []>(
    "PRAGMA table_info(webhook_queue)",
  ).all();
  if (!wqCols.some((c) => c.name === "batch_id")) {
    db.run("ALTER TABLE webhook_queue ADD COLUMN batch_id TEXT");
  }

  // ── v6: OAuth token cache ────────────────────────────────────────────────────

  db.run(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      connector_id    TEXT PRIMARY KEY,
      access_token    TEXT NOT NULL,
      refresh_token   TEXT,
      expires_at      TEXT,
      locked_at       TEXT
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

export interface FieldEntry {
  val: unknown;
  prev: unknown;
  ts: number;
  src: string;
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
  return JSON.parse(row.canonical_data) as FieldData;
}

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

export function shadowToCanonical(fd: FieldData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, entry] of Object.entries(fd)) {
    if (k !== "__assoc__") out[k] = entry.val;
  }
  return out;
}

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

// ─── Identity field matching ──────────────────────────────────────────────────

export function dbFindCanonicalByField(
  db: Db,
  entityName: string,
  excludeConnectorId: string,
  fieldName: string,
  value: unknown,
): string | undefined {
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

// ─── Request journal (v5) ─────────────────────────────────────────────────────

export type JournalTrigger = "poll" | "webhook" | "on_enable" | "on_disable";

export function dbLogRequestJournal(
  db: Db,
  entry: {
    connectorId: string;
    batchId: string | undefined;
    trigger: JournalTrigger | undefined;
    method: string;
    url: string;
    requestBody: string | null;
    requestHeaders: string | null;
    responseStatus: number;
    responseBody: string | null;
    durationMs: number;
  },
): void {
  db.run(
    `INSERT INTO request_journal
       (id, connector_id, batch_id, trigger, method, url, request_body, request_headers,
        response_status, response_body, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      entry.connectorId,
      entry.batchId ?? null,
      entry.trigger ?? null,
      entry.method,
      entry.url,
      entry.requestBody,
      entry.requestHeaders,
      entry.responseStatus,
      entry.responseBody,
      entry.durationMs,
    ],
  );
}

export interface RequestJournalRow {
  id: string;
  connector_id: string;
  batch_id: string | null;
  trigger: string | null;
  method: string;
  url: string;
  request_body: string | null;
  request_headers: string | null;
  response_status: number;
  response_body: string | null;
  duration_ms: number;
  called_at: string;
}

export function dbGetJournalRows(
  db: Db,
  connectorId?: string,
): RequestJournalRow[] {
  if (connectorId) {
    return db
      .query<RequestJournalRow, [string]>(
        "SELECT * FROM request_journal WHERE connector_id = ? ORDER BY called_at",
      )
      .all(connectorId);
  }
  return db
    .query<RequestJournalRow, []>("SELECT * FROM request_journal ORDER BY called_at")
    .all();
}

// ─── Webhook queue (v5) ───────────────────────────────────────────────────────

export function dbEnqueueWebhook(
  db: Db,
  connectorId: string,
  rawPayload: string,
): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO webhook_queue (id, connector_id, raw_payload) VALUES (?, ?, ?)`,
    [id, connectorId, rawPayload],
  );
  return id;
}

export interface WebhookQueueRow {
  id: string;
  connector_id: string;
  raw_payload: string;
  batch_id: string | null;
  status: string;
  attempts: number;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}

export function dbGetPendingWebhooks(
  db: Db,
  connectorIds: string[],
): WebhookQueueRow[] {
  if (connectorIds.length === 0) return [];
  const placeholders = connectorIds.map(() => "?").join(", ");
  return db
    .query<WebhookQueueRow, string[]>(
      `SELECT * FROM webhook_queue
       WHERE status = 'pending' AND connector_id IN (${placeholders})
       ORDER BY created_at`,
    )
    .all(...connectorIds);
}

export function dbGetWebhookRows(db: Db, connectorId?: string): WebhookQueueRow[] {
  if (connectorId) {
    return db
      .query<WebhookQueueRow, [string]>(
        "SELECT * FROM webhook_queue WHERE connector_id = ? ORDER BY created_at",
      )
      .all(connectorId);
  }
  return db
    .query<WebhookQueueRow, []>("SELECT * FROM webhook_queue ORDER BY created_at")
    .all();
}

export function dbMarkWebhookProcessing(db: Db, id: string, batchId: string): void {
  db.run(
    `UPDATE webhook_queue SET status = 'processing', attempts = attempts + 1, batch_id = ? WHERE id = ?`,
    [batchId, id],
  );
}

export function dbMarkWebhookCompleted(db: Db, id: string): void {
  db.run(
    `UPDATE webhook_queue
     SET status = 'completed', processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
    [id],
  );
}

export function dbMarkWebhookFailed(db: Db, id: string, error: string): void {
  db.run(
    `UPDATE webhook_queue
     SET status = 'failed', error = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
    [error, id],
  );
}

// ─── OAuth tokens (v6) ────────────────────────────────────────────────────────

export interface OAuthTokenRow {
  connector_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  locked_at: string | null;
}

export function dbGetOAuthToken(db: Db, connectorId: string): OAuthTokenRow | undefined {
  return db
    .query<OAuthTokenRow, [string]>(
      "SELECT * FROM oauth_tokens WHERE connector_id = ?",
    )
    .get(connectorId) ?? undefined;
}

export function dbUpsertOAuthToken(
  db: Db,
  connectorId: string,
  token: { accessToken: string; refreshToken?: string; expiresAt?: string },
): void {
  db.run(
    `INSERT INTO oauth_tokens (connector_id, access_token, refresh_token, expires_at, locked_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (connector_id) DO UPDATE SET
       access_token  = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at    = excluded.expires_at,
       locked_at     = NULL`,
    [connectorId, token.accessToken, token.refreshToken ?? null, token.expiresAt ?? null],
  );
}

/**
 * Acquire the refresh lock for a connector.
 * Returns true if this call won the lock, false if another holder already has it
 * (locked_at is set and less than 30 seconds old).
 *
 * SQLite serializes writes, so the UPDATE is atomic even under Bun's async model.
 */
export function dbAcquireOAuthLock(db: Db, connectorId: string): boolean {
  const now = new Date().toISOString();
  const staleThreshold = new Date(Date.now() - 30_000).toISOString();
  const result = db.run(
    `UPDATE oauth_tokens
     SET locked_at = ?
     WHERE connector_id = ?
       AND (locked_at IS NULL OR locked_at < ?)`,
    [now, connectorId, staleThreshold],
  );
  return result.changes === 1;
}

export function dbReleaseOAuthLock(db: Db, connectorId: string): void {
  db.run(
    "UPDATE oauth_tokens SET locked_at = NULL WHERE connector_id = ?",
    [connectorId],
  );
}

export function dbGetAllOAuthTokens(db: Db): OAuthTokenRow[] {
  return db.query<OAuthTokenRow, []>("SELECT * FROM oauth_tokens").all();
}

