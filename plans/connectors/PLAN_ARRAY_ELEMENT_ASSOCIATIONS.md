# PLAN: Associations on Nested Array Elements

**Status:** backlog  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** packages/sdk, packages/engine  
**Scope:** `ElementRecord` SDK type; engine `Ref`-extraction during array expansion  
**Spec:** specs/connector-sdk.md, specs/field-mapping.md §3.2, specs/associations.md  
**Depends on:** PLAN_NESTED_ARRAY_PIPELINE.md (complete), PLAN_DEFERRED_ASSOCIATIONS.md (complete),
  PLAN_PREDICATE_MAPPING.md (complete), PLAN_SCHEMA_REF_AUTOSYNTH.md (complete)  

---

## 1. Problem

The `_processRecords` array-expansion path contains this comment:

```typescript
// No association remapping for array child records in MVP
const dispatchResult = await this._dispatchToTarget(
  targetMember, tw, resolved, undefined,  // ← associations always undefined
  …
);
```

The engine calls `_extractRefsFromData` on root records—extracting FK associations from
`Ref`-valued fields and from plain string fields whose `FieldDescriptor.entity` is
declared—but skips this step entirely for every expanded array element. The result:

- A connector that returns `product_id: { '@id': 'prod-123', '@entity': 'products' }` in
  an order-line element gets the association silently dropped; the child record is
  dispatched with no FK reference.
- `FieldDescriptor.entity` auto-synthesis (schema pass) is never attempted for element
  fields, even when the array item schema declares them.
- Neither deferred edges nor predicate mapping is attempted for child records.

The same gap exists in the `collectOnly` path: child shadows are stored without an
`__assoc__` sentinel, so discovery and onboarding never see element-level FK data.

A secondary gap: there is no SDK API for a connector to supply element identity directly
(i.e. bypass `element_key` config with a runtime-computed key).

---

## 2. What Does Not Change

- `_extractRefsFromData` logic (both passes — explicit `Ref` and schema auto-synthesis).
- `_dispatchToTarget` call signature already accepts an `associations` argument;
  passing actual associations instead of `undefined` is the entire engine fix.
- Deferred edge rows, predicate mapping (`_filterInboundAssociations`), cross-connector
  remap (`_remapAssociations`), and write-side FK injection (`_injectRefsIntoData`) all
  work identically once associations reach them.
- Connectors that put plain objects in arrays continue to work without change.

---

## 3. Proposed Design

### 3.1 Connector path A — `Ref` objects in element data

The existing `Ref` contract (`{ '@id', '@entity'? }`) applies inside element objects
exactly as it does on root records. No new SDK type is needed for this path.

```typescript
// ERP connector — inside read()
{
  id: 'order-1',
  data: {
    lines: [
      { line_no: 1, product_id: { '@id': 'prod-123', '@entity': 'products' }, qty: 2 },
      { line_no: 2, product_id: { '@id': 'prod-456', '@entity': 'products' }, qty: 1 },
    ]
  }
}
```

After expansion the child record contains `product_id: { '@id': 'prod-123', '@entity':
'products' }`. The engine's Pass-1 in `_extractRefsFromData` finds it.

### 3.2 Connector path B — nested `FieldDescriptor.entity` in array item schema

The connector returns raw API payloads (plain strings) and declares FK intent in the
entity `schema`:

```typescript
schema: {
  lines: {
    type: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          product_id: { entity: 'products' },  // ← auto-synthesis trigger
        },
      },
    },
  },
}
```

The engine navigates the nested schema to extract a `Record<string, FieldDescriptor>`
for the element, then passes it to `_extractRefsFromData` as the effective schema. Pass-2
auto-synthesis handles the rest.

### 3.3 New SDK type: `ElementRecord` (for element identity override)

The `element()` factory lets a connector supply a stable element key at runtime,
sidestepping `element_key` config for computed or non-trivial keys. Associations are
expressed via `Ref` values in `data` (path A / path B above), not via a separate field.

```typescript
// packages/sdk/src/types.ts

export const ELEMENT_RECORD: unique symbol = Symbol('opensync.element');

export interface ElementRecord {
  readonly [ELEMENT_RECORD]: true;
  /** Raw element field values. May contain Ref objects for FK references. */
  data: Record<string, unknown>;
  /** Optional stable element identity — used as the element key in place of
   *  element_key config lookup. */
  id?: string;
}

/** Factory — brands the object with ELEMENT_RECORD so the engine can discriminate it
 *  from plain data objects without magic string keys in the payload.
 *  The ELEMENT_RECORD symbol is non-enumerable and invisible to JSON.stringify. */
export function element(
  rec: { data: Record<string, unknown>; id?: string }
): ElementRecord;
```

Connector usage:

```typescript
import { element } from '@opensync/sdk';

{
  id: 'order-1',
  data: {
    lines: [
      element({
        id:   'line-1',
        data: { line_no: 1, product_id: { '@id': 'prod-123', '@entity': 'products' }, qty: 2 },
      }),
    ]
  }
}
```

### 3.4 Engine: `expandArrayRecord` — `ElementRecord` detection

In `expandArrayRecord`, after the `isScalar` branch:

```typescript
// Spec: specs/field-mapping.md §3.2 — ElementRecord detection
let elementObj: Record<string, unknown>;

if (typeof element === 'object' && element !== null && ELEMENT_RECORD in (element as object)) {
  const er = element as ElementRecord;
  elementObj = er.data;
  if (er.id != null) {
    elementKeyValue = er.id;          // overrides element_key field lookup
  } else if (member.elementKey && member.elementKey in er.data) {
    elementKeyValue = String(er.data[member.elementKey]);
  } else {
    elementKeyValue = String(i);
  }
} else {
  elementObj = element as Record<string, unknown>;
  elementKeyValue = member.elementKey !== undefined && member.elementKey in elementObj
    ? String(elementObj[member.elementKey])
    : String(i);
}
```

