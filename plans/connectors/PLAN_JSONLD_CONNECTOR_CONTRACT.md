# PLAN: JSON-LD Connector Contract

**Status:** complete  
**Date:** 2026-04-08  
**Effort:** L  
**Domain:** packages/sdk, packages/engine, all connectors  
**Scope:** Connector record types (read + write); FieldType schema extension; association handling  
**Spec:** specs/connector-sdk.md, specs/associations.md, specs/field-mapping.md  
**Depends on:** PLAN_ASSOCIATION_SCHEMA.md (complete), PLAN_PREDICATE_MAPPING.md (complete)  
**Related:** PLAN_CONFIG_DECLARED_ASSOCIATIONS.md, PLAN_ARRAY_ELEMENT_ASSOCIATIONS.md

---

## 1. Motivation

### The read-side duplication problem

A connector that knows `companyId` is a FK reference must repeat the value twice:

```typescript
{
  id: 'contact-42',
  data: { name: 'Alice', companyId: 'hs_456' },
  associations: [{ predicate: 'companyId', targetEntity: 'company', targetId: 'hs_456' }]
}
```

`companyId` appears once as a plain string in `data` and again in `associations`. Connectors
that forget to populate `associations` silently lose cross-system reference resolution.
Connectors that return raw API responses never populate it at all.

### The write-side ergonomics problem

A connector receiving an update currently gets:

```typescript
{
  id: 'contact-42',
  data: { name: 'Alice' },
  associations: [{ predicate: 'companyId', targetEntity: 'company', targetId: '99' }]
}
```

The field has been stripped from `data` and the remapped ID lives in a separate
`associations` list. The connector must manually reassemble the write payload:

```typescript
const companyId = rec.associations?.find(a => a.predicate === 'companyId')?.targetId;
await api.patch(`/contacts/${rec.id}`, { ...rec.data, companyId });
```

This disconnect — the engine separates what the API treats as one thing — is the largest
friction point in the current connector contract. It compounds when arrays of elements each
carry their own FK references (`ElementRecord`, `PLAN_ARRAY_ELEMENT_ASSOCIATIONS.md`).

### What JSON-LD offers

JSON-LD represents a reference to another resource as an object with `"@id"`:

```json
{ "companyId": { "@id": "hs_456" } }
```

This is unambiguous (it can't be a plain scalar), co-located (no parallel list), and
self-describing. The SPARQL connector already uses this model internally — `worksFor` is an
`{ "@id": uri }` value; the connector then emits the explicit `associations` list from it.

Adopting `{ "@id": string }` as a first-class value type in the connector contract removes
the duplication on reads and, critically, **allows the engine to inject remapped target IDs
directly into the write payload** — the connector never needs to look at `associations` again.

---

## 2. What Does Not Change

- The engine's internal representation of associations (`Association` type,
  `deferred_associations`, shadow state sentinel, identity map, predicate mapping pipeline,
  `associationSchema` write-side filtering) is **unchanged**. JSON-LD is a surface change
  on the connector boundary layer, not an engine rewrite.
- Field mapping, conflict resolution, watermarks, webhooks, OAuth — all unchanged.
- `@context` is **optional** throughout. Connectors with opaque local IDs (HubSpot
  integers, ERP codes) do not need URI predicates. Full JSON-LD semantics (context,
  compact IRIs, term definitions) are available for RDF connectors but never required.
- Connector `read()`, `insert()`, `update()`, `delete()`, `lookup()` — signatures unchanged.
  Only the _shape of the records_ passed in and out changes.

---

## 3. Core Change: Inline Reference Values

### 3.1 New FieldValue type: `Ref`

Add one new value shape to the union of things that can appear in `data`:

```typescript
// packages/sdk/src/types.ts

/** An inline reference to another record.
 *  Appears as a field value wherever the field is a foreign key.
 *
 *  On read:  connector sets this; engine extracts an Association automatically.
 *  On write: engine injects the remapped target-connector-local ID here; connector reads it.
 *
 *  '@entity' is the connector's own entity name (same as Association.targetEntity).
 *  Omit '@entity' when the schema already declares the ref target (engine fills it in
 *  for writes; connector must supply it on reads if @entity is needed for disambiguation).
 */
export interface Ref {
  '@id': string;
  '@entity'?: string;
}
```

`@id` carries the record's local ID in the connector's namespace. `@entity` carries the
connector-local entity name — exactly what `Association.targetEntity` holds today.

