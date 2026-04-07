# Plan: Multi-Level Nested Array Expansion

**Status:** complete  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** Engine  
**Scope:** `packages/engine/src/config/loader.ts`, `packages/engine/src/core/array-expander.ts`, `packages/engine/src/engine.ts`  
**Spec:** `specs/field-mapping.md §3.4` (Deep nesting), `specs/database.md`  
**Depends on:** PLAN_NESTED_ARRAY_PIPELINE.md (complete), PLAN_CROSS_CHANNEL_EXPANSION.md (complete)  
**Blocks:** PLAN_ARRAY_COLLAPSE.md — implementation of the reverse pass should not begin until this plan is complete, so the collapse pass handles multi-level from the start  

---

## § 1 Problem

The spec already describes deep nesting at `specs/field-mapping.md §3.4`:

> Multi-level parent chains. Supports arbitrary depth. Each level is a separate mapping block
> referencing the previous level as `parent`.
> **Status: planned follow-on — depends on §3.2 (OSI-mapping §3 "Deep nesting").**

Three specific gaps prevent it from working today:

**Gap 1 — Config loader only walks one level up.**  
When a grandchild entry declares `parent: "lines"`, the loader sets
`resolvedSourceEntity = parentEntry.entity` — where `parentEntry` is the child's config entry
whose `entity` is a logical name like `orders/lines` (not a real connector entity). The engine
then calls `connector.read("orders/lines")` and finds nothing.  The fix requires walking the
`parent` chain transitively to find the root (no-`parent`) ancestor and always setting
`sourceEntity` to that ancestor's `entity`.

**Gap 2 — `expandArrayRecord` expands one level only.**  
For `orders → lines → components` (two levels), `expandArrayRecord` receives an `orders`
record and a member whose `arrayPath = "components"`.  When it walks the dotted path it hits
`lines`, which is an array; the traversal aborts.  Multi-level expansion requires a chain:
first expand `lines` into intermediate element nodes, then expand `components` within each node.
This is a cross-join, not a dotted-path walk.

**Gap 3 — `array_parent_map` (from PLAN_ARRAY_COLLAPSE) only records one hop.**  
The collapse pass needs to walk up from grandchild → child → root before it can identify the
parent record to patch.  Both hops must be recorded at expansion time.  A single-hop table is
sufficient if we can walk the chain using the same table (each row is one hop); what's missing
is that the forward pass currently only records the leaf hop, not intermediate ones.

---

## § 2 Scope

**In scope:**
- New `ChannelMember.expansionChain` field carrying the full ordered chain from root to leaf
- Loader transitive parent-chain walk to build `expansionChain` and resolve `sourceEntity`
- New `expandArrayChain` function replacing `expandArrayRecord` for multi-level members
- Forward pass writes `array_parent_map` entries for every hop in the chain (not just the leaf)
- `collectOnly` path updated for the same chain expansion
- Single-level members continue to work unchanged (chain of length 1 = current behaviour)

**Out of scope:**
- Scalar arrays within a chain (`scalar: true` — §3.3, separate plan)
- Reverse pass (PLAN_ARRAY_COLLAPSE handles that; this plan makes it work at any depth)
- Cross-connector parent inheritance (already rejected by the loader; stays rejected)

---

## § 3 Spec Changes Planned

| File | Section | Change |
|------|---------|--------|
| `specs/field-mapping.md` | §3.4 | Replace "aspirational, planned follow-on" with the implemented design (chain walk, cross-join expansion, `expansionChain` member field) |
| `specs/field-mapping.md` | §3.2 | Add note: single-level expansion is the `expansionChain.length === 1` degenerate case; multi-level via §3.4 |

No changes to `specs/database.md` — `array_parent_map` is specified in PLAN_ARRAY_COLLAPSE and its multi-hop semantics are already correct once every hop is written.

---

## § 4 Design

### § 4.1 `ChannelMember.expansionChain`

New optional field on `ChannelMember`:

```typescript
expansionChain?: {
  arrayPath: string;
  elementKey?: string;
  parentFields?: Record<string, string | { path?: string; field: string }>;
}[];
```

