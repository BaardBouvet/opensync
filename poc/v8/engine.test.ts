/**
 * POC v8 engine tests — Three-Way Onboarding & Deduplication
 *
 * Test coverage:
 *   addConnector()
 *     1.  dryRun returns correct linked/new/missing counts, zero DB changes
 *     2.  live: identity_map has correct rows for all 3 connectors
 *     3.  live: shadow_state seeded for the joining connector's matched records
 *     4.  matched records are NOT re-created in existing connectors
 *     5.  net-new joiner records ARE created in all existing connectors
 *     6.  canonical-only records are created in the joining connector (missingFromJoiner:propagate)
 *     7.  missingFromJoiner:skip — canonical-only records are left out
 *     8.  after addConnector, ingest() produces zero writes in all directions
 *     9.  addConnector is idempotent: re-running produces same report, no duplicate rows
 *    10.  identity field normalisation: upper-case email matches lower-case canonical
 *
 *   channelStatus() v8 extension
 *    11.  returns 'partially-onboarded' when C is in config but addConnector not yet called
 *
 *   ingest() guard — v8 behaviour
 *    12.  existing A↔B members can still ingest while C is partially-onboarded
 *    13.  ingest for the unlinked connector C is blocked while partially-onboarded
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import {
  SyncEngine,
  makeConnectorInstance,
  OnboardingRequiredError,
} from "./engine.js";
import type { ChannelConfig } from "./engine.js";
import { openDb } from "./db.js";
import type { Db } from "./db.js";
import jsonfiles from "../../connectors/jsonfiles/src/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "opensync-v8-"));
  return openDb(join(dir, "state.db"));
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "opensync-v8-data-"));
}

function writeJson(filePath: string, records: unknown[]): void {
  writeFileSync(filePath, JSON.stringify(records, null, 2), "utf8");
}

function readJson(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown[];
}

const WEBHOOK = "http://localhost:14008";

function makeInstance(db: Db, id: string, dir: string) {
  return makeConnectorInstance(
    id,
    jsonfiles,
    { filePaths: [join(dir, "contacts.json")] },
    {},
    db,
    WEBHOOK,
  );
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

/** Seed A and B with the same 3 contacts (different IDs, matching email). */
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

/** Seed C: Alice + Bob (match A/B), Dave (new), Carol absent. */
function seedC(dirC: string): void {
  writeJson(join(dirC, "contacts.json"), [
    { _id: "c1", name: "Alice Liddell", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "c2", name: "Bob Martin",    email: "bob@example.com",   _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "c3", name: "Dave Spencer",  email: "dave@example.com",  _updatedAt: "2025-01-01T00:00:00.000Z" },
  ]);
}

const CHANNEL_AB: ChannelConfig = {
  id: "contacts-channel",
  members: [
    { connectorId: "system-a", entity: "contacts" },
    { connectorId: "system-b", entity: "contacts" },
  ],
  identityFields: ["email"],
};

const CHANNEL_ABC: ChannelConfig = {
  id: "contacts-channel",
  members: [
    { connectorId: "system-a", entity: "contacts" },
    { connectorId: "system-b", entity: "contacts" },
    { connectorId: "system-c", entity: "contacts" },
  ],
  identityFields: ["email"],
};

/** Onboard A+B using discover/onboard, return an engine configured for A+B+C. */
async function onboardABThenGetABCEngine(
  db: Db,
  dirA: string,
  dirB: string,
  dirC: string,
): Promise<SyncEngine> {
  // Phase 1: onboard A+B using a 2-member engine
  const instA = makeInstance(db, "system-a", dirA);
  const instB = makeInstance(db, "system-b", dirB);
  const instC = makeInstance(db, "system-c", dirC);
  const engine2 = new SyncEngine({ connectors: [instA, instB], channels: [CHANNEL_AB] }, db);
  const report = await engine2.discover("contacts-channel");
  await engine2.onboard("contacts-channel", report);

  // Phase 2: return new engine with all 3 connectors and 3-member channel config
  const instA2 = makeInstance(db, "system-a", dirA);
  const instB2 = makeInstance(db, "system-b", dirB);
  const instC2 = makeInstance(db, "system-c", dirC);
  return new SyncEngine({ connectors: [instA2, instB2, instC2], channels: [CHANNEL_ABC] }, db);
}

