# Connector SDK

The SDK (`@opensync/sdk`) is the only package a connector author needs. It defines the contract between connectors and the engine.

## Core Interface

```typescript
interface OpenSyncConnector {
  metadata: ConnectorMetadata;

  // Reading data — connector defines its own streams (entities)
  getStreams(ctx: SyncContext): StreamDefinition[];

  // Writing data — must return the object as stored by the target (including generated IDs)
  upsert(entity: string, record: NormalizedRecord, ctx: SyncContext): Promise<PushResult>;
  delete?(entity: string, id: string, ctx: SyncContext): Promise<void>;

  // Webhook support
  lifecycle?: {
    onEnable(ctx: SyncContext): Promise<void>;   // register webhooks
    onDisable(ctx: SyncContext): Promise<void>;  // tear down webhooks
  };
  handleWebhook?(req: Request, ctx: SyncContext): Promise<NormalizedRecord[]>;

  // Auth customization
  prepareRequest?(req: Request, ctx: SyncContext): Promise<Request>;
}
```

## Streams

The connector defines what data it can provide via `getStreams()`. Each stream represents one entity type with its own fetch logic, scheduling hints, and dependency ordering.

```typescript
interface StreamDefinition {
  entity: string;                              // e.g. 'contact', 'company'
  fetch(ctx: SyncContext, since?: Date): AsyncIterable<NormalizedRecord[]>;
  capabilities: ConnectorCapabilities;         // per-entity capabilities
  fieldDescriptions?: Record<string, string>;  // plain-text descriptions of fields (e.g. { "fnavn": "First name", "kto_nr": "Bank account number" })
  recommendedIntervalSeconds?: number;         // e.g. 300 for contacts, 3600 for invoices
  dependsOn?: string[];                        // e.g. ['company'] — sync companies before contacts
}
```

Field descriptions are declared per stream, not per record — they're the same for every record of a given entity type. They're plain-text, free-form descriptions. No taxonomy or naming convention to follow — just describe what the field contains in whatever language makes sense. This avoids redundant metadata on every record and gives agents a way to understand non-obvious field names.

### Why Connector-Driven Streams

The connector knows its own API best:

- **Dependencies**: HubSpot contacts reference companies. The connector declares `dependsOn: ['company']` so the engine syncs companies first — otherwise contact creates fail because the referenced company doesn't exist in the target yet.
- **Poll frequency**: Fiken invoices rarely change but contacts change often. The connector hints `recommendedIntervalSeconds: 3600` for invoices and `300` for contacts.
- **Bundled APIs**: Some APIs return multiple entity types in one call. The connector can use a single HTTP request internally and yield records across multiple `fetch()` calls.
- **Single source of truth**: The streams ARE the entity list — no separate `metadata.entities` that can drift out of sync with the actual implementation.

### Scheduling

The engine uses `recommendedIntervalSeconds` as a default but the user can override per-entity in channel config:

```yaml
channels:
  - name: "Full Sync"
    members:
      - instance: hubspot-prod
        scheduling:
          contact: { interval_seconds: 60 }      # override: poll contacts every minute
          invoice: { interval_seconds: 7200 }     # override: invoices every 2 hours
```

### Watermark Tracking

The engine tracks the `since` watermark per entity per connector instance in the `stream_state` table. After a successful fetch, the engine stores the latest timestamp so the next poll only gets new changes.

The connector receives the watermark via the `since` parameter. If `since` is undefined, it's a full sync.

### Dependency Resolution

The engine resolves `dependsOn` into a topological order before running a sync cycle. If `contact` depends on `company` and `deal` depends on `contact`:

1. Sync `company` first
2. Then `contact`
3. Then `deal`

Circular dependencies are detected at config validation time and rejected.

### Example: HubSpot Connector Streams

