// Scenario: three-system
// Three systems (system-a / system-b / system-c) syncing a single contacts channel.
// Mirrors demo/examples/three-system/.
import type { ScenarioDefinition } from "./types.js";

const scenario: ScenarioDefinition = {
  label: "three-system",
  channels: [
    {
      id: "contacts",
      identityFields: ["email"],
      members: [
        { connectorId: "system-a", entity: "contacts" },
        { connectorId: "system-b", entity: "contacts" },
        { connectorId: "system-c", entity: "contacts" },
      ],
    },
  ],
  conflict: { strategy: "lww" },
};

export default scenario;
