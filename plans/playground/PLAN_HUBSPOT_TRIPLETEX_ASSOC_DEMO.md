# PLAN: Association Cardinality Mismatch Demo

**Status:** complete  
**Date:** 2026-04-08  
**Effort:** S  
**Domain:** playground, connectors/hubspot, connectors/tripletex  
**Scope:** New playground scenario demonstrating predicate-as-type association routing; add company associations to HubSpot contact entity; add Tripletex contact entity with orgId association  
**Spec:** specs/associations.md, specs/connector-sdk.md  
**Depends on:** none  

---

## § 1 Problem Statement

Two real systems model the same conceptual relationship with different shapes:

- **CRM-style systems** (e.g. HubSpot): contact↔company is many-to-many with typed edges.
  Each edge type is a distinct, named relationship — a contact can be `primaryCompanyId`
  to one company and `secondaryCompanyId` to another.
- **ERP-style systems** (e.g. Tripletex): contact has a single company FK (`orgId`).
  There is one employer; there is no secondary relationship concept.

The question is: how does the engine route the right subset of CRM associations to ERP
without any new engine logic?

---

## § 2 Key Insight: Predicate as Type

The association type is encoded in the **predicate name**, not in a metadata field. A
CRM connector that has distinct predicates for each relationship type (`primaryCompanyId`,
`secondaryCompanyId`) already expresses everything the engine needs to route correctly.

The existing `assocMappings` routing then handles the rest:

- CRM maps `primaryCompanyId` → canonical `primaryCompanyRef`
- CRM maps `secondaryCompanyId` → canonical `secondaryCompanyRef`
- ERP maps `orgId` → canonical `primaryCompanyRef`
- ERP declares no mapping for `secondaryCompanyRef` → those edges are **silently dropped**
  by existing engine behaviour

No engine changes are required. The selectivity falls out of the whitelist semantics that
`assocMappings` already implements: only declared predicates are forwarded.

---

## § 3 Scenario Design (playground-only, no new connectors)

The demo uses the existing `crm` and `erp` in-memory connectors from `lib/systems.ts`.

### § 3.1 Seed changes

Replace the single `companyId` association on CRM contacts with distinct-predicate entries.
Alice gets both a primary and a secondary company link; Bob and Carol each get one primary.

```typescript
// crm.contacts — replace current associations
{
  id: "c1",
  data: { name: "Alice Liddell", email: "alice@example.com" },
  associations: [
    { predicate: "primaryCompanyId",   targetEntity: "companies", targetId: "co1" },
    { predicate: "secondaryCompanyId", targetEntity: "companies", targetId: "co2" },
  ],
},
{
  id: "c2",
  data: { name: "Bob Martin", email: "bob@example.com" },
  associations: [
    { predicate: "primaryCompanyId", targetEntity: "companies", targetId: "co2" },
  ],
},
{
  id: "c3",
  data: { name: "Carol White", email: "carol@example.com" },
  associations: [
    { predicate: "primaryCompanyId", targetEntity: "companies", targetId: "co3" },
  ],
},
```

The `companies` seed and the entire ERP seed (`accounts`, `employees`) are unchanged.
ERP employees already carry a single `orgId` association.

### § 3.2 New scenario file: `assoc-cardinality.ts`

`playground/src/scenarios/assoc-cardinality.ts`:

```typescript
const scenario: ScenarioDefinition = {
  label: "assoc-cardinality (crm many-to-many ↔ erp single FK)",
  channels: [
    {
      id: "companies",
      identityFields: ["domain"],
      members: [
        {
          connectorId: "crm",
          entity: "companies",
          inbound:  [{ source: "name", target: "name" }, { source: "domain", target: "domain" }],
          outbound: [{ source: "name", target: "name" }, { source: "domain", target: "domain" }],
        },
        {
          connectorId: "erp",
          entity: "accounts",
          inbound:  [{ source: "accountName", target: "name" }, { source: "website", target: "domain" }],
          outbound: [{ source: "accountName", target: "name" }, { source: "website", target: "domain" }],
        },
      ],
    },
    {
      id: "contacts",
      identityFields: ["email"],
      members: [
        {
          connectorId: "crm",
          entity: "contacts",
          inbound:  [{ source: "name", target: "name" }, { source: "email", target: "email" }],
          outbound: [{ source: "name", target: "name" }, { source: "email", target: "email" }],
          assocMappings: [
            { source: "primaryCompanyId",   target: "primaryCompanyRef"   },
            { source: "secondaryCompanyId", target: "secondaryCompanyRef" },
          ],
        },
        {
          connectorId: "erp",
          entity: "employees",
          inbound:  [{ source: "fullName", target: "name" }, { source: "email", target: "email" }],
          outbound: [{ source: "fullName", target: "name" }, { source: "email", target: "email" }],
          assocMappings: [
            // ERP only knows about one company FK; secondaryCompanyRef has no mapping here
            // so those edges are dropped automatically — no engine config needed.
            { source: "orgId", target: "primaryCompanyRef" },
          ],
        },
      ],
    },
  ],
  conflict: { strategy: "lww" },
};
```

