# PLAN: Typed Field Values — `@type` on `Ref` and Inline `TimestampedValue`

**Status:** draft  
**Date:** 2026-04-09  
**Effort:** M  
**Domain:** packages/sdk, packages/engine, connectors/sparql, connectors/hubspot  
**Scope:** `Ref`, `ReadRecord.fieldTimestamps`, ingest preprocessing, all specs and tests  
**Spec:** specs/connector-sdk.md, specs/associations.md, specs/field-mapping.md, specs/sync-engine.md  
**Depends on:** PLAN_FIELD_TIMESTAMPS.md (complete), PLAN_JSONLD_CONNECTOR_CONTRACT.md (complete)  

---

## § 1 Problem Statement

Two separate but structurally related problems with how the current protocol encodes typed
information inline in `ReadRecord.data`.

### § 1.1 `Ref['@entity']` is a non-standard JSON-LD key

`Ref` uses `@id` for the record ID (standard JSON-LD) but `@entity` for the entity type
(custom extension). The original rationale (`PLAN_JSONLD_CONNECTOR_CONTRACT.md §3.1`) was
to avoid collision with JSON-LD `@type`, which in RDF contexts carries a class URI.

That concern was overweighted. JSON-LD `@type` on a node *is* the type/class of that node —
exactly what our `@entity` carries. A Ref represents "a reference to a node of type X with
ID Y", which maps exactly to `{ '@id': Y, '@type': X }` in standard JSON-LD. RDF connectors
that use full class URIs as entity names can use those URIs as the `@type` value without any
ambiguity. The deviation from the standard adds friction for JSON-LD-native connectors and
makes the SDK feel bespoke when it can be idiomatic instead.

### § 1.2 `ReadRecord.fieldTimestamps` does not scale to nested structures

`fieldTimestamps` is a flat `Record<string, string>` keyed by top-level field names. This works
for flat records but fails for the nested array case:

```typescript
// data has a lineItems array; there is no way to express "lineItems[1].price was
// last modified on T2 while lineItems[1].sku was last modified on T1"
fieldTimestamps: { lineItems: 'T2' }  // forced to take a single timestamp for the whole array
```

The same structural limitation affected `ReadRecord.associations` before it was replaced by
inline `Ref` values in `data`. The fix is the same: move the metadata inline, next to the
value it describes, so nesting is naturally handled.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-sdk.md` | `Ref` type | Replace `'@entity'?: string` with `'@type'?: string`; update all prose and examples |
| `specs/connector-sdk.md` | `ReadRecord` | Remove `fieldTimestamps`; add `TimestampedValue` documentation; show inline timestamp pattern |
| `specs/connector-sdk.md` | Associations section | Update entity inference rules — `@entity` → `@type` throughout |
| `specs/associations.md` | §1, §2, §4 | Replace all `Ref '@entity'` references; update relational and JSON-LD examples |
| `specs/field-mapping.md` | §1.9, §7.2 | Replace `fieldTimestamps` doc with the inline `TimestampedValue` protocol |
| `specs/sync-engine.md` | Ref extraction, Ingest Loop | Update Ref shape and data-unwrapping step description |

---

## § 3 Proposed Design

### § 3.1 Rename `Ref['@entity']` → `Ref['@type']`

```typescript
// Before
interface Ref {
  '@id': string;
  '@entity'?: string;
}