```typescript
getStreams(ctx) {
  return [
    {
      entity: 'company',
      capabilities: { canDelete: true, canUpdate: true },
      fieldDescriptions: { name: 'Company name', domain: 'Company website domain', industry: 'Industry category' },
      recommendedIntervalSeconds: 600,
      async *fetch(ctx, since) {
        // paginated fetch from /crm/v3/objects/companies
      }
    },
    {
      entity: 'contact',
      capabilities: { canDelete: true, canUpdate: true },
      fieldDescriptions: { firstname: 'First name', lastname: 'Last name', email: 'Email address' },
      recommendedIntervalSeconds: 300,
      dependsOn: ['company'],
      async *fetch(ctx, since) {
        // paginated fetch from /crm/v3/objects/contacts
      }
    },
    {
      entity: 'deal',
      capabilities: { canDelete: false, canUpdate: true, immutableFields: ['dealId'] },
      fieldDescriptions: { dealname: 'Deal name', amount: 'Deal value in NOK', dealstage: 'Current pipeline stage' },
      recommendedIntervalSeconds: 300,
      dependsOn: ['contact', 'company'],
      async *fetch(ctx, since) {
        // paginated fetch from /crm/v3/objects/deals
      }
    }
  ];
}
```

### Design Alternative: Engine-Driven Entity Fetch

> **Note**: This is the alternative design we considered. Documented here for future reference.
>
> Instead of `getStreams()`, the connector would declare entities in metadata and the engine would call `fetch(entity, ctx, since)` for each:
>
> ```typescript
> interface OpenSyncConnector {
>   metadata: { entities: string[]; /* ... */ };
>   fetch(entity: string, ctx: SyncContext, since?: Date): AsyncIterable<NormalizedRecord[]>;
> }
> ```
>
> Simpler interface, less boilerplate for basic connectors. But the engine has to guess dependencies and poll intervals, and the connector can't express that two entities come from the same API call.
>
> Could be revisited if `getStreams()` proves too verbose for simple connectors.

## Metadata

```typescript
interface ConnectorMetadata {
  name: string;                              // e.g. 'hubspot', 'fiken'
  version: string;                           // semver
  capabilities: ConnectorCapabilities;       // default capabilities (can be overridden per stream)
  configSchema: Record<string, ConfigField>; // declares what config the connector needs
  environments?: Record<string, string>;     // e.g. { production: 'https://api.fiken.no/v2', test: 'https://api.fiken.no/sandbox' }
}

interface ConfigField {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  secret?: boolean;      // masked in logs, encrypted at rest
  default?: unknown;
}

interface ConnectorCapabilities {
  canDelete: boolean;         // can the engine request deletion?
  canUpdate: boolean;         // can existing records be modified?
  supportsBulk?: boolean;     // does the API support batch operations?
  immutableFields?: string[]; // fields that can't be changed after creation (e.g. invoice_number)
}
```

### Config Schema

The `configSchema` declares what configuration a connector instance needs. This serves three purposes:

1. **CLI prompting**: `opensync add-connector hubspot` reads the schema and prompts for each field interactively.
2. **Validation**: The engine validates provided config against the schema before creating an instance. Missing required fields or wrong types fail fast.
3. **Agent discovery**: An agent can read the schema to know what credentials/settings are needed without reading documentation.

Example:
```typescript
configSchema: {
  clientId:     { type: 'string', description: 'OAuth Client ID', required: true, secret: false },
  clientSecret: { type: 'string', description: 'OAuth Client Secret', required: true, secret: true },
  portalId:     { type: 'string', description: 'HubSpot Portal ID', required: true, secret: false },
}
```

Fields marked `secret: true` are:
- Masked in structured logs and request journal
- Never shown in `opensync status` or `opensync inspect` output
- Stored encrypted in `connector_instances.config` (at-rest encryption)

