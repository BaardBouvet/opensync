/**
 * OpenSync POC v3 — directory-based config, content-based echo detection
 *
 *   bun run poc/v3/run.ts
 *   bun run poc/v3/run.ts --root path/to/project
 *
 * Loads config from a project root directory:
 *   connectors.json   — connector instances (plugin + auth config)
 *   mappings/         — one or more YAML/JSON files, merged at load time
 *
 * Channels are auto-derived from the unique "channel" values across all
 * mapping files — no explicit channel list required.
 *
 * Changes from v2:
 *  - Config comes from connectors.json + mappings/ (plain data) rather than
 *    inline TypeScript.
 *  - Connector plugins are loaded via dynamic import() from the "plugin" field.
 *  - Directed pairs are derived automatically from channel membership.
 *  - Echo detection uses the lastWritten content store (v3 engine).
 *
 * Stop with Ctrl+C.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { SyncEngine } from "./engine.js";
import type {
  ChannelConfig,
  ChannelMember,
  ConnectorInstance,
  EngineConfig,
  EngineState,
  InsertRecord,
  RenameMap,
} from "./engine.js";
import type { Connector, ConnectorContext } from "../../packages/sdk/src/index.js";

const POLL_MS = Number(process.env["POLL_MS"] ?? 2000);

// ─── Config schema types ──────────────────────────────────────────────────────

interface ConfigFieldMapping {
  source: string;
  target: string;
  direction?: "bidirectional" | "read_only" | "write_only";
}

interface ConfigMapping {
  connector: string;
  channel: string;
  entity: string;
  fields?: ConfigFieldMapping[];
}

interface ConfigConnector {
  plugin: string;
  config: Record<string, unknown>;
}

interface ConfigChannel {
  id: string;
}

interface OpenlinkFile {
  connectors: Record<string, ConfigConnector>;
}

interface ChannelsFile {
  channels: ConfigChannel[];
}

interface MappingsFile {
  mappings: ConfigMapping[];
}

// ─── Config loaders ───────────────────────────────────────────────────────────

function loadOpenlink(rootDir: string): OpenlinkFile {
  const filePath = join(rootDir, "openlink.json");
  if (!existsSync(filePath)) throw new Error(`openlink.json not found ivideon ${rootDir}`);
  const doc = JSON.parse(readFileSync(filePath, "utf8")) as OpenlinkFile;
  if (typeof doc.connectors !== "object" || Array.isArray(doc.connectors)) {
    throw new Error(`Invalid openlink.json: missing "connectors" map`);
  }
  return doc;
}

function _scanMappingsDir(rootDir: string): string[] {
  const mappingsDir = join(rootDir, "mappings");
  if (!existsSync(mappingsDir)) throw new Error(`mappings/ directory not found in ${rootDir}`);
  return readdirSync(mappingsDir)
    .filter((f: string) => extname(f) === ".yaml" || extname(f) === ".yml" || extname(f) === ".json")
    .sort()
    .map((f) => join(mappingsDir, f));
}

function loadChannels(rootDir: string): ConfigChannel[] {
  const all: ConfigChannel[] = [];
  for (const filePath of _scanMappingsDir(rootDir)) {
    const raw = readFileSync(filePath, "utf8");
    const doc = (extname(filePath) === ".json" ? JSON.parse(raw) : parseYaml(raw)) as ChannelsFile;
    if (Array.isArray(doc.channels)) all.push(...doc.channels);
  }
  if (all.length === 0) throw new Error(`No channels defined in mappings/ — add a channels.yaml`);
  return all;
}

function loadMappings(rootDir: string): ConfigMapping[] {
  const all: ConfigMapping[] = [];
  for (const filePath of _scanMappingsDir(rootDir)) {
    const raw = readFileSync(filePath, "utf8");
    const doc = (extname(filePath) === ".json" ? JSON.parse(raw) : parseYaml(raw)) as MappingsFile;
    if (Array.isArray(doc.mappings)) all.push(...doc.mappings);
  }
  return all;
}

// ─── Plugin loader ────────────────────────────────────────────────────────────

/**
 * Dynamically import a connector plugin from a package name or file path.
 * Relative paths are resolved from the project root (cwd).
 * This is the JavaScript equivalent of Java's Class.forName() + newInstance().
 */
