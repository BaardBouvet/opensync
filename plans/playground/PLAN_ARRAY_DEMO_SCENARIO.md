# Plan: Array Expansion Playground Scenario

**Status:** draft  
**Date:** 2026-04-07  
**Effort:** S  
**Domain:** Playground  
**Scope:** `playground/src/lib/systems.ts`, `playground/src/engine-lifecycle.ts`, new scenario file, scenario index  
**Spec:** `specs/playground.md`, `specs/field-mapping.md §3.2`  
**Depends on:** PLAN_NESTED_ARRAY_PIPELINE.md (complete), PLAN_CROSS_CHANNEL_EXPANSION.md (complete), PLAN_ARRAY_COLLAPSE.md (required for bidirectional demo)  

---

## § 1 Problem

The array expansion feature (specs/field-mapping.md §3.2) has no playground entry point.
There is no scenario that shows the core contrast: one system stores orders with embedded line
arrays, the other stores orders and line items as separate flat collections.

---

## § 2 Scope

This plan is deliberately narrow — one new scenario, the minimum seed additions needed to
drive it, and one lifecycle fix.  It does **not** implement the full SMB plan
(PLAN_PLAYGROUND_SMB_SEED.md, which covers two-level navigation, family/personal seeds,
unmapped-field demos, scenario groups, etc.).  That plan stays in backlog unaffected.

---

## § 3 Spec Changes Planned

| File | Section | Change |
|------|---------|--------|
| `specs/playground.md` | New §N — Array-expansion channels | Document that channels containing a member with `arrayPath` skip the collect→discover→onboard lifecycle step; they are bootstrapped on the first regular poll. State that `FIXED_SYSTEMS` includes `webshop` but scenarios may leave it out of any channel when unused. |

No changes to `specs/field-mapping.md`, `specs/sync-engine.md`, SDK, or engine packages.

---

## § 4 Seed Additions

### § 4.1 ERP — new entities

The ERP seed in `lib/systems.ts` gains two entities.

**`orders`** — each order carries an embedded `lines` array.

| id | orderRef | total | status | date | lines |
|----|----------|-------|--------|------|-------|
| ord1 | ORD-1001 | 299.90 | shipped | 2026-03-15 | [{lineNo:"L01",sku:"SKU-001",qty:5,unitPrice:29.99}, {lineNo:"L02",sku:"SKU-002",qty:2,unitPrice:49.99}] |
| ord2 | ORD-1002 | 149.95 | pending | 2026-04-01 | [{lineNo:"L01",sku:"SKU-001",qty:3,unitPrice:29.99}] |

