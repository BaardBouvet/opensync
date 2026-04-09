# PLAN: Association API Cleanup — Update Stale Plans After Connector API Refactor

**Status:** complete  
**Date:** 2026-04-09  
**Effort:** S  
**Domain:** plans/, connectors/waveapps  
**Scope:** Plan status updates, code example corrections, one live bug fix  
**Spec:** specs/connector-sdk.md, specs/associations.md  

---

## Background

A series of changes (visible in `CHANGELOG.md [Unreleased]`) removed the explicit
association API from the connector-facing contract:

| What changed | Old API | New API |
|---|---|---|
| `ReadRecord.associations?: Association[]` | Connectors built an `Association[]` alongside `data` | Connectors embed `Ref` objects (`{ '@id', '@entity'? }`) directly in `data`; engine extracts the association graph by scanning for `Ref`-shaped values |
| `InsertRecord.associations` / `UpdateRecord.associations` | Engine injected parallel association arrays into write payloads | Engine injects remapped FK strings directly into the relevant `data[predicate]` field |
| `EntityDefinition.associationSchema` / `AssociationDescriptor` | Connectors declared supported predicates via a dedicated schema field | FK declarations live exclusively on `FieldDescriptor.entity` in `EntityDefinition.schema` |

Several plans were written before or during this refactor and now contain incorrect premises,
stale examples, or wrong status values.  One connector has a live TypeScript error.

---

## § 1 Spec changes planned

None.  All relevant spec files (`specs/connector-sdk.md`, `specs/associations.md`) were
already updated as part of the refactor.  This plan makes no spec changes.

---

## § 2 Live Bug: waveapps connector

`connectors/waveapps/src/index.ts` — `invoiceToRecord()` constructs a `ReadRecord` with a
top-level `associations: [...]` field.  The root workspace `tsc` task does not cover this
package; running `tsc --noEmit` inside `connectors/waveapps/` surfaces:

```
src/index.ts:607:5 - error TS2353: Object literal may only specify known properties,
  and 'associations' does not exist in type 'ReadRecord'.
```

**Fix:** Remove the `associations` array from `invoiceToRecord()`.  The `customer.id` field
already appears in `data["customer.id"]` and the entity `schema` declares
`{ entity: 'customer' }` on `FieldDescriptor` for that field, so the engine synthesises the
`Ref` automatically — no explicit association array is needed.

---

## § 3 Plan status corrections

> Completed plans are left as historical records. Only plans in `proposed`, `draft`, or
> `backlog` state are updated.

### § 3.1 Plans marked `stale — needs rewrite`

**`plans/engine/PLAN_ARRAY_ELEMENT_ASSOCIATIONS.md`** (currently `proposed`)  
The plan's problem statement says "Connectors can populate `ReadRecord.associations` for
root-level records — the established SDK contract" and its "What Does Not Change" block
explicitly says "`ReadRecord`, `Association`, and all existing root-level association
handling are unchanged."  Both are now false.  The underlying need — letting a connector
signal FK references on individual array elements when the FK value is computed or
non-trivial — is still valid and unimplemented.  Mark the status `stale — needs rewrite`
and note that the redesign must use the `Ref`-in-`data` / `FieldDescriptor.entity`
approach rather than a parallel `associations` field.

**`plans/engine/PLAN_CONFIG_DECLARED_ASSOCIATIONS.md`** (currently `proposed`)  
The plan's core premise is "most connectors never populate `ReadRecord.associations`" and
the fix is config-driven synthesis of `Association` objects from FK field values.  With
`ReadRecord.associations` gone entirely, the mechanism layer no longer applies.  The idea
itself — declaring FK targets in YAML without touching the connector — is still worthwhile
(especially for connectors with computed or path-navigated FK values), but it must now be
described in terms of synthesising `Ref` inference from config rather than building
`Association[]`.  Mark the status `stale — needs rewrite`.

---

## § 4 Plans with stale examples (cosmetic, no logic change needed)

These plans are either complete or concern engine internals that were not changed by the
refactor.  The only issue is that inline code samples showing `associations: [...]` on
`ReadRecord` no longer match the live API.  Update the examples in-place; no status change
is needed unless the plan description contradicts current behaviour.

### § 4.1 `plans/connectors/PLAN_NON_LOCAL_ASSOCIATIONS.md` (draft)

The cross-channel entity-name translation problem (SPARQL connectors in different channels
sharing URI identity) is still real and unimplemented.  Two code blocks show
`associations: [{ predicate, targetEntity, targetId }]` as connector output; these should
become `data['https://schema.org/organizer'] = { '@id': '...', '@entity': 'organization' }`.
The rest of the plan is unaffected.

### § 4.2 `plans/engine/PLAN_CIRCULAR_ASSOCIATION_DEADLOCK.md` (backlog)

Strict mode + deadlock detection is still valid backlog work.  Section 2 shows two records
with `associations: [...]`; update to show them as `Ref` values in `data` instead.  No
other changes needed.

### § 4.3 `plans/meta/REPORT_ASSOCIATION_NAMING.md` (draft)

The inventory table in § 2 lists `associations?: Association[]` on `ReadRecord`,
`InsertRecord`, and `UpdateRecord` at the SDK layer — all three have been removed.  Update
the inventory to remove those rows and note that the connector-facing surface is now `Ref`
objects in `data` and `FieldDescriptor.entity` in `schema`.  The naming question itself
remains open and unchanged.

---

## § 5 Work items (in order)

1. Fix `connectors/waveapps/src/index.ts` — remove `associations` from `invoiceToRecord()`
   and add `entity: 'customer'` to the `customer.id` `FieldDescriptor` in the schema.
2. Update `plans/engine/PLAN_ARRAY_ELEMENT_ASSOCIATIONS.md` status → `stale — needs rewrite`;
   add a note at the top explaining why.
3. Update `plans/engine/PLAN_CONFIG_DECLARED_ASSOCIATIONS.md` status → `stale — needs rewrite`;
   add a note at the top explaining why.
4. Update code examples in `PLAN_NON_LOCAL_ASSOCIATIONS.md`,
   `PLAN_CIRCULAR_ASSOCIATION_DEADLOCK.md`, and `REPORT_ASSOCIATION_NAMING.md`.
5. Update `plans/INDEX.md` to reflect status changes for all affected plans.