// After
interface Ref {
  '@id': string;
  '@type'?: string;   // connector-local entity name (e.g. 'company') or full URI
}
```

`isRef()` is not modified — it already only checks for `'@id'`, which remains the
discriminator. Presence of `@id` is what makes something a Ref.

**Entity inference priority chain** (unchanged, key names updated):

1. Engine auto-synthesis: plain string + `entity` in `FieldDescriptor.schema` → Ref synthesized from plain string, no `@type` needed in `data`.
2. `'@type'` on an explicit `Ref` in `data` → entity name taken directly.
3. `entity` on the `FieldDescriptor` in `schema` when `'@type'` is absent from the Ref.
4. None of the above → opaque, no association derived.

**Why `@type` is unambiguous for both short names and full URIs.** A connector using connector-local short names writes `{ '@id': 'hs_456', '@type': 'company' }`. A SPARQL connector using full class URIs writes `{ '@id': 'https://example.com/org/acme', '@type': 'https://schema.org/Organization' }`. Both are valid `@type` values in JSON-LD. The engine uses whatever string appears there as the entity name. No collision arises.

### § 3.2 New `TimestampedValue` type

```typescript
/**
 * A value paired with the source-system modification timestamp for that specific field
 * (i.e. when this field *assignment* last changed — a property of the edge, not the node).
 *
 * Embed inline in `ReadRecord.data` wherever the source exposes a per-field timestamp
 * — including fields inside nested arrays. The engine strips these wrappers during ingest,
 * passing the clean `.value` forward and collecting `.dateModified` into per-field
 * timestamps for LWW resolution.
 *
 * Can wrap any value: scalars, plain objects, arrays, or Ref objects.
 * A TimestampedValue must never be nested inside another TimestampedValue.
 *
 * Spec: specs/connector-sdk.md § TimestampedValue
 */
export interface TimestampedValue {
  '@type': 'opensync:TimestampedValue';  // OpenSync-native discriminator
  value: unknown;                         // the actual field value (scalar, object, array, or Ref)
  dateModified: string;                   // ISO 8601 modification timestamp for this field assignment
}

/** Type guard — true when value is a TimestampedValue. */
export function isTimestampedValue(value: unknown): value is TimestampedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as TimestampedValue)['@type'] === 'opensync:TimestampedValue' &&
    'value' in value &&
    typeof (value as TimestampedValue).dateModified === 'string'
  );
}
```

**Disambiguation.** A `Ref` is detected by the presence of `'@id'`. A `TimestampedValue` is
detected by `'@type' === 'opensync:TimestampedValue'`. These do not overlap: a `Ref` never
has `'@type': 'opensync:TimestampedValue'`; a `TimestampedValue` never has `'@id'`.

**Why `opensync:TimestampedValue`.** The `@type` discriminator is namespaced (`opensync:`) to
signal clearly that this is an OpenSync-native protocol type, not a claim of conformance to
an external schema. The field names `value` and `dateModified` are borrowed from
`schema:PropertyValue` conventions — `schema:PropertyValue` also has both a `value` property
and inherits `dateModified` from `schema:Thing`. However, `opensync:TimestampedValue` is not
a subtype of `schema:PropertyValue` and does not fully conform to it: `schema:PropertyValue
.value` is typed as a scalar (`Boolean | Number | StructuredValue | Text`) and does not
accept linked-data nodes such as `Ref` objects. The shared field names are intentional and
useful for JSON-LD-literate readers; the semantic relationship is inspirational, not formal.

**Practical advantages over all context-based alternatives.** The inline wrapper is the
simplest design at every layer:

- *No context expansion on hot paths* — ingest walks the data tree checking for `'@type':
  'opensync:TimestampedValue'`, strips each wrapper, and collects timestamps. One recursive
  pass; no JSON-LD processor, no URI resolution.
- *No positional correlation* — side-channel approaches (flat `fieldTimestamps` map,
  per-item context objects within arrays) require maintaining two parallel structures in sync
  and break when data is reordered, sliced, or transformed. Inline wrappers are co-located
  with the value they annotate; they survive any transformation automatically.
- *Trivial SDK helpers* — `wrapTs(value, dateModified)` returns `{ '@type':
  'opensync:TimestampedValue', value, dateModified }`. Detection is a single
  `isTimestampedValue()` guard. Connector authors need no JSON-LD knowledge.

**Why not JSON-LD `@annotation` (`@container: @annotation`).** JSON-LD 1.1 has a mechanism
for annotating individual statements (edges) rather than nodes, which would be the
semantics-correct approach. It was considered and rejected for three reasons: (1) it requires
context expansion on the hot ingest path, which `PLAN_JSONLD_CONNECTOR_CONTRACT.md` explicitly
decided against; (2) `@annotation` support is sparse in JSON-LD tooling; (3) `opensync:
TimestampedValue` achieves the same semantics with a simpler, self-contained object shape
that requires no JSON-LD knowledge from connector authors.

**Why `dateModified` on a `TimestampedValue` is not the same as `dateModified` on a `Ref`.**
Placing `dateModified` directly on a `Ref` (e.g. `{ '@id': 'co-1', '@type': 'company',
dateModified: '...' }`) would be semantically wrong: in JSON-LD that reads as "co-1 was
modified at T" — a property of the *referenced entity*. What we want is "this field's
assignment to co-1 last changed at T" — a property of the *edge*. `TimestampedValue` is the
correct wrapper for this case; the `Ref` it wraps remains unmodified.

### § 3.3 Remove `ReadRecord.fieldTimestamps`

```typescript
// Removed from ReadRecord
fieldTimestamps?: Record<string, string>;
```

Connectors that previously used `fieldTimestamps` now embed timestamps inline:

```typescript
// Before
{
  id: contact.id,
  data: {
    email: contact.properties.email,
    phone: contact.properties.phone,
  },
  fieldTimestamps: {
    email: contact.properties.email_last_updated,
    phone: contact.properties.phone_last_updated,
  },
}