async function loadPlugin(pluginSpec: string): Promise<Connector> {
  const specifier = pluginSpec.startsWith(".")
    ? resolve(process.cwd(), pluginSpec)
    : pluginSpec;
  const mod = await import(specifier);
  const connector = (mod.default ?? mod) as Connector;
  if (!connector.metadata) {
    throw new Error(`Plugin "${pluginSpec}" does not export a valid Connector (missing metadata)`);
  }
  return connector;
}

function buildCtx(config: Record<string, unknown>): ConnectorContext {
  return {
    config,
    state: {} as ConnectorContext["state"],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    http: null as unknown as ConnectorContext["http"],
    webhookUrl: "",
  };
}

async function instantiateConnectors(
  cfgConnectors: Record<string, ConfigConnector>,
): Promise<Map<string, ConnectorInstance>> {
  const map = new Map<string, ConnectorInstance>();
  for (const [id, entry] of Object.entries(cfgConnectors)) {
    const plugin = await loadPlugin(entry.plugin);
    const ctx = buildCtx(entry.config);
    map.set(id, { id, ctx, entities: plugin.getEntities?.(ctx) ?? [] });
  }
  return map;
}

// ─── Config normaliser ────────────────────────────────────────────────────────

/**
 * Convert channels + mappings into the EngineConfig that SyncEngine expects.
 * Also derives the complete list of directed pairs from channel membership.
 */
function normaliseConfig(
  cfgChannels: ConfigChannel[],
  cfgMappings: ConfigMapping[],
  connectorInstances: Map<string, ConnectorInstance>,
): { engineConfig: EngineConfig; pairs: Array<[string, string, string]> } {
  const channelMembersMap = new Map<string, ChannelMember[]>();
  for (const ch of cfgChannels) {
    channelMembersMap.set(ch.id, []);
  }

  for (const mapping of cfgMappings) {
    const members = channelMembersMap.get(mapping.channel);
    if (!members) throw new Error(`Mapping references unknown channel "${mapping.channel}"`);
    if (!connectorInstances.has(mapping.connector)) {
      throw new Error(`Mapping references unknown connector "${mapping.connector}"`);
    }

    // Build inbound/outbound rename maps from field declarations.
    // Only bidirectional (default) and read_only fields contribute to inbound.
    // Only bidirectional and write_only fields contribute to outbound.
    let inbound: RenameMap | undefined;
    let outbound: RenameMap | undefined;

    if (mapping.fields && mapping.fields.length > 0) {
      for (const field of mapping.fields) {
        const dir = field.direction ?? "bidirectional";
        if (dir !== "write_only") {
          inbound ??= {};
          inbound[field.source] = field.target;
        }
        if (dir !== "read_only") {
          outbound ??= {};
          outbound[field.target] = field.source;
        }
      }
    }

    members.push({
      connectorId: mapping.connector,
      entity: mapping.entity,
      inbound,
      outbound,
    });
  }

  const channels: ChannelConfig[] = [];
  const pairs: Array<[string, string, string]> = [];

  for (const ch of cfgChannels) {
    const members = channelMembersMap.get(ch.id)!;
    channels.push({ id: ch.id, members });

    // Derive all N×(N-1) directed pairs for this channel.
    for (const from of members) {
      for (const to of members) {
        if (from.connectorId !== to.connectorId) {
          pairs.push([ch.id, from.connectorId, to.connectorId]);
        }
      }
    }
  }

  return {
    engineConfig: {
      connectors: Array.from(connectorInstances.values()),
      channels,
    },
    pairs,
  };
}

// ─── Resolve root directory ───────────────────────────────────────────────────

const thisDir = dirname(fileURLToPath(import.meta.url));
const rootArgIdx = process.argv.indexOf("--root");
const rootDir = rootArgIdx !== -1
  ? resolve(process.argv[rootArgIdx + 1])
  : thisDir;

const stateFilePath = join(rootDir, "data", "state.json");

// ─── Boot ─────────────────────────────────────────────────────────────────────

