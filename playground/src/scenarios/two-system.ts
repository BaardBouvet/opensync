// Scenario: two-system
// Two systems (system-a / system-b) syncing a single contacts channel.
// Mirrors demo/examples/two-system/.
import type { ScenarioDefinition } from "./types.js";

const scenario: ScenarioDefinition = {
  label: "two-system",
  channels: [
    {
      id: "contacts",
      identityFields: ["email"],
      members: [
        { connectorId: "system-a", entity: "contacts" },
        { connectorId: "system-b", entity: "contacts" },
      ],
    },
  ],
  conflict: { strategy: "lww" },
};

export default scenario;
