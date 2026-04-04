// Spec: specs/config.md — load and resolve config from the project root directory
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { load as yamlLoad } from "js-yaml";
import {
  OpenSyncJsonSchema,
  MappingsFileSchema,
  type MappingEntry,
  type FieldMappingEntry,
} from "./schema.js";
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
}

export type FieldMappingList = FieldMapping[];

export interface ChannelMember {
  connectorId: string;
  entity: string;
  inbound?: FieldMappingList;
  outbound?: FieldMappingList;
}

export interface ChannelConfig {
  id: string;
  members: ChannelMember[];
  identityFields?: string[];
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

  const allChannelDefs: Array<{ id: string; identityFields?: string[] }> = [];
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
        allChannelDefs.push({ id: ch.id, identityFields: ch.identityFields });
      }
    }
    if (result.data.mappings) {
      allMappingEntries.push(...result.data.mappings);
    }
  }

  // 3. Build ChannelConfig list
  // Each channel gets its members from the mapping entries that reference it
  const channelMap = new Map<string, ChannelConfig>();

  for (const chDef of allChannelDefs) {
    channelMap.set(chDef.id, {
      id: chDef.id,
      members: [],
      identityFields: chDef.identityFields,
    });
  }

  for (const entry of allMappingEntries) {
    if (!channelMap.has(entry.channel)) {
      // Auto-create channel if not declared in channels.yaml
      channelMap.set(entry.channel, { id: entry.channel, members: [] });
    }
    const ch = channelMap.get(entry.channel)!;

    const inbound = entry.fields ? buildInbound(entry.fields) : undefined;
    const outbound = entry.fields ? buildOutbound(entry.fields) : undefined;

    ch.members.push({
      connectorId: entry.connector,
      entity: entry.entity,
      inbound,
      outbound,
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
