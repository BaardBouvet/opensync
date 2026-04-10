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

export const ConflictStrategySchema = z.enum(["field_master", "origin_wins"]);

const FieldStrategyEntrySchema = z.object({
  strategy: z.enum(["coalesce", "last_modified", "collect", "bool_or", "origin_wins"]),
});

// Reserved keys at the top level of a conflict: block (cannot be used as field names).
const CONFLICT_RESERVED = new Set(["strategy", "fieldMasters", "connectorPriorities"]);

/**
 * Conflict config schema. Spec: specs/channels.md §2.1.
 *
 * Field strategies are declared as direct keys under `conflict:` — no `fieldStrategies`
 * wrapper. Each field entry is an object starting with `strategy:` and may carry additional
 * metadata (description, type, …) in future versions.
 *
 * Reserved words (`strategy`, `fieldMasters`, `connectorPriorities`) cannot be used as
 * field names. All other keys are treated as per-field conflict config.
 *
 * The transform normalises the parsed flat representation into the internal ConflictConfig
 * shape (keeping `fieldStrategies` internally so engine + resolvers need not change).
 */
export const ConflictConfigSchema = z
  .record(z.string(), z.unknown())
  .superRefine((data, ctx) => {
    if ("strategy" in data && data.strategy !== undefined) {
      const r = ConflictStrategySchema.safeParse(data.strategy);
      if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `conflict.strategy: ${r.error.issues[0]?.message ?? "invalid"}` });
    }
    if ("fieldMasters" in data && data.fieldMasters !== undefined) {
      const r = z.record(z.string(), z.string()).safeParse(data.fieldMasters);
      if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `conflict.fieldMasters: ${r.error.issues[0]?.message ?? "invalid"}` });
    }
    if ("connectorPriorities" in data && data.connectorPriorities !== undefined) {
      const r = z.record(z.string(), z.number()).safeParse(data.connectorPriorities);
      if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `conflict.connectorPriorities: ${r.error.issues[0]?.message ?? "invalid"}` });
    }
    for (const [key, value] of Object.entries(data)) {
      if (CONFLICT_RESERVED.has(key)) continue;
      const r = FieldStrategyEntrySchema.safeParse(value);
      if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `conflict.${key}: expected { strategy: coalesce|last_modified|collect|bool_or|origin_wins }`, path: [key] });
    }
  })
  .transform((data) => {
    type FieldStrategy = { strategy: "coalesce" | "last_modified" | "collect" | "bool_or" | "origin_wins" };
    const result: {
      strategy?: "field_master" | "origin_wins";
      fieldMasters?: Record<string, string>;
      connectorPriorities?: Record<string, number>;
      fieldStrategies?: Record<string, FieldStrategy>;
    } = {};
    if (data.strategy !== undefined) result.strategy = data.strategy as "field_master" | "origin_wins";
    if (data.fieldMasters !== undefined) result.fieldMasters = data.fieldMasters as Record<string, string>;
    if (data.connectorPriorities !== undefined) result.connectorPriorities = data.connectorPriorities as Record<string, number>;
    const fieldEntries: Record<string, FieldStrategy> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!CONFLICT_RESERVED.has(key)) fieldEntries[key] = value as FieldStrategy;
    }
    if (Object.keys(fieldEntries).length > 0) result.fieldStrategies = fieldEntries;
    return result;
  });

export const IdentityGroupSchema = z.object({
  fields: z.array(z.string()).min(1),
});

// Spec: specs/agent-assistance.md §4.2 — one polymorphic key rather than two keys with a
// precedence rule. `string[]` is the shorthand (each string becomes its own OR group);
// `IdentityGroup[]` is the compound form (AND-within-group, OR-across-groups).
// A mixed array (some strings, some objects) is a schema error caught at parse time.
export const IdentitySchema = z.union([
  z.array(z.string()),
  z.array(IdentityGroupSchema),
]);

export const ChannelDefSchema = z.object({
  id: z.string(),
  identity: IdentitySchema.optional(),
  /** Spec: specs/field-mapping.md §8 — opt-in delete propagation (default: false). */
  propagateDeletes: z.boolean().optional(),
  /** Spec: specs/channels.md §2.1 — per-channel canonical field declarations.
   *  Each key is a canonical field name; the value is a field config entry (at minimum
   *  a `strategy:` for conflict resolution). Entries here apply only to this channel and
   *  take precedence over the global conflict: block for any matching field. */
  fields: ConflictConfigSchema.optional(),
});

