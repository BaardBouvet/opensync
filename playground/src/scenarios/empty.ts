// Scenario: empty
// No channels, no mappings. Every connector entity appears in the lineage
// "unassigned" pool — the ideal starting point when designing a config from
// scratch. The engine boots but does no cross-system sync until the user adds
// at least one channel + two connector members.
import type { ScenarioDefinition } from "./types.js";

const scenario: ScenarioDefinition = {
  label: "empty (blank canvas)",
  yaml: `
channels: []

mappings: []
`,
};

export default scenario;
