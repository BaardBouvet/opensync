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
  assocMappings?: AssocPredicateMapping[];
  // Spec: specs/field-mapping.md §3.2/§3.4 — nested array expansion fields
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
}

export interface ChannelConfig {
  id: string;
  members: ChannelMember[];
  identityFields?: string[];
  /** Spec: plans/engine/PLAN_TRANSITIVE_CLOSURE_IDENTITY.md §2.5
   * Compound identity groups. Each group matches as an AND-tuple; groups are OR-ed across.
   * Takes precedence over identityFields when both are present. */
  identityGroups?: IdentityGroup[];
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
  strategy: "lww" | "field_master";
  fieldMasters?: Record<string, string>;
  connectorPriorities?: Record<string, number>;
  fieldStrategies?: Record<string, { strategy: "coalesce" | "last_modified" | "collect" }>;
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
  // Each channel gets its members from the mapping entries that reference it

  // Spec: specs/field-mapping.md §3.2 — build a global index of named mappings so
  // child entries can resolve their parent and inherit connectorId + sourceEntity.
  const namedMappings = new Map<string, MappingEntry>();
  for (const entry of allMappingEntries) {
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
  // Source descriptors are added to namedMappings only; they are NOT added as channel members.
  const sameChannelDescriptors = new Set<string>(); // set of `name` values
  for (const entry of allMappingEntries) {
    if (entry.parent) {
      const parentEntry = namedMappings.get(entry.parent);
      if (parentEntry && parentEntry.channel === entry.channel) {
        // Same-channel parent: mark as source descriptor
        sameChannelDescriptors.add(entry.parent);
      }
    }
  }

  const channelMap = new Map<string, ChannelConfig>();

  for (const chDef of allChannelDefs) {
    channelMap.set(chDef.id, {
      id: chDef.id,
      members: [],
      identityFields: chDef.identityFields,
      identityGroups: chDef.identityGroups,
    });
  }

  for (const entry of allMappingEntries) {
    // Spec: specs/field-mapping.md §3.2 — skip same-channel source descriptors.
    // They live in namedMappings for child lookup but are not channel members themselves.
    if (entry.name && sameChannelDescriptors.has(entry.name)) {
      continue;
    }

    if (!channelMap.has(entry.channel)) {
      // Auto-create channel if not declared in channels.yaml
      channelMap.set(entry.channel, { id: entry.channel, members: [] });
    }
    const ch = channelMap.get(entry.channel)!;

    // Spec: specs/field-mapping.md §3.2/§3.4 — resolve parent mapping for child entries.
    let resolvedConnectorId = entry.connector;
    let resolvedSourceEntity: string | undefined;
    let resolvedEntity = entry.entity ?? "";
    let expansionChain: ExpansionChainLevel[] | undefined;

    if (entry.parent) {
      if (!entry.array_path) {
        throw new Error(`Mapping entry in channel "${entry.channel}" with parent "${entry.parent}" must declare array_path`);
      }
      // Spec: specs/field-mapping.md §3.4 — walk the full parent chain transitively
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

    // Spec: plans/engine/PLAN_ELEMENT_FILTER.md §3.2 — compile filter expressions once at load time
    const elementFilter = entry.filter ? compileElementFilter(entry.filter, entry.channel) : undefined;
    const elementReverseFilter = entry.reverse_filter ? compileElementFilter(entry.reverse_filter, entry.channel) : undefined;

    ch.members.push({
      name: entry.name,
      connectorId: resolvedConnectorId!,
      entity: resolvedEntity,
      sourceEntity: resolvedSourceEntity,
      inbound,
      outbound,
      assocMappings: entry.associations,
      // Array expansion fields
      arrayPath: entry.array_path,
      parentMappingName: entry.parent,
      parentFields: entry.parent_fields as Record<string, string | { path?: string; field: string }> | undefined,
      elementKey: entry.element_key,
      expansionChain,
      elementFilter,
      elementReverseFilter,
    });
  }

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
    channels: Array.from(channelMap.values()),
    conflict: { strategy: "lww" },
    readTimeoutMs: 30_000,
  };
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
  }));
}

function buildOutbound(fields: FieldMappingEntry[]): FieldMappingList {
  // Outbound is the mirror of inbound
  return fields.map((f) => ({
    source: f.source,
    target: f.target,
    direction: f.direction,
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
