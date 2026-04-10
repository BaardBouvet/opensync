# Plan: Lineage — Nested Array Field Preview

**Status:** complete  
**Date:** 2026-04-09  
**Effort:** S  
**Domain:** Playground  
**Scope:** `playground/src/ui/lineage-diagram.ts`, `playground/src/ui/systems-pane.ts`, `specs/playground.md`  
**Spec:** `specs/playground.md §11.15`, `specs/playground.md §11.16` (new)  
**Depends on:** PLAN_LINEAGE_FIELD_PREVIEW.md (complete)  

---

## § 1 Problem

`FieldPreview.type` currently collapses any array type to the flat string `"array"`.
When a connector entity has a field like `lines` whose type is:

```ts
{ type: "array", items: { type: "object", properties: { sku: "string", qty: "number", price: "number" } } }
```

…the pool pill list shows:

```
lines   array
```

There is no way to see what fields the array elements carry without reading the connector
source code or external docs. This gap is especially visible in the webshop `purchases`
entity, where `lines[]` is the primary data of interest and its sub-fields are the ones
that need mapping.

The unassigned-pool use case is the clearest pain point: when a user is deciding whether
and how to map `purchases`, they need to know the `lines[]` element schema (at minimum
field names and types) without leaving the playground.

---

## § 2 Goal

Array-typed fields whose item type is a named-property object become expandable
sub-sections inside pool entity groups and channel entity group unmapped sections.
Expanding reveals one pill per element-object property. The default state is collapsed;
a single click/tap toggles open and shut.

Out of scope:
- Scalar arrays (`items` is a scalar type) — remain as flat `"array"` labels, no change.
- Multi-level deep nesting (array of array, object of array) — render the outer layer only;
  inner structure is shown in the tooltip.
- Channel *mapped* field nodes — array sub-field expansion is display-only metadata;
  SVG line drawing is not affected.
- `reverseExpression` / write-side schema — display only.

---

## § 3 Spec Changes Planned

| File | Section | Change |
|------|---------|--------|
| `specs/playground.md` | §11.15 | Extend `FieldPreview` definition with `subFields?: FieldPreview[]`; note that `type` stays `"array"` for the parent pill. Add build rule: populate `subFields` when the raw `FieldType` is `{ type: "array", items: { type: "object", properties: … } }`. |
| `specs/playground.md` | §11.16 (new) | New section: **Array sub-field expansion**. DOM structure, expand/collapse state, CSS classes, tooltip format for sub-field pills. |

No changes to `specs/connector-sdk.md`, `specs/sync-engine.md`, or any engine package.

---

## § 4 Data Model Change

### § 4.1 `FieldPreview` extension

Add one optional field to the existing interface (in `lineage-diagram.ts`):

```ts
export interface FieldPreview {
  name: string;
  isFK: boolean;
  description?: string;
  /** Human-readable type string: "string", "number", "array", "→ accounts", … */
  type?: string;
  example?: unknown;
  /** Present when type is "array" and items is an object with named properties.
   *  One entry per element-object property key. */
  subFields?: FieldPreview[];
}
```

`subFields` is only set when the raw `FieldDescriptor.type` is
`{ type: "array", items: { type: "object", properties: Record<string, FieldType> } }`.  
All other array shapes (scalar items, no items, unknown items) produce `subFields: undefined`.

### § 4.2 Build in `systems-pane.ts`

The helper that maps a `FieldDescriptor` to a `FieldPreview` gains a recursive step:

```ts
function descriptorToPreview(name: string, desc: FieldDescriptor): FieldPreview {
  const base: FieldPreview = {
    name,
    isFK: desc.entity !== undefined,
    description: desc.description,
    type: desc.entity
      ? `→ ${desc.entity}`
      : typeof desc.type === "string"
        ? desc.type
        : (desc.type?.type ?? undefined),
    example: desc.example,
  };
  if (
    desc.type &&
    typeof desc.type === "object" &&
    desc.type.type === "array" &&
    desc.type.items &&
    typeof desc.type.items === "object" &&
    desc.type.items.type === "object" &&
    desc.type.items.properties
  ) {
    base.subFields = Object.entries(desc.type.items.properties).map(([k, ft]) =>
      descriptorToPreview(k, { type: ft })
    );
  }
  return base;
}
```

