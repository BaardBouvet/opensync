# Sync Engine

The core pipeline that reads records from a source connector, diffs them against shadow state,
resolves conflicts, and fans out accepted changes to all other members of the same channel.

Proven across POC v0–v9. The schema, algorithms, and API signatures in this document are
implementation-ready.

---

## Setup

The engine is constructed with a `ResolvedConfig` and a `Db` handle:

```typescript
const db     = openDb('sync-state.db');   // ':memory:' for in-process use
const engine = new SyncEngine(config, db);
// optional third argument: webhookBaseUrl string for inbound webhook routing
```

`loadConfig(rootDir)` reads `opensync.json` and the `mappings/` directory and returns
a `ResolvedConfig`. For embedded use, construct `ResolvedConfig` directly:

```typescript
interface ResolvedConfig {
  connectors:    ConnectorInstance[];
  channels:      ChannelConfig[];
  conflict:      ConflictConfig;
  readTimeoutMs: number;               // max ms for a read() call; 30 000 is a safe default
}

interface ConnectorInstance {
  id:         string;
  connector:  Connector;               // loaded connector plugin (default export)
  config:     Record<string, unknown>; // connector-specific config (e.g. { apiUrl: "..." })
  auth:       Record<string, unknown>; // auth credentials — never mixed into config
  batchIdRef: { current: string | undefined };    // always initialise to { current: undefined }
  triggerRef: { current: "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh" | undefined };  // always initialise to { current: undefined }
}

interface ChannelConfig {
  id:               string;
  members:          ChannelMember[];
  identityFields?:  string[];          // canonical field names used for record matching
  identityGroups?:  IdentityGroup[];   // compound identity matching; takes precedence over identityFields
}

interface ChannelMember {
  connectorId:    string;
  entity:         string;              // logical entity name for this channel member (used for watermarks + shadow state keys)
  sourceEntity?:  string;             // connector entity to call read() on; absent = use entity (default); present on array child members
  inbound?:       FieldMappingList;    // source → canonical renames
  outbound?:      FieldMappingList;    // canonical → target renames
  assocMappings?: AssocPredicateMapping[]; // declared association predicates; absent = no associations forwarded
  // Array expansion (specs/field-mapping.md §3.2)
  arrayPath?:          string;        // dotted path to the array column on the parent record
  parentMappingName?:  string;        // name of the parent mapping entry
  parentFields?:       Record<string, string | { path?: string; field: string }>; // parent fields in scope for element mapping
  elementKey?:         string;        // element field used as stable identity key; absent = use index
}

interface FieldMapping {
  source?:    string;                  // omit to use target name as source name
  target:     string;                  // canonical field name
  direction?: "bidirectional" | "forward_only" | "reverse_only";
}

interface ConflictConfig {
  strategy?:            "field_master" | "origin_wins";
  /** Loader-internal — built from `master: true` on field entries in mappings. Not YAML-settable. */
  fieldMasters?:        Record<string, string>;   // field → connectorId
  /** Loader-internal — built from `priority:` on mapping entries. Not YAML-settable. */
  connectorPriorities?: Record<string, number>;   // connectorId → priority (lower wins)
  fieldStrategies?:     Record<string, { strategy: "coalesce" | "last_modified" | "collect" }>;
}
```

The engine creates the SQLite schema on construction (idempotent) and wires each connector
instance with a live `ConnectorContext` — auth, HTTP tracking, state KV store, and webhook
URL are all resolved internally. Callers never call a separate wiring function.

---

## Ingest Loop

`engine.ingest(channelId, connectorId, opts?)` is the primary entry point. It reads all
changed records from one source connector, diffs each record against shadow state, and fans
the accepted changes out to all other channel members.