export type IdentityGroup = z.infer<typeof IdentityGroupSchema>;

export const ChannelsYamlSchema = z.object({
  channels: z.array(ChannelDefSchema),
});

// ─── mappings/*.yaml — soft-delete field inspection ─────────────────────────

/** Spec: specs/field-mapping.md §8.2 */
export const SoftDeleteSchema = z.union([
  z.object({
    strategy: z.enum(["deleted_flag", "timestamp", "active_flag"]),
    field: z.string(),
  }),
  z.object({
    strategy: z.literal("expression"),
    expression: z.string(),
  }),
]);

// ─── mappings/*.yaml — field mappings ─────────────────────────────────────────

export const FieldDirectionSchema = z.enum(["bidirectional", "forward_only", "reverse_only"]);

const FieldMappingEntrySchemaBase = z.object({
  source: z.string().optional(),
  /** Spec: specs/field-mapping.md §1.7 — dotted JSON path within the source record.
   *  Mutually exclusive with `source`. Array-index tokens ([N]) are not allowed on
   *  non-forward_only fields (reverse write-back to a positional index is not supported). */
  source_path: z.string().optional(),
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
  /** Spec: specs/field-mapping.md §3.5 — when true, sort array elements before diff comparison.
   *  Suppresses false updates when source API returns same elements in different order. */
  sort_elements: z.boolean().optional(),
}).refine(
  (f) => !(f.source && f.source_path),
  { message: "source and source_path are mutually exclusive on a field mapping entry" },
).refine(
  (f) => {
    if (!f.source_path) return true;
    // Array-index write-back is not supported on the outbound (canonical→source) pass.
    // reverse_only runs only outbound; bidirectional runs both.
    // Only forward_only (inbound only, no write-back) is safe with array-index tokens.
    // Spec: specs/field-mapping.md §1.7
    if (f.direction === "forward_only") return true;
    return !/\[\d+\]/.test(f.source_path);
  },
  { message: "source_path with an array index ([N]) is only allowed on forward_only fields (array-index write-back is not supported)" },
);

// element_fields is self-referential, so define the full schema using z.lazy.
// TypeScript type annotation is required to break the inference cycle.
export type FieldMappingEntry = z.infer<typeof FieldMappingEntrySchemaBase> & {
  element_fields?: FieldMappingEntry[];
};

export const FieldMappingEntrySchema: z.ZodType<FieldMappingEntry> = FieldMappingEntrySchemaBase.extend({
  /** Spec: specs/field-mapping.md §3.5 — per-element field mappings applied to every element
   *  of this array field. Self-referential: supports arbitrarily deeply nested arrays.
   *  Mutually exclusive with array_path on the same mapping entry. */
  element_fields: z.lazy(() => z.array(FieldMappingEntrySchema)).optional(),
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
  // Deletion primitives (specs/field-mapping.md §8)
  /** Spec: specs/field-mapping.md §8.2 — soft-delete field inspection (flat members only). */
  soft_delete: SoftDeleteSchema.optional(),
  /** Spec: specs/field-mapping.md §8.3 — full-snapshot absence detection (flat members only). */
  full_snapshot: z.boolean().optional(),
}).refine(
  (e) => !(e.soft_delete && (e.array_path || e.parent)),
  { message: "soft_delete cannot be used on array expansion members (array_path or parent)" },
).refine(
  (e) => !(e.full_snapshot && (e.array_path || e.parent)),
  { message: "full_snapshot cannot be used on array expansion members (array_path or parent)" },
);

export const MappingsFileSchema = z.object({
  mappings: z.array(MappingEntrySchema).optional(),
  channels: z.array(ChannelDefSchema).optional(),
  conflict: ConflictConfigSchema.optional(),
});

export type MappingEntry = z.infer<typeof MappingEntrySchema>;
// FieldMappingEntry is declared above (self-referential type requires manual declaration).
export type AssocPredicateMappingEntry = z.infer<typeof AssocPredicateMappingSchema>;
export type ParentFieldRef = z.infer<typeof ParentFieldRefSchema>;
export type SoftDeleteEntry = z.infer<typeof SoftDeleteSchema>;
// Note: ConflictConfig interface lives in loader.ts; ConflictConfigSchema is the Zod validator.
