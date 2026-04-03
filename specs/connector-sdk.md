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

Within `getEntities`, each `EntityDefinition` must implement at least one of `fetch`, `insert`, `update`, or `delete` — a bare empty entity is rejected at registration time.

## Entities

The connector defines what data it can provide via `getEntities()`. Each entity represents one object type with its own read/write logic, scheduling hints, and dependency ordering.

```typescript
interface FetchBatch {
  records: FetchRecord[];
  since?: string;  // watermark for this batch; engine stores for next poll
}

interface EntityDefinition {
  name: string;                                // e.g. 'contact', 'company'
  fetch?(ctx: ConnectorContext, since?: string): AsyncIterable<FetchBatch>;
  lookup?(ids: string[], ctx: ConnectorContext): Promise<FetchRecord[]>;
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

`schema` on an entity declares the shape of the records it *produces* — static metadata evaluated at channel setup time. Each entry is a `FieldDescriptor` with optional `description`, `type`, `required`, and `immutable`. Fields marked `required: true` are enforced: the engine produces a synthetic error result for any record missing a required field before it reaches `insert()` or `update()`. Fields marked `immutable: true` are frozen after creation: the engine strips them from `UpdateRecord.data` before calling `update()`, so the connector never sees an attempt to overwrite them. No naming convention to follow — just describe what the field contains in whatever language makes sense.

Uses: agents read `description` to understand non-obvious field names; the engine and tooling use `type` to warn at channel setup if a source field type is incompatible with what the target entity expects.

On `ActionDefinition`, `schema` describes the *input payload* the action expects. `required: true` fields are enforced — the engine rejects `execute()` calls with missing required fields before they reach the connector.

### Why Connector-Driven Entities

The connector knows its own API best:

- **Dependencies**: HubSpot contacts reference companies. The connector declares `dependsOn: ['company']` so the engine syncs companies first — otherwise contact creates fail because the referenced company doesn't exist in the target yet.
- **Bundled APIs**: Some APIs return multiple entity types in one call. The connector can use a single HTTP request internally and yield records across multiple `fetch()` calls.
- **Single source of truth**: The entity definitions ARE the source of truth — no separate `metadata.entities` that can drift out of sync with the actual implementation.

### Watermark Tracking

The engine tracks a watermark per entity per connector instance. After a successful fetch run, the engine stores the latest watermark value so the next poll only gets new changes.

The connector receives the watermark via the `since` parameter. The semantics of `since` are entirely up to the connector:
- Timestamp (ISO 8601 or Unix epoch)
- Cursor token (from API pagination)
- Sequence number
- Any opaque string

If `since` is undefined, it's a full sync. The connector's first return value from `fetch()` will be stored as the watermark for the next poll.

> **Naming note**: `since` was chosen over `cursor` (too database-flavored) and `checkpoint` (accurate but verbose). It reads naturally: "give me everything since this point."

### Dependency Resolution

The engine resolves `dependsOn` into a topological order before running a sync cycle. If `contact` depends on `company` and `deal` depends on `contact`:

1. Sync `company` first
2. Then `contact`
3. Then `deal`

Circular dependencies are detected at config validation time and rejected.

### Example: HubSpot Connector Entities

```typescript
getEntities(): EntityDefinition[] {
  return [
    {
      name: 'company',
      schema: { name: { description: 'Company name' }, domain: { description: 'Company website domain' }, industry: { description: 'Industry category' } },
      scopes: { read: ['crm.objects.companies.read'], write: ['crm.objects.companies.write'] },
      async *fetch(ctx, since) {
        for await (const page of paginate('/crm/v3/objects/companies', { after: since })) {
          yield {
            records: page.results.map(c => ({ id: c.id, data: c.properties })),
            since: page.paging?.next?.after,
          };
        }
      },
      async lookup(ids, ctx) {
        const res = await ctx.http('https://api.hubspot.com/crm/v3/objects/companies/batch/read', {
          method: 'POST',
          body: JSON.stringify({ inputs: ids.map(id => ({ id })) })
        });
        if (!res.ok) throw new Error(`Batch read failed: ${res.status}`);
        const result = await res.json();
        return result.results.map(c => ({ id: c.id, data: c.properties }));
      },
      async *insert(records, ctx) {
        for await (const batch of chunk(records, 100)) {
          const res = await ctx.http('https://api.hubspot.com/crm/v3/objects/companies/batch/create', {
            method: 'POST',
            body: JSON.stringify({ inputs: batch.map(r => ({ properties: r.data })) })
          });
          if (!res.ok) throw new Error(`Batch create failed: ${res.status}`);
          const result = await res.json();
          yield* result.results.map(item => ({ id: item.id, data: item.properties }));
        }
      },
      async *update(records, ctx) {
        for await (const batch of chunk(records, 100)) {
          const res = await ctx.http('https://api.hubspot.com/crm/v3/objects/companies/batch/update', {
            method: 'POST',
            body: JSON.stringify({ inputs: batch.map(r => ({ id: r.id, properties: r.data })) })
          });
          if (!res.ok) throw new Error(`Batch update failed: ${res.status}`);
          const result = await res.json();
          yield* result.results.map(item => ({ id: item.id, data: item.properties }));
        }
      },
      async *delete(ids, ctx) {
        for await (const batch of chunk(ids, 100)) {
          const res = await ctx.http('https://api.hubspot.com/crm/v3/objects/companies/batch/archive', {
            method: 'POST',
            body: JSON.stringify({ inputs: batch.map(id => ({ id })) })
          });
          if (!res.ok) throw new Error(`Batch delete failed: ${res.status}`);
          yield* batch.map(id => ({ id }));
        }
      }
    },
    {
      name: 'contact',
      schema: { firstname: { description: 'First name' }, lastname: { description: 'Last name' }, email: { description: 'Email address' } },
      scopes: { read: ['crm.objects.contacts.read'], write: ['crm.objects.contacts.write'] },
      dependsOn: ['company'],
      async *fetch(ctx, since) {
        for await (const page of paginate('/crm/v3/objects/contacts', { after: since })) {
          yield {
            records: page.results.map(c => ({ id: c.id, data: c.properties })),
            since: page.paging?.next?.after,
          };
        }
      },
      async lookup(ids, ctx) {
        const res = await ctx.http('https://api.hubspot.com/crm/v3/objects/contacts/batch/read', {
          method: 'POST',
          body: JSON.stringify({ inputs: ids.map(id => ({ id })) })
        });
        if (!res.ok) throw new Error(`Batch read failed: ${res.status}`);
        const result = await res.json();
        return result.results.map(c => ({ id: c.id, data: c.properties }));
      },
      async *insert(records, ctx) {
        for await (const batch of chunk(records, 100)) {
          const res = await ctx.http('https://api.hubspot.com/crm/v3/objects/contacts/batch/create', {
            method: 'POST',
            body: JSON.stringify({ inputs: batch.map(r => ({ properties: r.data })) })
          });
          if (!res.ok) throw new Error(`Batch create failed: ${res.status}`);
          const result = await res.json();
          yield* result.results.map(item => ({ id: item.id, data: item.properties }));
        }
      },
      async *update(records, ctx) {
        for await (const batch of chunk(records, 100)) {
          const res = await ctx.http('https://api.hubspot.com/crm/v3/objects/contacts/batch/update', {
            method: 'POST',
            body: JSON.stringify({ inputs: batch.map(r => ({ id: r.id, properties: r.data })) })
          });
          if (!res.ok) throw new Error(`Update failed: ${res.status}`);
          const result = await res.json();
          yield* result.results.map(item => ({ id: item.id, data: item.properties }));
        }
      },
      async *delete(ids, ctx) {
        for await (const batch of chunk(ids, 100)) {
          const res = await ctx.http('https://api.hubspot.com/crm/v3/objects/contacts/batch/archive', {
            method: 'POST',
            body: JSON.stringify({ inputs: batch.map(id => ({ id })) })
          });
          if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
          yield* batch.map(id => ({ id }));
        }
      }
    },
    {
      name: 'deal',
      schema: { dealId: { description: 'Deal ID', immutable: true }, dealname: { description: 'Deal name' }, amount: { description: 'Deal value in NOK', type: 'number' }, dealstage: { description: 'Current pipeline stage' } },
      scopes: { read: ['crm.objects.deals.read'], write: ['crm.objects.deals.write'] },
      dependsOn: ['contact', 'company'],
      async *fetch(ctx, since) {
        for await (const page of paginate('/crm/v3/objects/deals', { after: since })) {
          yield {
            records: page.results.map(d => ({ id: d.id, data: d.properties })),
            since: page.paging?.next?.after,
          };
        }
      },
      async lookup(ids, ctx) {
        const res = await ctx.http('https://api.hubspot.com/crm/v3/objects/deals/batch/read', {
          method: 'POST',
          body: JSON.stringify({ inputs: ids.map(id => ({ id })) })
        });
        if (!res.ok) throw new Error(`Batch read failed: ${res.status}`);
        const result = await res.json();
        return result.results.map(d => ({ id: d.id, data: d.properties }));
      },
      async *insert(records, ctx) {
        for await (const batch of chunk(records, 100)) {
          const res = await ctx.http('https://api.hubspot.com/crm/v3/objects/deals/batch/create', {
            method: 'POST',
            body: JSON.stringify({ inputs: batch.map(r => ({ properties: r.data })) })
          });
          if (!res.ok) throw new Error(`Batch create failed: ${res.status}`);
          const result = await res.json();
          yield* result.results.map(item => ({ id: item.id, data: item.properties }));
        }
      },
      async *update(records, ctx) {
        for await (const batch of chunk(records, 100)) {
          const res = await ctx.http('https://api.hubspot.com/crm/v3/objects/deals/batch/update', {
            method: 'POST',
            body: JSON.stringify({ inputs: batch.map(r => ({ id: r.id, properties: r.data })) })
          });
          if (!res.ok) throw new Error(`Update failed: ${res.status}`);
          const result = await res.json();
          yield* result.results.map(item => ({ id: item.id, data: item.properties }));
        }
      }
      // no delete() — deals cannot be archived via the HubSpot API
    }
  ];
}
```

### Design Alternative: Engine-Driven Entity Dispatch

> **Note**: This is the alternative design we considered. Documented here for future reference.
>
> Instead of `getEntities()`, the connector would declare entities in metadata and the engine would call `fetch/upsert/delete` by `entity` on top-level methods:
>
> ```typescript
> interface OpenSyncConnector {
>   metadata: { entities: string[]; /* ... */ };
>   fetch(entity: string, ctx: SyncContext, since?: Date): AsyncIterable<FetchRecord[]>;
>   upsert(entity: string, record: FetchRecord, ctx: SyncContext): Promise<PushResult>;
>   delete?(entity: string, id: string, ctx: SyncContext): Promise<void>;
> }
> ```
>
> Simpler interface, less boilerplate for basic connectors. But the engine has to guess dependencies and poll intervals, and connector behavior for each entity gets split between metadata and top-level dispatch logic.
>
> Could be revisited if `getEntities()` proves too verbose for simple connectors.

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
  required?: boolean;   // field must be present; engine enforces before insert()/update() and execute()
  immutable?: boolean;  // field cannot be changed after creation; engine rejects updates that include it
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
  filePaths: {
    type: 'array',
    items: { type: 'string' },
    description: 'JSON file paths. Each file becomes one entity.',
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

## FetchRecord

Records returned by `fetch()` and `lookup()`. Also the record type inside `FetchBatch`.

```typescript
interface FetchRecord {
  id: string;                                // this record's ID in the source system (uniqueness scope defined below)
  data: Record<string, unknown | unknown[]>; // raw JSON blob — values may be single or multi-valued
  deleted?: boolean;                         // connector's intent to remove this record from the target (see FetchRecord — Deletion below)
  associations?: Association[];              // pre-extracted reference fields (see Associations)
}

