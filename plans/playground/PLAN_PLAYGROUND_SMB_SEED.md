# Plan: Playground SMB Seed Expansion

**Status:** backlog  
**Date:** 2026-04-06  
**Effort:** M  
**Domain:** Playground  
**Scope:** `playground/src/lib/`, `playground/src/scenarios/`, `playground/src/main.ts`, `specs/playground.md`  
**Spec:** `specs/playground.md §3`  
**Depends on:** none  

---

## § 1 Problem Statement

The current playground seed (`lib/systems.ts`) uses three systems (crm / erp / hr) with two
entities each and only two or three fields per entity.  Every field in every entity is
explicitly mapped — there are no unmapped fields in the seed.  This means the playground
cannot yet illustrate one of the most common real-world observations: *connector data contains
more fields than the channel cares about, and those extra fields simply stay in the source
and are never propagated*.

In addition, the current entity set only covers companies and contacts.  A typical SMB
integration also involves products, orders, and order lines, but the playground provides no
seed data or scenario for those concepts, making it harder to demo or explain richer sync
topologies.

---

## § 2 Goals

1. Introduce a **two-level navigation model** for the playground:
   - **Level 1 — Scenario** (which domain and which systems): `smb`, `family`, `personal`.
   - **Level 2 — Mapping config** (how the channels are wired): `simple`, `advanced`, `tutorial`.
2. Add richer field vocabularies to all existing entities so that at least one field per
   system is deliberately *not* included in any channel mapping.
3. Add a fourth SMB system — `webshop` (ecommerce) — with its own entity vocabulary.
4. Add three new entity types across erp and webshop: products, orders, and order lines.
5. Define two additional Level-1 scenario seeds: `family` (home + school) and `personal`
   (notes-app + tasks-app).
6. For each scenario, provide three named mapping configs — `simple`, `advanced`, `tutorial`.
7. Keep all existing scenarios (`associations-demo`, `minimal`) as legacy entries; wrap them
   in a compatibility shim so existing links continue to work.
8. Update the playground UI (`main.ts`) to show cascaded Scenario → Config dropdowns.

---

## § 3 Proposed Changes

### § 3.1 Type changes — `playground/src/scenarios/types.ts`

Replace the single `ScenarioDefinition` interface with two layered types (see § 8.2).
Export a backwards-compatible alias `type ScenarioDefinition = MappingConfig` during migration.

### § 3.2 Per-scenario seed files

Move seed data out of `lib/systems.ts` into per-scenario modules:

```
playground/src/scenarios/
  smb/
    seed.ts          — crm, erp, hr, webshop records (§ 4)
    simple.ts        — companies + contacts, direct 1:1 renames
    advanced.ts      — six channels with unmapped fields (current smb-demo plan)
    tutorial.ts      — companies channel only, annotated
  family/
    seed.ts          — home, school records (§ 9.1)
    simple.ts        — contacts + events channels
    advanced.ts      — contacts + events + tasks
    tutorial.ts      — contacts channel only, annotated
  personal/
    seed.ts          — notes-app, tasks-app records (§ 9.2)
    simple.ts        — tasks channel only
    advanced.ts      — tasks + notes + projects
    tutorial.ts      — tasks channel only, annotated
```

The `FIXED_SEED` constant in `lib/systems.ts` is replaced by per-scenario `seed.ts` modules.
`lib/systems.ts` itself is kept for any shared type helpers but no longer owns the seed data.

### § 3.3 New mapping configs — `smb/advanced.ts`

The `advanced` config is the full SMB topology from the original plan.  Its channel table:

| Channel | Canonical fields | Members |
|---------|-----------------|---------|
| `companies` | `name`, `domain`, `phone`, `industry` | crm.companies, erp.accounts, hr.orgs |
| `contacts` | `name`, `email`, `phone`, `jobTitle` | crm.contacts, erp.employees, hr.people |
| `products` | `sku`, `name`, `price` | erp.items, webshop.products |
| `orders` | `ref`, `companyDomain`, `total`, `status`, `date` | erp.orders, webshop.purchases |
| `orderLines` | `orderId`, `productSku`, `qty`, `unitPrice` | erp.orderLines, webshop.lineItems |

