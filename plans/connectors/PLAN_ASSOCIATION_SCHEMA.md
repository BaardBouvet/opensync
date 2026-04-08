# PLAN: Association Schema — Declaring Supported Predicates on Entities

**Status:** complete  
**Date:** 2026-04-06  
**Effort:** M  
**Domain:** packages/sdk, packages/engine  
**Scope:** EntityDefinition, dispatch filter, channel pre-flight  
**Spec:** specs/connector-sdk.md, specs/associations.md  
**Depends on:** PLAN_EAGER_ASSOCIATION_MODE.md (complete)  

---

## Spec changes planned

- `specs/connector-sdk.md` § Entities — add `associationSchema` field to `EntityDefinition`
  and document the new `AssociationDescriptor` type
- `specs/associations.md` — add section on declared vs. undeclared association schemas and
  how the engine filters at dispatch

---

## Problem

`EntityDefinition.schema` lets a connector declare metadata (description, type, required,
immutable) for each field in `data`. There is no equivalent for associations.

A connector can emit any combination of `Association` objects from `read()` and must silently
accept any `Association` objects arriving in `UpdateRecord.associations` from the engine. Neither
side is declared anywhere. This creates three concrete gaps:

**Gap 1 — Discovery**
An agent or tool wanting to understand the relationship graph of a connector must read actual
records or source code. There is no machine-readable declaration of which predicates a given
entity uses.

**Gap 2 — Channel pre-flight**
At channel setup time the engine cannot warn if a source entity declares, say,
`companyId → company` but the channel has no `company` entity. The mismatch is silent until
associations fail to resolve at runtime.

**Gap 3 — Write-side filtering**
When the engine fans out associations to a target connector, it passes all remapped
associations in `UpdateRecord.associations`. If the target entity's underlying API only
understands `companyId` and not, say, `managedBy`, the connector receives associations it
cannot act on and must silently ignore them. There is no protocol for telling the engine
"only send me the predicates I declared".

This is especially visible in:
- The SPARQL connector, where predicates are full URIs and only a declared subset are written
  back to the triplestore
- Any connector with a rigid relational schema (e.g. HubSpot contacts accept `companyId` but
  have no concept of `reportsTo`)

---

## What Does Not Change

- The `Association` type and `ReadRecord.associations` remain identical — nothing changes in
  how connectors emit associations today
- Connectors that do not declare `associationSchema` work exactly as today — the field is
  optional and the engine treats absence as "schema unknown, pass everything through"
- The `predicate`, `targetEntity`, `targetId`, `metadata` contract in `Association` is
  unchanged
- Association remapping (§ 7 of `specs/associations.md`) is unchanged — entity-name
  translation and identity-map resolution still happen regardless

---

## Proposed Design

### New type: `AssociationDescriptor`

```typescript
interface AssociationDescriptor {
  /** Entity name (connector's own, as registered in channel config) that this predicate
   *  points to. Matches Association.targetEntity values emitted by read() or expected in
   *  insert()/update(). */
  targetEntity: string;

  /** Human-readable description of the relationship.
   *  E.g. "The company this contact belongs to." Agents use this for mapping suggestions. */
  description?: string;

  /** Whether a record is considered incomplete (engine warning) if this association is absent.
   *  Does not block dispatch — it produces a warning entry in the sync result. */
  required?: boolean;

  /** Whether a single record can carry multiple associations with this predicate
   *  (e.g. a task assigned to several owners). Defaults to false (at most one). */
  multiple?: boolean;
}
```

### Extension to `EntityDefinition`

Add one optional field:

```typescript
interface EntityDefinition {
  // ... existing fields unchanged ...

  /** Association metadata: declares which predicates this entity emits from read().
   *  Mirrors the convention of schema, which describes what the entity produces.
   *  Key is the predicate string as it appears in Association.predicate — a short field
   *  name ('companyId') or a full URI ('https://schema.org/worksFor').
   *
   *  The engine also uses this as the write-side filter: when dispatching to a target
   *  entity that has associationSchema, only predicates declared here are included in
   *  UpdateRecord.associations. Omitting the field leaves behaviour unchanged (pass-through).
   */
  associationSchema?: Record<string, AssociationDescriptor>;
}
```

### Example declarations

**HubSpot contact — relational system:**
```typescript
associationSchema: {
  companyId: {
    targetEntity: 'company',
    description: 'The company this contact belongs to.',
  },
  ownerId: {
    targetEntity: 'owner',
    description: 'HubSpot user who owns this contact.',
  },
},
```

