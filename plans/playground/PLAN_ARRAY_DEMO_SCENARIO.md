# Plan: Array Expansion Playground Scenario

**Status:** complete  
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

### § 4.1 ERP — new entities (flat, old-school)

The ERP seed in `lib/systems.ts` gains two entities — both flat, no embedded arrays.

**`orders`** — one record per order, no embedded lines.

| id | orderRef | total | status | date |
|----|----------|-------|--------|------|
| ord1 | ORD-1001 | 299.90 | shipped | 2026-03-15 |
| ord2 | ORD-1002 | 149.95 | pending | 2026-04-01 |

**`orderLines`** — flat line items, one record per line.

| id | orderRef | lineNo | sku | qty | unitPrice |
|----|----------|--------|-----|-----|-----------|
| ol1 | ORD-1001 | L01 | SKU-001 | 5 | 29.99 |
| ol2 | ORD-1001 | L02 | SKU-002 | 2 | 49.99 |
| ol3 | ORD-1002 | L01 | SKU-001 | 3 | 29.99 |

**`items`** — product catalogue (used by the `products` channel in a future scenario).

| id | sku | itemName | price |
|----|-----|----------|-------|
| item1 | SKU-001 | Widget A | 29.99 |
| item2 | SKU-002 | Widget B | 49.99 |

### § 4.2 Webshop — new system (nested, modern)

Add `webshop` to `FIXED_SYSTEMS` and `FIXED_SEED`.

**`purchases`** — orders with an embedded `lines` array, seeded to match ERP data.

| id | purchaseRef | accountDomain | amount | state | couponCode | lines |
|----|-------------|--------------|--------|-------|------------|-------|
| pu1 | ORD-1001 | acme.com | 299.90 | shipped | null | [{lineNo:"L01",sku:"SKU-001",quantity:5,linePrice:29.99},{lineNo:"L02",sku:"SKU-002",quantity:2,linePrice:49.99}] |
| pu2 | ORD-1002 | globex.com | 149.95 | pending | SAVE10 | [{lineNo:"L01",sku:"SKU-001",quantity:3,linePrice:29.99}] |

