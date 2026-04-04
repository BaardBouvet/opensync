/**
 * POC v8 manual runner — demonstrates three-way onboarding and deduplication.
 *
 * Usage:
 *   bun poc/v8/run.ts
 *
 * Runs four scenarios in sequence:
 *
 *   Scenario 1 — Clean Two-System Onboard (v7 rerun)
 *     discover() + onboard() A↔B, verify 3 canonicals, run ingest → 0 writes.
 *
 *   Scenario 2 — Dry-Run addConnector
 *     addConnector(…, { dryRun: true }) → linked=2, newFromJoiner=1, missingInJoiner=1.
 *     Confirm that identity_map row count is unchanged.
 *
 *   Scenario 3 — Live addConnector
 *     addConnector(…) writes all links and propagates records in both directions.
 *     System A, B, and C each end up with exactly 4 records, 12 identity_map rows.
 *     Follow-up ingest across all 3 connectors → zero writes.
 *
 *   Scenario 4 — Deduplication Proof
 *     Demonstrates what happens without onboarding (duplicates), then the correct flow.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { SyncEngine, makeConnectorInstance, OnboardingRequiredError } from "./engine.js";
import type { ChannelConfig } from "./engine.js";
import jsonfiles from "../../connectors/jsonfiles/src/index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(thisDir, "data");

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  const records = readJson(join(dir, "contacts.json")) as Array<Record<string, unknown>>;
  console.log(`  ${label} (${records.length}):`);
  for (const r of records) {
    console.log(`    [${r["_id"]}] ${r["name"]} <${r["email"]}>`);
  }
}

const WEBHOOK = "http://localhost:14009";

/** Three-system data as described in the plan. */
function seedAll(dirA: string, dirB: string, dirC: string): void {
  // A: Alice, Bob, Carol
  writeJson(join(dirA, "contacts.json"), [
    { _id: "a1", name: "Alice Liddell", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "a2", name: "Bob Martin",    email: "bob@example.com",   _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "a3", name: "Carol White",   email: "carol@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
  ]);
  // B: same entities, different IDs
  writeJson(join(dirB, "contacts.json"), [
    { _id: "b1", name: "Alice Liddell", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "b2", name: "Bob Martin",    email: "bob@example.com",   _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "b3", name: "Carol White",   email: "carol@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
  ]);
  // C: Alice + Bob (overlap) + Dave (new) — Carol is missing
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

function check(condition: boolean, passed: string, failed: string): void {
  if (condition) ok(passed); else bad(failed);
}

// ─── Scenario 1 — Clean Two-System Onboard ───────────────────────────────────

async function scenario1(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("SCENARIO 1 — Clean A↔B onboard (v7 rerun)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();

  const dirA  = join(dataDir, "v8-s1", "system-a");
  const dirB  = join(dataDir, "v8-s1", "system-b");
  const dbPath = join(dataDir, "v8-s1", "opensync.db");
  resetState([dirA, dirB], dbPath);
  // Seed A and B with the same 3 contacts (different IDs, identical email)
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

  const engine = makeABEngine(dbPath, dirA, dirB);

  console.log("Starting data:");
  printContacts("system-a", dirA);
  printContacts("system-b", dirB);
  console.log();

  console.log("Running discover() ...");
  const report = await engine.discover("contacts-channel");
  console.log(`  [discover] matched=${report.matched.length}  unique=${report.uniquePerSide.length}`);
  check(report.matched.length === 3, "3 matches found", `expected 3, got ${report.matched.length}`);
  console.log();

  console.log("Running onboard() ...");
  const onboard = await engine.onboard("contacts-channel", report);
  console.log(`  [onboard ] linked=${onboard.linked}  shadowsSeeded=${onboard.shadowsSeeded}  queued=${onboard.uniqueQueued}`);
  check(onboard.linked === 6, "6 identity links written (3 canonicals × 2 sides)", `expected 6, got ${onboard.linked}`);
  const status = engine.channelStatus("contacts-channel");
  console.log(`  [status  ] ${status}`);
  check(status === "ready", "channel is ready", `expected ready, got ${status}`);
  console.log();

  console.log("Running ingest() (should produce 0 writes) ...");
  const r1 = await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() });
  const r2 = await engine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID() });
  const writes = [...r1.records, ...r2.records].filter((r) => r.action !== "skip").length;
  console.log(`  [ingest  ] ${writes} writes`);
  check(writes === 0, "zero writes after onboarding", `expected 0 writes, got ${writes}`);
  console.log();
}

// ─── Scenario 2 — Dry-Run addConnector ───────────────────────────────────────

