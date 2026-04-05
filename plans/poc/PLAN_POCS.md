# Plan: OpenSync POC Series — All Versions

**Status:** complete — historical  
**Date:** 2026-04-04  

Historical record of all Proof-of-Concept iterations that validated the engine design.
Each phase answers a specific question. Together they form the design history behind the
production specs in `specs/`.

---

| Version | Question answered | Status |
|---------|------------------|--------|
| v0 | Can we sync two systems without infinite loops? | complete |
| v1 | Can N-way sync work with a canonical UUID? | complete |
| v2 | Can config drive topology + field mapping? | complete |
| v3 | Can content hashing replace ID-based echo sets? | complete |
| v4 | Does SQLite + Drizzle give us durable state + circuit breakers? | complete |
| v5 | Can HTTP connectors + request journal + webhooks work? | complete |
| v6 | Can OAuth2 + ETag threading work via prepareRequest? | complete |
| v7 | Can discover + onboard prevent first-sync duplicates? | complete |
| v8 | Can a third system join a live channel safely? | complete |
| v9 | Is ingest-first + DB-backed identity the right final model? | complete |

---


---

# Plan: POC v0 — Minimal Bidirectional Sync (Two Systems)

**Status:** `complete`
**Depends on:** nothing — first POC

---

## Goal

Prove the simplest possible sync loop between two instances of the same connector type.
No conflict resolution, no field mapping, no persistent state beyond a flat file.
The question to answer: can we read from A, write to B, and suppress the echo without infinite
loops?

---

## Problem Statement

A sync engine needs to solve three problems at minimum before it is useful:

1. **Identity** — how does the engine know that record `A:alice-123` and `B:alice-456` are
   the same logical entity?
2. **Incremental reads** — how does the engine avoid re-reading every record on every poll?
3. **Echo prevention** — when the engine writes to B and then reads B, how does it avoid
   mistaking its own write for a new record from B?

This POC addresses all three at their simplest form.

---

## Scope

- Two connector instances: System A, System B — both JSON-files connectors.
- Two entity types: `customers`, `orders` (with FK associations).
- Operations: insert and update, no delete.
- Watermarks: per-instance, per-entity (the `since` field on `read()`).
- Echo prevention: a per-target set of written IDs, consumed on the next reverse read.
- Identity: a flat pairwise key-value map — `identityMap[entity]["A:id"] = b-id`.
- State persistence: `state.json` written to `poc/v0/data/` after each cycle.

Deliberately out of scope: N-way sync, field renaming, conflict resolution, SQLite.

---

## Design

### Identity Map

The pairwise map associates source record IDs to target record IDs:

```
identityMap["customers"]["A:alice-123"] = "alice-456"  // A-id → B-id
identityMap["customers"]["B:alice-456"] = "alice-123"  // B-id → A-id
```

Lookup is O(1). The flat structure works perfectly for exactly two systems.
Its limitation — it cannot represent a record's ID in a third system — is a known
constraint to be addressed in v1.

### Watermarks

Keyed `"instanceId:entityName"` — e.g. `"A:customers"`. On each read, the engine
passes the current watermark as the `since` parameter and updates it from the batch
response. This ensures only changed records are read on subsequent polls.

Known limitation: a shared watermark across multiple targets. If A feeds both B and C,
the same cursor is advanced for both — the target that runs second may miss records the
first already consumed. Addressed in v1 by keying watermarks `"A→B:entityName"`.

### Echo Prevention

After writing a record to B, its ID is added to `echoes["B"]`. When the engine
subsequently reads from B, any ID in the echo set is skipped and the entry removed.

This delete-on-sight design creates a coupling: the echo entry only clears when the
reverse pass runs. If the reverse pass is skipped or crashes, the entry persists and
will suppress the next genuine update from B. Addressed in v3 via content-based detection.

### Test Scenario (4-step narrative)

Tests run as a linear story, each step building on the previous:

1. Insert Alice and an order into A → sync A→B → verify B has both records.
2. Verify B→A produces no changes (echo prevention working).
3. Update Alice's name in A → sync A→B → verify B sees the update.
4. Update Alice's name in B → sync B→A → verify A sees the update.

---

## Known Unknowns Before Running the POC

- Does the jsonfiles connector's watermark behave correctly with the `since` field?
- Does the echo set flush reliably when steps are run in a single test?
- What happens to the identity map on process restart?

---

## Exit Criteria

- [ ] All 4 test steps pass.
- [ ] Process restart causes re-insert (known limitation documented, not fixed).
- [ ] LESSONS.md written.


---

# Plan: POC v1 — N-Way Sync with Canonical UUID Identity

**Status:** `complete`
**Depends on:** v0 POC (complete)

---

## Goal

Fix the fundamental scalability limit of v0's pairwise identity map. Introduce a canonical UUID
per logical record that is shared across all connected systems, then validate that three-way
sync works correctly without any hardcoded pair logic.

---

## Problem with v0

The v0 identity map is:

```
identityMap["customers"]["A:alice-123"] = "alice-456"  // A-id → B-id
```

This is a flat key-value store. With two systems it works. With three systems it breaks:
`"A:alice-123"` can only map to one value, so you cannot store both the B-side ID and the
C-side ID for the same source record.

Adding a third system to v0 requires redesigning the entire identity layer. This is the fix.

---

## Scope

- Three connector instances: System A, System B, System C — all JSON-files connectors.
- Same entity types: `customers`, `orders`.
- N-way sync: every directed pair is synced each cycle.
- Canonical UUID: one UUID per logical record, shared across all connector IDs.
- Directional echo prevention: `echoes[target][source]` — prevents infinite loops while
  allowing correct cascade propagation (A change reaches C via B in the same cycle).
- Directed-pair watermarks: `"A→B:entityName"` — each target advances its own cursor.
- State persistence: same `state.json` pattern as v0.

Deliberately out of scope: field mapping, conflict resolution, SQLite.

---

## Design

### Canonical Identity Map

Replace the flat bidirectional map with a three-level structure:

```
canonical[entity][canonicalId][instanceId] = recordId
externalToCanonical[entity]["A:alice-123"] = "canonical-uuid-abc"
```

One canonical UUID per logical record. Any number of connectors can be linked to it.
Adding a fourth connector requires a new entry under the same canonical UUID — no restructuring.

### Directional Echo Prevention

v0 keyed echoes by target only: `echoes["B"] = Set<id>`.
This meant A-writes to B and C-writes to B shared the same echo bucket.

v1 keys echoes by `[target][source]`:

```
echoes["B"]["A"] = Set<id>   // records A wrote into B
echoes["B"]["C"] = Set<id>   // records C wrote into B
```

When reading B back to A, only look at `echoes["B"]["A"]`. This allows a record written by A
to B to cascade correctly to C — B→C is not suppressed by the A-echo.

### Directed-Pair Watermarks

Rekey from `"A:customers"` to `"A→B:customers"`. The same source can now feed multiple targets
independently, each advancing its own cursor. No under-reads when one target runs ahead of another.

### Test Scenario (4-step narrative, 3 systems)

1. Insert Alice into A → sync all pairs → verify B and C both have Alice.
2. Verify all reverse passes produce no changes (echo prevention for 3 systems).
3. Update Alice in A → sync all pairs → verify B and C both see the update.
4. Update Alice in B → sync all pairs → verify A and C both see the update.

---

## Known Unknowns Before Running the POC

- Does cascade propagation work in a single cycle (A→B→C without an extra cycle)?
- Does the directional echo set prevent all spurious propagation across 3 systems?
- Is per-directed-pair watermark keying correct under all orderings of sync passes?

---

## Exit Criteria

- [ ] All 4 test steps pass with 3 systems.
- [ ] Cascaded changes arrive at C in the same cycle they originate in A.
- [ ] LESSONS.md written.


---

# Plan: POC v3 — Configurable Channels & Field Mapping

**Status:** `done`
**Depends on:** v1 POC (complete)

## Goal

Eliminate all hardcoded wiring from the engine and runner. In v1, the sync topology
(which systems exist, which entities are connected, which fields map to which) is all baked
into `run.ts`. In v3, all of that is expressed in a declarative config object. The engine
consumes configuration at startup; `run.ts` only instantiates and starts it.

A second goal is to introduce field mapping through a **canonical model**. Each channel declares
a canonical field schema; each member declares renames from its local field names into the
canonical names. The engine translates inbound records to canonical form and outbound records
back to each member's local form. Members only need to know about the canonical model — not
about each other — which keeps config linear (N members × 2 mappings) rather than quadratic
(N×(N-1) directed pairs).

Field mapping in v3 is **rename-only**. No split, no merge, no transform functions. That is
sufficient to prove the canonical routing model and keeps the POC scope tight.

Tests remain the authoritative executable specification. Hardcoding is permitted in tests.

## Storage Model

The canonical model is **ephemeral** — it exists only in memory during a single sync pass.
No central copy of data is maintained. Each connector holds its own data in its own format;
the engine's only persistent state is the identity map and per-connector watermarks (carried
over from v1).

The pass for a changed record looks like:

```
read from B  →  apply B.inbound  →  canonical record (in memory)
                                          │
                          ┌───────────────┴──────────────┐
                  apply A.outbound               apply C.outbound
                  patch A                         patch C
```

The canonical record is discarded after the pass. Patch semantics (see below) ensure that
fields owned by other connectors survive untouched on each target.

This is sufficient because v3 has no conflict resolution. When two connectors update the same
canonical field in the same cycle, the last write wins — whichever sync pass runs second
overwrites the first. Proper conflict resolution (field-level masters, shadow state) requires
a persistent central copy and is explicitly out of scope for this POC.

---

## What Changes vs v1

| Area | v1 | v3 |
|------|----|----|
| Connectors | Hardcoded in `run.ts` | Declared in `EngineConfig` |
| N-way channels | Two connectors only | Any number of members per channel |
| Field mapping | None — raw fields pass through | Rename-only, via canonical model |
| Canonical model | Not present | Declared per channel; engine routes through it |
| `run.ts` | Bootstrap + topology | Only reads config and starts engine |
| Tests | Hardcode systems and assertions | Hardcode config and assertions |

---

## Config Shape

A **channel** owns a **canonical schema** — the set of field names the engine uses internally.
Each **channel member** declares two rename maps:

- `inbound` — maps local field names → canonical field names (applied when reading from this member)
- `outbound` — maps canonical field names → local field names (applied when writing to this member)

Unmapped fields pass through under their original name in both directions.

```typescript
/** A rename map: keys are source field names, values are destination field names. */
type RenameMap = Record<string, string>;

interface ChannelMember {
  /** Reference to a ConnectorInstance by its id. */
  connectorId: string;
  /** Entity name in this connector instance (e.g. 'customers'). */
  entity: string;
  /** Rename local fields → canonical fields on read.
   *  Fields not listed are kept as-is. */
  inbound?: RenameMap;
  /** Rename canonical fields → local fields on write.
   *  Fields not listed are kept as-is. */
  outbound?: RenameMap;
}

interface ChannelConfig {
  /** Unique identifier. */
  id: string;
  /** Two or more members. The engine syncs every directed pair via canonical form. */
  members: ChannelMember[];
}

interface EngineConfig {
  connectors: ConnectorInstance[];
  channels: ChannelConfig[];
}
```

---

## Field Mapping Semantics

For each sync pass the engine:

1. Reads a record from the source member (raw local fields).
2. Applies `member.inbound` renames to produce the **canonical record**.
   - Only fields present in the source record appear in the canonical record.
   - Fields not in `inbound` are kept under their original name.
   - The engine never injects fields that were not in the source read.
3. For each other member in the channel, applies that member's `outbound` renames to produce the **local record**.
   - Only fields present in the canonical record appear in the local record.
   - Fields not in `outbound` are kept under their canonical name.
4. Writes the local record to that member via `insert()` or `update()`.
   - `insert()` receives exactly the fields from step 3 — no extras.
   - `update()` receives exactly the fields from step 3 — connectors must **patch** (merge into the existing record), not full-replace.

The source member's `outbound` map and the target member's `inbound` map are never used in the
same pass — `inbound` is for reading, `outbound` is for writing.

## Patch Semantics for `update()`

Because payloads only carry the fields the source explicitly provided, `update()` must be a
**patch** — it merges the incoming fields into the existing record and leaves all other fields
untouched. Full-replace would silently delete fields owned by other connectors in the channel.

The jsonfiles connector already does this correctly (spreads existing record first, then incoming
fields on top). All future connectors must follow the same contract. This is enforced by
convention in the POC; a future API-level safeguard can be added when needed.

Consequence: a connector that calls a full-replace API (e.g. HTTP PUT) must first `lookup()` the
current record and merge locally before writing.

---

## Rename Example: `name` ↔ `customerName`

Connector A calls the field `name`; the canonical model calls it `customerName`.

```typescript
// Connector A member config
{
  connectorId: "A",
  entity: "customers",
  inbound:  { name: "customerName" },   // A's "name"  → canonical "customerName"
  outbound: { customerName: "name" },   // canonical "customerName" → A's "name"
}
```

Connector B already uses `customerName` natively — no rename needed, mappings omitted.

---

## Scenario for `run.ts` and Tests

Three connector instances, one channel. The canonical customer model has `{ customerName }`.

| Connector | Local field | Mapping |
|-----------|-------------|---------||
| A | `name` | inbound: `name → customerName` / outbound: `customerName → name` |
| B | `customerName` | (none — already canonical) |
| C | `fullName` | inbound: `fullName → customerName` / outbound: `customerName → fullName` |

The demo seeds `"Alice Smith"` in connector A as `{ name: "Alice Smith" }`. After one sync cycle:
- Connector B has `{ customerName: "Alice Smith" }`
- Connector C has `{ fullName: "Alice Smith" }`

Editing `customerName` to `"Alicia Smith"` in connector B propagates to `{ name: "Alicia Smith" }`
in A and `{ fullName: "Alicia Smith" }` in C.

Orders have no renames — all three connectors use the same field names — so their member configs
omit `inbound`/`outbound` entirely.

### Complete config

```typescript
const config: EngineConfig = {
  connectors: [connectorA, connectorB, connectorC],
  channels: [
    {
      id: "customers",
      members: [
        {
          connectorId: "A",
          entity: "customers",
          inbound:  { name: "customerName" },       // A reads "name"  → canonical "customerName"
          outbound: { customerName: "name" },       // canonical "customerName" → A writes "name"
        },
        {
          connectorId: "B",
          entity: "customers",
          // B already uses "customerName" — no renames needed
        },
        {
          connectorId: "C",
          entity: "customers",
          inbound:  { fullName: "customerName" },   // C reads "fullName" → canonical "customerName"
          outbound: { customerName: "fullName" },   // canonical "customerName" → C writes "fullName"
        },
      ],
    },
    {
      id: "orders",
      members: [
        { connectorId: "A", entity: "orders" },
        { connectorId: "B", entity: "orders" },
        { connectorId: "C", entity: "orders" },
      ],
    },
  ],
};
```

---

## File Layout

```
poc/
  v3/
    engine.ts        # SyncEngine accepting EngineConfig
    engine.test.ts   # hardcoded config + assertions
    run.ts           # reads a config, starts engine, polls
    data/            # gitignored
      connector-a/
      connector-b/
      connector-c/
```

---

## Work Items

| # | Task |
|---|------|
| 1 | Define `RenameMap`, `ChannelMember`, `ChannelConfig`, `EngineConfig` types in `poc/v2/engine.ts`; rename `ConnectedSystem` → `ConnectorInstance` |
| 2 | Implement `applyRename(data, map)` — pure function, applies a `RenameMap` to a record |
| 3 | Port `SyncEngine` from v1 to accept `EngineConfig`; derive directed pairs from channel members at startup |
| 4 | On read: apply source member's `inbound` map → canonical record |
| 5 | On write: apply target member's `outbound` map → local record before `insert`/`update` |
| 6 | Write `engine.test.ts`: rename passthrough, inbound-only, outbound-only, and full round-trip assertions; 3-connector scenario |
| 7 | Write `run.ts`: declare 3-connector config with `name`/`customerName`/`fullName` renames, seed and poll |


---

# Plan: POC v3 — Content-Based Echo Detection

**Status:** `complete`
**Depends on:** v2 POC (complete)

## Goal

Replace the echo *set* (consume-on-sight, requires all passes every cycle) with a
`lastWritten` *store* (compare-on-read, pass-order independent). This eliminates
the most fragile constraint inherited from v0: that the caller must run all directed
pairs in a single cycle or echoes accumulate silently.

All other v2 mechanics (declarative config, canonical field model, N-way channels,
patch semantics, rename maps) are carried forward unchanged.

