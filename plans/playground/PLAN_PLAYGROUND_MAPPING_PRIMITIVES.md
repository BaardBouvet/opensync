# Plan: Playground Mapping Primitives Showcase

**Status:** complete  
**Date:** 2026-04-10  
**Effort:** M  
**Domain:** Playground  
**Scope:** `playground/src/lib/systems.ts`, `playground/src/scenarios/mapping-showcase.ts`, `playground/src/scenarios/index.ts`  
**Spec:** `specs/field-mapping.md`, `specs/playground.md`  
**Depends on:** none (compatible with but independent of `PLAN_PLAYGROUND_SMB_SEED.md`)  

---

## § 1 Problem Statement

Seventeen implemented mapping primitives have no playground demonstration. A user opening the
playground today sees field rename, array expansion, and association predicate mapping. Everything
else — expressions, normalize, default values, field direction, field groups, all five named
resolution strategies, atomic arrays, source/reverse filters, id_field, reverseRequired, and
soft_delete — is invisible unless they read the spec.

The gap makes it hard to discover features organically and impossible to use the playground as a
live API reference tour.

---

## § 2 Goals

1. Produce a **complete primitive coverage matrix** that maps every implemented mapping primitive
   to at least one playground scenario.
2. Extend `FIXED_SEED` in `playground/src/lib/systems.ts` with the minimum extra fields required
   to make each primitive produce an observable effect in the UI.
3. Add one new scenario, **`mapping-showcase`**, that exercises every primitive listed in § 3 in a
   realistic 2-channel, 3-system config.
4. Register `mapping-showcase` in `playground/src/scenarios/index.ts`.
5. Make every primitive self-documenting via YAML comments inside the scenario file itself, so
   users reading the YAML editor can identify what each config key does.

Out of scope: primitives marked "not yet implemented" in `specs/field-mapping.md` (passthrough
columns, references_field/vocabulary targets, and linked-list array ordering).
`source_path` (§1.7) and embedded objects (§3.1) are now implemented — they are added to the
coverage matrix below (rows 23–24) for the next pass of this plan.

---

## § 3 Primitive Coverage Matrix

The table below shows coverage status **before this plan**. Rows 4–5 (structural) are covered
by the new `deep-nesting` scenario (§ 5.3); rows 7–22 (field-level) are covered by the new
`mapping-showcase` scenario (§ 5.1–5.2).

| # | Primitive | Spec § | Config key(s) | Pre-plan coverage |
|---|-----------|--------|---------------|-------------------|
| 1 | Field rename / whitelist | §1.1 | `source`, `target` | ✓ all scenarios |
| 2 | Array expansion | §3.2 | `array_path`, `parent`, `element_key` | ✓ array-demo |
| 3 | Scalar arrays | §3.3 | `scalar: true` | ✓ array-demo |
| 4 | Deep nesting (multi-hop `expansionChain`) | §3.4 | `parent:` chain depth ≥ 2, `element_key` at each hop | ✗ |
| 5 | Cross-channel expansion | §3.2 | parent as full channel member + child in different channel | ✗ |
| 6 | Association predicate routing | § assoc spec | `associations` | ✓ associations-demo |
| 7 | Field direction | §1.2 | `direction: forward_only / reverse_only` | ✗ |
| 8 | Field expressions | §1.3 | `expression`, `reverse_expression`, `sources` | ✗ |
| 9 | Normalize | §1.4 | `normalize` | ✗ |
| 10 | Default value | §1.5 | `default` | ✗ |
| 11 | Field group | §1.8 | `group` | ✗ |
| 12 | Coalesce | §2.1 | `conflict.fieldStrategies.<f>.strategy: coalesce` | ✗ |
| 13 | Last-modified (LWW) | §2.2 | `conflict.fieldStrategies.<f>.strategy: last_modified` | ✗ |
| 14 | Expression resolver | §2.3 | `resolve` (expression string on field entry) | ✗ |
| 15 | Collect | §2.4 | `conflict.fieldStrategies.<f>.strategy: collect` | ✗ |
| 16 | bool_or | §2.5 | `conflict.fieldStrategies.<f>.strategy: bool_or` | ✗ |
| 17 | Atomic arrays | §3.5 | `sort_elements`, `element_fields` | ✗ |
| 18 | Source filter | §5.1 | `filter` (mapping-entry level) | ✗ |
| 19 | Reverse filter | §5.2 | `reverse_filter` (mapping-entry level) | ✗ |
| 20 | PK as field | §4.1 | `id_field` | ✗ |
| 21 | reverseRequired | §1.5 | `reverseRequired: true` on field entry | ✗ |
| 22 | Soft delete | §8.2 | `soft_delete: { strategy, field }` | ✗ |
| 23 | JSON sub-field extraction | §1.7 | `source_path` | ✓ mapping-showcase |
| 24 | Embedded objects | §3.1 | `parent:` (no `array_path`), child `entity` | ✓ mapping-showcase |

