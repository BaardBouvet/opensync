// Shared scenario type used by all bundled scenario modules.
// Connectors and seed data are fixed (see lib/systems.ts); scenarios define
// only channels and conflict strategy.
import type { ChannelConfig, ConflictConfig } from "@opensync/engine";

export interface ScenarioDefinition {
  /** Display name shown in the dropdown. */
  label: string;
  /** Channel and mapping config, equivalent to the mappings/*.yaml files. */
  channels: ChannelConfig[];
  conflict: ConflictConfig;
}
