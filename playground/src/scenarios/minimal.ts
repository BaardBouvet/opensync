// Scenario: minimal
// Two systems (crm / erp), single channel (companies ↔ accounts) with field
// renames.  The simplest possible sync: one channel, one identity field, two
// field renames.  Great for understanding the basics before the full demo.
import type { ScenarioDefinition } from "./types.js";

const scenario: ScenarioDefinition = {
  label: "minimal (crm ↔ erp, companies)",
  yaml: `
channels:
  - id: companies
    identityFields: [domain]

conflict:
  strategy: lww

mappings:
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
`,
};

export default scenario;
