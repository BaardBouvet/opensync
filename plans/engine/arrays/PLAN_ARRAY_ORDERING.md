# Plan: Nested Array Ordering (Custom Sort, CRDT Ordinal, CRDT Linked-List)

**Status:** complete  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** Engine, field-mapping  
**Scope:** `packages/engine/src/`  
**Spec:** `specs/field-mapping.md §6`  
**Depends on:** PLAN_ARRAY_COLLAPSE.md (complete), PLAN_MULTILEVEL_ARRAY_EXPANSION.md (complete)  

---

## § 1 Problem

Nested array expansion (§3.2/§3.4) and array collapse (§3.2 reverse) are implemented. The
engine can expand an embedded array into child records, diff them individually, and re-assemble
them into the parent record on write-back. What is missing is any **control over the order in
which elements appear in the reassembled array**.

Without ordering support:

- Elements are written back in the order they happen to be in `patchedData` after patching —
  whatever order the source connector last returned them in when the parent shadow was captured.
- When two sources contribute elements, the merged array order is undefined and may differ on
  every run.
- Sources that encode semantics in array position (ordered line items, steps in a workflow,
  Notion-style block trees) will silently receive garbled order from the engine.

The spec documents three ordering primitives at `specs/field-mapping.md §6`. All three depend
on nested array expansion and collapse being available first, which is now the case.

---

## § 2 Scope

**In scope:**
- `order_by`: post-collapse sort of the leaf array by declared field names (asc/desc, multi-key).
- `order: true` (CRDT ordinal): forward-pass injection of a synthetic `_ordinal` field from
  source array position; sort by it during collapse; strip before write-back.
- `order_linked_list: true` (CRDT linked-list): forward-pass injection of `_prev` / `_next`
  pointer fields from adjacency in source array; linked-list reconstruction during collapse;
  strip before write-back.
- All three strategies applied at the **leaf level** of the `expansionChain`. Intermediate
  levels in a multi-level expansion are not sorted by this feature.
- Config schema (`schema.ts`), loader (`loader.ts`), `ExpansionChainLevel`, `ChannelMember`,
  `array-expander.ts` utilities, `engine.ts` collapse pass.
- Spec update: `specs/field-mapping.md §6`.

**Out of scope:**
- Per-level ordering in multi-level expansions (each `expansionChain` level specifying its own
  `order_by`). Not blocked, but deferred — leaf ordering covers the primary use-case.
- Ordering during the forward pass (element order on the ingest side is already determined by
  source array position).
- Ordering for non-array (flat) entity sets. Out of concept; `order_by` only applies to child
  members that have `array_path`.

---

## § 3 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §6 intro | Remove "aspirational, depends on §3.2" note. Confirm §3.2 is implemented. |
| `specs/field-mapping.md` | §6.1 Custom sort | Expand stub to full design: `order_by` key, multi-field sort, applied at collapse time after all patches, before write-back. |
| `specs/field-mapping.md` | §6.2 CRDT ordinal | Expand stub: `order: true`, `_ordinal` injection on forward pass, LWW resolution across sources, sort during collapse, strip on write-back. |
| `specs/field-mapping.md` | §6.3 CRDT linked-list | Expand stub: `order_linked_list: true`, `_prev`/`_next` injection, head-finding + pointer-following reconstruction, graceful fallback on broken chains, strip on write-back. |
| `specs/field-mapping.md` | §9 feature table | Update `❌` to `✅` for all three ordering rows. |

No changes needed to `specs/connector-sdk.md`, `specs/sync-engine.md`, or `specs/database.md`.

---

## § 4 Design

### § 4.1 Config additions

Add three optional keys to `MappingEntrySchema` in `packages/engine/src/config/schema.ts`.
These keys are only meaningful on child mapping entries (those with `parent:` + `array_path:`).
Config validation should warn but not hard-error if they appear on non-child entries.

**`order_by`** — custom field sort:

```yaml
order_by:
  - field: lineNumber
    direction: asc   # default
  - field: productCode
    direction: desc
```

Zod type:

```ts
export const OrderByFieldSchema = z.object({
  field: z.string(),
  direction: z.enum(["asc", "desc"]).default("asc"),
});
// On MappingEntrySchema:
order_by: z.array(OrderByFieldSchema).optional(),
```

**`order`** — CRDT ordinal:

```yaml
order: true
```

```ts
// On MappingEntrySchema:
order: z.boolean().optional(),
```

**`order_linked_list`** — CRDT linked-list:

```yaml
order_linked_list: true
```

```ts
// On MappingEntrySchema:
order_linked_list: z.boolean().optional(),
```

The three strategies are mutually exclusive per mapping entry. Config loading must reject
(throw) any mapping entry that specifies more than one of `order_by`, `order`, and
`order_linked_list` simultaneously.

---

### § 4.2 Loader propagation

`ExpansionChainLevel` (in `packages/engine/src/config/loader.ts`) gains three optional fields
that mirror the resolved config:

```ts
export interface ExpansionChainLevel {
  arrayPath: string;
  elementKey?: string;
  parentFields?: Record<string, string | { path?: string; field: string }>;
  // Ordering (specs/field-mapping.md §6):
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  crdtOrder?: boolean;
  crdtLinkedList?: boolean;
}
```

