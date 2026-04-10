// Scenario: three-system
// Three systems (system-a / system-b / system-c) syncing a single contacts channel.
// Mirrors demo/examples/three-system/.
import type { ScenarioDefinition } from "./types.js";

const scenario: ScenarioDefinition = {
  label: "three-system",
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

  - connector: system-c
    entity: contacts
    channel: contacts
    fields:
      - name
      - email
`,
};

export default scenario;