Fields that exist in the seed but are **not** included in any channel mapping (intentionally
unmapped, to demonstrate the concept):

| System | Entity | Unmapped field | Rationale |
|--------|--------|---------------|-----------|
| crm | companies | `tier` | CRM-internal account tier (Gold/Silver/Bronze) |
| erp | accounts | `segment` | ERP-internal market segment |
| hr | orgs | `region` | HR-internal region code |
| webshop | products | `weight` | Shipping weight — irrelevant outside webshop |
| webshop | purchases | `couponCode` | Promotion code — webshop-only concept |
| crm | contacts | `leadScore` | CRM lead scoring — not shared externally |

The scenario's channel mappings will omit these fields entirely.  Because the playground
record cards show all `record.data` fields (§5.1 of the spec), the unmapped fields will be
visible on the source cards but will be absent from the synced copies in other systems,
making the exclusion tangible.

### § 3.4 Scenario registry — `playground/src/scenarios/index.ts`

Export a `scenarioGroups` map (type `Record<string, ScenarioGroup>`) that ships `smb`,
`family`, and `personal`.  Wrap legacy `associations-demo` and `minimal` in a thin
compatibility shim that presents each as a `ScenarioGroup` with a single `default` config.
Default group: `smb`, default config: `simple`.

### § 3.5 UI changes — `playground/src/main.ts`

Replace the single scenario `<select>` with two cascaded dropdowns:

1. **Scenario** — lists `scenarioGroups` keys with their `label`.
2. **Config** — re-populated when Scenario changes; lists the selected group's `configs` keys.

URL hash encodes both as `#<group>/<config>` (e.g. `#smb/advanced`).  Legacy hashes
(`#associations-demo`) are rewritten to `#associations-demo/default` on load.

### § 3.6 Spec update — `specs/playground.md`

Rewrite §3 to document the two-level architecture, the three scenario seeds, the three
config tiers, and the unmapped-field principle.

---

## § 4 Seed Design

### § 4.1 CRM (`crm`)

**`companies`** — adds `phone`, `industry`, `tier` (unmapped)

| id | name | domain | phone | industry | tier |
|----|------|--------|-------|----------|------|
| co1 | Acme Corp | acme.com | +1-555-0100 | Manufacturing | gold |
| co2 | Globex Inc | globex.com | +1-555-0200 | Technology | silver |
| co3 | Initech | initech.com | +1-555-0300 | Finance | bronze |

**`contacts`** — adds `phone`, `jobTitle`, `leadScore` (unmapped)

| id | name | email | phone | jobTitle | leadScore |
|----|------|-------|-------|----------|-----------|
| c1 | Alice Liddell | alice@example.com | +1-555-1001 | VP Engineering | 92 |
| c2 | Bob Martin | bob@example.com | +1-555-1002 | CFO | 65 |
| c3 | Carol White | carol@example.com | +1-555-1003 | CTO | 78 |

### § 4.2 ERP (`erp`)

**`accounts`** — adds `phone`, `segment` (unmapped)

| id | accountName | website | phone | segment |
|----|-------------|---------|-------|---------|
| acc1 | Acme Corp | acme.com | +1-555-0100 | enterprise |
| acc2 | Globex Inc | globex.com | +1-555-0200 | mid-market |

**`employees`** — adds `phone`, `title`

| id | fullName | email | phone | title |
|----|----------|-------|-------|-------|
| e1 | Alice Liddell | alice@example.com | +1-555-1001 | VP Engineering |
| e2 | Bob Martin | bob@example.com | +1-555-1002 | CFO |

**`items`** (new) — maps to the `products` channel

| id | sku | itemName | price | stock (unmapped) |
|----|-----|----------|-------|--------|
| item1 | SKU-001 | Widget A | 29.99 | 120 |
| item2 | SKU-002 | Widget B | 49.99 | 45 |

