# Scalar Array Collapse (Reverse Pass)

**Status:** complete  
**Date:** 2026-04-10  
**Effort:** M  
**Domain:** Engine — array expansion, collapse  
**Scope:** `packages/engine/src/engine.ts`, `packages/engine/src/core/array-expander.ts`, `specs/field-mapping.md`  
**Depends on:** `PLAN_SCALAR_ARRAYS.md` (complete — forward pass), `PLAN_ARRAY_COLLAPSE.md` (complete — object element collapse)  

---

## § 1 Problem

The forward pass for scalar arrays is complete: `scalar: true` on a mapping entry wraps each
bare-scalar element as `{ _value: element }`, assigns the string form of the value as the element
identity, and fans out to target connectors (`PLAN_SCALAR_ARRAYS.md`).

The reverse (collapse) pass does not handle `scalar: true` members. `collapseTargets` already
includes scalar members (the `arrayPath != null` filter), but `_applyCollapseBatch` applies
`patchNestedElement` which produces object elements — it never unwraps `_value` back to a bare
scalar. The result is that a scalar source member never receives a coherent collapse write-back.

The two differences from object-element collapse:

1. **Write-back format**: the reassembled array must contain bare scalars (e.g. `["vip",
   "churned"]`), not objects.
2. **Patch representation**: object collapse merges field-by-field into an existing element slot.
   For scalar arrays each element _is_ the value — there is no slot to merge; the array is
   rebuilt fresh as a set.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §3.3 Scalar arrays | Replace "Reverse pass (collapse) is not yet implemented" with the implemented algorithm: `_value` unwrap, set-rebuild strategy, ordering by first-seen `_ordinal` when present. Update status line. |
| `specs/field-mapping.md` | §10 coverage table | Update scalar arrays row from 🔶 to ✅. |
| `specs/field-mapping.md` | Open gaps list | Remove scalar array collapse bullet. |

---

## § 3 Design

### § 3.1 Collapse strategy for scalar arrays

Because scalar array elements _are_ their value (the element key equals `String(element)`), there
is no partial-field merging to do. The collapse write-back should always rebuild the entire array
from the known live canonical children:

**Single-level scalar** (single-hop chain — `parent.arrayPath` is the target): rebuild directly
on the root record.

1. Detect that the target member has `scalar: true`.
2. Skip `patchNestedElement` entirely.
3. Collect all live canonical children (from `dbGetArrayChildrenByParent`).
4. For each child, call `dbGetCanonicalFields` and apply the target's outbound mapping.
5. Unwrap the `_value` field (§3.2) and collect the scalar values.
6. If `order: true` is declared, sort by `_ordinal` ascending.
7. Assign the rebuilt scalar array directly to `patchedData[collapseTarget.arrayPath]` and
   dispatch.

**Multi-level scalar** (leaf of a multi-hop chain — e.g. `orders → lines[*].tags`):

The intermediate hops navigate to an object element inside the root record; the scalar array
lives as a property of that intermediate element. The algorithm is:

1. Group patches by root canonical ID as usual.
2. For each root parent, navigate the intermediate hops using the existing
   `patchNestedElement` traversal logic to locate the intermediate parent object in
   `patchedData` (all hops except the final scalar leaf hop).
3. At the leaf level, instead of field-merging, rebuild the scalar array for that intermediate
   element:
   - Query `dbGetArrayChildrenByParent` using the **intermediate** element's canonical ID
     (the parent of the scalar children) and the leaf `arrayPath`.
   - Apply the same set-rebuild, `_value` unwrap, filter, and sort as single-level (steps 3–6).
4. Assign `intermediateElement[leafArrayPath] = rebuiltScalarArray`.
5. Dispatch the root record update.

This is structurally identical to the single-level case once the intermediate parent element is
located.

### § 3.2 `fields:` mapping convention for scalar collapse

The outbound mapping (written back to the source connector) is derived from the same `fields:`
entries as the inbound mapping — `applyMapping` is called with direction `"outbound"`, which
swaps `source` and `target`. For scalar members, the target connector needs to receive the bare
scalar value at the field name it expects for each element.

The engine unwraps `_value` from the outbound-mapped record after `applyMapping`. If a field
entry maps `source: _value` on the source side, `applyMapping "outbound"` inverts that to
produce `{ _value: canonicalValue }` for the collapse — the engine then extracts `localData["_value"]`
as the bare scalar.

If no field entry has `source: _value`, the engine falls back to reading `localData["_value"]`
directly (the canonical name used by the forward pass). This means a scalar collapse target with
no `fields:` at all still works — every canonical `_value` becomes an element in the rebuilt array.

Example — tags channel where ERP expands and CRM receives the collapse:

```yaml
# Source side (ERP scalar expansion)
- channel: contact-tags
  parent: erp_contacts
  array_path: tags
  scalar: true
  fields:
    - source: _value
      target: tagName    # canonical name

# Target side (CRM scalar collapse)
- connector: crm
  channel: contact-tags
  entity: contact_tags
  array_path: crm_tags
  scalar: true
  fields:
    - source: tagName    # canonical → this becomes source on the outbound pass
      target: _value     # _value extracted by engine as the bare scalar element
```