Capabilities at metadata level are defaults. Each `StreamDefinition` can override with its own capabilities (e.g. contacts are deletable but invoices aren't).

Capabilities drive pre-flight warnings ("this system can't delete — inserts are permanent") and capability-aware rollback.

## NormalizedRecord

```typescript
interface NormalizedRecord {
  id: string;                                // external ID in the source system
  data: Record<string, unknown>;             // raw JSON blob — the connector's truth
  associations?: Association[];              // references to other objects
}

interface Association {
  entity: string;       // e.g. 'company'
  externalId: string;   // ID in the source system
  role: string;         // e.g. 'belongs_to', 'has_many', 'primary'
}
```

### No Common Data Model

Connectors expose their source system's data as-is. There is no shared `Contact` or `Invoice` type to conform to. The mapping between systems happens in the engine via user-defined transforms.

Field descriptions are optional plain-text labels declared on the `StreamDefinition`, not on individual records. They help agents and UIs understand what fields contain, especially for non-English or abbreviated field names. No structure is enforced — just write what makes sense.

### Associations

Connectors report references between objects. A HubSpot contact might have `associations: [{ entity: 'company', externalId: 'hs_company_456', role: 'primary' }]`.

The engine's identity map resolves these across systems. If a contact references a company, and that company has been linked to a Fiken customer, the engine knows the relationship.

For flat systems where contact and company live in one object — the connector just returns one record with all fields. No splitting required. The engine handles many-to-many mapping.

## PushResult

```typescript
interface PushResult {
  externalId: string;                   // the ID in the target system (critical for first-time creates)
  data: Record<string, unknown>;        // full object as returned by the target API
  status: 'created' | 'updated';
}
```

Capturing the full response is essential:
- Generated IDs are stored in the identity map
- The response becomes the shadow state for the target system
- This prevents the next poll from seeing the write as a "new" change (echo prevention)

## SyncContext

The engine provides a context object to every connector method. Connectors never handle auth, logging, or state management themselves.

```typescript
interface SyncContext {
  http: TrackedFetch;                    // auto-logged, auto-authed fetch
  config: Record<string, unknown>;       // instance config (baseUrl, foretakId, etc.)
  state: StateStore;                     // per-instance persistent key-value store
  logger: Logger;
  webhookUrl?: string;                   // URL where the engine receives webhooks for this instance
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

### ctx.state — Persistent Key-Value Store

For storing per-instance data like session tokens, pagination cursors, or webhook registration IDs. Backed by the `instance_meta` table in SQLite.

```typescript
interface StateStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
```

The connector receives its previous state on the next invocation. Example: storing a webhook subscription ID so `onDisable` can deregister it.

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

Each stream's `fetch()` function:

```typescript
fetch(ctx: SyncContext, since?: Date): AsyncIterable<NormalizedRecord[]>;
```

- Returns an async iterable of batches (pages). The connector handles pagination internally.
- If `since` is provided, return only records modified after that time (delta sync).
- If `since` is undefined, return everything (full sync — used for onboarding and soft delete detection).
- The engine tracks watermarks (last successful `since` value) per entity per instance in `stream_state`.

Pagination state (cursors, page tokens) can be stored in `ctx.state` if the connector needs to resume interrupted fetches. Use a key namespaced by entity (e.g. `cursor:contact`) to avoid collisions between streams.

## Upsert — Writing Data

```typescript
upsert(entity: string, record: NormalizedRecord, ctx: SyncContext): Promise<PushResult>;
```

- If `record.id` exists in the target system (known via identity map), update it.
- If `record.id` is unknown, create a new record.
- Must return `PushResult` with the target system's ID and full stored data.
- The engine determines create vs update — the connector receives a `NormalizedRecord` and figures out the right API call.

## Delete

```typescript
delete?(entity: string, id: string, ctx: SyncContext): Promise<void>;
```

Optional. Only callable if `capabilities.canDelete === true`. The engine checks this before calling.

## Auth — prepareRequest Hook

For bespoke auth (HMAC signing, session tokens, custom headers):

```typescript
prepareRequest?(req: Request, ctx: SyncContext): Promise<Request>;
```

Called before every outbound HTTP request. The connector can:
- Read the request body (via `req.clone()`) for HMAC signing
- Add custom headers (session tokens, API keys)
- Modify the URL (append query params)

Standard OAuth2 is handled by the engine automatically — connectors don't need `prepareRequest` for that.

## Database Connectors

For connectors that talk to databases instead of HTTP APIs, the same principles apply. The connector uses `ctx.http` for HTTP or manages its own DB connection (configured via `ctx.config`). All queries should still be logged — either through a `ctx.sql` helper (future) or manual journal entries.

## Optimistic Locking (ETag Support)

Some APIs support optimistic locking via `ETag` or `_version` fields. When the engine fetches a record, it stores the version. When it writes back, it sends the version — and the API rejects the write if someone else modified the record in between.

This is optional and connector-driven. If the source API returns version metadata, the connector stores it in `NormalizedRecord.data` (e.g. `_etag` or `_version`). The connector's `upsert()` uses it to send conditional writes (`If-Match` header or version field).

The engine doesn't enforce this — it's up to the connector to implement if the API supports it. But it's the strongest defense against race conditions when the API doesn't tell you who made a change.

## Health Checks

Connectors can optionally implement a health check for monitoring:

```typescript
interface OpenSyncConnector {
  // ... existing methods
  healthCheck?(ctx: SyncContext): Promise<HealthStatus>;
}

interface HealthStatus {
  healthy: boolean;
  message?: string;
  details?: Record<string, unknown>;  // e.g. { apiVersion: '3', rateLimitRemaining: 450 }
}
```

Called periodically by the engine to verify the connection is alive (valid credentials, API reachable, etc.). Results feed into the channel health status shown by `opensync status`.

## Error Hierarchy

```typescript
class OpenSyncError extends Error { code: string; retryable: boolean }
class RateLimitError extends OpenSyncError { retryAfterMs?: number }  // 429
class AuthError extends OpenSyncError { }                              // 401/403
class ValidationError extends OpenSyncError { }                        // bad data
class ConnectorError extends OpenSyncError { }                         // generic failure
```

Connectors should throw these typed errors. The engine uses them to decide: retry (RateLimitError), pause and refresh token (AuthError), skip record (ValidationError), or trip circuit breaker (too many ConnectorErrors).

## Declarative Connectors (Future)

> For simple REST APIs, writing a full TypeScript connector may be overkill. A future extension could support YAML-only connector definitions:
>
> ```yaml
> name: simple-api
> auth: bearer
> resources:
>   contacts:
>     read:
>       path: /v1/contacts
>       params: { updated_since: "{{ since | iso8601 }}" }
>       pagination: { strategy: cursor, cursor_path: "$.meta.next" }
>       normalization:
>         id: "$.id"
>         email: "$.email_address"
>     write:
>       path: "/v1/contacts/{{ id }}"
>       method: PATCH
> ```
>
> The engine would interpret this YAML and execute the HTTP calls — no TypeScript needed. However, this is intentionally deferred. TypeScript connectors are more flexible, easier for agents to generate, and cover 100% of use cases. Declarative connectors optimize for the 80% case at the cost of a rigid format that's harder to extend.

## Example Connectors

Three connectors ship with the project for development and testing:

### mock-crm (relational)
- Entities: `contact` (firstName, lastName, email, phone, companyId), `company` (name, domain, industry)
- In-memory Map storage with `updatedAt` tracking
- Capabilities: `canDelete: true, canUpdate: true`

### mock-erp (flat)
- Entity: `customer` (fullName, emailAddress, phoneNumber, organizationName)
- Deliberately different field names to exercise transforms
- Capabilities: `canDelete: false, canUpdate: true`

### mock-file (hello world)
The simplest possible connector — reads and writes a JSON array file. Intended as the starting point for anyone learning the SDK.
- Entity: `record` (arbitrary fields from the JSON objects)
- Storage: a `.json` file on disk (path from `ctx.config.filePath`)
- `fetch()` reads the file, returns all objects (or filters by a `updatedAt` field if `since` is provided)
- `upsert()` reads the file, inserts or replaces by ID, writes back
- `delete()` removes the entry and writes back
- Capabilities: `canDelete: true, canUpdate: true`

Example data file:
```json
[
  { "id": "1", "name": "Ola Nordmann", "email": "ola@test.no", "updatedAt": "2026-04-01T10:00:00Z" },
  { "id": "2", "name": "Kari Hansen", "email": "kari@test.no", "updatedAt": "2026-04-01T11:00:00Z" }
]
```

This connector doesn't use `ctx.http` (no HTTP calls), demonstrating that connectors aren't limited to REST APIs.
