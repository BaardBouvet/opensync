// Spec: specs/config.md — load and resolve config from the project root directory
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { load as yamlLoad } from "js-yaml";
import {
  OpenSyncJsonSchema,
  MappingsFileSchema,
  type MappingEntry,
  type FieldMappingEntry,
  type IdentityGroup,
  type ParentFieldRef,
} from "./schema.js";
export type { IdentityGroup } from "./schema.js";
import type {
  Connector,
  ConnectorContext,
  EntityDefinition,
} from "@opensync/sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FieldMapping {
  source?: string;
  target: string;
  direction?: "bidirectional" | "forward_only" | "reverse_only";
  /** Forward pass (source → canonical).
   *  Receives the full incoming record data; returns the value for `target`.
   *  When present, `source` is ignored — the expression sees all fields. */
  expression?: (record: Record<string, unknown>) => unknown;
  /** Reverse pass (canonical → source).
   *  Receives the full canonical record.
   *  Return a plain object to decompose into multiple source fields;
   *  return any other value to assign to `source ?? target`. */
  reverseExpression?: (record: Record<string, unknown>) => unknown;
  /** Applied to both the incoming value and the stored shadow value before the noop diff
   *  check. If normalize(incoming) === normalize(shadow), the field is a noop even when raw
   *  strings differ. Also prevents lower-fidelity sources from winning resolution when their
   *  normalized value matches the canonical.
   *  Spec: specs/field-mapping.md §1.4 */
  normalize?: (v: unknown) => unknown;
  /** When true, the entire dispatched row is suppressed if this field's value is null
   *  or absent in the outbound-mapped record. No written_state row is written.
   *  Spec: specs/field-mapping.md §1.6 */
  reverseRequired?: boolean;
  /** Static fallback applied during the forward (inbound) pass when the source field is
   *  absent or null. Applied before resolution. Mutually exclusive with defaultExpression.
   *  Spec: specs/field-mapping.md §1.5 */
  default?: unknown;
  /** Dynamic fallback applied during the forward (inbound) pass when the source field is
   *  absent or null. Receives the partially-built canonical record (fields processed so far).
   *  Mutually exclusive with default.
   *  Spec: specs/field-mapping.md §1.5 */
  defaultExpression?: (record: Record<string, unknown>) => unknown;
  /** Atomic resolution group label. All fields sharing the same label resolve from the same
   *  winning source, preventing incoherent field mixes (e.g. address parts from different sources).
   *  Spec: specs/field-mapping.md §1.8 */
  group?: string;
  /** Connector-side field names read by `expression`. Declared for lineage: when present,
   *  `buildChannelLineage` emits one ConnectorFieldNode per source (fan-in arrow). When absent
   *  and expression is set, the diagram shows an `(expression)` placeholder pill.
   *  Spec: specs/field-mapping.md §1.3 */
  sources?: string[];
  /** Resolution-time incremental reducer (TypeScript embedded API only — not serialisable to YAML).
   *  Called instead of fieldStrategies / global strategy when present.
   *  Runs after the group pre-pass and normalize precision-loss guard.
   *  @param incoming The value arriving from the current source.
   *  @param existing The current canonical value (previous winner). `undefined` on first ingest.
   *  @returns The new canonical value to store.
   *  Spec: specs/field-mapping.md §2.3 */
  resolve?: (incoming: unknown, existing: unknown | undefined) => unknown;
}

export type FieldMappingList = FieldMapping[];

/** Spec: plans/engine/PLAN_PREDICATE_MAPPING.md §2.2
 * Maps a connector-local association predicate to a canonical name.
 * Absent assocMappings on a ChannelMember → no associations forwarded. */
export interface AssocPredicateMapping {
  source: string;   // connector-local predicate name
  target: string;   // canonical predicate name (routing key; never stored)
}

// Spec: specs/field-mapping.md §3.4 — one level in a multi-level expansion chain.
export interface ExpansionChainLevel {
  arrayPath: string;
  elementKey?: string;
  parentFields?: Record<string, string | { path?: string; field: string }>;
  /** Spec: specs/field-mapping.md §3.3 — elements are bare scalars, not objects. */
  scalar?: boolean;
  // Spec: specs/field-mapping.md §6 — ordering (leaf level only)
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  crdtOrder?: boolean;
  crdtLinkedList?: boolean;
}

