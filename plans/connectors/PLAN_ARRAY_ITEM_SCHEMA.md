# PLAN: Rich Array Item Schema

**Status:** complete  
**Date:** 2026-04-09  
**Effort:** S  
**Domain:** packages/sdk, specs/connector-sdk.md, playground  
**Scope:** `FieldType` object/array variants; `systems.ts` fixture; lineage type display  
**Spec:** specs/connector-sdk.md  
**Depends on:** —

---

## 1. Problem

`FieldType` currently uses a minimal JSON Schema subset:

```typescript
type FieldType =
  | "string" | "number" | "boolean" | "null"
  | { type: "object"; properties?: Record<string, FieldType> }
  | { type: "array"; items?: FieldType };
```

Two deficiencies:

### 1.1 Object properties carry no metadata

`properties` maps field names to bare `FieldType` values — a plain type tag.  There is no room for a `description` or `example` alongside the type:

```typescript
// currently valid but loses all context
properties: { sku: "string", qty: "number" }
```

Agents reading a schema cannot understand what `sku` means inside an array item any better than they can understand an opaquely-named top-level field without a `FieldDescriptor`.

More critically, there is no way to declare that a nested property is itself a FK reference to another entity. A `purchases.lines[].customerId` field that points to an account cannot express `entity: "accounts"` anywhere — so the engine can never synthesize an association from it.

### 1.2 Embedded arrays are declared blind

The playground `FIXED_SCHEMAS` declares `purchases.lines` as:

```typescript
lines: { type: { type: "array" }, description: "Individual line items in this purchase" },
```

No `items` descriptor at all — the lineage field preview shows type `"array"` with nothing about
the shape of each element. Connectors like WaveApps similarly declare
`{ type: "array", items: { type: "object" } }` with no property breakdown.

The spec example in `connector-sdk.md §3` even shows:

```typescript
{ type: 'array', items: { type: 'object', properties: { sku: 'string', qty: 'number' } } }
```

…where `'string'` is a bare `FieldType` scalar — consistent with the current type but providing
no human-readable context.

---

## 2. Proposed Design

### 2.1 Use `FieldDescriptor` recursively for object properties

Rather than introducing a narrower type, `properties` inside an object `FieldType` should use
the full `FieldDescriptor` — the same type used at the entity level. This is necessary because:

- A nested property may itself be a FK reference (`entity: "accounts"`), enabling the engine
  to synthesize associations from embedded object fields in the future.
- `required` / `immutable` may be meaningful at the item level (e.g. a line item must always
  have a `lineNo`).
- Nesting is unbounded — an item property can itself be `{ type: "object", properties: … }` or
  `{ type: "array", items: … }`, requiring the same descriptor shape all the way down.

No new type is introduced. `FieldType` becomes:

```typescript
export type FieldType =
  | "string" | "number" | "boolean" | "null"
  | { type: "object"; properties?: Record<string, FieldDescriptor> }
  | { type: "array"; items?: FieldType };
```

Because `FieldDescriptor` references `FieldType` and `FieldType` references `FieldDescriptor`,
both declarations must be hoisted so they can refer to each other (already the case — they
are declared in the same file).

### 2.2 Breaking-change note

`FieldType.object.properties` values change from scalar literals (`"string"`) to
`FieldDescriptor` objects (`{ type: "string" }`). This is a pre-release breaking
change — no shim or backward-compat fallback is added. All call-sites are updated in the
same PR.

Known call-sites using `properties`:

| File | Usage | Action |
|------|-------|--------|
| `packages/sdk/src/types.ts` | JSDoc example `{ sku: 'string', qty: 'number' }` | Update to object form |
| `specs/connector-sdk.md` | Same example in spec code block | Update |
| `connectors/waveapps/src/index.ts` | `{ type: "array", items: { type: "object" } }` — no `properties` | No change needed |
| `playground/src/lib/systems.ts` | `purchases.lines` field — bare `{ type: "array" }` | Full item schema (§2.4) |

---

### 2.3 Update `purchases.lines` schema in `systems.ts`

Replace the bare declaration with a fully-described array item schema. Properties use full
`FieldDescriptor` objects, including `entity` where applicable:

```typescript
lines: {
  type: {
    type: "array",
    items: {
      type: "object",
      properties: {
        lineNo:    { type: "string", description: "Line item identifier within the purchase", example: "L01" },
        sku:       { type: "string", description: "Product stock-keeping unit code",          example: "SKU-001" },
        quantity:  { type: "number", description: "Quantity ordered",                          example: 5 },
        linePrice: { type: "number", description: "Unit price at time of purchase",            example: 29.99 },
      },
    },
  },
  description: "Individual line items in this purchase",
},
```

### 2.4 Improve lineage type label rendering in the playground

Currently `systems-pane.ts` renders the type for a field as:

```typescript
typeof desc.type === "string" ? desc.type : desc.type?.type
// "array" fields render as just "array"
```

After this change, array fields with an object item type should render as `"array[object]"`,
and optionally list the top-level property names as a tooltip or sub-label:

```typescript
// pseudocode
function renderFieldType(fieldType: FieldType | undefined): string {
  if (!fieldType) return "";
  if (typeof fieldType === "string") return fieldType;
  if (fieldType.type === "array") {
    const itemLabel = fieldType.items
      ? typeof fieldType.items === "string"
        ? fieldType.items
        : fieldType.items.type
      : "unknown";
    return `array[${itemLabel}]`;
  }
  if (fieldType.type === "object") {
    const keys = Object.keys(fieldType.properties ?? {});
    return keys.length ? `object{${keys.join(", ")}}` : "object";
  }
  return fieldType.type;
}
```

The exact format (bracket vs comma separation) is a display detail, decided at implementation
time, but the principle — surface item/property shape — is fixed by this plan.

---

## 3. Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-sdk.md` | § Field Types (FieldType definition block) | Update `object` `properties` type from `Record<string, FieldType>` to `Record<string, FieldDescriptor>`; update JSDoc example |
| `specs/connector-sdk.md` | § Field Types (prose and example) | Update the example that shows `{ sku: 'string', qty: 'number' }` to use full `FieldDescriptor` objects including `description` and optional `entity` |

No other spec files are affected — `FieldType` is purely a connector-SDK / schema annotation
concern; the engine does not enforce nested property schemas at runtime.

---

## 4. Out of Scope

- **Engine enforcement of nested property types** — nested properties are informational only;
  the engine does not validate individual item properties at diff or fan-out time. If enforcement
  is ever needed, it belongs in a separate plan.
- **`required` / `immutable` on nested properties** — also engine-enforcement territory; deferred.
- **YAML config schema** — `FieldType` in `FieldDescriptor` is the entity schema metadata; it
  does not feed into the YAML `MappingEntrySchema`. No `specs/config.md` change is needed.

---

## 5. Implementation Checklist

- [ ] Update `FieldType` in `packages/sdk/src/types.ts`: change `properties` from `Record<string, FieldType>` to `Record<string, FieldDescriptor>`
- [ ] Update JSDoc example in `packages/sdk/src/types.ts` to use full `FieldDescriptor` form including `description` and `entity`
- [ ] Update `specs/connector-sdk.md` FieldType definition block + spec example
- [ ] Update `playground/src/lib/systems.ts` `purchases.lines` to full item schema
- [ ] Update `playground/src/ui/systems-pane.ts` type label rendering helper
- [ ] Run `bun run tsc --noEmit` — verify no type errors at changed call-sites
- [ ] Run `bun test` — verify all tests pass
- [ ] Update `CHANGELOG.md` under `[Unreleased]`
