# PLAN: Associations on Nested Array Elements (`ElementRecord`)

**Status:** stale — needs rewrite  
**Date:** 2026-04-08  
**Effort:** S  
**Domain:** packages/sdk, packages/engine  
**Scope:** `ElementRecord` SDK type; engine extraction during array expansion  
**Spec:** specs/connector-sdk.md, specs/field-mapping.md §3.2, specs/associations.md  
**Depends on:** PLAN_NESTED_ARRAY_PIPELINE.md (complete), PLAN_DEFERRED_ASSOCIATIONS.md (complete),
  PLAN_PREDICATE_MAPPING.md (complete)  
**Related:** PLAN_CONFIG_DECLARED_ASSOCIATIONS.md (config synthesis — covers element-level and root)

> **Note (2026-04-09):** This plan was written before `ReadRecord.associations?: Association[]` was
> removed from the connector API. The proposed `ElementRecord.associations` field and the
> `element()` factory examples in § 3 reference the old parallel-array API. The underlying
> need — letting connectors signal computed FK references on individual array elements — is
> still valid and unimplemented, but any redesign must use `Ref` objects in `data` and
> `FieldDescriptor.entity` in `schema` rather than a separate `associations` field.

---

## 1. Problem

Connectors can populate `ReadRecord.associations` for root-level records — the established
SDK contract for signalling FK references. But when a connector returns records with
embedded arrays, there is no SDK API to supply associations at the element level. The
connector knows which `product_id` in each order line refers to which product (and may
have computed a non-trivial `targetId` that config synthesis cannot replicate), but has no
typed way to convey that to the engine.

A typical ERP connector:

```typescript
// The connector wants to convey that each line's product_id is a FK reference.
// Today there is no SDK API for this. The connector has no choice but to omit
// the association and rely on config synthesis or manual FK fields.
{
  id: 'order-1',
  data: {
    lines: [
      { line_no: 1, product_id: 'prod-123', qty: 2 },
      { line_no: 2, product_id: 'prod-456', qty: 1 },
    ]
  }
}
```

The gaps config synthesis cannot fill:
- The FK value is computed or transformed (not a direct copy of a field value).
- Multiple fields combine to form the `targetId`.
- The connector wants to self-identify element keys without requiring `element_key` config.

---

## 2. What Does Not Change

- `ReadRecord`, `Association`, and all existing root-level association handling are unchanged.
- The forward pass processes expanded child records via the standard `_processRecords`
  pipeline; deferred edges, identity remapping, and predicate mapping all work identically
  once associations are attached.
- `associationSchema` write-side filtering on the target entity works as-is.
- Connectors that do not use `element()` continue to yield plain objects — no breaking change.

---

## 3. Proposed Design

### 3.1 New SDK type: `ElementRecord`

```typescript
// packages/sdk/src/types.ts

export const ELEMENT_RECORD: unique symbol = Symbol('opensync.element');

export interface ElementRecord {
  readonly [ELEMENT_RECORD]: true;
  /** Raw element field values. */
  data: Record<string, unknown>;
  /** Explicit references from this element to other records. Same semantics as
   *  ReadRecord.associations — connector's own entity names, connector-local IDs. */
  associations?: Association[];
  /** Optional stable element identity. When present the engine uses this value as
   *  the element key in place of element_key config for this element. */
  id?: string;
}

/** Factory — brands the object with ELEMENT_RECORD so the engine can discriminate it
 *  from plain data objects at runtime without magic string keys in the payload. */
export function element(
  rec: { data: Record<string, unknown>; associations?: Association[]; id?: string }
): ElementRecord;
```

The `ELEMENT_RECORD` symbol is non-enumerable and invisible to `JSON.stringify`, so
`ElementRecord` objects round-trip cleanly through any JSON layer.

### 3.2 Connector usage

