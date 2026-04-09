// Scenario registry — the UI dropdown reads this; adding a new scenario only
// requires adding one module and one entry here.
import type { ScenarioDefinition } from "./types.js";
import associationsDemo from "./associations-demo.js";
import assocCardinality from "./assoc-cardinality.js";
import arrayDemo from "./array-demo.js";
import minimal from "./minimal.js";
import empty from "./empty.js";

export type { ScenarioDefinition };

export const scenarios: Record<string, ScenarioDefinition> = {
  "associations-demo": associationsDemo,
  "assoc-cardinality": assocCardinality,
  "array-demo": arrayDemo,
  "minimal": minimal,
  "empty": empty,
};

export const defaultScenarioKey = "associations-demo";
