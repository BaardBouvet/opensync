// ─── Field Types ─────────────────────────────────────────────────────────────

/**
 * A JSON Schema subset for describing field values.
 * Scalars are plain string literals; objects and arrays compose recursively.
 *
 * Examples:
 *   'string'
 *   { type: 'array', items: { type: 'object', properties: { sku: 'string', qty: 'number' } } }
 */
export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | { type: "object"; properties?: Record<string, FieldType> }
  | { type: "array"; items?: FieldType };

/**
 * Metadata for a single field on an entity or action payload.
 * Used by: agents (description), engine (required/immutable enforcement), tooling (type warnings).
 */
export interface FieldDescriptor {
  /** Human-readable description of what the field contains. Agents use this to understand
   *  abbreviated or non-English field names (e.g. 'fnavn' → 'First name'). */
  description?: string;

  /** Declared value type. The engine warns at channel setup if the source type is incompatible
   *  with what the target entity expects. */
  type?: FieldType;

  /** If true, the field must be present in every insert/update record (entity) or action payload.
   *  The engine rejects records missing required fields before they reach the connector,
   *  yielding a synthetic error result in their place. */
  required?: boolean;

  /** If true, the field cannot be changed after creation. The engine strips immutable fields
   *  from UpdateRecord.data before calling update(), so the connector never sees an attempt
   *  to overwrite them. */
  immutable?: boolean;
}

// ─── Records ─────────────────────────────────────────────────────────────────

/**
 * An explicit reference from one record to another.
 * Connectors extract these from data fields so the engine can track relationships
 * without parsing field values itself.
 */
export interface Association {
  /** The field key in data whose value is this reference (e.g. 'companyId').
   *  For JSON-LD connectors, may be a full URI (e.g. 'https://schema.org/worksFor'). */
  predicate: string;

  /** Name of the target entity. Together with targetId, forms the composite key
   *  (entity, id) used everywhere in the engine. */
  targetEntity: string;

  /** The referenced record's ID — usually the value of data[predicate]. */
  targetId: string;

  /** Optional edge-level properties beyond the reference itself (e.g. { since: '2020-01-01' }). */
  metadata?: Record<string, unknown>;
}

/**
 * A record returned by fetch() or lookup(). Also the element type inside FetchBatch.
 *
 * IDs are scoped to (entity, id): '123' from 'contact' and '123' from 'company' are distinct.
 */
export interface FetchRecord {
  /** This record's ID in the source system. Unique within the entity. */
  id: string;

  /** Raw field values. Values may be single (most APIs) or multi-valued arrays
   *  (graph / semantic sources). No common data model — connectors expose source fields as-is. */
  data: Record<string, unknown | unknown[]>;

  /** When true, signals the engine to remove this record from the target.
   *  Covers hard deletes, soft-delete-as-removal, and webhook DELETED events.
   *  Omit (or set false) to keep the record in the target even if it's archived/inactive in the source. */
  deleted?: boolean;

  /** Pre-extracted reference fields. The engine uses these to resolve relationships without
   *  inspecting raw data values. */
  associations?: Association[];
}

/**
 * A page of records yielded by fetch(). Each batch carries its own watermark
 * so the engine can resume from the last committed position on interruption.
 */
export interface FetchBatch {
  records: FetchRecord[];

  /** Opaque watermark for this batch. The engine stores the latest value it receives;
   *  on the next poll it passes it back via the `since` parameter.
   *  Semantics are connector-defined: ISO timestamp, cursor token, sequence number, etc. */
  since?: string;
}

// ─── Write Records ───────────────────────────────────────────────────────────
// All fields are engine-owned. Connectors must not mutate them.

/** Payload for creating a new record in the target system. */
export interface InsertRecord {
  /** Field values to write. Immutable fields declared in the entity schema are never
   *  included here — they are only meaningful on creation, not insert (which IS creation). */
  data: Record<string, unknown | unknown[]>;

  /** Associations to establish after the record is created. */
  associations?: Association[];
}

/** Payload for updating an existing record in the target system. */
export interface UpdateRecord {
  /** The ID previously returned by InsertResult.id for this record in this target system.
   *  Maintained by the engine's identity map — connectors must not mutate it. */
  id: string;

  /** Field values to write. Immutable fields (schema.immutable: true) are stripped by
   *  the engine before this reaches the connector. */
  data: Record<string, unknown | unknown[]>;