Items 1–3 and 6 are already covered; items 4–5 and 7–24 are addressed by this plan.

---

## § 4 Seed Additions

All additions extend `FIXED_SEED` in `playground/src/lib/systems.ts`. The goal is the minimum
set of new fields needed for each primitive to produce an observable difference in the UI (either
a mapped value appearing, a filter suppressing a record, or a default value filling in).

### § 4.1 `crm.contacts`

| New field | Example values | Purpose |
|-----------|---------------|---------|
| `firstName` | "Alice", "Bob", "Carol" | Split-name for expression demo; replaces `name` or added alongside |
| `lastName` | "Liddell", "Martin", "White" | Group + expression source |
| `phone` | `"(555) 100-0001"`, `"555-100-0002"`, `"+1 555 100 0003"` | Normalize strips non-digits before diff |
| `status` | `"active"`, `null`, `"active"` | `null` on c2 triggers the `default: "active"` fallback |
| `isVerified` | `true`, `null`, `null` | bool_or: c1 true propagates even though others are null |
| `leadScore` | `90`, `72`, `55` | forward_only field — visible in CRM, never written to ERP/HR |
| `isDeleted` | `false`, `true`, `false` | soft_delete: c2 (Bob) soft-deleted; should be excluded from canonical |

### § 4.2 `erp.employees`

| New field | Example values | Purpose |
|-----------|---------------|---------|
| `firstName` | "Alice", "Bob" | Round-trip for reverse_expression decompose |
| `lastName` | "Li", "Martin" | Same as above |
| `phoneNo` | `"5551000001"`, `"5551000002"` | Clean digits — normalize is noop; diffing still works |
| `emailAddress` | `"alice@acme.com"`, `"bob@globex.com"` | Used as the `email` canonical field |
| `isVerified` | `null`, `null` | bool_or sees null; merges with CRM true for Alice |
| `status` | `"active"`, `"inactive"` | `filter: "record.status !== 'inactive'"` suppresses Bob from ingest |

### § 4.3 `hr.people`

| New field | Example values | Purpose |
|-----------|---------------|---------|
| `firstName` | "Bob", "Carol" | Name group merge from HR |
| `lastName` | "Martin", "White" | Name group |
| `corporateEmail` | `"bob@globex.com"`, `null` | reverse_filter demo: Carol has no email → HR dispatch suppressed |
| `phone` | `"+1-555-100-0002"`, `"+1-555-100-0003"` | Normalize strips dashes/spaces for diff |
| `isVerified` | `null`, `false` | bool_or: HR contributes null and false; neither wins over CRM true |

### § 4.4 `crm.companies`

| New field | Example values | Purpose |
|-----------|---------------|---------|
| `description` | Long paragraph on co1, shorter on co2, null on co3 | Expression resolver selects richer |
| `categories` | `["enterprise","partner"]`, `["smb"]`, `["startup"]` | collect merges all categories |
| `isPremium` | `true`, `null`, `false` | bool_or: co1 is marked premium |
| `certifications` | `[{code:"ISO-9001",since:"2020"}]`, `[]`, `[]` | Atomic array via element_fields |

### § 4.5 `erp.accounts`

| New field | Example values | Purpose |
|-----------|---------------|---------|
| `description` | Short phrase, null | Expression resolver: CRM wins when ERP is shorter/null |
| `categories` | `["key-account"]`, `["prospect"]` | collect merges into set with CRM values |
| `isPremium` | `null`, `null` | bool_or: will only be true when CRM says true |
| `certifications` | `[]`, `[{code:"SOC2",since:"2023"}]` | Atomic array from a different source |