```typescript
import { element } from '@opensync/sdk';

// Inside read(): yield records with element() wrappers on the array elements
{
  id: 'order-1',
  data: {
    lines: [
      element({
        data:         { line_no: 1, product_id: 'prod-123', qty: 2, unit_price: 49.95 },
        associations: [{ predicate: 'product_id', targetEntity: 'products', targetId: 'prod-123' }],
      }),
      element({
        data:         { line_no: 2, product_id: 'prod-456', qty: 1, unit_price: 199.00 },
        associations: [{ predicate: 'product_id', targetEntity: 'products', targetId: 'prod-456' }],
      }),
    ]
  }
}
```

The `id` field lets a connector supply element identity directly:

```typescript
element({ id: 'line-1', data: { product_id: 'prod-123', qty: 2 }, associations: [...] })
// element_key config can be omitted entirely for this element
```

### 3.3 Engine: extraction during array expansion

In the expansion step, before field mapping is applied to an element:

```typescript
// Spec: specs/field-mapping.md §3.2 — ElementRecord extraction
let rawElement: Record<string, unknown>;
let connectorAssociations: Association[];

if (ELEMENT_RECORD in element) {
  const er = element as ElementRecord;
  rawElement = er.data;
  connectorAssociations = er.associations ?? [];
  if (er.id != null) elementKeyValue = er.id;  // overrides element_key lookup
} else {
  rawElement = element as Record<string, unknown>;
  connectorAssociations = [];
}

// Config-declared synthesis (PLAN_CONFIG_DECLARED_ASSOCIATIONS) is applied next
// and the results merged with connectorAssociations before _processRecords.
```

---

## 4. Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-sdk.md` | Entities § | Add `ElementRecord` type, `ELEMENT_RECORD` symbol, and `element()` factory to the SDK reference. Document `id` override behaviour. |
| `specs/field-mapping.md` | §3.2 | Add engine extraction step: check `ELEMENT_RECORD` brand, extract `.data`/`.associations`/`.id`. Note merge with config synthesis (see PLAN_CONFIG_DECLARED_ASSOCIATIONS). |
| `specs/associations.md` | New §8 | Add "Associations on nested array elements" section: document `ElementRecord` as the connector-supplied path; reference config-synthesis as the common path for connectors not using `element()`. |

---

## 5. Implementation Sketch

1. **`packages/sdk/src/types.ts`** — add `ELEMENT_RECORD` symbol, `ElementRecord` interface,
   and `element()` factory. Export from `packages/sdk/src/index.ts`.

2. **Array expansion ingest code** — before field mapping per element: check
   `ELEMENT_RECORD in element`; if present, destructure `.data`/`.associations`/`.id` and
   override `elementKeyValue` when `.id` is set. Pass `connectorAssociations` to the merge
   step (implemented in the config synthesis plan).

3. **Tests** — `packages/engine/src/array-element-associations.test.ts`:

   | ID | What it tests |
   |----|---------------|
   | AEA1 | `element()` with associations: engine attaches to child record and dispatches remapped association to target |
   | AEA2 | `element()` without associations: plain extraction, no associations on child record |
   | AEA3 | `element()` with `id`: overrides `element_key` field lookup for that element |
   | AEA4 | Mix of plain and `element()` in same array: each handled correctly |
   | AEA5 | Deferred edge: product not yet in identity_map → deferred row written; resolved on next cycle |
   | AEA6 | Predicate mapping: `product_id` → `productRef` via `assocMappings` |

---

## 6. Out of Scope

- **Config-declared association synthesis** (root records and nested elements) — covered
  in `PLAN_CONFIG_DECLARED_ASSOCIATIONS.md`.
- **Multi-level element associations** — both paths apply at each depth but the
  multi-level canonical ID threading needs a dedicated follow-on.
- **Write-back (reverse pass)** — target connectors already receive associations in
  `UpdateRecord.associations` and inject the FK themselves (§7.3). No collapse changes needed.