async function scenario2(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("SCENARIO 2 — Dry-run addConnector (no DB writes)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();

  const dirA  = join(dataDir, "v8-s2", "system-a");
  const dirB  = join(dataDir, "v8-s2", "system-b");
  const dirC  = join(dataDir, "v8-s2", "system-c");
  const dbPath = join(dataDir, "v8-s2", "opensync.db");
  resetState([dirA, dirB, dirC], dbPath);
  seedAll(dirA, dirB, dirC);

  // Phase 1: onboard A+B
  const engineAB = makeABEngine(dbPath, dirA, dirB);
  const report = await engineAB.discover("contacts-channel");
  await engineAB.onboard("contacts-channel", report);
  const db = openDb(dbPath);
  const imAfterAB = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
  console.log(`  A+B onboarded. identity_map has ${imAfterAB} rows.`);
  console.log();

  // Phase 2: dry-run addConnector for C
  const engineABC = makeABCEngine(dbPath, dirA, dirB, dirC);
  const dryRun = await engineABC.addConnector("contacts-channel", "system-c", { dryRun: true });

  console.log("  [dry-run]");
  console.log(`    linked=${dryRun.summary.linked}  newFromJoiner=${dryRun.summary.newFromJoiner}  missingInJoiner=${dryRun.summary.missingInJoiner}`);
  console.log(`    linked records: ${dryRun.linked.map((l) => l.externalId).join(", ")}`);
  console.log(`    newFromJoiner:  ${dryRun.newFromJoiner.map((n) => n.externalId).join(", ")}`);
  console.log(`    missingInJoiner: ${dryRun.missingInJoiner.map((m) => m.canonicalId).join(", ")}`);
  console.log();

  check(dryRun.summary.linked === 2, "linked=2 (Alice+Bob)", `expected 2, got ${dryRun.summary.linked}`);
  check(dryRun.summary.newFromJoiner === 1, "newFromJoiner=1 (Dave)", `expected 1, got ${dryRun.summary.newFromJoiner}`);
  check(dryRun.summary.missingInJoiner === 1, "missingInJoiner=1 (Carol)", `expected 1, got ${dryRun.summary.missingInJoiner}`);

  const imAfterDryRun = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
  check(imAfterDryRun === imAfterAB, `identity_map unchanged (${imAfterAB} rows)`, `expected ${imAfterAB}, got ${imAfterDryRun}`);
  console.log();
}

// ─── Scenario 3 — Live addConnector ──────────────────────────────────────────

async function scenario3(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("SCENARIO 3 — Live addConnector (full three-way onboard)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();

  const dirA  = join(dataDir, "v8-s3", "system-a");
  const dirB  = join(dataDir, "v8-s3", "system-b");
  const dirC  = join(dataDir, "v8-s3", "system-c");
  const dbPath = join(dataDir, "v8-s3", "opensync.db");
  resetState([dirA, dirB, dirC], dbPath);
  seedAll(dirA, dirB, dirC);

  console.log("Initial data:");
  printContacts("system-a", dirA);
  printContacts("system-b", dirB);
  printContacts("system-c (before addConnector)", dirC);
  console.log();

  // Phase 1: onboard A+B
  const engineAB = makeABEngine(dbPath, dirA, dirB);
  const report = await engineAB.discover("contacts-channel");
  await engineAB.onboard("contacts-channel", report);
  console.log("  A+B onboarded (3 canonicals linked).");
  console.log();

  // Phase 2: live addConnector for C
  const engineABC = makeABCEngine(dbPath, dirA, dirB, dirC);
  const addReport = await engineABC.addConnector("contacts-channel", "system-c");

  console.log("  [addConnector]");
  console.log(`    linked=${addReport.summary.linked}  newFromJoiner=${addReport.summary.newFromJoiner}  missingInJoiner=${addReport.summary.missingInJoiner}`);
  check(addReport.summary.linked === 2, "linked=2 (Alice+Bob)", `expected 2, got ${addReport.summary.linked}`);
  check(addReport.summary.newFromJoiner === 1, "newFromJoiner=1 (Dave)", `expected 1, got ${addReport.summary.newFromJoiner}`);
  check(addReport.summary.missingInJoiner === 1, "missingInJoiner=1 (Carol)", `expected 1, got ${addReport.summary.missingInJoiner}`);
  console.log();

  const statusPost = engineABC.channelStatus("contacts-channel");
  console.log(`  [status] ${statusPost}`);
  check(statusPost === "ready", "channel is ready", `expected ready, got ${statusPost}`);
  console.log();

  console.log("  After addConnector:");
  printContacts("system-a", dirA);
  printContacts("system-b", dirB);
  printContacts("system-c", dirC);
  console.log();

  const aLen = (readJson(join(dirA, "contacts.json")) as unknown[]).length;
  const bLen = (readJson(join(dirB, "contacts.json")) as unknown[]).length;
  const cLen = (readJson(join(dirC, "contacts.json")) as unknown[]).length;
  check(aLen === 4, `system-a has 4 records (got ${aLen})`, `expected 4, got ${aLen}`);
  check(bLen === 4, `system-b has 4 records (got ${bLen})`, `expected 4, got ${bLen}`);
  check(cLen === 4, `system-c has 4 records (got ${cLen})`, `expected 4, got ${cLen}`);

  const db = openDb(dbPath);
  const imRows = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
  console.log(`  identity_map rows: ${imRows}`);
  check(imRows === 12, "12 identity_map rows (4 canonicals × 3 connectors)", `expected 12, got ${imRows}`);
  console.log();

  // Phase 3: ingest across all 3 connectors — expect zero writes
  console.log("  Running ingest() for all 3 connectors ...");
  const enginePost = makeABCEngine(dbPath, dirA, dirB, dirC);
  const [ir1, ir2, ir3] = await Promise.all([
    enginePost.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() }),
    enginePost.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID() }),
    enginePost.ingest("contacts-channel", "system-c", { batchId: crypto.randomUUID() }),
  ]);
  const totalWrites = [...ir1.records, ...ir2.records, ...ir3.records].filter((r) => r.action !== "skip").length;
  console.log(`  [ingest  ] ${totalWrites} writes across all 3 connectors`);
  check(totalWrites === 0, "zero writes after addConnector", `expected 0, got ${totalWrites}`);
  console.log();
}

