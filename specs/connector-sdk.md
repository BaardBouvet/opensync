# Connector SDK

The SDK (`@opensync/sdk`) is the only package a connector author needs. It defines the contract between connectors and the engine.

## Core Interface

```typescript
interface Connector {
  metadata: ConnectorMetadata;
  getEntities?(ctx: ConnectorContext): EntityDefinition[];  // omit for pure action connectors
  getActions?(ctx: ConnectorContext): ActionDefinition[]; // omit if no actions
  getOAuthConfig?(config: Record<string, unknown>): OAuthConfig; // required when metadata.auth.type === 'oauth2'
  onEnable?(ctx: ConnectorContext): Promise<void>;  // connector-level setup (e.g. connection pools, connector-wide subscriptions)
  onDisable?(ctx: ConnectorContext): Promise<void>; // connector-level teardown
  prepareRequest?(req: Request, ctx: ConnectorContext): Promise<Request>;
  handleWebhook?(req: Request, ctx: ConnectorContext): Promise<WebhookBatch[]>;
  healthCheck?(ctx: ConnectorContext): Promise<HealthStatus>;
}
```

Every connector implements `Connector` and must provide at least `getEntities` or `getActions` — the engine rejects registration if neither is present. Implement only what applies: a pure action connector (email sender, Slack poster) omits `getEntities`; a read-only source omits `getActions`.

Within `getEntities`, each `EntityDefinition` must implement at least one of `read`, `insert`, `update`, or `delete` — a bare empty entity is rejected at registration time.

## Entities

The connector defines what data it can provide via `getEntities()`. Each entity represents one object type with its own read/write logic, scheduling hints, and dependency ordering.

```typescript
interface ReadBatch {
  records: ReadRecord[];
  since?: string;  // watermark for this batch; engine stores for next poll
}

interface EntityDefinition {
  name: string;                                // e.g. 'contact', 'company'
  read?(ctx: ConnectorContext, since?: string): AsyncIterable<ReadBatch>;
  lookup?(ids: string[], ctx: ConnectorContext): Promise<ReadRecord[]>;
  insert?(records: AsyncIterable<InsertRecord>, ctx: ConnectorContext): AsyncIterable<InsertResult>;
  update?(records: AsyncIterable<UpdateRecord>, ctx: ConnectorContext): AsyncIterable<UpdateResult>;
  delete?(ids: AsyncIterable<string>, ctx: ConnectorContext): AsyncIterable<DeleteResult>;
  schema?: Record<string, FieldDescriptor>;    // field metadata (e.g. { "fnavn": { description: "First name" }, "amount": { description: "Value in NOK", type: "number" } })
  scopes?: { read?: string[]; write?: string[]; always?: string[] }; // OAuth scopes by role; 'always' is requested whenever the entity is enabled
  dependsOn?: string[];                        // e.g. ['company'] — sync companies before contacts (entity names)
  onEnable?(ctx: ConnectorContext): Promise<void>;  // register webhook subscription for this entity's events
  onDisable?(ctx: ConnectorContext): Promise<void>; // deregister webhook subscription
}
```

`schema` on an entity declares the shape of the records it *produces* — static metadata evaluated at channel setup time. Each entry is a `FieldDescriptor` with optional `description`, `type`, `required`, `immutable`, and `example`. Fields marked `required: true` are enforced: the engine produces a synthetic error result for any record missing a required field before it reaches `insert()` or `update()`. Fields marked `immutable: true` are frozen after creation: the engine strips them from `UpdateRecord.data` before calling `update()`, so the connector never sees an attempt to overwrite them. No naming convention to follow — just describe what the field contains in whatever language makes sense.

Uses: agents read `description` to understand non-obvious field names; the engine and tooling use `type` to warn at channel setup if a source field type is incompatible with what the target entity expects.

On `ActionDefinition`, `schema` describes the *input payload* the action expects. `required: true` fields are enforced — the engine rejects `execute()` calls with missing required fields before they reach the connector.

### Why Connector-Driven Entities

The connector knows its own API best:

- **Dependencies**: HubSpot contacts reference companies. The connector declares `dependsOn: ['company']` so the engine syncs companies first — otherwise contact creates fail because the referenced company doesn't exist in the target yet.
- **Bundled APIs**: Some APIs return multiple entity types in one call. The connector can use a single HTTP request internally and yield records across multiple `read()` calls.
- **Single source of truth**: The entity definitions ARE the source of truth — no separate `metadata.entities` that can drift out of sync with the actual implementation.

### Watermark Tracking

The engine tracks a watermark per entity per connector instance. After a successful fetch run, the engine stores the latest watermark value so the next poll only gets new changes.

The connector receives the watermark via the `since` parameter. The semantics of `since` are entirely up to the connector:
- Timestamp (ISO 8601 or Unix epoch)
- Cursor token (from API pagination)
- Sequence number
- Any opaque string

If `since` is undefined, it's a full sync. The connector's first return value from `read()` will be stored as the watermark for the next poll.

> **Naming note**: `since` was chosen over `cursor` (too database-flavored) and `checkpoint` (accurate but verbose). It reads naturally: "give me everything since this point."

### Dependency Resolution

The engine resolves `dependsOn` into a topological order before running a sync cycle. If `contact` depends on `company` and `deal` depends on `contact`:

1. Sync `company` first
2. Then `contact`
3. Then `deal`

Circular dependencies are detected at config validation time and rejected.

### Example Connectors