console.log(`Root: ${rootDir}`);
const openlinkFile = loadOpenlink(rootDir);
const cfgChannels = loadChannels(rootDir);
const cfgMappings = loadMappings(rootDir);

console.log(`Loading ${Object.keys(openlinkFile.connectors).length} connector plugin(s)…`);
const connectorInstances = await instantiateConnectors(openlinkFile.connectors);

// Ensure data directories exist for all connectors.
for (const entry of Object.values(openlinkFile.connectors)) {
  const filePaths = entry.config["filePaths"] as string[] | undefined;
  if (filePaths) {
    for (const fp of filePaths) {
      mkdirSync(dirname(resolve(process.cwd(), fp)), { recursive: true });
    }
  }
}

const { engineConfig, pairs } = normaliseConfig(cfgChannels, cfgMappings, connectorInstances);
const engine = new SyncEngine(engineConfig);

if (existsSync(stateFilePath)) {
  engine.fromJSON(JSON.parse(readFileSync(stateFilePath, "utf8")) as EngineState);
  console.log("Loaded identity map + watermarks from state.json\n");
}

function saveState(): void {
  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, JSON.stringify(engine.toJSON(), null, 2), "utf8");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

async function* one<T>(item: T): AsyncIterable<T> {
  yield item;
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function printResults(dir: string, results: Awaited<ReturnType<SyncEngine["sync"]>>): void {
  const meaningful = results.filter((r) => r.action !== "skip");
  for (const r of meaningful) {
    const src = r.sourceId.slice(0, 8);
    const tgt = r.targetId ? r.targetId.slice(0, 8) : "?";
    const tag =
      r.action === "insert" ? "INSERT" :
      r.action === "update" ? "UPDATE" :
      r.action === "defer"  ? "DEFER " :
      r.action === "error"  ? "ERROR " : r.action.toUpperCase();
    const suffix = r.action === "error" ? `  ← ${(r as { error?: string }).error}` : "";
    console.log(`  [${ts()}] ${dir}  ${tag}  ${r.entity}  ${src}… → ${tgt}…${suffix}`);
  }
}

// ─── Seed (first run only) ────────────────────────────────────────────────────

// Seed on first run using connector A (first listed connector that has both entities).
const connA = connectorInstances.get(connectorInstances.keys().next().value!);
if (connA) {
  const customersAEntity = connA.entities.find((e) => e.name === "customers");
  const ordersAEntity    = connA.entities.find((e) => e.name === "orders");
  const firstFilePath    = (connA.ctx.config["filePaths"] as string[] | undefined)?.[0];

  if (customersAEntity?.insert && ordersAEntity?.insert && firstFilePath) {
    if (!existsSync(resolve(process.cwd(), firstFilePath))) {
      console.log(`First run — seeding connector ${connA.id} with Alice Smith + one order…`);
      const [alice] = await collect(
        customersAEntity.insert(one<InsertRecord>({ data: { name: "Alice Smith" } }), connA.ctx),
      );
      await collect(
        ordersAEntity.insert(one<InsertRecord>({
          data: { amount: 99 },
          associations: [
            { predicate: "customerId", targetEntity: "customers", targetId: alice.id },
          ],
        }), connA.ctx),
      );
      console.log(`  Seeded: customer ${alice.id.slice(0, 8)}… (Alice Smith), order $99\n`);
    } else {
      console.log("Existing data detected — skipping seed.\n");
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

const channelSummary = cfgChannels.map((ch) => {
  const members = cfgMappings.filter((m) => m.channel === ch.id).map((m) => m.connector);
  return `${ch.id} [${members.join(", ")}]`;
}).join("  |  ");

console.log("=".repeat(60));
console.log("  OpenSync POC v3 — YAML config, content-based echo detection");
console.log(`  Poll interval: ${POLL_MS}ms  |  Stop with Ctrl+C`);
console.log(`  Channels: ${channelSummary}`);
console.log(`  Pairs: ${pairs.length} directed`);
console.log("=".repeat(60));
console.log();

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  for (const [channelId, fromId, toId] of pairs) {
    const results = await engine.sync(channelId, fromId, toId);
    printResults(`${fromId}→${toId} [${channelId}]`, results);
  }
  saveState();
}

await poll();
setInterval(poll, POLL_MS);
