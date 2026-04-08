// Shared scenario type used by all bundled scenario modules.
// Connectors and seed data are fixed (see lib/systems.ts); scenarios define
// only channels, mappings, and conflict strategy — as canonical YAML.
// Spec: specs/playground.md §3.1

export interface ScenarioDefinition {
  /** Display name shown in the dropdown. */
  label: string;
  /**
   * Canonical YAML string: `channels:` + `mappings:` + optional `conflict:` blocks.
   * Parsed at engine boot time via MappingsFileSchema + buildChannelsFromEntries.
   * This is the source of truth — the editor pane displays and edits this string directly.
   * Spec: specs/playground.md §3.4
   */
  yaml: string;
}
