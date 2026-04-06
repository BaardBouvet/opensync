# Engine: Association Predicate Mapping

**Status:** complete  
**Date:** 2026-04-06  
**Effort:** M  
**Domain:** Engine, Config  
**Scope:** `packages/engine/src/`, `specs/config.md`, `specs/associations.md`, `playground/src/scenarios/`  
**Depends on:** none — engine-only change; `Association.predicate` type is unchanged  
**See also:** `PLAN_CHANNEL_CANONICAL_SCHEMA.md` — declares canonical predicate names on the channel; the `target` values in `associations` mapping entries should be declared there  

---

## § 1 Problem Statement

The engine's `_remapAssociations()` translates an association's `targetId` (source local ID →
target local ID via the identity map) and `targetEntity` (source entity name → target entity
name via channel membership), but passes `predicate` through unchanged.

In the playground's `associations-demo` scenario:

| System | Entity      | Predicate used |
|--------|-------------|---------------|
| CRM    | contacts    | `companyId`   |
| ERP    | employees   | `orgId`       |
| HR     | people      | `orgRef`      |

When CRM propagates Alice's contact to ERP, the association arrives at ERP as:
```
{ predicate: "companyId", targetEntity: "accounts", targetId: "acc1" }
```
ERP expected `orgId`, not `companyId`. The connector stores (or injects) whichever predicate
it receives, so ERP ends up with `companyId` — a CRM-specific key that has no meaning inside
ERP.

On the next poll cycle, ERP sends back `predicate: "companyId"`. The engine compares it to
its stored sentinel (also `companyId`) → echo detection passes, no update is dispatched.
The data stabilises in the wrong shape: ERP now permanently holds `companyId` instead of
`orgId`.

### Why this wasn't caught before

- All current `engine.test.ts` tests use the mock-crm / mock-erp connector pair, where both
  systems happen to use the same predicate name (`companyId` in the test fixture).
- The playground fixture (`FIXED_SEED`) only recently began displaying association data in
  event log entries, making the mismatch visible.

---

## § 2 Design

### § 2.1 Where predicate renames belong

The three-section config separation (see `specs/config.md` — Design Rationale) assigns each
concern to a specific section:

- **Channels** (`mappings/channels.yaml`) — topology: which connectors sync together,
  identity fields, conflict strategy.
- **Field mappings** (`mappings/*.yaml`) — naming: how each connector's local field names
  map to canonical names.

Predicate mapping is a naming concern, not a topology concern. A predicate is a field key
in `data` — it is local to an individual connector, just like `firstname` or `orgId`. The
correct place to declare that CRM's `companyId` and ERP's `orgId` are the same thing is the
mapping entry for each connector, alongside `fields`. The channel definition stays clean.

### § 2.2 YAML syntax

An optional `associations` array is added to each mapping entry, using the same
`source`/`target` shape as `fields`:

```yaml
# mappings/contacts.yaml
- connector: crm
  channel: contacts
  entity: contacts
  fields:
    - source: firstname
      target: name
  associations:
    - source: companyId   # local predicate name as emitted by this connector
      target: companyRef  # canonical predicate (engine-internal; never written to any system)

- connector: erp
  channel: contacts
  entity: employees
  fields:
    - source: full_name
      target: name
  associations:
    - source: orgId
      target: companyRef  # same canonical as CRM's companyId

- connector: hr
  channel: contacts
  entity: people
  fields:
    - source: displayName
      target: name
  associations:
    - source: orgRef
      target: companyRef  # same canonical as above
```

If `associations` is absent on a mapping entry, **no associations are forwarded** from or
to that connector. This is strict by design: associations are named contracts between
systems, and a connector that has not declared its predicates cannot participate in
association sync. Omitting the array is a safe default — it prevents predicate names that
have no meaning on the receiving side from leaking across connectors.

Only predicates that appear in the `associations` array are forwarded. Unlisted predicates
from a connector with an `associations` array are silently dropped.

### § 2.3 Inbound filtering (read path)

When a source record is ingested, the engine filters incoming associations against the
declared `associations` array for that connector:

- If `associations` is absent → drop all associations (none forwarded).
- If `associations` is present → keep only entries whose `source` matches an incoming
  `assoc.predicate`; drop the rest.

The **shadow always stores the connector's own local predicate** — the canonical name is
never written to the database:
```
__assoc__ = '[{"predicate":"companyId","targetEntity":"companies","targetId":"co1"}]'  // CRM shadow
__assoc__ = '[{"predicate":"orgId","targetEntity":"accounts","targetId":"acc1"}]'      // ERP shadow
```

This means changing or adding a predicate mapping never invalidates existing shadows. No
migration is needed.

### § 2.4 Outbound translation (dispatch path)

In `_remapAssociations()`, after translating `targetId` and `targetEntity`, translate
`predicate` from the **source connector's local name** through the canonical to the
**target connector's local name**:

```
1. source local  →  canonical:  lookup source-connector mapping, find entry where source === assoc.predicate
2. canonical     →  target local: lookup target-connector mapping, find entry where target === canonical
```

If the source connector has no `associations` mapping → drop all associations (return `[]`).
If an incoming predicate has no entry in the source mapping → drop that predicate.
If the canonical has no matching entry in the target mapping → drop that predicate.

Result:
```
CRM write → ERP: { predicate: "orgId",  targetEntity: "accounts", targetId: "acc1" }
CRM write → HR:  { predicate: "orgRef", targetEntity: "orgs",     targetId: "org1" }
```

### § 2.5 Echo detection uses connector-local predicate