export interface ChannelMember {
  name?: string;               // optional stable identifier; used by child parent references
  connectorId: string;
  entity: string;              // logical entity name for this channel (watermarks + shadow state keys)
  /** When set, connector.read() is called with this entity name instead of `entity`.
   * Present on array child members that inherit their read source from a parent mapping.
   * Spec: specs/field-mapping.md §3.2 */
  sourceEntity?: string;
  inbound?: FieldMappingList;
  outbound?: FieldMappingList;
  /** Spec: plans/engine/PLAN_PREDICATE_MAPPING.md §2.2 — declared association predicates.
   * Absent → no associations forwarded from/to this connector. */
  assocMappings?: AssocPredicateMapping[];  /** When set, inject `record.id` into the stripped data map under this field name
   *  before `applyMapping` runs. Use only when the connector does not include its own
   *  PK in `record.data`. Spec: specs/field-mapping.md §4.1 */
  idField?: string;  // Spec: specs/field-mapping.md §3.2/§3.4 — nested array expansion fields
  arrayPath?: string;          // leaf-level dotted path (leaf of expansionChain)
  parentMappingName?: string;  // name of the parent mapping entry (resolved from `parent` key)
  parentFields?: Record<string, ParentFieldRef>;  // leaf-level parent fields
  elementKey?: string;         // leaf-level element key field; absent = use index
  /** Spec: specs/field-mapping.md §3.4 — full ordered chain from outermost to leaf.
   * Length 1 = single-level (§3.2). Length > 1 = multi-level (§3.4).
   * Present on all members that have arrayPath. */
  expansionChain?: ExpansionChainLevel[];
  /** Spec: plans/engine/PLAN_ELEMENT_FILTER.md §3.2 — forward filter.
   * When set, only elements for which this returns true are claimed (expanded + dispatched). */
  elementFilter?: (element: unknown, parent: unknown, index: number) => boolean;
  /** Spec: plans/engine/PLAN_ELEMENT_FILTER.md §3.3 — reverse filter.
   * When set, collapse patches are only applied to elements for which this returns true. */
  elementReverseFilter?: (element: unknown, parent: unknown, index: number) => boolean;
  /** Spec: specs/field-mapping.md §3.3 — scalar array mode.
   * When true, elements at arrayPath are bare scalars. Each value is wrapped as { _value: element }.
   * Mutually exclusive with elementKey at config-load time. */
  scalar?: boolean;
  // Spec: specs/field-mapping.md §6 — ordering (leaf level only; applied during collapse)
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  crdtOrder?: boolean;
  crdtLinkedList?: boolean;
  /** Spec: specs/field-mapping.md §5.1 — forward record filter (flat members only).
   * When set, only source records for which this returns true contribute to resolution.
   * Records that previously matched but now fail are treated as soft-delete contributions
   * (shadow cleared). Not present on array expansion members (those use elementFilter). */
  recordFilter?: (record: Record<string, unknown>) => boolean;
  /** Spec: specs/field-mapping.md §5.2 — reverse record filter (flat members only).
   * When set, canonical entities for which this returns false are skipped for this connector.
   * No written_state row is written. Not present on array expansion members. */
  recordReverseFilter?: (record: Record<string, unknown>) => boolean;
}

export interface ChannelConfig {
  id: string;
  members: ChannelMember[];
  /** Spec: specs/agent-assistance.md §4.3 — single polymorphic key.
   * `string[]` shorthand: each string is its own OR group.
   * `IdentityGroup[]` compound form: AND-within-group, OR-across-groups.
   * Normalised to IdentityGroup[] inside _resolveGroups before use. */
  identity?: string[] | IdentityGroup[];
}

/** A resolved connector instance — plugin loaded, context wired, entities retrieved. */
export interface ConnectorInstance {
  id: string;
  connector: Connector;
  config: Record<string, unknown>;
  /**
   * Auth credentials resolved from the `auth:` key in opensync.json.
   * Kept separate from config so connector-specific config keys never
   * collide with credential names. The engine auth layer reads from here;
   * connectors never see credentials directly.
   */
  auth: Record<string, unknown>;
  /** Mutated by the engine to carry the current batch_id for request journal correlation. */
  batchIdRef: { current: string | undefined };
  /** Mutated to carry the current journal trigger. */
  triggerRef: { current: "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh" | undefined };
}

export interface ConflictConfig {
  strategy?: "field_master" | "origin_wins";
  fieldMasters?: Record<string, string>;
  connectorPriorities?: Record<string, number>;
  fieldStrategies?: Record<string, { strategy: "coalesce" | "last_modified" | "collect" | "bool_or" | "origin_wins" }>;
}