### § 4.6 `hr.orgs`

| New field | Example values | Purpose |
|-----------|---------------|---------|
| `description` | `null`, `null` | Coalesce skips; last_modified picks from CRM or ERP |
| `categories` | `["global"]`, `["regional"]` | collect adds HR's categories to the set |
| `isPremium` | `null`, `null` | bool_or: HR never marks premium |

### § 4.7 `erp.orders` — deep-nesting seed extension

Each order already exists in `FIXED_SEED`. The only addition is an embedded `lines` array on
each order where each line itself contains an embedded `components` sub-array. This gives a
3-level hierarchy (order → line → component) to drive the §3.4 expansion chain:

```ts
// Add to existing erp.orders records
{ id: "ord1", data: {
    orderRef: "ORD-1001", total: 299.90, status: "shipped",
    lines: [
      { lineNo: "L01", sku: "SKU-001", qty: 5, unitPrice: 29.99,
        components: [
          { compNo: "C01", partCode: "P-AAA", qty: 5  },
          { compNo: "C02", partCode: "P-BBB", qty: 10 },
        ]
      },
      { lineNo: "L02", sku: "SKU-002", qty: 2, unitPrice: 49.99,
        components: [
          { compNo: "C01", partCode: "P-CCC", qty: 2  },
        ]
      },
    ]
} }
```

A 2-hop `expandArrayChain` produces 3 leaf records with composite IDs
`ord1#lines[L01]#components[C01]`, `ord1#lines[L01]#components[C02]`,
`ord1#lines[L02]#components[C01]`.

### § 4.8 `warehouse.components` — new system (deep-nesting scenario only)

A new `warehouse` system added to `FIXED_SYSTEMS` and `FIXED_SEED`. Used only by the
`deep-nesting` scenario; other scenarios ignore it.

```ts
warehouse: {
  components: [
    { id: "wc1", data: { partCode: "P-AAA", stockQty: 50,  ordQty: 5,  orderRef: "ORD-1001", lineNo: "L01", compNo: "C01" } },
    { id: "wc2", data: { partCode: "P-BBB", stockQty: 200, ordQty: 10, orderRef: "ORD-1001", lineNo: "L01", compNo: "C02" } },
    { id: "wc3", data: { partCode: "P-CCC", stockQty: 80,  ordQty: 2,  orderRef: "ORD-1001", lineNo: "L02", compNo: "C01" } },
  ]
}
```

---

## § 5 Scenario: `mapping-showcase`

New file: `playground/src/scenarios/mapping-showcase.ts`

Exports a `ScenarioDefinition` with a single YAML string. The YAML is the canonical playground
config — parsed by the engine via `MappingsFileSchema`. It contains inline comments calling
out each primitive by spec section number.

### § 5.1 Channel `persons` — contacts / employees / people

Three systems (crm, erp, hr) merged into one canonical `persons` entity.

| Primitive | Config element | Observable outcome |
|-----------|---------------|--------------------|
| §1.1 rename | `emailAddress → email` on ERP | Alice's erp email appears as canonical `email` |
| §1.2 forward_only | `leadScore → crmLeadScore` | CRM score visible in canonical; never written to ERP/HR |
| §1.2 reverse_only | `syncSource → _origin` on ERP | Field injected on write-back only; absent on ingest |
| §1.3 expression | `fullName` from `firstName`+`lastName` | Canonical shows "Alice Liddell"; reverse decomposes |
| §1.4 normalize | `phone` strips `\D` | ERP `5551000001` and CRM `(555) 100-0001` compare equal; no loop |
| §1.5 default | `status` default `"active"` | c2 Bob (null status in CRM) gets `"active"` in canonical |
| §1.8 group | `group: name` on firstName+lastName | firstName and lastName always resolved from the same winning source |
| §4.1 id_field | `id_field: crmId` on CRM mapping | CRM's own PK surfaces as `crmId` in canonical data |
| §5.1 filter | `filter: "record.status !== 'inactive'"` on ERP | Bob (inactive in ERP) excluded from ERP ingest pass |
| §5.2 reverse_filter | `reverse_filter: "record.corporateEmail != null"` on HR | Carol (null email) gets no write-back to HR |
| reverseRequired | `reverseRequired: true` on ERP `email` | ERP dispatch row suppressed entirely if canonical email is null |
| soft_delete | `soft_delete: { strategy: deleted_flag, field: isDeleted }` on CRM | c2 Bob soft-deleted in CRM; engine treats record as deleted |