interface Association {
  predicate: string;                         // the field key in data whose value is this reference (e.g. 'companyId', 'worksFor', 'https://schema.org/worksFor')
  targetEntity: string;                      // target entity name (e.g. 'company') — forms composite key with targetId
  targetId: string;                          // the referenced ID — usually the value of data[predicate]
  metadata?: Record<string, unknown>;        // optional edge properties beyond the reference itself (e.g. { since: '2020-01-01' })
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

Associations are an explicit index of which fields in `data` are references, and to what. For a HubSpot contact with `data: { companyId: 'hs_456', name: 'Alice' }`, the association is just that field made explicit:

```typescript
associations: [{ predicate: 'companyId', targetEntity: 'company', targetId: 'hs_456' }]
```

`predicate` is typically the field key in `data` whose value is the reference. `targetId` is that value. `targetEntity` tells the engine which entity to look in — together they form the same `(entity, id)` composite key used everywhere else.

The engine resolves associations using `(targetEntity, targetId)` and does not silently pick a candidate if the target is not found — the edge is left pending until the target record arrives.

For JSON-LD connectors, `predicate` may be a URI (e.g. `https://schema.org/worksFor`), and associations are typically derived by extracting `@id` references from `data`. The two representations are two views of the same thing — `associations` is the pre-extracted, engine-readable form.

For flat systems where contact and company live in one object — the connector just returns one record with all fields. No splitting required. The engine handles many-to-many mapping.

## Write Records

The engine constructs typed records for each write operation. All fields are engine-owned and read-only from the connector's perspective.

```typescript
interface InsertRecord {
  data: Record<string, unknown | unknown[]>;
  associations?: Association[];
}

interface UpdateRecord {
  id: string;                                  // ID previously returned by InsertResult.id
  data: Record<string, unknown | unknown[]>;
  associations?: Association[];
}

// delete() receives IDs directly — no record wrapper needed
```

All fields are engine-owned and read-only from the connector's perspective.

The engine, not the connector, is responsible for maintaining `id`. Connectors must not mutate it.

## Write Results

Each write method yields one result per input record/ID, in the same order (positional correlation).

```typescript
interface InsertResult {
  id: string;                     // ID assigned by this (target) system
  data?: Record<string, unknown>; // full API response; stored for echo prevention — lets the engine suppress its own writes when they come back through fetch()
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

`InsertResult.id` is stored in the identity map and fed back as `UpdateRecord.id` and the delete ID on future writes. `InsertResult.data` / `UpdateResult.data` are stored for echo prevention — they let the engine recognise its own writes coming back through `fetch()` and suppress them as no-ops. `notFound` on delete or update is not an error — the record was already gone or never arrived. The happy-path result is just `{ id }` — no status annotation needed.

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

For storing per-instance data like session tokens, pagination cursors, or webhook registration IDs. Backed by the `instance_meta` table in SQLite.

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
// Two parallel fetch() runs both see an expired token — only one refreshes it.
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

## Fetch — Reading Data

`fetch` is optional. Omitting it makes the entity a write-only sink — the engine tracks identity and routes inserts, updates, and deletes, but never polls. Useful for targets like data warehouses or event sinks that can receive data but have no meaningful "read current state" operation.

When implemented, `fetch()` yields `FetchBatch` objects:

```typescript
fetch?(ctx: ConnectorContext, since?: string): AsyncIterable<FetchBatch>;

interface FetchBatch {
  records: FetchRecord[];
  since?: string;  // watermark for this batch; engine stores for next poll
}
```

**Watermark behavior:**
- Each yielded batch can include a `since` value — the engine stores the latest one it sees.
- On the next poll, the engine passes that stored value as the `since` parameter to `fetch()`.
- If `since` is provided, return only records modified after that watermark.
- If `since` is undefined, return everything (full sync — used for onboarding and soft delete detection).
- If interrupted, resumption uses the last stored watermark (no data loss or duplication).

Do not store pagination cursors in `ctx.state` — cursors are only valid for a single in-progress fetch run. If interrupted, resumption should use the last-committed `since` watermark from `FetchBatch`, not a stale cursor. `ctx.state` is for durable per-instance data that outlives a single fetch run (webhook subscription IDs, session tokens, etc.).

## Lookup — On-Demand Batch Lookup

```typescript
lookup?(ids: string[], ctx: ConnectorContext): Promise<FetchRecord[]>;
```

Optional method for fetching a set of records by ID on-demand (not streaming). The engine always calls it with a batch — accumulating all IDs it needs before dispatching, so connectors with batch read APIs can serve them in one round trip.

**Use cases:**
- **Delete verification**: Confirm records are actually gone before returning undo success
- **Rollback recovery**: Check if records still exist before attempting to restore them
- **Reconciliation**: Spot-check a set of records without a full sync
- **Conflict detection**: Before dispatching writes, the engine calls `lookup` to compare live target state against the source snapshots that drove the writes — field-scoped, so unrelated fields changed by other writers are not treated as conflicts

**Contract:**
- Return a `FetchRecord[]` for the records that were found; omit records that don't exist
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

## HTTP Customization

Connectors can implement optional methods on `Connector` for custom HTTP behavior:

```typescript
interface WebhookBatch {
  entity: string;            // matches an EntityDefinition name
  records: FetchRecord[];
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