Real connector implementations are in `connectors/` (distributable) and `dev/connectors/` (local fixtures). See `dev/connectors/mock-crm` for a
relational example (API-key auth, watermark reads, webhook registration) and
`dev/connectors/mock-erp` for a multi-auth example (OAuth2, session tokens, HMAC signing, ETag
conditional writes).

## Metadata

```typescript
interface ConnectorMetadata {
  name: string;                               // e.g. 'hubspot', 'fiken'
  version: string;                            // semver
  auth: AuthConfig;                           // how this connector authenticates
  configSchema?: Record<string, ConfigField>; // non-auth config only (e.g. portalId, baseUrl)
  environments?: Record<string, string>;      // environment name → base URL (e.g. { production: 'https://api.fiken.no/v2', test: 'https://api.fiken.no/sandbox' })
}

interface ConfigField {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  secret?: boolean;      // masked in logs, encrypted at rest
  default?: unknown;
}

type AuthConfig =
  | { type: 'oauth2'; scopes?: string[] }   // auth URLs provided dynamically by getOAuthConfig()
  | { type: 'api-key'; header?: string }    // defaults to 'Authorization: Bearer <key>'
  | { type: 'basic' }                       // username + password
  | { type: 'none' };                       // public APIs; use prepareRequest for bespoke auth

interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
}

// Field metadata for entity fields and action payloads.
// FieldType is a JSON Schema subset — scalars as string literals, object and array compose recursively:
//   'string' | 'number' | 'boolean' | 'null'
//   { type: 'object'; properties?: Record<string, FieldType> }
//   { type: 'array'; items?: FieldType }
//   { type: 'array', items: { type: 'object', properties: { sku: 'string', qty: 'number' } } }
type FieldType =
  | 'string' | 'number' | 'boolean' | 'null'
  | { type: 'object'; properties?: Record<string, FieldType> }
  | { type: 'array'; items?: FieldType };

interface FieldDescriptor {
  description?: string;
  type?: FieldType;
  entity?: string;      // FK ref to this connector-local entity name; engine synthesizes association from plain string value
  required?: boolean;   // field must be present; engine enforces before insert()/update() and execute()
  immutable?: boolean;  // field cannot be changed after creation; engine rejects updates that include it
  example?: unknown;    // illustrative example value; display-only — engine ignores it
}

// EntityCapabilities removed — insert/update/delete presence on EntityDefinition is the capability declaration.
```

### Config Schema

`configSchema` declares non-auth configuration a connector instance needs — things the user must supply beyond what the declared auth type handles (e.g. a `portalId`, a `baseUrl`, a database DSN). Auth credentials (`clientId`, `clientSecret`, API keys, passwords) are never declared here.

This serves three purposes:

1. **CLI prompting**: `opensync add-connector hubspot` reads the schema and prompts for each field interactively.
2. **Validation**: The engine validates provided config against the schema before creating an instance. Missing required fields or wrong types fail fast.
3. **Agent discovery**: An agent can read the schema to know what settings are needed without reading documentation.

Example (HubSpot — OAuth connector, only non-auth config):
```typescript
configSchema: {
  portalId: { type: 'string', description: 'HubSpot Portal ID', required: true },
}
```

Array fields are declared with `type: 'array'` and an `items` descriptor. The engine presents them as a multi-value input and delivers the value as a native array in `ctx.config`:
```typescript
configSchema: {
  topicNames: {
    type: 'array',
    items: { type: 'string' },
    description: 'Kafka topic names to subscribe to.',
    required: true,
  },
}
```

Fields with a fixed set of valid values use `enum`. The engine presents them as a dropdown rather than a free-text input, and validates that the submitted value is one of the declared choices:
```typescript
configSchema: {
  region: {
    type: 'string',
    enum: ['us-east-1', 'eu-west-1', 'ap-southeast-1'] as const,
    description: 'AWS region to connect to.',
    required: true,
  },
}
```

Fields marked `secret: true` are:
- Masked in structured logs and request journal
- Never shown in `opensync status` or `opensync inspect` output
- Stored encrypted in `connector_instances.config` (at-rest encryption)

Object fields are declared with `type: 'object'`. The engine presents them as a multi-line JSON textarea in the CLI and passes the parsed value through to `ctx.config` as a plain object. Useful for structured credentials that arrive as a single JSON document (e.g. a GCP service account key file or an Azure service principal):
```typescript
configSchema: {
  servicePrincipal: {
    type: 'object',
    description: 'Azure service principal JSON (paste the full document).',
    required: true,
    properties: {
      clientId:     { type: 'string', description: 'Application (client) ID' },
      clientSecret: { type: 'string', description: 'Client secret value' },
      tenantId:     { type: 'string', description: 'Directory (tenant) ID' },
    },
  },
}
```
The `properties` map is informational — it drives hints in CLI/agent output but is not enforced at runtime. Individual string values *inside* an object field do **not** receive `${VAR}` interpolation; use a dedicated string field for values you want to source from environment variables.

#### Relationship to JSON Schema

`ConfigField` borrows JSON Schema vocabulary (`type`, `description`, `default`, `enum`, `items`) but is **not a strict JSON Schema subset**. Two intentional deviations:

1. **`required` is a field-level boolean**, not a parent-object array. JSON Schema puts `required: ["portalId"]` on the enclosing object schema; `ConfigField` places `required: true` on the field itself. This is more ergonomic for connector authors.
2. **`secret` is a custom extension** with no JSON Schema equivalent. It carries operational semantics (encrypt at rest, mask in output) that JSON Schema does not model.

The engine can mechanically translate a `configSchema` into a JSON Schema object for external tooling (validators, form generators, OpenAPI) — `required: true` fields move into the parent `required` array and `secret` is dropped or mapped to a vendor extension like `x-secret`. Connectors do not need to do this themselves.

