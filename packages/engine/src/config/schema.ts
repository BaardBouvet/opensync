// Spec: specs/config.md — Zod schemas for opensync.json and mappings/*.yaml
import { z } from "zod";

// ─── opensync.json ────────────────────────────────────────────────────────────

export const ConnectorEntrySchema = z.object({
  /** npm package name or relative path to a local TypeScript file */
  plugin: z.string(),
  /** Connector-specific config. ${VAR} interpolation applied to string values. */
  config: z.record(z.string(), z.unknown()).default({}),
  /**
   * Auth credentials. Merged into config before being passed to the engine so the engine
   * auth layer can find apiKey / clientId / clientSecret at the top level of config.
   * Kept separate in opensync.json for clarity.
   */
  auth: z.record(z.string(), z.unknown()).optional(),
});

export const OpenSyncJsonSchema = z.object({
  connectors: z.record(z.string(), ConnectorEntrySchema),
});

export type OpenSyncJson = z.infer<typeof OpenSyncJsonSchema>;
export type ConnectorEntry = z.infer<typeof ConnectorEntrySchema>;

// ─── mappings/*.yaml — channel definitions ────────────────────────────────────

export const ConflictStrategySchema = z.enum(["lww", "field_master", "origin_wins"]);

export const ConflictConfigSchema = z.object({
  strategy: ConflictStrategySchema,
  fieldMasters: z.record(z.string(), z.string()).optional(),
  connectorPriorities: z.record(z.string(), z.number()).optional(),
  fieldStrategies: z.record(
    z.string(),
    z.object({ strategy: z.enum(["coalesce", "last_modified", "collect", "bool_or", "origin_wins"]) }),
  ).optional(),
});

export const IdentityGroupSchema = z.object({
  fields: z.array(z.string()).min(1),
});

export const ChannelDefSchema = z.object({
  id: z.string(),
  identityFields: z.array(z.string()).optional(),
  identityGroups: z.array(IdentityGroupSchema).optional(),
  conflict_resolution: ConflictStrategySchema.optional(),
});

export type IdentityGroup = z.infer<typeof IdentityGroupSchema>;

export const ChannelsYamlSchema = z.object({
  channels: z.array(ChannelDefSchema),
});

// ─── mappings/*.yaml — field mappings ─────────────────────────────────────────

export const FieldDirectionSchema = z.enum(["bidirectional", "forward_only", "reverse_only"]);

export const FieldMappingEntrySchema = z.object({
  source: z.string().optional(),
  target: z.string(),
  direction: FieldDirectionSchema.optional(),
  /** Spec: specs/field-mapping.md §1.6 */
  reverseRequired: z.boolean().optional(),
  /** Spec: specs/field-mapping.md §1.5 */
  default: z.unknown().optional(),
  /** Spec: specs/field-mapping.md §1.8 */
  group: z.string().optional(),
  /** Spec: specs/field-mapping.md §1.3 — connector-side fields read by expression.
   *  Declared for lineage; without this the diagram shows (expression) placeholder. */
  sources: z.array(z.string()).optional(),
  /** Spec: specs/field-mapping.md §1.3 — JS expression string compiled via new Function.
   *  Receives `record` (full incoming record); return value assigned to `target`.
   *  When present, `source` is ignored on the forward pass. */
  expression: z.string().optional(),
  /** Spec: specs/field-mapping.md §1.3 — JS expression string compiled via new Function.
   *  Receives `record` (full canonical record); return value assigned to `source ?? target`,
   *  or if an object is returned, keys are spread into multiple source fields. */
  reverse_expression: z.string().optional(),
  /** Spec: specs/field-mapping.md §1.4 — JS expression string compiled via new Function.
   *  Receives `v` (the field value); return value is the normalized form used only for diff. */
  normalize: z.string().optional(),
  /** Spec: specs/field-mapping.md §2.3 — JS expression string compiled via new Function.
   *  Receives `incoming` and `existing`; returns the new canonical value.
   *  Takes precedence over fieldStrategies / global strategy. */
  resolve: z.string().optional(),
});

export const AssocPredicateMappingSchema = z.object({
  source: z.string(),   // connector-local predicate name
  target: z.string(),   // canonical predicate name (routing key only; never stored)
});

// Spec: specs/field-mapping.md §3.2 — parent_fields value: string shorthand or { path?, field } object
export const ParentFieldRefSchema = z.union([
  z.string(),
  z.object({ path: z.string().optional(), field: z.string() }),
]);

export const MappingEntrySchema = z.object({
  connector: z.string().optional(),   // optional on child mappings (inherited from parent)
  channel: z.string(),
  entity: z.string().optional(),      // optional on same-channel child mappings (source descriptors omit it)
  fields: z.array(FieldMappingEntrySchema).optional(),
  associations: z.array(AssocPredicateMappingSchema).optional(),
  // Array expansion keys (specs/field-mapping.md §3.2)
  name: z.string().optional(),        // stable identifier; required when referenced as parent
  parent: z.string().optional(),      // name of parent mapping entry; inherits connector + read source
  array_path: z.string().optional(),  // dotted path to array column; required when parent is set
  parent_fields: z.record(z.string(), ParentFieldRefSchema).optional(),
  element_key: z.string().optional(), // element field for stable identity; falls back to index
  // Element filters (plans/engine/PLAN_ELEMENT_FILTER.md)
  filter: z.string().optional(),         // JS expression string — forward pass element filter
  reverse_filter: z.string().optional(), // JS expression string — reverse pass element filter
  // PK-as-field injection (specs/field-mapping.md §4.1)
  id_field: z.string().optional(),       // when set, inject record.id into stripped data under this name before mapping
  // Scalar array expansion (specs/field-mapping.md §3.3)
  scalar: z.boolean().optional(),        // when true, elements are bare scalars; mutually exclusive with element_key
  // Array ordering (specs/field-mapping.md §6)
  order_by: z.array(z.object({
    field: z.string(),
    direction: z.enum(["asc", "desc"]).default("asc"),
  })).optional(),
  order: z.boolean().optional(),
  order_linked_list: z.boolean().optional(),
});

export const MappingsFileSchema = z.object({
  mappings: z.array(MappingEntrySchema).optional(),
  channels: z.array(ChannelDefSchema).optional(),
  conflict: ConflictConfigSchema.optional(),
});

export type MappingEntry = z.infer<typeof MappingEntrySchema>;
export type FieldMappingEntry = z.infer<typeof FieldMappingEntrySchema>;
export type AssocPredicateMappingEntry = z.infer<typeof AssocPredicateMappingSchema>;
export type ParentFieldRef = z.infer<typeof ParentFieldRefSchema>;
// Note: ConflictConfig interface lives in loader.ts; ConflictConfigSchema is the Zod validator.
