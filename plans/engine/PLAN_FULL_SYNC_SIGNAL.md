# PLAN_FULL_SYNC_SIGNAL — First-class full-sync tracking

> **Status:** draft
> **Date:** 2026-04-05

Spec changes planned:
- `specs/connector-sdk.md` § Entities — add `ReadBatch.complete` field
- `specs/sync-engine.md` § collectOnly mode — replace snapshotAt watermark rationale with full-sync tracking

---

## Problem

The engine needs to know whether a connector has ever successfully returned its **complete**
dataset for a given entity. This is required for onboarding:

- `discover()` compares shadow state from two or more connectors to find matched and unique
  records. If either connector's shadow state is incomplete, records will be misclassified as
  unique-to-one-side when they actually exist on both sides but simply weren't returned yet.
- `onboard()` propagates unique-per-side records to the other connector. If the "unique" record
  is actually present on the other side but was missed, `onboard()` creates a duplicate.

Currently the engine has no reliable way to know if a `collectOnly` read returned everything.
The connector's `read(ctx, since=undefined)` is supposed to mean "return all records", but the
contract doesn't enforce it and the engine cannot verify it.

The engine works around this by misusing watermarks: it stores a fabricated ISO timestamp after
`collectOnly` so the next normal poll is incremental. But this leaks the engine's internal
state-tracking concern into the watermark field, which is supposed to be opaque and
connector-owned.

---

## Root cause analysis

Three distinct concerns are conflated today:

| Concern | Current mechanism | Problem |
|---------|------------------|---------|
| "Is polling incremental or full?" | `since = undefined` → full | The connector decides; the engine can't verify |
| "Has this connector been fully collected?" | Watermark presence (fabricated) | Misuse; watermarks are connector-owned |
| "Is this the last batch of a paginated full scan?" | Implicit (stream ends) | No explicit signal; no way to know the scan was complete vs interrupted |

---

## Options considered

### Option A — `ReadBatch.complete: boolean` (explicit terminal marker)

Add a `complete` flag to `ReadBatch`. When `true`, the connector asserts "this batch closes a
full scan; I have returned everything". The engine records a `full_sync_at` for this
(connectorId, entity).

```typescript
interface ReadBatch {
  records: ReadRecord[];
  since?: string;
  complete?: boolean;  // true = this closes a complete dataset scan
}
```

**Pros:**
- Explicit, verifiable from the engine's side
- Works for both single-batch and paginated full scans (only the last batch sets `complete`)
- Connectors that don't support verifiable full syncs simply never set it
- Engine can block onboarding until both sides have `complete = true` in their session

**Cons:**
- Connector authors must remember to set it
- Paginated connectors must track whether they're on the last page

### Option B — `EntityDefinition.fullSyncOnly: boolean` (declarative capability)

Some connectors (e.g. jsonfiles, simple REST APIs without cursor support) always return the full
dataset — there is no "cursor" concept. They can declare this statically.

```typescript
interface EntityDefinition {
  // ...
  fullSyncOnly?: boolean;  // every read() returns the complete dataset
}
```

When `fullSyncOnly: true`, the engine implies `complete = true` on every batch automatically.
When `false` (default), the connector must signal `complete` explicitly.

**Pros:**
- Zero extra work for connectors that already return everything (like jsonfiles)
- Accurate: the connector knows its own read semantics

**Cons:**
- Doesn't help cursor-based APIs, which are the harder case

### Option C — Separate `readAll(ctx)` method

Add a distinct `readAll()` that is only called for onboarding collection. The engine interprets
exhaustion of the async iterable as "complete".

**Rejected:** Requires all connectors to implement a second read method. `read(ctx, undefined)`
already means "full sync" in the existing contract. The issue is verification, not a missing
method.

### Option D — Engine-side `full_sync_at` table, no SDK change (internal only)

The engine tracks `full_sync_at` per `(connectorId, entityName)` internally, set when:
- `read(ctx, undefined)` returns without error AND the connector yielded at least one batch

This does not verify completeness; it only tracks that a full-sync-attempt completed
successfully. Useful as a baseline even without connector cooperation.