Stock is an ERP inventory count — not shared externally.

**`orders`** (new) — maps to the `orders` channel; associated to account

| id | orderRef | accountId (assoc) | total | status | date |
|----|----------|----------|-------|--------|------|
| ord1 | ORD-1001 | acc1 | 299.90 | shipped | 2026-03-15 |
| ord2 | ORD-1002 | acc2 | 149.95 | pending | 2026-04-01 |

`accountId` is an association to `erp.accounts`, not a canonical field.  The canonical
`companyDomain` field is derived from the account's `website` field via field mapping.

**`orderLines`** (new) — maps to the `orderLines` channel; associated to order + item

| id | orderId (assoc) | itemSku | qty | unitPrice |
|----|---------|---------|-----|-----------|
| ol1 | ord1 | SKU-001 | 5 | 29.99 |
| ol2 | ord1 | SKU-002 | 2 | 49.99 |
| ol3 | ord2 | SKU-001 | 3 | 29.99 |

### § 4.3 HR (`hr`)

**`orgs`** — adds `region` (unmapped)

| id | orgName | site | region |
|----|---------|------|--------|
| org1 | Globex Inc | globex.com | EMEA |
| org2 | Initech | initech.com | APAC |

**`people`** — adds `phone`, `role`

| id | displayName | email | phone | role |
|----|-------------|-------|-------|------|
| p1 | Bob Martin | bob@example.com | +1-555-1002 | CFO |
| p2 | Carol White | carol@example.com | +1-555-1003 | CTO |

### § 4.4 Webshop (`webshop`) — new system

**`products`** (new) — maps to the `products` channel; `weight` unmapped

| id | productSku | title | retailPrice | weight |
|----|------------|-------|-------------|--------|
| sp1 | SKU-001 | Widget A | 29.99 | 0.3 kg |
| sp2 | SKU-002 | Widget B | 49.99 | 0.8 kg |

**`purchases`** (new) — maps to the `orders` channel; `couponCode` unmapped

| id | purchaseRef | accountDomain | amount | state | createdAt | couponCode |
|----|-------------|---------------|--------|-------|-----------|------------|
| pu1 | ORD-1001 | acme.com | 299.90 | shipped | 2026-03-15 | — |
| pu2 | ORD-1002 | globex.com | 149.95 | pending | 2026-04-01 | SAVE10 |

`purchaseRef` is the identity field for the `orders` channel (same value as `orderRef`).  
`accountDomain` maps to canonical `companyDomain`.  
`state` maps to canonical `status`.  
`amount` maps to canonical `total`.

**`lineItems`** (new) — maps to the `orderLines` channel

| id | purchaseId (assoc) | productSku | quantity | linePrice |
|----|---------|------------|----------|-----------|
| li1 | pu1 | SKU-001 | 5 | 29.99 |
| li2 | pu1 | SKU-002 | 2 | 49.99 |
| li3 | pu2 | SKU-001 | 3 | 29.99 |

`purchaseId` is an association to `webshop.purchases`.  
`productSku`, `quantity`, and `linePrice` map to canonical `productSku`, `qty`, `unitPrice`.

---

## § 5 SMB Mapping Detail — `smb / advanced`

### § 5.1 `companies` channel

Identity: `domain`

| System | Entity | Field mapping (source → canonical) |
|--------|--------|-------------------------------------|
| crm | companies | name→name, domain→domain, phone→phone, industry→industry — `tier` **not mapped** |
| erp | accounts | accountName→name, website→domain, phone→phone — `segment` **not mapped** |
| hr | orgs | orgName→name, site→domain — `phone` and `region` **not mapped** |

### § 5.2 `contacts` channel

Identity: `email`

| System | Entity | Field mapping (source → canonical) |
|--------|--------|-------------------------------------|
| crm | contacts | name→name, email→email, phone→phone, jobTitle→jobTitle — `leadScore` **not mapped** |
| erp | employees | fullName→name, email→email, phone→phone, title→jobTitle |
| hr | people | displayName→name, email→email, phone→phone, role→jobTitle |

