// Scenario: mapping-showcase
// Exercises every implemented field-level mapping primitive across two channels
// (persons + orgs) and three systems (crm / erp / hr), plus a two-channel
// deep-nesting block (orders + components) that demonstrates §3.4 multi-hop
// array expansion and §3.2 cross-channel parent.
//
// Each config key is annotated with the spec section that documents it so that
// users reading the YAML editor can immediately identify what the key does.
//
// Coverage matrix (spec § → config key → observable outcome):
//   §1.1  rename          emailAddress → email (ERP)
//   §1.2  forward_only    leadScore captured from CRM, never written to ERP/HR
//   §1.2  reverse_only    syncSource injected on ERP write-back only
//   §1.3  expression      fullName assembled from firstName + lastName; reverse decomposes
//   §1.4  normalize       phone strips non-digits before diff (3 formats → same canonical)
//   §1.5  default         null CRM status → "active"
//   §1.10 value_map       CRM status a/i → canonical active/inactive; ERP 1/2 → same
//   §1.7  source_path     billing.street / billing.city extracted from ERP nested billing object
//   §1.8  group           firstName + lastName resolved atomically from winning source
//   §2.1  priority (mapping)  crm priority:1, erp priority:2, hr priority:3 declared on each mapping entry
//   §2.1  priority (field)  ERP firstName/lastName override to priority:0 — ERP wins name over CRM
//   §2.1  coalesce        domain: first non-null wins across crm/erp/hr; crm wins (priority 1)
//   §2.2  last_modified   name / phone: most-recently updated value wins
//   §2.3  resolve         description: longer value wins
//   §2.4  collect         categories: union set merged across all sources
//   §2.5  bool_or         isPremium: true from any source → canonical true
//   §3.2  cross-channel   erp_orders_src parent member lives in `orders`; child in `components`
//   §3.4  deep nesting    2-hop expansion chain: orders → lines → components
//   §3.1  embedded_obj    homeStreet + homeCity read from CRM contacts → contact_addresses entity
//   §3.5  atomic arrays   certifications with sort_elements + element_fields rename
//   §4.1  id_field        CRM PK surfaces as canonical crmId field
//   §5.1  filter          inactive ERP employees excluded from ingest
//   §5.2  reverse_filter  HR dispatch suppressed when canonical email absent
//   §8.2  soft_delete     CRM isDeleted:true treated as removed record
//   reverseRequired       ERP dispatch suppressed if canonical email is null
//
// Spec: specs/field-mapping.md §1–§8, specs/playground.md §3
import type { ScenarioDefinition } from "./types.js";