`ChannelMember` gains the same three mirror fields at the top level (for the leaf member,
matching the existing pattern for `arrayPath`, `elementKey`, `parentFields`):

```ts
orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
crdtOrder?: boolean;
crdtLinkedList?: boolean;
```

The loader populates these when building the `ChannelMember` for a child entry and when
building the last `ExpansionChainLevel` entry in `expansionChain`.

---

### § 4.3 Forward pass — CRDT field injection

CRDT ordinal and linked-list require the engine to inject **synthetic fields** into each
expanded element record on the forward pass. This happens inside `expandArrayRecord` in
`packages/engine/src/core/array-expander.ts`, after element identity is determined but before
`mergedData` is pushed into `childRecords`.

**CRDT ordinal (`crdtOrder: true`):**

```ts
if (member.crdtOrder) {
  mergedData["_ordinal"] = i;   // 0-based source position
}
```

`_ordinal` becomes a normal field in the child's `NormalizedRecord.data`. It enters shadow
state, participates in conflict resolution (LWW / coalesce against the same field from other
sources), and is available in `resolved` on the reverse pass. The winning `_ordinal` value
determines the element's final position in the reassembled array.

**CRDT linked-list (`crdtLinkedList: true`):**

```ts
if (member.crdtLinkedList) {
  const prevEl = node[i - 1] ?? null;
  const nextEl = node[i + 1] ?? null;
  const keyField = member.elementKey;
  mergedData["_prev"] = prevEl !== null && keyField
    ? String((prevEl as Record<string, unknown>)[keyField] ?? i - 1)
    : (i > 0 ? String(i - 1) : null);
  mergedData["_next"] = nextEl !== null && keyField
    ? String((nextEl as Record<string, unknown>)[keyField] ?? i + 1)
    : (i < node.length - 1 ? String(i + 1) : null);
}
```

`_prev` is the element key value of the preceding sibling, or `null` for the head.
`_next` is the element key value of the following sibling, or `null` for the tail.

Both fields enter shadow state and participate in resolution. During a merge from two sources
the LWW winner's pointer set determines the reconstructed order.

---

### § 4.4 Collapse pass — sort application

Sorting is applied in `_applyCollapseBatch` in `packages/engine/src/engine.ts`, immediately
after all patches have been merged into `patchedData` and before the `update()` call.

A new utility `applySortToLeafArray` is added to `array-expander.ts`:

```ts
export function applySortToLeafArray(
  rootData: Record<string, unknown>,
  chain: ExpansionChainLevel[],
  member: Pick<ChannelMember, "orderBy" | "crdtOrder" | "crdtLinkedList" | "elementKey">,
): void
```

It navigates down through the intermediate chain levels the same way `patchNestedElement`
does (matching on `elementKey`, following `arrayPath`), and applies the requested sort to the
**leaf array only**. The call site in `_applyCollapseBatch` is:

```ts
if (collapseTarget.orderBy || collapseTarget.crdtOrder || collapseTarget.crdtLinkedList) {
  for (const rootCanonId of /* unique root IDs in batch */) {
    applySortToLeafArray(patchedData, chain, collapseTarget);
  }
}
```

`_applyCollapseBatch` already operates on one parent (`patchedData`) at a time, so the loop
above degenerates to a single call per `_applyCollapseBatch` invocation.

#### Sort algorithm details

**Custom sort (`orderBy`):**

Multi-key comparison: iterate `orderBy` entries in order. Convert field values to numbers if
both sides parse as finite numbers; otherwise compare as locale-insensitive strings.
Respect `direction: "desc"` by negating the comparison result.

**CRDT ordinal (`crdtOrder`):**

Sort by `_ordinal` ascending. `_ordinal` is numeric so numeric comparison applies. Elements
with no `_ordinal` field (e.g. elements added directly by a target connector without going
through the forward pass) sort last, preserving their existing relative order.

**CRDT linked-list (`crdtLinkedList`):**

Reconstruct ordered sequence from `_prev` / `_next` pointer fields:

1. Build a map `key → {prev, next}` from all current array elements using `member.elementKey`
   (or index as string if absent).
2. Find the head: the element whose `_prev` is `null` or not present.
3. Walk `_next` pointers to build the ordered list.
4. If the walk terminates before all elements are placed (e.g. a cycle or broken pointer),
   append remaining elements in their current relative order.
5. Replace the leaf array in-place with the reconstructed order.

---

### § 4.5 Field stripping on write-back

`_ordinal`, `_prev`, and `_next` are engine-internal synthetic fields.  They should not appear
in the element data written to target connectors unless the user explicitly maps them via an
outbound `FieldMapping`.

Stripping happens inside `applySortToLeafArray` (or a companion helper), applied to the
elements **after** sorting but before the array is embedded in `patchedData` which is then
handed to `update()`.  The strip step:

