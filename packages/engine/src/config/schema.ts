// Spec: specs/config.md — Zod schemas for opensync.json and mappings/*.yaml
import { z } from "zod";

// ─── opensync.json ────────────────────────────────────────────────────────────

export const ConnectorEntrySchema = z.object({
  /** npm package name or relative path to a local TypeScript file */
  plugin: z.string(),
  /** Connector-specific config. ${VAR} interpolation applied to string values. */
  config: z.record(z.string(), z.unknown()).default({}),
});

export const OpenSyncJsonSchema = z.object({
  connectors: z.record(z.string(), ConnectorEntrySchema),
});

export type OpenSyncJson = z.infer<typeof OpenSyncJsonSchema>;
export type ConnectorEntry = z.infer<typeof ConnectorEntrySchema>;

// ─── mappings/*.yaml — channel definitions ────────────────────────────────────

export const ConflictStrategySchema = z.enum(["lww", "field_master"]);

export const ChannelDefSchema = z.object({
  id: z.string(),
  identityFields: z.array(z.string()).optional(),
  conflict_resolution: ConflictStrategySchema.optional(),
});

export const ChannelsYamlSchema = z.object({
  channels: z.array(ChannelDefSchema),
});

// ─── mappings/*.yaml — field mappings ─────────────────────────────────────────

export const FieldDirectionSchema = z.enum(["bidirectional", "forward_only", "reverse_only"]);

export const FieldMappingEntrySchema = z.object({
  source: z.string().optional(),
  target: z.string(),
  direction: FieldDirectionSchema.optional(),
});

export const MappingEntrySchema = z.object({
  connector: z.string(),
  channel: z.string(),
  entity: z.string(),
  fields: z.array(FieldMappingEntrySchema).optional(),
});

export const MappingsFileSchema = z.object({
  mappings: z.array(MappingEntrySchema).optional(),
  channels: z.array(ChannelDefSchema).optional(),
});

export type MappingEntry = z.infer<typeof MappingEntrySchema>;
export type FieldMappingEntry = z.infer<typeof FieldMappingEntrySchema>;