const scenario: ScenarioDefinition = {
  label: "Mapping Showcase (all mapping primitives)",
  yaml: `
channels:
  - id: persons
    identity: [email]
    fields:
      # §1.8 group: firstName + lastName resolved atomically from single winning source
      firstName: { strategy: coalesce }
      lastName:  { strategy: coalesce }
      # §2.2 last_modified: most-recently updated phone wins across sources
      phone: { strategy: last_modified }
  - id: orgs
    identity: [domain]
    fields:
      # §2.1 coalesce: first non-null domain wins; crm (priority 1) beats erp (2) beats hr (3)
      domain: { strategy: coalesce }
      # §2.2 last_modified: most-recently updated org name wins
      name: { strategy: last_modified }
      # §2.4 collect: categories merged as a union set across all sources
      categories: { strategy: collect }
      # §2.5 bool_or: isPremium is true if ANY source says true
      isPremium: { strategy: bool_or }
  - id: orders
    identity: [ref]
  - id: components
    # §3.2 compound identity: all three fields together identify one component
    identity:
      - fields: [orderRef, lineNo, compNo]


mappings:
  # ═══════════════════════════════════════════════════════════════════════════
  # Channel: persons  (crm.contacts / erp.employees / hr.people)
  # ═══════════════════════════════════════════════════════════════════════════

  # ── CRM contacts (named for embedded-object child reference) ─────────────────
  # name: required so the embedded-object child below can use parent: crm_contacts
  - name: crm_contacts
    connector: crm
    entity: contacts
    channel: persons
    # §2.1 priority (mapping-level): CRM is most authoritative for persons coalesce fields
    priority: 1
    # §8.2 soft_delete: records with isDeleted:true are treated as removed
    soft_delete:
      strategy: deleted_flag
      field: isDeleted
    # §4.1 id_field: CRM's own primary key surfaces as canonical field "crmId"
    id_field: crmId
    fields:
      - { source: email, target: email }
      # §1.8 group: firstName + lastName always resolved from the same source
      - { source: firstName, target: firstName, group: name }
      - { source: lastName,  target: lastName,  group: name }
      # §1.3 expression: assemble canonical fullName; reverse decomposes it back
      - sources: [firstName, lastName]
        target: fullName
        expression: "\`\${record.firstName ?? ''} \${record.lastName ?? ''}\`.trim()"
        reverse_expression: "({ firstName: (record.fullName ?? '').split(' ')[0], lastName: (record.fullName ?? '').split(' ').slice(1).join(' ') })"
      # §1.4 normalize: strip all non-digit chars before diff — 3 formats compare equal
      - source: phone
        target: phone
        normalize: 'String(v).replace(/\D/g, "")'
      # §1.5 default: null CRM status falls back to "active"
      # §1.10 value_map: CRM uses short codes a=active i=inactive; canonical is the full word
      - source: status
        target: status
        default: "active"
        value_map:
          'a': 'active'
          'i': 'inactive'
        reverse_value_map:
          'active':   'a'
          'inactive': 'i'
      # §1.2 forward_only: leadScore captured from CRM, never written to ERP or HR
      - source: leadScore
        target: crmLeadScore
        direction: forward_only

  # §3.1 embedded object: CRM homeStreet/homeCity split into a separate contact_addresses entity
  # parent: crm_contacts with no array_path → embedded object (reads same CRM contact row)
  - connector: crm
    parent: crm_contacts
    entity: contact_addresses
    channel: persons
    fields:
      - { source: homeStreet, target: street }
      - { source: homeCity,   target: city   }

  # ── ERP employees ────────────────────────────────────────────────────────────
  - connector: erp
    entity: employees
    channel: persons
    # §2.1 priority (mapping-level): ERP is secondary for persons coalesce fields by default…
    priority: 2
    # §5.1 filter: inactive employees are excluded from the ERP ingest pass
    filter: "record.status !== 'inactive'"
    fields:
      # §1.1 rename: ERP "emailAddress" maps to canonical "email"
      - source: emailAddress
        target: email
        # reverseRequired: if canonical email is null, suppress ERP dispatch entirely
        reverseRequired: true
      # §2.1 priority (field-level): …except for name fields where ERP is the HR-of-record
      # priority: 0 overrides the mapping-level priority: 2, making ERP win over CRM (priority: 1)
      - source: firstName
        target: firstName
        group: name
        priority: 0
      - source: lastName
        target: lastName
        group: name
        priority: 0
      - source: phoneNo
        target: phone
        normalize: 'String(v).replace(/\D/g, "")'
      # §1.2 reverse_only: inject a label field on ERP write-back; never read on ingest
      - source: syncSource
        target: _origin
        direction: reverse_only
      # §1.10 value_map: ERP uses numeric codes 1=active 2=inactive; same canonical as CRM
      - source: status
        target: status
        value_map:
          '1': 'active'
          '2': 'inactive'
        reverse_value_map:
          'active':   '1'
          'inactive': '2'

  # ── HR people ────────────────────────────────────────────────────────────────
  - connector: hr
    entity: people
    channel: persons
    # §5.2 reverse_filter: if canonical email is absent, suppress HR write-back entirely
    reverse_filter: "record.corporateEmail != null"
    fields:
      - { source: corporateEmail, target: email }
      - { source: firstName, target: firstName, group: name }
      - { source: lastName,  target: lastName,  group: name }
      - source: phone
        target: phone
        normalize: 'String(v).replace(/\D/g, "")'


  # ═══════════════════════════════════════════════════════════════════════════
  # Channel: orgs  (crm.companies / erp.accounts / hr.orgs)
  # ═══════════════════════════════════════════════════════════════════════════

  # ── CRM companies ────────────────────────────────────────────────────────────
  - connector: crm
    entity: companies
    channel: orgs
    # §2.1 priority (mapping-level): CRM is most authoritative for orgs coalesce fields
    priority: 1
    fields:
      - { source: domain, target: domain }
      - { source: name,   target: name   }
      # §2.3 resolve: pick whichever description is longer across all sources
      - source: description
        target: description
        resolve: >
          (incoming.description?.length ?? 0) >= (existing.description?.length ?? 0)
            ? incoming.description
            : existing.description
      - { source: categories, target: categories }
      - { source: isPremium,  target: isPremium  }
      # §3.5 atomic array: sort certifications before diff; rename code/since fields
      - source: certifications
        target: certifications
        sort_elements: true
        element_fields:
          - { source: code,  target: certCode  }
          - { source: since, target: certSince }

  # ── ERP accounts ─────────────────────────────────────────────────────────────
  - connector: erp
    entity: accounts
    channel: orgs
    # §2.1 priority (mapping-level): ERP is secondary for orgs coalesce fields
    priority: 2
    fields:
      - { source: website,     target: domain }
      - { source: accountName, target: name   }
      - source: description
        target: description
        resolve: >
          (incoming.description?.length ?? 0) >= (existing.description?.length ?? 0)
            ? incoming.description
            : existing.description
      - { source: categories, target: categories }
      - { source: isPremium,  target: isPremium  }
      - source: certifications
        target: certifications
        sort_elements: true
        element_fields:
          - { source: code,  target: certCode  }
          - { source: since, target: certSince }
      # §1.7 source_path: ERP returns billing address as a nested object; extract each field
      - source_path: billing.street
        target: billingStreet
      - source_path: billing.city
        target: billingCity

  # ── HR orgs ──────────────────────────────────────────────────────────────────
  - connector: hr
    entity: orgs
    channel: orgs
    # §2.1 priority (mapping-level): HR is lowest priority for orgs coalesce fields
    priority: 3
    fields:
      - { source: site,        target: domain     }
      - { source: orgName,     target: name       }
      - { source: categories,  target: categories }
      - { source: isPremium,   target: isPremium  }


  # ═══════════════════════════════════════════════════════════════════════════
  # Channel: orders  (erp.orders ↔ webshop.purchases)
  # ═══════════════════════════════════════════════════════════════════════════

  # Full named member — also serves as the cross-channel parent for \`components\`.
  # The name is required so hop-1 can reference it with parent: erp_orders_src.
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


  # ═══════════════════════════════════════════════════════════════════════════
  # Channel: components  (§3.4 deep nesting + §3.2 cross-channel)
  # ═══════════════════════════════════════════════════════════════════════════

  # Hop 1: orders[] → lines[]
  # §3.4 parent references a named cross-channel member (erp_orders_src is in 'orders')
  # §3.2 parent_fields: orderRef lifted from order scope into each line record
  - name: erp_lines
    connector: erp
    channel: components
    parent: erp_orders_src
    array_path: lines
    element_key: lineNo
    parent_fields:
      orderRef: orderRef

  # Hop 2 (leaf): lines[] → components[]
  # §3.4 grandchild references the intermediate expansion (erp_lines)
  # §3.2 parent_fields: lineNo lifted from line scope into each component record
  - connector: erp
    channel: components
    parent: erp_lines
    array_path: components
    element_key: compNo
    parent_fields:
      lineNo: lineNo
    fields:
      - { source: compNo,   target: compNo   }
      - { source: partCode, target: partCode }
      - { source: qty,      target: ordQty   }
      - { source: orderRef, target: orderRef }
      - { source: lineNo,   target: lineNo   }

  # Flat target — warehouse.components records are the write destination
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
`,
};

export default scenario;
