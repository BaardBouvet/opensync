// Spec: specs/database.md — database query helpers
// All SQL interactions go through these functions. Engine code never runs raw SQL directly.

import type { Db } from "./index.js";
import type { FieldData } from "./schema.js";

// ─── Identity map ─────────────────────────────────────────────────────────────

export function dbGetCanonicalId(
  db: Db,
  connectorId: string,
  externalId: string,
): string | undefined {
  return db
    .prepare<{ canonical_id: string }>(
      "SELECT canonical_id FROM identity_map WHERE connector_id = ? AND external_id = ?",
    )
    .get(connectorId, externalId)?.canonical_id;
}

export function dbGetExternalId(
  db: Db,
  canonicalId: string,
  connectorId: string,
): string | undefined {
  return db
    .prepare<{ external_id: string }>(
      "SELECT external_id FROM identity_map WHERE canonical_id = ? AND connector_id = ?",
    )
    .get(canonicalId, connectorId)?.external_id;
}

export function dbLinkIdentity(
  db: Db,
  canonicalId: string,
  connectorId: string,
  externalId: string,
): void {
  db.prepare(
    `INSERT INTO identity_map (canonical_id, connector_id, external_id)
     VALUES (?, ?, ?)
     ON CONFLICT (connector_id, external_id) DO UPDATE SET canonical_id = excluded.canonical_id`,
  ).run(canonicalId, connectorId, externalId);
}

export function dbMergeCanonicals(db: Db, keepId: string, dropId: string): void {
  db.prepare("UPDATE identity_map SET canonical_id = ? WHERE canonical_id = ?").run(keepId, dropId);
  db.prepare("UPDATE shadow_state SET canonical_id = ? WHERE canonical_id = ?").run(keepId, dropId);
}

export function dbFindCanonicalByField(
  db: Db,
  entityName: string,
  excludeConnectorId: string,
  fieldName: string,
  value: unknown,
): string | undefined {
  const raw =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? value
      : JSON.stringify(value);
  return db
    .prepare<{ canonical_id: string }>(
      `SELECT canonical_id FROM shadow_state
       WHERE entity_name = ?
         AND connector_id != ?
         AND JSON_EXTRACT(canonical_data, '$.' || ? || '.val') = ?
       LIMIT 1`,
    )
    .get(entityName, excludeConnectorId, fieldName, raw)?.canonical_id;
}

export function dbGetAllCanonicals(db: Db, connectorIds: string[]): string[] {
  if (connectorIds.length === 0) return [];
  const placeholders = connectorIds.map(() => "?").join(", ");
  return db
    .prepare<{ canonical_id: string }>(
      `SELECT DISTINCT canonical_id FROM identity_map WHERE connector_id IN (${placeholders})`,
    )
    .all(...connectorIds)
    .map((r) => r.canonical_id);
}

/**
 * Returns canonical IDs that are linked to at least one member in the given
 * list, filtered by entity name via shadow_state. This prevents contacts/
 * employees from leaking into a companies channel that shares the same
 * connector IDs.
 */
export function dbGetCanonicalsByChannelMembers(
  db: Db,
  members: Array<{ connectorId: string; entity: string }>,
): string[] {
  if (members.length === 0) return [];
  const clauses = members
    .map(() => "(im.connector_id = ? AND ss.entity_name = ?)")
    .join(" OR ");
  const params = members.flatMap((m) => [m.connectorId, m.entity]);
  return db
    .prepare<{ canonical_id: string }>(
      `SELECT DISTINCT im.canonical_id
       FROM identity_map im
       JOIN shadow_state ss
         ON ss.connector_id = im.connector_id AND ss.external_id = im.external_id
       WHERE (${clauses})`,
    )
    .all(...params)
    .map((r) => r.canonical_id);
}

export function dbGetLinkedConnectors(db: Db, canonicalId: string): string[] {
  return db
    .prepare<{ connector_id: string }>(
      "SELECT connector_id FROM identity_map WHERE canonical_id = ?",
    )
    .all(canonicalId)
    .map((r) => r.connector_id);
}

// ─── Watermarks ───────────────────────────────────────────────────────────────

export function dbGetWatermark(
  db: Db,
  connectorId: string,
  entityName: string,
): string | undefined {
  return db
    .prepare<{ since: string }>(
      "SELECT since FROM watermarks WHERE connector_id = ? AND entity_name = ?",
    )
    .get(connectorId, entityName)?.since;
}

