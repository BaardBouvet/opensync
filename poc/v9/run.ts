/**
 * POC v9 manual runner — demonstrates ingest-first, DB-backed identity matching.
 *
 * Usage:
 *   bun poc/v9/run.ts
 *
 * The v9 model separates data collection from identity matching:
 *
 *   Scenario 1 — Collect → Discover → Onboard → Sync
 *     Runs the new v9 flow: collectOnly ingests both sides, discovers from shadow_state
 *     (no live connector calls), onboards by merging provisional canonicals, then verifies
 *     that subsequent ingest produces 0 writes.
 *
 *   Scenario 2 — Discover is a free dry-run
 *     After collecting, shows that discover() can be called multiple times (it reads from
 *     DB only) and the report is stable.  Only call onboard() once you're happy with the
 *     report.
 *
 *   Scenario 3 — Adding a third system
 *     A+B are live.  C is collected with collectOnly.  addConnector() links C's
 *     provisional canonicals, propagates Dave to A+B, propagates Carol to C.
 *     Verifies A=4, B=4, C=4 and 12 identity_map rows, then 0 ingest writes.
 *
 *   Scenario 4 — Deduplication proof
 *     Skips the collect phase and ingests all three systems directly without onboarding.
 *     Shows the explosion (duplicates), then runs the proper v9 flow and shows clean counts.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { SyncEngine, makeConnectorInstance } from "./engine.js";
import type { ChannelConfig } from "./engine.js";
import jsonfiles from "../../connectors/jsonfiles/src/index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(thisDir, "data");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writeJson(filePath: string, records: unknown[]): void {
  writeFileSync(filePath, JSON.stringify(records, null, 2), "utf8");
}

function readJson(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown[];
}

function resetState(dirs: string[], dbPath: string): void {
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(f)) rmSync(f);
  }
}

function printContacts(label: string, dir: string): void {
  const recs = readJson(join(dir, "contacts.json")) as Array<Record<string, unknown>>;
  console.log(`  ${label} (${recs.length}):`);
  for (const r of recs) console.log(`    [${r["_id"]}] ${r["name"]} <${r["email"]}>`);
}

const WEBHOOK = "http://localhost:14010";

function seedAB(dirA: string, dirB: string): void {
  writeJson(join(dirA, "contacts.json"), [
    { _id: "a1", name: "Alice Liddell", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "a2", name: "Bob Martin",    email: "bob@example.com",   _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "a3", name: "Carol White",   email: "carol@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
  ]);
  writeJson(join(dirB, "contacts.json"), [
    { _id: "b1", name: "Alice Liddell", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "b2", name: "Bob Martin",    email: "bob@example.com",   _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "b3", name: "Carol White",   email: "carol@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
  ]);
}

function seedAll(dirA: string, dirB: string, dirC: string): void {
  seedAB(dirA, dirB);
  writeJson(join(dirC, "contacts.json"), [
    { _id: "c1", name: "Alice Liddell", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "c2", name: "Bob Martin",    email: "bob@example.com",   _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "c3", name: "Dave Spencer",  email: "dave@example.com",  _updatedAt: "2025-01-01T00:00:00.000Z" },
  ]);
}

function makeABEngine(dbPath: string, dirA: string, dirB: string): SyncEngine {
  const db = openDb(dbPath);
  const channel: ChannelConfig = {
    id: "contacts-channel",
    members: [
      { connectorId: "system-a", entity: "contacts" },
      { connectorId: "system-b", entity: "contacts" },
    ],
    identityFields: ["email"],
  };
  return new SyncEngine({
    connectors: [
      makeConnectorInstance("system-a", jsonfiles, { filePaths: [join(dirA, "contacts.json")] }, {}, db, WEBHOOK),
      makeConnectorInstance("system-b", jsonfiles, { filePaths: [join(dirB, "contacts.json")] }, {}, db, WEBHOOK),
    ],
    channels: [channel],
  }, db);
}

function makeABCEngine(dbPath: string, dirA: string, dirB: string, dirC: string): SyncEngine {
  const db = openDb(dbPath);
  const channel: ChannelConfig = {
    id: "contacts-channel",
    members: [
      { connectorId: "system-a", entity: "contacts" },
      { connectorId: "system-b", entity: "contacts" },
      { connectorId: "system-c", entity: "contacts" },
    ],
    identityFields: ["email"],
  };
  return new SyncEngine({
    connectors: [
      makeConnectorInstance("system-a", jsonfiles, { filePaths: [join(dirA, "contacts.json")] }, {}, db, WEBHOOK),
      makeConnectorInstance("system-b", jsonfiles, { filePaths: [join(dirB, "contacts.json")] }, {}, db, WEBHOOK),
      makeConnectorInstance("system-c", jsonfiles, { filePaths: [join(dirC, "contacts.json")] }, {}, db, WEBHOOK),
    ],
    channels: [channel],
  }, db);
}

function ok(msg: string): void  { console.log(`  ✓  ${msg}`); }
function bad(msg: string): void { console.log(`  ✗  ${msg}`); }
function check(cond: boolean, passed: string, failed: string): void {
  if (cond) ok(passed); else bad(failed);
}

function dumpDb(dbPath: string, tablesDir: string): void {
  const db = openDb(dbPath);
  mkdirSync(tablesDir, { recursive: true });

  const JSON_COLS: Record<string, string[]> = {
    shadow_state:    ["canonical_data"],
    transaction_log: ["data_before", "data_after"],
    request_journal: ["request_headers"],
  };

  const DUMP_TABLES = [
    "identity_map",
    "watermarks",
    "shadow_state",
    "channel_onboarding_status",
    "onboarding_log",
    "transaction_log",
    "sync_runs",
  ] as const;

  console.log(`  [db dump] → ${tablesDir}/`);
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
    console.log(`    ${table}.json (${rows.length} rows)`);
  }
}

// ─── Scenario 1 — Collect → Discover → Onboard → Sync ────────────────────────

async function scenario1(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("SCENARIO 1 — Collect → Discover → Onboard → Sync (v9 model)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();

  const dirA  = join(dataDir, "v9-s1", "system-a");
  const dirB  = join(dataDir, "v9-s1", "system-b");
  const dbPath = join(dataDir, "v9-s1", "opensync.db");
  resetState([dirA, dirB], dbPath);
  seedAB(dirA, dirB);

  const engine = makeABEngine(dbPath, dirA, dirB);
  console.log(`  Status before: ${engine.channelStatus("contacts-channel")}`);

  // Step 1: collect
  console.log("  Collecting A (collectOnly: true) …");
  await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
  console.log("  Collecting B (collectOnly: true) …");
  await engine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
  console.log(`  Status after collect: ${engine.channelStatus("contacts-channel")}`);
  check(engine.channelStatus("contacts-channel") === "collected", "channel is 'collected'", "expected 'collected'");
  console.log();

  // Step 2: discover (reads from shadow_state — no connector I/O)
  console.log("  Running discover() [reads from DB only] …");
  const report = await engine.discover("contacts-channel");
  console.log(`  [discover] matched=${report.matched.length}  unique=${report.uniquePerSide.length}`);
  check(report.matched.length === 3, "3 matches found in DB", `expected 3, got ${report.matched.length}`);
  console.log();

  // Step 3: onboard (merges provisional canonicals)
  console.log("  Running onboard() [merges provisional canonicals] …");
  const result = await engine.onboard("contacts-channel", report);
  console.log(`  [onboard ] linked=${result.linked}  shadowsSeeded=${result.shadowsSeeded}`);
  const db = openDb(dbPath);
  const imRows = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
  console.log(`  identity_map rows: ${imRows}`);
  check(imRows === 6, "6 identity_map rows (3 canonicals × 2)", `expected 6, got ${imRows}`);
  console.log(`  Status after onboard: ${engine.channelStatus("contacts-channel")}`);
  check(engine.channelStatus("contacts-channel") === "ready", "channel is 'ready'", "expected 'ready'");
  console.log();

  // Step 4: normal ingest → 0 writes
  console.log("  Running normal ingest (should produce 0 writes) …");
  const engine2 = makeABEngine(dbPath, dirA, dirB);
  const r1 = await engine2.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() });
  const r2 = await engine2.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID() });
  const writes = [...r1.records, ...r2.records].filter((r) => r.action !== "skip").length;
  console.log(`  [ingest  ] ${writes} writes`);
  check(writes === 0, "zero writes — shadow state was pre-seeded during collect", `expected 0, got ${writes}`);
  console.log();

  dumpDb(dbPath, join(dataDir, "v9-s1", "tables"));
  console.log();
}

// ─── Scenario 2 — Discover is a free dry-run ─────────────────────────────────

async function scenario2(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("SCENARIO 2 — Discover is a free dry-run (call it as many times as you like)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();

  const dirA  = join(dataDir, "v9-s2", "system-a");
  const dirB  = join(dataDir, "v9-s2", "system-b");
  const dbPath = join(dataDir, "v9-s2", "opensync.db");
  resetState([dirA, dirB], dbPath);
  seedAB(dirA, dirB);

  const engine = makeABEngine(dbPath, dirA, dirB);

  await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
  await engine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });

  // Call discover() twice — no side effects, no DB writes
  console.log("  Calling discover() twice — it only reads from shadow_state …");
  const report1 = await engine.discover("contacts-channel");
  const report2 = await engine.discover("contacts-channel");

  check(
    report1.matched.length === report2.matched.length,
    `discover() is idempotent: matched=${report1.matched.length} both times`,
    "reports differ between calls",
  );

  const db = openDb(dbPath);
  const imBefore = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
  check(imBefore === 6, `identity_map has only provisional rows (${imBefore} — 3 per side)`, `expected 6, got ${imBefore}`);
  console.log("  No cross-links exist yet — discover() is truly read-only.");
  console.log();

  // Now commit by calling onboard()
  console.log("  Calling onboard() to commit …");
  await engine.onboard("contacts-channel", report1);
  const imAfter = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
  check(imAfter === 6, `identity_map still has 6 rows (provisionals merged, no extras)`, `expected 6, got ${imAfter}`);
  console.log();

  dumpDb(dbPath, join(dataDir, "v9-s2", "tables"));
  console.log();
}

// ─── Scenario 3 — Adding a third system ──────────────────────────────────────

async function scenario3(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("SCENARIO 3 — Adding a third system (collect C → addConnector)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();

  const dirA  = join(dataDir, "v9-s3", "system-a");
  const dirB  = join(dataDir, "v9-s3", "system-b");
  const dirC  = join(dataDir, "v9-s3", "system-c");
  const dbPath = join(dataDir, "v9-s3", "opensync.db");
  resetState([dirA, dirB, dirC], dbPath);
  seedAll(dirA, dirB, dirC);

  console.log("  Initial data:");
  printContacts("system-a", dirA);
  printContacts("system-b", dirB);
  printContacts("system-c (before linking)", dirC);
  console.log();

  // Phase 1: v9 onboard A+B
  let engine = makeABEngine(dbPath, dirA, dirB);
  await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
  await engine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
  const abReport = await engine.discover("contacts-channel");
  await engine.onboard("contacts-channel", abReport);
  console.log("  A+B onboarded (3 canonicals linked, channel ready).");
  console.log();

  // Phase 2: collect C, dry-run, then commit
  const engineABC = makeABCEngine(dbPath, dirA, dirB, dirC);
  console.log("  Collecting C (collectOnly: true) …");
  await engineABC.ingest("contacts-channel", "system-c", { batchId: crypto.randomUUID(), collectOnly: true });
  console.log(`  Status after collecting C: ${engineABC.channelStatus("contacts-channel")}`);
  check(engineABC.channelStatus("contacts-channel") === "ready", "channel stays 'ready' (A+B cross-linked; C not yet committed)", "expected 'ready'");
  console.log();

  console.log("  Dry-run addConnector …");
  const dryRun = await engineABC.addConnector("contacts-channel", "system-c", { dryRun: true });
  console.log(`  [dry-run] linked=${dryRun.summary.linked}  newFromJoiner=${dryRun.summary.newFromJoiner}  missingInJoiner=${dryRun.summary.missingInJoiner}`);
  const db = openDb(dbPath);
  const imDry = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
  check(imDry === 9, `identity_map unchanged after dry-run (${imDry} = 6 A+B + 3 C provisionals)`, `expected 9, got ${imDry}`);
  console.log();

  console.log("  Live addConnector …");
  await engineABC.addConnector("contacts-channel", "system-c");
  console.log(`  Status after addConnector: ${engineABC.channelStatus("contacts-channel")}`);
  check(engineABC.channelStatus("contacts-channel") === "ready", "channel is 'ready'", "expected 'ready'");

  const imFinal = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
  check(imFinal === 12, `12 identity_map rows (4 canonicals × 3)`, `expected 12, got ${imFinal}`);
  console.log();

  console.log("  After addConnector:");
  printContacts("system-a", dirA);
  printContacts("system-b", dirB);
  printContacts("system-c", dirC);
  console.log();

  check((readJson(join(dirA, "contacts.json")) as unknown[]).length === 4, "system-a has 4 records", "a≠4");
  check((readJson(join(dirB, "contacts.json")) as unknown[]).length === 4, "system-b has 4 records", "b≠4");
  check((readJson(join(dirC, "contacts.json")) as unknown[]).length === 4, "system-c has 4 records", "c≠4");
  console.log();

  console.log("  Running ingest for all 3 connectors (should produce 0 writes) …");
  const engine2 = makeABCEngine(dbPath, dirA, dirB, dirC);
  const [r1, r2, r3] = await Promise.all([
    engine2.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() }),
    engine2.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID() }),
    engine2.ingest("contacts-channel", "system-c", { batchId: crypto.randomUUID() }),
  ]);
  const writes = [...r1.records, ...r2.records, ...r3.records].filter((r) => r.action !== "skip").length;
  check(writes === 0, "0 writes across all 3 connectors", `expected 0, got ${writes}`);
  console.log();

  dumpDb(dbPath, join(dataDir, "v9-s3", "tables"));
  console.log();
}

// ─── Scenario 4 — Deduplication proof ────────────────────────────────────────

async function scenario4(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("SCENARIO 4 — Deduplication proof (bad path vs v9 correct path)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();

  // 4a: bad path — direct ingest without collect→discover→onboard
  console.log("  ── 4a: Direct ingest without onboarding (produces duplicates) ──");
  const d = join(dataDir, "v9-s4a");
  const dirA = join(d, "system-a"); const dirB = join(d, "system-b");
  const dbPath = join(d, "opensync.db");
  resetState([dirA, dirB], dbPath);
  seedAB(dirA, dirB);

  const badEngine = makeABEngine(dbPath, dirA, dirB);
  await badEngine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() });
  await badEngine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID() });

  const aLen = (readJson(join(dirA, "contacts.json")) as unknown[]).length;
  const bLen = (readJson(join(dirB, "contacts.json")) as unknown[]).length;
  console.log(`  system-a: ${aLen} records  system-b: ${bLen} records`);
  bad(`system-a: ${aLen - 3} duplicate(s) created`);
  bad(`system-b: ${bLen - 3} duplicate(s) created`);
  console.log();

  // 4b: correct v9 path
  console.log("  ── 4b: v9 Collect → Discover → Onboard → Sync ──");
  const d2 = join(dataDir, "v9-s4b");
  const dirA2 = join(d2, "system-a"); const dirB2 = join(d2, "system-b");
  const dbPath2 = join(d2, "opensync.db");
  resetState([dirA2, dirB2], dbPath2);
  seedAB(dirA2, dirB2);

  const goodEngine = makeABEngine(dbPath2, dirA2, dirB2);
  await goodEngine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
  await goodEngine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
  const report = await goodEngine.discover("contacts-channel");
  await goodEngine.onboard("contacts-channel", report);

  const aLen2 = (readJson(join(dirA2, "contacts.json")) as unknown[]).length;
  const bLen2 = (readJson(join(dirB2, "contacts.json")) as unknown[]).length;
  console.log(`  system-a: ${aLen2} records  system-b: ${bLen2} records`);
  check(aLen2 === 3, "system-a: exactly 3 records", `expected 3, got ${aLen2}`);
  check(bLen2 === 3, "system-b: exactly 3 records", `expected 3, got ${bLen2}`);
  console.log();

  dumpDb(dbPath2, join(dataDir, "v9-s4b", "tables"));
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
