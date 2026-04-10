# Plan: Reverse Array Expansion (Array Collapse)

**Status:** complete  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** Engine  
**Scope:** `packages/engine/src/`  
**Spec:** `specs/field-mapping.md §3.2` (reverse pass section), `specs/database.md`  
**Depends on:** PLAN_NESTED_ARRAY_PIPELINE.md (complete), PLAN_CROSS_CHANNEL_EXPANSION.md (complete), PLAN_MULTILEVEL_ARRAY_EXPANSION.md (required — collapse pass must handle multi-level from the start)  

---

## § 1 Problem

The forward expansion pass (§3.2, already implemented) expands an ERP `orders.lines` array
into flat `webshop.lineItems` records.  The reverse is not implemented.  When webshop returns
modified `lineItems` records, the engine needs to write the change back into the correct slot
of the parent ERP order's embedded array.

The spec acknowledges this at `specs/field-mapping.md §3.2`:

> **Reverse pass:** Re-assembling expanded elements back into an embedded array for
> write-back to the source is not yet implemented.

This plan specifies and implements that reverse pass.

---

## § 2 Scope

**In scope:**
- New `array_parent_map` DB table populated during the forward pass
- `collectOnly` expansion support (needed for boot-phase discover/onboard)
- New `_dispatchToArrayTarget` dispatch path
- Per-parent batching of child patches within one ingest call
- Connector requirement: the parent entity (`orders`) must expose `update`

**Out of scope (deferred):**
- Array element deletion (removing a line from the embedded array)
- Reverse onboard for flat records that were never seeded from a forward pass
- Three-way conflict resolution at individual array-slot level
- **Multi-level nesting (grandchild arrays)** — covered by PLAN_MULTILEVEL_ARRAY_EXPANSION.md,
  which must be implemented first.  Once that plan is done, the collapse chain walk (§4.6)
  already handles arbitrary depth via repeated `array_parent_map` hops; no additional
  changes to this plan are needed.

---

## § 3 Spec Changes Planned

| File | Section | Change |
|------|---------|--------|
| `specs/field-mapping.md` | §3.2 reverse pass note | Replace "not yet implemented" paragraph with the implemented spec (§4 of this plan) |
| `specs/database.md` | Tables section | Add `array_parent_map` table definition |

---

## § 4 Design

### § 4.1 Why a new table is required

`deriveChildCanonicalId` is a one-way SHA-256 hash.  Given a child canonical UUID, the engine
cannot reconstruct which parent canonical ID it was derived from.  The `identity_map` table
maps `canonical_id ↔ (connector_id, external_id)` — it has no parent/child relationship.

The new `array_parent_map` table records this relationship at the time the forward pass runs:

```sql
CREATE TABLE IF NOT EXISTS array_parent_map (
  child_canon_id   TEXT NOT NULL PRIMARY KEY,
  parent_canon_id  TEXT NOT NULL,
  array_path       TEXT NOT NULL,
  element_key      TEXT NOT NULL
)
```

`element_key` stores the value of the element key (e.g. `"L01"`) so the collapse pass knows
which slot to patch without re-deriving a hash.

### § 4.2 Forward pass — populate the table

In `_processRecords` array branch, after `deriveChildCanonicalId`, add:

```typescript
dbUpsertArrayParentMap(db, childCanonId, parentCanonId, sourceMember.arrayPath, elementKeyValue);
```

Same write added to `collectOnly` expansion (§ 4.3 below).

### § 4.3 `collectOnly` expansion

Currently `collectOnly` stores parent-shaped rows under `entity = order_lines`.  For
bidirectionality to work during boot, `collectOnly` must expand and store child rows so that
`discover()` can match them against the flat records on the other side.

When `sourceMember.arrayPath` is set in the `collectOnly` fast path:

1. For each parent record, call `expandArrayRecord(record, sourceMember)` — same function as
   the forward pass.
2. For each child record, derive `childCanonId = deriveChildCanonicalId(parentCanonId, arrayPath, elementKeyValue)`.
3. Store shadow under `(connectorId, sourceMember.entity, childExternalId)` with the child
   canonical data (post-inbound-mapping).