// ─── Scenario 4 — Deduplication Proof ────────────────────────────────────────

async function scenario4(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("SCENARIO 4 — Deduplication proof (without vs with onboarding)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();

  // ── 4a: The bad path — ingest without onboarding ──

  console.log("  ── 4a: Without onboarding (skipOnboardingCheck: true) ──");
  console.log();

  const dirA = join(dataDir, "v8-s4a", "system-a");
  const dirB = join(dataDir, "v8-s4a", "system-b");
  const dirC = join(dataDir, "v8-s4a", "system-c");
  const dbPath = join(dataDir, "v8-s4a", "opensync.db");
  resetState([dirA, dirB, dirC], dbPath);
  seedAll(dirA, dirB, dirC);

  const engineBad = makeABCEngine(dbPath, dirA, dirB, dirC);
  const bg1 = crypto.randomUUID();
  await engineBad.ingest("contacts-channel", "system-a", { batchId: bg1, skipOnboardingCheck: true });
  await engineBad.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), skipOnboardingCheck: true });
  await engineBad.ingest("contacts-channel", "system-c", { batchId: crypto.randomUUID(), skipOnboardingCheck: true });

  const aLenBad = (readJson(join(dirA, "contacts.json")) as unknown[]).length;
  const bLenBad = (readJson(join(dirB, "contacts.json")) as unknown[]).length;
  const cLenBad = (readJson(join(dirC, "contacts.json")) as unknown[]).length;
  console.log(`  Result — DUPLICATES:`);
  console.log(`    system-a: ${aLenBad} records (expected 4, got ${aLenBad - 4} extra)`);
  console.log(`    system-b: ${bLenBad} records (expected 4, got ${bLenBad - 4} extra)`);
  console.log(`    system-c: ${cLenBad} records (expected 4, got ${cLenBad - 4} extra)`);
  bad(`system-a has ${aLenBad - 4} duplicate(s)`);
  bad(`system-b has ${bLenBad - 4} duplicate(s)`);
  bad(`system-c has ${cLenBad - 4} duplicate(s)`);
  console.log();

  // ── 4b: The correct path — discover + onboard + addConnector ──

  console.log("  ── 4b: With proper addConnector flow ──");
  console.log();

  const dirA2 = join(dataDir, "v8-s4b", "system-a");
  const dirB2 = join(dataDir, "v8-s4b", "system-b");
  const dirC2 = join(dataDir, "v8-s4b", "system-c");
  const dbPath2 = join(dataDir, "v8-s4b", "opensync.db");
  resetState([dirA2, dirB2, dirC2], dbPath2);
  seedAll(dirA2, dirB2, dirC2);

  const engineAB2 = makeABEngine(dbPath2, dirA2, dirB2);
  const rep2 = await engineAB2.discover("contacts-channel");
  await engineAB2.onboard("contacts-channel", rep2);

  const engineABC2 = makeABCEngine(dbPath2, dirA2, dirB2, dirC2);
  await engineABC2.addConnector("contacts-channel", "system-c");

  const aLen2 = (readJson(join(dirA2, "contacts.json")) as unknown[]).length;
  const bLen2 = (readJson(join(dirB2, "contacts.json")) as unknown[]).length;
  const cLen2 = (readJson(join(dirC2, "contacts.json")) as unknown[]).length;

  console.log(`  Result — NO DUPLICATES:`);
  console.log(`    system-a: ${aLen2} records`);
  console.log(`    system-b: ${bLen2} records`);
  console.log(`    system-c: ${cLen2} records`);
  check(aLen2 === 4, `system-a: exactly 4 records`, `expected 4, got ${aLen2}`);
  check(bLen2 === 4, `system-b: exactly 4 records`, `expected 4, got ${bLen2}`);
  check(cLen2 === 4, `system-c: exactly 4 records`, `expected 4, got ${cLen2}`);
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
