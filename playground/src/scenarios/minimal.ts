// Scenario: minimal
// Two systems (crm / erp), single channel (companies ↔ accounts) with field
// renames.  The simplest possible sync: one channel, one identity field, two
// field renames.  Great for understanding the basics before the full demo.
import type { ScenarioDefinition } from "./types.js";

const scenario: ScenarioDefinition = {
  label: "minimal (crm ↔ erp, companies)",
  channels: [
    {
      id: "companies",
      identityFields: ["domain"],
      members: [
        {
          connectorId: "crm",
          entity: "companies",
          inbound: [
            { source: "name",   target: "name"   },
            { source: "domain", target: "domain" },
          ],
          outbound: [
            { source: "name",   target: "name"   },
            { source: "domain", target: "domain" },
          ],
        },
        {
          connectorId: "erp",
          entity: "accounts",
          inbound: [
            { source: "accountName", target: "name"   },
            { source: "website",     target: "domain" },
          ],
          outbound: [
            { source: "accountName", target: "name"   },
            { source: "website",     target: "domain" },
          ],
        },
      ],
    },
  ],
  conflict: { strategy: "lww" },
};

export default scenario;
