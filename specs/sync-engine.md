# Sync Engine

The core pipeline that processes data changes and propagates them across systems.

## Pipeline Steps

Every sync cycle (poll or webhook-triggered) runs through these steps in order:

1. **Ingest** — fetch changes from source connector
2. **Transform** — apply field mappings to produce canonical form
3. **Reconcile** — diff incoming data against shadow state
4. **Resolve** — apply conflict rules
5. **Dispatch** — fan-out accepted changes to all other channel members
6. **Update** — store new shadow state with previous values preserved; advance watermark in the same transaction

The actual implementation details of steps 3–6 (reconciliation, resolution, storage) are backend-specific — see **Backend Architecture** below.

## Ingest Loop

Each source connector is read **once per cycle**, not once per target. The results are diffed against shadow state and fanned out to all other channel members in a single pass. This is the hub-and-spoke model applied to polling — reading a source twice would waste API quota and create race conditions between the two reads.

```
for each channel:
  for each member connector (in dependency order):
    records = connector.read(ctx, watermark)      // one read per source
    for each record:
      canonical = applyInbound(record, mappings)  // transform to canonical form
      shadow = getShadow(connectorId, recordId)
      if shadowMatchesIncoming(shadow, canonical): skip  // echo detection
      diff = computeDiff(canonical, shadow)
      resolved = resolveConflicts(diff, shadow, config)
      for each OTHER member in the channel:
        localRecord = applyOutbound(resolved, member.mappings)
        result = member.connector.insert/update(localRecord)
        updateShadow(member.connectorId, result.id, canonical)
    advanceWatermark(connectorId, entity, newSince)  // same DB transaction as shadow update
```

The watermark advance is **atomic with the shadow state update** — both happen in the same SQLite transaction. A crash between reading and writing cannot produce a watermark that is ahead of the actual written state. On restart, the engine re-reads from the last committed watermark and the shadow state comparison suppresses any records that were already dispatched.

## Association Propagation Rules

Associations (`Association[]` on a `ReadRecord`) represent foreign-key style links between entities. The engine resolves them through the identity map and applies the following rules — all four are unconditional.

### Rule 1: Empty associations propagate as removal

`associations: []` (an explicit empty array) is distinct from `associations: undefined` (field absent from this record).

- `undefined` → field was not included in this read; treat as a sparse update — leave associations untouched on the target.
- `[]` → source explicitly carries zero associations; propagate the removal so the target clears its association list.

Passing `undefined` when a source has removed all associations silently drops the removal and the target retains stale associations indefinitely.

### Rule 2: Null or falsy `targetId` is a removal tombstone

When an association carries a falsy `targetId` (null, empty string, undefined), the engine treats this as an explicit disassociation — not as a missing dependency. It does **not** defer the record.

The engine passes `{ ...assoc, targetId: null }` to the target (or omits the association entirely, depending on the connector contract) rather than suspending the record in the defer queue.

### Rule 3: Unknown `targetEntity` surfaces as an error

If an association references an entity name that has never appeared in the identity map for this channel (e.g. a typo like `"custmers"`), the engine surfaces this as a record-level `error` action and logs it. It does **not** defer — deferral means "wait for the target to arrive"; an unknown entity name is a configuration error that will never self-resolve.

