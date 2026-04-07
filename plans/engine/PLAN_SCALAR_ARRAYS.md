# Plan: Scalar Array Expansion

**Status:** backlog  
**Date:** 2026-04-07  
**Effort:** S  
**Domain:** Engine  
**Scope:** `specs/field-mapping.md`, `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/core/array-expander.ts`  
**Spec:** `specs/field-mapping.md §3.3`  
**Depends on:** PLAN_NESTED_ARRAY_PIPELINE.md (complete), PLAN_ELEMENT_FILTER.md (complete)  

---

## § 1 Problem

The array expander (`expandArrayRecord`) handles JSON arrays whose elements are objects. When
an element is a bare scalar — a string, number, or boolean — the expander today silently skips
it:

```ts
if (element === null || typeof element !== 'object' || Array.isArray(element)) {
  // Skip non-object elements (scalar arrays not yet supported)
  continue;
}
```

Source systems routinely store tag lists, category codes, and enum sets as scalar arrays:

```json
{ "id": "c1", "tags": ["vip", "churned"] }
```

Without scalar array support, these arrays are invisible to the sync engine: the diff sees the
whole `tags` blob as a single opaque value, per-element resolution is impossible, and changes
to individual tags do not trigger targeted dispatches.

---

## § 2 Scope

**In scope:**
- `scalar: true` config key on mapping entries
- Forward pass: expand each bare scalar into a flat child record exposing the value as `_value`
- `element_key` is the value itself — no separate `element_key` declaration is needed or allowed
- Filter expressions (`filter`) work with the raw scalar value as the `element` binding
- Validation at config load time (forbid `element_key` when `scalar: true`)
- Spec §3.3 promoted from "planned follow-on" to "designed, not yet implemented" (forward pass)
- Tests covering string, number, and mixed-type scalar arrays; filter interaction; parent_fields merge

**Out of scope (future follow-on):**
- Reverse pass (collapse) for scalar arrays — object-slot patching does not map cleanly to
  set-valued scalar arrays; design deferred until `written_state` element tombstoning is fully
  in place (PLAN_WRITTEN_STATE.md approach)
- `scalar: true` inside multi-level chains (the leaf-level scalar case covers the common use
  case; grandchild-scalar is an edge case deferred with the reverse pass)

---

## § 3 Spec Changes Planned

| File | Section | Change |
|------|---------|--------|
| `specs/field-mapping.md` | §3.3 Scalar arrays | Replace "planned follow-on" with the designed spec: `scalar: true` config key, `_value` field convention, filter-binding semantics (raw scalar as `element`), `element_key` forbidden, reverse pass noted as out-of-scope follow-on. Update status line to "forward pass designed — reverse pass planned follow-on". |
| `specs/config.md` | Mapping entry keys table | Add `scalar` row: `boolean`, optional, default false; valid only when `array_path` is set; mutually exclusive with `element_key`. |

No connector-sdk changes are needed. Scalar expansion is purely engine-side.

---

## § 4 Design

### § 4.1 New config key

Add one optional key to the mapping entry schema:

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `scalar` | `boolean` | `false` | When true, elements of the array at `array_path` are bare scalars. Each value becomes both the element identity and the value of the synthesised `_value` field in the child record. `element_key` must not be set. |

Config example:

```yaml
- name: erp_contacts
  connector: erp
  channel: contact-tags
  entity: contacts

- channel: contact-tags
  parent: erp_contacts
  array_path: tags
  scalar: true       # elements are bare strings like "vip" or "churned"
  fields:
    - source: _value     # the scalar element value
      target: tagName
    - source: contactId  # brought in via parent_fields
      target: contactRef
  parent_fields:
    contactId: id

- connector: crm
  channel: contact-tags
  entity: contact_tags
  fields:
    - source: tagName
      target: tag
    - source: contactRef
      target: parentId
```

### § 4.2 Child record shape

For a parent record `{ id: "c1", tags: ["vip", "churned"] }` with `scalar: true`:

| Element | `childId` | Child data |
|---------|-----------|------------|
| `"vip"` | `c1#tags[vip]` | `{ _value: "vip", contactId: "c1" }` |
| `"churned"` | `c1#tags[churned]` | `{ _value: "churned", contactId: "c1" }` |