The sentinel stored in `__assoc__` uses the connector's own local predicate. Echo detection
compares the incoming sentinel (built from the source record's local predicates, after
inbound filtering) against the shadow sentinel (also local predicates for that connector).
The canonical name is never stored — it is purely a routing key used during outbound
translation.

### § 2.6 `RecordSyncResult` payload uses connector-local predicates

The four association payload fields (`sourceAssociations`, `sourceShadowAssociations`,
`beforeAssociations`, `afterAssociations`) carry the **connector-local** predicate when
returned to callers — not the canonical name:

- `sourceAssociations` — local (incoming record, before filtering)
- `sourceShadowAssociations` — local (read directly from shadow sentinel)
- `beforeAssociations` / `afterAssociations` — local (shadows store local predicates)

No translation is needed to produce these payloads; the shadow already holds the right
form. The playground event log shows `orgId → accounts/acc1` for an ERP-targeted event
naturally, without any reverse-translation step.

---

## § 3 Config Schema Changes

### § 3.1 Zod schema additions

In `packages/engine/src/config/schema.ts`, the mapping entry schema gains a new optional
array — no changes to the channel schema:

```typescript
export const AssocPredicateMappingSchema = z.object({
  source: z.string(),   // connector-local predicate
  target: z.string(),   // canonical predicate
});

export const MappingEntrySchema = z.object({
  connector:    z.string(),
  channel:      z.string(),
  entity:       z.string(),
  fields:       z.array(FieldMappingSchema).optional(),
  associations: z.array(AssocPredicateMappingSchema).optional(),  // NEW
});
```

`ChannelSchema` is unchanged.

### § 3.2 Loader type additions

In `packages/engine/src/config/loader.ts`:

```typescript
export interface AssocPredicateMapping {
  source: string;   // connector-local predicate
  target: string;   // canonical predicate
}

export interface MappingEntry {
  // existing fields unchanged
  connector:    string;
  channel:      string;
  entity:       string;
  fields?:      FieldMapping[];
  associations?: AssocPredicateMapping[];   // NEW
}
```

`ChannelConfig` is unchanged.

### § 3.3 Engine lookup at load time

At config load time (same pass that builds field-mapping lookup tables), build two lookup
tables per (connectorId, channelId):

```
inboundPredicateMap:  Map<connectorId+channelId, Map<localPredicate, canonicalPredicate>>
outboundPredicateMap: Map<connectorId+channelId, Map<canonicalPredicate, localPredicate>>
```

Both are derived from the same `associations` arrays — the outbound table is the inverse.
Duplicate entries (same `source` in two entries for the same connector×channel) are a
validation error at load time.

### § 3.4 Playground `ScenarioDefinition`

The playground uses `MappingEntry[]` for its in-memory mappings (same type from
`@opensync/engine`). The `associations-demo` scenario gains `associations` entries in its
mapping array. No changes to `ChannelConfig` or `ScenarioDefinition.channels`.

---

## § 4 Shadow Sentinel Migration

No migration is required. Shadows always store connector-local predicates — both before
and after this change. Adding or renaming a predicate mapping changes only the config;
existing shadows remain valid. On the first ingest after adding an `associations` mapping,
previously-forwarded-but-now-filtered predicates will disappear from new dispatches, but
no re-dispatch of the source record occurs unless the record itself changed.

---

## § 5 Engine Helpers

Add two private helpers to keep `_remapAssociations` readable:

- `_filterInboundAssociations(associations, connectorId, channelId)` — applies the
  `associations` allowlist for the source connector; returns `[]` if no mapping declared.
- `_translatePredicate(predicate, fromConnectorId, toConnectorId, channelId)` — resolves
  local → canonical via source mapping, then canonical → local via target mapping; returns
  `null` if either step has no entry (caller drops the predicate).

---

## § 6 Spec Changes Planned

| Spec file | Section(s) to add or modify |
|-----------|---------------------------|
| `specs/associations.md` | § 7.2 — update step 4 to include predicate filtering and translation; add § 7.5 describing the predicate mapping via canonical name in field mappings, and the local-predicate-in-shadow invariant |
| `specs/config.md` | `mappings/*.yaml — Field Mappings` § Associations — replace "no declaration needed" with description of optional `associations` array; add YAML example |

No new spec files needed. `ChannelConfig` is unchanged so `specs/config.md` — Channel Definitions requires no update.

---

## § 7 Implementation Steps

1. Add `AssocPredicateMappingSchema` and extend `MappingEntrySchema` in `schema.ts`
2. Add `AssocPredicateMapping` and extend `MappingEntry` in `loader.ts`
3. Build `predicateMap` at config load time: `Map<connectorId+channelId, Map<localPredicate, canonicalPredicate>>`
   and its inverse `predicateMapOut`
4. Add `_filterInboundAssociations()` and `_translatePredicate()` private helpers in `engine.ts`
5. Inbound: apply `_filterInboundAssociations` in `_processRecords` before building assocSentinel;
   shadow stores filtered local predicates unchanged
6. Outbound: in `_remapAssociations`, after `targetId`/`targetEntity` remap, apply
   `_translatePredicate`; drop predicates with no mapping; drop entire association list if
   source connector has no `associations` declaration
7. `RecordSyncResult` association payloads already use local predicates (shadow is local) — no change needed
8. Update `associations-demo.ts` scenario with `associations` entries in its mapping array
9. Update `specs/associations.md` and `specs/config.md`
10. Add T45: regression test — CRM contact with `companyId` is written to ERP with `orgId` predicate;
    a connector with no `associations` mapping receives no associations

---

## § 8 Out of Scope

- Many-to-one predicate mapping (two local predicates to one canonical) — treat as a follow-up
- Cross-channel predicate references — out of scope, see `PLAN_NON_LOCAL_ASSOCIATIONS.md`