### § 5.3 `products` channel

Identity: `sku`

| System | Entity | Field mapping (source → canonical) |
|--------|--------|-------------------------------------|
| erp | items | sku→sku, itemName→name, price→price — `stock` **not mapped** |
| webshop | products | productSku→sku, title→name, retailPrice→price — `weight` **not mapped** |

### § 5.4 `orders` channel

Identity: `ref`

| System | Entity | Field mapping (source → canonical) |
|--------|--------|-------------------------------------|
| erp | orders | orderRef→ref, website(via account)→companyDomain, total→total, status→status, date→date |
| webshop | purchases | purchaseRef→ref, accountDomain→companyDomain, amount→total, state→status, createdAt→date — `couponCode` **not mapped** |

Note: the `orders` identity field is the order reference string (`ref`).  The ERP and webshop
records use the same `orderRef`/`purchaseRef` value so they resolve to the same identity.

### § 5.5 `orderLines` channel

Identity: composite — `orderId` + `productSku` (or a stable `lineId` if available).  
For simplicity in the playground, use `{ orderId, productSku }` as joint identity fields.

| System | Entity | Field mapping (source → canonical) |
|--------|--------|-------------------------------------|
| erp | orderLines | orderId→orderId, itemSku→productSku, qty→qty, unitPrice→unitPrice |
| webshop | lineItems | purchaseId→orderId, productSku→productSku, quantity→qty, linePrice→unitPrice |

---

## § 6 Implementation Steps

1. **Update `playground/src/scenarios/types.ts`** — introduce `MappingConfig` and
   `ScenarioGroup` (§ 8.2); export `type ScenarioDefinition = MappingConfig` compat alias.

2. **Create `playground/src/scenarios/smb/seed.ts`** — SMB seed from § 4
   (crm, erp, hr, webshop records).  Remove these records from `lib/systems.ts`.

3. **Create `playground/src/scenarios/smb/simple.ts`** — two channels: `companies`
   (name/domain/phone) and `contacts` (name/email/phone/jobTitle); no unmapped fields;
   direct 1:1 renames only.

4. **Create `playground/src/scenarios/smb/advanced.ts`** — full six channels from § 5;
   all unmapped fields present in seed.

5. **Create `playground/src/scenarios/smb/tutorial.ts`** — `companies` channel only;
   each member annotated with a `description` string explaining identity and mapping choices.

6. **Create `playground/src/scenarios/family/seed.ts`** and
   `playground/src/scenarios/family/{simple,advanced,tutorial}.ts` per § 9.1.

7. **Create `playground/src/scenarios/personal/seed.ts`** and
   `playground/src/scenarios/personal/{simple,advanced,tutorial}.ts` per § 9.2.

8. **Update `playground/src/scenarios/index.ts`** — export `scenarioGroups: Record<string,
   ScenarioGroup>`; wrap legacy `associations-demo` and `minimal` in a compatibility shim
   that exposes them as single-config groups (key `"default"`).

9. **Update `playground/src/main.ts`** — replace single scenario `<select>` with two
   cascaded dropdowns; implement URL hash routing as `#<group>/<config>`; rewrite bare
   legacy hashes to `#<key>/default` on load.

10. **Update `playground/src/engine-lifecycle.ts`** — accept `MappingConfig` instead of
    `ScenarioDefinition` (structurally identical; the type alias makes this a no-op).

11. **Update `specs/playground.md §3`** per § 7 below.

12. **Run** `bun run tsc --noEmit` and `bun test`; confirm no regressions.

---

## § 7 Spec Changes Planned

