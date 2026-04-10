// Scenario: two-system
// Two systems (system-a / system-b) syncing a single contacts channel.
// Mirrors demo/examples/two-system/.
import type { ScenarioDefinition } from "./types.js";

const scenario: ScenarioDefinition = {
  label: "two-system",
  yaml: `
channels:
  - id: contacts
    identity: [email]


mappings:
  - connector: system-a
    entity: contacts
    channel: contacts
    fields:
      - name
      - email

  - connector: system-b
    entity: contacts
    channel: contacts
    fields:
      - name
      - email
`,
};

export default scenario;