  /** Updated association set, if any changed. */
  associations?: Association[];
}

// ─── Write Results ────────────────────────────────────────────────────────────
// One result per input record/ID, in the same order (positional correlation).

export interface InsertResult {
  /** ID assigned by this (target) system. Stored in the engine's identity map and
   *  fed back as UpdateRecord.id and the delete ID on future writes. */
  id: string;

  /** Full API response, if available. Stored for echo prevention — lets the engine recognise
   *  its own writes when they come back through fetch() and suppress them as no-ops. */
  data?: Record<string, unknown>;

  /** Present means this record failed. Absent means success.
   *  For per-record failures use this field; throw only to abort the entire write run. */
  error?: string;
}

export interface UpdateResult {
  /** The ID that was updated. */
  id: string;

  /** Full API response, if available. Used for echo prevention (same as InsertResult.data). */
  data?: Record<string, unknown>;

  /** Present means the record didn't exist in the target — not an error, already gone
   *  or not yet arrived. The engine reconciles on the next cycle. */
  notFound?: true;

  /** Present means this record failed. Absent means success. */
  error?: string;
}

export interface DeleteResult {
  /** The ID that was deleted. */
  id: string;

  /** Present means the record didn't exist in the target — not an error, already gone. */
  notFound?: true;

  /** Present means this record failed. Absent means success. */
  error?: string;
}

// ─── Context ──────────────────────────────────────────────────────────────────

/**
 * fetch()-compatible function with automatic auth injection, request journaling,
 * retry on 429/5xx, and sensitive header masking. Use exactly like fetch().
 * Calls made via ctx.http inside prepareRequest() skip prepareRequest itself (no recursion).
 */
export type TrackedFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

/**
 * Per-instance persistent key-value store backed by the engine's database.
 * All values must be JSON-serializable. Date, undefined, functions, and class instances
 * will be corrupted on the next read.
 */
export interface StateStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;

  /** Atomic read-modify-write. Concurrent calls for the same key are serialized.
   *  If fn throws, state is not updated. If fn exceeds timeoutMs (default 30 000),
   *  rejects with ConnectorError. Use this to avoid TOCTOU races (e.g. token refresh). */
  update<T>(
    key: string,
    fn: (current: T | undefined) => T | Promise<T>,
    timeoutMs?: number
  ): Promise<T>;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Injected by the engine into every connector method call.
 */
export interface ConnectorContext {
  /** Instance config supplied by the user (e.g. baseUrl, portalId).
   *  Read-only. The engine resolves environment-specific base URLs before injecting. */
  config: Record<string, unknown>;

  /** Per-instance persistent key-value store. Use for webhook subscription IDs,
   *  session tokens, and other data that must survive across fetch runs. */
  state: StateStore;

  logger: Logger;

  /** Auto-logged, auto-authed drop-in for fetch(). Retries transient failures.
   *  See TrackedFetch for details. */
  http: TrackedFetch;

  /** Base URL for inbound webhooks to this connector instance. Append any sub-path
   *  or query params — all traffic under this base routes to handleWebhook(). */
  webhookUrl: string;
}

// ─── Entity Definition ────────────────────────────────────────────────────────

/**
 * Defines one object type that a connector can read from and/or write to.
 * At least one of fetch, insert, update, or delete must be present —
 * the engine rejects registration of a bare empty entity.
 */
export interface EntityDefinition {
  /** Unique name for this entity within the connector (e.g. 'contact', 'invoice'). */
  name: string;

  /** Stream all records of this type from the source system.
   *
   *  Optional — omitting it makes this a write-only sink entity (e.g. a data warehouse
   *  table or event log that can receive but has no meaningful read operation).
   *
   *  @param ctx  Connector context.
   *  @param since  Opaque watermark from the previous fetch run. Undefined = full sync.
   *               Return only records modified after this point when provided. */
  fetch?(
    ctx: ConnectorContext,
    since?: string
  ): AsyncIterable<FetchBatch>;

  /** Fetch a specific set of records by ID on-demand (non-streaming).
   *  The engine batches all IDs it needs and calls this once, so connectors with
   *  batch read APIs get the efficiency gain automatically.
   *
   *  Return only the records that were found — omit IDs that don't exist.
   *  Throw on API failure; the engine handles retry.
   *
   *  Used for conflict detection, rollback verification, and reconciliation. */
  lookup?(ids: string[], ctx: ConnectorContext): Promise<FetchRecord[]>;