Write capabilities are expressed by which methods the entity implements: presence of `insert`, `update`, and `delete` is self-declaring. The engine checks at channel setup time which operations are available and shows pre-flight warnings (e.g. "this system has no `update` — changes will be insert-only"). Capability-aware rollback uses the same information.

### Auth Declaration

`metadata.auth` tells the engine how to authenticate `ctx.http` requests. Auth credentials are never stored in `configSchema` — the engine manages them separately.

For `oauth2`, the engine runs the full authorization code flow, stores tokens, and refreshes them automatically. The connector implements `getOAuthConfig(ctx)` to provide the authorization and token endpoints — the connector receives `ctx.config.baseUrl` already resolved for the selected environment, so auth URLs can be derived dynamically:

```typescript
// Fiken — auth URLs are relative to baseUrl, so all environments work automatically
getOAuthConfig(config) {
  return {
    authorizationUrl: `${config.baseUrl}/oauth/authorize`,
    tokenUrl: `${config.baseUrl}/oauth/token`,
  };
}

// HubSpot — fixed auth endpoints regardless of environment
getOAuthConfig(config) {
  return {
    authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl: 'https://api.hubspot.com/oauth/v1/token',
  };
}
```

`scopes` in `AuthConfig` is the base set always requested for `oauth2`. Entity scopes are split by role — the engine unions only what the channel actually uses:

```
requiredScopes = auth.scopes
  ∪ entity.scopes.always (for each enabled entity, regardless of role)
  ∪ entity.scopes.read  (for each entity the channel reads from this connector)
  ∪ entity.scopes.write (for each entity the channel writes to this connector)
  ∪ action.scopes       (for each enabled action)
```

A user who only enables `contact` as a source isn't prompted for write permissions. A user who doesn't enable `deal` at all isn't prompted for deal scopes.

For `api-key`, the engine prompts for the key value, stores it encrypted, and injects it as `Authorization: Bearer <key>` (or the `header` value if specified). For `basic`, it prompts for username and password. For `none`, use `configSchema` for connection parameters and implement `prepareRequest` for any custom signing.

## ReadRecord

Records returned by `read()` and `lookup()`. Also the record type inside `ReadBatch`.

```typescript
interface ReadRecord {
  id: string;                                    // this record's ID in the source system (uniqueness scope defined below)
  data: Record<string, unknown | unknown[]>;     // raw JSON blob — values may be single or multi-valued; FK fields carry Ref objects
  version?: string;                              // opaque concurrency token (e.g. ETag) — passed back in UpdateRecord.version
  deleted?: boolean;                             // connector's intent to remove this record from the target (see ReadRecord — Deletion below)
  updatedAt?: string;                            // source-assigned modification timestamp, ISO 8601 (e.g. '2026-03-15T10:32:00Z').
                                                 // Engine uses this as the base LWW timestamp for every field in this record.
                                                 // Omit for sources that have no modification timestamp.
  createdAt?: string;                            // source-assigned creation timestamp, ISO 8601.
                                                 // Immutable: stored in shadow once on first ingest; subsequent ingests with a
                                                 // different value are silently ignored.
                                                 // Enables origin_wins resolution and stable LWW tie-breaking.
                                                 // Omit for sources that do not expose a creation time.
  fieldTimestamps?: Record<string, string>;      // per-field modification timestamps, keyed by field names used in `data`.
                                                 // Values are ISO 8601 strings. When present, engine uses these as the LWW
                                                 // timestamp for the named fields, taking precedence over shadow derivation
                                                 // and updatedAt. Connector is responsible for keeping timestamp columns out
                                                 // of data. Omit for connectors without per-field modification times.
}

// Ref — an inline reference value embedded in data[fieldName]
interface Ref {
  '@id': string;        // the referenced record's ID in this (source) system
  '@entity'?: string;   // the entity name the target belongs to — omit when the entity can be inferred from the field's FieldDescriptor.entity in schema
}
```

### Deletion

`deleted: true` is the connector's normalized intent to remove a record from the target — not just a flag mirroring the source. It covers:

- **Hard delete**: record disappeared from the source API (detected via a deleted-objects endpoint, diff, or a DELETED webhook event). Often only the ID is available; `data` may be empty.
- **Soft delete interpreted as removal**: source has `archived: true` or `status: 'inactive'`, and the connector decides this means "remove from target." The connector sets `deleted: true` and may still include the full `data`.
- **Webhooks**: source pushes a deletion event; connector sets `deleted: true` from the event payload.

The connector decides whether to propagate source soft-deletes as deletions or as field updates. If archived contacts should be kept in the target but flagged, leave `deleted` unset and pass `archived: true` in `data` instead.

### No Common Data Model

Connectors expose their source system's data as-is. There is no shared `Contact` or `Invoice` type to conform to. The mapping between systems happens in the engine via user-defined transforms.

Field values in `data` can be either single values or arrays. Most relational connectors will keep emitting single values, while graph/semantic connectors can emit multi-valued properties when the source model requires it.

Field metadata is declared via `schema` on the `EntityDefinition`, not on individual records. Each field can carry a `description`, a structured `type` (a JSON Schema subset), and a `required` flag. This helps agents and UIs understand what fields contain — especially for non-English or abbreviated field names — and lets the engine enforce shape constraints before records reach `insert()` or `update()`.

### ID Namespace & Uniqueness

The engine always resolves records as `(entity, id)` — the entity name is the namespace. An ID is only unique within the entity it came from. This means `123` from `contact` and `123` from `company` are distinct records.