### § 3.3 Expected demo walkthrough

1. Boot the channel. CRM: Alice has two company links via distinct predicates
   (`primaryCompanyId` → Acme, `secondaryCompanyId` → Globex). ERP: Alice has one
   (`orgId` → Acme).
2. Engine ingests CRM contacts. `primaryCompanyId` routes to canonical `primaryCompanyRef`;
   `secondaryCompanyId` routes to canonical `secondaryCompanyRef`.
3. Engine dispatches to ERP. ERP's `assocMappings` maps `primaryCompanyRef` → `orgId`.
   `secondaryCompanyRef` has no ERP mapping → dropped. ERP receives exactly one association:
   `{ orgId → Acme }`. No over-delivery, no engine logic.
4. Engine dispatches to CRM. CRM has mappings for both canonical keys; ERP's single
   `orgId` edge (read back as `primaryCompanyRef`) is written as `primaryCompanyId`.
   The `secondaryCompanyId` edge is untouched — it came from CRM originally and is not
   affected by the round-trip.
5. Edit Alice in CRM: change `primaryCompanyId` to Initech (co3). On next sync, ERP's
   `orgId` updates to Initech. The `secondaryCompanyId` → Globex link is unchanged in CRM
   and never propagates to ERP.

---

## § 4 Connector Implementations

Both connector changes follow from the plan above: the playground scenario is a
simplified in-memory version of the same predicate-as-type pattern that the real
connectors now implement.

### § 4.1 HubSpot — contact company associations

**Read side**: After reading a page of contacts via the existing batch CRM API, the
connector calls the v4 Associations batch-read endpoint
(`POST /crm/associations/2026-03/contacts/companies/batch/read`) for all contact IDs
in the page. Each edge's `associationTypes` array is mapped to distinct predicates:

| HubSpot typeId | predicate |
|---|---|
| `1` | `primaryCompanyId` |
| `279` | `companyId` (unlabeled default) |

Unknown typeIds are silently skipped. A single edge can carry multiple typeIds
simultaneously (e.g. both `1` and `279`), producing one `Association` entry per
known typeId.

**Write side**: On `insert` and `update`, after writing contact properties, any
`record.associations` entries with recognised predicates are forwarded to
`POST /crm/associations/2026-03/contacts/companies/batch/create`. Entries with
unrecognised predicates are silently ignored.

Positional correlation between batch inputs and results is used for the insert
case (same order as inputs, as required by the connector SDK spec §4).

### § 4.2 Tripletex — new contact entity

Tripletex's `/contact` resource represents people linked to customer accounts. A
new `contact` entity is added alongside the existing `customer` and `invoice`
entities.

**Read side**: Each contact record carries a `customer` embedded object
(`{ id: N, url: "..." }`). The connector extracts this as an association:
`{ predicate: "orgId", targetEntity: "customer", targetId: "N" }`. The full
`customer` object remains in `data` as-is (raw pipe — no data transformation).

**Write side**: `record.associations` is inspected for an entry with
`predicate === "orgId"`. If found, `{ customer: { id: N } }` is injected into
the POST/PUT body alongside the other data fields, reconstructing the FK the
Tripletex API expects.

Webhook subscription for `contact.*` events is registered on `onEnable`
and deregistered on `onDisable`, following the pattern of the existing
`customer` entity.

---

## § 5 Implementation Order

| # | Chunk | Effort | What it delivers |
|---|-------|--------|-----------------|
| 1 | Extend CRM seed with distinct-predicate associations (§ 3.1) | XS | Seed reflects real multi-predicate shape |
| 2 | New scenario `assoc-cardinality.ts` + register in index (§ 3.2) | XS | Runnable demo in the playground |
| 3 | HubSpot: association read + write on contact entity (§ 4.1) | S | Real HubSpot contacts carry typed company edges |
| 4 | Tripletex: new contact entity with orgId association (§ 4.2) | S | Real Tripletex contacts carry employer edge |

Chunks 1–2 are playground-only and can land independently. Chunks 3–4 touch real
connectors and should each be type-checked and tested.

---

## § 6 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/associations.md` | § 7 (extend) | Add a note that the recommended pattern for typed associations is distinct predicates per type (predicate-as-type), not a shared predicate with `metadata.type`. Document that unlisted target predicates are silently dropped, making `assocMappings` a whitelist on both directions. |
| `specs/connector-sdk.md` | Write Records section (extend) | Add guidance that connectors receiving `InsertRecord.associations` / `UpdateRecord.associations` are responsible for translating them into whatever API primitives the target system uses (separate endpoints, embedded FK fields, etc.), and that predicates unknown to the connector should be silently skipped. |

No production connector code for §§ 4.1–4.2 may be written before the spec
sections above are drafted.