  /** Create new records in this system. Yields one InsertResult per input record,
   *  in the same order. The assigned id is stored in the engine's identity map.
   *  Throw to abort the whole run; use status: 'error' for per-record failures. */
  insert?(
    records: AsyncIterable<InsertRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<InsertResult>;

  /** Update existing records in this system. Yields one UpdateResult per input record.
   *  'not_found' is a valid terminal result — the record was already gone. */
  update?(
    records: AsyncIterable<UpdateRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<UpdateResult>;

  /** Delete records by ID. Yields one DeleteResult per input ID.
   *  'not_found' is a valid terminal result — the record was already gone. */
  delete?(
    ids: AsyncIterable<string>,
    ctx: ConnectorContext
  ): AsyncIterable<DeleteResult>;

  /** Field metadata for records produced by this entity.
   *  Keys are field names from data. Used by agents (description), engine (required/immutable
   *  enforcement), and tooling (type compatibility warnings at channel setup). */
  schema?: Record<string, FieldDescriptor>;

  /** OAuth scopes split by role. The engine unions only what the channel actually uses,
   *  so a source-only user is never prompted for write permissions.
   *
   *  - read:   requested when this entity is used as a sync source
   *  - write:  requested when this entity is used as a sync target
   *  - always: requested whenever this entity is enabled, regardless of role */
  scopes?: {
    read?: string[];
    write?: string[];
    always?: string[];
  };

  /** Other entity names that must be synced before this one.
   *  The engine resolves a topological order; circular dependencies are rejected.
   *  Example: contacts reference companies, so contact declares dependsOn: ['company']. */
  dependsOn?: string[];

  /** Called when this entity becomes active in a channel (i.e. when a user enables it).
   *  Use to register a webhook subscription scoped to this entity's events.
   *  The engine calls onEnable per entity, so only active entities register subscriptions. */
  onEnable?(ctx: ConnectorContext): Promise<void>;

  /** Called when this entity is deactivated or the connector instance is disabled.
   *  Use to deregister the webhook subscription registered in onEnable. */
  onDisable?(ctx: ConnectorContext): Promise<void>;
}

// ─── Action Definition ────────────────────────────────────────────────────────

/** Result of executing an action. */
export interface ActionResult {
  status: "success" | "failed";
  /** Raw response from the external system, if any. */
  data?: Record<string, unknown>;
}

/**
 * A named side-effect operation exposed by the connector (e.g. 'send-email', 'post-message').
 * Actions share ConnectorContext with entities — ctx.http, ctx.state, ctx.logger all work.
 */
export interface ActionDefinition {
  /** Unique name for this action within the connector. */
  name: string;

  /** Optional description for discovery by agents and CLI tooling. */
  description?: string;

  /** Input payload schema. Required fields are validated by the engine before execute()
   *  is called — missing required fields produce an immediate error without calling the connector. */
  schema?: Record<string, FieldDescriptor>;

  /** OAuth scopes required to execute this action. */
  scopes?: string[];

  execute(
    payload: Record<string, unknown>,
    ctx: ConnectorContext
  ): Promise<ActionResult>;
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

/** A user-configurable field declared in configSchema. */
export interface ConfigField {
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;

  /** If true: masked in logs, never shown in opensync status/inspect output,
   *  stored encrypted at rest. Use for tokens, passwords, and API keys that
   *  aren't handled by the auth system (i.e. declared under auth: none). */
  secret?: boolean;

  default?: unknown;
}

/** Returned by getOAuthConfig() — the URLs the engine needs to run the OAuth2 flow. */
export interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
}

/**
 * How this connector authenticates. The engine manages credentials; connectors
 * never store auth secrets themselves.
 *
 * - oauth2:  Engine runs authorization code flow, stores tokens, refreshes automatically.
 *            Connector implements getOAuthConfig() to provide the endpoints.
 * - api-key: Engine prompts for key, stores encrypted, injects as Authorization: Bearer <key>
 *            (or the custom header value if provided).
 * - basic:   Engine prompts for username + password, injects as Authorization: Basic <b64>.
 * - none:    Public API or bespoke auth. Use configSchema for connection params and
 *            prepareRequest() for any custom request signing.
 */
export type AuthConfig =
  | {
      type: "oauth2";
      /** Base set of scopes always requested, regardless of which entities are enabled.
       *  Entity-level scopes (read/write/always) are unioned on top at channel setup time. */
      scopes?: string[];
    }
  | {
      type: "api-key";
      /** Custom header name. Defaults to 'Authorization' with value 'Bearer <key>'. */
      header?: string;
    }
  | { type: "basic" }
  | { type: "none" };

/**
 * Static connector identity and configuration contract.
 * Evaluated once at registration time, not per-request.
 */
export interface ConnectorMetadata {
  /** Machine-readable connector name (e.g. 'hubspot', 'fiken'). */
  name: string;

  /** Semver version string. */
  version: string;

  /** Authentication method. Determines how the engine acquires and injects credentials. */
  auth: AuthConfig;

  /** Non-auth instance configuration. Auth credentials (clientId, clientSecret, API keys,
   *  passwords) are never declared here — the auth system handles them.
   *
   *  The engine uses this to: prompt users (CLI), validate config, and support agent discovery. */
  configSchema?: Record<string, ConfigField>;

  /** Named environments mapping to base URLs. The engine resolves the selected environment
   *  before injecting ctx.config.baseUrl.
   *  Example: { production: 'https://api.fiken.no/v2', test: 'https://api.fiken.no/sandbox' } */
  environments?: Record<string, string>;
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

/**
 * A group of records from a single webhook payload, belonging to one entity type.
 * handleWebhook() returns an array of these — one payload can carry multiple entity types.
 */
export interface WebhookBatch {
  /** Must match an EntityDefinition name returned by getEntities(). */
  entity: string;
  records: FetchRecord[];
}

// ─── Health ───────────────────────────────────────────────────────────────────

export interface HealthStatus {
  healthy: boolean;
  /** Human-readable status message, shown in opensync status output. */
  message?: string;
  /** Optional structured details (e.g. { apiVersion: '3', rateLimitRemaining: 450 }). */
  details?: Record<string, unknown>;
}

// ─── Connector ────────────────────────────────────────────────────────────────

/**
 * The top-level interface every connector implements and exports as its default export.
 *
 * Minimum viable connector: metadata + at least one of getEntities / getActions.
 * The engine rejects registration if neither is present.
 */
export interface Connector {
  metadata: ConnectorMetadata;

  /** Return the entity definitions for this connector.
   *  Omit for pure action connectors (email senders, Slack posters, etc.).
   *  Called once at registration and again when config changes. */
  getEntities?(ctx: ConnectorContext): EntityDefinition[];

  /** Return the action definitions for this connector.
   *  Omit if this connector has no side-effect actions. */
  getActions?(ctx: ConnectorContext): ActionDefinition[];

  /** Return OAuth2 authorization and token endpoint URLs.
   *  Required when metadata.auth.type === 'oauth2'.
   *
   *  Receives raw instance config (not yet environment-resolved) so the connector
   *  can derive auth URLs from baseUrl when needed (e.g. multi-tenant / on-prem). */
  getOAuthConfig?(config: Record<string, unknown>): OAuthConfig;

  /** Called when a user enables this connector instance. Use to register webhooks,
   *  set up subscriptions, or perform any one-time setup.
   *  For entity-scoped setup (e.g. per-entity webhook subscriptions), use onEnable on EntityDefinition instead. */
  onEnable?(ctx: ConnectorContext): Promise<void>;

  /** Called when a user disables this connector instance. Use to deregister webhooks
   *  and clean up any resources registered in onEnable. */
  onDisable?(ctx: ConnectorContext): Promise<void>;

  /** Intercept every outbound HTTP request before it is sent.
   *  Use for HMAC signing, session token injection, or custom URL manipulation.
   *  Standard OAuth2 is handled automatically — no need to implement this for that.
   *  ctx.http is available but calls inside prepareRequest skip prepareRequest (no recursion). */
  prepareRequest?(req: Request, ctx: ConnectorContext): Promise<Request>;

  /** Parse an inbound webhook payload and return records grouped by entity.
   *  Return [] to silently acknowledge without yielding records (e.g. ping/challenge requests).
   *  Throw ValidationError to respond 400; throw ConnectorError to respond 500. */
  handleWebhook?(
    req: Request,
    ctx: ConnectorContext
  ): Promise<WebhookBatch[]>;

  /** Optional periodic health check. Results surface in opensync status output. */
  healthCheck?(ctx: ConnectorContext): Promise<HealthStatus>;
}