Each entry represents one expansion level, ordered from outermost (closest to the root entity)
to innermost (this member's own level).  For a single-level member:

```
expansionChain = [{ arrayPath: "lines", elementKey: "lineNo", parentFields: { orderId: "orderId" } }]
```

For a grandchild member (`orders → lines → components`):

```
expansionChain = [
  { arrayPath: "lines",      elementKey: "lineNo"  },
  { arrayPath: "components", elementKey: "compNo"  },
]
```

`ChannelMember.arrayPath` and `ChannelMember.elementKey` continue to hold the **leaf level's**
values (for backward compatibility with single-level code paths that check `member.arrayPath`).
`expansionChain` is the authoritative source for expansion; when present and `length > 1` it
signals multi-level.

### § 4.2 Loader — transitive parent-chain walk

Current loader (one level):
```typescript
resolvedSourceEntity = parentEntry.entity;
```

Replace with a transitive walk that follows `parent` links until reaching the root
(no-`parent`) entry:

```typescript
function resolveExpansionChain(
  entry: MappingEntry,
  namedMappings: Map<string, MappingEntry>,
): { sourceEntity: string; chain: ExpansionChainLevel[] } {
  const chain: ExpansionChainLevel[] = [];
  let cursor: MappingEntry = entry;

  // Walk up, collecting levels from leaf to root, then reverse
  while (cursor.parent) {
    chain.push({
      arrayPath: cursor.array_path!,
      elementKey: cursor.element_key,
      parentFields: cursor.parent_fields as Record<string, ...> | undefined,
    });
    const parentEntry = namedMappings.get(cursor.parent)!;
    cursor = parentEntry;
  }
  // cursor is now the root (no parent); its entity is the connector entity to read
  const sourceEntity = cursor.entity!;
  chain.reverse(); // now outermost first
  return { sourceEntity, chain };
}
```

Validation: the existing cross-connector rejection applied only to the direct parent.  Extend
it to every hop: if any entry in the chain has a different `connector` from the root, reject.
(Same-connector invariant must hold at all depths.)

### § 4.3 `expandArrayChain` — cross-join multi-level expansion

Replace (or extend) `expandArrayRecord` with `expandArrayChain`:

```typescript
export function expandArrayChain(
  record: ReadRecord,
  chain: ExpansionChainLevel[],
): ReadRecord[]
```

Algorithm (recursive case, chain.length ≥ 2):

1. Expand the outermost level: treat the record as if `chain[0]` were the only level.
   Produce intermediate `ReadRecord[]` — these are the level-1 element records.
   Each intermediate record has `id = "${record.id}#${chain[0].arrayPath}[${elementKey}]"`.

2. For each intermediate record, recurse: `expandArrayChain(intermediate, chain.slice(1))`.
   Collect all results.

3. Return the flat union of all grandchild records.

Base case (`chain.length === 1`): identical to current `expandArrayRecord` logic.

The intermediate records produced in step 1 are **ephemeral** — they are never written to
shadow state or dispatched anywhere; they exist only to carry the element data for the next
level's expansion.  All parent-scope field propagation (`parentFields`) applies level by level:
each level's `parentFields` merges fields from that level's parent scope into the element data.

### § 4.4 Canonical ID composability

`deriveChildCanonicalId` is already compositionally correct and requires no changes:

```
childCanonId      = deriveChildCanonicalId(orderCanonId,  "lines",      "L01")
grandchildCanonId = deriveChildCanonicalId(childCanonId,  "components", "C01")
```

The SHA-256 inputs are distinct at each level, so grandchild UUIDs cannot collide with child
or parent UUIDs.

The intermediate canonical IDs (childCanonId at level 1) are computed in the expansion loop
but never written to `shadow_state` for the source side (matches existing spec §3.2 semantics:
source shadows are written only for the root parent entity).

### § 4.5 `array_parent_map` — write every hop

During forward expansion (both `_processRecords` and `collectOnly`), for each level in the
chain write one `array_parent_map` row:

```
Level 0 (outermost): (childCanonId,      orderCanonId,  "lines",      "L01")
Level 1 (leaf):      (grandchildCanonId, childCanonId,  "components", "C01")
```

The table structure is unchanged — it is a directed single-hop graph.  The collapse pass
walks it upward through as many hops as needed.

### § 4.6 Collapse chain walk (impact on PLAN_ARRAY_COLLAPSE)

`_dispatchToArrayTarget` (§4.4 of PLAN_ARRAY_COLLAPSE) currently does one lookup of
`array_parent_map` then one lookup of `identity_map`.  For multi-level, it must walk the
chain until it finds a `parentCanonId` that exists in `identity_map` for the target connector
(that is the root parent).  Along the way it collects each `(arrayPath, elementKey)` pair.

Walk pseudocode:

```
walkChain(db, canonId, targetConnectorId):
  hops = []
  cursor = canonId
  MAX_DEPTH = 16   // guard against cycles
  for depth in 0..MAX_DEPTH:
    row = dbGetArrayParentMap(db, cursor)
    if row is null: return { found: false }     // not seeded from forward pass
    hops.unshift({ arrayPath: row.arrayPath, elementKey: row.elementKey })
    if identity_map has (row.parentCanonId, targetConnectorId):
      return { found: true, rootExternalId: ..., hops }
    cursor = row.parentCanonId
  return { found: false }   // depth limit reached
```

`hops` is ordered root-to-leaf: `[{ "lines", "L01" }, { "components", "C01" }]`.

The nested-patch step (§4.7 of PLAN_ARRAY_COLLAPSE, extended here) then navigates the loaded
parent record using this hop list to locate and patch the target slot.

---

## § 5 Config example — two-level nesting

```yaml
# root — regular member of the 'orders' channel
- name: erp_orders
  connector: erp
  channel: orders
  entity: orders
  fields:
    - { source: orderId, target: orderId }

# level-1 child — expands lines from orders; member of 'order-lines' channel
- name: erp_order_lines
  connector: erp
  channel: order-lines
  parent: erp_orders
  array_path: lines
  element_key: lineNo
  parent_fields:
    orderId: orderId
  fields:
    - { source: lineNo,    target: lineNumber }
    - { source: productId, target: productId  }
    - { source: orderId,   target: orderRef   }

# level-2 grandchild — expands components from lines; member of 'line-components' channel
- name: erp_line_components
  connector: erp
  channel: line-components
  parent: erp_order_lines   # grandchild: walks up through erp_order_lines → erp_orders
  array_path: components
  element_key: compNo
  parent_fields:
    lineNo: lineNo
    orderId: orderId
  fields:
    - { source: compNo,     target: componentNumber }
    - { source: partSku,    target: sku             }
    - { source: lineNo,     target: lineRef         }
    - { source: orderId,    target: orderRef        }

# flat target — one record per component
- connector: warehouse
  channel: line-components
  entity: components
  fields:
    - { source: componentNumber, target: compNum  }
    - { source: sku,             target: itemCode }
    - { source: lineRef,         target: lineNum  }
    - { source: orderRef,        target: ordRef   }
```

Loader resolves `erp_line_components`:
- `sourceEntity = "orders"` (root of chain)
- `expansionChain = [{ arrayPath:"lines", elementKey:"lineNo" }, { arrayPath:"components", elementKey:"compNo" }]`

---

## § 6 Implementation Steps

1. **`packages/engine/src/config/loader.ts`**  
   - Add `expansionChain` to `ChannelMember` type  
   - Replace direct `resolvedSourceEntity = parentEntry.entity` with `resolveExpansionChain()` helper  
   - Extend cross-connector validation to all hops in the chain  

2. **`packages/engine/src/core/array-expander.ts`**  
   - Export new `expandArrayChain(record, chain)` function implementing §4.3  
   - Keep `expandArrayRecord` as a thin wrapper: `expandArrayChain(record, [{ arrayPath: member.arrayPath!, elementKey: member.elementKey, parentFields: member.parentFields }])`  
   - Both are exported; only `expandArrayChain` is called from the engine  

3. **`packages/engine/src/engine.ts`** — `_processRecords` array branch  
   - Replace `expandArrayRecord(record, sourceMember)` with `expandArrayChain(record, sourceMember.expansionChain ?? [{ arrayPath: sourceMember.arrayPath!, ... }])`  
   - Write `array_parent_map` for every hop in the expansion chain, not just the leaf  
   - Intermediate canonical IDs are computed in the expansion loop (level-by-level `deriveChildCanonicalId`) and used only for `array_parent_map` writes; not stored in shadow  

4. **`packages/engine/src/engine.ts`** — `collectOnly` fast path  
   - Same chain expansion as step 3  
   - Write `array_parent_map` for every hop  

5. **`specs/field-mapping.md`**  
   - §3.4: replace "aspirational" status with implemented spec from §4 of this plan  
   - §3.2: add cross-reference to §3.4 for the single-level degenerate case note  

6. **Tests** — `packages/engine/src/multilevel-array.test.ts`  
   - ML1: two-level config loads correctly — `sourceEntity = "orders"`, `expansionChain.length === 2`  
   - ML2: three-hop config (root → child → grandchild → great-grandchild) loads correctly  
   - ML3: cycle in parent chain is rejected at load time  
   - ML4: cross-connector hop is rejected at load time  
   - ML5: forward expansion — correct number of grandchild records produced  
   - ML6: grandchild external IDs follow composite `parent#path[key]#path[key]` formula  
   - ML7: grandchild canonical IDs are stable and distinct from parent/child IDs  
   - ML8: `array_parent_map` contains entries for every hop  
   - ML9: `collectOnly` expands correctly and writes all hop entries  
   - ML10: single-level member still works unchanged (backward compat)  

7. **`CHANGELOG.md`** — `### Added` entry

---

## § 7 Relationship to PLAN_ARRAY_COLLAPSE

PLAN_ARRAY_COLLAPSE must not be implemented until this plan is complete.  Update
PLAN_ARRAY_COLLAPSE's `Depends on:` field to include this plan.  The collapse pass's chain
walk (§4.6 of PLAN_ARRAY_COLLAPSE) should be written against the multi-level `array_parent_map`
from the start — the single-level case is just a chain of length 1.