---

## The Problem with Echo Sets

The v2 echo set works like this:

```
A→B writes Alice  →  echoes["B"]["A"] = { aliceBId }
B→A reads Alice   →  aliceBId found in set → skip, delete from set
```

The delete-on-sight design creates a coupling between passes: the echo entry only
disappears when the reverse pass runs and encounters it. If anything interrupts the
cycle — a delayed pass, a test that only checks one direction, a crash between
passes — the entry persists and silently suppresses the next genuine change from B.

This is what caused the test failure in v2 step 2: step 1 ran A→B but not B→A,
leaving `aliceBId` in the echo set. When step 2 ran B→A after editing Alice,
the genuine update was swallowed as a stale echo.

---

## The Fix: Content-Based Echo Detection

Instead of tracking IDs, the engine tracks **what it last wrote** to each connector
for each record, in canonical form.

```
lastWritten[connectorId][entityName][recordId] = canonicalData
```

### On write (insert or update to a target connector)

After applying the target member's `outbound` renames to get the local record,
store the canonical record (before outbound renames — i.e. the engine's internal
representation) under the target connector, entity, and the target record's ID:

```typescript
lastWritten["B"]["customers"][aliceBId] = { customerName: "Alice Smith" }
```

### On read (before deciding to propagate)

After applying the source member's `inbound` renames to get the canonical record,
compare it to `lastWritten[sourceConnectorId][entityName][sourceRecordId]`.

- **Match** → this record's canonical fields are identical to what the engine last
  wrote here. It is our own write bouncing back. Skip it (do not propagate).
- **No entry** → never written by the engine. Treat as a genuine source record.
- **Mismatch** → the record has been externally modified since the engine last wrote
  it. Propagate the change.

```
A→B writes { customerName: "Alice Smith" }
  → lastWritten["B"]["customers"][aliceBId] = { customerName: "Alice Smith" }

[some time later, B→A runs]
B→A reads Alice from B → canonical: { customerName: "Alice Smith" }
  → matches lastWritten["B"]["customers"][aliceBId]
  → skip (echo)

[user edits customerName in B to "Alicia Smith"]
B→A reads Alice from B → canonical: { customerName: "Alicia Smith" }
  → does not match lastWritten["B"]["customers"][aliceBId]
  → propagate (genuine change)
  → A→B writes { customerName: "Alicia Smith" }
  → lastWritten["B"]["customers"][aliceBId] = { customerName: "Alicia Smith" }
```

### Why canonical comparison is correct

The comparison uses canonical fields only — not raw local fields. A connector may
add its own metadata on write (a server-assigned ETag, a `modifiedBy` audit field,
a processed timestamp). These will appear in the raw read but not in the canonical
record after `inbound` renames, so they never cause false mismatches.

The `lastWritten` entry is never deleted — it is overwritten on the next write.
This means a delayed or repeated read of the same unchanged record is still
correctly identified as an echo, regardless of how many poll cycles have passed.

---

## Comparison: Echo Set vs lastWritten Store

| Property | Echo set (v2) | lastWritten store (v3) |
|----------|---------------|------------------------|
| Echo recognised after | Same cycle only | Any future cycle |
| Pass ordering required | Yes — all passes same cycle | No |
| Entry lifecycle | Deleted on first sight | Overwritten on next write |
| Handles delayed passes | No | Yes |
| Handles crash between passes | No | Yes (entry persists) |
| Comparison basis | Record ID | Canonical field values |
| Connector-added metadata | Not an issue | Not an issue (canonical only) |

---

## State Shape

```typescript
/**
 * Canonical data last written by the engine to a specific record in a specific
 * connector. Used for content-based echo detection.
 *
 * lastWritten[connectorId][entityName][recordId] = canonicalData
 */
type LastWritten = Record<string, Record<string, Record<string, Record<string, unknown>>>>;
```

This is serialisable and can be included in `EngineState` alongside `identityMap`
and `watermarks`, so echo detection survives process restarts.

---

## Comparison Logic

A shallow equality check over canonical fields is sufficient. Field values come
from JSON-serialisable connector data; reference equality is meaningless. Two
canonical records are equal if they have the same keys and the same values under
`JSON.stringify` with sorted keys (to be order-independent).

```typescript
function canonicalEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const stable = (o: Record<string, unknown>) =>
    JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
  return stable(a) === stable(b);
}
```

---

## What Does Not Change

- `RenameMap`, `applyRename` — unchanged.
- `sync(channelId, fromId, toId)` signature — unchanged.
- State serialisation pattern (`toJSON`/`fromJSON`) — extended to include `lastWritten`.
- Patch semantics for `update()` — unchanged.

---

## Config Style Exploration (inspired by OSI-mapping)

### Background

