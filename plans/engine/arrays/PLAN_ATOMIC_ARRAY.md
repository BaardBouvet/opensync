# PLAN: Atomic Array Fields

**Status:** complete  
**Date:** 2026-04-10  
**Effort:** M  
**Domain:** Engine — field mapping, diff, config  
**Scope:** `specs/field-mapping.md`, `specs/connector-sdk.md`, `packages/sdk/src/types.ts`, `packages/engine/src/core/diff.ts`, `packages/engine/src/core/mapping.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/config/schema.ts`  
**Depends on:** `PLAN_NORMALIZE_NOOP.md` (complete)  

---

## § 1 Problem

The engine already supports two modes for array-valued fields on a record:

| Mode | Config | Semantics |
|------|--------|-----------|
| **Per-item channel** (`array_path`) | `array_path: lines` on mapping | Each element becomes its own child entity. Per-element diffing, identity, conflict resolution, and collapse write-back. Any source can own any element. |
| **Atomic array** | (nothing today) | The entire array is treated as an opaque scalar value. One source owns the whole array. When it changes, the canonical value is replaced atomically. No per-element tracking. |

The atomic mode is useful when:

- The array is always written and replaced in full (e.g. an ERP publishes the complete `lines` list on every order save — partial element writes are not a supported API contract).
- Items should never be mixed across sources — only one source is the truth holder; others receive the full array passively.
- Per-element canonical IDs, collapse, and element-level conflict resolution are unwanted complexity.

**The mechanical behavior is already achievable today**: simply map the array field like any other field without using `array_path`. The engine stores the JSON-serialized array in shadow state; LWW/coalesce/field_master resolution picks one source's array as the winner; fan-out sends the full array blob to other connectors as a field value. Nothing is broken.

**What is missing** is three things:

### § 1.1 No documented pattern

`specs/field-mapping.md §3` only documents structural transforms that expand arrays (`array_path`, scalar arrays, deep nesting). Nothing in the spec tells operators "to treat an array atomically, simply map it as a regular field." The absence of documentation makes the pattern non-discoverable and leads operators to reach for `array_path` even when they don't want mixing.

### § 1.2 Order-sensitive diff triggers false updates

`diff.ts` compares field values with `JSON.stringify(lhs) !== JSON.stringify(rhs)` (line 34). For array-type fields this is **order-sensitive**: the same logical array returned in a different element order looks like a change, producing a spurious update on every poll cycle.

Example: connector A returns `[{id:1,qty:5},{id:2,qty:3}]`; on the next cycle it returns `[{id:2,qty:3},{id:1,qty:5}]` (same data, different order). The engine sees a diff and dispatches an update to all targets — forever.

The fix is a dedicated `sort_elements: true` boolean on the field mapping entry (§3.2). The existing `normalize` expression primitive cannot cleanly solve this — encoding a stable sort as a raw JS expression is verbose, specific to one type, not composable, and reads as dead-end syntax rather than a named, purposeful declaration. `sort_elements` is orthogonal to `normalize`, which is retained for value-level transforms like precision rounding or phone formatting.

However, the **preferred solution** is schema-level: the connector already knows whether its array is structurally ordered. That knowledge belongs in `FieldType`, not in every mapping entry that references the field. See §3.2.

### § 1.3 No shorthand for declaring sole authority