### Associations

Associations are encoded as inline `Ref` values in `data`. A contact that belongs to a company
sets `data.companyId` to a `Ref` object rather than a plain string:

```typescript
// Instead of data.companyId = 'hs_456'
data.companyId = { '@id': 'hs_456', '@entity': 'company' };
```

The engine finds `Ref` values in `data`, extracts the association graph from them, and remaps
the `@id` to the target system's ID space before dispatch. Pending associations (target not yet
seen) are stored and resolved once the target record arrives.

**Recommended light path** — declare `{ type: 'ref', entity: 'company' }` in the entity
`schema` and return raw API payloads from `read()`. The engine auto-synthesizes `Ref` objects
from plain string values for schema-declared ref fields during ingest — no code change to
`read()` required. This is the common path for SaaS connectors.

```typescript
schema: {
  companyId: { type: 'string', entity: 'company', description: 'Parent company' },
}
// read() can then yield the raw API response verbatim:
yield { records: [{ id: r.id, data: r }] };
```

**Entity inference** — the engine infers the target entity in order of precedence:
1. Engine auto-synthesis: plain string value + `entity` on the schema descriptor (no Ref object needed in `read()`)
2. `@entity` on an explicit `Ref` object in `data`
3. `entity` on the schema descriptor when `@entity` is absent from the Ref
4. None of the above → opaque, no association derived

**SDK helpers** — `@opensync/sdk` exports `isRef(value)` to test whether a value is a `Ref` object. This is useful in `read()` implementations that explicitly construct Refs (e.g. RDF/SPARQL connectors that need to annotate IRI fields before the engine auto-synthesis step).

The full association design — rationale, storage layout, and remapping — is in
[`specs/associations.md`](associations.md).

### Composite Primary Keys

Some sources have no single-column primary key — rows are identified by a tuple of values (e.g. `(country_code, product_id)` in a join table, `(order_id, line_no)` in an order-lines table).

**The connector contract remains `id: string`.** The connector is responsible for serialising the tuple into a single opaque string before yielding the record, and for decoding it back when `update()` or `delete()` returns the same string:

```typescript
// read(): encode
yield { records: [{ id: `${row.country_code}:${row.product_id}`, data: { ...row } }] };

// update(): decode
const [countryCode, productId] = record.id.split(':');
await db.query('UPDATE ... WHERE country_code = $1 AND product_id = $2', [countryCode, productId]);
```

**Separator choice**: pick a character that cannot appear in the key values, or URL-encode the components before joining. A common safe choice is `\0` (null byte) since it is never valid in SQL identifiers or typical API IDs.

This keeps the engine contract simple — `id` is always an opaque string — and avoids any engine-side knowledge of composite key structure. The engine never needs to decompose the ID; it always passes it back verbatim.

**When the composite fields are canonical domain fields** (e.g. `orderId` + `lineNo` are both meaningful in the canonical model), consider also mapping them as ordinary fields and declaring `identity: [{ fields: [orderId, lineNo] }]` on the channel in addition to the serialised `id`. This enables cross-connector matching by field value, not just by engine-assigned ID. See [identity.md](identity.md) §Compound Identity Groups.

## Write Records

The engine constructs typed records for each write operation. All fields are engine-owned and read-only from the connector's perspective.

```typescript
interface InsertRecord {
  data: Record<string, unknown | unknown[]>;   // FK fields carry remapped plain ID strings
}

interface UpdateRecord {
  id: string;                                  // ID previously returned by InsertResult.id
  data: Record<string, unknown | unknown[]>;   // FK fields carry remapped plain ID strings
  version?: string;                            // last-seen version token from ReadRecord.version — used for conditional writes (e.g. If-Match ETag)
  snapshot?: Record<string, unknown>;          // full field snapshot at the time the delta was computed — used for conflict detection without a lookup() round trip
}

// delete() receives IDs directly — no record wrapper needed
```

All fields are engine-owned and read-only from the connector's perspective.

The engine, not the connector, is responsible for maintaining `id`. Connectors must not mutate it.

**Writing associations**: FK reference fields appear as **plain ID strings** in `data` under the
target-local predicate name. Connectors receive `record.data` directly and can pass it to the API as-is.
The engine handles all remapping from source-local IDs to target-local IDs before dispatch.
If the association target is not yet cross-linked the field is absent from `data` (and a deferred row
is written so the engine retries once the link is established).

To enable FK synthesis, declare the FK field in the entity's `schema`:
```typescript
schema: { companyId: { entity: "companies" } }
```
The engine then synthesises association metadata from the plain string value automatically. No special
write handling is needed in the connector.

## Write Results

Each write method yields one result per input record/ID, in the same order (positional correlation).

```typescript
interface InsertResult {
  id: string;                     // ID assigned by this (target) system
  data?: Record<string, unknown>; // full API response; stored for echo prevention — lets the engine suppress its own writes when they come back through read()
  error?: string;                 // present = this record failed; absent = success
}

interface UpdateResult {
  id: string;
  data?: Record<string, unknown>;
  notFound?: true;                // record didn't exist in target — not an error, engine reconciles
  error?: string;                 // present = this record failed; absent = success
}

interface DeleteResult {
  id: string;
  notFound?: true;                // record didn't exist in target — not an error, already gone
  error?: string;                 // present = this record failed; absent = success
}
```

`InsertResult.id` is stored in the identity map and fed back as `UpdateRecord.id` and the delete ID on future writes. `InsertResult.data` / `UpdateResult.data` are stored for echo prevention — they let the engine recognise its own writes coming back through `read()` and suppress them as no-ops. `notFound` on delete or update is not an error — the record was already gone or never arrived. The happy-path result is just `{ id }` — no status annotation needed.