**Pros:** Zero SDK/connector changes required  
**Cons:** Still doesn't prove complete coverage; doesn't help with paginated APIs

---

## Recommendation

**Adopt Options A + B together.** They are complementary, not competing.

- **Option B** (`fullSyncOnly`) handles the simple case — jsonfiles, any connector that reads
  an entire data source on every call. The connector declares it once and the engine handles it.
- **Option A** (`ReadBatch.complete`) handles the general case — cursor-based connectors can
  signal the terminal batch.
- **Option D** as a fallback: if neither flag is present and neither `fullSyncOnly: true` nor
  any `complete: true` was seen, the engine logs a warning that collection completeness is
  unverified and proceeds on best-effort basis. This preserves backward compatibility.

The engine tracks `full_sync_at` per `(connectorId, entityName)` in a new `sync_state` table
(or a column on `watermarks`). `discover()` and `onboard()` check this and emit a warning
(or optionally block with an error) if it's missing.

---

## Implementation plan

### 1. SDK changes

Add to `ReadBatch` in `packages/sdk/src/types.ts`:
```typescript
/** Set to true on the final batch of a complete dataset scan (full sync).
 *  Tells the engine this connector has returned all records for this entity.
 *  Omit on incremental (since-filtered) reads and on intermediate pages.
 *  Connectors that set fullSyncOnly: true on the entity do not need to set this. */
complete?: boolean;
```

Add to `EntityDefinition` in `packages/sdk/src/types.ts`:
```typescript
/** When true, every call to read() returns the complete dataset (no cursor, no filtering).
 *  The engine treats every read() result as a complete full sync automatically.
 *  Default: false. */
fullSyncOnly?: boolean;
```

### 2. DB schema change

Add to `packages/engine/src/db/migrations.ts`:
```sql
CREATE TABLE IF NOT EXISTS sync_state (
  connector_id  TEXT NOT NULL,
  entity_name   TEXT NOT NULL,
  full_sync_at  INTEGER,           -- epoch ms of last verified complete scan
  PRIMARY KEY (connector_id, entity_name)
);
```

### 3. Engine changes

In `ingest()`:
- After consuming all batches, if `entity.fullSyncOnly === true` OR any batch had
  `complete === true`, write `full_sync_at = Date.now()` to `sync_state`.

In `collectOnly` path: same logic — `full_sync_at` is set when collection is verified complete.

In `discover()`: check that all members have a `full_sync_at` entry. If not, emit a warning
in the `DiscoveryReport` (new field: `collectionWarnings?: string[]`). Do not block — the
engine can't always know, and the user may have manually verified completeness.

### 4. Update existing connectors

- `connector-jsonfiles`: set `fullSyncOnly: true` on all entities (it reads the whole file)
- `connector-mock-crm`, `connector-mock-erp`: set `complete: true` on the last batch in
  `read()` (they return everything in one shot)
- Real connectors (`hubspot`, `postgres`, etc.): set `complete: true` on the terminal batch
  of a full sync; omit on incremental reads

### 5. Spec changes

- `specs/connector-sdk.md` § Entities: document `ReadBatch.complete` and
  `EntityDefinition.fullSyncOnly` with semantics and examples
- `specs/sync-engine.md` § collectOnly: replace the snapshotAt watermark rationale with
  `full_sync_at` tracking. Remove the Gap 1 language.

---

## What this does NOT solve

- **Gap 1 (records written during collect window):** This is a separate problem from
  collection completeness. Even with `complete: true`, a record written between the connector's
  last read and the engine committing the shadow state could be missed on the first incremental
  poll. That problem belongs to the connector's watermark semantics — a connector that returns
  `batch.since = max_seen_watermark` will always miss such records. A connector that returns
  `batch.since = start_of_read` (captured before the first API call) covers the window
  correctly. This is a connector concern, not an engine concern.

- **Soft deletes / mark-and-sweep:** Knowing we received a complete snapshot enables periodic
  reconciliation (mark records absent from a full scan as deleted). That is out of scope for
  this plan but becomes possible once `full_sync_at` exists.