```ts
function stripCrdtFields(
  arr: Record<string, unknown>[],
  member: Pick<ChannelMember, "crdtOrder" | "crdtLinkedList" | "outbound">,
): void {
  const mappedFields = new Set(member.outbound?.map((f) => f.source) ?? []);
  for (const el of arr) {
    if (member.crdtOrder && !mappedFields.has("_ordinal")) delete el["_ordinal"];
    if (member.crdtLinkedList && !mappedFields.has("_prev")) delete el["_prev"];
    if (member.crdtLinkedList && !mappedFields.has("_next")) delete el["_next"];
  }
}
```

A user who wants the connector to receive `_ordinal` (e.g. to persist ordering in the source)
can add a `forward_only` outbound field mapping from `_ordinal` to their preferred field name.

---

### § 4.6 Multi-level array interaction

For multi-level expansions (`expansionChain.length > 1`) the sort applies to the **leaf** array
only, navigating through intermediate levels by looking up the matching element at each hop
using the existing `patchNestedElement` traversal logic.

`applySortToLeafArray` accepts the full `expansionChain` and traverses intermediate hops the
same way `patchNestedElement` does: for each non-leaf hop, locate the matching parent element
in the intermediate array using the hop's `elementKey` value stored in `array_parent_map` for
the batch's root.

Because `_applyCollapseBatch` processes all patches for a single root entity together, there is
exactly one intermediate path to navigate per invocation.

---

## § 5 Tests

New test file: `packages/engine/src/array-ordering.test.ts`.

All tests use the standard inline connector + `Engine.ingest()` / `Engine.applyMapping()`
harness established by `nested-array.test.ts` and `multilevel-array.test.ts`.

| ID | Covers | Scenario |
|----|--------|----------|
| OR1 | Custom sort — single field asc | Two elements arrive patched in reverse order; `order_by: [{field: lineNumber, direction: asc}]`; collapse writes them sorted ascending by `lineNumber`. |
| OR2 | Custom sort — single field desc | Same but `direction: desc`; elements sorted descending. |
| OR3 | Custom sort — multi-field | Primary field tied on two elements; secondary field breaks the tie; correct order. |
| OR4 | Custom sort — numeric vs string | Values `"2"`, `"10"`, `"1"` — numeric sort gives `1,2,10`; string sort would give `1,10,2`; verify numeric path taken. |
| OR5 | Custom sort — identity for single element | Single element: sort is a no-op; no error. |
| OR6 | CRDT ordinal — forward injection | After ingest, child shadow state records include `_ordinal` equal to source array index. |
| OR7 | CRDT ordinal — collapse sort | Elements patched by a source that reversed their order; collapse restores order via `_ordinal`; `_ordinal` absent from written element. |
| OR8 | CRDT ordinal — multi-source LWW | Two sources provide different ordinals for the same element; LWW winner's ordinal determines position. |
| OR9 | CRDT ordinal — elements without `_ordinal` sort last | An element added directly by target connector (no `_ordinal`) appears after all engine-tracked elements. |
| LL1 | Linked-list — forward injection | After ingest, first element has `_prev: null`, last has `_next: null`, middle element's `_prev`/`_next` point to correct neighbours. |
| LL2 | Linked-list — collapse reconstruction | Three elements stored in wrong order in parent shadow; `_prev`/`_next` fields intact; collapse reconstructs correct linked-list order; pointer fields absent from written elements. |
| LL3 | Linked-list — broken chain graceful fallback | `_next` pointer of element A points to a non-existent element key; reconstruction places A then appends remaining elements in their existing relative order; no error thrown. |
| LL4 | Linked-list — cycle guard | Pointers form a cycle with no null `_prev`; a cycle guard (max iterations = array length) breaks out; elements appended in existing order rather than looping; no error. |
| MX1 | Mutual exclusion validation | Mapping entry with both `order: true` and `order_linked_list: true` → `loadConfig` throws a descriptive error. |
| MX2 | Ordering on non-child entry | `order_by` on a mapping entry with no `parent:` → warning emitted, no error (order has no effect). |
| ML1 | Multi-level + sort | Two-level expansion; `order: true` only on the leaf child; intermediate array untouched; leaf array sorted by `_ordinal`. |

---

## § 6 Implementation Order

1. **Config + loader** — add `order_by` / `order` / `order_linked_list` to `MappingEntrySchema`,
   propagate to `ExpansionChainLevel` and `ChannelMember`, add mutual-exclusion validation.
   Tests MX1, MX2.

2. **CRDT forward injection** — extend `expandArrayRecord` to inject `_ordinal` / `_prev` /
   `_next` based on `member.crdtOrder` / `member.crdtLinkedList`.
   Tests OR6, LL1.

3. **Sort utilities** — add `applySortToLeafArray` and `stripCrdtFields` to `array-expander.ts`
   as pure functions, covered by unit tests independent of the engine.

4. **Collapse integration** — wire `applySortToLeafArray` into `_applyCollapseBatch` after all
   patches are applied.
   Tests OR1–OR5, OR7–OR9, LL2–LL4, ML1.

5. **Spec update** — update `specs/field-mapping.md §6` subsections and feature table.

6. **Update `GAP_OSI_PRIMITIVES.md`** — change all three ordering rows from `❌` to `✅`.
