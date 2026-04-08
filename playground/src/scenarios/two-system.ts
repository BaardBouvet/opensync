// Scenario: two-system
// Two systems (system-a / system-b) syncing a single contacts channel.
// Mirrors demo/examples/two-system/.
import type { ScenarioDefinition } from "./types.js";

const scenario: ScenarioDefinition = {
  label: "two-system",
  yaml: `
channels:
  - id: contacts
    identityFields: [email]

conflict:
  strategy: lww

mappings:
  - connector: system-a
    entity: contacts
    channel: contacts

  - connector: system-b
    entity: contacts
    channel: contacts
`,
};

export default scenario;