The [OSI-mapping](https://github.com/BaardBouvet/OSI-mapping) schema uses a clean
three-section structure for integration configuration:

- **`sources`** — connector instances (just identity + primary key, no mapping)
- **`targets`** — the canonical model: field names + per-field resolution strategy
  (`identity`, `coalesce`, `last_modified`, `expression`)
- **`mappings`** — a flat list; each entry wires one connector to one channel via
  explicit field-level mappings (`source: localField`, `target: canonicalField`)

Mappings are first-class citizens, separate from both connector declarations and
channel declarations. This separates three genuinely orthogonal concerns that the
v2 config conflates into a single `ChannelMember` object.

OSI-mapping also introduces several ideas that are directly relevant to opensync's
design gaps:

| OSI-mapping concept | Relevance to opensync |
|---------------------|----------------------|
| `written_state` + `derive_noop` | Directly equivalent to the v3 `lastWritten` store — OSI-mapping solves the same "don't re-propagate what you just wrote" problem via an ETL-maintained table |
| Per-field `direction` (`bidirectional`, `forward_only`, `reverse_only`) | Opensync's `inbound`/`outbound` separate maps achieve the same thing but are harder to read side-by-side |
| Resolution strategies (`coalesce`, `last_modified`) on target fields | Completely absent from opensync — currently last-write-wins with no declared preference |
| `references` on FK fields | Direct equivalent of `_associations` in opensync; OSI-mapping makes FK resolution a first-class field-level declaration rather than a separate array |

---

### Config Style A — Channel-centric (v2, current)

```typescript
const config: EngineConfig = {
  connectors: [connectorA, connectorB, connectorC],
  channels: [
    {
      id: "customers",
      members: [
        { connectorId: "A", entity: "customers", inbound: { name: "customerName" }, outbound: { customerName: "name" } },
        { connectorId: "B", entity: "customers" },
        { connectorId: "C", entity: "customers", inbound: { fullName: "customerName" }, outbound: { customerName: "fullName" } },
      ],
    },
    {
      id: "orders",
      members: [
        { connectorId: "A", entity: "orders" },
        { connectorId: "B", entity: "orders" },
        { connectorId: "C", entity: "orders" },
      ],
    },
  ],
};
```

### Config Style B — Connector-centric

Channels are declared as slots; each connector block owns its participation in
each channel. To answer "what does connector A do?", read only the A block.

```typescript
const config = {
  channels: [
    { id: "customers" },
    { id: "orders" },
  ],
  connectors: [
    {
      id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx),
      channels: {
        customers: { entity: "customers", inbound: { name: "customerName" }, outbound: { customerName: "name" } },
        orders:    { entity: "orders" },
      },
    },
    {
      id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx),
      channels: {
        customers: { entity: "customers" },
        orders:    { entity: "orders" },
      },
    },
    {
      id: "C", ctx: cCtx, entities: connector.getEntities!(cCtx),
      channels: {
        customers: { entity: "customers", inbound: { fullName: "customerName" }, outbound: { customerName: "fullName" } },
        orders:    { entity: "orders" },
      },
    },
  ],
};
```

### Config Style C — OSI-mapping inspired (three sections)

Inspired by OSI-mapping's `sources` / `targets` / `mappings` separation.
Connectors, channels, and field wiring are all declared independently. Field
mappings use explicit `source`/`target` pairs (instead of two separate rename maps)
and support a `direction` flag.

```typescript
const config = {
  // Channels: just named slots. No field declarations yet — opensync doesn't
  // have resolution strategies, but this is where they would live.
  channels: [
    { id: "customers" },
    { id: "orders" },
  ],

  // Connectors: runtime instances only — no mapping info here.
  connectors: [
    { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) },
    { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) },
    { id: "C", ctx: cCtx, entities: connector.getEntities!(cCtx) },
  ],

  // Mappings: flat list — each entry wires one connector to one channel.
  // Fields are explicit pairs; direction defaults to "bidirectional".
  mappings: [
    {
      connectorId: "A",
      channelId: "customers",
      entity: "customers",
      fields: [
        { source: "name", target: "customerName" },
        // direction: "bidirectional" (default) — renamed both ways
      ],
    },
    {
      connectorId: "B",
      channelId: "customers",
      entity: "customers",
      fields: [
        { source: "customerName", target: "customerName" },
      ],
    },
    {
      connectorId: "C",
      channelId: "customers",
      entity: "customers",
      fields: [
        { source: "fullName", target: "customerName" },
      ],
    },
    { connectorId: "A", channelId: "orders", entity: "orders" },
    { connectorId: "B", channelId: "orders", entity: "orders" },
    { connectorId: "C", channelId: "orders", entity: "orders" },
  ],
};
```

### Trade-off comparison

| Property | A: channel-centric | B: connector-centric | C: OSI-inspired |
|----------|--------------------|----------------------|-----------------|
| See all participants in a channel | One place | Must scan connectors | Must scan mappings |
| See all channels for a connector | Must scan channels | One place | Must scan mappings |
| Adding a connector | Edit every channel block | Add one block | Add block + entries |
| Field mapping lives with | Channel | Connector | Mapping (independent) |
| `direction` per field | No (separate maps) | No (separate maps) | Yes (string flag) |
| Config is serialisable (JSON/YAML) | Yes | Yes | Yes |
| Channels and connectors evolve independently | No | No | Yes |

---

### Version Control, Multi-team, and the One-Document Decision

**The config must be plain data in version control.** Connector instances carry
runtime state (auth tokens, HTTP clients, file paths) that clearly belongs in code,
but the *wiring* — which channels exist, which connectors participate, how fields
are named — is configuration. It should live in a YAML or JSON file committed
alongside the project, diffable, reviewable, and editable without a TypeScript
compiler.

**One document, not one-file-per-connector.** The temptation to split config across
files (one per connector, one per channel) seems attractive for large teams but
creates more problems than it solves:

- **Cross-references break locality.** A mapping entry must reference both a
  `connectorId` and a `channelId`. If those are defined in separate files, a
  reviewer must jump between files to verify correctness. In one document the
  full picture is a single scroll.
- **Most open source projects ship one config file.** `docker-compose.yml`,
  `webpack.config.js`, `tsconfig.json`, `.eslintrc`, GitHub Actions workflow files
  — all of these mix concerns that belong to different teams and all deliberately
  stay as one document. The ecosystem has established tooling (diff viewers, schema
  validators, lint rules) around single-file configs.
- **File splitting is opt-in via `$ref` or `include`.** If a project genuinely
  outgrows a single file, YAML anchors or a merge step can compose multiple files
  into one schema-valid document. This is an escape hatch, not the default. The
  schema should be designed for one file; tooling for multi-file composition can
  come later.

**Code review ergonomics for Style C.** Because `connectors`, `channels`, and
`mappings` are separate top-level arrays, a PR that adds a new connector produces
a diff with three clearly scoped additions:

```diff
  connectors:
+   - id: hubspot
+     plugin: "@opensync/hubspot"

  channels:
    - id: customers   # unchanged

  mappings:
+   - connector: hubspot
+     channel: customers
+     entity: contacts
+     fields:
+       - { source: firstname, target: customerName }
```

Compare this to Style A, where adding a connector means inserting into every
channel block — the diff is scattered and the reviewer must mentally re-assemble
the picture.

**Style B has the same review problem, inverted.** Adding a new channel means
editing every connector block. In large deployments with many connectors, this is
the more common operation (channels are stable; connectors come and go).

**Decision: Style C, one document.**

The `opensync.yaml` (or `opensync.json`) file will contain three top-level keys:

```
connectors:  — one entry per connector instance (id, plugin, auth config)
channels:    — one entry per channel (id, canonical field list, resolution rules)
mappings:    — one entry per connector×channel pair (field-level wiring)
```

The engine reads the file, instantiates the connector plugins, and builds the
internal `ChannelMember` representation at startup. Teams editing different
connectors will touch different `mappings` entries and different `connectors`
entries — natural conflict isolation without requiring separate files.

---

### Config file format: YAML

**YAML vs the alternatives:**

| Format | Comments | Multi-line strings | Footguns | Parsing |
|--------|----------|--------------------|----------|---------|
| YAML | ✅ yes | ✅ yes | ⚠️ some (Norway problem, tab/space) | requires `js-yaml` or similar |
| TOML | ✅ yes | ✅ yes | ✅ minimal | requires `@iarna/toml` |
| JSON | ❌ no | ❌ awkward | ✅ none | built-in |
| JSON5 | ✅ yes | ✅ yes | ✅ minimal | requires `json5` |

YAML is the right choice here. Comments are important for a config that multiple
teams edit — anyone adding a connector field mapping should be able to explain
*why* the rename exists inline. YAML is also the dominant format in the ecosystem
that this tool targets (GitHub Actions, Docker Compose, Kubernetes, most CI/CD
tooling), so users will be fluent in it. The parser footguns (Norway problem,
implicit type coercion) are manageable: field names and values in an opensync
config are always strings, so a schema validator catches mistyped values early.

---

### YAML sketch: `opensync.yaml` for the v3 three-connector POC

```yaml
version: "1"

# ─── Connectors ───────────────────────────────────────────────────────────────
# One entry per connector instance.
# "plugin" is the connector package or local path.
# "config" is plugin-specific; its shape is defined by the connector's own schema.
# Secrets should reference environment variables (not inline values).

connectors:
  - id: A
    plugin: "@opensync/jsonfiles"
    config:
      dataDir: ./data/connector-a

  - id: B
    plugin: "@opensync/jsonfiles"
    config:
      dataDir: ./data/connector-b

  - id: C
    plugin: "@opensync/jsonfiles"
    config:
      dataDir: ./data/connector-c

# ─── Channels ─────────────────────────────────────────────────────────────────
# One entry per logical data channel. The channel defines the canonical field
# names; future versions will add resolution strategies here.

channels:
  - id: customers
  - id: orders

# ─── Mappings ─────────────────────────────────────────────────────────────────
# One entry per connector×channel pair. Each entry wires a connector's local
# entity into a channel, with optional per-field rename declarations.
#
# Field direction defaults to "bidirectional". Use "read_only" (read from this
# connector but never write back) or "write_only" (injected on write, never read).
#
# Omitting "fields" means all fields pass through under their local names
# (assumes local names already match the canonical names).

mappings:
  - connector: A
    channel: customers
    entity: customers
    fields:
      # A stores "name"; the canonical field is "customerName"
      - source: name
        target: customerName

  - connector: B
    channel: customers
    entity: customers
    # B already uses "customerName" — no field renames needed

  - connector: C
    channel: customers
    entity: customers
    fields:
      - source: fullName
        target: customerName

  - connector: A
    channel: orders
    entity: orders

  - connector: B
    channel: orders
    entity: orders

  - connector: C
    channel: orders
    entity: orders
```

---

### What stays in code vs. what moves to YAML

| Concern | YAML | Code (`run.ts`) |
|---------|------|-----------------|
| Connector IDs | ✅ | — |
| Plugin name / path | ✅ | — |
| Plugin config (dataDir, etc.) | ✅ | — |
| Channel IDs | ✅ | — |
| Field mappings + direction | ✅ | — |
| Poll interval | ✅ (or env var) | — |
| Auth secrets | ❌ — env var refs | Injected at startup |
| Connector instantiation | — | ✅ plugin loader resolves `plugin:` → JS module |
| Seed data (first-run bootstrap) | — | ✅ |
| Poll loop | — | ✅ |
| Engine + state management | — | ✅ |

The plugin loader is the only new piece of non-trivial code that `run.ts` needs:
given a `plugin:` string, resolve it as either an npm package name
(`@opensync/hubspot`) or a relative path (`./connectors/jsonfiles`), import it,
call `getEntities(ctx)`, and return a `ConnectorInstance`. Everything else in
`run.ts` already exists.
This is the JavaScript equivalent of Java reflection. In Java you'd write
`Class.forName("com.example.HubspotConnector").getDeclaredConstructor().newInstance()`.
In JavaScript/TypeScript it's a dynamic `import()`, which accepts a string resolved
at runtime and returns the module's exports:

```typescript
// Java analogy: Class.forName(plugin) → newInstance() → call method
async function loadConnector(plugin: string): Promise<Connector> {
  // Resolves npm package name or relative path — no compile-time dependency needed.
  const mod = await import(plugin);
  return (mod.default ?? mod) as Connector;
}

async function instantiate(entry: ConfigConnector): Promise<ConnectorInstance> {
  const plugin = await loadConnector(entry.plugin);
  const ctx = buildCtx(entry.config);         // auth, dataDir, etc. from YAML
  return {
    id: entry.id,
    ctx,
    entities: plugin.getEntities?.(ctx) ?? [],
  };
}
```

`plugin.getEntities` is then just a normal function call — same as `run.ts` already
does with the statically-imported connector. The only difference is that the module
was loaded from a string at runtime rather than resolved at compile time via a
static `import` statement. Bun and Node both support dynamic `import()` natively;
no extra dependency is needed.
---

### Design decisions to resolve

1. **`dataDir` vs explicit `filePaths`** — The v2 jsonfiles connector takes a
   `filePaths` array. Exposing a `dataDir` in the config and having the connector
   derive the paths internally is cleaner for the config file, but requires a
   contract change in the connector. The POC can use `filePaths` directly; `dataDir`
   is a future connector improvement.

2. **Env var interpolation syntax** — Secrets should not be committed. Options:
   - `apiKey: ${HUBSPOT_API_KEY}` — shell-style, familiar from Docker Compose
   - `apiKey: !env HUBSPOT_API_KEY` — YAML custom tag
   - A separate `.env` file loaded before config parsing (simplest for the POC)
   
   Shell-style `${VAR}` is the most recognisable and easiest to implement with a
   simple string replacement pass before YAML parsing.

3. **Directed pairs generation** — The v2 `run.ts` hardcodes all N×(N-1) directed
   pairs. With a config, the engine can derive them automatically: for each channel,
   generate a directed pair for every ordered combination of its mapping entries.
   No manual specification needed. This also removes the risk of forgetting a pair.

4. **`version:` field** — Always `"1"` for now. Enables schema evolution later
   without breaking existing files; the loader can reject unknown versions with a
   clear error message.

### Work items

| # | Task |
|---|------|
| 13 | Design and document `opensync.yaml` JSON Schema (Draft 2020-12) for `version`, `connectors`, `channels`, `mappings` |
| 14 | Implement `loadConfig(path)`: read YAML, validate against schema, return typed `OpenSyncConfig` |
| 15 | Implement plugin loader: `plugin:` string → npm package or local path → `ConnectorInstance` |
| 16 | Implement normaliser: `OpenSyncConfig` → `EngineConfig` (internal `ChannelMember[]` representation) |
| 17 | Implement directed-pair auto-derivation from channel membership (replace hardcoded pairs in `run.ts`) |
| 18 | Rewrite `run.ts` to load `opensync.yaml`, wire everything up, run poll loop |
| 19 | Write `poc/v3/opensync.yaml` matching the three-connector POC scenario |

---

## Work Items

| # | Task |
|---|------|
| 1 | Add `lastWritten` to `EngineState`; extend `toJSON`/`fromJSON` |
| 2 | Implement `canonicalEqual(a, b)` — pure function |
| 3 | On write: store canonical record in `lastWritten` after insert/update |
| 4 | On read: compare incoming canonical record to `lastWritten` entry; skip on match |
| 5 | Remove all echo-set machinery (`echoes` map, `_echoSet()`, `toEchoes.add()`, `fromEchoes.delete()`) |
| 6 | Update `engine.test.ts`: remove forced reverse-pass setup from step 1/3; assert detection works across non-contiguous cycles |
| 7 | Add `canonicalEqual` unit tests: equal records, differing value, extra key, key order independence |

---

## Association Propagation Bugs (found in v2)

Exploratory testing of the v2 engine surfaced four distinct bugs in how the engine
handles `_associations`. These should be fixed in v3.

### Bug 1 — Removal is not propagated (`[] → undefined`)

In `sync()`, after `_remapAssociations` returns an empty array, the engine passes
`associations: undefined` to the connector's `update()` call:

```ts
associations: remapped.length > 0 ? remapped : undefined,
```

Connectors treat `undefined` as "field not present in this patch — leave it alone".
So removing all associations from a source record is silently dropped; the target
retains its old associations indefinitely.

**Fix:** distinguish `undefined` (source record had no `_associations` key at all)
from `[]` (source explicitly carries zero associations). Pass `associations: []`
when the source has an empty associations array so connectors can apply the removal.

### Bug 2 — `null` / empty `targetId` defers instead of removing

When a source record nulls out the `targetId` in an association, `_remapAssociations`
calls `lookupTargetId(assoc.targetEntity, ..., null, ...)` which always returns
`undefined` → the record is deferred indefinitely. A null `targetId` is an
explicit disassociation signal, not a missing dependency.

**Fix:** in `_remapAssociations`, treat a falsy `targetId` as an explicit removal
tombstone: emit `{ ...assoc, targetId: null }` (or omit the association) rather
than returning `null` to trigger a defer.

### Bug 3 — Non-existent `targetEntity` defers instead of erroring

An association referencing an entity name that has never been synced (e.g. a typo
like `"custmers"`) also causes `lookupTargetId` to return `undefined` → defer.
The record is silently queued forever and the error is invisible.

**Fix:** separate "not yet in identity map" (legitimate defer) from "entity name
has no canonical entries at all" (configuration error). The latter should surface
as a distinct action (e.g. `"error"`) or throw, not silently defer.

### Bug 4 — Duplicate predicates are replicated verbatim

The engine passes all associations through `_remapAssociations` without checking
for duplicates. If a source record carries two identical `{ predicate, targetEntity,
targetId }` tuples, both are remapped and written to the target, which then also
stores duplicates.

**Fix:** deduplicate associations by `predicate` (last-wins or error) before
remapping, at least as an option. The connector contract should specify whether
multiple associations with the same predicate are allowed.

### Updated Work Items

| # | Task |
|---|------|
| 8 | Distinguish `undefined` vs `[]` associations; pass `[]` to `update()` when source has no associations |
| 9 | Treat falsy `targetId` in an association as an explicit removal — do not defer |
| 10 | Detect unknown `targetEntity` in `_remapAssociations`; surface as `"error"` action rather than defer |
| 11 | Deduplicate associations by `predicate` before remapping |
| 12 | Add `engine.test.ts` cases: remove association, null targetId, unknown entity, duplicate predicate |

---

## `applyRename` Whitelist Semantics (fixed in v2, carry forward)

The original `applyRename` iterated source fields and fell back to `map[key] ?? key`,
passing any field not present in the rename map through unchanged. This caused
connector-local fields (e.g. a `foo` field only meaningful to connector A) to leak
into canonical form and be written verbatim to every other connector.

**Fix (applied in v2):** when a map is provided, iterate the map entries rather than
the source fields. Only fields explicitly listed in the map are included in the
output; all others are silently dropped. When no map is provided the existing
pass-through behaviour (`{ ...data }`) is preserved, which is correct for channel
members with no renaming needs (e.g. orders).

```typescript
// Before (leaks unmapped fields)
for (const [key, value] of Object.entries(data)) {
  result[map[key] ?? key] = value;
}

// After (whitelist)
for (const [srcKey, dstKey] of Object.entries(map)) {
  if (Object.prototype.hasOwnProperty.call(data, srcKey)) {
    result[dstKey] = data[srcKey];
  }
}
```


---

# Plan: POC v4 — SQLite State Layer + Log Surfaces

**Status:** `planned`
**Depends on:** v3 POC (complete)

## Goal

Replace the in-memory JSON state blob with a real SQLite database. Validate the Drizzle adapter
pattern in practice, establish the minimal schema needed to run the engine, and investigate which
log surfaces are essential vs. deferred.

This is a foundations POC — not yet the full production engine. The goal is to answer concrete
questions about the data layer before building on top of it.

---

## What v3 Left Behind

v3 stores all state in a single `data/state.json` file:

```json
{
  "identityMap": { "<canonicalId>": { "<connectorId>": "<externalId>" } },
  "watermarks":  { "<connectorId>": { "<entityName>": "<since>" } },
  "lastWritten": { "<connectorId>": { "<entityName>": { "<externalId>": { ...canonical } } } }
}
```

This works for a single process with no concurrent access. It breaks when:
- Multiple processes need to read/write state (daemon + CLI commands like `status`, `inspect`)
- State becomes large enough that loading the whole blob on every poll is a problem
- We need queryable structure (e.g. "show me all records from connector A in channel X")

---

## The Minimal Runtime Schema

The v4 engine needs **four** tables. Three replace `state.json`; the fourth (`shadow_state`) is
the core architectural addition that enables hub-and-spoke.

### `identity_map`

```sql
CREATE TABLE identity_map (
  canonical_id    TEXT NOT NULL,
  connector_id    TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  PRIMARY KEY (canonical_id, connector_id),
  UNIQUE (connector_id, external_id)
);
```

Replaces: `state.identityMap`

### `watermarks`

Per source connector per entity — **no longer per directed pair**.

```sql
CREATE TABLE watermarks (
  connector_id  TEXT NOT NULL,
  entity_name   TEXT NOT NULL,
  since         TEXT NOT NULL,
  PRIMARY KEY (connector_id, entity_name)
);
```

Replaces: `state.watermarks` (v3 keyed by `"fromId→toId:entity"`, v4 by `"connectorId:entity"`)

### `shadow_state`

Local copy of every record as last seen from each source connector, in canonical form. This is
the central hub: all reads diff against it; all writes update it.

```sql
CREATE TABLE shadow_state (
  connector_id    TEXT NOT NULL,
  entity_name     TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  canonical_id    TEXT NOT NULL,
  canonical_data  TEXT NOT NULL,   -- JSON blob
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (connector_id, entity_name, external_id)
);
```

Replaces: `state.lastWritten`. Also makes it queryable — you can see the current state of every
record in every connector without reading from the live APIs.

### `connector_state`

Per-connector persistent key-value store. Powers `ctx.state`.

```sql
CREATE TABLE connector_state (
  connector_id  TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,   -- JSON
  PRIMARY KEY (connector_id, key)
);
```

---

## The Hub-and-Spoke Loop (architectural shift from v3)

v3 iterates **directed pairs** — each source is read once per target:

```
A→B  read A, write B   ← A read twice if there's also A→C
A→C  read A, write C
B→A  read B, write A
...
```

v4 iterates **sources** — each source is read once per cycle, changes fanned out to all targets:

```
ingest(channel, A)   read A once → Δ_A → write to B, write to C
ingest(channel, B)   read B once → Δ_B → write to A, write to C
ingest(channel, C)   read C once → Δ_C → write to A, write to B
```

Echo detection: after writing Δ_A to B, update `shadow_state[B]` with the canonical data.
When B is ingested next cycle, its records are diffed against `shadow_state[B]` — if the data
matches what was just written, it's an echo and is skipped. Same semantics as v3 `lastWritten`,
different structure.

The engine's public API changes from `sync(channelId, from, to)` to `ingest(channelId, connectorId)`.
`run.ts` iterates each channel member once rather than each directed pair.

---

## Log Surfaces to Investigate

Not all log surfaces have equal urgency. v4 should validate two and defer the rest.

### Surface 1: Transaction Log (validate in v4)

Every record written to a connector is logged. This is what enables rollback and `opensync inspect`.

```sql
CREATE TABLE transaction_log (
  id            TEXT PRIMARY KEY,          -- uuid
  batch_id      TEXT NOT NULL,             -- groups all writes in one sync cycle
  connector_id  TEXT NOT NULL,
  entity_name   TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  canonical_id  TEXT NOT NULL,
  action        TEXT NOT NULL,             -- 'insert' | 'update' | 'delete'
  data_before   TEXT,                      -- JSON, null for inserts
  data_after    TEXT,                      -- JSON, null for deletes
  synced_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

**Why validate now:** The engine already produces this data as `RecordSyncResult` — we just need
to persist it. Adding it in v4 proves the write path and gives us something to query immediately.
The `batch_id` concept (grouping a full cycle's writes) is essential for rollback and should be
validated early.

### Surface 2: Sync Run Log (validate in v4)

One row per poll cycle. Lightweight — just totals and timing.

```sql
CREATE TABLE sync_runs (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT NOT NULL,              -- same batch_id as transaction_log entries
  channel_id    TEXT NOT NULL,
  from_connector TEXT NOT NULL,
  to_connector  TEXT NOT NULL,
  inserted      INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  deferred      INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL
);
```

**Why validate now:** This is what `opensync status` reads. Without it, the CLI has no history.
It's trivially cheap to write (one INSERT per directed pair per cycle) but answers the most
immediately useful question: "is this working?"

### Surface 3: Request Journal (defer to future POC)

Logs every outbound HTTP call. Not relevant yet — the jsonfiles connector makes no HTTP calls.
Schema is already specified in `specs/observability.md`. Validate when building a real HTTP
connector (HubSpot, Fiken).

### Surface 4: `ctx.state` (validate in v4)

Per-connector persistent key-value store. Currently a stub `{}` in the POC. Real connectors need
it for OAuth tokens, resumable cursors, and pagination state.

```sql
CREATE TABLE connector_state (
  connector_id  TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,   -- JSON
  PRIMARY KEY (connector_id, key)
);
```

**Why validate now:** Any real connector will use this. If it doesn't work cleanly in the engine's
`ConnectorContext`, we'll find out before we've built connectors that depend on it.

---

## Other Surfaces to Investigate in v4

These aren't SQLite tables but are open questions that v4 should resolve or at least touch:

### Deletion handling

v3 has no concept of a record being deleted at the source. The `read()` interface returns changed
records since a watermark — it doesn't signal removals. Options:
- Periodic full-scan diff against `identity_map` (expensive but simple)
- Connector-side tombstone: a record with `_deleted: true` in the batch
- Soft-delete flag in `identity_map` itself

This needs a decision before the transaction log can be considered complete (deletes need `data_before`).

### Error recovery per record

v3 crashes the cycle if any connector call throws. Real behaviour should be:
- Connector-level errors: log to `sync_runs.errors`, skip that record, continue the cycle
- This is the v3 `"error"` action extended to include persistence

### Config validation (Zod)

`openlink.json` and mappings are currently loaded and cast with `as`. Zod schemas should be
validated at startup so the engine refuses to start on bad config with a clear message. v4 is the
right place to establish this pattern.

### Full sync mode

Ignoring watermarks and re-processing everything. Needed for onboarding (first run against an
existing dataset) and for recovery. Simple to implement: pass `undefined` as `since` to all
`read()` calls, don't update watermarks until the full scan completes successfully.

---

## The Drizzle Adapter Question

v4 will validate whether `openDb()` (the dual-driver adapter from `specs/database.md`) works in
practice. Specifically:

- Does Drizzle's `BaseSQLiteDatabase` type actually serve as a clean seam between `bun:sqlite` and
  `better-sqlite3`?
- Are there API differences in transaction semantics, WAL mode configuration, or RETURNING clause
  support that the adapter needs to paper over?
- Is Drizzle's overhead worth it vs. raw SQL for the POC? (Hypothesis: yes for the identity map
  queries; possibly no for the bulk `last_written` upserts.)

---

## What v4 Is NOT

- Not a full production schema — `connector_instances`, `sync_channels`, `oauth_tokens` etc. are
  in the spec but out of scope here. v4 uses connector IDs as plain strings (same as v3) rather
  than FK-linked rows.
- Not a job queue — `sync_jobs` is deferred. v4 still runs the poll loop inline.
- Not a webhook handler.
- Not the CLI binary — v4 is still a `bun run poc/v4/run.ts` script.

---

## Work Items

1. `openDb()` implementation — dual-driver adapter, `bun:sqlite` + `better-sqlite3` paths
2. Schema bootstrap — `CREATE TABLE IF NOT EXISTS` for all 6 tables on startup
3. Port identity map reads/writes to SQLite (`identity_map` table)
4. Port watermarks to SQLite — key changes from `"from→to:entity"` to `"connectorId:entity"`
5. Replace `lastWritten` with `shadow_state` table
6. Rewrite engine core: `sync(channelId, from, to)` → `ingest(channelId, connectorId)`
   - Read source once; diff each record against `shadow_state[source]`
   - Fan out Δ to all other channel members
   - Update `shadow_state[target]` after each write (echo prevention)
7. Remove `toJSON()` / `fromJSON()` / `data/state.json` serialisation (replaced by DB)
8. Add `batch_id` generation per cycle (UUID); pass through to log writes
9. Transaction log writes after each insert/update (action, data_before, data_after, batch_id)
10. Sync run log writes — one row per `ingest()` call (inserted, updated, skipped, errors)
11. Implement `ctx.state` via `connector_state` table
12. Zod validation for `openlink.json` and mapping files at load time
13. Per-record error recovery — catch connector throws, log, continue cycle
14. Full sync mode — `--full` flag, bypass watermarks, re-ingest everything
15. Update engine tests — use in-memory SQLite (`:memory:`), cover new ingest() API
16. Copy v3 config files (`openlink.json`, `mappings/`) into `poc/v4/`

---

## Open Questions

- **Drizzle vs raw SQL for v4?** Raw SQL keeps the POC lean; Drizzle matches the target
  architecture. Lean towards Drizzle with raw fallback for bulk upserts if needed.
- **`better-sqlite3` vs `bun:sqlite` as the dev default?** `bun:sqlite` works immediately in the
  POC (no native install). Switch to `better-sqlite3` when testing the Node path.

---

## v4 Expansion: Hardening the Foundation for Actions, Safety, Rollback, and Data Access

The POC trajectory (v1–v6) is solid for auth and HTTP. However, there are four structural
decisions that need to be validated *before* building actions, discovery, safety, and rollback —
changes to any of these after the fact would require redoing the foundation.

---

### Critical Gap: Field-Level Shadow State

v4's `shadow_state` stores `canonical_data` as a flat JSON blob. The spec defines field entries as:

```typescript
interface FieldEntry { val: unknown; prev: unknown; ts: number; src: string; }
type FieldData = Record<string, FieldEntry>;
```

Almost nothing else works without this structure:

| Feature | Why it needs `{ val, prev, ts, src }` |
|---|---|
| Rollback | `prev` to revert a field; `src` to identify who wrote it |
| Conflict resolution (field_master / LWW) | `src` per field (who owns it); `ts` per field (what's newer) |
| Data access queries | "Who last changed email?" needs `.src` and `.ts` per field |
| Actions `FieldDiff[]` | The changes array in emitted events carries per-field `oldValue`/`newValue` |
| External change detection | "I didn't write this" requires comparing `src` against the outbound log |

**If the shadow_state schema stays as a flat blob past v4, migrating it will break everything
built on top.** This must be resolved before v5.

**Questions to answer:**
- Does `{ val, prev, ts, src }` per field fit cleanly in SQLite as a JSONB blob, or does each
  field need its own row? (Hypothesis: blob is fine; per-row is more queryable but overkill for now.)
- Do the diff and echo-detection algorithms still read naturally with the new shape?
- Does the `data_before` / `data_after` in `transaction_log` change shape when shadow_state is field-level?

---

### Structural Pipeline Hook 1: Event Emission (Actions)

Actions require `eventBus.emit()` to fire after every successful dispatch. The correct position
in the ingest loop is:

```
read → diff → resolve → dispatch → emit('record.created' | 'record.updated') → update shadow
```

The hook is cheap to add, but it must emit with the correct shape:
- `entityId` (canonical UUID)
- `sourceInstanceId`
- `changes: FieldDiff[]` — which fields changed and their old/new values (only possible with field-level shadow)
- `data` — full canonical record at the time of emission

**Validate in v4 expansion:** stub an `EventBus` that collects emitted events; write a test that
asserts a 3-connector sync emits the right events with the right `FieldDiff[]` payload. Nothing
should subscribe yet — just verify the emission contract is correct.

---

### Structural Pipeline Hook 2: Conflict Resolution

v4 currently applies implicit LWW — last ingest wins. The spec places an explicit resolution step
between diff and dispatch:

```
diff → resolveConflicts(changes, shadow, config) → dispatch
```

With field-level shadow state in place this slot is straightforward to fill: `src` and `ts` per
field give LWW all it needs, and `field_master` is a simple config lookup. Without field-level
shadow, conflict resolution has nowhere to get per-field provenance from.

**Validate in v4 expansion:** a test with two connectors that both update the same field in the
same cycle. Verify that LWW picks the higher timestamp and that a `field_master` rule can override
it regardless of timestamp.

---

### Structural Pipeline Hook 3: Circuit Breaker Pre/Post-Flight

The circuit breaker must wrap the dispatch loop, not individual calls:

```typescript
// before processing a batch:
const state = await breaker.evaluate(batchSize, errorCount);
if (state === 'TRIPPED') return; // or throw, depending on strategy

// dispatch each record...

// after dispatch:
await breaker.recordOscillations(changedFields);
```

If the ingest loop isn't designed with this wrapping point, the circuit breaker has to reach into
the loop internals to intercept it.

**Validate in v4 expansion:** a simple in-memory `CircuitBreaker` stub (no DB yet); a test that
trips the breaker on a volume threshold mid-batch and asserts that the batch stops cleanly and
that shadow state is consistent (no partial writes for the tripped records).

---

### What Doesn't Threaten the Foundation

These can be added later without structural pipeline changes, as long as the above three are solid:

- **Idempotency** — a hash check inserted at the start of `ingest()` before the read loop;
  no loop changes required.
- **Soft delete detection** — mark-and-sweep runs after the full-sync read; entirely outside
  the main dispatch loop.
- **Discovery / matching** — a pre-sync step that populates `identity_map` before any ingest
  runs; no pipeline changes.
- **Rollback** — reads `transaction_log` and calls `connector.upsert` / `connector.delete` in
  reverse; no changes to the ingest path itself.
- **Data access** — direct SQLite queries against `shadow_state`; zero pipeline changes.
- **Full transform engine** — inbound rename maps already exist as a slot; expanding to arbitrary
  `TransformFn` is purely additive.

---

### Additional Work Items (v4 Expansion)

17. Migrate `shadow_state.canonical_data` from flat JSON blob to field-level `{ val, prev, ts, src }` per field; update diff, echo detection, and transaction log accordingly
18. Stub `EventBus` with `emit()` + `on()`; wire emission after each successful dispatch
19. Add `resolveConflicts()` between diff and dispatch; test LWW and `field_master` strategies
20. Add `CircuitBreaker` stub with volume threshold; wire pre/post-flight around the dispatch loop; test tripping stops the batch cleanly
- **`batch_id` granularity** — one per full poll cycle or one per directed pair? One per pair
  makes rollback more surgical but creates more rows. One per cycle is simpler. Start with one per
  cycle.
- **`last_written` upsert performance** — each sync cycle updates one row per synced record. With
  large datasets this is the hot path. Worth benchmarking raw `INSERT OR REPLACE` vs Drizzle's
  `onConflictDoUpdate`.

---

## v4 Validation: OSI-Mapping Primitive Foundation Probes

See [specs/osi-mapping-primitives.md](../specs/osi-mapping-primitives.md) for the full catalog of
50 primitives from OSI-mapping and their current foundation status in OpenSync.

Of the 28 gaps identified, most are **additive** — nested arrays, filters, routing, vocabulary
targets, inline tests, tombstones, normalize — none require structural changes to v4's pipeline,
schema, or conflict model.

Three gaps are **structural risks**: if left unproven now, implementing them later would require
rearchitecting components that other features will already be built on top of.

---

### Probe 1: Field-Value Identity Matching

**Risk:** `_getOrCreateCanonical()` always allocates a new UUID for an unknown `(connectorId, externalId)` pair. OSI-mapping's `identity` strategy links records when they *share a field value* (`email` matches across two sources → same entity), not when the connector reports an explicit association. If `shadow_state` can't be efficiently queried for canonicalId-by-field-value, or if merging two canonical IDs into one (repointing all rows) requires restructuring the identity schema, that is a fundamental blocker.

**What to validate:** Add `identityFields: string[]` to `ChannelConfig`. During ingest, before
`_getOrCreateCanonical()`, query `shadow_state` for any row in *another* connector with matching identity field values. If found, link the incoming `(connectorId, externalId)` to the *existing* canonical UUID rather than allocating a new one.

The probe must also cover the **merge case**: two canonical UUIDs are discovered to represent the same entity (because their identity fields match). Repoint all `identity_map` rows from one UUID to the other and verify no shadow_state rows are orphaned.

**SQL query at the core:**
```sql
SELECT canonical_id
FROM shadow_state
WHERE entity_name = ?
  AND connector_id != ?
  AND JSON_EXTRACT(canonical_data, '$.' || ?) = ?
LIMIT 1
```

**Acceptance:** A test with two connectors where neither reports an association — they share an `email` field value. After ingesting both, they must resolve to the same canonical ID. The transaction log must show one entity, not two.

---

### Probe 2: Per-Field Resolution Strategies

**Risk:** `ConflictConfig` is a single global strategy for the entire channel. `FieldData` already stores `{ val, src, ts }` per field — the raw material for `coalesce` (compare priority) and `last_modified` (compare ts). The question is whether `resolveConflicts()` can be extended with per-field strategy declarations without restructuring its signature or the shadow schema. If `FieldData` is missing information that a strategy needs (e.g. `priority` is nowhere in shadow state), or if the resolver's interface can't be extended without breaking callers, the design is wrong.

**What to validate:** Extend `ConflictConfig` with:
```typescript
fieldStrategies?: Record<string, 
  | { strategy: "coalesce"; priority: number }
  | { strategy: "last_modified" }
  | { strategy: "collect" }
>
```
Wire through `resolveConflicts()`. Implement `coalesce` (lower `priority` number wins, with `last_modified` as tiebreaker) and `last_modified` (higher `ts` wins). `collect` can return an array of all source values — just proves the resolver can return something other than a scalar.

**Acceptance:** A test with three connectors, two conflicting on a `coalesce` field (different priorities) and two conflicting on a `last_modified` field (different timestamps). Correct winner chosen for each. A `collect` field accumulates all three values. The rest of the engine (shadow update, transaction log, dispatch) handles the collected array without changes.

---

### Probe 3: Field-Level Direction Control

**Risk:** `ChannelMember.inbound` and `outbound` are `Record<string, string>` (whitelist rename maps). OSI-mapping requires each field to declare `direction: "forward_only" | "reverse_only" | "bidirectional"` — critical for constant injections (fields with no source, contributed only during the forward pass) and reverse-only fields (written to a target but never read back). If the config type stays as `RenameMap`, adding direction later forces a breaking rename of the config shape and changes to every caller of `applyRename`.

**What to validate:** Replace `RenameMap = Record<string, string>` with:
```typescript
interface FieldMapping {
  source?: string;           // source field name (omit for constants)
  target: string;            // target field name
  direction?: "bidirectional" | "forward_only" | "reverse_only";  // default: bidirectional
  expression?: string;       // constant or transform expression (placeholder — not evaluated yet)
}
type FieldMappingList = FieldMapping[];
```
Update `applyRename` to accept `FieldMappingList` and respect direction. During forward dispatch (source → target), skip `reverse_only` fields. In any future reverse path (target → source), skip `forward_only` fields. The `expression` field on a `forward_only` mapping with no `source` is not evaluated yet — just assert it is preserved in the config and ignored at runtime.

**Acceptance:** A test where a `forward_only` constant field (`type: "customer"`) appears in the target's received record but is *not* echoed back when the target connector is later ingested. A `reverse_only` field moves in the opposite direction only. A `bidirectional` field moves both ways as before. `applyRename` existing tests must still pass after the type change.

---

### Additional Work Items (v4 OSI Probes)

21. Probe 1 — field-value identity: add `identityFields` to `ChannelConfig`; query `shadow_state` for match before allocating canonical UUID; test merge of two canonical IDs
22. Probe 2 — per-field strategies: extend `ConflictConfig` with `fieldStrategies`; implement `coalesce`, `last_modified`, `collect` in `resolveConflicts()`; test all three in one cycle
23. Probe 3 — field direction: replace `RenameMap` with `FieldMapping[]`; update `applyRename`; test forward_only/reverse_only/bidirectional separation

---

## Foundation Must-Fixes

Three issues identified during the gap analysis against grove/in-and-out that need to be addressed
in v4, not deferred. All other gaps from that analysis are additive and can be bolted on later.

### Fix 1: Watermark atomicity

**Problem:** In `engine.ts`, `dbSetWatermark` is called at the end of `ingest()` *after* the
dispatch loop completes — in a separate statement from the `dbSetShadow` / `dbLogTransaction`
calls inside the loop. A crash between the last `dbSetShadow` and `dbSetWatermark` advances the
watermark past data that was never committed to shadow state, causing those records to be silently
skipped on the next run (permanent data loss).

**Fix:** Wrap the entire per-source write block — from the first `dbSetShadow` call through to
`dbSetWatermark` — in a single `db.transaction(...)`. Shadow updates, transaction log entries,
and the watermark advance must all commit together or not at all.

**Why now:** The scheduler, daemon mode, and concurrency control will all be built on top of the
current call sequence. Retrofitting atomicity once those layers exist is significantly more
disruptive than fixing it now.

### Fix 2: `deleted_at` missing from `shadow_state` schema

**Problem:** `specs/database.md` specifies `deleted_at TEXT` on `shadow_state`. The POC schema
in `poc/v4/db.ts` omits it. Without this column the reconcile step cannot distinguish between
"record not returned this cycle → candidate for deletion" and "record that was previously
tombstoned and has now reappeared with the same `external_id`" (soft-delete resurrection). The
diff logic will treat a returning record as a second insert rather than a resurrection.

**Fix:** Add `deleted_at TEXT` (nullable) to the `shadow_state` bootstrap DDL. Update
`dbSetShadow` to accept and persist the value. Add a corresponding resurrection check in the
ingest reconcile path: if `shadow.deleted_at IS NOT NULL` and the record appears again, treat
it as an update (clear `deleted_at`, apply new data) rather than a duplicate insert.

**Why now:** This is a schema change. Adding a column to a live schema requires a migration;
in the POC, `bootstrap()` runs `CREATE TABLE IF NOT EXISTS` so the column will only be added
to fresh databases. Fixing it now avoids having to write and test a migration in a later POC
phase.

### Fix 3: Extract `dispatchWrite` as a named seam

**Problem:** The write path in `ingest()` is inline — conflict resolution, shadow state update,
transaction log, and the connector `.upsert()` call are woven together in the same function
body. Two upcoming foundation requirements (pre-flight read for write-anomaly protection, and
per-record write ordering) both need to wrap the connector write call. If the dispatch step
sits inside a loop with no clean boundary, adding those wrappers requires surgery on the
engine's hottest path.

**Fix:** Extract the block that calls `connector.upsert()` / `connector.delete()`, updates
shadow state, and writes the transaction log entry into a standalone `dispatchWrite(db, target,
record, canonId, ...)` function. The loop calls this function; the function has a clear
before/after boundary where a pre-flight read hook and an ordering guard can slot in without
touching loop logic.

**Why now:** This is pure refactoring with no behaviour change — the correct time to do it is
before adding any logic that depends on the seam existing.


---

# Plan: POC v5 — HTTP, Webhooks, and Request Journal

**Status:** `planned`
**Depends on:** v4 POC (SQLite state layer)

## Goal

Validate the HTTP surface: `ctx.http`, the request journal, auth injection, and the webhook
receive-and-queue flow. Introduce a real HTTP connector (a local mock API server) so these
surfaces can be exercised with actual network calls.

The jsonfiles connector is deliberately I/O-only — it makes no HTTP calls and has no auth. v5
is the first POC where the engine touches a network, which surfaces a different class of
problems: latency, failures, retries, credential management, and webhook delivery timing.

---

## The Test Target: A Local Mock API Server

Rather than wiring to a real SaaS (credentials, rate limits, data risks), v5 introduces a small
local HTTP server that behaves like a real API. This is the `mock-crm` connector referenced in the
overview spec.

The mock server exposes:
- `GET  /contacts?since=<iso>`   — poll for changed contacts (returns JSON array)
- `POST /contacts`               — create a contact, returns `{ id, ... }`
- `PUT  /contacts/:id`           — update a contact
- `POST /webhooks/subscribe`     — register a webhook URL
- `DELETE /webhooks/:id`         — deregister
- Test-only: `POST /__trigger`   — manually fire a webhook to the registered URL

Auth: static `Authorization: Bearer <token>` header (API key pattern, simplest possible).

The server runs in-process during tests (`Bun.serve` or Hono) and is started/stopped per test
suite. No external process needed.

---

## What v5 Validates

### 1. `ctx.http` wrapper

The engine injects a `ctx.http` function into every connector. It wraps `fetch()` with:
- Auth header injection (from `ctx.config.apiKey` or token manager)
- Automatic logging to the request journal (before + after each call)
- Credential masking in the journal (API keys, bearer tokens never appear in plain text)

v5 answers:
- Does the `ctx.http` interface feel right for connector authors?
- Does masking work — can we verify the journal row never contains the raw token?
- How do we handle non-2xx responses — throw, or return with status?

### 2. Request Journal

The first time the journal is populated with real data. Every `GET /contacts` poll and every
`POST /contacts` write should produce a row:

```
connector_id | method | url                     | status | duration_ms | request_body | response_body
mock-crm     | GET    | http://localhost:4000/… | 200    | 12          | null         | [{"id":…}]
mock-crm     | POST   | http://localhost:4000/… | 201    | 8           | {"name":…}   | {"id":"xyz"}
```

Questions to resolve:
- Full response body, or truncated? (GDPR / size tradeoff)
- Should request bodies be stored? (outbound mutations expose the data being written)
- How do we correlate a journal row to the `transaction_log` row it produced?

### 3. Webhook Receive-and-Queue

The engine runs a lightweight HTTP server on a local port. The mock API calls that URL when
contacts change.

Flow to validate:
1. Mock API server fires `POST /webhooks/<connectorId>` to the engine's webhook server
2. Engine writes raw payload to `webhook_queue` immediately, responds `200`
3. Webhook processor dequeues, calls `connector.handleWebhook(req, ctx)`
4. Normalized records enter the sync pipeline (same path as polled records)

Questions to resolve:
- Should the webhook server and the poll loop run in the same process or different?
  (Hypothesis: same process, different async tasks — simpler, no IPC needed for POC)
- How does the engine's webhook URL get communicated to the connector's `onEnable()`?
  (`ctx.webhookUrl` is the answer — validate it feels natural to use)
- What happens if the engine is down when a webhook arrives? The mock server queues it and
  retries — but the engine has no queue on its side either. For the POC, just test the
  happy path; retry semantics are a v6+ concern.

### 4. Thin vs Thick Webhooks

The mock connector will implement both patterns to validate the interface:
- **Thick**: webhook payload contains the full contact — `handleWebhook()` just normalises it
- **Thin**: webhook payload contains only `{ id, event }` — `handleWebhook()` calls `ctx.http`
  to fetch the full record

This matters because thin webhooks add API calls to the journal, which tests the correlation
between webhook processing and request journal entries.

### 5. Auth Injection

`ctx.http` should transparently inject the API key on every request. The connector itself never
reads `ctx.config.apiKey` directly in its `read()`/`insert()`/`update()` methods.

Test: verify all journal rows for the mock-crm connector have the `Authorization` header present
but redacted in the stored `request_headers`.

---

## Surfaces Explicitly Out of Scope for v5

- **OAuth2** — session token and API key patterns are sufficient. OAuth adds token refresh, lock
  contention, and redirect flows. That's a dedicated POC.
- **`prepareRequest` hook** — HMAC signing, session tokens. Deferred.
- **Webhook signature validation** — the mock server signs nothing. Test the happy path only.
- **Retry / exponential backoff** on failed webhook processing — validate the queue, not the
  retry loop.
- **Webhook health monitoring** — "heartbeat lost" warnings are a UI/status concern. Deferred.
- **Rate limiting / 429 handling** — the mock server never rate-limits.

---

## The Mock CRM Connector

Lives at `connectors/mock-crm/`. Implements the `Connector` interface using `ctx.http`:

```typescript
// connectors/mock-crm/src/index.ts
export default {
  metadata: {
    name: "mock-crm",
    version: "0.1.0",
    auth: { type: "apiKey", header: "Authorization", prefix: "Bearer" },
  },

  getEntities(ctx): EntityDefinition[] {
    return [{
      name: "contacts",

      async *read(ctx, since) {
        const url = since
          ? `${ctx.config.baseUrl}/contacts?since=${encodeURIComponent(since)}`
          : `${ctx.config.baseUrl}/contacts`;
        const res = await ctx.http(url);
        const records = await res.json();
        yield { records, since: new Date().toISOString() };
      },

      async *insert(records, ctx) {
        for await (const record of records) {
          const res = await ctx.http(`${ctx.config.baseUrl}/contacts`, {
            method: "POST",
            body: JSON.stringify(record.data),
          });
          const created = await res.json();
          yield { id: created.id, data: created };
        }
      },

      // handleWebhook lives on the Connector, not EntityDefinition (see SDK spec)
    }];
  },

  async handleWebhook(req, ctx) {
    const payload = await req.json();
    // Thick webhook — full contact in payload
    return [{ entity: "contacts", records: [{ id: payload.id, data: payload }] }];
  },

  async onEnable(ctx) {
    const res = await ctx.http(`${ctx.config.baseUrl}/webhooks/subscribe`, {
      method: "POST",
      body: JSON.stringify({ url: ctx.webhookUrl }),
    });
    const { subscriptionId } = await res.json();
    await ctx.state.set("webhookSubscriptionId", subscriptionId);
  },

  async onDisable(ctx) {
    const id = await ctx.state.get("webhookSubscriptionId");
    if (id) {
      await ctx.http(`${ctx.config.baseUrl}/webhooks/${id}`, { method: "DELETE" });
      await ctx.state.delete("webhookSubscriptionId");
    }
  },
} satisfies Connector;
```

---

## New SQLite Tables (beyond v4)

### `request_journal`

```sql
CREATE TABLE request_journal (
  id              TEXT PRIMARY KEY,
  connector_id    TEXT NOT NULL,
  batch_id        TEXT,                    -- links to transaction_log if this call produced a write
  method          TEXT NOT NULL,
  url             TEXT NOT NULL,
  request_body    TEXT,                    -- JSON, null for GET
  request_headers TEXT,                    -- JSON, sensitive values replaced with "[REDACTED]"
  response_status INTEGER NOT NULL,
  response_body   TEXT,                    -- truncated at 64KB
  duration_ms     INTEGER NOT NULL,
  called_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

### `webhook_queue`

```sql
CREATE TABLE webhook_queue (
  id              TEXT PRIMARY KEY,
  connector_id    TEXT NOT NULL,
  raw_payload     TEXT NOT NULL,           -- JSON, as received
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | completed | failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at    TEXT
);
```

---

## Work Items

1. `mock-crm` API server (Hono, in-process, start/stop for tests)
2. `connectors/mock-crm/` connector implementation
3. `ctx.http` implementation — wraps `fetch()`, injects auth, logs to request journal
4. Auth injection: API key / bearer pattern from `ctx.config`
5. Credential masking in journal writes
6. Request journal table + writes in `ctx.http`
7. Webhook server (Hono, single route `POST /webhooks/:connectorId`)
8. `webhook_queue` table
9. Webhook processor — dequeue loop, call `connector.handleWebhook()`, feed pipeline
10. `ctx.webhookUrl` injected at engine start, derived from server port
11. `onEnable()` / `onDisable()` connector lifecycle calls at startup/shutdown
12. Thin webhook variant — `handleWebhook()` calls `ctx.http` to enrich, verify journal row appears
13. `batch_id` correlation between `request_journal` and `transaction_log`
14. Tests:
    - Poll cycle produces correct request journal rows
    - Inserted records produce journal rows with masked credentials
    - Webhook receive → queue → process → sync pipeline (happy path)
    - Thin webhook produces additional journal row for the enrichment fetch
    - Journal rows never contain raw API key value

---

## Open Questions

- **Response body storage policy**: Always store, store only on error, or configurable?
  Impact on storage size vs. debuggability. Start with "always, truncate at 64KB".
- **`batch_id` on journal rows**: A journal row from a poll call happens *before* writes, so
  it can't know the `batch_id` of the writes it will produce. Options: (a) generate `batch_id`
  at the start of each cycle, pass it through, (b) update journal rows retroactively after writes.
  Option (a) is cleaner.
- **Webhook server port**: Hardcoded for POC (`4001`), or detected from `openlink.json`? Hardcode
  for now, make it configurable as part of the real engine.
- **In-process vs separate process for webhook server**: Same process for the POC (simplest).
  Production: same process is fine unless horizontal scaling is needed.

---

## Addendum: `trigger` column on `request_journal`

**Resolved during implementation.**

### Problem

After the first run, the `request_journal` table contained rows with `batch_id = null` for
lifecycle calls (`onEnable`, `onDisable`). There was no way to tell why an HTTP call was made
without reading the URL — a `POST /webhooks/subscribe` looked identical to a `POST /contacts`
if you squinted.

### Decision: add a `trigger` column

```sql
ALTER TABLE request_journal ADD COLUMN trigger TEXT;
-- values: 'poll' | 'webhook' | 'on_enable' | 'on_disable'
```

A nullable `TEXT` discriminator. Exactly one of `batch_id` or `trigger` tends to be the
primary correlation handle for any given row:

| Context                | `trigger`    | `batch_id`       |
|------------------------|-------------|------------------|
| `ingest()` poll cycle  | `poll`      | set (links to tx_log writes) |
| `processWebhookQueue()`| `webhook`   | set (one per webhook row)    |
| `onEnable()`           | `on_enable` | null             |
| `onDisable()`          | `on_disable`| null             |

This is a purely additive, non-breaking schema change. All existing rows receive `NULL`,
which is correct — they pre-date the column.

### Implementation

`makeTrackedFetch()` accepts a `triggerRef: { current: JournalTrigger | undefined }` alongside
the existing `batchIdRef`. `ConnectorInstance` carries both refs. The engine sets them before
each operation and (for lifecycle calls) clears them in a `finally` block:

```typescript
// ingest()
source.batchIdRef.current = opts.batchId;
source.triggerRef.current = "poll";

// onEnable()
instance.triggerRef.current = "on_enable";
try { await instance.connector.onEnable(instance.ctx); }
finally { instance.triggerRef.current = undefined; }

// processWebhookQueue()
instance.batchIdRef.current = batchId;       // one UUID per webhook row
instance.triggerRef.current = "webhook";
```

### Why not reuse `batch_id` for lifecycle events?

`batch_id` is semantically tied to a set of writes that atomically advanced the state. A
lifecycle event (`onEnable`) makes HTTP calls but produces no `transaction_log` rows — there is
nothing to group. Overloading `batch_id` with a sentinel string like `"lifecycle:on_enable"`
would break the FK intent of the column. A separate `trigger` column keeps the semantics clean.

---

## Addendum: `batch_id` on `webhook_queue`

**Resolved during implementation.**

### Problem

After processing, a `webhook_queue` row had no `batch_id`. The `request_journal` rows produced
by `handleWebhook` carried a `batch_id` (written at processing time), but there was no way to
navigate *from* the queue row *to* those journal rows — or to the `sync_runs` and
`transaction_log` rows that share the same UUID.

### Decision: add `batch_id TEXT` to `webhook_queue`

```sql
ALTER TABLE webhook_queue ADD COLUMN batch_id TEXT;
```

The UUID is generated *before* `dbMarkWebhookProcessing()` and written to the queue row at the
same moment it is propagated into `batchIdRef`. This gives a single join key across all four
observability tables for any webhook-triggered operation:

```sql
-- "what did processing this webhook cause?"
SELECT r.*
FROM   webhook_queue w
JOIN   request_journal r  ON r.batch_id = w.batch_id
WHERE  w.id = '<webhook-uuid>';

-- or via sync_runs / transaction_log
SELECT t.*
FROM   webhook_queue w
JOIN   transaction_log t ON t.batch_id = w.batch_id
WHERE  w.id = '<webhook-uuid>';
```

### Why not also add `webhook_id` to `sync_runs`?

`sync_runs.batch_id` already equals `webhook_queue.batch_id` for webhook-triggered runs — the
join is implicit. Adding a redundant `webhook_id` FK would duplicate information without adding
expressive power.

### Implementation

`processWebhookQueue()` now generates `batchId` before marking the row as processing:

```typescript
const batchId = crypto.randomUUID();
dbMarkWebhookProcessing(this.db, row.id, batchId);   // writes batch_id to queue row
if (instance.batchIdRef) instance.batchIdRef.current = batchId;  // propagates to ctx.http
```

`dbMarkWebhookProcessing` signature changed to `(db, id, batchId)`.



---

# Plan: POC v6 — OAuth2, prepareRequest, and Lookup-Merge ETag

**Status:** `planned`
**Depends on:** v5 POC (ctx.http, request journal, ctx.state)
**Absorbs:** `lookup-merge-etag.md` plan (connector foundation validated here)

## Goal

Validate three things in one POC:

1. The two remaining auth patterns: OAuth2 (centralized, engine-managed) and `prepareRequest`
   (bespoke, connector-managed). After v6, all three auth paths are proven — `ctx.http` is
   complete and connectors can be written against it with confidence.
2. The connector-side foundation for ETag / optimistic-lock writes: `ReadRecord.version` flowing
   through the engine's dispatch loop and arriving as `UpdateRecord.version` at the connector.
   The full engine retry-on-412 machinery is out of scope; this POC establishes that the
   connector contract is right before building the surrounding machinery.

The mock API server from v5 is extended to support both an OAuth2 token endpoint and a
signature-based auth variant, so each auth path can be tested without external dependencies.
The same mock-erp server also exposes ETag headers on lookup responses and validates
`If-Match` on writes, so the ETag threading can be tested end-to-end at the connector layer.

---

## The Three Auth Paths (recap)

`ctx.http` resolves auth in this priority order before making every request:

```
1. connector has prepareRequest?  → call it, skip everything else
2. metadata.auth.type === 'oauth2'   → inject Bearer token (refresh if expired)
3. metadata.auth.type === 'api-key'  → inject static key as Bearer header
4. metadata.auth.type === 'none'     → no auth header
```

v5 validated path 3. v6 validates paths 1 and 2, and validates that path 1 correctly short-circuits
paths 2 and 3.

---

## What v6 Validates

### 1. OAuth2 — Token Lifecycle

The engine manages the full OAuth2 Client Credentials flow (machine-to-machine, no browser
redirect needed for the POC). The connector declares `metadata.auth.type = 'oauth2'` and
implements `getOAuthConfig()`.

Flow to validate end-to-end:

```
Engine start
  → calls connector.getOAuthConfig(ctx)
  → checks oauth_tokens table: no token yet
  → POST /oauth/token (client_credentials grant)
  → stores { access_token, expires_at } in oauth_tokens
  → ctx.http calls use Bearer token automatically

Token expires (simulated)
  → ctx.http detects expires_at within 5-minute buffer
  → acquires lock (UPDATE oauth_tokens SET locked_at = ...)
  → POST /oauth/token to refresh
  → stores new token, clears locked_at

Concurrent refresh (simulated with two async tasks)
  → Task A acquires lock, starts refresh
  → Task B sees locked_at set, waits 500ms, reads refreshed token from DB
  → Both tasks proceed with valid token, only one refresh call made
```

Questions to resolve:
- The lock is a SQLite `UPDATE ... WHERE locked_at IS NULL OR locked_at < now() - 30s`
  and "affected rows === 1" check. SQLite serializes writes, so this is safe even in Bun's
  single-event-loop async model — but verify it with a concurrent test.
- What happens when the token endpoint itself returns an error? The engine should surface this
  as a connector-level error (not crash), trip the circuit breaker if it persists.
- Does `getOAuthConfig()` receive current `ctx.config` correctly, so the connector can derive
  the token endpoint from `ctx.config.baseUrl`? Validate with a dynamic URL (mock server port
  injected at test time).

### 2. OAuth2 — Scope Union

The spec says required scopes are the union of `auth.scopes` + entity scopes + action scopes.
v6 should validate that the correct scope set is sent in the token request.

This is a connector-level declaration, but the engine must assemble it. Simple to test:
mock server's `/oauth/token` echoes back the requested scopes; assert the engine sent the
right union.

### 3. `prepareRequest` — Session Token Pattern

A mock connector that doesn't use OAuth but needs to log in first:

```
First request
  → ctx.state.get('session') → null
  → POST /auth with user/pass credentials
  → stores session token in ctx.state
  → retries original request with X-Session header

Subsequent requests
  → ctx.state.get('session') → token
  → injects header directly, no extra login call

Session expiry (simulated: mock server returns 401)
  → connector invalidates ctx.state.get('session')
  → refreshes via POST /auth
  → retries
```

The critical thing to validate: **no recursion**. The `POST /auth` call inside `prepareRequest`
goes through `ctx.http`, which must not call `prepareRequest` again — otherwise login calls
trigger more login calls indefinitely. The spec says `prepareRequest` calls bypass the hook.
Verify this with a test that asserts `/auth` is called exactly once per session.

### 4. `prepareRequest` — HMAC Signing

A mock connector where every request must be signed:

```
ctx.http("POST /data", { body: '{"name":"Alice"}' })
  → prepareRequest clones body, computes HMAC-SHA256
  → adds X-Signature header to request
  → mock server validates signature, returns 200 or 401
```

What this tests beyond the signing itself:
- `req.clone()` is needed before reading the body — validate the stream is not consumed
- Signed headers must not appear in the journal in plain text (masking still applies)
- The original unmodified request object is logged (pre-prepareRequest), so the journal row
  shows the request the connector intended, not the wire format

### 5. `prepareRequest` short-circuits built-in auth

If a connector declares both `prepareRequest` and `metadata.auth.type = 'oauth2'`, the
`prepareRequest` hook runs and the OAuth token injection is skipped entirely. Verify this
explicitly — a connector should be able to handle its own auth without the engine interfering.

---

## What v6 Validates (continued): Lookup-Merge ETag

This section covers the connector-foundation half of the `lookup-merge-etag.md` plan. The engine
machinery (retry-on-412, `prefetchBeforeWrite` channel option, storing `version` in `shadow_state`)
is explicitly deferred. What v6 does establish:

### 6. `ReadRecord.version` — connector captures ETag from lookup

`mock-erp` returns an `ETag` header on every `GET /employees/:id` response. The `mock-erp`
connector's `lookup()` implementation captures it:

```typescript
return {
  id,
  data,
  version: res.headers.get('ETag') ?? undefined,
};
```

The `ReadRecord` type gains an optional `version` field (additive, no existing connector
impacted). The engine stores it alongside the lookup result in a local map during the dispatch
pass, then populates `UpdateRecord.version` before calling `connector.update()`.

What v6 proves:
- The field flows from `lookup()` result → engine dispatch loop → `UpdateRecord` without loss.
- Connectors that omit `version` (e.g. the existing jsonfiles connector) are completely
  unaffected — the field is absent on both ends, no behavioral change.

### 7. `UpdateRecord.version` — connector uses ETag for conditional write

The `mock-erp` connector's `update()` method forwards `version` as an `If-Match` header if
present, and otherwise sends the write without it:

```typescript
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (record.version) headers['If-Match'] = record.version;
const res = await ctx.http(`${base}/employees/${record.id}`, {
  method: 'PUT',
  headers,
  body: JSON.stringify({ ...snapshot, ...record.data }),
});
if (res.status === 412) {
  yield { id: record.id, error: '412 Precondition Failed — record modified concurrently' };
  continue;
}
```

`mock-erp` validates the `If-Match` header server-side (returns 412 if the stored ETag doesn't
match the request). A test-control endpoint `POST /__mutate-employee/:id` modifies a record
out-of-band to advance the server's ETag, enabling the 412 path to be exercised deterministically.

### 8. `UpdateRecord.snapshot` — full-replace PUT connector avoids double lookup

`mock-erp` only supports full-replace PUT (no PATCH). The connector needs the entire existing
record to merge changes into before writing. Because the engine already called `lookup()` for
conflict detection (or `prefetchBeforeWrite`), it can populate `UpdateRecord.snapshot` with the
full live record, sparing the connector a second fetch.

`UpdateRecord` gains an optional `snapshot` field. The engine populates it when it has a live
lookup result for the record in the current dispatch pass; otherwise it is absent and the connector
falls back to its own `fetchOne()` call. v6 tests both paths (snapshot present → no extra fetch;
snapshot absent → connector does its own fetch).

What v6 proves:
- The snapshot is the same data the connector would have fetched itself (no divergence).
- When snapshot is absent the connector still works correctly (graceful degradation).
- No existing connector (`mock-crm`, jsonfiles) is impacted by the additive field.

### 9. 412 result is a per-record error, not a throw

When the server returns 412, the connector yields `{ id, error: '412 ...' }` rather than
throwing. The engine treats this as a per-record failure and marks the record for retry on the
next cycle, without aborting the rest of the write run. v6 tests:
- The 412 record produces an `action: 'error'` in `IngestResult.records`.
- The remaining records in the same batch are still written successfully.

---

## Mock SaaS Servers

v6 introduces a second mock SaaS alongside mock-crm from v5. Running two distinct servers with
different auth patterns reflects the real scenario: syncing between systems that each have their
own auth contract.

### `mock-crm` (from v5, unchanged)

API key auth. Unchanged from v5. The engine connects to it using the static `api-key` path in
`ctx.http`.

### `mock-erp` (new in v6)

A second in-process Hono server representing an ERP system. Exposes the same contact-like entity
(`employees`, to keep it distinct from CRM `contacts`) but protected by OAuth2 Client Credentials.
Also has a legacy session-based variant for testing `prepareRequest`.

```
mock-erp endpoints:

POST /oauth/token
  body: { grant_type, client_id, client_secret, scope }
  response: { access_token, token_type, expires_in, scope }

GET  /employees?since=<iso>     — requires Authorization: Bearer <token>
GET  /employees/:id             — requires Bearer; returns ETag header
POST /employees                 — requires Bearer
PUT  /employees/:id             — requires Bearer; validates If-Match if present, returns 412 on mismatch

POST /session/login             — returns { session: "<token>" }  (prepareRequest variant)
GET  /employees/legacy?since=…  — requires X-Session: <token>     (prepareRequest variant)

POST /signed/employees          — requires X-Signature HMAC header (prepareRequest HMAC variant)

POST /__expire-token            — test-only: mark current token as expired on mock server's side
POST /__invalidate-session      — test-only: invalidate the session token
POST /__mutate-employee/:id     — test-only: modify a field out-of-band to advance the stored ETag
```

`mock-erp` is started alongside `mock-crm` in the same test process, on a different port.
`openlink.json` for the v6 POC has two connector entries:

```json
{
  "connectors": {
    "crm": {
      "plugin": "@opensync/connector-mock-crm",
      "config": { "baseUrl": "http://localhost:4000", "apiKey": "test-key" }
    },
    "erp": {
      "plugin": "@opensync/connector-mock-erp",
      "config": {
        "baseUrl": "http://localhost:4001",
        "clientId": "opensync-test",
        "clientSecret": "secret"
      }
    }
  }
}
```

The v6 sync scenario: `contacts` in mock-crm ↔ `employees` in mock-erp, synced through a
`people` channel. Each connector uses a completely different auth path — the sync pipeline and
field mapping are the same as v3/v4/v5; only the auth layer differs.

### `connectors/mock-erp/`

New connector package alongside `connectors/mock-crm/`. Implements `Connector` with
`metadata.auth.type = 'oauth2'`, `getOAuthConfig()`, and the `getEntities()` definition for
`employees`. Also exports a `prepareRequest` variant (as a separate named export or a factory
function) for the session-token and HMAC tests.

---

## Mock Server Extensions (beyond v5)

All new endpoints live on `mock-erp` (port 4001). `mock-crm` (port 4000) is unchanged from v5.
The `/__expire-token` and `/__invalidate-session` test-control endpoints are only active in the
test build of mock-erp.

---

## New SQLite Tables (beyond v5)

### `oauth_tokens`

```sql
CREATE TABLE oauth_tokens (
  connector_id    TEXT PRIMARY KEY,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT,
  expires_at      TEXT,            -- ISO 8601; null means non-expiring
  locked_at       TEXT             -- set during refresh; cleared after
);
```

No new tables for `prepareRequest` — it uses `ctx.state` (the `connector_state` table from v4).

No new tables for ETag — `version` values are carried in the engine's in-memory dispatch
context for the duration of the current ingest pass. Storing `version` in `shadow_state` is an
open question deferred to the full engine (see Open Questions).

---

## SDK Changes (additive, planned here — implemented when v6 is built)

| Item | Type |
|------|------|
| Add `version?: string` to `ReadRecord` | Additive — existing connectors unaffected |
| Add `version?: string` to `UpdateRecord` | Additive — existing connectors unaffected |
| Add `snapshot?: Record<string, unknown>` to `UpdateRecord` | Additive |
| Engine: copy `version` from `lookup()` result into `UpdateRecord` during dispatch | Engine internals |
| Engine: populate `snapshot` on `UpdateRecord` when lookup result is available | Engine internals |

---

## Work Items

### Auth (OAuth2 + prepareRequest)

1. `mock-erp` API server (Hono, in-process, start/stop for tests) — port 4001
2. `connectors/mock-erp/` connector package — OAuth2, `getOAuthConfig()`, `employees` entity
3. `openlink.json` for v6 POC — two connectors (crm: api-key, erp: oauth2)
4. `mappings/` for v6 POC — `people` channel mapping crm `contacts` ↔ erp `employees`
5. `OAuthTokenManager` class — `getAccessToken()`, `storeTokens()`, lock/retry logic
6. `oauth_tokens` table
7. `ctx.http` OAuth path — detect `metadata.auth.type === 'oauth2'`, call token manager
8. Scope union assembly from `metadata.auth.scopes` + entity scopes + action scopes
9. Test: full token lifecycle (acquire → use → expire → refresh) against mock-erp
10. Test: concurrent refresh — lock contention, only one `/oauth/token` call made
11. Test: token endpoint error → connector-level error, not crash
12. Test: end-to-end sync crm↔erp — api-key auth on one side, oauth2 on the other
13. `ctx.http` `prepareRequest` path — call hook, skip built-in auth injection
14. Non-recursion guard — `ctx.http` calls inside `prepareRequest` skip the hook
15. Session token `prepareRequest` variant against mock-erp `/session/login`
16. Test: session login called exactly once per session (no recursion)
17. Test: 401 from mock-erp → session invalidated, re-login, retry
18. HMAC signing `prepareRequest` variant against mock-erp `/signed/employees`
19. Test: body not consumed before signing; signature validates on server
20. Test: pre-hook request logged in journal (not post-hook wire format)
21. Test: `prepareRequest` presence suppresses OAuth injection

### Lookup-Merge ETag (connector foundation)

22. Add `version?: string` to `ReadRecord` in `packages/sdk/src/types.ts`
23. Add `version?: string` and `snapshot?: Record<string, unknown>` to `UpdateRecord`
24. `mock-erp`: `GET /employees/:id` returns `ETag` header; `PUT /employees/:id` validates
    `If-Match` and returns 412 on mismatch; `POST /__mutate-employee/:id` test-control endpoint
25. Engine dispatch loop: after `lookup()`, carry `version` and full live record in a local map
    keyed by record ID; attach both to `UpdateRecord` before calling `connector.update()`
26. `mock-erp` connector `lookup()`: capture `ETag` header → `ReadRecord.version`
27. `mock-erp` connector `update()`: forward `version` as `If-Match`; yield per-record error on 412;
    use `snapshot` for merge if present, otherwise fall back to internal `fetchOne()`
28. Test: `version` present in `UpdateRecord` when `lookup()` returns it (end-to-end threading)
29. Test: `snapshot` present in `UpdateRecord` when engine pre-fetched; connector skips own fetch
30. Test: `snapshot` absent → connector performs its own fetch (graceful degradation)
31. Test: 412 path — out-of-band mutation → `If-Match` fails → per-record error, rest of batch succeeds
32. Test: connector that omits `version` entirely (mock-crm / jsonfiles) — no behavioral change

---

## Open Questions

### Auth

- **Authorization Code flow**: Client Credentials (machine-to-machine) is fine for the POC.
  Authorization Code (user consent, browser redirect) is needed for real HubSpot/Fiken
  connectors. That flow requires a local redirect server or a CLI `opensync auth <connectorId>`
  command to open a browser. Defer to a dedicated auth POC or the real engine.
- **Token encryption at rest**: The spec says sensitive fields should be encrypted. For the POC,
  plain text is fine — but the `oauth_tokens` table design should leave room for an `encrypted`
  flag or a separate secrets backend. Don't bake in plaintext as an assumption.
- **`prepareRequest` and response handling**: The current spec only covers request mutation.
  Should `prepareRequest` also be able to inspect the response — e.g. to detect a 401 and retry?
  Or is that a separate `handleResponse` hook? This is the 401-retry pattern for session tokens.
  Tentative answer: handle it inside `prepareRequest` by checking `ctx.state`, but the interface
  needs to be specified before implementation.
- **Scope computation timing**: Scopes are declared per entity and action. Do we compute the union
  at `onEnable()` time (static, based on current channel membership) or at every token request
  (dynamic)? Static at enable time is simpler and matches how real OAuth apps work (scopes
  approved once at authorization time).

### Lookup-Merge ETag

- **Always pre-fetch or only on conflict detection?** Pre-fetching unconditionally costs one
  `lookup()` call per updated record per cycle. Proposed default for v6: only populate
  `version`/`snapshot` when the engine already called `lookup()` for conflict detection in
  the current pass. A per-channel `prefetchBeforeWrite` option (and full deferred
  implementation) is deferred to the real engine.
- **Store `version` in `shadow_state`?** Storing it would let the engine re-use the last-seen
  version across cycles without a fresh lookup. But ETags must reflect the record *as it is now*,
  not as of the last sync. Tentative: yes, store alongside `canonical_data` for staleness
  detection, but still do a fresh `lookup()` before write when `prefetchBeforeWrite` is enabled.
  Not needed for the v6 POC — defer.
- **`If-Unmodified-Since` as a fallback?** For APIs without ETag but with `updatedAt`, the
  connector could use `updatedAt` from the lookup as `If-Unmodified-Since`. Weaker (1-second
  granularity) but still better than nothing. Leave entirely to the connector for now; no engine
  support needed.
- **Engine retry on 412**: The full retry-on-412 loop (fresh lookup → re-dispatch on next cycle)
  is explicitly out of scope for v6. The 412 result surfaces as a per-record error in
  `IngestResult`; the retry machinery is a follow-on task.


---

# Plan: POC v7 — Discoverability & Onboarding

**Status:** `planned`
**Depends on:** v5 POC (SQLite state layer, shadow state, identity map)
**Triggered by:** State-wipe incident — deleting `opensync.db` then re-running a full sync
caused both jsonfiles connectors to double up because the engine had no memory of
previously-synced records.

---

## The Problem

The engine's state (SQLite) and the connectors' data (JSON files / remote APIs) are two separate
things. They can get out of sync. The most dangerous moment is when:

1. **Fresh install** — two systems each have existing data, unknown overlap.
2. **State wipe** — the database was deleted but the connected systems already have previously-
   synced data in them.

In both cases, `ingest()` with `fullSync: true` sees every record as new (no shadow state, no
identity map) and inserts all of them into every other connector. If the records were already
there, they get duplicated. With two jsonfiles connectors this looks like:

```
System A: [a1, a2, a3]   →   ingest   →   System B inserts a1ʼ, a2ʼ, a3ʼ
System B: [b1, b2, b3]   →   ingest   →   System A inserts b1ʼ, b2ʼ, b3ʼ

Result:
  System A: [a1, a2, a3, b1ʼ, b2ʼ, b3ʼ]   ← 6 records, 3 are duplicates
  System B: [b1, b2, b3, a1ʼ, a2ʼ, a3ʼ]   ← 6 records, 3 are duplicates
```

Where `b1 = a1` (same person, different generated IDs) because they were previously synced —
the engine just forgot.

The current code has no mechanism to detect this situation or prevent it.

---

## Goals

1. **Match phase**: before writing anything, fetch all records from all channel members and
   compare them using identity fields — produce a `MatchReport` that categorises records as
   matched, partial, or unique-per-side.

2. **Link phase**: commit a `MatchReport` to the DB — write identity_map rows and fully populate
   shadow_state for both sides of every confirmed match. This is the echo-storm prevention step
   from `specs/discovery.md`.

3. **Onboarding state machine**: track per-channel whether discovery has been completed.
   Guard `ingest()` so it refuses to run on an uninitialised channel that already has data.

4. **Dry-run mode**: `engine.discover()` produces a report without touching the DB.
   `engine.onboard(channelId, matchReport)` commits it. These are separate, inspectable steps.

5. **Demonstrate the failure**: the runner script should show exactly what goes wrong without
   discovery (duplicate insertion) and exactly what goes right with it (zero writes on a clean
   re-run after state wipe).

---

## New Engine Operations

### `engine.discover(channelId)`

Read ALL records from every member connector (no `since` filter, no watermark). Compare across
connectors using the channel's `identityFields` configuration. Return a `DiscoveryReport` — no
DB writes.

```typescript
interface DiscoveryMatch {
  canonicalData: Record<string, unknown>;
  sides: Array<{
    connectorId: string;
    externalId: string;
    rawData: Record<string, unknown>;
  }>;
}

interface DiscoverySide {
  connectorId: string;
  externalId: string;
  rawData: Record<string, unknown>;
}

interface DiscoveryReport {
  channelId: string;
  entity: string;
  matched: DiscoveryMatch[];         // high-confidence: same value on all identity fields
  uniquePerSide: DiscoverySide[];    // records that exist on only one connector
  summary: {
    [connectorId: string]: { total: number; matched: number; unique: number };
  };
}
```

Implementation notes:
- Reads use `entity.read(ctx, undefined)` (no watermark) — same as `fullSync` but read-only.
- Matching is exact: all `identityFields` must match after inbound field mapping is applied.
- For v7, only two-connector channels are in scope. N-way matching can come later.
- `identityFields` is already on `ChannelConfig` — no schema changes needed.

### `engine.onboard(channelId, report, opts?)`

Commit a `DiscoveryReport` to the DB. For each `matched` entry:
1. Assign a `canonical_id` (new UUID).
2. Write `identity_map` rows for all sides.
3. Write `shadow_state` rows for all sides with the current canonical data.
4. Advance the watermark for each connector to `now` so the next incremental sync
   starts from this point and doesn't re-read already-onboarded records.

For `uniquePerSide` records:
- Default: queue them for creation in the other system (controlled by
  `opts.propagateUnique`, default `true`). This is done by running a normal
  `_processRecords` pass, which will treat them as new inserts.
- If `opts.propagateUnique === false`: write a shadow row with `onboarded_only` status
  and skip them — they stay local.

```typescript
interface OnboardResult {
  linked: number;          // identity_map pairs created
  shadowsSeeded: number;   // shadow_state rows written
  uniqueQueued: number;    // records queued for creation in the other connector
  uniqueSkipped: number;   // unique records explicitly skipped
}
```

### `engine.channelStatus(channelId)`

Return the current onboarding state for a channel:

```typescript
type ChannelStatus =
  | "uninitialized"   // no identity_map rows, no shadow_state for this channel — needs discovery
  | "ready";          // onboarding was completed at least once — normal sync is safe
```

The check is lightweight: any `identity_map` row linked to a connector in this channel means
`"ready"`. No separate status table needed for v7 — derive from existing state.

---

## New DB Table: `onboarding_log`

Track when discovery/onboard ran so the runner output (and future UI) can show history:

```sql
CREATE TABLE IF NOT EXISTS onboarding_log (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  entity        TEXT NOT NULL,
  action        TEXT NOT NULL,   -- 'discover' | 'onboard'
  matched       INTEGER,
  unique_count  INTEGER,
  linked        INTEGER,
  shadows_seeded INTEGER,
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL
);
```

This is append-only and used only for diagnostics. It does not affect engine behaviour.

---

## Guard in `ingest()`

Before reading from the source connector, check:

1. Is there at least one record in the target connector's JSON file / API?
2. Is there zero shadow state for this channel?

If both are true: throw `OnboardingRequiredError` with a clear message:

```
OnboardingRequiredError: Channel "contacts-channel" has data in connector "system-b"
but no shadow state. Run engine.discover() and engine.onboard() before syncing.
Use { skipOnboardingCheck: true } to override (creates duplicates).
```

The `skipOnboardingCheck` escape hatch exists so tests that deliberately exercise the
failure scenario can opt out.

The check only protects the write side. Reading and diffing local shadow state is always safe.

---

## Demo Scenario (`run.ts`)

The runner should walk through three sub-scenarios in sequence:

### Scenario A — The Bug (shows the problem)

1. Populate `system-a/contacts.json` and `system-b/contacts.json` with the same 3 contacts
   (different `_id`s, same `name`/`email`), simulating a previous sync whose DB state was lost.
2. Delete the SQLite DB.
3. Call `ingest()` on both sides with `skipOnboardingCheck: true`.
4. Print the resulting file contents — show 6 records per file (3 duplicates each).
5. Reset state and JSON files for the next scenario.

### Scenario B — Happy Path (shows the fix)

1. Same starting data as Scenario A.
2. Call `engine.discover("contacts-channel")` — print the `DiscoveryReport`.
   Output should show `3 matched, 0 unique`.
3. Call `engine.onboard("contacts-channel", report)` — print the `OnboardResult`.
   Output should show `3 linked, 6 shadows seeded, 0 unique queued`.
4. Call `ingest()` on both sides — output should show `3 skipped, 0 inserts`.
5. Make one edit (change Alice's email in system-a) — ingest should show `1 update`.

### Scenario C — Fresh Onboarding (no prior overlap)

1. Populate only `system-a/contacts.json` with 3 contacts. `system-b/contacts.json` is empty.
2. Call `engine.discover()` — show `0 matched, 3 unique in system-a`.
3. Call `engine.onboard()` with default `propagateUnique: true`.
4. system-b should now have all 3 contacts (created by onboarding, not loose ingest).
5. Call `ingest()` on both sides — show `0 inserts` (already handled).

---

## Test Coverage (`engine.test.ts`)

- `discover()` returns correct match/unique counts for pre-seeded JSON files.
- `discover()` makes zero DB writes (verified by snapshot of DB state before/after).
- `onboard()` writes the correct `identity_map` and `shadow_state` rows.
- After `onboard()`, `ingest()` on both sides produces zero inserts.
- After `onboard()` + one edit on side A, `ingest()` from A produces exactly one update on side B.
- `ingest()` without prior `onboard()` throws `OnboardingRequiredError` when target has data.
- `ingest()` with `skipOnboardingCheck: true` succeeds and creates duplicates (negative test).
- Watermarks are advanced to `finished_at` of `onboard()` so next incremental sync is clean.

---

## What v7 Does NOT Cover

- **Fuzzy / partial matching** (name similarity, phone normalisation) — the spec describes this
  but it's a follow-on. v7 only implements exact-match on the declared `identityFields`.
- **N-way matching** (3+ connectors in one channel). Two-connector channels only.
- **Interactive review of partial matches** — no CLI/UI. Partial matches are reported but not
  acted on; the operator must resolve them manually and re-run.
- **Incremental discovery** (resumable, paginated for large datasets). v7 loads everything into
  memory; that's fine for the POC scale.
- **OAuth2 / authenticated connectors** — the test fixture is still jsonfiles. The discovery
  plumbing is connector-agnostic, so it will work with HTTP connectors when v6 lands.
- **Rollback** — if `onboard()` is interrupted mid-write, the DB is left in a partially-linked
  state. A transaction wrapper is all that's needed; note it as a known gap.

---

## Open Questions

1. **Identity fields and field mapping**: `identityFields` are currently canonical field names.
   When comparing side A to side B the inbound mapping has already been applied, so canonical
   names are used for matching. Is that always correct, or do we need a per-side identity field
   declaration? This matters when the field is renamed between connectors.

2. **Watermark advancement after onboard**: advancing to `now` is safe but means a window of
   changes made between the `discover()` and `onboard()` calls won't be picked up until the
   next full sync. Should `discover()` record a `snapshot_at` timestamp and `onboard()` use
   that instead of `now`?

3. **The `onboarding_log` vs `sync_runs`**: could just add an `action` column to `sync_runs`
   and reuse it rather than a new table. Worth deciding before implementing so the schema is
   stable across POCs.

4. **What signals `"ready"` reliably?**: deriving channel status from the existence of
   `identity_map` rows works for the common case but not for channels where the left side
   legitimately has zero records. An explicit `channel_onboarding_status` table (keyed on
   `channel_id`) would be simpler and more explicit. Evaluate at implementation time.


---

# Plan: POC v8 — Three-Way Onboarding & Deduplication

**Status:** `planned`
**Depends on:** v7 POC (discover phase, `engine.discover()`, `engine.onboard()`, channel status)

---

## Background

v7 established the core discover/onboard loop for a **two-connector channel**: fetch all records
from both sides, match on identity fields, link into the canonical layer, seed shadow state, and
guard `ingest()` from running blind. The result is a clean first-sync with no duplicates.

v8 poses the harder question: **what happens when a third system joins a channel that is already
live?** Systems A and B are synced and operational. System C is being onboarded for the first
time. C has its own pre-existing data. Some of those records are the same entities already known
to the canonical layer; others are net-new. The engine must:

1. Figure out which of C's records map to existing canonicals (match against the canonical layer,
   not against A or B directly).
2. Link those records without creating duplicates in A or B.
3. Propagate genuinely new C records into all existing channel members.
4. Propagate records already in A/B (but absent from C) into C.
5. After all this, start a normal 3-way sync with no surprises.

This is categorically different from v7's "two fresh systems" scenario. It requires a new
**add-connector-to-live-channel** flow alongside the existing pairwise discover/onboard.

---

## Goals

1. **Implement v7 first** as the starting point — two systems successfully onboarded with
   `discover()` + `onboard()`, live incremental sync running between them.

2. **`engine.addConnector(channelId, connectorId)`**: a new top-level operation that handles
   joining a new connector to an already-onboarded channel. It orchestrates discover, match
   against canonicals, link, seed, and propagate — all as a single safe transaction.

3. **Canonical-layer matching**: discovery for a joining connector matches its records not
   pairwise against a peer, but against the **existing canonical dataset**. The match report
   must express "C record X → canonical Y" rather than "C record X → B record Z".

4. **Asymmetric propagation**: after linking, records that are net-new in C are created in all
   existing members. Records already in the canonical layer but absent from C are created in C.
   Records matched to an existing canonical are **not** re-created anywhere.

5. **Idempotency check**: if `addConnector` is re-run for the same connector after partial
   failure, it should resume cleanly with no double-writes.

6. **Demonstrate deduplication**: the runner script should prove that running `addConnector`
   on a third system with overlapping data produces zero duplicates in any of the three systems
   and correct record counts everywhere.

---

## Scenario

Three systems are used; two of them can be the existing `mock-crm` and `mock-erp` connectors,
and the third is a second `mock-erp` instance with its own port and data set (or a dedicated
`mock-crm-b` variant). The data is simple: contacts/employees sharing an email field as the
identity key.

### Initial state (before v8 starts)

| Connector | Records |
|-----------|---------|
| System A (mock-crm) | Alice, Bob, Carol |
| System B (mock-erp) | Alice, Bob, Carol ← different IDs, same email |
| System C (mock-crm-b) | Alice, Bob, Dave ← different IDs; Carol is missing; Dave is new |

Canonicals after A↔B onboard: `{Alice, Bob, Carol}` — all 3 linked A↔B, shadow state seeded.

### Expected state after `addConnector(channelId, "system-c")`

| Connector | Records | Notes |
|-----------|---------|-------|
| System A | Alice, Bob, Carol, Dave | Dave propagated from C |
| System B | Alice, Bob, Carol, Dave | Dave propagated from C |
| System C | Alice, Bob, Carol, Dave | Carol propagated into C; Dave already existed |

Identity map: each of Alice, Bob, Carol, Dave linked across all three connectors that hold them.
Shadow state: seeded for all 3 sides for every entity.
Zero duplicates. Zero extra writes for the 3 already-matched records.

---

## New Engine Operation: `addConnector`

```typescript
interface AddConnectorOptions {
  /** Do not write anything — return the plan as a dry-run report. Default: false. */
  dryRun?: boolean;
  /**
   * What to do with records that exist in the canonical layer but are absent from the joining
   * connector. Default: 'propagate' — create them in the new connector.
   * 'skip' — leave them out; they will be created on the next normal ingest pass.
   */
  missingFromJoiner?: "propagate" | "skip";
}

interface AddConnectorReport {
  channelId: string;
  connectorId: string;
  /** C records that matched an existing canonical — will be linked, not created. */
  linked: Array<{
    canonicalId: string;
    externalId: string;
    matchedOn: string[];      // which identity fields hit
  }>;
  /** Net-new C records that will be propagated to all existing channel members. */
  newFromJoiner: Array<{
    externalId: string;
    data: Record<string, unknown>;
  }>;
  /** Canonical records absent from C — will be created in C (or skipped). */
  missingInJoiner: Array<{
    canonicalId: string;
    data: Record<string, unknown>;
  }>;
  summary: {
    totalInJoiner: number;
    linked: number;
    newFromJoiner: number;
    missingInJoiner: number;
  };
}

class SyncEngine {
  // ...existing methods from v7...

  /**
   * Onboard a new connector into an already-live channel.
   * The channel must already be in "ready" state (v7 onboarding completed).
   * The joining connector must not already be a registered member.
   */
  async addConnector(
    channelId: string,
    connectorId: string,
    opts?: AddConnectorOptions,
  ): Promise<AddConnectorReport>;
}
```

### Internal steps

```
addConnector(channelId, "system-c")
  1. Assert channel is "ready" (has identity_map rows for existing members).
  2. Assert connectorId is not already in this channel's identity_map.
  3. Fetch ALL records from system-c. (No watermark — full snapshot.)
  4. Load current canonical dataset from identity_map + shadow_state.
  5. Match: for each C record, scan canonicals using identityFields.
       → hit   → AddConnectorReport.linked
       → miss  → AddConnectorReport.newFromJoiner
  6. Compute missingInJoiner: canonicals with no hit from C.
  7. If dryRun: return the report, stop here.
  8. Commit links:
       for each `linked` entry:
         - add identity_map row: (canonicalId, "system-c", externalId)
         - write shadow_state row for system-c side
         (do NOT touch A or B — they're already linked and seeded)
  9. Propagate newFromJoiner to all existing members (A and B):
       - run _processRecords for these as new inserts
       - then link the new A/B IDs back to the same canonical
       - seed shadow_state for the new A/B rows
  10. Propagate missingInJoiner to system-c (if opts.missingFromJoiner === 'propagate'):
       - insert each canonical into system-c
       - add identity_map row for system-c
       - seed shadow_state for the new C row
  11. Advance watermark for system-c to `now`.
  12. Log to onboarding_log: action = 'add-connector'.
```

---

## Match: C Records vs Canonical Layer

The matching logic changes relative to v7. v7 picked two sides (A, B) and ran pairwise matching.
v8's `addConnector` match is **one-to-canonical**:

```typescript
interface CanonicalRecord {
  canonicalId: string;
  fields: Record<string, unknown>;   // the merged canonical field values from shadow_state
}

function matchAgainstCanonicals(
  joinerRecords: ReadRecord[],
  canonicals: CanonicalRecord[],
  identityFields: string[],
): {
  linked: Array<{ joinerRecord: ReadRecord; canonicalId: string; matchedOn: string[] }>;
  unmatched: ReadRecord[];
} 
```

Matching is still exact on all `identityFields` (same as v7). The canonical field values come
from the shadow_state of any member that already holds that canonical (first-member-wins for
read, consistent with v7 canonical construction). Fuzzy matching is out of scope for v8.

### One twist: identity field normalisation

Emails are lowercased and trimmed before comparison — same rule that was in scope in v7 but never
explicitly implemented. v8 is the natural place to pin that behaviour with test coverage because
"Bob" in CRM and "bob@example.com" vs "Bob@Example.com" in ERP is a real edge case that would
silently produce a duplicate without normalisation.

---

## Extended `ChannelStatus`

v7 had two statuses: `"uninitialized"` and `"ready"`. v8 needs one more:

```typescript
type ChannelStatus =
  | "uninitialized"        // no identity_map rows at all
  | "partially-onboarded"  // some members onboarded, at least one not yet
  | "ready";               // all declared members are onboarded
```

`"partially-onboarded"` is the state the channel is in between _adding_ system-c to the config
and actually running `addConnector`. The `ingest()` guard must allow sync between already-
onboarded members even while a third connector is in `"partially-onboarded"` state — it should
only block ingest _for_ the joining connector (it has no shadow state and will duplicate).

---

## DB Changes

### `identity_map` — no schema change needed

The existing `(canonical_id, connector_id, external_id)` structure supports N-way linking.
v7 just never tested with more than 2 connectors; v8 is the first N > 2 test.

### `onboarding_log` — extend action column

Add `'add-connector'` as a valid action value. No DDL change required since the column is TEXT.

### New helper: `dbGetCanonicalFields(db, canonicalId)`

Read the latest shadow_state for a canonical across all its linked connectors and return a merged
field map. Needed by the match step. First linked connector's shadow wins per field (priority by
connector registration order).

---

## Runner Scenarios (`run.ts`)

### Setup

Start three mock servers: CRM on port 5000, ERP on port 5001, CRM-B on port 5002.
Pre-populate all three with the data from the scenario table above.

### Scenario 1 — Clean two-system onboard (v7 rerun)

1. `discover("people-channel")` → DiscoveryReport showing 3 matches on email.
2. `onboard("people-channel", report)` → 3 linked, 6 shadows seeded.
3. `channelStatus("people-channel")` → `"ready"`.
4. Run `ingest()` → zero writes (everything already shadow-seeded).
5. Print identity_map — confirm 3 canonicals, each linked to A and B.

Output should look like:
```
[discover] 3 matched, 0 unique-per-side
[onboard ] linked=3 shadows=6 queued=0
[status  ] ready
[ingest  ] 0 inserts, 0 updates (A→B) | 0 inserts, 0 updates (B→A)
```

### Scenario 2 — Dry-run addConnector

1. `addConnector("people-channel", "system-c", { dryRun: true })` 
2. Print the report:
   - `linked`: Alice (email), Bob (email)
   - `newFromJoiner`: Dave
   - `missingInJoiner`: Carol
3. Assert no DB writes occurred (query identity_map — still only A+B rows).

Output should look like:
```
[dry-run] linked=2 newFromJoiner=1 missingInJoiner=1
[assert ] identity_map still has 6 rows (A+B only) ✓
```

### Scenario 3 — Live addConnector

1. `addConnector("people-channel", "system-c")` (live).
2. Print the report — same numbers as dry-run.
3. `channelStatus("people-channel")` → `"ready"`.
4. Assert record counts in all three systems:
   - System A: 4 records (Alice, Bob, Carol, Dave).
   - System B: 4 records (Alice, Bob, Carol, Dave).
   - System C: 4 records (Alice, Bob, Carol, Dave).
5. Assert identity_map has 12 rows (4 canonicals × 3 connectors).
6. Run `ingest()` → zero writes in all 6 directions (3 pairs).

Output should look like:
```
[add    ] linked=2 newFromJoiner=1 missingInJoiner=1
[status ] ready
[counts ] A=4 B=4 C=4 ✓
[map    ] 12 identity_map rows (4 canonicals × 3) ✓
[ingest ] 0 inserts, 0 updates across all pairs ✓
```

### Scenario 4 — Deduplication proof (the scary case)

To prove the guard works:

1. Reset all state. Re-populate three systems as in Setup.
2. Skip onboarding entirely. Call `ingest()` for all three pairs with `skipOnboardingCheck: true`.
3. Print record counts — show the duplication explosion.
4. Reset again and run the proper add-connector flow.
5. Print record counts again — show exactly 4 in each system, no duplicates.

This makes the value of the discover phase undeniable.

---

## Test Coverage (`engine.test.ts`)

The following tests are added beyond v7's suite:

| # | Description |
|---|-------------|
| 1 | `addConnector` dryRun returns correct linked/new/missing counts, no DB changes |
| 2 | `addConnector` live: identity_map has N×3 rows for N canonicals |
| 3 | `addConnector` live: shadow_state seeded for all 3 sides |
| 4 | Records matched on canonical are NOT re-created in A or B |
| 5 | Net-new joiner records ARE created in A and B with linked identity_map rows |
| 6 | Canonical-only records are created in the joining connector |
| 7 | After `addConnector`, `ingest()` produces zero writes in all 6 directions |
| 8 | `channelStatus` returns `"partially-onboarded"` when C is added to config but not yet called `addConnector` |
| 9 | `ingest()` for system-c is blocked while status is `"partially-onboarded"` |
| 10 | `addConnector` is idempotent: re-running after success produces the same report, no duplicate rows |
| 11 | Identity field normalisation: `Bob@Example.com` matches `bob@example.com` |

---

## Out of Scope for v8

- Fuzzy / composite matching (weight-based scoring). Still out of scope; exact match only.
- Removing a connector from a live channel (the inverse operation).
- Conflict resolution when the joining connector's data disagrees with the canonical value for
  a matched record (e.g. Alice's phone number is different in C). v8 just links without merging.
  Canonical value stays as set during the original A↔B onboard.
- UI / CLI for the discover and add-connector flows.
- More than one "new connector" added at a time. `addConnector` is sequential, one per call.

---

## Open Questions

1. **Canonical field source on mismatch**: when C's version of Alice has a different `phone`
   than the canonical, what should the shadow state for C reflect — C's value or the canonical?
   Current plan: C's own value (it's a shadow of C's state, not a normalised canonical).
   The canonical itself is not updated. This may need revisiting in a later POC.

2. **`addConnector` vs extending `onboard`**: should `addConnector` be a separate top-level
   method or a flag on `onboard` (e.g. `onboard(channelId, report, { mode: 'join' })`)?
   Separate method is clearer at the call site and easier to guard with preconditions.

3. **Watermark for the joining connector**: advancing it to `now` means that any writes made
   to C between `addConnector` and the first live `ingest()` could be missed. A safer choice
   is to record a `snapshot_at` timestamp at the start of the bulk fetch and use that as the
   watermark — same open question raised in v7 but now more important with 3-way sync.

4. **`partially-onboarded` detection**: how does the engine know system-c is "in the config but
   not yet onboarded"? The channel config declares its members; the identity_map declares who has
   been linked. The set difference between declared members and linked members gives the
   joining connectors. This requires the channel config to be the source of truth for membership.

5. **Creating Carol in C during `addConnector`**: the canonical value for Carol was formed from
   A's shadow state. When the engine creates Carol in C it sends those canonical fields through
   the outbound mapping. If C's schema doesn't accept all fields (e.g. it has no `middleName`
   column), the connector must handle that gracefully. Is the engine responsible for stripping
   unknown fields, or the connector?


---

# Plan: POC v9 — Ingest-first, DB-backed Identity Matching

**Status:** `implemented`
**Depends on:** v8 POC (three-way onboarding, `addConnector`)

---

## Background

v8 implemented `addConnector` as a live-fetch operation: it called the joining connector's
`read()` at onboard time to get a full snapshot, matched those records against the canonical
layer, and linked everything in one pass. This worked, but it created an awkward coupling.

The fundamental problem: **you can't preview the onboarding result without side-effects**.
`dryRun: true` worked, but it still required a live connector call on every invocation. If you
wanted to inspect the match report, you had to call the connector. If you ran `dryRun` multiple
times, you made multiple live calls. And `discover()` had the same issue — it called both
connectors to build the in-memory snapshot, so the "inspect before committing" workflow was
expensive.

The deeper issue is that `discover()` and `addConnector()` were coupled to live I/O, which
meant they couldn't be separated from the data-collection step. Inspection and commitment were
tangled together.

---

## Core Insight

Separate **data collection** from **identity resolution**.

Data collection — reading records from the source system — always writes to `shadow_state`.
That's already true for normal `ingest()`. The v9 insight is: **extend that invariant to
onboarding**. Run `ingest({collectOnly: true})` first, which writes shadow rows without any
fan-out, then let `discover()` and `onboard()` / `addConnector()` read entirely from those
shadow rows. No live connector calls after the initial ingestion.

This makes the flow:

```
ingest(A, { collectOnly: true })   → shadow_state[A] written, no fan-out
ingest(B, { collectOnly: true })   → shadow_state[B] written, no fan-out
discover(channelId)                → pure DB query on shadow_state → DiscoverReport
onboard(channelId, report)         → commits links, propagates uniques, marks ready
ingest(A)  /  ingest(B)            → normal fan-out now works (cross-links exist)
```

For adding a third connector later:

```
ingest(C, { collectOnly: true })   → shadow_state[C] written, no fan-out
                                     channel stays 'ready' for A+B — C is invisible
addConnector(channelId, "C")       → reads C's shadow_state, matches, links, catches up
ingest(A) / ingest(B) / ingest(C)  → all three sync normally
```

---

## Goals

1. **`ingest({collectOnly: true})`**: new mode that writes shadow_state and creates provisional
   self-only identity_map rows, but performs zero fan-out. Safe to call at any time on any
   channel without an `OnboardingRequiredError`.

2. **`discover()` from shadow_state**: reads entirely from the DB — no connector calls. Replaces
   the v8 live-fetch discover. Because it's pure DB, it is cheap, repeatable, and identical on
   every invocation (until the next `ingest`).

3. **`onboard()` with merged provisionals**: instead of creating fresh canonical UUIDs, fold the
   provisional canonicals created during `collectOnly` ingest into the matched canonical.
   `dbMergeCanonicals` updates both `identity_map` and `shadow_state.canonical_id` atomically.

4. **`addConnector()` from shadow_state**: same principle as `discover()` — reads C's
   `shadow_state` rather than fetching live. Requires that `ingest(C, {collectOnly: true})` was
   run first (throws a helpful error otherwise).

5. **Channel status semantics**: a connector that has been collected but not yet linked via
   `addConnector()` is **invisible** to `channelStatus()`. The channel stays `'ready'` for its
   currently-linked members while a new connector is being onboarded.

6. **Catch-up on `addConnector`**: changes that occurred in A/B while C was being collected are
   reconciled during `addConnector()` — not deferred to the next ingest. After `addConnector`
   returns, C is fully current. The following ingest is a no-op.

---

## Channel Status

```
uninitialized  →  no shadow_state rows for any channel member
collected      →  shadow rows exist, no cross-canonical links yet (pre-onboard)
ready          →  at least two members share cross-linked canonical_id rows
```

`'partially-onboarded'` is removed. A connector in the process of being added does not affect
the status of the channel — it is simply not yet a member. Once `addConnector()` commits, it
becomes a full member and the channel stays `'ready'`.

---

## `ingest({ collectOnly: true })`

```typescript
engine.ingest(channelId, connectorId, {
  batchId: crypto.randomUUID(),
  collectOnly: true,
})
```

**Behaviour:**

- Calls the connector's `read()` exactly as a normal ingest.
- For each record: strips `_`-prefixed meta fields, creates or retrieves a provisional
  canonical, writes `shadow_state`, writes `identity_map`. No `OnboardingRequiredError` check.
- Skips all fan-out: no calls to any other channel member's `insert()` or `update()`.
- Returns `RecordSyncResult[]` with `action: 'skip'` for every record (there are no writes).

**Provisional canonicals**: each record gets a self-only `identity_map` row
`(connector_id, external_id) → canonical_id`. These are provisional — they will be merged into
the true shared canonical by `onboard()` or `addConnector()`. They do not count as cross-links
and do not cause `channelStatus()` to return `'ready'`.

---

## `discover()` from shadow_state

```typescript
const report = await engine.discover(channelId);
```

**v9 change**: reads entirely from `shadow_state` — zero live connector calls.

**Requires**: `ingest({collectOnly: true})` has been run for every channel member. If any
member has no `shadow_state` rows, an error is thrown with a hint to run the collect step.

**Returns**: same `DiscoverReport` shape as v8. Matching logic (exact on `identityFields`,
case/whitespace-normalised) is unchanged.

Because there are no live calls, `discover()` is idempotent and cheap to call multiple times.
The report is a snapshot of the current shadow_state; re-running gives the same result until
a new `ingest({collectOnly: true})` is run.

---

## `onboard()` with merged provisionals

**v9 change**: rather than creating fresh canonical UUIDs for matched pairs (as v7/v8 did),
v9 folds the provisional canonical from one side into the provisional canonical from the other.

```
Before onboard:
  identity_map: (A, "a1") → canon-x    ← provisional
  identity_map: (B, "b1") → canon-y    ← provisional

After onboard (matched on email):
  identity_map: (A, "a1") → canon-x    ← kept
  identity_map: (B, "b1") → canon-x    ← merged: canon-y → canon-x
  shadow_state: B/"b1" canonical_id updated to canon-x
```

`dbMergeCanonicals(keepId, discardId)` performs this atomically. No new UUIDs are allocated for
matched records. Unmatched records (unique to one side) are propagated via direct `entity.insert()`
to the other side (bypassing shadow-diff, which would produce 'skip' since the shadow already
exists from the collect step).

---

## `addConnector()` — v9 changes

**v9 change 1 — reads from shadow_state, not live**: the joiner's records come from
`shadow_state` rows written during `ingest(C, {collectOnly: true})`. No live fetch.

**v9 change 2 — merges provisional canonicals**: matched entries go through `dbMergeCanonicals`
(same as `onboard()`), folding C's provisional canonicals into the existing canonical layer.

**v9 change 3 — catch-up on link**: after committing the identity links, `addConnector()`
compares C's collected snapshot (what C had when `collectOnly` was run) against the current
canonical fields (which reflect any A/B updates during the collection window). For each matched
record that has diverged, it calls `C.update()` and advances C's shadow. C is fully current
before `addConnector()` returns.

**v9 change 4 — fan-out guard in `_processRecords`**: while C is in the collected-but-not-linked
state, normal ingest from A or B skips fan-out to C. It detects this by querying for canonical_ids
shared by more than one connector (`crossLinkedConnectors`); C's provisional self-only canonicals
don't qualify. A's shadow advances normally (so A+B continue syncing as usual) — C simply
receives no writes until it is linked.

---

## Scenario (jsonfiles fixture)

| Connector | Records at collect time |
|-----------|------------------------|
| System A | Alice, Bob, Carol |
| System B | Alice, Bob, Carol |
| System C | Alice, Bob, Dave (Carol is missing; Dave is new) |

### Full flow

```
ingest(A, collectOnly)  → shadow_state[A]: Alice, Bob, Carol
ingest(B, collectOnly)  → shadow_state[B]: Alice, Bob, Carol
discover()              → matched: [(Alice,A)↔(Alice,B), (Bob,A)↔(Bob,B), (Carol,A)↔(Carol,B)]
onboard()               → 6 identity_map rows (3 canonicals × 2); propagates nothing (sets equal)
                          channelStatus → 'ready'

ingest(C, collectOnly)  → shadow_state[C]: Alice, Bob, Dave
                          channelStatus stays 'ready' (A+B unaffected)

[A/B sync normally during this window, e.g. Alice's name updated in A → synced to B, not C]

addConnector(C)         → matches Alice+Bob in C to existing canonicals
                          Dave (newFromJoiner) → inserted into A and B
                          Carol (missingInJoiner) → inserted into C
                          Alice catch-up → C.update("c1", { name: "Alice Updated" })
                          channelStatus → 'ready'

ingest(A), ingest(B), ingest(C) → 0 writes each
```

---

## Test Coverage (`engine.test.ts`)

| Suite | Tests |
|-------|-------|
| `ingest({ collectOnly: true })` | writes shadow_state; no fan-out; provisional canonicals; channelStatus = 'collected' |
| `discover() from shadow_state` | correct report without live calls; works after files deleted; normalises identityFields; errors helpfully if no shadow rows |
| `onboard() with merged provisionals` | 6 identity_map rows; canonical_id consistent per pair; unique records propagated; ingest after onboard = 0 writes; channelStatus = 'ready'; dryRun leaves DB clean |
| `A+B stays ready while C is collected` | ingest to A produces no fan-out to C; channelStatus stays 'ready'; addConnector catches up C immediately; post-addConnector ingest = 0 writes to C |
| `addConnector() with shadow-backed matching` | throws if C not pre-ingested; correct linked/new/missing counts; identity_map = 12 rows; Dave in A+B; Carol in C; 0 writes after; channelStatus = 'ready' |

23 tests, 55 assertions. All passing.

---

## What v9 Leaves Out

- **Fuzzy / probabilistic matching**: still exact on `identityFields` only.
- **Removing a connector** from a live channel (the inverse of `addConnector`).
- **Conflict resolution** when C's canonical value disagrees with A/B's: `addConnector` uses
  A/B's canonical as the authoritative value and writes it to C. C's own differing value is
  discarded on link. This may need revisiting if C should be allowed to "win" certain fields.
- **Multiple joiners at once**: `addConnector` handles one connector per call.
- **CLI / config-driven onboarding**: the flow is still exercised programmatically via the
  engine API.

---

## Key Design Decisions

**Why not suppress A's shadow when C is being collected?**
An earlier attempt held back A's shadow advancement so that the pending update would be
re-processed after `addConnector`. This broke A+B syncing: A re-processed every record on every
ingest, sending redundant writes to B. The correct fix is to let A sync normally and reconcile
the gap inside `addConnector` as a catch-up step. `addConnector` already has the current
canonical state; comparing it against C's collected snapshot is cheap and sufficient.

**Why merge provisionals rather than create new canonicals?**
Creating a new canonical UUID for each matched pair (as v7/v8 did) would require updating all
existing shadow_state rows that reference the old provisional canonical. `dbMergeCanonicals`
does this in a single `UPDATE` statement and avoids allocating IDs that are immediately retired.

**Why is `channelStatus` blind to unlinked collected connectors?**
A connector that has been collected but not yet committed via `addConnector` is not a channel
member in any operational sense. Including it in the status computation would force the channel
into a degraded state during a routine maintenance operation. The channel's observable behaviour
(A+B sync, fan-out, watermarks) is unaffected by C's presence in the engine config.