### § 3.3 `reverse_filter` interaction

`reverse_filter` on a scalar member receives the bare scalar as the `element` binding (consistent
with how `filter` works on the forward pass). Elements whose filter expression returns falsy are
excluded from the rebuilt array.

### § 3.4 `order: true` interaction

When `order: true` is declared, each child's canonical fields contain `_ordinal`. Sort the rebuilt
scalar array by `_ordinal` ascending before write-back. Elements without `_ordinal` sort last.
This is consistent with `PLAN_ARRAY_ORDERING.md` semantics.

### § 3.5 Element deletion (scalar element hard delete)

Element absence detection (§8.5 in `specs/field-mapping.md`) already runs for scalar members as
part of the general array-expansion path — the same `dbGetChildShadowsForParent` check fires
regardless of `scalar`. An empty-patch collapse is enqueued when elements go missing. The
empty-patch branch of `_applyCollapseBatch` handles this via the full set-rebuild path
(§3.1 above) — no additional logic is needed.

### § 3.6 `patchNestedElement` gap for multi-level scalar

`patchNestedElement` currently locates leaf elements by looking up a field name:
```ts
const idx = arr.findIndex(
  (el) => String((el as Record<string, unknown>)[leafFieldName ?? ""]) === lastHop.elementKey,
);
```
Bare scalars are not objects, so this lookup always returns `-1` for a scalar leaf hop. For the
multi-level collapse implementation, **the leaf hop is handled separately** (§3.1 multi-level
algorithm): we stop traversal one hop before the scalar leaf and assign the rebuilt scalar array
to the intermediate element's property. `patchNestedElement` is not called for the scalar leaf
hop at all — the set-rebuild is an assignment, not a merge.

---

## § 4 Implementation Plan

### Step 1: Detect scalar target in `_applyCollapseBatch`

Add a `scalar` field check at the top of `_applyCollapseBatch`. When the `collapseTarget` member
has `scalar: true`:
1. Skip the `patchNestedElement` loop.
2. Determine whether this is single-level or multi-level (inspect `collapseTarget.expansionChain`
   length).
3. Execute the appropriate set-rebuild path (§3.1).

### Step 2: Single-level scalar set-rebuild helper

For a single-hop scalar member: query `dbGetArrayChildrenByParent(rootCanonId, leafPath)`,
map each child to its `_value`, apply filter and ordinal sort, assign to
`patchedData[collapseTarget.arrayPath]`.

### Step 3: Multi-level scalar set-rebuild

For a multi-hop scalar member: use the existing intermediate-hop navigation (reuse the loop from
`patchNestedElement`, stopping one hop before the scalar leaf) to reach the intermediate parent
object. Then query `dbGetArrayChildrenByParent(intermediateCanonId, leafPath)` where
`intermediateCanonId` is retrieved via `dbGetCanonicalId` for the intermediate external ID.
Apply the same set-rebuild, filter, and sort. Assign to `intermediateElement[leafPath]`.

### Step 4: Forward pass verification

The forward pass for multi-level scalar chains (leaf `scalar: true` inside a multi-hop
`expansionChain`) already propagates correctly through `expandArrayChain` → `expandArrayRecord`
because `scalar: level.scalar` is passed at each chain step. Add a test to confirm this works
end-to-end before tackling the collapse (to avoid debugging two gaps at once).

### Step 5: `_value` unwrapping

After `applyMapping(fields, collapseTarget.outbound, "outbound")`, extract the scalar:

```ts
const scalarValue = localData["_value"] ?? undefined;
if (scalarValue !== undefined) rebuiltArray.push(scalarValue);
// If _value is missing after mapping, the element contributed no value — skip.
```

### Step 6: Tests

Extend `packages/engine/src/delete-propagation.test.ts` or create a dedicated test file.
Required test cases:

| ID | Scenario |
|----|----------|
| SC1 | Scalar array — new tag syncs to target; collapse reassembles scalar array correctly |
| SC2 | Scalar array — updated tag (value changed) propagates as set change |
| SC3 | Scalar array — deleted tag (element absence) removed from target array |
| SC4 | Scalar array — `reverse_filter` excludes matching element from collapse write-back |
| SC5 | Scalar array with `order: true` — elements sorted by `_ordinal` on write-back |
| SC6 | Scalar array with no outbound mapping — `_value` field used as raw scalar |
| SC7 | Multi-level scalar (2-hop chain: `orders → lines[*].tags`) — forward pass produces correct leaf IDs and canonical rows |
| SC8 | Multi-level scalar — collapse writes rebuilt scalar array into correct intermediate element slot |

---

## § 5 Out of Scope

- `scalar: true` at a **non-leaf** position in a multi-level chain (e.g. `orders.tags[*]` where
  tags elements are then further expanded). A scalar value cannot have sub-arrays; this
  configuration is rejected at load time by the existing `element_key` + `scalar` mutual-exclusion
  validation combined with the fact that a scalar element has no named fields to carry
  a further `array_path` from.
- `order_linked_list: true` on scalar members — linked-list ordering on a value-identity set
  has no clear semantics; remain mutually exclusive (existing config validation covers this).