## ConnectorContext

The engine provides a single context object to all connector methods.

```typescript
interface ConnectorContext {
  config: Record<string, unknown>;       // instance config (baseUrl, foretakId, etc.)
  state: StateStore;                     // per-instance persistent key-value store
  logger: Logger;
  http: TrackedFetch;                    // auto-logged, auto-authed fetch
  webhookUrl: string;                    // base URL for this instance — append sub-paths or params freely
}
```

### ctx.http — Tracked Fetch

A drop-in replacement for `fetch()` that automatically:
- Logs every request/response to the request journal (method, url, body, status, duration)
- Injects auth headers (OAuth bearer token or via `prepareRequest` hook)
- Retries on transient failures (429, 5xx) with exponential backoff
- Masks sensitive headers (Authorization) in journal logs

Connector code looks like normal fetch:
```typescript
const res = await ctx.http('https://api.fiken.no/v2/contacts');
```

Use `webhookUrl` as a base when registering webhook callbacks with external systems. The engine routes all inbound requests under this base to `handleWebhook` with the original request intact — path, query string, headers, and body are all preserved. The connector can construct any sub-URL it needs:

```typescript
// All of these route to handleWebhook:
`${ctx.webhookUrl}/contacts`           // sub-path
`${ctx.webhookUrl}/deals`              // different sub-path
`${ctx.webhookUrl}?type=contact`       // query param
`${ctx.webhookUrl}/events?stream=deal` // both
```

Inspect `new URL(req.url).pathname` or `.searchParams` inside `handleWebhook` to route to the right entity.

### ctx.state — Persistent Key-Value Store

For storing per-instance data like session tokens, pagination cursors, or webhook registration IDs. Backed by the `connector_state` table in SQLite.

```typescript
interface StateStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  update<T>(key: string, fn: (current: T | undefined) => T | Promise<T>, timeoutMs?: number): Promise<T>;
}
```

Values must be JSON-serializable (no `Date` objects, `undefined`, functions, or class instances). The engine stores state as JSON — anything that doesn't survive `JSON.parse(JSON.stringify(v))` will be corrupted on the next read.

The connector receives its previous state on the next invocation. Example: storing a webhook subscription ID so `onDisable` can deregister it.

`update` is an atomic read-modify-write: concurrent calls for the same key are serialized — each caller waits for the previous `fn` to finish before starting. The lock is held for the entire duration of `fn`, including any async work inside it. Use this for any state that multiple streams might race to modify:

```typescript
// Two parallel read() runs both see an expired token — only one refreshes it.
const token = await ctx.state.update('sessionToken', async (current) => {
  if (current && !isExpired(current)) return current;  // already refreshed by the other run
  const fresh = await fetchNewToken(ctx.config.clientId, ctx.config.clientSecret);
  return fresh;
}, 10_000);  // fail after 10 s rather than blocking indefinitely
```

- If `fn` throws, the state is not updated and the error propagates.
- If `fn` exceeds `timeoutMs` (default: 30 000 ms), `update` rejects with a `ConnectorError` and the state is not updated.
- Plain `get` + `set` has a TOCTOU race: both runs read the expired token, both call the auth endpoint, and one write clobbers the other. `update` eliminates that gap.

### ctx.config — Instance Configuration

Read-only config set by the user when they add a connector instance. Contains things like `baseUrl`, `foretakId`, `apiKey`. The engine resolves environment-specific base URLs from `metadata.environments` before injecting.

### ctx.logger — Structured Logger

```typescript
interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}
```

## Read — Reading Data

`read` is optional. Omitting it makes the entity a write-only sink — the engine tracks identity and routes inserts, updates, and deletes, but never polls. Useful for targets like data warehouses or event sinks that can receive data but have no meaningful "read current state" operation.

When implemented, `read()` yields `ReadBatch` objects:

```typescript
read?(ctx: ConnectorContext, since?: string): AsyncIterable<ReadBatch>;

interface ReadBatch {
  records: ReadRecord[];
  since?: string;  // watermark for this batch; engine stores for next poll
}
```

**Watermark behavior:**
- Each yielded batch can include a `since` value — the engine stores the latest one it sees.
- On the next poll, the engine passes that stored value as the `since` parameter to `read()`.
- If `since` is provided, return only records modified after that watermark.
- If `since` is undefined, return everything (full sync — used for onboarding and soft delete detection).
- If interrupted, resumption uses the last stored watermark (no data loss or duplication).

Do not store pagination cursors in `ctx.state` — cursors are only valid for a single in-progress read run. If interrupted, resumption should use the last-committed `since` watermark from `ReadBatch`, not a stale cursor. `ctx.state` is for durable per-instance data that outlives a single read run (webhook subscription IDs, session tokens, etc.).

## Lookup — On-Demand Batch Lookup

```typescript
lookup?(ids: string[], ctx: ConnectorContext): Promise<ReadRecord[]>;
```

Optional method for fetching a set of records by ID on-demand (not streaming). The engine always calls it with a batch — accumulating all IDs it needs before dispatching, so connectors with batch read APIs can serve them in one round trip.

**Use cases:**
- **Delete verification**: Confirm records are actually gone before returning undo success
- **Rollback recovery**: Check if records still exist before attempting to restore them
- **Reconciliation**: Spot-check a set of records without a full sync
- **Conflict detection**: Before dispatching writes, the engine calls `lookup` to compare live target state against the source snapshots that drove the writes — field-scoped, so unrelated fields changed by other writers are not treated as conflicts

