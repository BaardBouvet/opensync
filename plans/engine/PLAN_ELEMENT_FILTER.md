# Plan: Element-Level Filters on Array Expansion Members

**Status:** complete  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** Engine  
**Scope:** `specs/field-mapping.md`, `specs/config.md`, `packages/engine/src/config/`, `packages/engine/src/core/array-expander.ts`, `packages/engine/src/engine.ts`  
**Spec:** `specs/field-mapping.md §3.2`, `specs/config.md`  
**Depends on:** PLAN_NESTED_ARRAY_PIPELINE.md (complete), PLAN_ARRAY_COLLAPSE.md (complete)  

---

## § 1 Spec Changes Planned

| File | Section | Change |
|------|---------|--------|
| `specs/field-mapping.md` | §3.2 — Array expansion | Add `filter` and `reverse_filter` keys; document forward/reverse evaluation, short-circuit semantics, independent-axis note, and the split-routing pattern |
| `specs/config.md` | Mapping entry keys | Add `filter` and `reverse_filter` to the mapping entry key table with types and valid expressions |

---

## § 2 Problem

Array expansion members currently claim **all** elements at a given `array_path`. There is no
way to route a subset of elements to one channel and the remainder to another.

### § 2.1 Split-routing pattern

A common requirement: one `array_path` (e.g. `lines`) contains elements of multiple types
(e.g. `type: "product"` and `type: "service"`). Two flat target systems want only their
respective types:

```yaml
# channel: product-lines
- connector: erp
  parent: erp_orders
  array_path: lines
  filter: "element.type === 'product'"
  element_key: lineNo
  ...

# channel: service-lines
- connector: erp
  parent: erp_orders
  array_path: lines
  filter: "element.type === 'service'"
  element_key: lineNo
  ...
```

Without a filter, both channels receive every element. Both produce the same derived canonical
IDs (because `deriveChildCanonicalId` is deterministic), so `identity_map` would link them as
the same entity — which is wrong when the two channels map to different flat systems that must
not share records.

### § 2.2 Reverse collapse constraint

Until element filters are implemented, the following configuration is **unsafe** and is
explicitly not supported:

> Two channel members with the same `array_path` on the same parent entry, where the intent
> is for each member to own a disjoint subset of elements, and writes from the flat side
> must collapse back only into the elements that member originally expanded.

Without a filter, the collapse path (`_applyCollapseBatch` / `patchNestedElement`) would
correctly patch the element slot by key, but both channels would have claimed the same
canonical IDs — meaning a write on one flat system would be treated as a change on the
other too, causing spurious fan-out. The split-routing pattern is only safe end-to-end
once filters are evaluated at both expansion time and collapse time.

**Current behaviour (no filter):** multiple members with the same `array_path` on the same
parent each receive all elements and produce identical canonical IDs. This is the correct
behaviour when both channels are meant to share the same canonical records (e.g. two read
targets for the same data). It is the wrong behaviour when the intent is a disjoint split.

---

## § 3 Design

### § 3.1 Config keys

```yaml
- connector: erp
  channel: product-lines
  parent: erp_orders
  array_path: lines
  filter: "element.type === 'product'"          # forward: which elements enter this channel
  reverse_filter: "element.type === 'product'"  # reverse: which resolved elements are written back
  element_key: lineNo
  fields: [...]
```

Both keys are optional and independent:

| Key | Applies to | Meaning |
|-----|-----------|--------|
| `filter` | Forward pass | Only elements matching the expression are claimed by this member — expanded, canonicalised, dispatched |
| `reverse_filter` | Reverse pass | Only canonical records matching the expression are written back to this source during collapse |

Available bindings for both expressions:

| Binding | Value |
|---------|-------|
| `element` | the current array element (after `parentFields` merge, before inbound mapping) |
| `parent` | the parent record's raw `data` object |
| `index` | zero-based position of the element in the array |

For the common split-routing case both expressions will be identical. They can legitimately differ — e.g. a source that contributes only `type='product'` elements but must also receive back any `type='product'` elements that arrived from another source.

### § 3.2 Forward pass (expansion)

Both `filter` and `reverse_filter` are compiled once at config load time into
`(element, parent, index) => boolean` functions using `new Function(...)`. Config validation
rejects expressions that fail to parse.

During `expandArrayChain` / `expandArrayRecord`, each element is tested against `filter`
before a canonical ID is derived. Elements for which the expression evaluates to falsy are
silently skipped — no canonical ID derived, no shadow stored, no dispatch.

### § 3.3 Reverse pass (collapse)

When collapsing a flat-record write back to the array source, the engine evaluates
`reverse_filter` against the current element in the parent record before deciding whether
to apply the patch. If the element does not pass `reverse_filter` (e.g. its `type` field
was changed out-of-band), the patch is skipped and logged as a warning.

When `reverse_filter` is absent the engine applies the patch unconditionally (current
behaviour). When `filter` is set but `reverse_filter` is not, the two are treated
independently — the absence of `reverse_filter` does not imply `reverse_filter = filter`.

### § 3.4 `ChannelMember` addition

```typescript
interface ChannelMember {
  // ... existing fields ...
  elementFilter?:        (element: unknown, parent: unknown, index: number) => boolean;
  elementReverseFilter?: (element: unknown, parent: unknown, index: number) => boolean;
}
```

### § 3.5 Interaction with multi-level chains

Filters apply at each level of a multi-level expansion chain independently. A filter on the
leaf member applies to leaf elements; a filter on an intermediate named entry (same-channel
source descriptor) applies to intermediate elements before their children are expanded.

---

## § 4 Security Note

`new Function(...)` executes arbitrary JavaScript. In the browser playground this is
acceptable (same origin, user-authored config). In server deployments, filter expressions
should be treated as user-supplied code and sandboxed or replaced with a safe expression
language. This constraint must be documented in `specs/config.md`.

---

## § 5 Out of Scope

- A domain-specific expression language (CEL, JSONata, etc.) — a future follow-on.
- Filter application to non-array (standard) channel members.
- Aggregate operations across elements (count, sum) — belongs in field expressions
  (PLAN_FIELD_EXPRESSIONS.md).