export function dbSetWatermark(
  db: Db,
  connectorId: string,
  entityName: string,
  since: string,
): void {
  db.prepare(
    `INSERT INTO watermarks (connector_id, entity_name, since)
     VALUES (?, ?, ?)
     ON CONFLICT (connector_id, entity_name) DO UPDATE SET since = excluded.since`,
  ).run(connectorId, entityName, since);
}

// ─── Shadow state ─────────────────────────────────────────────────────────────

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
    .prepare<{ canonical_data: string; deleted_at: string | null }>(
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
    .prepare<{ canonical_data: string; deleted_at: string | null }>(
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
  db.prepare(
    `INSERT INTO shadow_state (connector_id, entity_name, external_id, canonical_id, canonical_data, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT (connector_id, entity_name, external_id) DO UPDATE SET
       canonical_id   = excluded.canonical_id,
       canonical_data = excluded.canonical_data,
       deleted_at     = NULL,
       updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(connectorId, entityName, externalId, canonicalId, JSON.stringify(fieldData));
}

export function dbGetAllShadowForEntity(
  db: Db,
  connectorId: string,
  entityName: string,
): Array<{ externalId: string; fieldData: FieldData }> {
  return db
    .prepare<{ external_id: string; canonical_data: string }>(
      `SELECT external_id, canonical_data FROM shadow_state
       WHERE connector_id = ? AND entity_name = ? AND deleted_at IS NULL`,
    )
    .all(connectorId, entityName)
    .map((row) => ({
      externalId: row.external_id,
      fieldData: JSON.parse(row.canonical_data) as FieldData,
    }));
}

export function dbGetCanonicalFields(db: Db, canonicalId: string): Record<string, unknown> {
  const rows = db
    .prepare<{ canonical_data: string }>(
      `SELECT ss.canonical_data
       FROM shadow_state ss
       JOIN identity_map im ON im.connector_id = ss.connector_id
         AND im.external_id = ss.external_id
       WHERE im.canonical_id = ? AND ss.deleted_at IS NULL`,
    )
    .all(canonicalId);

  const merged: Record<string, unknown> = {};
  for (const row of rows) {
    const fd = JSON.parse(row.canonical_data) as FieldData;
    for (const [k, entry] of Object.entries(fd)) {
      if (k === "__assoc__") continue;
      if (!(k in merged) && entry.val !== null && entry.val !== undefined) {
        merged[k] = entry.val;
      }
    }
  }
  return merged;
}

// ─── FieldData helpers ────────────────────────────────────────────────────────

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
  db.prepare(
    `INSERT INTO transaction_log
       (id, batch_id, connector_id, entity_name, external_id, canonical_id, action, data_before, data_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    entry.batchId,
    entry.connectorId,
    entry.entityName,
    entry.externalId,
    entry.canonicalId,
    entry.action,
    entry.dataBefore !== undefined ? JSON.stringify(entry.dataBefore) : null,
    JSON.stringify(entry.dataAfter),
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
  db.prepare(
    `INSERT INTO sync_runs
       (id, batch_id, channel_id, connector_id, inserted, updated, skipped, deferred, errors, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
  );
}

// ─── Request journal ──────────────────────────────────────────────────────────

export type JournalTrigger = "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh";

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
  db.prepare(
    `INSERT INTO request_journal
       (id, connector_id, batch_id, trigger, method, url, request_body, request_headers,
        response_status, response_body, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
  );
}

// ─── Connector state ──────────────────────────────────────────────────────────

export function makeConnectorState(db: Db, connectorId: string) {
  return {
    get(key: string): unknown | undefined {
      const row = db
        .prepare<{ value: string }>(
          "SELECT value FROM connector_state WHERE connector_id = ? AND key = ?",
        )
        .get(connectorId, key);
      return row ? (JSON.parse(row.value) as unknown) : undefined;
    },
    set(key: string, value: unknown): void {
      db.prepare(
        `INSERT INTO connector_state (connector_id, key, value)
         VALUES (?, ?, ?)
         ON CONFLICT (connector_id, key) DO UPDATE SET value = excluded.value`,
      ).run(connectorId, key, JSON.stringify(value));
    },
    delete(key: string): void {
      db.prepare("DELETE FROM connector_state WHERE connector_id = ? AND key = ?").run(
        connectorId,
        key,
      );
    },
  };
}

// ─── OAuth tokens ─────────────────────────────────────────────────────────────

export interface OAuthTokenRow {
  connector_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  locked_at: string | null;
}

export function dbGetOAuthToken(db: Db, connectorId: string): OAuthTokenRow | undefined {
  return db
    .prepare<OAuthTokenRow>("SELECT * FROM oauth_tokens WHERE connector_id = ?")
    .get(connectorId);
}

export function dbUpsertOAuthToken(
  db: Db,
  connectorId: string,
  token: { accessToken: string; refreshToken?: string; expiresAt?: string },
): void {
  db.prepare(
    `INSERT INTO oauth_tokens (connector_id, access_token, refresh_token, expires_at, locked_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (connector_id) DO UPDATE SET
       access_token  = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at    = excluded.expires_at,
       locked_at     = NULL`,
  ).run(
    connectorId,
    token.accessToken,
    token.refreshToken ?? null,
    token.expiresAt ?? null,
  );
}

export function dbAcquireOAuthLock(db: Db, connectorId: string): boolean {
  const now = new Date().toISOString();
  const staleThreshold = new Date(Date.now() - 30_000).toISOString();
  const result = db
    .prepare(
      `UPDATE oauth_tokens SET locked_at = ?
       WHERE connector_id = ? AND (locked_at IS NULL OR locked_at < ?)`,
    )
    .run(now, connectorId, staleThreshold);
  // better-sqlite3 run() returns a RunResult with .changes
  return (result as unknown as { changes: number }).changes === 1;
}

export function dbReleaseOAuthLock(db: Db, connectorId: string): void {
  db.prepare("UPDATE oauth_tokens SET locked_at = NULL WHERE connector_id = ?").run(connectorId);
}

// ─── Channel onboarding status ────────────────────────────────────────────────

export function dbGetChannelStatus(db: Db, channelId: string): "ready" | "uninitialized" {
  const row = db
    .prepare<{ channel_id: string }>(
      "SELECT channel_id FROM channel_onboarding_status WHERE channel_id = ?",
    )
    .get(channelId);
  return row ? "ready" : "uninitialized";
}

export function dbSetChannelReady(db: Db, channelId: string, entity: string): void {
  db.prepare(
    `INSERT INTO channel_onboarding_status (channel_id, entity, marked_ready_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (channel_id) DO UPDATE SET
       entity = excluded.entity,
       marked_ready_at = excluded.marked_ready_at`,
  ).run(channelId, entity);
}

// ─── Circuit breaker events (Gap 2) ──────────────────────────────────────────

// Spec: plans/engine/PLAN_PRODUCTION_ENGINE_M2.md §7.2
export function dbLogCircuitBreakerEvent(
  db: Db,
  channelId: string,
  event: "trip" | "reset" | "half_open",
  reason?: string,
): void {
  db.prepare(
    `INSERT INTO circuit_breaker_events (id, channel_id, event, reason)
     VALUES (?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), channelId, event, reason ?? null);
}

export function dbGetRecentCircuitBreakerEvents(
  db: Db,
  channelId: string,
  sinceMs: number,
): Array<{ event: string; occurred_at: string }> {
  const since = new Date(sinceMs).toISOString();
  return db
    .prepare<{ event: string; occurred_at: string }>(
      `SELECT event, occurred_at FROM circuit_breaker_events
       WHERE channel_id = ? AND occurred_at >= ?
       ORDER BY occurred_at DESC`,
    )
    .all(channelId, since);
}

// ─── Deferred associations ────────────────────────────────────────────────────
// Spec: plans/engine/PLAN_DEFERRED_ASSOCIATIONS.md §2.1

export function dbInsertDeferred(
  db: Db,
  sourceConnector: string,
  entityName: string,
  sourceExternalId: string,
  targetConnector: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO deferred_associations
       (source_connector, entity_name, source_external_id, target_connector, deferred_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sourceConnector, entityName, sourceExternalId, targetConnector, Date.now());
}

export function dbGetDeferred(
  db: Db,
  sourceConnector: string,
  entityName: string,
): Array<{ source_external_id: string; target_connector: string }> {
  return db
    .prepare<{ source_external_id: string; target_connector: string }>(
      `SELECT source_external_id, target_connector FROM deferred_associations
       WHERE source_connector = ? AND entity_name = ?`,
    )
    .all(sourceConnector, entityName);
}

export function dbRemoveDeferred(
  db: Db,
  sourceConnector: string,
  entityName: string,
  sourceExternalId: string,
  targetConnector: string,
): void {
  db.prepare(
    `DELETE FROM deferred_associations
     WHERE source_connector = ? AND entity_name = ? AND source_external_id = ? AND target_connector = ?`,
  ).run(sourceConnector, entityName, sourceExternalId, targetConnector);
}