**Contract:**
- Return a `ReadRecord[]` for the records that were found; omit records that don't exist
- Throw an error on API failure (handled by engine retry logic)
- Must use IDs exactly as stored in the identity map (external IDs in this system)

Connectors whose API only supports single-record lookups implement `lookup` with a loop. Connectors with a batch read endpoint use it directly — they get the efficiency gain automatically.

If not implemented, the engine safely skips verification but logs that capability is missing.

## Writing Data

```typescript
insert?(records: AsyncIterable<InsertRecord>, ctx: ConnectorContext): AsyncIterable<InsertResult>;
update?(records: AsyncIterable<UpdateRecord>, ctx: ConnectorContext): AsyncIterable<UpdateResult>;
delete?(ids: AsyncIterable<string>, ctx: ConnectorContext): AsyncIterable<DeleteResult>;
```

All three write methods are optional. The engine only calls a method if the entity implements it — presence is the capability declaration. The engine validates at channel setup that the target entity implements at least the operations the channel requires.

- The engine streams records in; the connector pulls and chunks however it wants.
- Each method yields one result per input, in the same order — the engine correlates positionally.
- Records missing fields marked `required: true` in the entity's `schema` are rejected by the engine before reaching `insert()` or `update()` — a synthetic result with `error` set is yielded on the connector's behalf.
- The engine dispatches inserts, updates, and deletes in separate calls — no branching needed inside the connector.
- Idempotent: `not_found` on delete or update is a valid terminal state, not an error.

### Patch semantics for `update()` — a load-bearing contract

**`update()` must be a patch**, not a full replace. The engine sends only the fields that changed, not the record's complete current state. A connector that performs a full replace (e.g. HTTP PUT with only the incoming fields) will silently destroy fields owned by other connectors in the same channel.

Correct implementation: merge incoming fields into the existing record and leave all other fields untouched. The jsonfiles and postgres connectors both do this — spread existing record first, incoming fields on top.

**If the target API only supports full replacement (e.g. HTTP PUT)**, the connector must call `lookup()` to fetch the current record and merge locally before submitting the PUT. This is the connector's responsibility, not the engine's.

```typescript
// Correct: merge before writing
async *update(records, ctx) {
  for await (const record of records) {
    const [current] = await this.lookup([record.id], ctx);  // fetch existing
    const merged = { ...current?.data, ...record.data };    // patch merge
    await api.put(`/contacts/${record.id}`, merged);
    yield { id: record.id };
  }
}
```

This contract is not advisory — a connector that full-replaces will corrupt multi-field-owner scenarios in ways that are silent and difficult to diagnose.

### Naming: `update` vs `patch`

The method is named `update` in the current SDK. In retrospect, `patch` would be a more accurate name — it signals the merge semantics above without requiring a prose explanation. HTTP's `PATCH` verb carries exactly this meaning and is already familiar to connector authors who work with REST APIs.

Renaming `update` → `patch` across the SDK would be a breaking change for all existing connectors, so it is deferred. Consider it for a future major version. If the rename does happen, the migration path is mechanical: rename the method, update the `UpdateRecord` / `UpdateResult` types accordingly, and provide a codemod.

## HTTP Customization

Connectors can implement optional methods on `Connector` for custom HTTP behavior:

```typescript
interface WebhookBatch {
  entity: string;            // matches an EntityDefinition name
  records: ReadRecord[];
}

prepareRequest?(req: Request, ctx: PrepareRequestContext): Promise<Request>;
handleWebhook?(req: Request, ctx: ConnectorContext): Promise<WebhookBatch[]>;
```

`prepareRequest` is called before every outbound HTTP request. The connector can:
- Read the request body (via `req.clone()`) for HMAC signing
- Add custom headers (session tokens, API keys)
- Modify the URL (append query params)

`ctx.http` is available and will log requests normally — but calls made via `ctx.http` inside `prepareRequest` skip `prepareRequest` itself (no recursion). Use it for any auth-related HTTP such as fetching or refreshing a session token.

Standard OAuth2 is handled by the engine automatically — connectors don't need `prepareRequest` for that.

`handleWebhook` parses incoming webhook payloads and returns records grouped by entity. Returning an array of `WebhookBatch` objects allows one webhook payload to carry multiple entity types. The engine routes each batch to the correct entity by `entity` name.

```typescript
async handleWebhook(req, ctx) {
  const body = await req.json();

  // group events by entity type, map to ReadRecord
  const byEntity = new Map<string, ReadRecord[]>();
  for (const event of body.events) {
    const entity = event.objectType;  // e.g. 'contact', 'company'
    const record = {
      id: event.objectId,
      data: event.properties ?? {},
      deleted: event.changeType === 'DELETED',
    };
    byEntity.set(entity, [...(byEntity.get(entity) ?? []), record]);
  }

  return [...byEntity.entries()].map(([entity, records]) => ({ entity, records }));
}
```

Return an empty array to silently acknowledge a webhook without yielding any records (e.g. ping/validation requests).

Connectors that don't need custom auth or webhooks simply omit these methods.

## Actions

Connectors that trigger side effects expose named actions via `getActions()`.

