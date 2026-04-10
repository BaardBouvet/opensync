# PLAN: JSON Sub-Field Extraction (`source_path`)

**Status:** backlog  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** Engine — field mapping, config  
**Scope:** `specs/field-mapping.md`, `specs/config.md`, `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/core/mapping.ts`  
**Depends on:** none  

---

## § 1 Problem

`NormalizedRecord` is a flat key-value map. The engine's `applyMapping` function looks up each
source field by name from this flat map. When a connector returns a nested object — e.g.
`{ address: { street: "1 Main St", city: "Oslo" } }` — the operator must either:

1. Have the connector pre-extract the nested fields and return them at the top level, or
2. Write a forward `expression` that calls `record.address?.street`.

Option 1 pushes transformation responsibilities into connectors (violating the "connectors are
dumb pipes" principle). Option 2 works but is verbose and requires a paired `reverse_expression`
to reconstruct the nested object on write-back — a manual and error-prone inverse.

`source_path` is a first-class config key that declares the extraction inline in the mapping
without requiring connector changes or JS expressions.

---

## § 2 Proposed Design

### § 2.1 Config syntax

A `source_path` key on a `FieldMappingEntry` replaces `source` when the value lives at a nested
path. The two keys are mutually exclusive: a validation error is raised if both are present.

```yaml
fields:
  - source_path: address.street     # dot-notation — reads record.address?.street
    target: street

  - source_path: metadata.tags[0]   # bracket index — reads record.metadata?.tags?.[0]
    target: primaryTag

  - source_path: lines[0].product_id
    target: firstProductId

  - source: name                    # plain source still works alongside source_path entries
    target: customerName
```

Path syntax:
- `.` separates object keys.
- `[N]` (non-negative integer) indexes into an array.
- Missing intermediate values resolve to `undefined` (not an error); `undefined` is treated
  the same as an absent field (falls through to `default` if configured).

### § 2.2 Forward pass

After `record.data` is available and `id_field` injection is applied, each mapping entry that
carries `source_path` extracts the value by walking the path before the rest of `applyMapping`
runs. The extracted value is then subjected to the same pipeline as a plain `source` field:
`expression`, `normalize`, `default`, `direction`, etc.

Path resolution is a short recursive walk (not a full JSONPath library): split on `.` first,
then handle `[N]` tokens within each segment. This is intentionally simpler than JSONPath —
it covers the real-world cases without bringing in a dependency or supporting filters,
wildcards, or recursive descent.

### § 2.3 Reverse pass

On the reverse pass the engine must reconstruct the nested structure. The reverse path is the
inverse of `source_path`: the outbound-mapped value is placed at the nested location within the
connector's payload.

```
source_path: address.street  →  outbound: { address: { street: <value> } }
```

When multiple fields share the same top-level path prefix, they are merged into the same nested
object:

```yaml
- source_path: address.street
  target: street
- source_path: address.city
  target: city
```

Outbound: `{ address: { street: "1 Main St", city: "Oslo" } }`.

If the connector's `update()` payload already contains a partial object at that key (e.g. from
another field in the mapping), the nested assignments are merged, not replaced.

Array-index write-back (`[N]`) on reverse is **not supported** — writing to a positional index
within an existing array would require reading the full array first, mutating one slot, and
writing back the whole array. This is out of scope; operators who need write-back to an array
element should use `array_path` expansion or a `reverse_expression`. An attempt to use a
`source_path` with an array index in a non-`forward_only` field raises a config validation
error at load time.

### § 2.4 Interaction with `element_fields`

`source_path` is valid inside `element_fields` entries. When used there it resolves relative to
each element object (not the parent record):

```yaml
- source: certifications
  target: certifications
  element_fields:
    - source_path: body.code    # within each certificate element: element.body?.code
      target: certCode
```

### § 2.5 `source_path` as the inferred `source` name

When `source` is absent and `source_path` is present, the leaf key of the path is used as the
logical "source name" for lineage hints:

```
source_path: address.street  →  effective source name: "street"
```

This name appears in the `sources` lineage array for display purposes only.

---

## § 3 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §1.7 JSON sub-field extraction | Update status from "not yet implemented" to "implemented"; add reverse-pass semantics and array-index restriction note |
| `specs/config.md` | `FieldMappingEntry` key table | Add `source_path` row; note mutual exclusion with `source` and array-index reverse restriction |

---

## § 4 Implementation Checklist

- [ ] Add `source_path?: string` to `FieldMappingEntrySchema` (Zod) in `packages/engine/src/config/schema.ts`; validate mutual exclusion with `source` at load time; validate that `source_path` with an array-index token is not used on a non-`forward_only` field
- [ ] Add `sourcePath?: string` to the `FieldMapping` TypeScript type in `packages/engine/src/config/loader.ts`; wire through from `f.source_path`
- [ ] Implement `resolveSourcePath(record, path: string): unknown` helper in `packages/engine/src/core/mapping.ts` — split on `.`, handle `[N]` tokens, return `undefined` for missing intermediates
- [ ] In `applyMapping` forward pass: when `m.sourcePath` is set, call `resolveSourcePath` to obtain the value instead of `record[sourceKey]`
- [ ] In `applyMapping` reverse pass: when `m.sourcePath` is set, use nested-path assignment instead of flat key assignment; merge sibling paths into the same nested object; skip reverse-path assignment for forward-only fields (already skipped by direction guard)
- [ ] Add tests for `source_path`: single-level dotted path; multi-level dotted path; array index forward; array index reverse raises error (caught at config load time); missing intermediate resolves to `undefined`; `default` fires on `undefined` path result; `source_path` + `expression`; `source_path` inside `element_fields`; multiple `source_path` entries with shared prefix merge on reverse
- [ ] Update `specs/field-mapping.md §1.7` status
- [ ] Update `specs/config.md` `FieldMappingEntry` key table
- [ ] Update `plans/engine/GAP_OSI_PRIMITIVES.md` — `source_path` entry from 🔶 to ✅
- [ ] Update `specs/field-mapping.md` coverage table — `source_path extraction` row from 🔶 to ✅
- [ ] Run `bun run tsc --noEmit`
- [ ] Run `bun test`
- [ ] Update `CHANGELOG.md` under `[Unreleased]`