`lines` is a raw JSON array on the record — a connector field, not interpreted by the channel
mapping for the `orders` channel (it is excluded from that channel's `fields` list).

**`items`** — product catalogue (used by the `products` channel in a future scenario).

| id | sku | itemName | price |
|----|-----|----------|-------|
| item1 | SKU-001 | Widget A | 29.99 |
| item2 | SKU-002 | Widget B | 49.99 |

### § 4.2 Webshop — new system

Add `webshop` to `FIXED_SYSTEMS` and `FIXED_SEED`.

**`purchases`** — flat orders seeded to match ERP orders (same refs, different field names).

| id | purchaseRef | accountDomain | amount | state | couponCode |
|----|-------------|--------------|--------|-------|------------|
| pu1 | ORD-1001 | acme.com | 299.90 | shipped | null |
| pu2 | ORD-1002 | globex.com | 149.95 | pending | SAVE10 |

**`lineItems`** — flat line items seeded to match ERP embedded lines (same ref + lineNo, different field names).

| id | purchaseRef | lineNumber | sku | quantity | linePrice |
|----|------------|-----------|-----|---------|----------|
| li1 | ORD-1001 | L01 | SKU-001 | 5 | 29.99 |
| li2 | ORD-1001 | L02 | SKU-002 | 2 | 49.99 |
| li3 | ORD-1002 | L01 | SKU-001 | 3 | 29.99 |

Pre-seeding both sides is what makes the **bidirectional** demo compelling: changes on either
side propagate to the other.

**This requires PLAN_ARRAY_COLLAPSE.md to be implemented first.** Until then, the scenario
can be added in a forward-only form (empty webshop lineItems) as a placeholder.

---

## § 5 Scenario Design

**File:** `playground/src/scenarios/array-demo.ts`  
**Label:** `"array-demo (erp embedded lines → webshop flat lineItems)"`

### Channel 1: `orders`

Normal bidirectional sync — no array expansion.

| Member | Entity | Identity field | Key mappings |
|--------|--------|---------------|--------------|
| erp | orders | `ref` | orderRef→ref, total→total, status→status, date→date |
| webshop | purchases | `ref` | purchaseRef→ref, amount→total, state→status, createdAt→date |

The ERP `lines` field passes through the channel's shadow storage but is excluded from the
`fields` whitelist, so it is never dispatched to webshop.purchases.  (It lives on the ERP
order record and is picked up separately by the `order-lines` channel.)

### Channel 2: `order-lines`

Array expansion — no collect/discover/onboard; bootstrapped on first poll.

| Member | Role | Entity name | sourceEntity | arrayPath | elementKey |
|--------|------|-------------|-------------|-----------|------------|
| erp | array source | order_lines | orders | lines | lineNo |
| webshop | flat target | lineItems | — | — | — |

ERP member parentFields: `{ orderRef: "orderRef" }` — brings the parent order ref into each
element's scope so `orderRef` is available as a canonical field on each child record.

Canonical fields on `order-lines`: `orderRef`, `sku`, `qty`, `unitPrice`.

Field mappings:

| Member | Inbound | Outbound |
|--------|---------|----------|
| erp (array source) | lineNo→lineNo, sku→sku, qty→qty, unitPrice→unitPrice, orderRef→orderRef | (n/a — source only) |
| webshop.lineItems | (read ignored — see §6) | sku→sku, qty→quantity, unitPrice→linePrice, orderRef→purchaseRef |

---

## § 6 Lifecycle Changes — `engine-lifecycle.ts`

### Problem

The current `startEngine` boot sequence does:
```
for each uninitialized channel:
  collectOnly for each member → discover → onboard
```

The `collectOnly` path does not contain array expansion logic.  When it runs for the ERP
`order-lines` member it:

1. Uses `readEntityName = sourceEntity ?? entity` = `"orders"` → reads order records correctly
2. For each record applies inbound mapping and stores shadow under entity `order_lines` with
   the parent external ID (`"ord1"`, `"ord2"`)
3. Produces **two shadow rows shaped like full order objects** — not three line-shaped rows

`discover()` then reports both ERP rows as new, and `onboard()` writes two order-shaped records
to `webshop.lineItems`: wrong count, wrong shape.

Note: teaching `collectOnly` to call `expandArrayRecord` plus `deriveChildCanonicalId` would
technically produce consistent IDs (because `_getOrCreateCanonical` is idempotent, so both
paths would derive the same child UUID from the same parent UUID).  That work is deferred
because in this scenario webshop starts completely empty — there are no pre-existing target
records that need to be discovered and matched.  The first regular poll covers everything.

### Fix

After loading `config.channels`, classify each channel as either **standard** (no member has
`arrayPath`) or **array-expansion** (at least one member has `arrayPath`).

```typescript
const isArrayChannel = (ch: ChannelConfig) => ch.members.some((m) => m.arrayPath);
```

In the onboard loop: skip channels where `isArrayChannel` is true.  They stay
`"uninitialized"` in the channel status view — that is acceptable and accurate for the demo.

The first regular poll calls `ingest("order-lines", "erp")`, which hits the array expansion
path in `_processRecords` (already bypasses the fan-out guard), creates derived canonical IDs,
and dispatches inserts to `webshop.lineItems`. ✓

`ingest("order-lines", "webshop")` is called by the poll loop too.  It reads
`webshop.lineItems` (in-memory connector returns them).  In `_processRecords` (standard path),
it tries to dispatch to the ERP `order_lines` entity — which doesn't exist in ERP's
`getEntities()` → `_dispatchToTarget` returns `{ type: "skip" }`.  No spurious writes. ✓

Also update `buildSeedClusters` to return `[]` for array-expansion channels (no pre-onboard
state to show).

---

## § 7 Object-Card Visualisation of Nested Array Fields

The playground's object card (the per-record card in the identity cluster view) currently
displays only top-level scalar fields. When a record carries embedded arrays (e.g. ERP
`orders` with a `lines` field) the card shows a bare `[Array]` or `[object Object]` token
rather than the actual structured content.

For the array-demo scenario this is misleading: an ERP order is meaningful only when its
embedded lines are visible. The card must render nested array fields in a collapsed/expandable
form.

### § 7.1 Requirements

- Fields whose value is a non-empty JSON array render as an expandable section labelled
  `fieldName (N)` where N is the element count.
- When expanded, each element renders as a nested key–value block, indented below the parent
  field row and styled distinctly (e.g. lighter background, reduced font size).
- Multi-level nesting (array within array element) collapses the inner arrays one level
  further — only two levels of visual nesting are shown; deeper levels show a count chip.
- Collapsed by default for arrays with more than 3 elements; expanded by default for 1–3
  elements.
- The expand/collapse state is local to the card instance (not persisted).
- Applies to all scenarios, not only array-demo — any record field that is an array benefits.

### § 7.2 Scope

`playground/src/components/RecordCard.tsx` (or equivalent card component) — add
`ArrayFieldRow` sub-component. No engine or SDK changes required.

---

## § 8 Implementation Steps

1. **`playground/src/lib/systems.ts`**
   - Add `webshop` to `FIXED_SYSTEMS` and `FIXED_SEED`
   - Add `erp.orders` (with embedded lines) and `erp.items` to `FIXED_SEED`

2. **`playground/src/engine-lifecycle.ts`**
   - In `buildConfig`: ensure `webshop` is included in the `ConnectorInstance` list
   (already follows from `FIXED_SYSTEMS` containing it)
   - In `startEngine` onboard loop: skip array-expansion channels
   - In `buildSeedClusters`: return `[]` for array-expansion channels

3. **`playground/src/scenarios/array-demo.ts`** — new file, channel config from §5

4. **`playground/src/scenarios/index.ts`** — add `"array-demo"` entry

5. **`specs/playground.md`** — add array-expansion channel lifecycle note (§ 3 Spec Changes)

6. **Object-card nested array visualisation** — `playground/src/components/RecordCard.tsx`
   (or equivalent): add `ArrayFieldRow` sub-component per §7.

7. **`CHANGELOG.md`** — add entry under `### Added`

8. `bun run tsc --noEmit` + `bun test` — confirm no regressions