```typescript
interface ActionPayload {
  /** Engine-assigned deterministic key for this action invocation. Stable across retries.
   *  Forward to the target API as a per-message dedup key where supported. */
  idempotencyKey: string;
  data: Record<string, unknown>;
}

interface ActionDefinition {
  name: string;                                        // e.g. 'send-email', 'post-message'
  description?: string;
  schema?: Record<string, FieldDescriptor>; // optional — required fields validated before execute() is called
  scopes?: string[];                                   // OAuth scopes required to execute this action

  /** Streaming batch execute — mirrors insert/update/delete contract.
   *  Yields one ActionResult per input payload in the same positional order.
   *  Serial connectors iterate one-at-a-time; bulk connectors chunk and batch. */
  execute(payloads: AsyncIterable<ActionPayload>, ctx: ConnectorContext): AsyncIterable<ActionResult>;
}

interface ActionResult {
  data?: Record<string, unknown>;  // response from the external system, if any
  error?: string;                  // present = this item failed; absent = success
}
```

Actions get the same `ConnectorContext` as streams — `ctx.http`, `ctx.state`, `ctx.config`, and `ctx.logger` all work identically.

`schema` uses the same `FieldDescriptor` type as entity fields. If provided, the engine validates that all `required: true` fields are present in each payload before calling `execute()`. CLI/UI tooling can also use it to prompt for action inputs without reading documentation.

A connector that only sends data (an email gateway, a Slack poster) implements just `getActions` and omits `getEntities`. A connector that can both read and write (Slack reading messages and posting them) implements both.

## Database Connectors

Database connectors implement `Connector` but don't use `ctx.http`. Instead, they manage their own DB connections configured via `ctx.config`. All queries should still be logged — either through a future SDK helper or manual journal entries.

## Conflict Detection

In a multi-writer environment, the engine is not the only process that can modify records in a target system. A user might edit a contact in HubSpot directly while the engine is about to write a field change to the same record.

Conflict detection is handled entirely by the engine — connectors do not need to implement any of it. When conflict detection is enabled for a channel, the engine:

1. Calls `lookup` on the target connector with all the IDs involved in the current write batch to get their current live state
2. Compares the source snapshot (the field values that drove the write decision) against the live target values, for the fields being written
3. If those fields match — the target still reflects what the source had when the delta was computed; proceeds with the write
4. If any differ — the target was independently modified; skips the write and reconciles on the next cycle

The check is field-scoped: if the engine manages `email` and `phone`, and another system changed `lifecyclestage` on the same contact, that is not a conflict — only the fields being overwritten matter.

Because `lookup` is called for the whole write batch at once, the engine gets all live state in one (or a few) round trips rather than one API call per record.

This requires `lookup` to be implemented on the target entity. If it is absent, the engine skips conflict detection and writes unconditionally, which is acceptable for append-only or low-conflict environments.

## Health Checks

`healthCheck?(ctx): Promise<HealthStatus>` — called periodically by the engine to verify the connection is alive (valid credentials, API reachable, etc.). Results feed into the channel health status shown by `opensync status`.

## Error Hierarchy

```typescript
class ConnectorError extends Error { code: string; retryable: boolean }  // base
class RateLimitError extends ConnectorError { retryAfterMs?: number }     // 429
class AuthError extends ConnectorError { }                                 // 401/403
class ValidationError extends ConnectorError { }                           // bad data
```

The engine uses error type to decide the response:

| Error | Engine action |
|---|---|
| `RateLimitError` | Pause and retry after `retryAfterMs` (or exponential backoff if unset) |
| `AuthError` | Pause run, attempt token refresh, retry once — then mark instance unhealthy |
| `ValidationError` | Skip the offending record, log, continue |
| `ConnectorError` | Retry with backoff; repeated failures mark the instance unhealthy |

### Where errors apply

**`read()`** — throw to abort the entire read run for this entity. The engine will retry on the next poll cycle using the last stored watermark for this entity.
- `RateLimitError` — API responded 429; engine backs off before retrying
- `AuthError` — credentials invalid or expired
- `ConnectorError` — unexpected API error, network failure, bad response shape

**`insert()` / `update()` / `delete()`** — throw to abort the write run. Per-record failures should be expressed via the result's `status: 'error'` instead.
- `RateLimitError` — mid-stream 429; engine backs off and retries the whole operation
- `AuthError` — credentials invalid or expired
- `ConnectorError` — unexpected failure

**`lookup()`** — throw on API failure; omit not-found IDs from the returned array.
- `ConnectorError` — any API error

**`onEnable()` / `onDisable()`** — throw to fail the lifecycle step.
- `AuthError` — can't authenticate to register/deregister webhooks
- `ConnectorError` — API call failed

**`handleWebhook()`** — throw to return a 500 to the upstream (which may trigger a retry from the webhook sender). Return an empty array to silently acknowledge without yielding records.
- `ValidationError` — payload didn't match expected shape; engine returns 400
- `ConnectorError` — processing failure; engine returns 500

**`execute()`** — throw to fail the action. The engine logs the failure and marks the trigger attempt as failed.
- `RateLimitError` — external service responded 429; engine backs off and retries
- `AuthError` — credentials invalid or expired
- `ConnectorError` — unexpected failure



## The `connectors/` folder

`connectors/` is the canonical home for connectors that ship with this repository. It has three
purposes:

1. **Reference implementations** — each connector shows exactly how a real-world integration
   maps onto the SDK contract. Agents, contributors, and reviewers read these to understand what
   correct connector code looks like: how `ctx.http` is used, how auth is threaded through, how
   watermarks are returned, how errors are expressed.

2. **Design validation** — if the SDK contract makes a connector awkward to write, the
   connector code is the evidence. Every time the SDK changes, the connectors are the first place
   to look for breakage. They serve as integration-level type-checking for the API surface.