**SPARQL person — RDF/URI predicates:**
```typescript
associationSchema: {
  'https://schema.org/worksFor': {
    targetEntity: 'organization',
    description: 'Organisation the person works for.',
  },
  'https://schema.org/memberOf': {
    targetEntity: 'organization',
    description: 'Organisation the person is a member of.',
    multiple: true,
  },
},
```

---

## Engine Behaviour Changes

### § A — Channel pre-flight check (new)

When `associationSchema` is declared on a source entity, the engine checks at channel setup
time (or when `engine.addConnector()` is called) that each `associationDescriptor.targetEntity`
names an entity that is:

1. Present in the same channel **or**
2. Present in the `identity_map` via a cross-channel alias (future: see
   `PLAN_NON_LOCAL_ASSOCIATIONS.md`)

If neither condition holds, the engine emits a pre-flight warning (not an error — channels
with partially-matched schemas are valid). Warning format mirrors existing capability warnings:

```
[WARN] crm:contact.associationSchema['companyId'] targets entity 'company'
       but no 'company' entity is registered in channel 'people'.
       Associations with this predicate will have unresolvable targets.
```

### § B — Write-side association filtering at dispatch (new, opt-in via schema presence)

Following the same convention as `schema` on `EntityDefinition` (which describes what the
entity *produces*), `associationSchema` is also used as the write-side filter. When
dispatching to a target connector whose entity declares `associationSchema`, the engine
filters `UpdateRecord.associations` before calling `insert()` or `update()`:

1. Keep only associations whose `predicate` appears in the target entity's `associationSchema`
2. Drop the rest silently (a trace-level log entry is written)

If the target entity has **no** `associationSchema`, all associations pass through unchanged
(current behaviour). This preserves backward compatibility — adding `associationSchema` is an
opt-in tightening of the write-side contract, not a breaking change.

### § C — Required-association warning

When a target entity has `associationSchema` entries marked `required: true`, and a dispatched
record arrives without those associations, the engine appends a "missing_required_association"
warning to the `RecordSyncResult` for that record. Dispatch still proceeds — `required: true`
on an `AssociationDescriptor` is advisory (parallel to how `FieldDescriptor.required` works on
insert paths, but associations cannot block a dispatch the way fields can).

---

## Implementation Sequence

1. **SDK type addition** (`packages/sdk/src/types.ts`)
   - Add `AssociationDescriptor` interface
   - Add `associationSchema?: Record<string, AssociationDescriptor>` to `EntityDefinition`
   - Export `AssociationDescriptor` from `packages/sdk/src/index.ts`

2. **Spec update** (`specs/connector-sdk.md`, `specs/associations.md`)
   - Document `AssociationDescriptor` and `associationSchema` in the Entities section
   - Add a § in `associations.md` on declared schemas and engine filtering

3. **Engine pre-flight** (`packages/engine/src/`)
   - In `validateChannelConfig` (or equivalent setup path), cross-check `associationSchema`
     `targetEntity` values against channel members; emit warnings

4. **Engine dispatch filter** (`packages/engine/src/engine.ts` — fan-out path)
   - When building `UpdateRecord.associations` for a target, check whether the target entity
     has `associationSchema`; if so, filter as described in § B above

5. **Connector updates** (illustrative only — not all connectors need updating at once)
   - `connectors/sparql` — add `associationSchema` to `person` and `organization` entities
   - `dev/connectors/mock-crm` — add `associationSchema` to `contact` entity

6. **Tests**
   - Unit: `AssociationDescriptor` type round-trips through SDK
   - Engine: pre-flight warning fires when `targetEntity` absent from channel
   - Engine: dispatch filter drops `write`-excluded predicates when `associationSchema` present
   - Engine: all associations pass through when `associationSchema` absent (regression)

---

## Open Questions

1. **`multiple: false` enforcement** — Should the engine enforce that only one association
   per predicate arrives in a record when `multiple: false`? Or just document the expectation
   and leave enforcement to the connector? Leaning toward warning-only (same approach as
   `required`).

2. **Cross-channel predicate matching** — When the engine is remapping across channels (§ 7 of
   `associations.md`), predicate keys pass through unchanged (only `targetEntity` and `targetId`
   are translated). The write-side filter therefore matches against the target's
   `associationSchema` using the source predicate key. This is fine for short field-name
   predicates but may break for URI predicates where source and target use different URIs for
   the same relationship. Worth revisiting when URI predicate translation is addressed in
   `PLAN_NON_LOCAL_ASSOCIATIONS.md`.

3. **Schema-on-schema validation** — If both source and target declare `associationSchema` for
   the same predicate, and their `targetEntity` values differ even after translation, should
   the engine warn? Out of scope here but worth flagging for `PLAN_CONFIG_VALIDATION.md`.