Approximate YAML structure for this channel:

```yaml
channels:
  - id: persons
    identity: [email]

conflict:
  fieldStrategies:
    firstName: { strategy: coalesce }
    lastName: { strategy: coalesce }
    phone: { strategy: last_modified }

mappings:
  # ── CRM contacts ────────────────────────────────────────────────────────────
  - connector: crm
    channel: persons
    entity: contacts
    # §8.2 soft_delete: treat isDeleted:true as record.deleted
    soft_delete:
      strategy: deleted_flag
      field: isDeleted
    id_field: crmId          # §4.1 — CRM PK injected as canonical field
    fields:
      - source: email
        target: email
      # §1.8 group: firstName + lastName resolved atomically
      - source: firstName
        target: firstName
        group: name
      - source: lastName
        target: lastName
        group: name
      # §1.3 expression: assemble fullName; reverse decomposes back
      - sources: [firstName, lastName]
        target: fullName
        expression: "`${record.firstName ?? ''} ${record.lastName ?? ''}`.trim()"
        reverse_expression: "({ firstName: record.fullName.split(' ')[0], lastName: record.fullName.split(' ').slice(1).join(' ') })"
      # §1.4 normalize: strip all non-digit characters before diff
      - source: phone
        target: phone
        normalize: "String(v).replace(/\\D/g, '')"
      # §1.5 default: null status in CRM becomes "active"
      - source: status
        target: status
        default: "active"
      # §1.2 forward_only: leadScore captured from CRM, never written to ERP/HR
      - source: leadScore
        target: crmLeadScore
        direction: forward_only

  # ── ERP employees ────────────────────────────────────────────────────────────
  - connector: erp
    channel: persons
    entity: employees
    # §5.1 filter: inactive employees excluded from the forward pass
    filter: "record.status !== 'inactive'"
    fields:
      - source: emailAddress
        target: email
        reverseRequired: true   # §spec — don't dispatch if canonical email null
      - source: firstName
        target: firstName
        group: name
      - source: lastName
        target: lastName
        group: name
      - source: phoneNo
        target: phone
        normalize: "String(v).replace(/\\D/g, '')"
      # §1.2 reverse_only: inject origin label on write-back only; never read
      - source: syncSource
        target: _origin
        direction: reverse_only

  # ── HR people ────────────────────────────────────────────────────────────────
  - connector: hr
    channel: persons
    entity: people
    # §5.2 reverse_filter: suppress dispatch to HR when canonical email is absent
    reverse_filter: "record.corporateEmail != null"
    fields:
      - source: corporateEmail
        target: email
      - source: firstName
        target: firstName
        group: name
      - source: lastName
        target: lastName
        group: name
      - source: phone
        target: phone
        normalize: "String(v).replace(/\\D/g, '')"
```

### § 5.2 Channel `orgs` — companies / accounts / orgs

Three systems (crm, erp, hr) merged into one canonical `orgs` entity.

| Primitive | Config element | Observable outcome |
|-----------|---------------|--------------------|
| §2.1 coalesce | `domain: coalesce` | First non-null domain wins; HR rarely has domain → ERP/CRM fill in |
| §2.2 last_modified | `name: last_modified` | Most-recently updated name wins across all sources |
| §2.3 resolve expression | `resolve` string on `description` | Longer description wins; CRM prose beats ERP skeleton |
| §2.4 collect | `categories: collect` | `["enterprise","partner"]` + `["key-account"]` + `["global"]` → union set |
| §2.5 bool_or | `isPremium: bool_or` | co1 marked premium in CRM → canonical isPremium true despite null elsewhere |
| §3.5 atomic arrays | `sort_elements: true` + `element_fields` on `certifications` | Array sorted before diff; per-element `code`/`since` rename applied |

Approximate YAML structure for this channel:

