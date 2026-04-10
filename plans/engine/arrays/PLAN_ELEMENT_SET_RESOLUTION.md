# Element-Set Resolution

**Status:** complete  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** Engine — array expansion, conflict resolution  
**Scope:** `packages/engine/src/engine.ts`, `specs/field-mapping.md`  
**Depends on:** `PLAN_NESTED_ARRAY_PIPELINE.md` (complete), `PLAN_ARRAY_COLLAPSE.md` (complete), `PLAN_FIELD_GROUPS.md` (complete — per-field resolution strategies), `PLAN_WRITTEN_STATE.md` (complete)  

---

## § 1 Problem

When multiple source connectors contribute elements to the same collapsed array — for example,
two connectors both manage line-items on the same order — the engine has no per-element
resolution strategy. The current behaviour is implicit last-write-wins (LWW) at the element
level: the collapse accumulates all patches; the last patch for a given element key wins.

Each element in the array should be resolvable using the same strategies already available for
flat fields. Without this, a multi-source nested array is not production-safe: a lower-priority
source can silently overwrite a higher-priority source's version of the same element.

### § 1.1 Current collapse patch accumulation

In `_applyCollapseBatch`, patches arrive in arrival order (the order sources are ingested in a
cycle). `patchNestedElement` merges each patch field-by-field into the element slot in the parent
data record. If two patches target the same element key (`elementKey`), the second patch wins for
any field it supplies — this is LWW by ingest order, which is not deterministic across cycles.

### § 1.2 Where conflict resolution is missing

For flat (non-array) records, `resolveConflicts` is called in `_processRecords` before dispatch.
It applies per-field strategies, per-field timestamps, and source priorities from
`this.conflictConfig`. For array child records (the expansion path), `resolveConflicts` is also
called per child element — but only once per element key per source connector. It resolves
correctly _within_ a single source's contribution. The gap is between sources: when two sources
both provide an element with the same `element_key`, there is no cross-source arbitration at
collapse time to pick the winning version of each element field.

### § 1.3 No new config surface

The existing channel `ConflictConfig` (`connectorPriorities`, `fieldStrategies`,
`fieldMasters`) already encodes the resolution intent for the channel. Introducing a separate
`elements_strategy` config key on mapping entries would be redundant and inconsistent: resolution
strategy is a channel-level concern, not something individual source members declare. The fix
is purely in engine internals — apply the existing `this.conflictConfig` at collapse time, just
as it is applied for flat records.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §3.2 (array expansion) | Add subsection "§3.2.5 Multi-source element resolution" documenting that the channel's `ConflictConfig` governs element-level cross-source arbitration at collapse time, in the same way it governs flat-record resolution. |
| `specs/field-mapping.md` | §10 coverage table | Update Element-set resolution row from 🔶 to ✅ once implemented. |
| `plans/engine/GAP_OSI_PRIMITIVES.md` | §9 Element-set resolution | Update from 🔶 to ✅. |

---

## § 3 Design

### § 3.1 Extend `CollapsePatch` with source identity and timestamps

The collapse patch batch for a given parent contains patches from all sources. Currently
`CollapsePatch` carries `sourceId` (the child external ID) but not which connector produced it,
and not per-field timestamps. Both are needed for cross-source arbitration.

```ts
type CollapsePatch = {
  childCanonId: string;
  resolved: Record<string, unknown>;
  hops: { arrayPath: string; elementKey: string }[];
  sourceId: string;
  sourceConnectorId: string;        // NEW — connector that produced this patch
  fieldTs?: Record<string, number>; // NEW — per-field timestamps from child shadow
};
```

`sourceConnectorId` is the ingesting `sourceMember.connectorId`, available at the push site.
`fieldTs` is populated from the child shadow's `FieldData` at the same push site (the child
shadow is already loaded at that point to compute `resolveConflicts`).

### § 3.2 Resolution at collapse time

Before iterating patches in `_applyCollapseBatch`, group them by element key and merge each
group into a single winner patch using `this.conflictConfig`:

1. Extract the leaf element key from each patch:
   ```ts
   const elemKey = patch.hops[patch.hops.length - 1]?.elementKey ?? "";
   ```
2. Group patches by `elemKey`. Groups with a single patch are trivially resolved (no change).
3. For each multi-patch group, produce one merged patch:
   - **Priority order (coalesce semantics):** sort by `connectorPriorities[sourceConnectorId]`
     ascending (lower number = higher priority; connectors absent from the map sort last).
     Apply patches from lowest priority to highest, so the highest-priority source's fields win
     by writing last — consistent with how `resolveConflicts` handles coalesce for flat fields.
   - **Per-field `last_modified`:** if `fieldStrategies` declares `last_modified` for a field,
     take the value from whichever source patch has the largest `fieldTs[field]` for that field.
     This mirrors the per-field timestamp logic in `resolveConflicts`.
   - **`fieldMasters`:** if a field has a declared master connector, always take that
     connector's value for the field when it is present in the patch group.
4. Replace the `patches` list with the merged one-per-element list before the existing patch
   loop.

When `conflictConfig` has no `connectorPriorities` and no `fieldStrategies`, the merge reduces
to applying patches in connector-declaration order (stable, deterministic LWW) — which is a
safe improvement over the current arrival-order LWW.

### § 3.3 Empty-patch (element-absence) interaction

The empty-patch branch of `_applyCollapseBatch` (element deletion) bypasses the patch loop and
goes directly to set-rebuild from `dbGetArrayChildrenByParent`. This path is unaffected by the
new logic — the surviving canonical children are already resolved individually via
`resolveConflicts` in the expansion pass.

---

## § 4 Implementation Steps

1. Extend `CollapsePatch` (local type in `engine.ts`) with `sourceConnectorId: string` and
   `fieldTs?: Record<string, number>` (§3.1).
2. At both collapse-patch push sites, populate the new fields from `sourceMember.connectorId`
   and the child shadow's field-timestamp map.
3. In `_applyCollapseBatch`, add a pre-loop grouping and merging step (§3.2).
4. Tests (see §5).
5. Spec updates.

No changes to `config/schema.ts`, `config/loader.ts`, or any YAML config surface.

---

## § 5 Test Cases

| ID | Scenario | Expected |
|----|----------|----------|
| ES1 | Two source connectors both provide same element key; `connectorPriorities` gives A higher priority; both provide the same field | A's value wins |
| ES2 | Same as ES1; A provides field X, B provides field Y (no overlap) | Both fields present; A wins X, B's Y is preserved |
| ES3 | `fieldStrategies` declares `last_modified` for field X; A has newer timestamp for X | A's value wins for X regardless of priority order |
| ES4 | `fieldStrategies: last_modified` for X; A newer for X, B newer for Y | X from A, Y from B |
| ES5 | No `connectorPriorities`; two sources; same element key | Stable connector-declaration-order LWW (no regression from current arrival-order LWW) |
| ES6 | Source A provides element key X; source B does not | A's element is present; no data loss |
| ES7 | `fieldMasters` declares connector A owns field `price`; B provides a different `price` | A's `price` wins regardless of ingest order |

---

## § 6 Out of Scope

- A dedicated `elements_strategy` config key — unnecessary; the channel `ConflictConfig`
  already expresses the same intent.
- Cross-channel element merging — elements from different channels contributing to the same
  target element. Not designed; deferred.
- Element-level group fields (`group:` config key inside element field mappings) — groups
  currently work on flat records. Extending group semantics into element resolution requires
  a design pass.
