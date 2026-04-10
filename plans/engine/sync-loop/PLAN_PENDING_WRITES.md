# PLAN_PENDING_WRITES — Retry failed fan-out writes

**Status:** draft  
**Date:** 2026-04-07  
**Effort:** S  
**Domain:** engine  
**Spec changes planned:** `specs/sync-engine.md` — new § "Pending Write Retry"  

---

## Problem

When a change from connector A fans out to B and C, and C's write fails, the engine
silently drops the dispatch:

1. `_dispatchToTarget` returns `{ type: "error" }` for C.
2. In `_processRecords`, C is never added to `outcomes[]` and `hadErrors = true` is set.
3. The atomic commit at the end of the record loop unconditionally writes **A's source
   shadow** with the new values, along with B's shadow (which succeeded).
4. **Nothing is written for C** — no shadow update, no `written_state` row, and no
   retry entry.

On the next ingest from A:

- Echo detection compares A's incoming record against A's **updated** shadow (step 3
  already advanced it).
- They match → `action: "skip"` → C is **never retried**.

The change to C is permanently lost unless A produces another external change to the same
record, or a `fullSync: true` is triggered — but `fullSync` only clears the `since`
watermark; echo detection still fires and suppresses the re-dispatch because A's shadow
already reflects the new value.

This is independent of batch size or the incremental engine work (GAP-I1/I2). It exists
in the current architecture for any single failed dispatch.

---

## Root cause

The invariant is broken: **A's source shadow should not advance past a version that has
not been successfully delivered to all reachable targets.**

The `deferred_associations` mechanism handles a structurally identical problem (records
that cannot be dispatched due to a missing identity link) by writing a sticky retry row
and re-running the lookup+dispatch loop on the next ingest. Plain write failures have no
equivalent mechanism.

---

## Proposed fix

### § 1 New table — `pending_writes`

Add to `packages/engine/src/db/migrations.ts`:

```sql
-- Spec: plans/engine/PLAN_PENDING_WRITES.md §1
CREATE TABLE IF NOT EXISTS pending_writes (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  source_connector     TEXT    NOT NULL,
  entity_name          TEXT    NOT NULL,
  source_external_id   TEXT    NOT NULL,
  target_connector     TEXT    NOT NULL,
  failed_at            INTEGER NOT NULL,
  UNIQUE (source_connector, entity_name, source_external_id, target_connector)
)
```

Modelled on `deferred_associations`. The unique constraint is an upsert guard: a second
failure for the same `(source, entity, extId, target)` tuple before the first is resolved
simply updates `failed_at` (via `INSERT OR REPLACE`).

### § 2 Write a row on dispatch error

In `_processRecords`, in the dispatch-error branch:

```typescript
// Before (current):
if (dispatchResult.type === "error") {
  results.push({ ..., action: "error", ... });
  hadErrors = true;
  continue;
}

// After:
if (dispatchResult.type === "error") {
  results.push({ ..., action: "error", ... });
  hadErrors = true;
  dbInsertPendingWrite(
    this.db,
    sourceMember.connectorId, sourceMember.entity, record.id,
    targetMember.connectorId,
  );
  continue;
}
```

### § 3 Clear the row on dispatch success

In the atomic commit block, after `dbRemoveDeferred`, add:

```typescript
dbRemovePendingWrite(
  this.db,
  sourceMember.connectorId, sourceMember.entity, record.id,
  o.shadowData.connectorId,
);
```

This ensures that when A later changes the same record and the dispatch to C succeeds,
the pending row is cleaned up automatically.

### § 4 Retry loop in `ingest()`

After the existing deferred-association retry block, add a pending-writes retry block
with the same structure:

```typescript
// Spec: plans/engine/PLAN_PENDING_WRITES.md §4
// Retry any fan-out writes that failed in a previous ingest cycle.
const pending = dbGetPendingWrites(this.db, connectorId, sourceMember.entity);
if (pending.length > 0) {
  const sourceEntityDef = source.entities.find((e) => e.name === sourceMember.entity);
  if (sourceEntityDef?.lookup) {
    const uniqueIds = [...new Set(pending.map((p) => p.source_external_id))];
    // Exclude records already processed in this ingest cycle (fresh data wins)
    const alreadyProcessed = new Set(allRecords.map((r) => r.id));
    const idsToLookup = uniqueIds.filter((id) => !alreadyProcessed.has(id));
    if (idsToLookup.length > 0) {
      const lookedUp = await sourceEntityDef.lookup(idsToLookup, source.ctx);
      if (lookedUp.length > 0) {
        // skipEchoFor: source shadow was already advanced when the failure occurred,
        // so echo detection would otherwise suppress the re-dispatch.
        const retryIds = new Set(lookedUp.map((r) => r.id));
        const retryResults = await this._processRecords(
          channelId, sourceMember, lookedUp, batchId, ingestTs, retryIds,
        );
        results.push(...retryResults);
      }
      // Records lookup returned nothing for → source deleted, clean up pending rows
      const returnedIds = new Set(lookedUp.map((r) => r.id));
      for (const id of idsToLookup) {
        if (!returnedIds.has(id)) {
          for (const row of pending.filter((p) => p.source_external_id === id)) {
            dbRemovePendingWrite(
              this.db, connectorId, sourceMember.entity, id, row.target_connector,
            );
          }
        }
      }
    }
  }
}
```

