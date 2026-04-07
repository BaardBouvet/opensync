# Hard Delete: Entity Absence and Element Absence Detection

**Status:** proposed  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** Engine — deletion, array expansion  
**Scope:** `packages/engine/src/engine.ts`, `packages/engine/src/db/queries.ts`, `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `specs/field-mapping.md`  
**Depends on:** `PLAN_DELETE_PROPAGATION.md` (for entity-level fan-out; detection and shadow marking are independent)  
**Blocks:** nothing (but element delete fully exercises the collapse + `written_state` pipeline)  

---

## § 1 Problem Statement

Two "hard delete" primitives are documented in `specs/field-mapping.md §8.3` and referenced in
`GAP_OSI_PRIMITIVES.md §6` as unimplemented. Both became addressable after `written_state`
(`PLAN_WRITTEN_STATE`) and nested-array expansion/collapse landed.

### § 1.1 Entity absence (flat records)

A full-snapshot connector (e.g. `jsonfiles`, a CSV import) reads the **entire current dataset**
every cycle. If a record that was previously ingested is absent from today's batch, it has been
deleted in the source. The engine has no mechanism to detect this — the old `shadow_state` row
lives on and continues contributing stale values to resolution.

The PLAN_DELETE_PROPAGATION spec (detection mode 2, mark-and-sweep) covers this but is blocked
on `PLAN_FULL_SYNC_SIGNAL` (which adds a `ReadBatch.complete` signal). This plan takes a
simpler, config-driven approach: a `full_snapshot: true` flag on the mapping member tells the
engine that every read is a complete dataset, so any ID absent from the batch is deleted.

### § 1.2 Element absence (nested arrays)

When a source delivers an updated parent record with fewer array elements than the previous
ingest, those missing elements have been deleted from the source array. The engine currently:

1. Expands the current elements and writes/updates their `shadow_state` rows.
2. Does **not** touch the shadow rows for elements that were present before but are absent now.

The stale element shadow rows keep contributing to the canonical resolution. The next collapse
write to a target will include those ghost elements in the reassembled array.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §8.3 | Update status to "implemented". Replace stub with full config syntax, algorithm description, safety guard, and constraint that it implies `fullSync: true`. |
| `specs/field-mapping.md` | §8 (new sub-section) | Add §8.5 "Element absence detection" documenting the algorithm for clearing stale child shadow rows after array expansion. |
| `specs/field-mapping.md` | Summary table | Update Hard delete and Element hard delete rows from ❌ to ✅. |

No new spec sections needed — `§8.3` already has a placeholder. The algorithm text below defines
the canonical behaviour; the spec update reproduces it.

---

## § 3 Design

### § 3.1 Entity absence (`full_snapshot: true`)

#### Config surface

`full_snapshot: true` is added as an optional boolean on a mapping entry (flat members only;
array expansion members inherit the parent's read behaviour):

```yaml
channels:
  contacts:
    - connector: jsonfiles
      channel: contacts
      entity: contacts
      full_snapshot: true