We use `@entity` rather than `@type` to avoid collision with the standard JSON-LD `@type`
property, which in RDF contexts means the resource's class URI, not its engine entity name.
For connectors using URI predicates, `@type` (a full URI class) and `@entity` (engine entity
name, possibly the same URI) can coexist without conflict.

> **Why not plain JSON-LD `{ "@type": "@id" }` term definition in `@context`?**
> Context-based type coercion is correct for full JSON-LD but requires every consumer of the
> record to expand the context before interpreting values. The engine's field mapping and
> diff layers work on raw values; adding context expansion to those hot paths complicates
> the engine for a purity gain connectors don't need. `Ref` is our pragmatic subset.

### 3.2 Revised read-side record

```typescript
// ReadRecord.data may now contain Ref values wherever a field is a reference.
// All other fields remain plain scalars, arrays, or objects as before.
{
  id: 'contact-42',
  data: {
    name: 'Alice',
    email: 'alice@example.com',
    companyId: { '@id': 'hs_456', '@entity': 'company' },
  }
}
```

No `associations` field required. The engine extracts associations from all `Ref`-valued
fields automatically during ingest preprocessing.

Connectors that return raw API responses without any `Ref` values can rely on config
synthesis (`PLAN_CONFIG_DECLARED_ASSOCIATIONS.md`) — no connector change needed.

### 3.3 Schema extension: ref field type

`FieldType` gains a reference variant:

```typescript
// packages/sdk/src/types.ts
type FieldType =
  | 'string' | 'number' | 'boolean' | 'null'
  | { type: 'object'; properties?: Record<string, FieldType> }
  | { type: 'array'; items?: FieldType }
  | { type: 'ref'; entity: string };    // NEW — FK reference to named entity
```

Example entity schema:

```typescript
schema: {
  name:      { type: 'string', description: 'Contact full name' },
  email:     { type: 'string', description: 'Primary email' },
  companyId: { type: 'ref', entity: 'company', description: 'Parent company' },
}
```

A field declared `{ type: 'ref', entity: 'company' }` subsumes the corresponding entry in
`associationSchema`. The engine derives the association predicate from the field name and
the target entity from `entity`. `associationSchema` is still accepted for backward
compatibility and for cases where predicates are URI strings that differ from the field
name (RDF connectors).

---

## 4. Write Contract: Inline ID Injection

### 4.1 Today

The engine delivers associations in a parallel list and the connector must extract and
merge them manually:

```typescript
// Update today — connector must do FK injection itself
{
  id: 'contact-42',
  data: { name: 'Alice' },
  associations: [{ predicate: 'companyId', targetEntity: 'company', targetId: '99' }]
}
```

### 4.2 Proposed

The engine injects the remapped target-connector-local ID directly into `data` as a `Ref`
value. `associations` is removed from `InsertRecord` and `UpdateRecord`.

```typescript
// InsertRecord (proposed)
export interface InsertRecord {
  /** Field values to write. Ref-valued fields carry the remapped target-local ID. */
  data: Record<string, unknown | unknown[]>;   // same shape; Ref may appear as value
}

// UpdateRecord (proposed)
export interface UpdateRecord {
  id: string;
  data: Record<string, unknown | unknown[]>;   // Ref values injected by engine
  version?: string;
  snapshot?: Record<string, unknown>;
}
```

The connector receives:

```typescript
{
  id: 'contact-42',
  data: {
    name: 'Alice',
    companyId: { '@id': '99' },   // remapped target-local ID, ready to use
  }
}
```

The connector reads it as:
```typescript
const companyId = (rec.data.companyId as Ref | undefined)?.['@id'];
await api.patch(`/contacts/${rec.id}`, { ...rec.data, companyId });
// Or, for an API that speaks JSON-LD directly: pass rec.data verbatim.
```

### 4.3 What the engine does at dispatch time

The existing association remapping pipeline (§7.2 of `specs/associations.md`) runs
unchanged. At the end, instead of placing the remapped association in
`UpdateRecord.associations`, the engine:

1. Looks up the target field name for this predicate (the predicate name IS the field name
   for relational connectors; for URI-predicate connectors it's in mappings config).
2. Writes `data[fieldName] = { '@id': remappedTargetLocalId }`.
3. Does **not** populate `UpdateRecord.associations`.

The `associationSchema` write-side filter (§8.1 of `specs/associations.md`) still applies —
only predicates declared in the entity schema (either as `{ type: 'ref' }` field or in
`associationSchema`) get injected. Undeclared predicates are dropped.

### 4.4 Source-inexpressible predicate preservation

The §8.4 merge rule (preserve target-shadow associations for predicates the source cannot
express) is unchanged in logic but implemented differently: the engine keeps those
predicates as additional `Ref` values in `data` rather than `associations`. From the
connector's perspective there is no difference — the FK values are all in `data`.

---

## 5. SDK Helpers

Connector authors should never need to write `(rec.data.companyId as Ref | undefined)?.['@id']`
or manually build `{ '@id': id, '@entity': entity }` objects. The SDK exports a small helper
module that handles both directions.

### 5.1 `readRefs(data, schema)` — extract plain values from a write payload

For connectors that need to pass a plain object to their API (most REST APIs), `readRefs`
produces a flat, `Ref`-free copy of `data` ready to send:

```typescript
import { readRefs } from '@opensync/sdk';

async *update(records, ctx) {
  for await (const rec of records) {
    // Converts { name: 'Alice', companyId: { '@id': '99' } }
    //       to { name: 'Alice', companyId: '99' }
    const payload = readRefs(rec.data);
    await ctx.http(`/contacts/${rec.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    yield { id: rec.id };
  }
}
```

`readRefs` recursively unwraps `{ '@id' }` objects to their string value, including inside
nested objects and arrays. Non-`Ref` values pass through unchanged. For connectors that speak
JSON-LD natively, passing `rec.data` verbatim is equally valid.

```typescript
// packages/sdk/src/helpers.ts
export function readRefs(data: Record<string, unknown>): Record<string, unknown>;
```

### 5.2 `makeRefs(data, schema)` — add `Ref` wrappers on the read side

For connectors that receive plain API responses and want to produce `Ref` values without
manually wrapping each FK field, `makeRefs` does the conversion given the entity schema:

```typescript
import { makeRefs } from '@opensync/sdk';