export interface ResolvedConfig {
  connectors: ConnectorInstance[];
  channels: ChannelConfig[];
  conflict: ConflictConfig;
  readTimeoutMs: number;
}

// ─── loadConfig ───────────────────────────────────────────────────────────────

// Spec: specs/config.md §CLI Discovery
export async function loadConfig(rootDir: string): Promise<ResolvedConfig> {
  const root = isAbsolute(rootDir) ? rootDir : resolve(process.cwd(), rootDir);

  // 1. Load + validate opensync.json
  const jsonPath = join(root, "opensync.json");
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read ${jsonPath}: ${String(err)}`);
  }
  const parsed = OpenSyncJsonSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(`Invalid opensync.json: ${parsed.error.message}`);
  }
  const openSyncJson = parsed.data;

  // 2. Load + merge all mapping files in mappings/ alphabetically
  const mappingsDir = join(root, "mappings");
  let mappingFiles: string[] = [];
  try {
    mappingFiles = readdirSync(mappingsDir)
      .filter((f) => /\.(ya?ml|json)$/.test(f))
      .sort()
      .map((f) => join(mappingsDir, f));
  } catch {
    // mappings/ is optional if no channels are configured
  }

  const allChannelDefs: Array<{ id: string; identityFields?: string[]; identityGroups?: IdentityGroup[] }> = [];
  const allMappingEntries: MappingEntry[] = [];

  for (const filePath of mappingFiles) {
    let raw: unknown;
    try {
      const content = readFileSync(filePath, "utf8");
      raw = filePath.endsWith(".json") ? JSON.parse(content) : yamlLoad(content);
    } catch (err) {
      throw new Error(`Cannot read mapping file ${filePath}: ${String(err)}`);
    }

    const result = MappingsFileSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`Invalid mapping file ${filePath}: ${result.error.message}`);
    }

    if (result.data.channels) {
      for (const ch of result.data.channels) {
        allChannelDefs.push({ id: ch.id, identityFields: ch.identityFields, identityGroups: ch.identityGroups });
      }
    }
    if (result.data.mappings) {
      allMappingEntries.push(...result.data.mappings);
    }
  }

  // 3. Build ChannelConfig list
  const channels = buildChannelsFromEntries(allChannelDefs, allMappingEntries);

  // 4. Load connector plugins and resolve env-var interpolation
  const connectorInstances: ConnectorInstance[] = [];

  for (const [connectorId, entry] of Object.entries(openSyncJson.connectors)) {
    const resolvedConfig = resolveEnvVars(entry.config, root);
    const resolvedAuth = entry.auth ? resolveEnvVars(entry.auth, root) : {};

    // Load the plugin
    let connector: Connector;
    try {
      const pluginPath = entry.plugin.startsWith(".")
        ? resolve(root, entry.plugin)
        : entry.plugin;
      const mod = (await import(pluginPath)) as { default?: Connector };
      if (!mod.default || typeof mod.default !== "object") {
        throw new Error(`Plugin "${entry.plugin}" does not export a default Connector object`);
      }
      connector = mod.default;
    } catch (err) {
      throw new Error(`Failed to load connector plugin "${entry.plugin}" for "${connectorId}": ${String(err)}`);
    }

    connectorInstances.push({
      id: connectorId,
      connector,
      config: resolvedConfig,
      auth: resolvedAuth,
      batchIdRef: { current: undefined },
      triggerRef: { current: undefined },
    });
  }

  return {
    connectors: connectorInstances,
    channels,
    conflict: {},
    readTimeoutMs: 30_000,
  };
}

// ─── buildChannelsFromEntries ─────────────────────────────────────────────────
// Spec: specs/config.md — pure channel builder used by both loadConfig() and
// the browser playground (which parses YAML directly, without file I/O).

export function buildChannelsFromEntries(
  channelDefs: Array<{ id: string; identity?: string[] | IdentityGroup[] }>,
  mappingEntries: MappingEntry[],
): ChannelConfig[] {
  // Spec: specs/field-mapping.md §3.2 — build a global index of named mappings so
  // child entries can resolve their parent and inherit connectorId + sourceEntity.
  const namedMappings = new Map<string, MappingEntry>();
  for (const entry of mappingEntries) {
    if (entry.name) {
      if (namedMappings.has(entry.name)) {
        throw new Error(`Duplicate mapping name "${entry.name}": mapping names must be unique across all mapping files`);
      }
      namedMappings.set(entry.name, entry);
    }
  }

  // Spec: specs/field-mapping.md §3.4 — validate no cycles in parent chains before
  // any further processing (cycles are not detectable after descriptor exclusion).
  for (const [name, entry] of namedMappings) {
    const seen = new Set<string>([name]);
    let cursor: MappingEntry | undefined = entry;
    while (cursor?.parent) {
      if (seen.has(cursor.parent)) {
        throw new Error(`Cycle detected in parent chain at "${cursor.parent}"`);
      }
      seen.add(cursor.parent);
      cursor = namedMappings.get(cursor.parent);
    }
  }

  // Determine which named entries are same-channel source descriptors — i.e. named entries
  // that are referenced as `parent` by another entry in the SAME channel.
  // Source descriptors live in namedMappings only; they are NOT added as channel members.
  const sameChannelDescriptors = new Set<string>();
  for (const entry of mappingEntries) {
    if (entry.parent) {
      const parentEntry = namedMappings.get(entry.parent);
      if (parentEntry && parentEntry.channel === entry.channel) {
        sameChannelDescriptors.add(entry.parent);
      }
    }
  }

  const channelMap = new Map<string, ChannelConfig>();

  for (const chDef of channelDefs) {
    channelMap.set(chDef.id, {
      id: chDef.id,
      members: [],
      identity: chDef.identity,
    });
  }

  for (const entry of mappingEntries) {
    // Spec: specs/field-mapping.md §3.2 — skip same-channel source descriptors.
    if (entry.name && sameChannelDescriptors.has(entry.name)) {
      continue;
    }

    if (!channelMap.has(entry.channel)) {
      channelMap.set(entry.channel, { id: entry.channel, members: [] });
    }
    const ch = channelMap.get(entry.channel)!;

    let resolvedConnectorId = entry.connector;
    let resolvedSourceEntity: string | undefined;
    let resolvedEntity = entry.entity ?? "";
    let expansionChain: ExpansionChainLevel[] | undefined;

    if (entry.parent) {
      if (!entry.array_path) {
        throw new Error(`Mapping entry in channel "${entry.channel}" with parent "${entry.parent}" must declare array_path`);
      }
      if (entry.scalar && entry.element_key) {
        throw new Error(`Mapping in channel "${entry.channel}" with scalar: true must not declare element_key`);
      }
      const orderCount = [entry.order_by, entry.order, entry.order_linked_list].filter(Boolean).length;
      if (orderCount > 1) {
        throw new Error(`Mapping in channel "${entry.channel}" specifies more than one ordering method (order_by, order, order_linked_list); only one is allowed`);
      }
      const chainResult = resolveExpansionChain(entry, namedMappings);
      resolvedConnectorId = entry.connector ?? chainResult.connectorId;
      if (!resolvedConnectorId) {
        throw new Error(`Cannot resolve connectorId for child mapping in channel "${entry.channel}" with parent "${entry.parent}"`);
      }
      resolvedSourceEntity = chainResult.sourceEntity;
      resolvedEntity = entry.entity ?? `${chainResult.sourceEntity}/${entry.array_path}`;
      expansionChain = chainResult.chain;
    } else {
      if (!resolvedConnectorId) {
        throw new Error(`Mapping entry in channel "${entry.channel}" must declare a connector`);
      }
      if (!entry.entity) {
        throw new Error(`Mapping entry for connector "${resolvedConnectorId}" in channel "${entry.channel}" must declare an entity`);
      }
    }

    const inbound = entry.fields ? buildInbound(entry.fields) : undefined;
    const outbound = entry.fields ? buildOutbound(entry.fields) : undefined;

    const isArrayMember = !!(entry.array_path || entry.parent);

    const elementFilter = isArrayMember && entry.filter
      ? compileElementFilter(entry.filter, entry.channel)
      : undefined;
    const elementReverseFilter = isArrayMember && entry.reverse_filter
      ? compileElementFilter(entry.reverse_filter, entry.channel)
      : undefined;

    const recordFilter = !isArrayMember && entry.filter
      ? compileRecordFilter(entry.filter, entry.channel)
      : undefined;
    const recordReverseFilter = !isArrayMember && entry.reverse_filter
      ? compileRecordFilter(entry.reverse_filter, entry.channel)
      : undefined;

    ch.members.push({
      name: entry.name,
      connectorId: resolvedConnectorId!,
      entity: resolvedEntity,
      sourceEntity: resolvedSourceEntity,
      inbound,
      outbound,
      assocMappings: entry.associations,
      idField: entry.id_field,
      arrayPath: entry.array_path,
      parentMappingName: entry.parent,
      parentFields: entry.parent_fields as Record<string, string | { path?: string; field: string }> | undefined,
      elementKey: entry.element_key,
      expansionChain,
      scalar: entry.scalar,
      orderBy: entry.order_by as Array<{ field: string; direction: "asc" | "desc" }> | undefined,
      crdtOrder: entry.order ?? undefined,
      crdtLinkedList: entry.order_linked_list ?? undefined,
      elementFilter,
      elementReverseFilter,
      recordFilter,
      recordReverseFilter,
    });
  }

  return Array.from(channelMap.values());
}

// ─── resolveExpansionChain ───────────────────────────────────────────────────
// Spec: specs/field-mapping.md §3.4 — walk the full parent chain transitively,
// collecting one ExpansionChainLevel per hop (outermost first after reversal).

function resolveExpansionChain(
  entry: MappingEntry,
  namedMappings: Map<string, MappingEntry>,
): { sourceEntity: string; connectorId: string; chain: ExpansionChainLevel[] } {
  const chain: ExpansionChainLevel[] = [];
  const seen = new Set<string>();
  let cursor: MappingEntry = entry;

  while (cursor.parent) {
    const parentName = cursor.parent;
    if (seen.has(parentName)) {
      throw new Error(`Cycle detected in parent chain at "${parentName}"`);
    }
    seen.add(parentName);
    const parentEntry = namedMappings.get(parentName);
    if (!parentEntry) {
      throw new Error(`Mapping entry references unknown parent "${parentName}"`);
    }
    // Cross-connector check at each hop
    if (cursor.connector && parentEntry.connector && cursor.connector !== parentEntry.connector) {
      throw new Error(
        `Mapping entry with parent "${parentName}" declares connector "${cursor.connector}" ` +
        `but parent has connector "${parentEntry.connector}". Cross-connector inheritance is not supported.`,
      );
    }
    chain.push({
      arrayPath: cursor.array_path!,
      elementKey: cursor.element_key,
      parentFields: cursor.parent_fields as Record<string, string | { path?: string; field: string }> | undefined,
      scalar: cursor.scalar,
      orderBy: cursor.order_by as Array<{ field: string; direction: "asc" | "desc" }> | undefined,
      crdtOrder: cursor.order ?? undefined,
      crdtLinkedList: cursor.order_linked_list ?? undefined,
    });
    cursor = parentEntry;
  }
  // cursor is now the root (no parent) — its connector and entity are the read source
  chain.reverse(); // outermost first
  return {
    sourceEntity: cursor.entity ?? "",
    connectorId: cursor.connector ?? "",
    chain,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildInbound(fields: FieldMappingEntry[]): FieldMappingList {
  return fields.map((f) => ({
    source: f.source,
    target: f.target,
    direction: f.direction,
    reverseRequired: f.reverseRequired,
    default: f.default,
    group: f.group,
    sources: f.sources,
    expression: f.expression ? compileExpression(f.expression, f.target) : undefined,
    reverseExpression: f.reverse_expression ? compileReverseExpression(f.reverse_expression, f.target) : undefined,
    normalize: f.normalize ? compileNormalize(f.normalize, f.target) : undefined,
    resolve: f.resolve ? compileResolve(f.resolve, f.target) : undefined,
  }));
}

function buildOutbound(fields: FieldMappingEntry[]): FieldMappingList {
  // Outbound is the mirror of inbound
  return fields.map((f) => ({
    source: f.source,
    target: f.target,
    direction: f.direction,
    reverseRequired: f.reverseRequired,
    group: f.group,
    sources: f.sources,
    expression: f.expression ? compileExpression(f.expression, f.target) : undefined,
    reverseExpression: f.reverse_expression ? compileReverseExpression(f.reverse_expression, f.target) : undefined,
    normalize: f.normalize ? compileNormalize(f.normalize, f.target) : undefined,
    resolve: f.resolve ? compileResolve(f.resolve, f.target) : undefined,
  }));
}

// Spec: specs/config.md — ${VAR} interpolation in string values only (not nested objects)
function resolveEnvVars(
  config: Record<string, unknown>,
  _root: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      out[key] = value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
        const envVal = process.env[varName];
        if (envVal === undefined) {
          throw new Error(
            `Config key "${key}" references environment variable "${varName}" which is not set`,
          );
        }
        return envVal;
      });
    } else {
      // Nested objects: pass through without interpolation (spec rule)
      out[key] = value;
    }
  }
  return out;
}

// ─── makeConnectorEntities ────────────────────────────────────────────────────

/** Resolve entity definitions from a connector instance given its context.
 *  Split out so the engine can call it after wiring ctx. */
export function getConnectorEntities(
  connector: Connector,
  ctx: ConnectorContext,
): EntityDefinition[] {
  return connector.getEntities ? connector.getEntities(ctx) : [];
}

// ─── compileElementFilter ─────────────────────────────────────────────────────

/** Spec: plans/engine/PLAN_ELEMENT_FILTER.md §3.2
 * Compile a filter/reverse_filter expression string into a typed predicate.
 * Throws at config load time if the expression cannot be parsed. */
function compileElementFilter(
  expression: string,
  channelId: string,
): (element: unknown, parent: unknown, index: number) => boolean {
  let fn: (element: unknown, parent: unknown, index: number) => unknown;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function("element", "parent", "index", `return (${expression});`) as typeof fn;
  } catch (err) {
    throw new Error(
      `Element filter expression in channel "${channelId}" failed to compile: ${String(err)}\n  Expression: ${expression}`,
    );
  }
  return (element, parent, index) => Boolean(fn(element, parent, index));
}

// ─── compileRecordFilter ──────────────────────────────────────────────────────

/** Spec: specs/field-mapping.md §5.1/§5.2
 * Compile a record-level filter/reverse_filter expression string into a typed predicate.
 * Throws at config load time if the expression cannot be parsed.
 * Security note: new Function executes arbitrary JS — disable in untrusted multi-tenant
 * deployments or isolate in a worker. See PLAN_RECORD_FILTER.md §6. */
function compileRecordFilter(
  expression: string,
  channelId: string,
): (record: Record<string, unknown>) => boolean {
  let fn: (record: Record<string, unknown>) => unknown;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function("record", `return (${expression});`) as typeof fn;
  } catch (err) {
    throw new Error(
      `Record filter expression in channel "${channelId}" failed to compile: ${String(err)}\n  Expression: ${expression}`,
    );
  }
  return (record) => Boolean(fn(record));
}

// ─── Field expression compilers ───────────────────────────────────────────────

/** Spec: specs/field-mapping.md §1.3
 * Compile an `expression` string into a typed function.
 * Binding: `record` — the full incoming source record. */
function compileExpression(
  expr: string,
  target: string,
): (record: Record<string, unknown>) => unknown {
  try {
    // eslint-disable-next-line no-new-func
    return new Function("record", `return (${expr});`) as (record: Record<string, unknown>) => unknown;
  } catch (err) {
    throw new Error(
      `Field expression for target "${target}" failed to compile: ${String(err)}\n  Expression: ${expr}`,
    );
  }
}

/** Spec: specs/field-mapping.md §1.3
 * Compile a `reverse_expression` string into a typed function.
 * Binding: `record` — the full canonical record. */
function compileReverseExpression(
  expr: string,
  target: string,
): (record: Record<string, unknown>) => unknown {
  try {
    // eslint-disable-next-line no-new-func
    return new Function("record", `return (${expr});`) as (record: Record<string, unknown>) => unknown;
  } catch (err) {
    throw new Error(
      `Field reverse_expression for target "${target}" failed to compile: ${String(err)}\n  Expression: ${expr}`,
    );
  }
}

/** Spec: specs/field-mapping.md §1.4
 * Compile a `normalize` string into a typed function.
 * Binding: `v` — the raw field value. */
function compileNormalize(
  expr: string,
  target: string,
): (v: unknown) => unknown {
  try {
    // eslint-disable-next-line no-new-func
    return new Function("v", `return (${expr});`) as (v: unknown) => unknown;
  } catch (err) {
    throw new Error(
      `Field normalize for target "${target}" failed to compile: ${String(err)}\n  Expression: ${expr}`,
    );
  }
}

/** Spec: specs/field-mapping.md §2.3
 * Compile a `resolve` string into a typed incremental reducer.
 * Bindings: `incoming`, `existing`. */
function compileResolve(
  expr: string,
  target: string,
): (incoming: unknown, existing: unknown | undefined) => unknown {
  try {
    // eslint-disable-next-line no-new-func
    return new Function("incoming", "existing", `return (${expr});`) as (incoming: unknown, existing: unknown | undefined) => unknown;
  } catch (err) {
    throw new Error(
      `Field resolve for target "${target}" failed to compile: ${String(err)}\n  Expression: ${expr}`,
    );
  }
}