4. Write `array_parent_map(childCanonId, parentCanonId, arrayPath, elementKeyValue)`.
5. Do NOT store a shadow for the parent record itself under `sourceMember.entity` (that would
   pollute the channel's entity namespace with order-shaped rows).

Parent canonical IDs from `collectOnly` are provisional (created by `_getOrCreateCanonical`)
just as they are in the normal forward pass — no change there.

### § 4.4 Reverse dispatch — `_dispatchToArrayTarget`

Called when the target `ChannelMember` has `arrayPath`.

Input: the resolved canonical record for one flat child, the child `canonId`, the target
`ChannelMember`, and the target `WiredConnectorInstance`.

Steps:

1. **Look up parent** — `dbGetArrayParentMap(db, canonId)`.  If not found (record was not
   seeded from a forward pass), return `{ type: "skip" }` with a warning.  Reverse onboard
   for "never seen" records is out of scope.

2. **Look up parent external ID** — query `identity_map` where
   `canonical_id = parent_canon_id AND connector_id = target_connector_id`.  If not found,
   skip.

3. **Load current parent** — try `targetEntityDef.lookup([parentExternalId])` first; fall back
   to parent shadow state if `lookup` is not available or throws.

4. **Find the array slot** — resolve `arrayPath` (dotted) on the loaded parent record; find
   the element whose `element_key` field matches the stored `element_key` value.

5. **Patch the slot** — apply `resolvedCanonical` fields to the element.  Only fields present
   in `resolvedCanonical` are patched; other fields in the slot are preserved.

6. **Write the parent** — call `targetEntityDef.update` with the full patched parent record
   (same external ID, patched data).

7. **Update parent shadow state** — write the patched parent record to shadow_state under
   `(connectorId, sourceEntity, parentExternalId)`.

8. Return `{ type: "ok", action: "update", targetId: parentExternalId, ... }`.

### § 4.5 Per-parent batching in `_processRecords`

**Problem without batching:** A single poll delivers lines L01 and L02 for the same order
`ord1`.  Without batching, `_dispatchToArrayTarget` runs twice: the first reads the order,
patches L01, writes; the second reads the order (the now-updated version), patches L02,
writes.  This is actually correct in terms of final state IF the second read fetches the
latest state — but it means two round-trips to the connector.

**Better approach:** Group all flat child records by `parent_canon_id` before dispatching to
any array-collapse target.  Per parent group, apply all element patches in one pass, then
write the parent once.

In `_processRecords`, after the standard per-record loop handles echo detection and shadow
state for the flat source, add a post-loop grouping step for each target member with
`arrayPath`:

```
pendingPatches: Map<parentCanonId, { canonId, resolved, elementKey }[]>

for each record:
  child_canon_id = dbGetExternalId(db, ...) or derive from identity via shadow
  parent_entry = dbGetArrayParentMap(db, child_canon_id)
  if parent_entry: pendingPatches[parent_entry.parent_canon_id].push(...)

for each parentCanonId in pendingPatches:
  load parent → apply all patches → write once
```

This requires that the standard echo-detection and shadow-state-update loop still runs for
the flat source side (so ERP's perspective stays in sync), and the array-collapse dispatch
is deferred to the post-loop batch phase.

### § 4.6 Config compatibility

No new config keys are required.  The existing `array_path`, `source_entity`, `parent_fields`,
and `element_key` keys on the array-expansion member already contain all the information
needed.  The engine distinguishes direction by whether the member with `arrayPath` is the
source or the target of a given `ingest()` call.

### § 4.7 Connector requirement

The parent entity (`orders`) must expose `update` on the array-expansion side.  The engine
writes a full patched record (not a partial patch) — array element shape is connector-specific
so a full replace is the safest general contract.  Connectors that expose `lookup` benefit
from a fresher base record; those without fall back to shadow state.

---

## § 5 Implementation Steps

1. **`packages/engine/src/db/migrations.ts`**  
   Add `CREATE TABLE IF NOT EXISTS array_parent_map (...)`.

2. **`packages/engine/src/db/queries.ts`** (or equivalent db helpers file)  
   Add `dbUpsertArrayParentMap`, `dbGetArrayParentMap`.

3. **`packages/engine/src/engine.ts`** — `_processRecords` array branch  
   After `deriveChildCanonicalId`, call `dbUpsertArrayParentMap`.

4. **`packages/engine/src/engine.ts`** — `collectOnly` fast path  
   When `sourceMember.arrayPath`: expand records, store child shadows, write
   `array_parent_map`, skip parent-level shadow write.

5. **`packages/engine/src/engine.ts`** — new `_dispatchToArrayTarget`  
   Implement §4.4 logic.

6. **`packages/engine/src/engine.ts`** — `_dispatchToTarget`  
   Before the `if (!targetEntityDef?.insert || !targetEntityDef?.update) return skip` early
   return, add: `if (targetMember.arrayPath) return this._dispatchToArrayTarget(...)`.

7. **`packages/engine/src/engine.ts`** — `_processRecords` standard path  
   Add post-loop batching step for array-collapse targets (§4.5).

8. **`specs/field-mapping.md §3.2`**  
   Replace "not yet implemented" note with implemented spec (§4 above).

9. **`specs/database.md`**  
   Add `array_parent_map` table.

10. **Tests**  
    New test file `packages/engine/src/array-collapse.test.ts`:  
    - AC1: round-trip — forward expand to flat connector, edit flat record, reverse collapse patches ERP array slot  
    - AC2: two lines updated in one poll → single parent write  
    - AC3: unknown child (never forward-expanded) → skip with no error  
    - AC4: `collectOnly` expansion stores child shadows → `discover()` matches them against flat side  
    - AC5: partial patch — only mapped fields overwritten, other element fields preserved  
    - AC6: noop suppression — unchanged line does not trigger parent write

11. **`CHANGELOG.md`** — `### Added` entry

---

## § 6 Relationship to the Playground Plan

`PLAN_ARRAY_DEMO_SCENARIO.md` currently seeds webshop empty and relies on the forward pass
only.  Once this plan is implemented, the playground plan should be updated to:
- Seed webshop `lineItems` with pre-existing records (the contrast the user wants to see)
- Remove the lifecycle guard that skips `collectOnly` for array channels (once `collectOnly`
  correctly expands, boot-phase discover/onboard works for the flat side)
- Demonstrate a webshop lineItem edit propagating back into the ERP embedded array