// After
{
  id: contact.id,
  data: {
    email: { '@type': 'opensync:TimestampedValue', value: contact.properties.email, dateModified: contact.properties.email_last_updated },
    phone: { '@type': 'opensync:TimestampedValue', value: contact.properties.phone, dateModified: contact.properties.phone_last_updated },
  },
}
```

### § 3.4 Inline timestamps in nested arrays

The inline form handles nested structures naturally. Each leaf value can carry its own
timestamp, regardless of depth:

```typescript
{
  id: 'order-1',
  data: {
    lineItems: [
      {
        sku: { '@type': 'opensync:TimestampedValue', value: 'WIDGET-1', dateModified: '2024-04-01T00:00:00Z' },
        qty: { '@type': 'opensync:TimestampedValue', value: 5,          dateModified: '2024-05-15T00:00:00Z' },
      },
    ],
    status: { '@type': 'opensync:TimestampedValue', value: 'shipped', dateModified: '2026-01-10T09:00:00Z' },
  },
}
```

### § 3.5 Timestamped `Ref` values

When a FK reference field has a per-field modification timestamp (e.g. "when did this contact
last change which company it belongs to?"), wrap the `Ref` inside a `TimestampedValue`:

```typescript
data: {
  companyId: {
    '@type': 'opensync:TimestampedValue',
    value: { '@id': 'co-1', '@type': 'company' },  // Ref — inner value, untouched
    dateModified: '2024-06-01T12:00:00Z',            // when this assignment changed
  },
}
```

The `dateModified` describes the *edge* ("when was this contact assigned to this company
last updated?"), not the node ("when was co-1 last updated?"). Placing `dateModified`
directly on the `Ref` would conflate these two meanings.

The engine's `unwrapData` pass strips the `TimestampedValue` wrapper, records the
`dateModified` for the `companyId` field, then passes the inner `Ref` to
`_extractRefsFromData` for normal association extraction.

### § 3.6 Engine ingest — data-unwrapping step

A new engine ingest pre-processing step, **`unwrapData`**, runs before `_extractRefsFromData`
and before mapping. It recursively walks `ReadRecord.data` and:

1. For any `TimestampedValue` at any depth: replaces the wrapper with its `.value` and
   records the `dateModified` against the **top-level field key** containing it.
2. For fields with multiple `TimestampedValue` leaves (nested arrays): uses `MAX` of all
   `dateModified` values found in that subtree as the timestamp for the top-level field.
3. Returns: the clean data (no `TimestampedValue` wrappers remain) and a derived
   `Record<string, number>` of per-top-level-field timestamps in epoch milliseconds.

This derived map replaces what `record.fieldTimestamps` provided and is fed into
`computeFieldTimestamps` with the same priority:

```
unwrapData(record.data) timestamps    (highest — connector-native, per-field authoritative)
shadow derivation: max(shadow.ts, ingestTs) for unchanged fields
record.updatedAt ?? ingestTs          (lowest — record-level fallback)
```

`computeFieldTimestamps` in `mapping.ts` is updated to accept the pre-computed unwrapped
timestamp map instead of reading `record.fieldTimestamps`. The function signature changes from:

```typescript
computeFieldTimestamps(
  canonical: Record<string, unknown>,
  shadow: FieldData | undefined,
  record: ReadRecord,   // previously used record.fieldTimestamps directly
  ingestTs: number,
): Record<string, number>
```

to:

```typescript
computeFieldTimestamps(
  canonical: Record<string, unknown>,
  shadow: FieldData | undefined,
  record: ReadRecord,               // still used for record.updatedAt
  ingestTs: number,
  inlineTimestamps: Record<string, number>,  // extracted by unwrapData (replaces record.fieldTimestamps)
): Record<string, number>
```

The call site in `engine.ts` passes the output of `unwrapData` as `inlineTimestamps` and also
passes the unwrapped-clean data (not `record.data` directly) to `_extractRefsFromData` and
`applyMapping`.

---

## § 4 SDK Exports

Add to `packages/sdk/src/index.ts`:

```typescript
export { isTimestampedValue } from './types.js';
export type { TimestampedValue } from './types.js';
```

---

## § 5 Connector Changes

### § 5.1 `connectors/hubspot/src/index.ts`

One explicit Ref: `{ '@id': String(toEntry.toObjectId), '@entity': 'company' }` →
`{ '@id': String(toEntry.toObjectId), '@type': 'company' }`.

No `fieldTimestamps` usage — no other changes needed.

### § 5.2 `connectors/sparql/src/index.ts`

One explicit Ref construction: `{ '@id': b.value, '@entity': def.refEntity }` →
`{ '@id': b.value, '@type': def.refEntity }`.

No `fieldTimestamps` usage — no other changes needed.

---

## § 6 Test Changes

The following test files use `'@entity'` in Ref literals and must be updated to `'@type'`:

- `packages/engine/src/association-schema.test.ts` — ~8 occurrences
- `packages/engine/src/jsonld-contract.test.ts` — ~10 occurrences

The following test files use `record.fieldTimestamps` and must be updated to use inline
`TimestampedValue` in `record.data` instead:

- `packages/engine/src/core/mapping.test.ts` — FT6, FT7 test groups (~4 occurrences)

New test groups needed for `unwrapData`:

- Flat scalar with `TimestampedValue` → clean value + correct timestamp extracted.
- Nested array with mixed `TimestampedValue` leaves → MAX timestamp used for containing field.
- Timestamped `Ref` (`opensync:TimestampedValue` wrapping a `Ref`) → Ref extracted correctly after unwrap.
- `TimestampedValue` with `dateModified` in ISO string format → parsed to epoch ms correctly.
- Plain (non-`TimestampedValue`) fields pass through unchanged.

---

## § 7 Docs Changes

- `docs/connectors/advanced.md` — update the explicit Ref example (`@entity` → `@type`).
- `docs/connectors/guide.md` — if `fieldTimestamps` is mentioned, update to inline pattern.

---

## § 8 Migration Notes

No public release has occurred. Per the AGENTS.md invariant ("No backward compatibility before
the first public release"), no shim for `@entity` is required and no `fieldTimestamps` fallback
is needed. All call sites are fixed in place; the old shape is removed entirely.

---

## § 9 What Does Not Change

- `isRef()` — still checks only `'@id'`; no change needed.
- `FieldDescriptor.entity` — still the recommended path for schema-declared FK fields (auto-synthesis).
- `ReadRecord.updatedAt`, `createdAt`, `version`, `deleted` — unchanged.
- Association extraction logic — same priority chain, only key name updated.
- `AssociationDescriptor` and `associationSchema` — unchanged.
- Write-side records (`InsertRecord`, `UpdateRecord`) — engine dispatches clean plain values; `TimestampedValue` is a read-side-only protocol; connectors never receive it on writes.
