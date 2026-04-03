/**
 * OpenSync POC v4 — SQLite state layer, hub-and-spoke ingest model
 *
 *   bun run poc/v4/run.ts
 *   bun run poc/v4/run.ts --root path/to/project
 *   bun run poc/v4/run.ts --full          # ignore watermarks, re-ingest everything
 *
 * Changes from v3:
 *  - State persisted in SQLite (data/opensync.db) instead of data/state.json
 *  - Hub-and-spoke: each source read once per cycle, changes fanned out to all targets
 *  - ctx.state backed by connector_state table
 *  - Transaction log and sync run log written to DB on every cycle
 *  - Per-record error recovery: connector errors are caught and logged
 *  - Config validated with Zod at startup
 *  - --full flag for full sync (watermark bypass)
 *
 * Stop with Ctrl+C.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { z } from "zod";
import { openDb, makeConnectorState } from "./db.js";
import { SyncEngine } from "./engine.js";
import type {
  ChannelConfig,
  ChannelMember,
  ConnectorInstance,
  EngineConfig,
  IngestResult,
  InsertRecord,
  FieldMappingList,
} from "./engine.js";
import type { Connector, ConnectorContext } from "../../packages/sdk/src/index.js";

const POLL_MS = Number(process.env["POLL_MS"] ?? 2000);

// ─── Config schema (Zod) ─────────────────────────────────────────────────────

const FieldMappingSchema = z.object({
  source: z.string().optional(),
  target: z.string(),
  direction: z.enum(["bidirectional", "forward_only", "reverse_only"]).optional(),
  expression: z.string().optional(),
});

const MappingSchema = z.object({
  connector: z.string(),
  channel: z.string(),
  entity: z.string(),
  fields: z.array(FieldMappingSchema).optional(),
});

const ChannelSchema = z.object({ id: z.string() });

const ConnectorSchema = z.object({
  plugin: z.string(),
  config: z.record(z.string(), z.unknown()).default({}),
});

const OpenlinkSchema = z.object({
  connectors: z.record(z.string(), ConnectorSchema),
});

const ChannelsFileSchema = z.object({
  channels: z.array(ChannelSchema).optional(),
  mappings: z.array(MappingSchema).optional(),
}).passthrough();

type ConfigMapping = z.infer<typeof MappingSchema>;
type ConfigChannel = z.infer<typeof ChannelSchema>;
type OpenlinkFile = z.infer<typeof OpenlinkSchema>;

// ─── Config loaders ───────────────────────────────────────────────────────────

function loadOpenlink(rootDir: string): OpenlinkFile {
  const filePath = join(rootDir, "openlink.json");
  if (!existsSync(filePath)) throw new Error(`openlink.json not found in ${rootDir}`);
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  return OpenlinkSchema.parse(raw);
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
    const doc = ChannelsFileSchema.parse(
      extname(filePath) === ".json" ? JSON.parse(raw) : parseYaml(raw),
    );
    if (doc.channels) all.push(...doc.channels);
  }
  if (all.length === 0) throw new Error(`No channels defined in mappings/ — add a channels.yaml`);
  return all;
}

function loadMappings(rootDir: string): ConfigMapping[] {
  const all: ConfigMapping[] = [];
  for (const filePath of _scanMappingsDir(rootDir)) {
    const raw = readFileSync(filePath, "utf8");
    const doc = ChannelsFileSchema.parse(
      extname(filePath) === ".json" ? JSON.parse(raw) : parseYaml(raw),
    );
    if (doc.mappings) all.push(...doc.mappings);
  }
  return all;
}

// ─── Plugin loader ────────────────────────────────────────────────────────────

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

// ─── Connector instantiation ──────────────────────────────────────────────────

async function instantiateConnectors(
  cfgConnectors: Record<string, { plugin: string; config: Record<string, unknown> }>,
  db: ReturnType<typeof openDb>,
): Promise<Map<string, ConnectorInstance>> {
  const map = new Map<string, ConnectorInstance>();
  for (const [id, entry] of Object.entries(cfgConnectors)) {
    const plugin = await loadPlugin(entry.plugin);
    const ctx: ConnectorContext = {
      config: entry.config,
      state: makeConnectorState(db, id),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      http: null as unknown as ConnectorContext["http"],
      webhookUrl: "",
    };
    map.set(id, { id, ctx, entities: plugin.getEntities?.(ctx) ?? [] });
  }
  return map;
}

// ─── Config normaliser ────────────────────────────────────────────────────────

function normaliseConfig(
  cfgChannels: ConfigChannel[],
  cfgMappings: ConfigMapping[],
  connectorInstances: Map<string, ConnectorInstance>,
): EngineConfig {
  const channelMembersMap = new Map<string, ChannelMember[]>();
  for (const ch of cfgChannels) channelMembersMap.set(ch.id, []);

  for (const mapping of cfgMappings) {
    const members = channelMembersMap.get(mapping.channel);
    if (!members) throw new Error(`Mapping references unknown channel "${mapping.channel}"`);
    if (!connectorInstances.has(mapping.connector)) {
      throw new Error(`Mapping references unknown connector "${mapping.connector}"`);
    }

    let fieldMappings: FieldMappingList | undefined;
    if (mapping.fields && mapping.fields.length > 0) {
      fieldMappings = mapping.fields.map((f) => ({
        source: f.source,
        target: f.target,
        direction: f.direction,
        expression: f.expression,
      }));
    }
    members.push({ connectorId: mapping.connector, entity: mapping.entity, inbound: fieldMappings, outbound: fieldMappings });
  }

  const channels: ChannelConfig[] = [];
  for (const ch of cfgChannels) {
    channels.push({ id: ch.id, members: channelMembersMap.get(ch.id)! });
  }
  return { connectors: Array.from(connectorInstances.values()), channels };
}

// ─── Resolve root / flags ─────────────────────────────────────────────────────

const thisDir = dirname(fileURLToPath(import.meta.url));
const rootArgIdx = process.argv.indexOf("--root");
const rootDir = rootArgIdx !== -1 ? resolve(process.argv[rootArgIdx + 1]) : thisDir;
const fullSync = process.argv.includes("--full");

// ─── Boot ─────────────────────────────────────────────────────────────────────

console.log(`Root: ${rootDir}`);
if (fullSync) console.log("Mode: full sync (watermarks ignored)");

const openlinkFile = loadOpenlink(rootDir);
const cfgChannels = loadChannels(rootDir);
const cfgMappings = loadMappings(rootDir);

// Ensure data dir + data files exist.
mkdirSync(join(rootDir, "data"), { recursive: true });
for (const entry of Object.values(openlinkFile.connectors)) {
  const filePaths = entry.config["filePaths"] as string[] | undefined;
  if (filePaths) {
    for (const fp of filePaths) mkdirSync(dirname(resolve(process.cwd(), fp)), { recursive: true });
  }
}

const dbPath = join(rootDir, "data", "opensync.db");
const db = openDb(dbPath);

console.log(`Loading ${Object.keys(openlinkFile.connectors).length} connector plugin(s)…`);
const connectorInstances = await instantiateConnectors(openlinkFile.connectors, db);
const engineConfig = normaliseConfig(cfgChannels, cfgMappings, connectorInstances);
const engine = new SyncEngine(engineConfig, db);

// ─── Seed (first run only) ────────────────────────────────────────────────────

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}
async function* one<T>(item: T): AsyncIterable<T> { yield item; }

const firstConnector = connectorInstances.get(connectorInstances.keys().next().value!);
if (firstConnector) {
  const customersEntity = firstConnector.entities.find((e) => e.name === "customers");
  const ordersEntity    = firstConnector.entities.find((e) => e.name === "orders");
  const firstFilePath   = (firstConnector.ctx.config["filePaths"] as string[] | undefined)?.[0];

  if (customersEntity?.insert && ordersEntity?.insert && firstFilePath) {
    if (!existsSync(resolve(process.cwd(), firstFilePath))) {
      console.log(`First run — seeding connector ${firstConnector.id} with Alice Smith + one order…`);
      const [alice] = await collect(
        customersEntity.insert(one<InsertRecord>({ data: { name: "Alice Smith" } }), firstConnector.ctx),
      );
      await collect(
        ordersEntity.insert(one<InsertRecord>({
          data: { amount: 99 },
          associations: [{ predicate: "customerId", targetEntity: "customers", targetId: alice.id }],
        }), firstConnector.ctx),
      );
      console.log(`  Seeded: customer ${alice.id.slice(0, 8)}… (Alice Smith), order $99\n`);
    } else {
      console.log("Existing data detected — skipping seed.\n");
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts(): string { return new Date().toISOString().slice(11, 23); }

function printIngestResult(result: IngestResult): void {
  const meaningful = result.records.filter((r) => r.action !== "skip");
  for (const r of meaningful) {
    const src = r.sourceId.slice(0, 8);
    const tgt = r.targetId ? r.targetId.slice(0, 8) : "?";
    const tag =
      r.action === "insert" ? "INSERT" :
      r.action === "update" ? "UPDATE" :
      r.action === "defer"  ? "DEFER " :
      r.action === "error"  ? "ERROR " : r.action.toUpperCase();
    const dir = r.targetConnectorId
      ? `${result.connectorId}→${r.targetConnectorId} [${result.channelId}]`
      : `${result.connectorId} [${result.channelId}]`;
    const suffix = r.action === "error" ? `  ← ${r.error}` : "";
    console.log(`  [${ts()}] ${dir}  ${tag}  ${r.entity}  ${src}… → ${tgt}…${suffix}`);
  }
}

// ─── Start banner ─────────────────────────────────────────────────────────────

const channelSummary = cfgChannels.map((ch) => {
  const members = cfgMappings.filter((m) => m.channel === ch.id).map((m) => m.connector);
  return `${ch.id} [${members.join(", ")}]`;
}).join("  |  ");
const totalMembers = engineConfig.channels.reduce((n, ch) => n + ch.members.length, 0);

console.log("=".repeat(60));
console.log("  OpenSync POC v4 — SQLite state, hub-and-spoke ingest");
console.log(`  Poll interval: ${POLL_MS}ms  |  Stop with Ctrl+C`);
console.log(`  Channels: ${channelSummary}`);
console.log(`  Sources per cycle: ${totalMembers}`);
console.log(`  DB: ${dbPath}`);
console.log("=".repeat(60));
console.log();

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  const batchId = crypto.randomUUID();
  for (const channel of engineConfig.channels) {
    for (const member of channel.members) {
      const result = await engine.ingest(channel.id, member.connectorId, { batchId, fullSync });
      printIngestResult(result);
    }
  }
}

// ─── Live table dump ─────────────────────────────────────────────────────────
// After every poll, write each SQLite table to data/tables/<table>.json.
// JSON columns (canonical_data, data_before, data_after) are parsed so the
// files are human-readable without needing a SQLite viewer.

const tablesDir = join(rootDir, "data", "tables");
mkdirSync(tablesDir, { recursive: true });

const JSON_COLS: Record<string, string[]> = {
  shadow_state:    ["canonical_data"],
  transaction_log: ["data_before", "data_after"],
};

const DUMP_TABLES = [
  "identity_map",
  "watermarks",
  "shadow_state",
  "connector_state",
  "transaction_log",
  "sync_runs",
] as const;

function dumpTables(): void {
  for (const table of DUMP_TABLES) {
    const rows = db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    const parsed = JSON_COLS[table]
      ? rows.map((row) => {
          const out = { ...row };
          for (const col of JSON_COLS[table]) {
            if (typeof out[col] === "string") {
              try { out[col] = JSON.parse(out[col] as string); } catch { /* leave as-is */ }
            }
          }
          return out;
        })
      : rows;
    writeFileSync(join(tablesDir, `${table}.json`), JSON.stringify(parsed, null, 2));
  }
}

await poll();
dumpTables();
setInterval(async () => { await poll(); dumpTables(); }, POLL_MS);
