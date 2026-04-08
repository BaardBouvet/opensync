# PLAN: Schema-Driven Ref Auto-Synthesis

**Status:** complete  
**Date:** 2026-04-08  
**Effort:** XS  
**Domain:** packages/engine, packages/sdk  
**Scope:** `_extractRefsFromData` ingest path; `makeRefs()` helper semantics  
**Spec:** specs/connector-sdk.md, specs/associations.md  
**Depends on:** PLAN_JSONLD_CONNECTOR_CONTRACT.md (complete)  
**Related:** PLAN_CONFIG_DECLARED_ASSOCIATIONS.md (YAML-layer equivalent for connectors without schema metadata)

---

## 1. Problem

A connector that declares

```typescript
schema: {
  companyId: { type: 'ref', entity: 'company', description: 'Parent company' },
}
```

must still call `makeRefs(data, schema)` inside `read()` — or construct Ref objects by hand
— for the engine to recognise `companyId` as an association reference. A connector that
returns the raw API response verbatim (`companyId: 'hs_456'` as a plain string) gets no
association inference even though the schema fully describes the intent.

This creates a two-step obligation:

1. Declare the field type in `schema`
2. Also call `makeRefs()` (or build Refs manually) in `read()`

The schema declaration already contains all information the engine needs. Having to repeat
the intent in `read()` is redundant and is a source of bugs — connector authors declare the
schema but forget the helper call, silently losing cross-system FK remapping.

---

## 2. Paths to Association Inference — the Full Picture

| Source of truth | Who acts | Connector code change? |
|----------------|----------|----------------------|
| Connector builds `Ref` objects explicitly in `read()` | Connector | Yes — construct `{ '@id': …, '@entity': … }` |
| Connector calls `makeRefs(data, schema)` in `read()` | Connector | Yes — one helper call |
| **Schema auto-synthesis (this plan)** | **Engine (ingest)** | **No — just declare `schema`** |
| Config `record_associations` (PLAN_CONFIG_DECLARED_ASSOCIATIONS) | Engine (config) | No — YAML config change only |

Schema auto-synthesis is the recommended light path for SaaS connectors: declare the schema
once and return raw API payloads. `makeRefs()` remains useful when the connector needs Ref
objects in its own write logic.

---

## 3. Proposed Change

### 3.1 Extend `_extractRefsFromData` to synthesize from plain strings

Currently the method only processes values for which `isRef(v)` is true. Add a secondary
pass over fields declared `{ type: 'ref', entity: E }` in the entity schema:

```typescript
// Pseudo-code for the new rule (applied after existing Ref extraction)
for (const [field, descriptor] of Object.entries(entityDef?.schema ?? {})) {
  if (descriptor.type?.type !== 'ref') continue;           // not a ref field
  const value = data[field];
  if (value === undefined || value === null) continue;
  if (isRef(value)) continue;                              // already a Ref — already handled
  if (typeof value !== 'string') continue;                 // only synthesize from strings
  if (!value) continue;                                    // empty string — skip
  associations.push({
    predicate: field,
    targetEntity: descriptor.type.entity,
    targetId: value,
  });
}
```

The ingest preprocessing step (currently in `collectOnly` / `_processRecords`) then injects
the synthesized Ref back into the record's `data` so downstream processing (shadow diff,
`_injectRefsIntoData`) works identically to the explicit-Ref path.

### 3.2 Inject synthesized Ref into `data`

After synthesis, wrap the plain string as a `Ref` in a copy of `data` before passing it
forward — the same transformation `makeRefs()` performs:

```typescript
for (const assoc of synthesizedAssociations) {
  data = { ...data, [assoc.predicate]: { '@id': assoc.targetId, '@entity': assoc.targetEntity } };
}
```

This normalizes the record so the rest of the pipeline (shadow write, `_injectRefsIntoData`,
Ref stripping before dispatch) is unaware of how the Ref arrived.

### 3.3 Array ref fields

A field declared `{ type: 'array', items: { type: 'ref', entity: E } }` whose value is an
array of plain strings should synthesize one association per non-empty string element and
replace the array value with an array of Ref objects.

Array synthesis is handled in the same pass but only when the value is `string[]`.

### 3.4 `makeRefs()` is unchanged

`makeRefs(data, schema)` continues to work exactly as before. Connectors that call it before
yielding will produce Ref objects; the engine's auto-synthesis pass is a no-op for fields
that are already Refs (the `isRef(value) → continue` guard in § 3.1).

---

## 4. What Does Not Change

- `ReadRecord` and all SDK types — no interface changes.
- All downstream association handling — deferred edges, predicate mapping, identity
  remapping, `associationSchema` write-side filtering — is unaffected.
- Connectors that build Refs explicitly or call `makeRefs()` are unaffected.
- Config `record_associations` (PLAN_CONFIG_DECLARED_ASSOCIATIONS) is unaffected and
  remains the fallback for connectors with no schema metadata at all.

---

## 5. Migration / Rollout

1. Ship the engine change.  
2. SaaS connector authors need only declare `{ type: 'ref', entity: … }` in their entity
   `schema` and return raw API payloads. No `read()` code change required.  
3. Connectors that already call `makeRefs()` continue to work — the idempotency guard
   ensures no double-wrapping.

---

## 6. Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-sdk.md` | `§ Association Schema` / FieldType ref variant | Document that `{ type: 'ref', entity }` in schema is sufficient; engine auto-synthesizes Refs from plain string values during ingest — connector does not need to call `makeRefs()`. `makeRefs()` remains available for connectors that need Refs in write logic. |
| `specs/associations.md` | Entity Inference table | Add "plain string value + schema `{ type: 'ref' }`" as equivalent path to explicit Ref. |
