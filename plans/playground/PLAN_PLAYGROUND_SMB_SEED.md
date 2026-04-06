# Plan: Playground SMB Seed Expansion

**Status:** backlog  
**Date:** 2026-04-06  
**Effort:** S  
**Domain:** Playground  
**Scope:** `playground/src/lib/systems.ts`, `playground/src/scenarios/`, `specs/playground.md`  
**Spec:** `specs/playground.md §3.2`  
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

1. Add richer field vocabularies to all existing entities so that at least one field per
   system is deliberately *not* included in any channel mapping.
2. Add a fourth system — `webshop` (ecommerce) — with its own entity vocabulary.
3. Add three new entity types across erp and webshop: products, orders, and order lines.
4. Register a new `smb-demo` scenario that maps all six canonical concepts (companies,
   contacts, products, orders, order-lines, and optionally employees) across the four systems,
   with explicit unmapped fields visible in the seed cards.
5. Keep all existing scenarios (`associations-demo`, `minimal`) unchanged.

---

## § 3 Proposed Changes

### § 3.1 Expanded seed — `playground/src/lib/systems.ts`

Add fields and entities as described in § 4 below.  Add `webshop` to `FIXED_SYSTEMS`.

### § 3.2 New scenario — `playground/src/scenarios/smb-demo.ts`

A new scenario that covers the full SMB topology:

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

### § 3.3 Scenario registry update — `playground/src/scenarios/index.ts`

Register `smb-demo` and make it the new `defaultScenarioKey`, or decide to keep
`associations-demo` as default.  Decision: make `smb-demo` the default because it is the
more complete and realistic starting point; rename the current default comment in the file.

### § 3.4 Spec update — `specs/playground.md`

Update §3.2 (Default seed) to document the four-system seed, the six canonical entity
concepts, and the principle that unmapped fields remain in the source connector and are
not propagated.

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

## § 5 Scenario Mapping Detail — `smb-demo`

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

1. **Expand `FIXED_SEED`** in `playground/src/lib/systems.ts`:
   - Add extra fields to all existing records as per § 4.
   - Add the `webshop` system with `products`, `purchases`, `lineItems`.
   - Add `items`, `orders`, `orderLines` to `erp`.
   - Extend `FIXED_SYSTEMS` tuple to include `"webshop"`.

2. **Create `playground/src/scenarios/smb-demo.ts`** with channel definitions from § 5.
   No UI code changes are needed — the existing cluster view, card renderer, and unmapped-tab
   mechanism already handle the new entities.

3. **Register the scenario in `playground/src/scenarios/index.ts`**:
   - Add `import smb from "./smb-demo.js"`.
   - Add `"smb-demo": smb` to the `scenarios` map.
   - Change `defaultScenarioKey` to `"smb-demo"`.

4. **Update `specs/playground.md §3.2`** to describe the four-system seed and add a note that
   seed records may contain fields absent from any channel mapping, and that such fields are
   visible in source cards but not propagated.

5. **Run** `bun run tsc --noEmit` and `bun test` to confirm no regressions.

---

## § 7 Spec Changes Planned

| File | Section | Change |
|------|---------|--------|
| `specs/playground.md` | §3.2 Default seed | Extend to describe four-system seed (crm/erp/hr/webshop), six entity concepts, and the unmapped-field behaviour |

No other spec changes are required.  Engine behaviour, connector SDK, and all other specs are
unchanged — this plan only adds playground seed data and a scenario.