```
ingest(channelId, connectorId, opts)
  1. Resolve channel + source ChannelMember
  2. Get watermark for (connectorId, entity) — undefined = full sync
  3. Call connector.read(ctx, since) — streams ReadBatch[]
     ├─ If opts.collectOnly: write shadow + provisional canonical; no fan-out → STOP
     └─ Otherwise continue to step 4
  4. For each record:
     a. Strip _-prefixed meta fields.
        If the source member has `arrayPath` (array child member — specs/field-mapping.md §3.2):
          - Write parent `shadow_state` (entity = source entity) and run echo detection at
            the parent level. If parent is unchanged, skip all child expansion for this record.
          - Expand parent record into N child ReadRecords via the array expander.
          - For each child record: derive canonical ID deterministically from parent canonical ID +
            element key (no source-side `linkExternalId` call). Process the child through steps
            b–g below. No source-side shadow_state is written for child records.
        Otherwise: apply inbound field mapping and continue to step b as a single record.
     b. Resolve canonical ID (via identity_map; identityFields matching if configured)
     c. Diff incoming canonical against source shadow_state
     d. If no changes: skip (echo prevention)
     e. Apply conflict resolution against each target's shadow
     f. Fan-out to cross-linked targets only (skip provisionally-only connectors)
        For each target:
          i.   Apply outbound field mapping to produce the target-local delta (`localData`)
          ii.  Target-centric noop: if `localData` matches `written_state` for this
               (connector, entity, canonical), skip dispatch (update only — inserts always proceed).
               Spec: specs/field-mapping.md §7.1
          iii. Look up target's external ID via identity_map (insert if absent)
          iv.  Optionally pre-fetch live record for ETag (connector.lookup())
          v.   Call target.insert() or target.update()
          vi.  On success: write target shadow_state + upsert written_state with `localData`
     g. Atomic commit: write source shadow_state + all target shadow_states +
        identity links + written_state rows + transaction_log entries
  5. Advance watermark for (connectorId, entity) — same transaction as final shadow write
     For array child members: watermark keyed on the child's logical entity name (not the
     inherited source entity). If the source member has `sourceEntity`, the connector is called
     with the inherited source entity but the watermark is stored under `member.entity`.
  6. Log sync_run summary row
```

### Watermark atomicity

The watermark advance and shadow writes are committed in the **same SQLite transaction**
for each batch. A crash cannot produce a watermark ahead of its written shadow state.
On restart, the engine re-reads from the last committed watermark; shadow comparison
suppresses any records already dispatched.

### Fan-out guard

A target connector only receives fan-out if it has at least one **cross-linked** canonical_id
— i.e. a canonical_id shared by more than one connector in `identity_map`. Connectors that
have been collected but not yet linked via `onboard()` / `addConnector()` have only provisional
self-only rows and are silently skipped. This prevents inserting records into a connector that
hasn't completed onboarding and would create duplicates.

### `collectOnly` mode

`ingest(channelId, connectorId, { collectOnly: true })` reads and writes shadow_state but
performs **zero fan-out**. Every record gets a provisional self-only `identity_map` row. These
provisionals are later merged into the shared canonical layer by `onboard()` or `addConnector()`.
`collectOnly` never throws — it is safe to call at any time.

#### Watermark anchoring after `collectOnly` and `onboard`

Watermarks are **opaque strings** — the engine stores and passes them back to connectors
without inspecting their format.

After `collectOnly`, the engine stores `batch.since` **exactly as returned by the connector**.
If the connector returns no `batch.since` (e.g. the source was empty), no watermark is stored.
The next poll will pass `since = undefined`, which triggers a full sync — correct behaviour,
since there was nothing to anchor to.