Distinguishing these cases:
- `targetId` not yet in identity map → legitimate defer (target record hasn't synced yet)
- `targetEntity` name unknown → configuration error → `"error"` action

### Rule 4: Duplicate predicates are deduplicated

If a source record carries two `Association` entries with the same `predicate` value, the engine deduplicates them before remapping. Last-wins within the incoming array. Duplicates that survive into the target create referential ambiguity and are rejected upstream if the connector enforces uniqueness.

## Backend Architecture

The engine's core pipeline is **data-model agnostic**. Behind the scenes, pluggable backends handle:

- **Shadow state** — how entity data is stored and tracked
- **Entity resolution** — how external IDs map to a unified identity
- **Diffing** — how changes are detected
- **Conflict resolution** — how competing values are decided
- **Transaction log** — how operations are recorded for undo/audit

This design allows:

1. **Multiple implementations aligned to different data models**
2. **Connectors remain independent** of backend choice
3. **Future backends (graph, triple-store, event sourcing) without refactoring connectors or core pipeline**

### Backend Interface (Abstraction)

Each backend implements:

```typescript
interface SyncBackend {
  // Shadow state: store and retrieve entity data with provenance
  shadowState: {
    upsert(entityId: UUID, instanceId: string, data: BackendFieldData): Promise<void>;
    get(entityId: UUID): Promise<BackendEntityState | null>;
    getByExternalId(externalId: string, instanceId: string): Promise<BackendEntityState | null>;
  };
  
  // Entity resolution: map external IDs to unified UUIDs (identity map)
  entityResolution: {
    getOrCreate(externalId: string, connectorInstanceId: string, entityType: string): Promise<UUID>;
    link(uuid: UUID, externalId: string, connectorInstanceId: string): Promise<void>;
    resolve(externalId: string, connectorInstanceId: string): Promise<UUID | null>;
  };
  
  // Diffing: detect what changed
  diff: {
    compute(
      incoming: NormalizedRecord,
      prior: BackendEntityState | null,
      sourceInstanceId: string,
      timestamp: number
    ): Change[];        // backend-specific change representation
  };
  
  // Conflict resolution: decide which value wins
  conflictResolver: {
    resolve(field: string, candidates: { instanceId: string; value: unknown }[]): unknown;
  };
  
  // Transaction log: audit trail and undo support
  transactionLog: {
    append(operation: TransactionOperation): Promise<void>;
    getSince(timestamp: number): Promise<TransactionOperation[]>;
    rollback(transactionId: UUID, targetInstanceId?: string): Promise<void>;
  };
}
```

### Current Implementation: Field-Level (Relational) Backend

The v1 engine implements a **field-level** backend optimized for relational systems (CRM, ERP, accounting):

- **Shadow state**: JSONB field entries with `{ val, prev, ts, src }`
- **Entity resolution**: UUID identity map + `entity_links` table
- **Diffing**: field-by-field comparison
- **Conflict resolution**: field-level master + LWW strategy
- **Transaction log**: field-level mutations

The rest of this document describes this field-level implementation.

### Future: Triple-Level (Graph) Backend

A graph-oriented backend could handle RDF, knowledge graphs, and triple stores:

- **Shadow state**: triples with `{ subject, predicate, object, ts, src }`
- **Entity resolution**: graph URI resolution + identity linking
- **Diffing**: triple-by-triple comparison
- **Conflict resolution**: predicate-level master rules
- **Transaction log**: triple-level assertions/retractions

Same core pipeline; different storage and processing model.

See [semantic-sources.md](semantic-sources.md) for how connectors support both backends.

## Shadow State

The heart of the engine. Every record in every system has a corresponding shadow state — a JSONB blob tracking each field individually.

### Field Entry Structure

```typescript
interface FieldEntry {
  val: unknown;    // current value
  prev: unknown;   // previous value (preserved for undo)
  ts: number;      // epoch ms when this value was last written
  src: string;     // connector instance ID that last wrote this field
}

type FieldData = Record<string, FieldEntry>;
```

Example shadow state for a contact:
```json
{
  "email": { "val": "ola@test.no", "prev": "old@test.no", "ts": 1711993200, "src": "hubspot-1" },
  "phone": { "val": "99887766", "prev": null, "ts": 1711993500, "src": "fiken-1" },
  "status": { "val": "active", "prev": "lead", "ts": 1711992000, "src": "hubspot-1" }
}
```

### Why Field-Level

- **Conflict resolution**: different systems can be master for different fields
- **Undo granularity**: revert a single field, not the whole record
- **Change detection**: know exactly which fields changed and when
- **External change detection**: if a field changes but the engine didn't write it, something else did

## Diff Engine

A pure function — no DB calls. Compares incoming data against shadow state.

```typescript
interface FieldDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  source: string;      // connector instance that produced this change
  timestamp: number;
}

interface DiffResult {
  entityId: string;
  entityLinkId: string;
  changes: FieldDiff[];
  isNew: boolean;       // no prior shadow state exists
  isDeleted: boolean;   // record missing from full sync
}

function computeDiff(
  incoming: Record<string, unknown>,
  shadow: FieldData | null,
  sourceInstanceId: string,
  timestamp: number
): DiffResult;
```

Logic:
- If shadow is null → all fields are "new"
- For each field in incoming: compare `incoming[field]` against `shadow[field].val`
- Only changed fields appear in `changes`
- Fields present in shadow but absent in incoming are NOT treated as deletions (sparse updates are allowed)

## Transform Engine

User-defined TypeScript functions for mapping fields between systems. Transforms run twice per sync:
1. **Inbound**: source system format → engine's internal representation
2. **Outbound**: engine's internal representation → target system format

```typescript
type TransformFn = (
  data: Record<string, unknown>,
  direction: 'inbound' | 'outbound',
  context: { sourceEntity: string; targetEntity: string }
) => Record<string, unknown>;

interface FieldMapping {
  sourceField: string;
  targetField: string;
  transform?: TransformFn;   // optional custom logic
}

interface EntityMapping {
  sourceEntity: string;       // e.g. 'contact'
  targetEntity: string;       // e.g. 'customer'
  fields: FieldMapping[];
}

function applyTransform(
  data: Record<string, unknown>,
  mapping: EntityMapping,
  direction: 'inbound' | 'outbound'
): Record<string, unknown>;
```

### Simple rename (no transform fn needed)
```typescript
{ sourceField: 'email', targetField: 'emailAddress' }
```

### Combining fields
```typescript
{
  sourceField: 'firstName',
  targetField: 'fullName',
  transform: (d) => ({ ...d, fullName: `${d.firstName} ${d.lastName}` })
}
```

### Normalizing formats (prevents false-positive diffs)
```typescript
{
  sourceField: 'phone',
  targetField: 'phone',
  transform: (d) => ({ ...d, phone: normalizePhoneNumber(d.phone) })
}
```

Without normalizers, systems with different phone formats (`+47 99 88...` vs `479988...`) will see each other's values as "changed" and loop forever.

### Mapping changes

When a user changes their mapping configuration, the engine can re-process existing shadow state without re-fetching from source systems. The raw data is preserved in shadow state — only the transform instructions change.

### SQL Expressions as Transform Language (Future)

> **Note**: Documented as a future alternative to TypeScript transforms.
>
> SQL is a natural fit for data transformation — compact, well-known, and portable. Example:
> ```yaml
> fields:
>   - target: full_name
>     expression: "src.first_name || ' ' || src.last_name"
>   - target: email
>     expression: "LOWER(src.email)"
>   - target: amount_nok
>     expression: "src.amount_usd * 10.5"
> ```
>
> Implementation approach: insert source data into a temporary SQLite table, run `SELECT [expressions] FROM temp`, read the result. This gives real SQL power "for free" since we already have SQLite.
>
> Deferred because: TypeScript transforms are more flexible, easier for agents to generate, and don't require a SQL parser/evaluator layer. But SQL expressions could be a powerful addition for users who think in SQL rather than code.

## Conflict Resolution

When the same field changes in multiple systems between sync cycles.

```typescript
type ResolutionStrategy = 'field_master' | 'lww' | 'manual';

interface FieldRule {
  field: string;
  master?: string;               // connector instance ID that always wins
  strategy: ResolutionStrategy;
}

interface ConflictResolutionConfig {
  defaultStrategy: ResolutionStrategy;  // fallback for fields without explicit rules
  fieldRules: FieldRule[];
}

interface ResolvedField {
  field: string;
  value: unknown;
  source: string;
  resolution: 'accepted' | 'rejected' | 'conflict';
  reason: string;
}

function resolveConflicts(
  changes: FieldDiff[],
  shadow: FieldData | null,
  config: ConflictResolutionConfig
): ResolvedField[];
```

### Strategies

**field_master**: One system always wins for specific fields. Example: CRM is master for email/phone, ERP is master for invoice_address/vat_number. If a non-master system changes a mastered field, the change is rejected and the master's value is written back.

**lww (Last Write Wins)**: The change with the most recent timestamp wins. Default fallback. Uses `FieldEntry.ts` for comparison.

**manual**: Flag the conflict for human review. The record is paused (not synced) until resolved.

### Typical setup
```yaml
conflict_resolution:
  default: lww
  field_rules:
    - field: email
      strategy: field_master
      master: hubspot-1
    - field: vat_number
      strategy: field_master
      master: fiken-1
```

## Dispatch (Fan-out)

After resolving conflicts, accepted changes are pushed to all other members of the sync channel.

```typescript
class Dispatcher {
  dispatch(
    channelId: string,
    sourceInstanceId: string,
    entityId: string,
    resolvedFields: ResolvedField[],
    mapping: EntityMapping
  ): Promise<DispatchResult[]>;
}

interface DispatchResult {
  targetInstanceId: string;
  externalId: string;
  status: 'created' | 'updated' | 'skipped' | 'failed';
  error?: string;
}
```

For each target system:
1. Apply outbound transform (engine format → target format)
2. Look up external ID via identity map. If none exists, this is a create.
3. Call `connector.upsert()` → get `PushResult`
4. Store the new external ID in identity map (if created)
5. Update shadow state for the target system
6. Record outbound push in echo guard
7. Log the mutation in transaction log (for undo)

If one target fails, others still proceed. Failed targets are retried via the job queue.

## Sync Channels

A channel groups connector instances that sync a given entity type.

```yaml
channels:
  - name: "Contact Sync"
    entity_type: contact
    members:
      - connector: hubspot
        instance: hubspot-prod
        role:
          master_fields: [email, phone]
      - connector: fiken
        instance: fiken-prod
        role:
          master_fields: [vat_number]
      - connector: mailchimp
        instance: mailchimp-prod
        role:
          master_fields: []   # no mastered fields, LWW for everything
```

Adding a third system is just adding another member. The hub-and-spoke model means no new point-to-point integrations needed.

## Scheduling & Watermarks

### Per-Entity Scheduling

Each connector declares streams with `recommendedIntervalSeconds`. The engine uses these as defaults, creating separate polling schedules per entity per connector instance.

The user can override in channel config:

```yaml
channels:
  - name: "Full Sync"
    members:
      - instance: hubspot-prod
        scheduling:
          contact: { interval_seconds: 60 }
          company: { interval_seconds: 300 }
          deal: { interval_seconds: 300 }
      - instance: fiken-prod
        scheduling:
          customer: { interval_seconds: 600 }
          invoice: { interval_seconds: 3600 }
```

### Watermark Tracking

The engine tracks how far each entity has been read **per source connector** in `stream_state`. Watermarks are keyed `(connector_instance_id, entity_type)` — one entry per connector per entity, shared across all targets that consume from that source.

| connector_instance_id | entity_type | cursor | last_fetched_at |
|----------------------|-------------|--------|-----------------|
| hubspot-prod | contact | `{"since": "2026-04-01T10:00:00Z"}` | 2026-04-01T10:05:00Z |
| hubspot-prod | company | `{"since": "2026-04-01T09:30:00Z"}` | 2026-04-01T09:35:00Z |
| fiken-prod | invoice | `{"since": "2026-03-31T02:00:00Z"}` | 2026-03-31T02:05:00Z |

**Note on key scheme**: Earlier POC versions keyed watermarks per directed pair (`"fromId→toId:entity"`), which allowed each target to advance its own cursor independently. The current architecture reads each source once and fans out to all targets, so a single per-source watermark is correct — the hub-and-spoke ingest loop processes all targets in one pass before advancing the cursor.

After a successful fetch cycle, the engine updates the cursor **in the same database transaction** as the shadow state writes for that cycle (see Ingest Loop above). A crash cannot produce a cursor that is ahead of the written data.

On the next poll, the cursor is passed as `since` to the stream's `read()`.

The cursor is JSONB rather than a plain timestamp because some APIs use opaque cursors, page tokens, or sequence numbers instead of timestamps. The connector decides what goes in the cursor — the engine just stores and passes it back.

### Dependency-Ordered Execution

When a sync cycle runs, the engine resolves stream dependencies (from `StreamDefinition.dependsOn`) into topological order:

1. Fetch all streams with no dependencies first (e.g. `company`)
2. Then streams that depend on those (e.g. `contact` depends on `company`)
3. Then deeper dependencies (e.g. `deal` depends on `contact`)

This ensures that when a contact references a company, the company has already been synced and has an identity link in the target system.

Circular dependencies are detected at config validation time and rejected with a clear error.

### Full Sync vs Delta Sync

- **Delta sync**: Engine passes the stored watermark as `since`. Connector returns only changed records. This is the normal operating mode.
- **Full sync**: Engine passes `since = undefined`. Connector returns everything. Used for:
  - Initial onboarding/discovery
  - Soft delete detection (mark-and-sweep)
  - Periodic reconciliation (catching anything webhooks missed)
  - After a user changes their mapping config

Full syncs can be triggered manually (`opensync sync --full`) or scheduled (e.g. daily at 02:00 via config).

## Job Queue

Sync jobs are queued in SQLite rather than processed inline. This provides:
- Persistence across restarts
- Priority ordering
- Retry with backoff
- Rate limiting per connector

```typescript
class JobQueue {
  enqueue(job: { channelId, sourceInstanceId, payload, priority?, runAt? }): Promise<string>;
  dequeue(limit?: number): Promise<SyncJob[]>;   // atomic SELECT + UPDATE
  complete(jobId: string): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  retry(jobId: string): Promise<void>;
}

class JobWorker {
  start(): void;           // begins polling loop
  stop(): Promise<void>;   // graceful shutdown
}
```

## Pipeline Orchestrator

Ties everything together. Runs per-entity — the scheduler invokes the pipeline once for each stream according to its schedule and dependency order.

```typescript
class SyncPipeline {
  // Run a single entity sync for one source connector
  execute(job: {
    channelId: string;
    sourceInstanceId: string;
    entityType: string;
    since?: Date;              // from stream_state watermark, or undefined for full sync
  }): Promise<PipelineResult>;

  // Run a full sync cycle for a channel — resolves dependencies, runs all streams in order
  executeChannel(channelId: string, options?: { full?: boolean }): Promise<Map<string, PipelineResult>>;
}

interface PipelineResult {
  entityType: string;
  processed: number;
  created: number;
  updated: number;
  skipped: number;     // echo suppressed
  conflicts: number;
  errors: Array<{ entityId: string; error: string }>;
}
```

`executeChannel()` is the top-level entry point. It:
1. Gets all streams from all member connectors
2. Resolves dependency order across all members
3. For each entity in order: runs `execute()` for each source connector
4. Updates watermarks in `stream_state` after each successful fetch

## Design Rationale: Why Backends?

The pipeline orchestrator and job queue are **data-model agnostic** by design. This separation enables:

### 1. Non-Relational Sources Today
Graph sources (RDF, semantic web, knowledge graphs) emit multi-valued properties and relationships that don't flatten cleanly into records. With a pluggable backend, the relational engine doesn't need to force these into its schema — a future graph backend can interpret the same connector output natively.

### 2. Evolution Without Refactoring
As we learn what works for customers:
- New backends can be added without touching the pipeline
- Existing connectors and migrations remain valid
- Users can migrate data between backends (or run both in parallel)

### 3. Optimizations for Specific Models
- **Relational backend**: Field-level diffing, JSONB shadow state, ACID transactions
- **Graph backend**: Triple-level provenance, native graph queries, resource-centric identity
- **Event sourcing backend** (future): Immutable event log, temporal queries, point-in-time state

Each backend optimizes for its data model without coupling the core pipeline to those details.

### 4. Testing & Pluggability
A mock backend simplifies testing the pipeline without database I/O. Connectors don't care which backend is running — they just emit `NormalizedRecord` objects.

### 5. Standards Alignment
By keeping the pipeline neutral, we avoid vendor lock-in. The identity resolution layer, operation log, and conflict resolution logic are backend-agnostic — they could theoretically plug into different storage layers (PostgreSQL, Duckdb, RDF4J, etc.) with backend-specific implementations.

**The connectors SDK, the pipeline, and the deployment model are all independent of backend choice.** This is intentional. It makes OpenSync durable and extensible.