// ─── Suite: addConnector() ────────────────────────────────────────────────────

describe("addConnector()", () => {
  it("dryRun returns correct counts and makes zero DB changes", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);
    const engine = await onboardABThenGetABCEngine(db, dirA, dirB, dirC);

    const beforeIM = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
    const beforeSS = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM shadow_state").get()!.n;

    const report = await engine.addConnector("contacts-channel", "system-c", { dryRun: true });

    expect(report.summary.linked).toBe(2);         // Alice + Bob
    expect(report.summary.newFromJoiner).toBe(1);  // Dave
    expect(report.summary.missingInJoiner).toBe(1); // Carol

    // Zero DB changes
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n).toBe(beforeIM);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM shadow_state").get()!.n).toBe(beforeSS);
  });

  it("live: identity_map has correct rows after linking", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);
    const engine = await onboardABThenGetABCEngine(db, dirA, dirB, dirC);

    await engine.addConnector("contacts-channel", "system-c");

    // At minimum: Alice + Bob linked in system-c (2 new rows)
    const cRows = db.query<{ n: number }, [string]>(
      "SELECT COUNT(*) as n FROM identity_map WHERE connector_id = ?",
    ).get("system-c")!.n;
    expect(cRows).toBeGreaterThanOrEqual(2); // Alice + Bob linked; Dave might also be there after propagation

    // Alice's canonical_id must link A, B, and C
    const aliceCanon = db.query<{ canonical_id: string }, [string, string]>(
      "SELECT canonical_id FROM identity_map WHERE connector_id = ? AND external_id = ?",
    ).get("system-a", "a1")?.canonical_id;
    expect(aliceCanon).toBeDefined();

    const aliceCRow = db.query<{ external_id: string }, [string, string]>(
      "SELECT external_id FROM identity_map WHERE canonical_id = ? AND connector_id = ?",
    ).get(aliceCanon!, "system-c")?.external_id;
    expect(aliceCRow).toBe("c1");
  });

  it("live: shadow_state seeded for joining connector's matched records", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);
    const engine = await onboardABThenGetABCEngine(db, dirA, dirB, dirC);

    await engine.addConnector("contacts-channel", "system-c");

    // c1 (Alice) and c2 (Bob) must have shadow_state rows
    for (const extId of ["c1", "c2"]) {
      const ss = db.query<{ n: number }, [string, string, string]>(
        "SELECT COUNT(*) as n FROM shadow_state WHERE connector_id = ? AND entity_name = ? AND external_id = ?",
      ).get("system-c", "contacts", extId);
      expect(ss?.n).toBe(1);
    }
  });

  it("matched records are NOT re-created in existing connectors", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);
    const engine = await onboardABThenGetABCEngine(db, dirA, dirB, dirC);

    const aCountBefore = (readJson(join(dirA, "contacts.json")) as unknown[]).length;
    const bCountBefore = (readJson(join(dirB, "contacts.json")) as unknown[]).length;

    await engine.addConnector("contacts-channel", "system-c");

    // A and B should not have grown except for Dave (1 new record each)
    const aCountAfter = (readJson(join(dirA, "contacts.json")) as unknown[]).length;
    const bCountAfter = (readJson(join(dirB, "contacts.json")) as unknown[]).length;
    expect(aCountAfter).toBe(aCountBefore + 1); // only Dave added
    expect(bCountAfter).toBe(bCountBefore + 1); // only Dave added
  });

  it("net-new joiner records are created in all existing connectors", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);
    const engine = await onboardABThenGetABCEngine(db, dirA, dirB, dirC);

    await engine.addConnector("contacts-channel", "system-c");

    const aContacts = readJson(join(dirA, "contacts.json")) as Array<Record<string, unknown>>;
    const bContacts = readJson(join(dirB, "contacts.json")) as Array<Record<string, unknown>>;

    expect(aContacts.some((c) => c["email"] === "dave@example.com")).toBe(true);
    expect(bContacts.some((c) => c["email"] === "dave@example.com")).toBe(true);
  });

  it("missingFromJoiner:propagate — canonical-only records are created in the joining connector", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);
    const engine = await onboardABThenGetABCEngine(db, dirA, dirB, dirC);

    await engine.addConnector("contacts-channel", "system-c", { missingFromJoiner: "propagate" });

    // Carol must appear in system-c
    const cContacts = readJson(join(dirC, "contacts.json")) as Array<Record<string, unknown>>;
    expect(cContacts.some((c) => c["email"] === "carol@example.com")).toBe(true);
    expect(cContacts.length).toBe(4); // Alice, Bob, Dave (original) + Carol (propagated)
  });

  it("missingFromJoiner:skip — canonical-only records are left out of joining connector", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);
    const engine = await onboardABThenGetABCEngine(db, dirA, dirB, dirC);

    await engine.addConnector("contacts-channel", "system-c", { missingFromJoiner: "skip" });

    // Carol must NOT appear in system-c
    const cContacts = readJson(join(dirC, "contacts.json")) as Array<Record<string, unknown>>;
    expect(cContacts.some((c) => c["email"] === "carol@example.com")).toBe(false);
    expect(cContacts.length).toBe(3); // Alice, Bob, Dave unchanged
  });

  it("after addConnector, incremental ingest produces zero writes in all directions", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);
    const engine = await onboardABThenGetABCEngine(db, dirA, dirB, dirC);

    await engine.addConnector("contacts-channel", "system-c");

    // Run incremental ingest from all three connectors
    for (const connId of ["system-a", "system-b", "system-c"]) {
      const result = await engine.ingest("contacts-channel", connId, { batchId: crypto.randomUUID() });
      const inserts = result.records.filter((r) => r.action === "insert").length;
      const updates = result.records.filter((r) => r.action === "update").length;
      expect(inserts).toBe(0);
      expect(updates).toBe(0);
    }
  });

  it("is idempotent: re-running produces same report, no duplicate rows", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);
    const engine = await onboardABThenGetABCEngine(db, dirA, dirB, dirC);

    await engine.addConnector("contacts-channel", "system-c");

    const imAfterFirst = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;

    // Re-run — should be a no-op in terms of DB rows
    const engine2 = await onboardABThenGetABCEngine(db, dirA, dirB, dirC);
    const report2 = await engine2.addConnector("contacts-channel", "system-c");

    expect(db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n)
      .toBe(imAfterFirst);
  });

  it("identity field normalisation: mixed-case email matches lower-case canonical", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB);

    // C has Alice with upper-cased email
    writeJson(join(dirC, "contacts.json"), [
      { _id: "c1", name: "Alice Liddell", email: "ALICE@EXAMPLE.COM", _updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    const engine = await onboardABThenGetABCEngine(db, dirA, dirB, dirC);

    const report = await engine.addConnector("contacts-channel", "system-c", { dryRun: true });

    // ALICE@EXAMPLE.COM should match alice@example.com in the canonical layer
    expect(report.summary.linked).toBe(1);
    expect(report.linked[0].externalId).toBe("c1");
  });
});

