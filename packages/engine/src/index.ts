// @opensync/engine — public API
// Only SyncEngine, loadConfig, openDb, and public types are exported.
// Internal modules are not part of the public API.

export { SyncEngine, ConflictError } from "./engine.js";
export type {
  SyncAction,
  RecordSyncResult,
  IngestResult,
  DiscoveryReport,
  DiscoverySide,
  DiscoveryMatch,
  OnboardResult,
  ChannelStatus,
  AddConnectorOptions,
  AddConnectorReport,
} from "./engine.js";

export { loadConfig } from "./config/loader.js";
export type {
  ResolvedConfig,
  ConnectorInstance,
  ChannelConfig,
  ChannelMember,
  ConflictConfig,
  FieldMapping,
  FieldMappingList,
} from "./config/loader.js";

export { openDb } from "./db/index.js";
export type { Db } from "./db/index.js";