### § 5 `skipEchoFor` in `_processRecords`

The `skipEchoFor` parameter already exists (added for deferred-associations retry). No
change needed to the signature. Pass the set of looked-up record IDs exactly as the
deferred retry does.

---

## DB helper functions

Add to `packages/engine/src/db/queries.ts` (or wherever the deferred helpers live):

```typescript
export function dbInsertPendingWrite(
  db: Db, sourceConnector: string, entityName: string,
  sourceExternalId: string, targetConnector: string,
): void

export function dbGetPendingWrites(
  db: Db, sourceConnector: string, entityName: string,
): Array<{ source_external_id: string; target_connector: string }>

export function dbRemovePendingWrite(
  db: Db, sourceConnector: string, entityName: string,
  sourceExternalId: string, targetConnector: string,
): void
```

---

## Edge cases

**`lookup()` not available on the source connector.**  
If `read()` cannot fetch individual records, the pending write cannot be retried
automatically. The row stays in `pending_writes` indefinitely. The only recovery is a
full-sync triggered externally (which also won't help with echo detection — see below).  
For now: log a warning once per ingest cycle if `pending_writes` rows exist but no
`lookup()` is available. A future plan can add a "force push current shadow" path that
bypasses echo detection explicitly.

**Record deleted at source before retry.**  
`lookup()` returns nothing for the ID → pending rows cleaned up (§4). Delete propagation
is a separate concern (see `PLAN_DELETE_PROPAGATION.md`).

**Circuit breaker open.**  
The ingest guard at the top of `ingest()` returns early before the retry block is
reached. Pending rows accumulate. Once the breaker closes, the next ingest drains them.
This is correct behaviour — no change needed.

**Same record fails for the same target twice.**  
The `UNIQUE` constraint on `pending_writes` with `INSERT OR REPLACE` ensures only one
row exists per `(source, entity, extId, target)`. `failed_at` is refreshed. No unbounded
growth.

**Retry itself fails.**  
`_processRecords` writes a new `pending_writes` row (§2) and the row stays. Retry
frequency matches ingest cadence — no explicit backoff is added in this plan. The
circuit breaker provides coarse-grained backoff at the channel level.

---

## Difference from `deferred_associations`

| | `deferred_associations` | `pending_writes` |
|---|---|---|
| Trigger | `_remapAssociations` returns `null` (identity link not yet established) | `_dispatchToTarget` returns `{ type: "error" }` |
| Expected? | Yes — timing condition during onboarding | No — transient connector failure |
| Data reuse | Record is looked up fresh on retry | Record is looked up fresh on retry |
| Echo bypass | Yes — `skipEchoFor` passed | Yes — `skipEchoFor` passed (same reason) |
| Cleared on | Successful dispatch in any subsequent `_processRecords` pass | Successful dispatch in any subsequent `_processRecords` pass |

The implementation pattern is identical; only the trigger differs.

---

## Spec changes planned

- **`specs/sync-engine.md`** — add new section "§ Pending Write Retry" describing the
  `pending_writes` table, when rows are written (dispatch error), when they are consumed
  (retry loop in `ingest()`), and the `lookup()`-required constraint.  
  No other spec files need changes.

---

## Implementation steps

1. Add `pending_writes` table to `migrations.ts`.
2. Add DB helpers (`dbInsertPendingWrite`, `dbGetPendingWrites`, `dbRemovePendingWrite`).
3. Write failing tests:
   - A→B+C where C returns an error on first dispatch; assert C receives the record on the next ingest from A even with no external change at A.
   - A→B+C where C errors twice then succeeds; assert the pending row is cleared after success.
   - Source record deleted before retry; assert pending row is cleaned up.
4. In `_processRecords`: write `pending_writes` row on dispatch error; clear it on success.
5. In `ingest()`: add retry block after the deferred-associations block.
6. Update `specs/sync-engine.md` with the new section.
7. Update `CHANGELOG.md`.