To declare "ERP exclusively owns the `lines` array and CRM only receives it", an operator must:
1. Understand that `direction: reverse_only` on ERP's mapping suppresses CRM's contribution — but this is the wrong direction flag semantically (it's the CRM that should be read-only, not ERP).
2. Use `direction: forward_only` on **CRM's** side — which means "ERP gives lines to canonical; canonical gives lines to CRM, but CRM never sends lines back up." That is the right flag, but it requires understanding the direction semantics from CRM's point of view.
3. Alternatively, use `field_master: { lines: erp }` in the channel's `conflict_resolution` config.

None of these are discoverable without reading deep into the spec. There is no config key that says "this connector is the authoritative source for this field — all other connectors are read-only for it."

### § 1.4 No canonical element schema — the core gap

The three problems above are documentation and ergonomics issues. This one is structural.

When two connectors represent the same logical array but with **different element field names**
— the common case in real integrations — the atomic blob has no mapping surface at all.

```
ERP line element:  { line_no: "L1", product_id: "SKU-001", unit_price: 29.99 }
CRM line element:  { lineNum: "L1", item: "SKU-001",       price: 29.99 }
Canonical element: { lineNumber: "L1", productId: "SKU-001", unitPrice: 29.99 }
```

In the `array_path` model the canonical element schema emerges naturally from the `fields`
mappings on the child member: each `source: line_no, target: lineNumber` entry declares one
element field's canonical name. But in the atomic model the array blob is stored and compared
as a single opaque JSON value — there is no place to declare element-level field renames.

**Unavoidable consequence:** as long as `element_fields` mapping does not exist, the atomic
pattern only works when all connectors speak the **same** element field names natively, or when
the operator is willing to write a full-array transform via `expression` /
`reverse_expression`. Both conditions are restrictive:

- _Same field names natively_ — only true when the connector is designed to speak a fixed
  canonical schema, which is rare for real SaaS APIs.
- _`expression` transform_ — works but is a maintenance burden: each connector must write
  forward and reverse array-transform expressions in raw JS with no type safety, and they
  must invert each other perfectly. Any schema change requires updating every expression.

**The structural solution is a new `element_fields` config key** (see §3.4). It provides
per-element field mapping (rename, direction, expression, normalize) applied uniformly to
every element of the array without expanding elements into separate entities. This differs
from `array_path` in one critical way: no per-element canonical IDs are allocated and no
collapse infrastructure is involved — the array is still stored and resolved atomically.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §3 Structural Transforms | Add **§3.5 Atomic arrays** (new subsection, documented below) |
| `specs/field-mapping.md` | §3 Structural Transforms | Add `sort_elements` to the §3.5 example and key table |
| `specs/field-mapping.md` | §10 coverage table | Add "Atomic array" row (new primitive, ✅ after implementation) |
| `specs/config.md` | `MappingEntry` key reference table | Add `sort_elements` boolean and `element_fields` key |

---

## § 3 Proposed Design

### § 3.1 New spec section: §3.5 Atomic arrays

Add the following content to `specs/field-mapping.md` as §3.5 under § 3 Structural Transforms:

> **§3.5 Atomic arrays**
>
> An array-valued field on a source record that should be owned by one source and replaced in
> its entirety when it changes — with no per-element tracking — can be mapped as a **plain
> field** without `array_path`. The engine stores the JSON blob in shadow state; normal
> resolution strategies (coalesce, last_modified, field_master) pick the winning source's
> entire array value; fan-out delivers the full array to other connectors as a field value.
>
> **When to use atomic vs `array_path`:**
>
> | Need | Use |
> |------|-----|
> | One source owns the whole array; API is full-replace | Atomic (no `array_path`) |
> | Items from multiple sources may coexist; per-element conflict resolution needed | `array_path` channel expansion |
> | Targets need item-level `insert`/`update` rather than full-array replace | `array_path` channel expansion |
>
> **Single-authority example** — ERP owns `lines`; CRM receives but never writes it:
>
> ```yaml
> # ERP is the bidirectional owner
> - connector: erp
>   channel: orders
>   entity: orders
>   fields:
>     - source: lines
>       target: lines
>       sort_elements: true   # explicit override if connector schema lacks order annotation (§3.2)
>
> # CRM receives the canonical lines array but never contributes its own version
> - connector: crm
>   channel: orders
>   entity: orders
>   fields:
>     - source: lines
>       target: lines
>       direction: forward_only  # canonical → CRM only; CRM's lines never go upstream
>       sort_elements: true
> ```
>
> **LWW example** — whichever source updated lines most recently wins the entire array:
>
> ```yaml
> - connector: erp
>   channel: orders
>   entity: orders
>   fields:
>     - source: lines
>       target: lines
>       sort_elements: true
>
> - connector: crm
>   channel: orders
>   entity: orders
>   fields:
>     - source: lines
>       target: lines
>       sort_elements: true
>
> # channel-level: last_modified resolution is used because records carry updatedAt
> ```
>
> **`field_master` example** — explicit field-level authority pin:
>
> ```yaml
> channels:
>   - id: orders
>     conflict_resolution:
>       fieldMasters:
>         lines: erp         # ERP wins lines regardless of timestamps
> ```
>
> **Order-insensitive comparison:** if the source connector's schema declares
> `unordered: true` on the array's `FieldType`, the engine applies sort-before-compare
> automatically. If the connector schema is absent or omits `unordered`, set `sort_elements: true`
> on the field mapping entry as an explicit override. See §3.2.
>
> **Dispatch semantics:** the target connector receives the full canonical array as a field
> value in `InsertRecord.data` / `UpdateRecord.data`. Targets that support only item-level
> write APIs (not full-array replace) should use `array_path` expansion instead.

### § 3.2 Order-insensitive diff: schema annotation + mapping override

Two independent mechanisms, OR’d together at diff time:

#### § 3.2.1 Schema-level: `FieldType` array `unordered` annotation

The connector knows whether its array is structurally ordered or a set. That declaration
belongs in `FieldType` in the SDK, not in every mapping entry:

```typescript
// packages/sdk/src/types.ts
type FieldType =
  | "string" | "number" | "boolean" | "null"
  | { type: "object"; properties?: Record<string, FieldDescriptor> }
  | { type: "array"; items?: FieldType; unordered?: true };
//                                     ^^^^^^^^^^^^^^^
```

`unordered?: true` follows the same pattern as `required` and `immutable` on `FieldDescriptor`:
a flag that carries meaning only when explicitly set, is never written as `false`, and is
absent by default. The vocabulary matches connector-author intent at declaration time: "element
order in this array is not significant."

This is intentionally narrower than a two-value enum:
- A `"set" | "ordered"` enum has a dead member (`"ordered"` === absent) and conflates
  mathematical set semantics (no duplicates) with ordering semantics.
- `unordered?: true` expresses exactly the one thing the engine needs to know.

```typescript
// Connector schema examples
schema: {
  tags:  { type: { type: "array", items: "string",              unordered: true },  description: "Labels applied to this record" },
  lines: { type: { type: "array", items: { type: "object", ... }, unordered: true }, description: "Line items — order not significant" },
  steps: { type: { type: "array", items: { type: "object", ... } },                  description: "Workflow steps — sequence matters" },
}
```

The engine reads the source connector’s schema for the field’s `FieldType.unordered` when
building the diff comparator. If `unordered: true`, sort-before-compare is applied
automatically — no `sort_elements: true` needed in any mapping.

#### § 3.2.2 Mapping-level: `sort_elements: true` override

A boolean on a `FieldMapping` entry. Useful when:
- The connector has no schema for this field.
- The connector omits `unordered` (order unknown) but the operator knows element order is
  not significant for this particular sync.
- The target connector has different ordering semantics than the source.

```yaml
fields:
  - source: lines
    target: lines
    sort_elements: true   # explicit opt-in regardless of connector schema
```

**The two signals are OR’d:** either the source connector’s schema declares `unordered: true`,
or the mapping declares `sort_elements: true`, and sort-before-compare is applied.

**Why not `normalize` for this?** `normalize` is a JS expression string compiled via `new
Function`. Making it also accept named tokens would overload the field to mean two different
things, require magic string detection before the compiler runs, and not compose with other
normalization. A dedicated boolean and a schema annotation are each semantically precise.

**Sort implementation** (shared between both mechanisms):

Rather than a value-only sort, the implementation uses a **schema-guided recursive normalizer**
that descends the `FieldType` tree. This handles nested unordered arrays at any depth.

```ts
// packages/engine/src/core/diff.ts
function normalizeForDiff(value: unknown, fieldType: FieldType | undefined): unknown {
  if (
    fieldType &&
    typeof fieldType === "object" &&
    fieldType.type === "array"
  ) {
    if (!Array.isArray(value)) return value;
    // Recursively normalize each element using the items schema
    const normalized = value.map(el => normalizeForDiff(el, fieldType.items));
    // Sort if the array is declared unordered
    if (fieldType.unordered) {
      return [...normalized].sort((a, b) => {
        const sa = JSON.stringify(a) ?? "";
        const sb = JSON.stringify(b) ?? "";
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
    }
    return normalized;
  }
  if (
    fieldType &&
    typeof fieldType === "object" &&
    fieldType.type === "object" &&
    fieldType.properties
  ) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    // Recursively normalize any nested array properties
    const out: Record<string, unknown> = { ...value as Record<string, unknown> };
    for (const [k, desc] of Object.entries(fieldType.properties)) {
      if (desc.type) out[k] = normalizeForDiff(out[k], desc.type);
    }
    return out;
  }
  return value;
}
```

This is called with the field’s `FieldType` from the source connector’s schema. Because
`FieldType` is fully recursive (`items` can itself be an object with `properties` containing
further arrays), any depth of nesting is handled correctly in one pass. The normalized value
is used only for diff comparison — it is never written to shadow state or dispatched.

**Interaction with `element_fields`:** `element_fields` transforms run before `normalizeForDiff`.
When a nested `element_fields` entry carries `sort_elements: true` on an inner array field,
`applyElementFields` passes that inner value through `normalizeForDiff` with a synthetic
`{ type: "array", unordered: true, items: <inner element_fields type> }` descriptor. This
gives mapping-level sort coverage at any depth, fully independent of the connector schema.

### § 3.3 `element_fields` — per-element field mapping without expansion

A new optional config key `element_fields` on a **field mapping entry** declares field
mappings applied **to every element** of a named array field before the array is stored in
canonical. Elements are never assigned their own canonical IDs and the array is still stored
and resolved as a single opaque value in shadow state. This is purely a transform layer, not
a structural expansion.

`element_fields` entries are themselves field mappings, so the type is **self-referential**:
a nested array field within an element can carry its own `element_fields` and `sort_elements`
at any depth. This mirrors the recursive nature of `FieldType` in the connector schema.

```typescript
// Conceptual type (loader.ts FieldMapping)
interface FieldMapping {
  source?: string;
  target: string;
  direction?: "bidirectional" | "forward_only" | "reverse_only";
  expression?: (r: Record<string, unknown>) => unknown;
  reverseExpression?: (r: Record<string, unknown>) => unknown;
  // ... other transform primitives ...
  sort_elements?: boolean;      // sort this array field before diff
  element_fields?: FieldMapping[]; // NEW — recursive
}
```

**Flat example:**

```yaml
- connector: erp
  channel: orders
  entity: orders
  fields:
    - source: lines
      target: lines
      sort_elements: true
      element_fields:
        - source: line_no
          target: lineNumber
        - source: product_id
          target: productId
        - source: unit_price
          target: unitPrice

- connector: crm
  channel: orders
  entity: orders
  fields:
    - source: lines
      target: lines
      direction: forward_only
      sort_elements: true
      element_fields:
        - source: lineNum
          target: lineNumber
        - source: item
          target: productId
        - source: price
          target: unitPrice
```

**Nested `element_fields` example** — each line item itself contains an unordered `components`
array. `sort_elements` and `element_fields` both nest naturally:

```yaml
- connector: erp
  channel: orders
  entity: orders
  fields:
    - source: lines
      target: lines
      sort_elements: true
      element_fields:
        - source: line_no
          target: lineNumber
        - source: components       # nested array within each element
          target: components
          sort_elements: true      # sort the nested array too
          element_fields:
            - source: comp_id
              target: componentId
            - source: qty
              target: quantity
```

`sort_elements` on a nested `element_fields` entry applies during the recursive
`normalizeForDiff` pass, so deeply-nested unordered arrays are handled at any depth even
when the connector schema is absent.

Forward pass: after the parent field mapping extracts `lines` from the source record, each
element object is passed through `applyMapping(element, element_fields)` using the same
`applyMapping` logic as a top-level record. The result is a canonical element object. The
array of canonical elements is stored as the canonical value of `lines`.

Reverse pass: before the parent field reverse-mapping rewrites the field for the target
connector, each element object is passed through `applyReverseMapping(element, element_fields)`
to produce the connector-native element object.

**Primitive support in `element_fields`:**

The field-mapping primitives split into two categories. `element_fields` supports the
**transform** category and excludes the **resolution** category — because elements in an
atomic array are never compared against other sources' versions; there is no cross-source
arbitration at the element level.

| Primitive | Category | In `element_fields`? | Rationale |
|-----------|----------|----------------------|-----------|
| `source` / `target` rename | transform | ✅ yes | Core purpose of `element_fields` |
| `source_path` | transform | ✅ yes | Sub-field extraction within an element object |
| `expression` / `reverse_expression` | transform | ✅ yes | Element-level value transforms (e.g. date format conversion, derived field) |
| `default` / `defaultExpression` | transform | ✅ yes | Fill missing element fields before storing canonically |
| `direction` | transform | ✅ yes | Per-element-field read/write direction (e.g. `forward_only` on a system-computed element field the source API never accepts back) |
| `normalize` | diff | ❌ no | Diff happens at the whole-array level (after element transforms); per-element-field normalize has no diff to apply against |
| `group` | resolution | ❌ no | Atomic resolution across sources; elements live entirely within one source's blob |
| `resolve` | resolution | ❌ no | Same — cross-source resolver function has no meaning at element-field level |
| `priority` | resolution | ❌ no | Same |
| `reverseRequired` | resolution | ❌ no | Row-dispatch suppression; no row boundary at element-field level |
| `collect` / `bool_or` | resolution | ❌ no | Cross-source aggregation; does not apply |
| `sources` lineage hint | metadata | ✅ yes | Display-only; no runtime effect, harmless to allow |

The rule is simple: if the primitive **transforms a value** it belongs in `element_fields`; if it **chooses a value from competing sources** it does not.

**Key invariant:** `element_fields` is mutually exclusive with `array_path` on the same
field entry. Both cannot be set simultaneously — a config validation error is raised at load
time. (`array_path` expands elements into separate entities; `element_fields` transforms them
in place. The distinction applies at every level of nesting.)

---

### § 3.4 No new engine behavior for §1.1–§1.3

All three authority models (single-authority, LWW, field_master) already work without engine
changes for §1.1–§1.3. The only implementation work for those gaps is the
`sort_elements: true` boolean and the spec documentation.

`direction: forward_only` for non-authoritative connectors is the clean, already-documented
pattern for declaring one-way sync on a field. No new `authority:` or `atomic:` key is
introduced — the existing primitive set is sufficient; what was missing was the
documentation connecting them into a coherent pattern.

**Escape hatch:** if `element_fields` cannot cover a particular transform (e.g. a computed
field derived from multiple element properties), `expression` / `reverse_expression` on the
parent field entry can transform the whole blob. Use this only when `element_fields` is
insufficient — the full-blob expression approach requires forward and reverse to mirror each
other exactly and does not benefit from the per-field rename table.

---

## § 4 Out of Scope

- **Automatic sort for all array-typed fields** — the default remains order-sensitive. Connectors
  opt in via `unordered: true` in their schema; operators opt in via `sort_elements: true` in their
  mapping. Switching the global default would change behavior silently for existing deployments.
- **Per-element `direction`** — making some elements of an atomic array read-only is per-item
  tracking territory; use `array_path` with `element_key` + `reverse_filter` for that.
- **Write-back of partial array changes** — the atomic pattern always writes the full array blob.
  Callers who need partial write-back must use `array_path` collapse.

---

## § 5 Implementation Checklist

- [ ] Add `unordered?: true` to the `{ type: "array" }` variant in `packages/sdk/src/types.ts`; update JSDoc
- [ ] Update `specs/connector-sdk.md` `FieldType` definition block and prose to document `unordered`
- [ ] Add `§3.5 Atomic arrays` subsection to `specs/field-mapping.md` (placed after §3.4 Deep nesting)
- [ ] Add `element_fields` primitive support table and `sort_elements` key description to `specs/field-mapping.md §3.5`
- [ ] Update `specs/config.md` MappingEntry key reference to add `sort_elements` boolean and `element_fields` key
- [ ] Add `sort_elements?: boolean` to `FieldMappingEntrySchema` (Zod) and to the `FieldMapping` TypeScript type in `loader.ts`; wire both `unordered: true` (from source connector schema) and `sort_elements: true` (from mapping entry) into the diff comparator — OR’d together, sort applied before `normalize` if also present
- [ ] Add `element_fields?: FieldMapping[]` to the `FieldMapping` type as a **self-referential** field; add recursive Zod schema for `element_fields` to `MappingEntrySchema` in `loader.ts` (lazy `z.lazy(() => FieldMappingEntrySchema)` to handle recursion); validate mutual exclusion with `array_path` at load time at every level
- [ ] Implement `applyElementFields(arrayValue, elementFields, reverse)` helper in `packages/engine/src/core/mapping.ts` — recursively applies `applyMapping` / `applyReverseMapping` to each element object; when an element field entry itself has `element_fields`, recurse into the nested array
- [ ] Call `applyElementFields` in the forward pass after field extraction and in the reverse pass before field injection
- [ ] Add tests for `sort_elements` and `unordered: true`: same elements different order → noop (both mechanisms); different elements → diff; non-array value → still works; `sort_elements: true` overrides absent schema annotation; `sort_elements` + `normalize` together → sort applied first; nested unordered array within element → schema-guided recursion normalizes it; `sort_elements` without schema → top-level only
- [ ] Add tests for `element_fields`: rename round-trip; `forward_only` element field is omitted on reverse; `expression` on an element field; `default` fills missing element field; non-array value is passed through unchanged; `array_path` + `element_fields` on same entry → config error; nested `element_fields` within `element_fields` → recursive rename round-trip; nested `sort_elements: true` → inner array sorted
- [ ] Run `bun run tsc --noEmit`
- [ ] Run `bun test`
- [ ] Update `CHANGELOG.md` under `[Unreleased]`