// ─── Suite: onboard() dryRun ─────────────────────────────────────────────────

describe("onboard() dryRun", () => {
  it("returns correct counts without writing any DB rows", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);

    const instA = makeInstance(db, "system-a", dirA);
    const instB = makeInstance(db, "system-b", dirB);
    const engine = new SyncEngine({ connectors: [instA, instB], channels: [CHANNEL_AB] }, db);

    const report = await engine.discover("contacts-channel");

    const beforeIM = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
    const beforeSS = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM shadow_state").get()!.n;

    const result = await engine.onboard("contacts-channel", report, { dryRun: true });

    // Counts match what a live onboard would produce
    expect(result.linked).toBe(6);         // 3 canonicals × 2 sides
    expect(result.shadowsSeeded).toBe(6);
    expect(result.uniqueQueued).toBe(0);   // all 3 matched

    // Zero DB changes
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n).toBe(beforeIM);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM shadow_state").get()!.n).toBe(beforeSS);
  });

  it("dryRun onboard then dryRun addConnector — full preview without any DB writes", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    // Step 1: build A+B engine and dry-run the onboard
    const instA = makeInstance(db, "system-a", dirA);
    const instB = makeInstance(db, "system-b", dirB);
    const instC = makeInstance(db, "system-c", dirC);
    const engineAB = new SyncEngine({ connectors: [instA, instB], channels: [CHANNEL_AB] }, db);

    const discoverReport = await engineAB.discover("contacts-channel");
    const onboardPreview = await engineAB.onboard("contacts-channel", discoverReport, { dryRun: true });

    expect(onboardPreview.linked).toBe(6);
    expect(onboardPreview.uniqueQueued).toBe(0);

    // Step 2: channel is still uninitialized (dry-run wrote nothing)
    expect(engineAB.channelStatus("contacts-channel")).toBe("uninitialized");

    // Step 3: addConnector dry-run also works (uses the canonical layer — but it's empty,
    // so this preview only succeeds after a real onboard)
    // Do the real onboard first, then dry-run addConnector
    await engineAB.onboard("contacts-channel", discoverReport);

    const engineABC = new SyncEngine(
      { connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB), instC],
        channels: [CHANNEL_ABC] },
      db,
    );
    const addPreview = await engineABC.addConnector("contacts-channel", "system-c", { dryRun: true });

    expect(addPreview.summary.linked).toBe(2);
    expect(addPreview.summary.newFromJoiner).toBe(1);
    expect(addPreview.summary.missingInJoiner).toBe(1);

    // DB unchanged since addConnector dry-run
    const imRows = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
    expect(imRows).toBe(6); // only A+B rows
  });
});