| File | Section | Change |
|------|---------|--------|
| `specs/playground.md` | §3 (rewrite) | Document two-level architecture: `ScenarioGroup` (Level 1) and `MappingConfig` (Level 2) |
| `specs/playground.md` | §3.1 Scenario groups | Three named groups (`smb`, `family`, `personal`) and the legacy compat shim |
| `specs/playground.md` | §3.2 Mapping config tiers | `simple`, `advanced`, `tutorial` — philosophy and target audience for each |
| `specs/playground.md` | §3.3 Default seed — SMB | Four-system seed (crm/erp/hr/webshop) and six canonical entity concepts |
| `specs/playground.md` | §3.4 Default seed — Family | Home + school scenario seed |
| `specs/playground.md` | §3.5 Default seed — Personal | Notes-app + tasks-app scenario seed |
| `specs/playground.md` | §3.6 Unmapped fields | Principle: seed records may contain fields absent from any mapping; such fields are visible in source cards but not propagated |

Engine behaviour, connector SDK, and all other specs are unchanged.

---

## § 8 Two-Level Architecture

### § 8.1 Motivation

The current architecture conflates two independent dimensions into a single flat
`ScenarioDefinition`:

- **What world we are in** — which systems exist, what entities they have, what records are
  loaded. This is the *scenario seed* (Level 1).
- **How the sync is configured** — which channels exist, what field mappings apply, what
  identity fields are used. This is the *mapping config* (Level 2).

Separating them allows a user who is learning about field mapping to switch config complexity
without losing the familiar set of systems — and allows the playground to grow new scenario
domains (family, personal) without multiplying redundant seed definitions.

### § 8.2 Type definitions

```ts
/** Level 2: a named channel-mapping configuration for a given scenario. */
export interface MappingConfig {
  /** Display label shown in the Config dropdown. */
  label: string;
  /** Optional tooltip / sidebar description explaining the config's intent. */
  description?: string;
  channels: ChannelConfig[];
  conflict: ConflictConfig;
}

/** Level 1: a scenario group — its own seed plus one or more mapping configs. */
export interface ScenarioGroup {
  /** Display label shown in the Scenario dropdown. */
  label: string;
  description?: string;
  /** Per-system seed records. */
  seed: SeedData;
  configs: Record<string, MappingConfig>;
  defaultConfigKey: string;
}

/** Compat alias so existing imports of ScenarioDefinition keep working. */
export type ScenarioDefinition = MappingConfig;
```

`SeedData` mirrors the shape of the current `FIXED_SEED` constant:

```ts
// system → entity → record-id → field-bag
export type SeedData = Record<string, Record<string, Record<string, FieldData>>>;
```

### § 8.3 Registry shape

```ts
export const scenarioGroups: Record<string, ScenarioGroup> = {
  smb:      smbScenario,
  family:   familyScenario,
  personal: personalScenario,
  // Legacy entries wrapped in a single-config shim:
  "associations-demo": wrapLegacy(associationsDemo),
  "minimal":           wrapLegacy(minimal),
};

export const defaultGroupKey  = "smb";
// (each ScenarioGroup carries its own defaultConfigKey)
```

### § 8.4 URL hash routing

| URL fragment | Resolves to |
|---|---|
| `#smb/advanced` | SMB scenario, advanced config |
| `#family/tutorial` | Family scenario, tutorial config |
| `#associations-demo` | Legacy; rewritten to `#associations-demo/default` |
| *(empty)* | `#smb/simple` (defaults) |

---

## § 9 Additional Scenario Seeds

### § 9.1 Family (`family`)

The family scenario demonstrates syncing personal information shared across two *ecosystem*
connectors: a `home` app (contacts + events managed locally) and a `school` portal
(directory + calendar published by a school).

**Systems:** `home`, `school`

**`home.contacts`** — family address book

| id | name | email | phone | birthday | notes (unmapped) |
|----|------|-------|-------|----------|------------------|
| hc1 | Alice Parent | alice@family.example | +1-555-2001 | 1980-04-12 | picks up kids |
| hc2 | Bob Parent | bob@family.example | +1-555-2002 | 1982-09-03 | vegetarian |
| hc3 | Teacher Smith | smith@school.example | +1-555-3001 | — | Room 12B |

