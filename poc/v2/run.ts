/**
 * JSON-Files Sync POC v2 — configurable channels & canonical field mapping
 *
 *   bun run poc/v2/run.ts
 *
 * Three connector instances (A, B, C) with different local field names for customers:
 *   A stores { name }          B stores { customerName }      C stores { fullName }
 *
 * The channel config declares the renames. The engine routes all data through the
 * canonical field "customerName" — no connector knows about the others' field names.
 *
 * On first run, seeds connector A with Alice + one order, then syncs all pairs so
 * all three connectors are populated consistently.
 *
 * After that it polls every POLL_MS milliseconds and prints every insert/update/defer.
 * Edit any JSON file under poc/v3/data/ while the daemon is running and the change
 * will be picked up on the next poll and translated into the correct field name for
 * each target connector.
 *
 * Stop with Ctrl+C.
 *
 * NOTE: The identity map is held in memory. Restarting resets it — delete poc/v3/data/
 * before restarting for a clean slate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import connector from "../../connectors/jsonfiles/src/index.js";
import { SyncEngine } from "./engine.js";
import type {
  ConnectorContext,
  ConnectorInstance,
  EngineConfig,
  EngineState,
  InsertRecord,
} from "./engine.js";

const POLL_MS = Number(process.env["POLL_MS"] ?? 2000);

// ─── Directories ──────────────────────────────────────────────────────────────

const rootDir = join(fileURLToPath(import.meta.url), "..", "data");
const aDir = join(rootDir, "connector-a");
const bDir = join(rootDir, "connector-b");
const cDir = join(rootDir, "connector-c");
const STATE_FILE = join(rootDir, "state.json");

mkdirSync(aDir, { recursive: true });
mkdirSync(bDir, { recursive: true });
mkdirSync(cDir, { recursive: true });

// ─── Connectors ───────────────────────────────────────────────────────────────

function makeCtx(filePaths: string[]): ConnectorContext {
  return {
    config: { filePaths },
    state: {} as ConnectorContext["state"],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    http: null as unknown as ConnectorContext["http"],
    webhookUrl: "",
  };
}

const aCtx = makeCtx([join(aDir, "customers.json"), join(aDir, "orders.json")]);
const bCtx = makeCtx([join(bDir, "customers.json"), join(bDir, "orders.json")]);
const cCtx = makeCtx([join(cDir, "customers.json"), join(cDir, "orders.json")]);

const connectorA: ConnectorInstance = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
const connectorB: ConnectorInstance = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
const connectorC: ConnectorInstance = { id: "C", ctx: cCtx, entities: connector.getEntities!(cCtx) };

// ─── Channel config ───────────────────────────────────────────────────────────
//
// Canonical customer field: "customerName"
//   A: name       ↔ customerName
//   B: (already canonical, no renames)
//   C: fullName   ↔ customerName

const engineConfig: EngineConfig = {
  connectors: [connectorA, connectorB, connectorC],
  channels: [
    {
      id: "customers",
      members: [
        {
          connectorId: "A",
          entity: "customers",
          inbound:  { name: "customerName" },       // A reads "name"  → canonical "customerName"
          outbound: { customerName: "name" },       // canonical "customerName" → A writes "name"
        },
        {
          connectorId: "B",
          entity: "customers",
          // B already uses "customerName" — no renames needed
        },
        {
          connectorId: "C",
          entity: "customers",
          inbound:  { fullName: "customerName" },   // C reads "fullName" → canonical "customerName"
          outbound: { customerName: "fullName" },   // canonical "customerName" → C writes "fullName"
        },
      ],
    },
    {
      id: "orders",
      members: [
        { connectorId: "A", entity: "orders" },
        { connectorId: "B", entity: "orders" },
        { connectorId: "C", entity: "orders" },
      ],
    },
  ],
};

// ─── Engine ───────────────────────────────────────────────────────────────────

const engine = new SyncEngine(engineConfig);

if (existsSync(STATE_FILE)) {
  engine.fromJSON(JSON.parse(readFileSync(STATE_FILE, "utf8")) as EngineState);
  console.log("Loaded identity map + watermarks from state.json\n");
}

function saveState(): void {
  writeFileSync(STATE_FILE, JSON.stringify(engine.toJSON(), null, 2), "utf8");
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
      r.action === "defer"  ? "DEFER " : r.action.toUpperCase();
    console.log(`  [${ts()}] ${dir}  ${tag}  ${r.entity}  ${src}… → ${tgt}…`);
  }
}

// ─── Seed (first run only) ────────────────────────────────────────────────────

const customersAFile = join(aDir, "customers.json");
const isFreshStart = !existsSync(customersAFile);

if (isFreshStart) {
  console.log('First run — seeding connector A with Alice Smith + one order…');
  console.log('  A stores { name }, B will receive { customerName }, C will receive { fullName }');
  console.log();

  const customersA = connectorA.entities.find((e) => e.name === "customers")!;
  const ordersA    = connectorA.entities.find((e) => e.name === "orders")!;

  // Seed in A's local field name.
  const [alice] = await collect(
    customersA.insert!(one<InsertRecord>({ data: { name: "Alice Smith" } })),
  );
  await collect(
    ordersA.insert!(one<InsertRecord>({
      data: { amount: 99 },
      associations: [
        { predicate: "customerId", targetEntity: "customers", targetId: alice.id },
      ],
    })),
  );
  console.log(`  Seeded: customer ${alice.id.slice(0, 8)}… (Alice Smith), order $99\n`);
} else {
  console.log("Existing data detected — skipping seed.\n");
}

// ─── Start ────────────────────────────────────────────────────────────────────

console.log("=".repeat(60));
console.log("  OpenSync JSON-Files POC v2 — configurable channels");
console.log(`  Poll interval: ${POLL_MS}ms  |  Stop with Ctrl+C`);
console.log("  Connectors:");
console.log(`    A  poc/v2/data/connector-a/  (field: name)`);
console.log(`    B  poc/v2/data/connector-b/  (field: customerName — canonical)`);
console.log(`    C  poc/v2/data/connector-c/  (field: fullName)`);
console.log("=".repeat(60));
console.log();

// ─── Poll loop ────────────────────────────────────────────────────────────────

// All directed pairs for each channel. Order is cascade-friendly: A→B before B→C
// means A changes reach C in the same cycle.
const pairs: [string, string, string][] = [
  ["customers", "A", "B"],
  ["customers", "B", "C"],
  ["customers", "A", "C"],
  ["customers", "C", "B"],
  ["customers", "B", "A"],
  ["customers", "C", "A"],
  ["orders", "A", "B"],
  ["orders", "B", "C"],
  ["orders", "A", "C"],
  ["orders", "C", "B"],
  ["orders", "B", "A"],
  ["orders", "C", "A"],
];

async function poll(): Promise<void> {
  for (const [channelId, fromId, toId] of pairs) {
    const results = await engine.sync(channelId, fromId, toId);
    printResults(`${fromId}→${toId} [${channelId}]`, results);
  }
  saveState();
}

await poll();
setInterval(poll, POLL_MS);
