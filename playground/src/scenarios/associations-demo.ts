// Scenario: associations-demo
// Three systems (crm / erp / hr) × two entities each (companies+contacts /
// accounts+employees / orgs+people), with field renames and associations.
// Mirrors demo/examples/associations-demo/.
import type { ScenarioDefinition } from "./types.js";

const scenario: ScenarioDefinition = {
  label: "associations-demo",
  yaml: `
channels:
  - id: companies
    identity: [domain]
  - id: contacts
    identity: [email]


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

  - connector: hr
    entity: orgs
    channel: companies
    fields:
      - { source: orgName, target: name   }
      - { source: site,    target: domain }

  # ── Channel: contacts ─────────────────────────────────────────────────────
  - connector: crm
    entity: contacts
    channel: contacts
    fields:
      - { source: name,  target: name  }
      - { source: email, target: email }
    associations:
      - { source: companyId, target: companyRef }

  - connector: erp
    entity: employees
    channel: contacts
    fields:
      - { source: fullName, target: name  }
      - { source: email,    target: email }
    associations:
      - { source: orgId, target: companyRef }

  - connector: hr
    entity: people
    channel: contacts
    fields:
      - { source: displayName, target: name  }
      - { source: email,       target: email }
    associations:
      - { source: orgRef, target: companyRef }
`,
};

export default scenario;