`birthday` and `notes` are home-side private fields not mapped to any channel.

**`home.events`** — family calendar

| id | title | date | allDay | reminder (unmapped) |
|----|-------|------|--------|---------------------|
| ev1 | School play | 2026-05-10 | true | 2026-05-09T09:00 |
| ev2 | Parent-teacher meeting | 2026-05-14 | false | — |

**`school.directory`** — school's contact list

| id | displayName | email | contactPhone | role (unmapped) |
|----|-------------|-------|--------------|----------------|
| sd1 | Alice Parent | alice@family.example | +1-555-2001 | Volunteer |
| sd2 | Teacher Smith | smith@school.example | +1-555-3001 | Teacher |

**`school.calendar`** — school events

| id | eventName | eventDate | isPublic (unmapped) |
|----|-----------|-----------|---------------------|
| sc1 | School play | 2026-05-10 | true |
| sc2 | Sports day | 2026-05-21 | true |

Shared channels and config tiers:

| Config | Channels |
|--------|----------|
| `simple` | `contacts` (identity: `email`) + `events` (identity: `title`+`date`) |
| `advanced` | same, plus a `reminders` channel (home.events ↔ school.calendar, date-keyed) |
| `tutorial` | `contacts` channel only; annotated |

### § 9.2 Personal (`personal`)

The personal scenario demonstrates syncing data across two productivity apps a single
person uses: a `notes-app` and a `tasks-app`.  Because some entities exist in only one
system, this scenario also illustrates *single-member channels* — valid in OpenSync but
rarely shown in business demos.

**Systems:** `notes-app`, `tasks-app`

**`notes-app.notes`**

| id | title | tags | createdAt | body (unmapped) | updatedAt (unmapped) |
|----|-------|------|-----------|-----------------|----------------------|
| n1 | Buy groceries | ["shopping"] | 2026-04-01 | Milk, eggs, bread | 2026-04-05 |
| n2 | Project ideas | ["work"] | 2026-03-15 | …long text… | 2026-04-02 |

**`notes-app.reminders`** — note-attached due dates

| id | noteTitle (derived) | dueDate | done |
|----|---------------------|---------|------|
| r1 | Buy groceries | 2026-04-07 | false |

**`tasks-app.tasks`**

| id | title | dueDate | done | priority (unmapped) | listName (unmapped) |
|----|-------|---------|------|---------------------|---------------------|
| t1 | Buy groceries | 2026-04-07 | false | high | Personal |
| t2 | Prepare slides | 2026-04-10 | false | medium | Work |

**`tasks-app.projects`**

| id | name | color (unmapped) |
|----|------|------------------|
| pr1 | Personal | blue |
| pr2 | Work | red |

Shared channels and config tiers:

| Config | Channels |
|--------|----------|
| `simple` | `tasks` (identity: `title`) — notes-app.reminders + tasks-app.tasks |
| `advanced` | `tasks` + `notes` (notes-app.notes only, single-member) + `projects` (tasks-app.projects only, single-member) |
| `tutorial` | `tasks` channel only; annotated |

---

## § 10 Mapping Config Tiers

All three Level-1 scenarios ship the same three Level-2 config keys:

| Key | Philosophy | Target audience |
|-----|-----------|----------------|
| `simple` | Minimal channel set.  All mapped fields have obvious 1:1 renames.  No unmapped fields present in seed.  No composite or derived identity.  Engine converges in one pass. | First-time visitors; demo screencasts; documentation screenshots |
| `advanced` | Full channel set with unmapped fields in the seed, derived identity where applicable, and cross-channel associations.  Shows the full depth of the engine. | Developers evaluating OpenSync; integration engineers |
| `tutorial` | A single annotated channel.  Each mapping entry carries a `description` string explaining *why* the identity field was chosen and *why* each field rename was done.  Deliberately partial — shows that a sync config need not cover every field or every system at once. | Guided walkthroughs; embedded documentation; onboarding flows |