```

Schema change (`config/schema.ts`): add `full_snapshot: z.boolean().optional()` to
`ChannelMemberEntrySchema`.

Loader change (`config/loader.ts`): thread `fullSnapshot?: boolean` on `ChannelMember`.

Implication: `full_snapshot: true` implies a full-dataset read. The engine always passes
`since = undefined` regardless of stored watermark for this `(connectorId, entityName)` pair.
This is implemented by checking `sourceMember.fullSnapshot` in `ingest()` when computing `since`.

#### Detection algorithm

In `ingest()`, after the record-collection loop and before `_processRecords`:

```ts
// § 3.1 — entity absence detection for full-snapshot members
if (sourceMember.fullSnapshot) {
  const returnedIds = new Set(allRecords.map((r) => r.id));
  const knownRows = dbGetAllShadowForEntity(db, connectorId, sourceMember.entity);
  // Safety: if the batch returned nothing and there are known rows, treat as suspect —
  // do not synthesize mass deletes from an empty read (connector error or config mistake).
  if (returnedIds.size > 0 || knownRows.length === 0) {
    const missingIds = knownRows
      .filter((r) => !returnedIds.has(r.externalId))
      .map((r) => r.externalId);
    // Circuit-breaker volume guard (reuses existing breaker thresholds)
    const deletionRatio = knownRows.length > 0 ? missingIds.length / knownRows.length : 0;
    if (deletionRatio > FULL_SNAPSHOT_DELETE_RATIO_GUARD) {
      // Emit circuit-breaker event; skip absence detection for this cycle
    } else {
      for (const externalId of missingIds) {
        allRecords.push({ id: externalId, data: {}, deleted: true });
      }
    }
  }
}
```

The synthesized `{ id, deleted: true }` records are appended to `allRecords` and flow through
the existing `_processRecords` path. When `PLAN_DELETE_PROPAGATION` is implemented, those records
will trigger the full delete-dispatch path. Until then, they reach `_processRecords` where the
`record.deleted` flag is currently unhandled — so this plan also needs to add the minimal shadow
marking: set `deleted_at` on the shadow row and skip further processing.

#### Minimum viable delete handling (no PLAN_DELETE_PROPAGATION dependency)

A thin guard in `_processRecords`, before canonical resolution:

```ts
if (record.deleted === true) {
  const existing = dbGetShadowRow(db, sourceMember.connectorId, sourceMember.entity, record.id);
  if (existing) {
    dbMarkDeleted(db, sourceMember.connectorId, sourceMember.entity, record.id);
    results.push({ entity: sourceMember.entity, action: "skip", sourceId: record.id,
                   targetConnectorId: "", targetId: record.id });
  }
  continue;
}
```

`dbMarkDeleted` is a new query function that sets `deleted_at = now` on the shadow row (the
helper is already designed in `PLAN_DELETE_PROPAGATION.md §Phase 3`) — this plan adds it. Fan-out
dispatch is left to `PLAN_DELETE_PROPAGATION`.

#### Constant

```ts
const FULL_SNAPSHOT_DELETE_RATIO_GUARD = 0.5; // more than 50% missing → suspect
```

Configurable in the future; hard-coded for now.

### § 3.2 Element absence (nested array expansion)

#### Detection point

In `_processRecords`, inside the `if (sourceMember.arrayPath)` branch, after expanding the
current elements and writing their shadow rows (the existing loop over
`expandArrayChain(record, chain, ...)`):

```ts
// § 3.2 — element absence detection
// After the current expansion, find all previously-known element shadows for this
// parent and array path.  Delete any whose element key is no longer present.
const currentElementExternalIds = new Set(childRecords.map((cr) => cr.id));
const previousElements = dbGetChildShadowsForParent(
  db, connectorId, sourceMember.entity, provisionalParentId, chain[0].arrayPath,
);
for (const prev of previousElements) {
  if (!currentElementExternalIds.has(prev.externalId)) {
    dbDeleteShadow(db, connectorId, sourceMember.entity, prev.externalId);
    // Ensure a collapse write is triggered for this parent, even if parent unchanged.
    deletedElementParents.add(provisionalParentId);
  }
}
```

`deletedElementParents` is a `Set<string>` collected across the entire `_processRecords` call.
After the main loop, for every `parentCanonId` in `deletedElementParents`, force-trigger the
collapse path:

```ts
// § 3.2 — force collapse for parents with deleted elements
for (const parentCanonId of deletedElementParents) {
  for (const ctMember of collapseTargets) {
    const perTarget = pendingCollapsePatches.get(ctMember) ?? new Map<string, CollapsePatch[]>();
    // Empty patch list = "write the array with current canonical state" (no new elements,
    // just omit the deleted ones via written_state comparison during collapse).
    if (!perTarget.has(parentCanonId)) {
      perTarget.set(parentCanonId, []);
      pendingCollapsePatches.set(ctMember, perTarget);
    }
  }
}
```

The collapse dispatch (`_applyCollapseBatch`) already reads all child canonical IDs for the
parent from `array_parent_map` and resolves them. With the deleted shadow row gone, the deleted
element no longer has a shadow contribution; if it had no contribution from any other source,
it will not appear in the resolved canonical set and will be absent from the reassembled array.

#### New query: `dbGetChildShadowsForParent`

```ts
export function dbGetChildShadowsForParent(
  db: Db,
  connectorId: string,
  entityName: string,
  parentCanonId: string,
  arrayPath: string,
): Array<{ externalId: string; canonicalId: string }> {
  return db.prepare<{ external_id: string; canonical_id: string }>(
    `SELECT ss.external_id, ss.canonical_id
       FROM shadow_state ss
       JOIN array_parent_map apm ON apm.child_canon_id = ss.canonical_id
      WHERE ss.connector_id  = ?
        AND ss.entity_name   = ?
        AND apm.parent_canon_id = ?
        AND apm.array_path      = ?
        AND ss.deleted_at IS NULL`,
  ).all(connectorId, entityName, parentCanonId, arrayPath)
   .map((r) => ({ externalId: r.external_id, canonicalId: r.canonical_id }));
}
```

#### `_applyCollapseBatch` with empty patch list

Currently `_applyCollapseBatch` requires at least one patch to know which parent to write to.
An empty patch list means "re-assemble and write using the current canonical state only, with
no new element data to merge". The method needs to handle this path:

- Compute the set of all child canonical IDs from `array_parent_map` for `(rootCanonId, arrayPath)`.
- For each child, call `dbGetCanonicalFields` to get current resolved values.
- Run the existing assembly + sort + write-back path with that set.
- If the set is empty (all elements deleted), write back an empty array.

This is a small extension to `_applyCollapseBatch` — the current patch-driven path already does
the equivalent work; the empty-patch path is just the same without the merge step.

#### `written_state` cleanup

After a successful collapse write, the engine calls `dbUpsertWrittenState`. The deleted element's
`written_state` row (if one existed from a prior write) should be removed:

```ts
// After collapse write succeeds, delete written_state rows for elements no longer in array
for (const deletedCanonId of absentCanonIds) {
  dbDeleteWrittenState(db, ctMember.connectorId, ctMember.entity, deletedCanonId);
}
```

New query `dbDeleteWrittenState`:

```ts
export function dbDeleteWrittenState(
  db: Db,
  connectorId: string,
  entityName: string,
  canonicalId: string,
): void {
  db.prepare(
    `DELETE FROM written_state
      WHERE connector_id = ? AND entity_name = ? AND canonical_id = ?`,
  ).run(connectorId, entityName, canonicalId);
}
```

---

## § 4 New DB Helpers Summary

| Function | File | Purpose |
|----------|------|---------|
| `dbMarkDeleted` | `db/queries.ts` | Set `deleted_at` on a shadow row (already designed in PLAN_DELETE_PROPAGATION) |
| `dbGetChildShadowsForParent` | `db/queries.ts` | Return all non-deleted shadow rows for a parent's array path (JOIN `array_parent_map`) |
| `dbDeleteWrittenState` | `db/queries.ts` | Remove a `written_state` row after an element is confirmed absent from the reassembled array |

---

## § 5 Safety Properties

| Risk | Mitigation |
|------|-----------|
| Empty-batch false positives (connector error returns nothing) | `returnedIds.size === 0 && knownRows.length > 0` → skip absence detection for this cycle |
| Mass deletion from corrupt snapshot | `deletionRatio > 0.5` → circuit-breaker guard, no deletes |
| Stale element phantom-write after parent collapse | `dbDeleteWrittenState` removes stale row; next cycle won't re-write absent element |
| Multi-level nesting: grandchild element deleted | `dbGetChildShadowsForParent` joins only one hop; must be called at each expansion level in the chain. For `PLAN_MULTILEVEL_ARRAY_EXPANSION` multi-level chains, repeat detection at each depth. |

---

## § 6 Tests

All tests in `packages/engine/src/`:

### § 6.1 Entity absence (`HD` prefix)

| ID | Description |
|----|-------------|
| HD1 | After full-snapshot ingest, a record absent from batch has `deleted_at` set in shadow_state |
| HD2 | Record absent → subsequent resolution excludes its shadow contribution |
| HD3 | Record absent → `full_snapshot: true` forces `since = undefined` (no watermark used) |
| HD4 | Empty-batch safety: no deletions synthesized when returned set is empty and known rows exist |
| HD5 | Circuit-breaker volume guard: > 50% absent → no deletions, circuit-breaker event emitted |
| HD6 | Resurrection: absent record re-appears in next batch → `deleted_at` cleared, treated as update |

### § 6.2 Element absence (`EA` prefix)

| ID | Description |
|----|-------------|
| EA1 | Element present in previous expansion, absent from updated parent → shadow row deleted |
| EA2 | Element deleted from source → absent from reassembled array on next collapse write to target |
| EA3 | Element deleted from source → `written_state` row for that element is removed after collapse |
| EA4 | Element deleted then re-added (resurrection) → new shadow row written, element reappears |
| EA5 | Multiple elements deleted in one ingest cycle → all absent from reassembled array |
| EA6 | Parent-level echo detection suppressed: even if parent fields unchanged, collapse fires when element was deleted |
| EA7 | No-op when no elements were deleted: collapse not triggered by absence detection path |

---

## § 7 Relationship to PLAN_DELETE_PROPAGATION

This plan provides:
- `full_snapshot: true` config flag and absence detection loop.
- `dbMarkDeleted` helper (sets `deleted_at`; fan-out is a no-op stub).
- Element shadow clearing and forced collapse trigger.

`PLAN_DELETE_PROPAGATION` provides:
- Fan-out dispatch: calling `entity.delete()` on target connectors for `shadow.deleted_at`-marked records.
- `propagateDeletes: true` channel config.
- Circuit-breaker integration with the fan-out path.

The two plans are independent and can ship in either order. Shipping this plan first gives
correct shadow-state semantics and collapse writes without cross-system delete dispatch.
Shipping `PLAN_DELETE_PROPAGATION` first gives explicit delete dispatch without absence
detection. Both are needed for the full hard-delete experience.