```yaml
  - id: orgs
    identity: [domain]

# (append to conflict block above)
conflict:
  fieldStrategies:
    domain: { strategy: coalesce }
    name: { strategy: last_modified }
    categories: { strategy: collect }
    isPremium: { strategy: bool_or }

mappings:
  # ── CRM companies ────────────────────────────────────────────────────────────
  - connector: crm
    channel: orgs
    entity: companies
    fields:
      - source: domain
        target: domain
      - source: name
        target: name
      # §2.3 resolve expression: pick whichever description is longer
      - source: description
        target: description
        resolve: >
          (incoming.description?.length ?? 0) >= (existing.description?.length ?? 0)
            ? incoming.description
            : existing.description
      - source: categories
        target: categories
      - source: isPremium
        target: isPremium
      # §3.5 atomic array: certifications sorted + per-element field rename
      - source: certifications
        target: certifications
        sort_elements: true
        element_fields:
          - source: code
            target: certCode
          - source: since
            target: certSince

  # ── ERP accounts ─────────────────────────────────────────────────────────────
  - connector: erp
    channel: orgs
    entity: accounts
    fields:
      - source: website
        target: domain
      - source: accountName
        target: name
      - source: description
        target: description
        resolve: >
          (incoming.description?.length ?? 0) >= (existing.description?.length ?? 0)
            ? incoming.description
            : existing.description
      - source: categories
        target: categories
      - source: isPremium
        target: isPremium
      - source: certifications
        target: certifications
        sort_elements: true
        element_fields:
          - source: code
            target: certCode
          - source: since
            target: certSince

  # ── HR orgs ──────────────────────────────────────────────────────────────────
  - connector: hr
    channel: orgs
    entity: orgs
    fields:
      - source: domain
        target: domain
      - source: name
        target: name
      - source: categories
        target: categories
      - source: isPremium
        target: isPremium
```

---

## § 5.3 Scenario `deep-nesting` — §3.4 + cross-channel expansion

Because §3.4 requires a three-entry named chain, an additional system (`warehouse`), and seed
data that does not fit the field-primitive showcase, deep nesting is its own registered scenario:
`deep-nesting`.

New file: `playground/src/scenarios/deep-nesting.ts`

### Two channels

**`orders`** — ERP orders ↔ Webshop purchases (same identity contract as `array-demo`, reused
for familiarity). The ERP `orders` entry is a **full channel member with a stable `name:`**, so
the child channel can reference it cross-channel.

**`components`** — ERP `orders.lines[*].components[*]` via a 2-hop expansion chain into flat
`warehouse.components` records. Cross-channel: the top-level parent lives in `orders`.

### Primitive coverage in this scenario

| Primitive | Config element | Observable outcome |
|-----------|---------------|--------------------|
| §3.4 deep nesting | `parent: erp_lines`, where `erp_lines` itself has `parent: erp_orders_src` | 3 warehouse component records derived from 1 ERP order |
| §3.2 cross-channel | `erp_orders_src` is a full member of `orders`; its child entry is in `components` | parent resolves independently in `orders`; child references it cross-channel |
| §3.2 `parent_fields` | `orderRef` lifted at hop 1; `lineNo` lifted at hop 2 | both fields present on every leaf record without re-walking the chain |
| Reverse collapse | write-back to `warehouse.components` patches correct slot in erp nested array | `components[C01]` on `ord1.lines[L01]` is the only element updated |

### Approximate YAML

```yaml
channels:
  - id: orders
    identity: [ref]
  - id: components
    identity:
      - fields: [orderRef, lineNo, compNo]

mappings:
  # ── Channel: orders ──────────────────────────────────────────────────────────
  # Full member — also serves as cross-channel parent for `components`
  - name: erp_orders_src
    connector: erp
    entity: orders
    channel: orders
    fields:
      - { source: orderRef, target: ref    }
      - { source: total,    target: total  }
      - { source: status,   target: status }

  - connector: webshop
    entity: purchases
    channel: orders
    fields:
      - { source: purchaseRef, target: ref    }
      - { source: amount,      target: total  }
      - { source: state,       target: status }

  # ── Channel: components (2-hop deep nesting + cross-channel) ─────────────────
  # Hop 1: orders[] → lines[]
  - name: erp_lines
    connector: erp
    parent: erp_orders_src      # cross-channel parent (its channel is 'orders')
    channel: components
    array_path: lines
    element_key: lineNo
    parent_fields:
      orderRef: orderRef         # lift orderRef from order into line scope

  # Hop 2 (leaf): lines[] → components[]
  - parent: erp_lines
    channel: components
    array_path: components
    element_key: compNo
    parent_fields:
      lineNo: lineNo             # lift lineNo from line into component scope
    fields:
      - { source: compNo,   target: compNo   }
      - { source: partCode, target: partCode }
      - { source: qty,      target: ordQty   }
      - { source: orderRef, target: orderRef }
      - { source: lineNo,   target: lineNo   }

  # Flat target connector
  - connector: warehouse
    entity: components
    channel: components
    fields:
      - { source: partCode, target: partCode }
      - { source: stockQty, target: stockQty }
      - { source: ordQty,   target: ordQty   }
      - { source: orderRef, target: orderRef }
      - { source: lineNo,   target: lineNo   }
      - { source: compNo,   target: compNo   }
```