`Ref` values in `elementObj` are carried through `mergedData` untouched—no further
change to the expander is needed.

### 3.5 Engine: `getArrayElementSchema` helper

A pure function (lives in `core/array-expander.ts` or a new `core/schema-nav.ts`):

```typescript
/**
 * Navigate the nested FieldType of a parent entity to extract the leaf-level
 * FieldDescriptor map for expanded array elements.
 *
 * Example — chain [{arrayPath:'lines'},{arrayPath:'components'}]:
 *   entityDef.schema['lines'].type.items.properties['components'].type.items.properties
 *
 * Returns undefined when the schema does not declare the array or when the item
 * type is not an object.  _extractRefsFromData gracefully handles undefined.
 */
export function getArrayElementSchema(
  entityDef: EntityDefinition | undefined,
  chain: { arrayPath: string }[],
): Record<string, FieldDescriptor> | undefined;
```

Implementation: iterate `chain`, at each level resolve `schema[arrayPath]?.type` →
expect `{ type:'array', items:{ type:'object', properties:{ … } } }` → descend into
`properties` for the next level. Return the leaf `properties`.

### 3.6 Engine: `_processRecords` — array expansion path

Remove the `// No association remapping for array child records in MVP` comment and apply
the same four-step association pipeline used for root records:

```typescript
// Spec: specs/field-mapping.md §3.2 — extract associations from child record data.
const childElementSchema = getArrayElementSchema(srcEntityDef, chain);
const childEntityDefLike = childElementSchema ? { schema: childElementSchema } : undefined;
const childInboundAssoc = this._extractRefsFromData(childRaw, childEntityDefLike as EntityDefinition | undefined);
const filteredChildAssoc = this._filterInboundAssociations(childInboundAssoc, sourceMember);
const childAssocSentinel = filteredChildAssoc.length
  ? JSON.stringify([...filteredChildAssoc].sort((a, b) => a.predicate.localeCompare(b.predicate)))
  : undefined;
```

Then:
1. Write `childAssocSentinel` into the child's `shadow_state` row (passed to
   `buildFieldData`).
2. Pass `filteredChildAssoc` to `resolveConflicts` for association change detection.
3. Pass `filteredChildAssoc` to `_dispatchToTarget` (replacing the current `undefined`).
   The remap, deferred-row, and FK-injection steps that already exist in that function
   handle the rest.

### 3.7 `collectOnly` path

Mirror the same change in the `collectOnly` array branch (around line 416 in
`engine.ts`): after expanding child records, call `_extractRefsFromData` with the
element schema and store the sentinel alongside the child shadow.

---

## 4. Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-sdk.md` | Entities § (after ReadRecord) | Add `ElementRecord` type and `element()` factory. Document `id` override. Note that FK refs on elements use `Ref` in `data`, not a separate field. |
| `specs/field-mapping.md` | §3.2 | Add "Element-level associations": describe `getArrayElementSchema`, the `_extractRefsFromData` call on child records, and the assoc sentinel write. |
| `specs/associations.md` | New §9 | "Associations on nested array elements": both connector paths (`Ref` in data; nested `FieldDescriptor.entity`); note that deferred edges, predicate mapping, and remap apply identically. |

---

## 5. Implementation Sketch

1. **`packages/sdk/src/types.ts`** — add `ELEMENT_RECORD` symbol, `ElementRecord`
   interface (no `associations` field), and `element()` factory. Export from
   `packages/sdk/src/index.ts`.

2. **`packages/engine/src/core/array-expander.ts`** (or new `core/schema-nav.ts`) —
   add `getArrayElementSchema`. Update `expandArrayRecord` for `ElementRecord` detection
   (§ 3.4). Export `getArrayElementSchema` for use in `engine.ts`.

3. **`packages/engine/src/engine.ts`** — in `_processRecords` array expansion path:
   call `getArrayElementSchema` + `_extractRefsFromData` on each child record; write
   sentinel; pass associations to `_dispatchToTarget` (§ 3.6). Mirror in `collectOnly`
   path (§ 3.7).

4. **Tests** — `packages/engine/src/array-element-associations.test.ts`:

   | ID | Scenario |
   |----|---------|
   | AEA1 | `Ref` in element data → engine dispatches remapped FK to target |
   | AEA2 | `FieldDescriptor.entity` on nested schema + plain string → auto-synthesis; FK dispatched |
   | AEA3 | `element()` with `id` → overrides `element_key` field lookup |
   | AEA4 | Mix of plain and `element()` in same array → each handled correctly |
   | AEA5 | Deferred edge: target entity not yet in identity_map → deferred row written; resolved on next cycle |
   | AEA6 | Predicate mapping via `assocMappings`: `product_id` → `productRef` on target |
   | AEA7 | `collectOnly` path: child shadow includes `__assoc__` sentinel when element has Ref |

---

## 6. Out of Scope

- **Multi-level element associations at intermediate chain levels** — this plan addresses
  the leaf level. Intermediate-hop association extraction can be added as a follow-on.
- **Write-back / collapse direction** — target connectors already receive remapped FK IDs
  injected into `data` at dispatch time (§7.3 of `specs/associations.md`). No collapse
  changes are needed.
- **Config-declared association synthesis for elements** — covered by
  `PLAN_CONFIG_DECLARED_ASSOCIATIONS.md` (stale, separate rewrite needed).
