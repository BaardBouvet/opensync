/**
 * JSON-Files Sync POC — polling daemon
 *
 *   bun run poc/run.ts
 *
 * On first run, seeds System A with one customer (Alice) and one order ($99)
 * referencing her, then syncs everything to System B so both sides are populated.
 *
 * After that it polls every POLL_MS milliseconds, syncing A→B then B→A, and
 * prints a line for every insert/update/defer it sees. Edit any of the four JSON
 * files under poc/data/ while the daemon is running and the change will be picked
 * up on the next poll and written to the matching file in the other system.
 *
 * Stop with Ctrl+C.
 *
 * NOTE: The identity map is held in memory. Restarting the daemon resets it,
 * which will cause existing records to be re-inserted (doubles). Delete
 * poc/data/ before restarting for a clean slate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import connector from "../connectors/jsonfiles/src/index.js";
import { SyncEngine } from "./engine.js";
import type { ConnectedSystem, ConnectorContext, EngineState, InsertRecord } from "./engine.js";

const POLL_MS = Number(process.env["POLL_MS"] ?? 2000);

// ─── Setup ────────────────────────────────────────────────────────────────────

const rootDir = join(fileURLToPath(import.meta.url), "..", "data");
const aDIR = join(rootDir, "system-a");
const bDIR = join(rootDir, "system-b");
const STATE_FILE = join(rootDir, "state.json");

mkdirSync(aDIR, { recursive: true });
mkdirSync(bDIR, { recursive: true });

function makeCtx(filePaths: string[]): ConnectorContext {
  return {
    config: { filePaths },
    state: {} as ConnectorContext["state"],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    http: null as unknown as ConnectorContext["http"],
    webhookUrl: "",
  };
}

const aCtx = makeCtx([join(aDIR, "customers.json"), join(aDIR, "orders.json")]);
const bCtx = makeCtx([join(bDIR, "customers.json"), join(bDIR, "orders.json")]);

const systemA: ConnectedSystem = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
const systemB: ConnectedSystem = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };

const engine = new SyncEngine();

// Restore persisted identity map + watermarks if available.
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
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function printResults(
  dir: "A→B" | "B→A",
  results: Awaited<ReturnType<SyncEngine["sync"]>>,
): void {
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

// ─── Seed System A (first run only) ──────────────────────────────────────────

const customersAFile = join(aDIR, "customers.json");
const isFreshStart = !existsSync(customersAFile);

if (isFreshStart) {
  console.log("First run — seeding System A with Alice + one order…");

  const customersA = systemA.entities.find((e) => e.name === "customers")!;
  const ordersA = systemA.entities.find((e) => e.name === "orders")!;

  const [alice] = await collect(
    customersA.insert!(one<InsertRecord>({ data: { name: "Alice" } })),
  );
  await collect(
    ordersA.insert!(
      one<InsertRecord>({
        data: { amount: 99 },
        associations: [
          { predicate: "customerId", targetEntity: "customers", targetId: alice.id },
        ],
      }),
    ),
  );
  console.log(`  Seeded: customer ${alice.id.slice(0, 8)}… (Alice), order $99\n`);
} else {
  console.log("Existing data detected — skipping seed.\n");
}

// ─── Start ────────────────────────────────────────────────────────────────────

console.log("=".repeat(60));
console.log("  OpenSync JSON-Files POC — polling daemon");
console.log(`  Poll interval: ${POLL_MS}ms  |  Stop with Ctrl+C`);
console.log("  Files:");
console.log(`    poc/data/system-a/customers.json`);
console.log(`    poc/data/system-a/orders.json`);
console.log(`    poc/data/system-b/customers.json`);
console.log(`    poc/data/system-b/orders.json`);
console.log("=".repeat(60));
console.log();

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  const ab = await engine.sync(systemA, systemB);
  const ba = await engine.sync(systemB, systemA);
  printResults("A→B", ab);
  printResults("B→A", ba);
  saveState();
}

// Initial sync (picks up seed data or any pre-existing changes).
await poll();

// Keep going until Ctrl+C.
setInterval(poll, POLL_MS);
