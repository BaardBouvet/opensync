// Scenario: assoc-cardinality
// CRM contacts carry two typed company associations (primaryCompanyId,
// secondaryCompanyId); ERP employees carry a single orgId FK.
// The assocMappings whitelist routes only primaryCompanyRef to ERP, so
// secondaryCompanyId edges are dropped automatically — no engine config needed.
// Spec: plans/playground/PLAN_HUBSPOT_TRIPLETEX_ASSOC_DEMO.md
import type { ScenarioDefinition } from "./types.js";

const scenario: ScenarioDefinition = {
  label: "assoc-cardinality (crm many-to-many ↔ erp single FK)",
  yaml: `
channels:
  - id: companies
    identityFields: [domain]
  - id: contacts
    identityFields: [email]

conflict:
  strategy: lww

mappings:
  # ── Channel: companies ────────────────────────────────────────────────────
  - connector: crm
    entity: companies
    channel: companies
    fields:
      - { source: name,   target: name   }
      - { source: domain, target: domain }

  - connector: erp
    entity: accounts
    channel: companies
    fields:
      - { source: accountName, target: name   }
      - { source: website,     target: domain }

  # ── Channel: contacts ─────────────────────────────────────────────────────
  - connector: crm
    entity: contacts
    channel: contacts
    fields:
      - { source: name,  target: name  }
      - { source: email, target: email }
    associations:
      - { source: primaryCompanyId,   target: primaryCompanyRef  }
      - { source: secondaryCompanyId, target: secondaryCompanyRef }

  - connector: erp
    entity: employees
    channel: contacts
    fields:
      - { source: fullName, target: name  }
      - { source: email,    target: email }
    # ERP only maps primaryCompanyRef → orgId.
    # secondaryCompanyRef has no entry here, so those edges are dropped
    # by the assocMappings whitelist — no engine change needed.
    associations:
      - { source: orgId, target: primaryCompanyRef }
`,
};

export default scenario;
