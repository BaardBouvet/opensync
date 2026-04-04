// Spec: specs/database.md — full schema definition
// All tables used by the production engine.

// ─── Row types ────────────────────────────────────────────────────────────────

export interface IdentityMapRow {
  canonical_id: string;
  connector_id: string;
  external_id: string;
}

export interface WatermarkRow {
  connector_id: string;
  entity_name: string;
  since: string;
}

export interface ShadowStateRow {
  connector_id: string;
  entity_name: string;
  external_id: string;
  canonical_id: string;
  canonical_data: string; // JSON: FieldData
  deleted_at: string | null;
  updated_at: string;
}

export interface ConnectorStateRow {
  connector_id: string;
  key: string;
  value: string; // JSON
}

export interface TransactionLogRow {
  id: string;
  batch_id: string;
  connector_id: string;
  entity_name: string;
  external_id: string;
  canonical_id: string;
  action: string; // 'insert' | 'update'
  data_before: string | null; // JSON: FieldData
  data_after: string; // JSON: FieldData
  synced_at: string;
}

export interface SyncRunRow {
  id: string;
  batch_id: string;
  channel_id: string;
  connector_id: string;
  inserted: number;
  updated: number;
  skipped: number;
  deferred: number;
  errors: number;
  started_at: string;
  finished_at: string;
}

export interface RequestJournalRow {
  id: string;
  connector_id: string;
  batch_id: string | null;
  trigger: string | null; // 'poll' | 'webhook' | 'on_enable' | 'on_disable' | 'oauth_refresh'
  method: string;
  url: string;
  request_body: string | null;
  request_headers: string | null; // JSON
  response_status: number;
  response_body: string | null;
  duration_ms: number;
  called_at: string;
}

export interface CircuitBreakerEventRow {
  id: string;
  channel_id: string;
  event: string; // 'trip' | 'reset' | 'half_open'
  reason: string | null;
  occurred_at: string;
}

export interface OAuthTokenRow {
  connector_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  locked_at: string | null;
}

export interface ChannelOnboardingStatusRow {
  channel_id: string;
  entity: string;
  marked_ready_at: string;
}

// ─── FieldData (stored inside shadow_state.canonical_data) ───────────────────

export interface FieldEntry {
  val: unknown;
  prev: unknown;
  ts: number; // epoch ms
  src: string; // connector_id that last wrote this field
}

export type FieldData = Record<string, FieldEntry>;
