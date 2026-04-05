// Spec: specs/database.md — idempotent schema creation
// Called once on SyncEngine construction. Safe to call on an existing database.

import type { Db } from "./index.js";

// Spec: specs/database.md
export function createSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS identity_map (
      canonical_id  TEXT NOT NULL,
      connector_id  TEXT NOT NULL,
      external_id   TEXT NOT NULL,
      PRIMARY KEY (canonical_id, connector_id),
      UNIQUE (connector_id, external_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS watermarks (
      connector_id  TEXT NOT NULL,
      entity_name   TEXT NOT NULL,
      since         TEXT NOT NULL,
      PRIMARY KEY (connector_id, entity_name)
    )
  `);

  db.exec(`
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_state (
      connector_id  TEXT NOT NULL,
      key           TEXT NOT NULL,
      value         TEXT NOT NULL,
      PRIMARY KEY (connector_id, key)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS transaction_log (
      id            TEXT PRIMARY KEY,
      batch_id      TEXT NOT NULL,
      connector_id  TEXT NOT NULL,
      entity_name   TEXT NOT NULL,
      external_id   TEXT NOT NULL,
      canonical_id  TEXT NOT NULL,
      action        TEXT NOT NULL,
      data_before   TEXT,
      data_after    TEXT NOT NULL,
      synced_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_runs (
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
    )
  `);

  db.exec(`
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

  // Spec: plans/engine/PLAN_PRODUCTION_ENGINE_M2.md §3.1 — Gap 2 fix
  db.exec(`
    CREATE TABLE IF NOT EXISTS circuit_breaker_events (
      id           TEXT PRIMARY KEY,
      channel_id   TEXT NOT NULL,
      event        TEXT NOT NULL,
      reason       TEXT,
      occurred_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      connector_id  TEXT PRIMARY KEY,
      access_token  TEXT NOT NULL,
      refresh_token TEXT,
      expires_at    TEXT,
      locked_at     TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_onboarding_status (
      channel_id       TEXT PRIMARY KEY,
      entity           TEXT NOT NULL,
      marked_ready_at  TEXT NOT NULL
    )
  `);

  // Spec: plans/engine/PLAN_DEFERRED_ASSOCIATIONS.md §2.1
  db.exec(`
    CREATE TABLE IF NOT EXISTS deferred_associations (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      source_connector     TEXT    NOT NULL,
      entity_name          TEXT    NOT NULL,
      source_external_id   TEXT    NOT NULL,
      target_connector     TEXT    NOT NULL,
      deferred_at          INTEGER NOT NULL,
      UNIQUE (source_connector, entity_name, source_external_id, target_connector)
    )
  `);
}