---

## § 6 Registration

Add to `playground/src/scenarios/index.ts`:

```ts
import mappingShowcase from "./mapping-showcase.js";
import deepNesting from "./deep-nesting.js";

export const scenarios: Record<string, ScenarioDefinition> = {
  "associations-demo": associationsDemo,
  "assoc-cardinality": assocCardinality,
  "array-demo": arrayDemo,
  "mapping-showcase": mappingShowcase,   // ← new: field-level primitives
  "deep-nesting": deepNesting,           // ← new: §3.4 deep nesting + cross-channel
  "minimal": minimal,
  "empty": empty,
};
```

Labels: `"Mapping Showcase (all primitives)"` and `"Deep Nesting (multi-hop array expansion)"`.

---

## § 7 Acceptance Criteria

All of the following must be observable in the playground UI after the sync cycle:

- [ ] `crmId` appears in Alice's canonical `persons` record with her CRM PK value.
- [ ] `fullName` is `"Alice Liddell"` in the canonical record; `firstName`/`lastName` round-trips back correctly to ERP.
- [ ] Alice's three different phone formats (`(555) 100-0001`, `5551000001`, `+1-555-100-0002`) all compare equal — no update event after first sync.
- [ ] Bob (c2, status null in CRM) has `status: "active"` in the canonical record.
- [ ] Bob (e2, status "inactive" in ERP) is not contributed by the ERP member.
- [ ] Bob (c2, `isDeleted: true` in CRM) is removed from the canonical entity after soft-delete detection.
- [ ] `crmLeadScore` appears in the canonical record but is absent from ERP and HR write-back payloads.
- [ ] Carol has no write-back dispatched to HR (reverse_filter suppresses it).
- [ ] co1's `description` in the canonical `orgs` record is the long CRM version, not the short ERP version.
- [ ] `categories` on co1 is a merged set containing `"enterprise"`, `"partner"`, `"key-account"`, and `"global"`.
- [ ] `isPremium` on co1 is `true` in canonical despite ERP and HR having `null`.
- [ ] `certifications` on orgs diff-compares stably regardless of source API order.
- [ ] `deep-nesting` scenario: ERP order `ord1` produces exactly 3 `warehouse.components` records after sync.
- [ ] Composite canonical IDs follow the `ord1#lines[L01]#components[C01]` pattern.
- [ ] `orderRef` and `lineNo` are present on every synced leaf record (lifted via `parent_fields`).
- [ ] Writing a change to `warehouse.components` propagates back and patches the correct slot in `erp.orders.lines[*].components[*]` (reverse collapse).

---

## § 8 Compatibility Note

This plan is independent of `PLAN_PLAYGROUND_SMB_SEED.md`. Both extend `FIXED_SEED` and
add scenarios but do not conflict. If the SMB seed plan lands first and introduces per-scenario
seed modules, the `mapping-showcase` scenario's seed additions should be moved to a co-located
`playground/src/scenarios/mapping-showcase-seed.ts` instead of staying in `FIXED_SEED`.

---

## § 9 Spec Changes Planned

No spec changes are needed. All primitives demonstrated by this plan are already fully
specified in `specs/field-mapping.md` (§1–§8). The only spec that might benefit from a small
update is `specs/playground.md` — a new row in the scenarios table to list `mapping-showcase`.
That update should be made when the scenario is implemented.
