/**
 * POC v7 manual runner — demonstrates the onboarding problem and its fix.
 *
 * Usage:
 *   bun poc/v7/run.ts
 *
 * Runs three scenarios in sequence:
 *
 *   Scenario A — The Bug
 *     Two systems already have the same 3 contacts (different IDs, same name/email).
 *     Ingest without onboarding → 6 records per file (3 duplicates each).
 *
 *   Scenario B — Happy Path
 *     Same starting data. discover() → onboard() → ingest().
 *     Result: 3 skipped, 0 inserts. Edit one record → 1 update.
 *
 *   Scenario C — Fresh Onboarding (one side only)
 *     system-a has 3 contacts, system-b is empty.
 *     discover() → onboard() with propagateUnique:true → system-b gets 3 records.
 *     Follow-up ingest() → 0 inserts.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { SyncEngine, makeConnectorInstance, OnboardingRequiredError } from "./engine.js";
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

function resetState(dirA: string, dirB: string, dbPath: string): void {
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(f)) rmSync(f);
  }
}

function seedBoth(dirA: string, dirB: string): void {
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

function printFile(label: string, filePath: string): void {
  const records = readJson(filePath) as Array<Record<string, unknown>>;
  console.log(`  ${label} (${records.length} records):`);
  for (const r of records) {
    console.log(`    [${r["_id"]}] ${r["name"]} <${r["email"]}>`);
  }
}

function makeSetup(dirA: string, dirB: string, dbPath: string, webhookBaseUrl = "http://localhost:14007") {
  const db = openDb(dbPath);
  const instanceA = makeConnectorInstance(
    "system-a",
    jsonfiles,
    { filePaths: [join(dirA, "contacts.json")] },
    {},
    db,
    webhookBaseUrl,
  );
  const instanceB = makeConnectorInstance(
    "system-b",
    jsonfiles,
    { filePaths: [join(dirB, "contacts.json")] },
    {},
    db,
    webhookBaseUrl,
  );
  const engine = new SyncEngine({
    connectors: [instanceA, instanceB],
    channels: [{
      id: "contacts-channel",
      members: [
        { connectorId: "system-a", entity: "contacts" },
        { connectorId: "system-b", entity: "contacts" },
      ],
      identityFields: ["email"],
    }],
  }, db);
  return { db, engine };
}

// ─── Scenario A — The Bug ─────────────────────────────────────────────────────

async function scenarioA(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("SCENARIO A — The Bug (ingest without onboarding)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();

  const dirA  = join(dataDir, "scenario-a", "system-a");
  const dirB  = join(dataDir, "scenario-a", "system-b");
  const dbPath = join(dataDir, "scenario-a", "opensync.db");
  resetState(dirA, dirB, dbPath);
  seedBoth(dirA, dirB);

  console.log("Starting data (same 3 contacts on both sides, different IDs):");
  printFile("system-a", join(dirA, "contacts.json"));
  printFile("system-b", join(dirB, "contacts.json"));
  console.log();

  const { engine } = makeSetup(dirA, dirB, dbPath);

  // Bypass the guard to demonstrate the bug
  console.log("Running ingest from system-a (skipOnboardingCheck: true) ...");
  await engine.ingest("contacts-channel", "system-a", {
    batchId: crypto.randomUUID(),
    skipOnboardingCheck: true,
  });

  console.log("Running ingest from system-b (skipOnboardingCheck: true) ...");
  await engine.ingest("contacts-channel", "system-b", {
    batchId: crypto.randomUUID(),
    skipOnboardingCheck: true,
  });

  console.log();
  console.log("Result — DUPLICATES:");
  printFile("system-a", join(dirA, "contacts.json"));
  printFile("system-b", join(dirB, "contacts.json"));
  console.log();
  const aLen = (readJson(join(dirA, "contacts.json")) as unknown[]).length;
  const bLen = (readJson(join(dirB, "contacts.json")) as unknown[]).length;
  console.log(`  ❌  system-a: ${aLen} records (expected 3, got ${aLen - 3} duplicates)`);
  console.log(`  ❌  system-b: ${bLen} records (expected 3, got ${bLen - 3} duplicates)`);
  console.log();
}

// ─── Scenario B — Happy Path ──────────────────────────────────────────────────

async function scenarioB(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("SCENARIO B — Happy Path (discover → onboard → ingest)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();

  const dirA  = join(dataDir, "scenario-b", "system-a");
  const dirB  = join(dataDir, "scenario-b", "system-b");
  const dbPath = join(dataDir, "scenario-b", "opensync.db");
  resetState(dirA, dirB, dbPath);
  seedBoth(dirA, dirB);

  let { engine } = makeSetup(dirA, dirB, dbPath);

  // Verify guard fires
  console.log("Attempting ingest without onboarding (should throw) ...");
  try {
    await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() });
    console.log("  ❌  No error thrown — this should not happen");
  } catch (err) {
    if (err instanceof OnboardingRequiredError) {
      console.log(`  ✓  Correctly blocked: ${err.message}`);
    } else {
      throw err;
    }
  }
  console.log();

  // Discover
  console.log("Running discover() ...");
  const report = await engine.discover("contacts-channel");
  console.log(`  Matched: ${report.matched.length}`);
  console.log(`  Unique:  ${report.uniquePerSide.length}`);
  for (const [id, s] of Object.entries(report.summary)) {
    console.log(`  ${id}: total=${s.total}, matched=${s.matched}, unique=${s.unique}`);
  }
  console.log();

  // Onboard
  console.log("Running onboard() ...");
  const onboardResult = await engine.onboard("contacts-channel", report);
  console.log(`  Linked:         ${onboardResult.linked}`);
  console.log(`  Shadows seeded: ${onboardResult.shadowsSeeded}`);
  console.log(`  Unique queued:  ${onboardResult.uniqueQueued}`);
  console.log(`  Channel status: ${engine.channelStatus("contacts-channel")}`);
  console.log();

  // First ingest after onboarding
  console.log("Running ingest from system-a (incremental) ...");
  const r1 = await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() });
  const actions1 = r1.records.reduce<Record<string, number>>((acc, r) => {
    acc[r.action] = (acc[r.action] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  Actions: ${JSON.stringify(actions1)}`);
  console.log(`  Records in system-b: ${(readJson(join(dirB, "contacts.json")) as unknown[]).length}`);
  console.log();

  // Edit Alice in system-a
  console.log("Editing Alice's email in system-a ...");
  const contacts = readJson(join(dirA, "contacts.json")) as Array<Record<string, unknown>>;
  const alice = contacts.find((c) => c["email"] === "alice@example.com")!;
  alice["email"] = "alice@updated.com";
  alice["_updatedAt"] = new Date().toISOString();
  writeJson(join(dirA, "contacts.json"), contacts);
  await new Promise((r) => setTimeout(r, 5));

  console.log("Running incremental ingest from system-a after edit ...");

  // Re-create engine to use fresh instances (watermark is in DB already)
  ({ engine } = makeSetup(dirA, dirB, dbPath));
  const r2 = await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() });
  const actions2 = r2.records.reduce<Record<string, number>>((acc, r) => {
    acc[r.action] = (acc[r.action] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  Actions: ${JSON.stringify(actions2)}`);

  const bAfter = readJson(join(dirB, "contacts.json")) as Array<Record<string, unknown>>;
  const aliceB = bAfter.find((c) => c["email"] === "alice@updated.com");
  console.log(`  Alice's email in system-b: ${aliceB?.["email"] ?? "(not updated)"}`);
  console.log();

  console.log("Result:");
  printFile("system-a", join(dirA, "contacts.json"));
  printFile("system-b", join(dirB, "contacts.json"));
  console.log();
  console.log(`  ✓  system-a: ${contacts.length} records (no duplicates)`);
  console.log(`  ✓  system-b: ${bAfter.length} records (no duplicates)`);
  console.log();
}

// ─── Scenario C — Fresh Onboarding (one side only) ───────────────────────────

async function scenarioC(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("SCENARIO C — Fresh Onboarding (system-a has data, system-b empty)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();

  const dirA  = join(dataDir, "scenario-c", "system-a");
  const dirB  = join(dataDir, "scenario-c", "system-b");
  const dbPath = join(dataDir, "scenario-c", "opensync.db");
  resetState(dirA, dirB, dbPath);

  writeJson(join(dirA, "contacts.json"), [
    { _id: "a1", name: "Alice Liddell", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "a2", name: "Bob Martin",    email: "bob@example.com",   _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "a3", name: "Carol White",   email: "carol@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
  ]);
  writeJson(join(dirB, "contacts.json"), []);

  console.log("Starting data:");
  printFile("system-a", join(dirA, "contacts.json"));
  console.log("  system-b: (empty)");
  console.log();

  const { engine } = makeSetup(dirA, dirB, dbPath);

  // Discover — system-b is empty so no matches, all unique on side A
  console.log("Running discover() ...");
  const report = await engine.discover("contacts-channel");
  console.log(`  Matched: ${report.matched.length}`);
  console.log(`  Unique:  ${report.uniquePerSide.length} (all in system-a)`);
  console.log();

  // Onboard with propagateUnique: true (default) — creates records in system-b
  console.log("Running onboard() with propagateUnique: true (default) ...");
  const onboardResult = await engine.onboard("contacts-channel", report);
  console.log(`  Unique queued (created in system-b): ${onboardResult.uniqueQueued}`);
  console.log();

  console.log("After onboarding:");
  printFile("system-b", join(dirB, "contacts.json"));
  console.log();

  // Follow-up ingest — should produce 0 inserts
  console.log("Running incremental ingest from system-a ...");
  const r = await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() });
  const inserts = r.records.filter((x) => x.action === "insert").length;
  console.log(`  Inserts: ${inserts}`);
  console.log();

  console.log("Result:");
  printFile("system-a", join(dirA, "contacts.json"));
  printFile("system-b", join(dirB, "contacts.json"));
  console.log();
  console.log(`  ✓  system-b created ${(readJson(join(dirB, "contacts.json")) as unknown[]).length} records via onboarding`);
  console.log(`  ✓  Follow-up ingest produced ${inserts} inserts`);
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  await scenarioA();
  await scenarioB();
  await scenarioC();
  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