- `_value` holds the bare scalar casted to the same type it appears in the array.
- Parent scope (from `parent_fields`) is merged in as usual; `_value` wins on collision.
- The element key value is always `String(element)`. Duplicates (same scalar value twice in
  the array) produce the same canonical ID — the second occurrence is silently deduplicated.
  This is the intended behaviour: scalar arrays represent sets, not sequences.

### § 4.3 Filter expressions

When `scalar: true`, the `element` binding in `filter` expressions is the **raw scalar value**
directly, not the wrapped object:

```yaml
filter: "element !== 'internal'"   # exclude the 'internal' tag from sync
```

This is consistent with how a user would naturally think about filtering a string array. The
`parent` and `index` bindings are unchanged.

Contrast with object arrays where `element` is the element object (`element.type === 'product'`).
The distinction is documented in the spec.

### § 4.4 Implementation changes

**`packages/engine/src/config/schema.ts`**

In `MappingEntrySchema`:
```ts
scalar: z.boolean().optional(),
```

**`packages/engine/src/config/loader.ts`**

1. Add `scalar?: boolean` to `ExpansionChainLevel`.
2. Add `scalar?: boolean` to `ChannelMember`.
3. In `resolveExpansionChain`, propagate `scalar` from the leaf mapping entry into the leaf
   `ExpansionChainLevel`.
4. In the member-building block, propagate `scalar` from the resolved leaf level to
   `ChannelMember.scalar`.
5. Validation at load time: if `entry.element_key` and `entry.scalar` are both set, throw:
   ```
   Mapping in channel "<channel>" with scalar: true must not declare element_key
   ```

**`packages/engine/src/core/array-expander.ts`**

In `expandArrayRecord`, replace the guard that skips non-object elements:

```ts
// Before (skips all scalars)
if (element === null || typeof element !== 'object' || Array.isArray(element)) {
  continue;
}
```

With:

```ts
// After
const isScalar = member.scalar === true;
if (!isScalar) {
  if (element === null || typeof element !== 'object' || Array.isArray(element)) {
    continue;
  }
}
```

For the scalar branch:
- Skip `null` and `undefined` elements.
- `elementKeyValue = String(element)`.
- `elementObj = { _value: element }` (bare scalar wrapped into object form).
- Merge parent scope: `mergedData = { ...parentScope, ...elementObj }` (same as object path;
  `_value` wins over any parent field accidentally named `_value`).
- Pass raw scalar as the `element` argument to `elementFilter` (not the wrapped object).

No changes are needed to `expandArrayChain` — it calls `expandArrayRecord` and the scalar flag
propagates through the chain level.

The `extractHopKeys` function is unchanged; the element-key format `#path[value]` is the same
whether the key came from a declared `element_key` field or from the scalar value itself.

### § 4.5 Reverse pass (deferred)

Collapsing scalar arrays back to the source requires assembling a fresh scalar array from the
current set of child canonical records rather than patching individual object slots. The
`written_state` table (PLAN_WRITTEN_STATE.md) is the right foundation: compare the current set
of `_value` members against the last-written scalar array and produce the net-new array. This
is not in scope for the initial implementation.

Until the reverse pass is implemented, a scalar array child channel should only contain target
connectors (no source connector as a reverse-collapse target). The engine will not error — the
existing "is this a collapse target?" check in the dispatch path sees no `sourceEntity` on the
scalar member and skips. However, any writes from flat targets that would need to collapse back
to the parent's scalar array will be silently dropped. Document this limitation in the spec.

---

## § 5 Tests

All tests go in `packages/engine/src/core/array-expander.test.ts` (or a new
`array-expander.scalar.test.ts` alongside it).

| Test | Description |
|------|-------------|
| SA-1 | String scalar array expands to one child per element; `_value` field set; child IDs match `parentId#path[value]` pattern |
| SA-2 | Number scalar array — `_value` is the numeric value; child IDs use `String(number)` |
| SA-3 | Duplicate scalar values in array collapse into one child record (set semantics) |
| SA-4 | `null` and `undefined` elements are skipped |
| SA-5 | `parent_fields` values are merged into each scalar child record; `_value` wins on collision |
| SA-6 | `filter` expression receives the raw scalar as `element`, not the wrapped object |
| SA-7 | Config validation error when `element_key` and `scalar: true` are both set |
| SA-8 | `scalar: false` (explicit default) behaves identically to absent `scalar`; non-object elements are skipped |
| SA-9 | Empty scalar array returns `[]` (no children) |
| SA-10 | Integration: full ingest cycle with a scalar array channel dispatches one update per distinct scalar value to a flat target connector |