`onboard` and `addConnector` do **not** write watermarks. Collection status ("has this
connector been ingested") is tracked via `shadow_state` row presence and the `channel_status`
table — not via watermarks. Watermarks are only set by connector reads.

---

## Field Mapping

Field mappings translate between each connector's native field names and the channel's canonical
field names. The canonical form exists only in memory during a sync pass — it is never stored.

### Inbound (source → canonical)

Applied when reading from a source connector before diffing. Fields listed in `inbound` are
renamed; unlisted fields pass through unchanged if no `fields` whitelist is declared, or are
dropped if a whitelist is declared (see config.md).

### Outbound (canonical → target)

Applied before writing to each target connector. Fields listed in `outbound` are renamed back.

### Direction

| `direction`    | Inbound | Outbound |
|----------------|---------|----------|
| `bidirectional` (default) | ✓ | ✓ |
| `reverse_only` | ✗ | ✓ |
| `forward_only` | ✓ | ✗ |

---

## Shadow State

The engine's memory. One row per `(connector_id, entity_name, external_id)`. Tracks each field
individually with provenance.

```typescript
type FieldData = Record<string, FieldEntry>;

interface FieldEntry {
  val:  unknown;   // current value
  prev: unknown;   // previous value (preserved for rollback)
  ts:   number;    // epoch ms when this value was last written
  src:  string;    // connector_id that last wrote this field
}
```

Shadow state serves three purposes:
1. **Echo prevention** — if incoming canonical matches shadow, skip (no-op).
2. **Diff engine** — determines exactly which fields changed and produces the update payload.
3. **Conflict resolution** — each target's shadow is compared against the incoming canonical
   to decide which values to accept.

### Shadow row lifecycle

| Event | Shadow action |
|-------|---------------|
| `collectOnly` ingest, new record | Insert row with provisional canonical_id |
| Normal ingest, no change | Nothing (shadow matches incoming) |
| Normal ingest, changed fields | Update row; write `prev` before overwriting `val` |
| `onboard()` / `addConnector()` | Re-seed: update `canonical_id` to merged value |
| `splitCluster()` | New UUID per connector; shadow rows updated to new canonical_ids |
| Record deleted in source | Set `deleted_at` |

---

## § splitCluster

`splitCluster(canonicalId: string): void`

The inverse of the merge that occurs during `onboard()` / `addConnector()`. Assigns each
connector row in the cluster its own fresh canonical_id so the records are no longer treated
as the same real-world entity.

**Tables updated atomically:**

| Table | Change |
|---|---|
| `identity_map` | Each `(canonical_id, connector_id)` row gets a new unique `canonical_id` |
| `shadow_state` | `canonical_id` updated per-connector to match the new value |
| `written_state` | `canonical_id` updated per-connector |
| `array_parent_map` | `parent_canon_id` re-pointed via child's connector identity |

`transaction_log` is not modified — historical records remain intact under the old
`canonical_id`.

A no-op if the cluster has fewer than two connector members. Logs a structured message
to `console.info` on every successful split.

---

## Diff Engine

A pure function. Compares incoming canonical fields against the existing source shadow.

```
diff(incoming, shadow):
  if shadow is null → action = "insert" for the target (no prior state)
  for each field in incoming:
    if shadow[field] is undefined OR incoming[field] !== shadow[field].val → changed
  if no fields changed → action = "skip"
  otherwise → action = "update"
```

Fields absent from `incoming` but present in `shadow` are **not** treated as deletions.
Sparse updates are valid — the connector only returns what changed.

---

## Conflict Resolution

Conflict resolution runs per-target before dispatch. It compares the incoming canonical
values against the target connector's current shadow to decide which values to actually write.

> Full strategy reference: `specs/channels.md § 3 Resolution Strategies`.

### Global strategies

**Last-write-wins (default)** — if `incoming.ts >= shadow[field].ts`, accept the
incoming value. Otherwise drop it (the target already has something newer).

**`field_master`** — a named connector always wins for declared fields. Other connectors'
updates to mastered fields are dropped. Unmastered fields fall back to LWW.

### Per-field strategies

Declared in `ConflictConfig.fieldStrategies` to override the global strategy for specific fields:

- **`coalesce`** — lower `connectorPriority` number wins; `last_modified` is tiebreaker for equal priority
- **`last_modified`** — equivalent to LWW
- **`collect`** — accumulates values from all connectors into an array

### Configuration

```typescript
interface ConflictConfig {
  strategy?:          "field_master" | "origin_wins";
  /** Loader-internal — built from `master: true` on field entries in mappings. Not YAML-settable. */
  fieldMasters?:      Record<string, string>;    // field → connectorId
  /** Loader-internal — built from `priority:` on mapping entries. Not YAML-settable. */
  connectorPriorities?: Record<string, number>;  // connectorId → priority (lower = wins)
  fieldStrategies?:   Record<string, FieldStrategy>;
}
```

---

## Dispatch

For each accepted change, the engine dispatches to each eligible target:

1. Apply outbound field mapping to produce the target-local delta (`localData`).
2. **Target-centric noop check**: if `localData` matches `written_state` for this
   `(connector_id, entity_name, canonical_id)`, skip the dispatch (updates only).
   First-time inserts are always dispatched. Spec: `specs/field-mapping.md §7.1`.
3. Resolve the target's external ID via `identity_map`. No ID → this is a new record.
4. For connectors that declare `lookup()`: pre-fetch the live record to get its ETag/version
   and (optionally) its full snapshot for full-replace PUT connectors.
5. Call `targetEntity.insert(record)` or `targetEntity.update(record)`.
6. On success: write the target's new `shadow_state` row, any new `identity_map` link,
   and upsert the `written_state` row with `localData`.
7. Emit `record.created` or `record.updated` event on the `EventBus`.
8. Append a `transaction_log` entry (for rollback).

All of steps 6–8 happen inside the per-record atomic commit transaction.

### Deferred records

When a record carries a `Ref` value (or a plain string with `FieldDescriptor.entity` declared)
whose target ID is not yet in `identity_map`, the record is dispatched immediately without
that FK field. A `deferred_associations` row is written so the engine retries the missing
link on the next ingest cycle. Result action is `"defer"` for the retry attempt while the
target is still absent. See `specs/associations.md § 6` for full deferred-edge rules.

---

## Association Propagation

Associations are extracted from `Ref` values (`{ '@id': string; '@entity'?: string }`) embedded
in `ReadRecord.data`, or from plain strings when `FieldDescriptor.entity` is declared in the
connector's schema. The engine remaps each target ID through `identity_map` before writing
remapped plain strings to `data[predicate]` in the target write payload.

See [`specs/associations.md § 6–7`](associations.md) for deferred edges, circular references,
and cross-system remapping.

### Rule 1 — Unknown entity name surfaces as an error

If the entity name (from `@entity` or `FieldDescriptor.entity`) is not registered for this
connector in any channel (e.g. a typo like `"custmers"`), the engine surfaces a record-level
`"error"` action and logs it. It does **not** defer.

Why: deferral means "wait for the target to arrive"; an unknown entity name is a configuration
error that will never self-resolve. Failing loudly surfaces the misconfiguration immediately
rather than silently accumulating deferred rows forever.

- `@id` not yet in identity map → legitimate defer (target record hasn't synced yet)
- entity name unknown → configuration error → `"error"` action

### Rule 2 — Unresolvable target ID is deferred, not an error

When a `Ref['@id']` cannot be resolved in `identity_map` (the referenced record hasn't been
synced yet), the engine dispatches the record immediately without that FK field in the write
payload (eager mode, default). A `deferred_associations` row is written so the engine retries
once the target record is seen in a future ingest cycle.

See `specs/associations.md § 6.1` for eager dispatch semantics and `§ 6.2` for how circular
references between two mutually-referencing new records resolve within two passes.

### Rule 3 — Source-inexpressible predicates are preserved on update

A source connector can only express the predicates it has declared in its `assocMappings`
chain. When it triggers an UPDATE to a target, predicates the source cannot express (e.g.
`secondaryCompanyId` when the source only maps `primaryCompanyRef`) are preserved from the
target's current shadow rather than cleared.

Why: naively overwriting the full association list on every update would silently delete
predicates that other connectors or the user added directly in the target system. Preserving
unknown predicates means updates are additive by default, and only explicitly mapped predicates
are managed by the sync engine. See `specs/associations.md § 8.4`.

---

## Echo Prevention

The shadow diff is itself the primary echo prevention mechanism. When the engine writes a
record to target B, it seeds B's shadow state with the canonical values it just wrote. When B
is later ingested as a source, the incoming canonical for that record matches B's shadow exactly
→ diff produces zero changes → action = `"skip"`. No additional echo set is needed.

---

## Circuit Breaker

In-memory, per-engine instance. Tracks a ring buffer of recent batch outcomes.

```
State machine:
  CLOSED → OPEN:      error rate > threshold after minSamples batches
  OPEN → HALF_OPEN:   resetAfterMs elapsed
  HALF_OPEN → CLOSED: next batch succeeds
  HALF_OPEN → OPEN:   next batch fails
```

When OPEN, `ingest()` aborts before any connector I/O. When HALF_OPEN, one test batch is
allowed through. Default thresholds: 50% error rate, 3 samples, 10 s reset.

---

## Context & Auth

Each connector receives a `ConnectorContext` (ctx) with:

- **`ctx.http`**: tracked fetch — auto-logs to `request_journal`, auto-injects auth headers,
  handles OAuth2 token refresh (mutex to prevent concurrent refreshes).
- **`ctx.state`**: per-connector persistent KV store backed by `connector_state` table.
- **`ctx.webhookUrl`**: base URL for inbound webhooks.
- **`ctx.logger`**: structured logger.
- **`ctx.config`**: static config from `opensync.json`.

### Auth priority order

1. `connector.prepareRequest` defined → call it, skip 2–4.
2. `auth.type === "oauth2"` → inject Bearer token (acquire / refresh via `OAuthTokenManager`).
3. `auth.type === "api-key"` → inject static key as Bearer (or custom header).
4. `auth.type === "none"` → no auth header.

---

## Transaction Log

Every successful write to a target connector appends a row to `transaction_log`:

```
(id, batch_id, connector_id, entity_name, external_id, canonical_id,
 action, data_before, data_after, synced_at)
```

`data_before` is the target's previous `shadow_state.canonical_data`; `data_after` is the new
value. Both are stored as JSON. This is the basis for rollback — see `rollback.md`.

---

## Public API

## Public API

```typescript
// Open (or create) the SQLite database file. Pass ':memory:' for in-process use.
function openDb(path: string): Db

class SyncEngine {
  constructor(config: ResolvedConfig, db: Db, webhookBaseUrl?: string)

  // Primary sync operations
  ingest(channelId: string, connectorId: string, opts?: {
    collectOnly?: boolean;  // collect into shadow without fanning out
    fullSync?:   boolean;   // ignore stored watermark, re-read all records
  }): Promise<IngestResult>

  // Onboarding (see discovery.md)
  discover(channelId: string, snapshotAt?: number): Promise<DiscoveryReport>
  onboard(channelId: string, report: DiscoveryReport, opts?: { dryRun?: boolean }): Promise<OnboardResult>
  addConnector(channelId: string, connectorId: string, opts?: AddConnectorOptions): Promise<AddConnectorReport>

  // Status
  channelStatus(channelId: string): ChannelStatus
  onboardedConnectors(channelId: string): string[]  // connectors with cross-linked canonicals
}
```

```typescript
type ChannelStatus = "uninitialized" | "collected" | "ready";
// uninitialized — no shadow rows exist for this channel
// collected     — shadow rows collected but no cross-linked identity links yet
// ready         — at least one canonical_id is linked across 2+ connectors; incremental polling is active
```

`ingest()` result:

```typescript
// Spec: § RecordSyncResult
type SyncAction = "read" | "insert" | "update" | "skip" | "defer" | "error";

interface RecordSyncResult {
  entity:            string;
  action:            SyncAction;
  sourceId:          string;
  targetConnectorId: string;
  targetId:          string;
  error?:            string;
  // ── Field payload ─────────────────────────────────────────────────────────
  /** READ: source record field values after inbound mapping.  Present for every
   *  non-skip result (one READ per unique sourceId per ingest pass). */
  sourceData?:   Record<string, unknown>;
  /** READ: engine's last known field values for the source record (shadow_state
   *  at the start of this ingest pass, with __-prefixed meta keys stripped). */
  sourceShadow?: Record<string, unknown>;
  /** INSERT/UPDATE: resolved canonical field values written to the target. */
  after?:  Record<string, unknown>;
  /** UPDATE: target's previous field values from shadow_state before the write. */
  before?: Record<string, unknown>;
  // ── Association payload ───────────────────────────────────────────────────
  /** READ: associations on the incoming source record. */
  sourceAssociations?:       Association[];
  /** READ: associations stored in the source shadow before this ingest pass
   *  (parsed from the __assoc__ sentinel). */
  sourceShadowAssociations?: Association[];
  /** INSERT/UPDATE: remapped associations written to the target connector. */
  afterAssociations?:        Association[];
  /** UPDATE: associations stored in the target shadow before the write. */
  beforeAssociations?:       Association[];
}

interface IngestResult {
  channelId:   string;
  connectorId: string;
  records:     RecordSyncResult[];
  snapshotAt?: number;  // collectOnly only — pass to discover()
}
```

### § RecordSyncResult.action semantics

| action | Meaning | Populated fields |
|--------|---------|-----------------|
| `"read"` | Engine read a source record that differs from its last known state (`targetConnectorId` = `""`, `targetId` = `sourceId`). One per unique non-skip `sourceId` per ingest pass. | `sourceData`, `sourceShadow?`, `sourceAssociations?`, `sourceShadowAssociations?` |
| `"insert"` | A new record was written to a target connector. | `after`, `afterAssociations?` |
| `"update"` | An existing target record was updated. | `before`, `beforeAssociations?`, `after`, `afterAssociations?` |
| `"skip"` | No write was needed — incoming data already matches shadow state. | — |
| `"defer"` | Association could not be remapped yet; a deferred row was written for retry. | — |
| `"error"` | A write failed. | `error` |

`sourceData` and `sourceShadow` are populated by the engine using a `fieldDataToRecord` helper
that strips `__`-prefixed meta entries (e.g. `__assoc__`) from `FieldData` and extracts `.val`
from each remaining entry.  `before` is populated from the *target* connector's pre-write shadow
state, not the source shadow.  All four association fields are absent (not `[]`) when there are
no associations — callers can use `?? []` to compare them.

`onboard()` result:

```typescript
interface OnboardResult {
  linked:         number;
  shadowsSeeded:  number;
  uniqueQueued:   number;
  /** Individual fanout INSERT records produced during onboarding.
   *  Each entry carries `action: "insert"`, `sourceId` (source external ID),
   *  `targetConnectorId`, `targetId` (newly assigned ID), and `after` (canonical data). */
  inserts: RecordSyncResult[];
}
```


---

## Rollback

Every successful write to a target connector appends a row to `transaction_log`. This is
the basis for all undo operations. `data_before` is the target's previous
`shadow_state.canonical_data`; `data_after` is the value written. Both are stored as JSON.

> Schema: `specs/database.md § transaction_log`.

Why audit-by-default: the engine makes decisions the user never explicitly approved (field
values, timing, conflict resolution). Without a log, debugging why a field changed is
guesswork. With it, every mutation is traceable to a batch ID and, via `request_journal`, to
the exact API calls that caused it.

### Undo levels

**Single record** — revert the last change to a specific record in a specific connector:

```typescript
// Find the most recent transaction_log entry for this (canonical, connector) pair
// update → push data_before back to the connector
// insert → call entity.delete()
// delete → call entity.insert() with data_before
```

**Batch** — `undoBatch(batchId)` processes all `transaction_log` entries for a batch in
reverse order (last-written first). All connectors that received writes in the batch are
reverted. This is the common use case: "undo the last sync cycle".

**Full channel** — `fullRollback(channelId)` processes the entire transaction log for a
channel in reverse chronological order. Use with caution — this removes all traces of the
engine's involvement in that channel.

### Capability-aware rollback

Not every connector supports every operation. The engine consults the entity's method
presence before attempting each undo step:

| Situation | Engine behaviour |
|-----------|-----------------|
| Target has no `delete` method, action was `insert` | Skip, log reason; undo report marks `skipped` |
| Target has `immutable` fields, action was `update` | Strip those fields from `data_before`; revert the rest |
| Target API returns error during revert | Mark as `failed`; continue with the next record |

```typescript
interface UndoResult {
  canonicalId:    string;
  connectorId:    string;
  action:         'reverted' | 'skipped' | 'failed';
  reason?:        string;
}
```

The engine warns at channel setup (pre-flight) if a target has no `delete` method — full
rollback will be partial for that connector.

### Rollback is itself logged

Rollback operations are mutations. They are written to `transaction_log` too, so the
before/after chain is complete. This means you can undo an undo, though doing so is rarely
useful outside of test scenarios.