`lines` is a raw JSON array on the record — a connector field, not interpreted by the channel
mapping for the `orders` channel (it is excluded from that channel's `fields` list).  The
`order-lines` channel picks it up via `arrayPath: "lines"` on the webshop member.

Pre-seeding both sides is what makes the **bidirectional** demo compelling: the ERP flat
`orderLines` mirror the webshop embedded lines, and changes on either side propagate to the
other.  PLAN_ARRAY_COLLAPSE.md is complete, so both directions are available immediately.

---

## § 5 Scenario Design

**File:** `playground/src/scenarios/array-demo.ts`  
**Label:** `"array-demo (webshop nested lines → erp flat orderLines)"`

### Channel 1: `orders`

Normal bidirectional sync — no array expansion.

| Member | Entity | Identity field | Key mappings |
|--------|--------|---------------|--------------|
| erp | orders | `ref` | orderRef→ref, total→total, status→status, date→date |
| webshop | purchases | `ref` | purchaseRef→ref, amount→total, state→status, createdAt→date |

The webshop `lines` field passes through the channel's shadow storage but is excluded from the
`fields` whitelist, so it is never dispatched to erp.orders.  (It lives on the webshop
purchase record and is picked up separately by the `order-lines` channel.)

### Channel 2: `order-lines`

Array expansion (webshop as array source, ERP as flat target) — no collect/discover/onboard;
bootstrapped on first poll.

| Member | Role | Entity name | sourceEntity | arrayPath | elementKey |
|--------|------|-------------|-------------|-----------|------------|
| webshop | array source | order_lines | purchases | lines | lineNo |
| erp | flat target | orderLines | — | — | — |

Webshop member parentFields: `{ purchaseRef: "purchaseRef" }` — brings the parent purchase
ref (= `orderRef` canonical) into each element's scope.

Canonical fields on `order-lines`: `orderRef`, `lineNo`, `sku`, `qty`, `unitPrice`.

Field mappings:

| Member | Inbound | Outbound |
|--------|---------|----------|
| webshop (array source) | lineNo→lineNo, sku→sku, quantity→qty, linePrice→unitPrice, purchaseRef→orderRef | sku→sku, qty→quantity, unitPrice→linePrice, orderRef→purchaseRef |
| erp.orderLines (flat target) | lineNo→lineNo, sku→sku, qty→qty, unitPrice→unitPrice, orderRef→orderRef | sku→sku, qty→qty, unitPrice→unitPrice, orderRef→orderRef |

The webshop member's **outbound** mapping is exercised by the collapse (reverse) path: when an
ERP `orderLines` record changes, the engine looks up the parent `purchases` record via
`array_parent_map` and writes the updated line back into the `lines` array slot.

---

## § 6 Lifecycle Changes — `engine-lifecycle.ts`

### Problem

The current `startEngine` boot sequence does:
```
for each uninitialized channel:
  collectOnly for each member → discover → onboard
```

The `collectOnly` path does not contain array expansion logic.  When it runs for the webshop
`order-lines` member it:

1. Uses `readEntityName = sourceEntity ?? entity` = `"purchases"` → reads purchase records correctly
2. For each record applies inbound mapping and stores shadow under entity `order_lines` with
   the parent external ID (`"pu1"`, `"pu2"`)
3. Produces **two shadow rows shaped like full purchase objects** — not three line-shaped rows

`discover()` then reports both webshop rows as new, and `onboard()` writes two purchase-shaped
records to `erp.orderLines`: wrong count, wrong shape.

Note: teaching `collectOnly` to call `expandArrayRecord` plus `deriveChildCanonicalId` would
technically produce consistent IDs.  That work is deferred because in this scenario ERP starts
fully seeded  — both sides are pre-seeded, so onboard would attempt redundant inserts.  The
first regular poll's forward expansion + discover pass covers everything correctly.

### Fix

After loading `config.channels`, classify each channel as either **standard** (no member has
`arrayPath`) or **array-expansion** (at least one member has `arrayPath`).

```typescript
const isArrayChannel = (ch: ChannelConfig) => ch.members.some((m) => m.arrayPath);
```

In the onboard loop: skip channels where `isArrayChannel` is true.  They stay
`"uninitialized"` in the channel status view — that is acceptable and accurate for the demo.

The first regular poll calls `ingest("order-lines", "webshop")`, which hits the array
expansion path in `_processRecords` (already bypasses the fan-out guard), creates derived
canonical IDs for each `purchases.lines` element, and dispatches inserts/updates to
`erp.orderLines`. ✓

`ingest("order-lines", "erp")` is called by the poll loop too.  It reads ERP flat
`orderLines` records (in-memory connector returns them).  In `_processRecords` (standard
path), `regularTargets` is empty for the webshop member because the webshop member has
`arrayPath` (it goes into `collapseTargets` instead).  Until `array_parent_map` is populated
by at least one forward pass, no collapse patches are accumulated.  No spurious writes. ✓

Also update `buildSeedClusters` to return `[]` for array-expansion channels (no pre-onboard
state to show).

---

## § 6.5 Engine Prerequisite Analysis

All required engine capabilities are already implemented.  No engine changes are needed for
this scenario.

| Capability | Required by | Status |
|------------|-------------|--------|
| `expandArrayRecord` / `expandArrayChain` | Forward pass: webshop `purchases.lines` → ERP `orderLines` | ✓ complete (PLAN_NESTED_ARRAY_PIPELINE.md) |
| `deriveChildCanonicalId` + `array_parent_map` | Deterministic child IDs; reverse lookup parent for collapse | ✓ complete |
| Collapse path (`collapseTargets` in `_processRecords`) | Reverse pass: ERP `orderLines` → webshop `purchases.lines` slot | ✓ complete (PLAN_ARRAY_COLLAPSE.md) |
| Array source can be any connector | The engine's expansion and collapse paths are symmetric; `arrayPath` on any member works regardless of which system is "source" | ✓ verified — `sourceMember.arrayPath` check is connector-agnostic |
| `collapseTargets` selection | `channel.members.filter(m => m.connectorId !== sourceMember.connectorId && m.arrayPath != null)` — picks up the webshop member when ERP is the ingest source | ✓ verified |
| ERP flat member in `regularTargets` — not `collapseTargets` | ERP `orderLines` member has no `arrayPath`; it enters `regularTargets` for forward fanout from webshop | ✓ verified |
| Boot skip (array-expansion channels bypass onboard) | `engine-lifecycle.ts` fix described in §6 | planned — `isArrayChannel` guard to be added in §8 step 2 |

One nuance: the **collapse pass needs `array_parent_map` data** — populated by the first
forward expansion ingest.  In the seed, both sides are pre-seeded but `array_parent_map` is
empty at boot.  The boot sequence (§6 fix) leaves `order-lines` uninitialized; the first
regular poll runs the forward expansion (`ingest("order-lines", "webshop")`) which populates
`array_parent_map` and establishes identity links.  On the same or next tick, the collapse
path from `ingest("order-lines", "erp")` can find the parent links.  Ordering within a single
poll tick (webshop before erp) is determined by `ch.members` order in the scenario definition;
the webshop member must come first to ensure `array_parent_map` is populated before the ERP
ingest of the same tick tries to use it.  (If ERP runs first within the same tick it simply
finds no collapse patches and skips — no error; the following tick is correct.)

---

## § 7 Object-Card Visualisation of Nested Array Fields

The playground's object card (the per-record card in the identity cluster view) currently
displays only top-level scalar fields. When a record carries embedded arrays (e.g. webshop
`purchases` with a `lines` field) the card shows a bare `[Array]` or `[object Object]` token
rather than the actual structured content.

For the array-demo scenario this is misleading: a webshop purchase is meaningful only when
its embedded lines are visible. The card must render nested array fields in a
collapsed/expandable form.

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
   - Add `webshop` to `FIXED_SYSTEMS` and `FIXED_SEED` (with `purchases` carrying embedded `lines` arrays)
   - Add `erp.orders` (flat, no embedded lines), `erp.orderLines`, and `erp.items` to `FIXED_SEED`

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