  // group events by entity type, map to FetchRecord
  const byEntity = new Map<string, FetchRecord[]>();
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
interface ActionDefinition {
  name: string;                                        // e.g. 'send-email', 'post-message'
  description?: string;
  schema?: Record<string, FieldDescriptor>; // optional — required fields validated before execute() is called
  scopes?: string[];                                   // OAuth scopes required to execute this action
  execute(payload: Record<string, unknown>, ctx: ConnectorContext): Promise<ActionResult>;
}

interface ActionResult {
  status: 'success' | 'failed';
  data?: Record<string, unknown>;              // response from the external system, if any
}
```

Actions get the same `ConnectorContext` as streams — `ctx.http`, `ctx.state`, `ctx.config`, and `ctx.logger` all work identically.

`schema` uses the same `FieldDescriptor` type as entity fields. If provided, the engine validates that all `required: true` fields are present in the payload before calling `execute()`. CLI/UI tooling can also use it to prompt for action inputs without reading documentation.

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

**`fetch()`** — throw to abort the entire fetch run for this entity. The engine will retry on the next poll cycle using the last stored watermark for this entity.
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



## Example Connectors

Three connectors ship with the project for development and testing:

### mock-crm (relational)
- Entities: `contact` (firstName, lastName, email, phone, companyId), `company` (name, domain, industry)
- In-memory Map storage with `updatedAt` tracking
- Implements: `insert`, `update`, `delete`

### mock-erp (flat)
- Entity: `customer` (fullName, emailAddress, phoneNumber, organizationName)
- Deliberately different field names to exercise transforms
- Implements: `insert` only (append-only log)

### jsonfiles (hello world)
The simplest possible connector — reads and writes a JSON array file. Intended as the starting point for anyone learning the SDK.
- Entity: `record` (arbitrary fields from the JSON objects)
- Storage: a `.json` file on disk (path from `ctx.config.filePath`)
- `fetch()` reads the file, returns all objects (or filters by a `updatedAt` field if `since` is provided)
- `insert()` appends, `update()` replaces by ID, `delete()` removes by ID — all write back to the file
- Implements: `insert`, `update`, `delete`

Example data file:
```json
[
  { "id": "1", "name": "Ola Nordmann", "email": "ola@test.no", "updatedAt": "2026-04-01T10:00:00Z" },
  { "id": "2", "name": "Kari Hansen", "email": "kari@test.no", "updatedAt": "2026-04-01T11:00:00Z" }
]
```

This connector doesn't use `ctx.http` (no HTTP calls), demonstrating that connectors aren't limited to REST APIs.