async *read(ctx, since) {
  for (const contact of await fetchContacts(ctx)) {
    yield {
      records: [{
        id: contact.id,
        // contact = { name: 'Alice', companyId: 'hs_456', email: '...' }
        // schema declares companyId as { type: 'ref', entity: 'company' }
        // result: { name: 'Alice', companyId: { '@id': 'hs_456', '@entity': 'company' }, email: '...' }
        data: makeRefs(contact, schema),
      }]
    };
  }
}
```

`makeRefs` reads the entity `schema`, finds fields declared as `{ type: 'ref', entity: E }`,
and wraps their values with `{ '@id': value, '@entity': E }`. Null / absent values are left
as-is (no `Ref` emitted). Fields not in the schema pass through unchanged.

```typescript
// packages/sdk/src/helpers.ts
export function makeRefs(
  data: Record<string, unknown>,
  schema: EntityDefinition['schema'],
): Record<string, unknown>;
```

For nested arrays of elements the helper walks array values and applies the same wrapping
using the `items` type on `{ type: 'array', items: { type: 'ref', entity: E } }` fields.

### 5.3 Relationship to config synthesis

Connectors using `makeRefs` do not need `record_associations` config — the `Ref` values
are self-describing. `makeRefs` is the recommended path for connector authors who control
the SDK import and know their schema at write time. Config synthesis
(`PLAN_CONFIG_DECLARED_ASSOCIATIONS.md`) is the fallback for connectors that return raw
responses and are not being modified.

---

## 6. `@context` for RDF Connectors

RDF connectors (SPARQL) use full URI predicates and `@id` IRIs as local IDs. They already
build associations with URI predicates today. The new contract is a natural fit:

```typescript
// SPARQL connector read output (proposed)
{
  id: 'https://example.com/people/alice',
  data: {
    'https://schema.org/name': 'Alice',
    'https://schema.org/worksFor': {
      '@id': 'https://example.com/orgs/acme',
      '@entity': 'organization',
    }
  }
}
```

The engine auto-extracts the association; no separate `rowToRecord` association-building
step needed. The SPARQL connector `makeRdfEntity` factory simplifies.

To avoid verbose URI keys in config mappings, connectors may declare a `context`
on `EntityDefinition`:

```typescript
// New optional field on EntityDefinition (proposed)
context?: {
  '@context': Record<string, string | Record<string, string>>;
};
```

Example:

```typescript
context: {
  '@context': {
    name:     'https://schema.org/name',
    worksFor: 'https://schema.org/worksFor',
    org:      { '@id': 'https://schema.org/worksFor', '@type': '@id' },
  }
}
```

With a declared context the connector and the channel config can use short names (`worksFor`)
instead of full URIs. The engine expands short names to full URIs when reading records from
this entity, and compacts URIs back to short names when writing to it. Context expansion is
compiled once at entity registration time.

`context` is optional. Connectors without it use field-name strings verbatim throughout.

---

## 7. Association Inference Rule

When the engine encounters a `Ref` value in `data` during ingest it applies this rule to
derive the `Association`:

1. If the field name matches a `{ type: 'ref', entity: E }` in `schema` → entity = E.
2. Else if the field name matches a key in `associationSchema` → entity = `associationSchema[key].targetEntity`.
3. Else → no association derived from this value (it's treated as an opaque object).

The predicate in the derived `Association` is always the field name (after context
compaction, if applicable). This derived association is subject to the same predicate
mapping pipeline as explicitly-declared ones (§7.5).

---

## 8. Impact on Existing Connectors

| Connector | Read-side change | Write-side change |
|-----------|-----------------|-------------------|
| **HubSpot** | Replace `associations: [...]` construction with `{ '@id': ..., '@entity': ... }` field values in `data`. Drop the `fetchContactCompanyAssocs` merge step. | Remove `writeContactCompanyAssocs`; read `data.companyId?.['@id']` instead. |
| **SPARQL** | `rowToRecord` association-building loop simplifies — just assign `{ '@id': binding.value, '@entity': def.refEntity }` for IRI bindings. | `buildTriples` reads `toRdfTerm(data[field]?.['@id'] ?? data[field])` for ref fields. |
| **mock-crm / mock-erp** | Add `'@entity'` to relevant FK fields. | Read `data.companyId?.['@id']`. |
| **postgres / tripletex / waveapps / kafka** | Update once associations are relevant. | Same pattern. |

Pure-data connectors with no association predicates require **no changes** — the new
`Ref` type is additive.

---

## 9. Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-sdk.md` | `ReadRecord` | Replace `associations` field with `Ref`-typed data values. Remove `ReadRecord.associations`, `InsertRecord.associations`, and `UpdateRecord.associations`. |
| `specs/connector-sdk.md` | SDK helpers | Document `readRefs` and `makeRefs`. |
| `specs/connector-sdk.md` | `InsertRecord` / `UpdateRecord` | Remove `associations` field. Document `Ref` values in `data` as the FK injection mechanism. |
| `specs/connector-sdk.md` | `FieldType` | Add `{ type: 'ref'; entity: string }` variant. Explain relationship to `associationSchema`. |
| `specs/connector-sdk.md` | `context` on `EntityDefinition` | New optional field; document context compilation and short-name expansion. |
| `specs/associations.md` | §7 remapping steps | Step 6 now writes `Ref` value into `data[predicate]` instead of pushing to `associations`. |
| `specs/associations.md` | §8.4 inexpressible predicate preservation | Update: preserved predicates are kept as `Ref` values in `data`, not in `associations`. |

---

## 10. Resolved Design Questions

**Q1 — `@entity` on writes.**  
The engine includes `@entity` in the injected `Ref` so the connector can inspect it for
debugging or for APIs that accept JSON-LD directly. The SDK `readRefs` helper strips it when
unwrapping to plain values, so connectors using the helper see no overhead.

**Q2 — Multi-valued reference fields.**  
A field declared `{ type: 'array', items: { type: 'ref', entity: 'tags' } }` holds an array
of `Ref`s. Semantics: the engine injects the **complete current set** of known associations
for this predicate — all `targetId`s that are resolved in the identity map at dispatch time.
This mirrors how the old `associations` list worked: the engine passed the full known set,
not a diff. Unresolved targets are deferred and injected on the next cycle once they appear.
The engine injects `[]` (empty array) when no associations for this predicate are known,
distinct from `undefined` (predicate not applicable for this record). Connectors that need
set semantics (replace-all) use `[]` vs non-empty to know whether to clear existing links.