The existing inline mapping inside `getEntityDefs()` is replaced with a call to
`descriptorToPreview`.

---

## § 5 DOM Structure

### § 5.1 Pool fields list

When a field pill inside `.ld-pool-fields-list` has `subFields` set, replace the simple
`<span class="ld-pool-field">` with an expandable group:

```html
<!-- Simple field (no subFields — unchanged) -->
<span class="ld-pool-field" title="Order total · number · e.g. 299.90">total</span>

<!-- Array field with sub-fields (collapsed) -->
<div class="ld-pool-field-array-group">
  <div class="ld-pool-field-array-header" data-array-key="webshop/purchases/lines">
    <span class="ld-pool-field ld-pool-field-array" title="Order line items · array">lines</span>
    <span class="ld-chevron ld-array-chevron">▸</span>
  </div>
  <div class="ld-pool-subfield-list ld-hidden">
    <span class="ld-pool-subfield" title="Product SKU · string">sku</span>
    <span class="ld-pool-subfield" title="Quantity · number · e.g. 2">qty</span>
    <span class="ld-pool-subfield" title="Unit price · number · e.g. 9.95">price</span>
  </div>
</div>
```

The `data-array-key` is `"connectorId/entity/fieldName"` — unique within the pool.

### § 5.2 Channel entity group unmapped section

The same expandable pattern applies inside `.ld-field-node-unmapped` context.  
An array field with sub-fields renders as:

```html
<div class="ld-field-node ld-field-node-unmapped ld-field-node-array-group">
  <div class="ld-field-node-array-header" data-array-key="...">
    <span class="ld-field-node-array-label">lines</span>
    <span class="ld-chevron ld-array-chevron">▸</span>
  </div>
  <div class="ld-field-node-subfield-list ld-hidden">
    <span class="ld-field-node-subfield" title="Product SKU · string">sku</span>
    …
  </div>
</div>
```

Sub-field pills inside `ld-field-node-subfield-list` inherit `pointer-events: none` and
opacity from their array-group parent — no separate interactivity rules needed.

---

## § 6 Expand/Collapse State

A `Set<string>` named `expandedArrayFields` (keys: `"connectorId/entity/fieldName"`) is
local to the pool rendering block in `renderLineageDiagram`.  
A separate `Set<string>` with the same key structure is local to each call to
`buildEntityGroup` for the unmapped section.

Both default to empty (all collapsed).  
Clicking `.ld-pool-field-array-header` or `.ld-field-node-array-header` toggles the
corresponding key and updates the DOM (chevron text, `ld-hidden` on the sub-list).

---

## § 7 CSS

New classes — all scoped inside the playground stylesheet:

| Class | Purpose |
|-------|---------|
| `.ld-pool-field-array-group` | Wrapper div for expandable array field in pool |
| `.ld-pool-field-array-header` | Clickable row with label + chevron |
| `.ld-pool-field-array` | The label pill inside the header (inherits `.ld-pool-field`) |
| `.ld-array-chevron` | Inline chevron; rotates `▸`↔`▾` on expand |
| `.ld-pool-subfield-list` | Container for sub-field pills; `ld-hidden` when collapsed |
| `.ld-pool-subfield` | Individual sub-field pill; indented ~12 px relative to parent |
| `.ld-field-node-array-group` | Channel unmapped equivalent of pool array group |
| `.ld-field-node-array-header` | Clickable row inside channel unmapped array group |
| `.ld-field-node-subfield-list` | Sub-field list inside channel entity group |
| `.ld-field-node-subfield` | Individual sub-field inside channel entity group |

Sub-field pills use the same `title` tooltip format as top-level fields:
`description · type · e.g. example` (omitting empty parts).

---

## § 8 No Impact on SVG Line Drawing

`drawSide` locates source-field nodes via `.ld-field-node[data-source-field]`.  
Sub-field pills carry no `data-source-field` attribute and no `data-canonical-field`
attribute, so they are never included in line drawing or highlight/dim logic.
The `data-unmapped="true"` guard that already skips unmapped nodes covers the channel
entity group sub-fields without any new code.