3. **Agent-writeable baseline** — the connectors serve as ground truth for evaluating whether
   an agent can generate a correct connector from the spec alone. A new connector written by a
   code-generation agent should be indistinguishable from a human-authored one in this folder.

Connectors in this folder are **not** a registry or marketplace. They are development artefacts
maintained alongside the SDK and engine. Production users publish their own connectors as separate
npm packages; the engine resolves them at runtime from `opensync.json`.

---

## Mock servers (`dev/servers/`)

`dev/servers/mock-crm` and `dev/servers/mock-erp` are standalone HTTP services used exclusively by
connector tests and integration tests. They live in `dev/servers/` (not `connectors/`) because
they are infrastructure, not SDK implementations.

### Why they exist

Connector tests need a real HTTP peer. Mocking `ctx.http` in-process hides entire categories
of bugs: URL construction, header injection, auth negotiation, error-status handling, ETag
round-trips. The mock servers provide a genuine HTTP server that the connector drives over the
loopback interface, so the connector's network path is exercised exactly as it will be in
production.

### Design principles

- **Real HTTP, not mocked fetch** — Bun.serve runs on an ephemeral port; every test makes
  genuine TCP connections. No `fetch` patching.
- **In-memory state** — all state lives in `Map`s. There is no database, no disk I/O, no
  teardown complexity. A `POST /__reset` call clears everything between tests.
- **Automatic event delivery** — the mock CRM server fires webhooks to all registered
  subscribers on every `POST /contacts` (created) and `PUT /contacts/:id` (updated). This
  exercises the full webhook pipeline — registration, delivery, connector `handleWebhook()` —
  without orchestration in the test itself.
- **Test-helper endpoints** — `/__reset`, `/__trigger`, `/__expire-token`,
  `/__invalidate-session`, `/__mutate-employee/:id` exist only for test setup and teardown.
  They bypass auth and are never available in "production" mode; there is no production mode
  because these servers are test-only.
- **Env-var config** — ports and credentials are configurable via environment variables
  (`MOCK_CRM_PORT`, `MOCK_CRM_API_KEY`, `MOCK_ERP_PORT`, etc.) so the servers can be started
  as long-running processes during integration test runs without hard-coded port conflicts.

### Mock CRM (`@opensync/server-mock-crm`)

Models a simple CRM with a `contacts` entity. Auth is a static Bearer API key. Supports webhook
subscriptions: subscribers receive a full `{ event, id, name, email, updatedAt, ... }` payload
on every create and update.

Entity: `contacts` — `id`, `name`, `email`, `updatedAt`

Connector (`dev/connectors/mock-crm`): covers API-key auth, watermark reads, insert/update, webhook
registration (`onEnable`/`onDisable`), and both thick and thin webhook modes.

### Mock ERP (`@opensync/server-mock-erp`)

Models a personnel/HR system with an `employees` entity. Implements three auth patterns in one
server to exercise all `prepareRequest` variants without needing three separate servers:

| Auth pattern | Endpoints | Connector variant |
|---|---|---|
| OAuth2 client_credentials | `/employees`, `/employees/:id`, `POST /employees`, `PUT /employees/:id` | default export |
| Session token | `/session/login`, `/employees/legacy` | `sessionConnector` |
| HMAC-SHA256 signing | `/signed/employees` | `hmacConnector` |

The ERP server also implements ETag-based optimistic locking: `GET /employees/:id` returns an
`ETag` header; `PUT /employees/:id` validates `If-Match` and returns `412 Precondition Failed`
when the record has changed since the client last read it.

Entity: `employees` — `id`, `name`, `email`, `department`, `updatedAt`

Connector (`dev/connectors/mock-erp`): covers OAuth2 token lifecycle, `prepareRequest` session and
HMAC patterns, `lookup()` with ETag threading, and conditional writes with `If-Match`.

---

## Example Connectors

Three connectors ship with the project for development and testing:

### mock-crm (relational)
- Entity: `contacts` (`id`, `name`, `email`, `updatedAt`)
- In-memory HTTP server (`@opensync/server-mock-crm`) on an ephemeral port
- Auth: Bearer API key injected by `ctx.http`
- Implements: `read` (with `since` watermark), `insert`, `update`, `onEnable`/`onDisable` (webhook subscription), `handleWebhook` (thick and thin modes)

### mock-erp (multi-auth)
- Entity: `employees` (`id`, `name`, `email`, `department`, `updatedAt`)
- In-memory HTTP server (`@opensync/server-mock-erp`) on an ephemeral port
- Three connector variants in the same file (default OAuth2, `sessionConnector`, `hmacConnector`)
- Implements: `read` (with `since` watermark), `lookup` (ETag as `version`), `insert`, `update` (with `If-Match`), `prepareRequest` (session token and HMAC signing)

### jsonfiles (hello world)
The simplest possible connector — reads and writes a JSON array file. Intended as the
starting point for anyone learning the SDK.
- Entity: `record` (arbitrary fields from the JSON objects)
- Storage: a `.json` file on disk (path from `ctx.config.entities`)
- `read()` reads the file, returns all objects (or filters by a `updatedAt` field if `since` is provided)
- `insert()` appends, `update()` replaces by ID, `delete()` removes by ID — all write back to the file
- Does not use `ctx.http` — demonstrates that connectors are not limited to REST APIs

Example data file:
```json
[
  { "_id": "1", "name": "Ola Nordmann", "email": "ola@test.no", "_updatedAt": "2026-04-01T10:00:00Z" },
  { "_id": "2", "name": "Kari Hansen", "email": "kari@test.no", "_updatedAt": "2026-04-01T11:00:00Z" }
]
```