**Q3 — Snapshot field.**  
`UpdateRecord.snapshot` is a verbatim copy of the most recent `lookup()` result for this
record, keyed with the connector's own field names. Because `lookup()` returns `ReadRecord`
and `ReadRecord.data` may now contain `Ref` values, the snapshot carries `Ref` values for
any FK fields the connector chose to wrap. No separate transform pass needed — it follows
automatically from the connector's own `read()`/`lookup()` output shape.

**Q4 — Backward compat for `UpdateRecord.associations`.**  
No backward compat. `associations` is removed from `InsertRecord` and `UpdateRecord`. All
existing connectors are updated in the same working session. The HubSpot `writeContactCompanyAssocs`
batch-write helper is replaced by reading `data.companyId?.['@id']` in the normal update path.

---

## 11. Implementation Sketch

1. **`packages/sdk/src/types.ts`** — add `Ref` interface; add `{ type: 'ref'; entity: string }`
   to `FieldType`; add optional `context` to `EntityDefinition`; remove `associations` from
   `InsertRecord`, `UpdateRecord`, and `ReadRecord`.

2. **`packages/sdk/src/helpers.ts`** — implement `readRefs(data, schema)` and
   `makeRefs(data, schema)`. Export from `packages/sdk/src/index.ts`.

3. **Ingest preprocessing** — before calling `_processRecords`, scan `record.data` for `Ref`
   values; derive associations using the inference rule (§7); proceed with derived list
   (no merge needed — `ReadRecord.associations` is removed). O(fields) scan.

4. **Dispatch injection** — after the association remapping pipeline, write
   `data[predicate] = { '@id': remappedId, '@entity': targetEntity }` instead of pushing
   to `associations`. For array-valued predicates inject `[{ '@id': id }, ...]`.

5. **Context compilation** — at entity registration time, if `entity.context` is present,
   compile the `@context` into a forward map (short → URI) and reverse map (URI → short).
   Apply forward map when reading `data` keys; apply reverse map when writing `data` keys.

6. **`FieldType` ref inference** — ingest preprocessing reads `entity.schema` to apply
   the inference rule (§7). No config-load change needed.

7. **Connector updates** — update HubSpot (remove `fetchContactCompanyAssocs` /
   `writeContactCompanyAssocs`; use `Ref` values and `readRefs`), SPARQL (simplify
   `rowToRecord`), mock-crm, mock-erp. Pure-data connectors need no changes.

8. **Tests** — extend `packages/engine/src/association-schema.test.ts` and add
   `packages/engine/src/jsonld-contract.test.ts`:

   | ID | What it tests |
   |----|---------------|
   | JLC1 | Connector yields `Ref` value in `data`: engine extracts association, dispatches remapped `Ref` in write payload |
   | JLC2 | Engine write injection: `data.companyId` receives `{ '@id': remappedId, '@entity': 'company' }` |
   | JLC3 | `{ type: 'ref' }` schema field drives inference rule (§7, rule 1) |
   | JLC4 | `associationSchema` drives inference rule (§7, rule 2) — backward compat path |
   | JLC5 | Neither schema nor `associationSchema`: `Ref`-shaped value treated as opaque object |
   | JLC6 | `@context` compilation: short name expanded to URI on read; compacted on write |
   | JLC7 | Inexpressible predicates preserved as `Ref` values in `data` on update |
   | JLC8 | Multi-valued ref field: engine injects full association set as `Ref[]` |
   | JLC9 | Multi-valued ref field: empty `[]` injected when no associations resolved |
   | JLC10 | `readRefs` unwraps `Ref` to plain string; nested objects and arrays unwrapped recursively |
   | JLC11 | `makeRefs` wraps FK fields per schema; null values left as-is; non-schema fields unchanged |

---

## 12. Out of Scope

- **Full JSON-LD processing** — `@graph`, `@set`, `@list`, `@nest`, blank nodes,
  `@reverse`, named graphs. These are not needed for any current connector use case. A
  connector that needs them can pre-process its API responses into flat `Ref`-using records.

- **JSON-LD framing / compaction API** — no dependency on json-ld.org libraries.
  The engine implements only the `@ context` term expansion subset (§5), not the full
  processing algorithm.

- **`ReadRecord.associations` removal** — `associations` is removed from all three record
  types (`ReadRecord`, `InsertRecord`, `UpdateRecord`). Config synthesis
  (`PLAN_CONFIG_DECLARED_ASSOCIATIONS.md`) is the fallback for raw-response connectors.
