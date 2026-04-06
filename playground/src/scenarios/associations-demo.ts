// Scenario: associations-demo
// Three systems (crm / erp / hr) × two entities each (companies+contacts /
// accounts+employees / orgs+people), with field renames and associations.
// Mirrors demo/examples/associations-demo/.
import type { ScenarioDefinition } from "./types.js";

const scenario: ScenarioDefinition = {
  label: "associations-demo",
  channels: [
    {
      id: "companies",
      identityFields: ["domain"],
      members: [
        {
          connectorId: "crm",
          entity: "companies",
          inbound: [
            { source: "name",   target: "name" },
            { source: "domain", target: "domain" },
          ],
          outbound: [
            { source: "name",   target: "name" },
            { source: "domain", target: "domain" },
          ],
        },
        {
          connectorId: "erp",
          entity: "accounts",
          inbound: [
            { source: "accountName", target: "name" },
            { source: "website",     target: "domain" },
          ],
          outbound: [
            { source: "accountName", target: "name" },
            { source: "website",     target: "domain" },
          ],
        },
        {
          connectorId: "hr",
          entity: "orgs",
          inbound: [
            { source: "orgName", target: "name" },
            { source: "site",    target: "domain" },
          ],
          outbound: [
            { source: "orgName", target: "name" },
            { source: "site",    target: "domain" },
          ],
        },
      ],
    },
    {
      id: "contacts",
      identityFields: ["email"],
      members: [
        {
          connectorId: "crm",
          entity: "contacts",
          inbound: [
            { source: "name",  target: "name" },
            { source: "email", target: "email" },
          ],
          outbound: [
            { source: "name",  target: "name" },
            { source: "email", target: "email" },
          ],
        },
        {
          connectorId: "erp",
          entity: "employees",
          inbound: [
            { source: "fullName", target: "name" },
            { source: "email",    target: "email" },
          ],
          outbound: [
            { source: "fullName", target: "name" },
            { source: "email",    target: "email" },
          ],
        },
        {
          connectorId: "hr",
          entity: "people",
          inbound: [
            { source: "displayName", target: "name" },
            { source: "email",       target: "email" },
          ],
          outbound: [
            { source: "displayName", target: "name" },
            { source: "email",       target: "email" },
          ],
        },
      ],
    },
  ],
  conflict: { strategy: "lww" },
};

export default scenario;