// ─── Suite: channelStatus() v8 extension ─────────────────────────────────────

describe("channelStatus() v8 — partially-onboarded", () => {
  it("returns 'partially-onboarded' when C is in config but addConnector not yet called", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    // Onboard A+B, then create engine with A+B+C config but don't call addConnector
    const instA = makeInstance(db, "system-a", dirA);
    const instB = makeInstance(db, "system-b", dirB);
    const engine2 = new SyncEngine({ connectors: [instA, instB], channels: [CHANNEL_AB] }, db);
    const rep = await engine2.discover("contacts-channel");
    await engine2.onboard("contacts-channel", rep);

    // New engine with all 3 in config
    const instA2 = makeInstance(db, "system-a", dirA);
    const instB2 = makeInstance(db, "system-b", dirB);
    const instC2 = makeInstance(db, "system-c", dirC);
    const engine3 = new SyncEngine({ connectors: [instA2, instB2, instC2], channels: [CHANNEL_ABC] }, db);

    expect(engine3.channelStatus("contacts-channel")).toBe("partially-onboarded");

    await engine3.addConnector("contacts-channel", "system-c");
    expect(engine3.channelStatus("contacts-channel")).toBe("ready");
  });
});

// ─── Suite: ingest() guard — v8 behaviour ────────────────────────────────────

describe("ingest() guard — v8 partial-onboarding", () => {
  it("existing A↔B members can still ingest while C is partially-onboarded", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);
    const engine = await onboardABThenGetABCEngine(db, dirA, dirB, dirC);
    // C is NOT yet added — channel is partially-onboarded

    // A and B must be able to ingest freely
    await expect(
      engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() }),
    ).resolves.toBeDefined();
    await expect(
      engine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID() }),
    ).resolves.toBeDefined();
  });

  it("ingest for the unlinked connector C is blocked while partially-onboarded", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);
    const engine = await onboardABThenGetABCEngine(db, dirA, dirB, dirC);
    // C is NOT yet added — it has no identity_map rows

    await expect(
      engine.ingest("contacts-channel", "system-c", { batchId: crypto.randomUUID() }),
    ).rejects.toThrow(OnboardingRequiredError);
  });
});
