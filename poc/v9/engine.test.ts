/**
 * POC v9 engine tests — Ingest-first, DB-backed identity matching
 *
 * Key assertions this suite proves:
 *
 *   ingest({ collectOnly: true })
 *     1. Writes shadow_state for source records
 *     2. Does NOT fan-out to other connectors
 *     3. Creates provisional canonicals (identity_map for source only, no cross-links)
 *     4. channelStatus() becomes "collected" after both sides ingest
 *
 *   discover() from shadow_state
 *     5. Returns correct match report using only DB data (no live connector calls)
 *     6. Works even after source files are deleted — proves zero live I/O
 *     7. Normalises identity fields (uppercase matches lowercase)
 *     8. Throws a helpful error if connector has no shadow_state rows
 *
 *   onboard() with merged provisionals
 *     9.  Merges provisional canonicals — identity_map has N×2 rows
 *    10.  Re-seeds unified shadow state for all sides
 *    11.  Unique-per-side records are propagated via direct insert (no _processRecords)
 *    12.  Normal ingest after onboard() produces 0 writes
 *    13.  channelStatus() becomes "ready" after onboard()
 *
 *   addConnector() with shadow-backed matching
 *    14.  Throws if joiner not pre-ingested
 *    15.  Reads joiner's shadow_state (no live fetch)
 *    16.  Merges joiner's provisional canonicals into existing layer
 *    17.  newFromJoiner propagated to existing members
 *    18.  missingInJoiner propagated to joining connector
 *    19.  After addConnector, ingest all 3 → 0 writes
 */
import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { SyncEngine, makeConnectorInstance } from "./engine.js";
import type { ChannelConfig } from "./engine.js";
import { openDb } from "./db.js";
import type { Db } from "./db.js";
import jsonfiles from "../../connectors/jsonfiles/src/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "opensync-v9-"));
  return openDb(join(dir, "state.db"));
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "opensync-v9-data-"));
}

function writeJson(filePath: string, records: unknown[]): void {
  writeFileSync(filePath, JSON.stringify(records, null, 2), "utf8");
}

function readJson(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown[];
}

const WEBHOOK = "http://localhost:14010";

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

// ─── Suite: ingest({ collectOnly: true }) ──────────────────────────────────────

describe("ingest({ collectOnly: true })", () => {
  it("writes shadow_state for source records only", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const engine = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);

    await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });

    const ssA = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM shadow_state WHERE connector_id = 'system-a'").get()!.n;
    const ssB = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM shadow_state WHERE connector_id = 'system-b'").get()!.n;
    expect(ssA).toBe(3);  // A's 3 records in shadow
    expect(ssB).toBe(0);  // B never touched
  });

  it("does NOT fan out to other connectors", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const engine = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);

    await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });

    // B's json file should still have its original 3 records (nothing inserted from A)
    const bRecords = readJson(join(dirB, "contacts.json")) as Array<{ _id: string }>;
    const bIds = bRecords.map((r) => r._id);
    expect(bIds).toContain("b1");
    expect(bIds).toContain("b2");
    expect(bIds).toContain("b3");
    expect(bIds).not.toContain("a1");
    expect(bIds).not.toContain("a2");
    expect(bIds).not.toContain("a3");
  });

  it("creates provisional canonicals (source-only identity_map rows, no cross-links)", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const engine = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);

    await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });

    const imA = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map WHERE connector_id = 'system-a'").get()!.n;
    const imB = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map WHERE connector_id = 'system-b'").get()!.n;
    expect(imA).toBe(3);
    expect(imB).toBe(3);

    // No cross-links: no canonical_id is shared between A and B
    const crossLinks = db.query<{ n: number }, []>(
      `SELECT COUNT(*) as n FROM (
         SELECT canonical_id FROM identity_map GROUP BY canonical_id HAVING COUNT(DISTINCT connector_id) > 1
       )`,
    ).get()!.n;
    expect(crossLinks).toBe(0);
  });

  it("channelStatus() is 'collected' after both sides ingest", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const engine = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);

    expect(engine.channelStatus("contacts-channel")).toBe("uninitialized");

    await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    // After one side: shadow exists → still considered collected (or partially)
    expect(["collected", "uninitialized"]).toContain(engine.channelStatus("contacts-channel"));

    await engine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
    expect(engine.channelStatus("contacts-channel")).toBe("collected");
  });
});

// ─── Suite: discover() from shadow_state ─────────────────────────────────────

describe("discover() from shadow_state", () => {
  it("returns correct match report without any live connector calls", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const engine = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);

    await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });

    const report = await engine.discover("contacts-channel");

    expect(report.matched.length).toBe(3);
    expect(report.uniquePerSide.length).toBe(0);
    expect(report.summary["system-a"]).toEqual({ total: 3, matched: 3, unique: 0 });
    expect(report.summary["system-b"]).toEqual({ total: 3, matched: 3, unique: 0 });
  });

  it("works even after source files are deleted — proves no live I/O", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const engine = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);

    await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });

    // Delete source files — discover() must still work from shadow_state alone
    rmSync(join(dirA, "contacts.json"));
    rmSync(join(dirB, "contacts.json"));

    const report = await engine.discover("contacts-channel");
    expect(report.matched.length).toBe(3);  // Correct report with no live access ✓
  });

  it("normalises identity fields — uppercase email matches lowercase canonical", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();

    writeJson(join(dirA, "contacts.json"), [
      { _id: "a1", name: "Alice", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { _id: "b1", name: "Alice", email: "ALICE@EXAMPLE.COM", _updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    const engine = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);

    await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });

    const report = await engine.discover("contacts-channel");
    expect(report.matched.length).toBe(1);  // matched despite case difference
    expect(report.uniquePerSide.length).toBe(0);
  });

  it("throws a helpful error if connector has no shadow_state rows", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const engine = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);

    // Only ingest A — B has no shadow rows yet
    await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });

    await expect(engine.discover("contacts-channel")).rejects.toThrow(/no shadow_state rows.*collectOnly/);
  });
});

// ─── Suite: onboard() with merged provisionals ────────────────────────────────

describe("onboard() with merged provisionals", () => {
  async function collectAndDiscover(db: Db, dirA: string, dirB: string) {
    const engine = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);
    await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
    const report = await engine.discover("contacts-channel");
    return { engine, report };
  }

  it("merges provisional canonicals — identity_map has 6 rows (3 canonicals × 2)", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const { engine, report } = await collectAndDiscover(db, dirA, dirB);

    await engine.onboard("contacts-channel", report);

    const im = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
    expect(im).toBe(6);

    // Cross-links exist for all 3 canonicals
    const crossLinks = db.query<{ n: number }, []>(
      `SELECT COUNT(*) as n FROM (
         SELECT canonical_id FROM identity_map GROUP BY canonical_id HAVING COUNT(DISTINCT connector_id) > 1
       )`,
    ).get()!.n;
    expect(crossLinks).toBe(3);
  });

  it("each canonical_id is the same for both the A and B rows of a matched record", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const { engine, report } = await collectAndDiscover(db, dirA, dirB);

    await engine.onboard("contacts-channel", report);

    // a1 and b1 should share the same canonical_id
    const a1 = db.query<{ canonical_id: string }, []>(
      "SELECT canonical_id FROM identity_map WHERE connector_id = 'system-a' AND external_id = 'a1'",
    ).get()!.canonical_id;
    const b1 = db.query<{ canonical_id: string }, []>(
      "SELECT canonical_id FROM identity_map WHERE connector_id = 'system-b' AND external_id = 'b1'",
    ).get()!.canonical_id;
    expect(a1).toBe(b1);
  });

  it("unique-per-side records are propagated to the other side", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();

    // A has Carol, B does not
    writeJson(join(dirA, "contacts.json"), [
      { _id: "a1", name: "Alice", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
      { _id: "a2", name: "Carol", email: "carol@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { _id: "b1", name: "Alice", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);

    const engine = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);
    await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
    const report = await engine.discover("contacts-channel");

    expect(report.uniquePerSide.length).toBe(1);  // Carol is unique to A
    expect(report.uniquePerSide[0].externalId).toBe("a2");

    const result = await engine.onboard("contacts-channel", report);
    expect(result.uniqueQueued).toBe(1);

    // Carol should now be in B's file
    const bAfter = readJson(join(dirB, "contacts.json")) as Array<{ _id: string; email: string }>;
    expect(bAfter.some((r) => r.email === "carol@example.com")).toBe(true);
  });

  it("normal ingest after onboard produces 0 writes", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const { engine, report } = await collectAndDiscover(db, dirA, dirB);
    await engine.onboard("contacts-channel", report);

    // Fresh engine instance (reset watermarks don't matter — shadow state was pre-seeded)
    const engine2 = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);
    const r1 = await engine2.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() });
    const r2 = await engine2.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID() });

    const writes = [...r1.records, ...r2.records].filter((r) => r.action !== "skip").length;
    expect(writes).toBe(0);
  });

  it("channelStatus() becomes 'ready' after onboard()", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const { engine, report } = await collectAndDiscover(db, dirA, dirB);

    expect(engine.channelStatus("contacts-channel")).toBe("collected");
    await engine.onboard("contacts-channel", report);
    expect(engine.channelStatus("contacts-channel")).toBe("ready");
  });

  it("dryRun returns counts without writing anything", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const { engine, report } = await collectAndDiscover(db, dirA, dirB);

    const before = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
    const preview = await engine.onboard("contacts-channel", report, { dryRun: true });

    expect(preview.linked).toBe(6);
    expect(preview.shadowsSeeded).toBe(6);
    // DB unchanged
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n).toBe(before);
  });
});

// ─── Suite: partial-onboarding safety ────────────────────────────────────────

describe("partially-onboarded: A+B can sync while C is collected", () => {
  it("A+B ingest produces no fan-out to C (collected-but-not-linked C is skipped)", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    // Phase 1: onboard A+B
    const engineAB = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);
    await engineAB.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engineAB.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
    await engineAB.onboard("contacts-channel", await engineAB.discover("contacts-channel"));

    // Phase 2: collect C (partially-onboarded)
    const engineABC = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB), makeInstance(db, "system-c", dirC)], channels: [CHANNEL_ABC] }, db);
    await engineABC.ingest("contacts-channel", "system-c", { batchId: crypto.randomUUID(), collectOnly: true });
    expect(engineABC.channelStatus("contacts-channel")).toBe("partially-onboarded");

    // Phase 3: update Alice in A, then run a normal A ingest
    const aContacts = readJson(join(dirA, "contacts.json")) as Array<Record<string, unknown>>;
    const alice = aContacts.find((r) => r["email"] === "alice@example.com")!;
    alice["name"] = "Alice Updated";
    alice["_updatedAt"] = new Date().toISOString();
    writeJson(join(dirA, "contacts.json"), aContacts);

    const ingestResult = await engineABC.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), fullSync: true });

    // The update should go to B (cross-linked) but NOT to C (only collected, not linked)
    const actionsToB = ingestResult.records.filter((r) => r.targetConnectorId === "system-b").map((r) => r.action);
    const actionsToC = ingestResult.records.filter((r) => r.targetConnectorId === "system-c").map((r) => r.action);

    expect(actionsToB).toContain("update");   // B gets Alice's name update ✓
    expect(actionsToC).toHaveLength(0);        // C is skipped — not yet cross-linked ✓

    // C's file is unchanged (no duplicate Alice inserted)
    const cAfter = readJson(join(dirC, "contacts.json")) as Array<Record<string, unknown>>;
    expect(cAfter.length).toBe(3);
    const aliceInC = cAfter.find((r) => r["email"] === "alice@example.com");
    expect(aliceInC?.["name"]).toBe("Alice Liddell");  // original — not "Alice Updated"
  });

  it("addConnector catches C up with changes made during partial-onboarding window", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    // Onboard A+B, collect C
    const engineAB = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);
    await engineAB.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engineAB.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
    await engineAB.onboard("contacts-channel", await engineAB.discover("contacts-channel"));

    const engineABC = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB), makeInstance(db, "system-c", dirC)], channels: [CHANNEL_ABC] }, db);
    await engineABC.ingest("contacts-channel", "system-c", { batchId: crypto.randomUUID(), collectOnly: true });

    // Update Alice in A while C is partially-onboarded
    const aContacts = readJson(join(dirA, "contacts.json")) as Array<Record<string, unknown>>;
    const alice = aContacts.find((r) => r["email"] === "alice@example.com")!;
    alice["name"] = "Alice Updated";
    alice["_updatedAt"] = new Date().toISOString();
    writeJson(join(dirA, "contacts.json"), aContacts);
    await engineABC.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), fullSync: true });

    // Now complete the onboarding of C — addConnector catches C up immediately
    await engineABC.addConnector("contacts-channel", "system-c");
    expect(engineABC.channelStatus("contacts-channel")).toBe("ready");

    // C has "Alice Updated" right after addConnector — no extra ingest needed
    const cAfter = readJson(join(dirC, "contacts.json")) as Array<Record<string, unknown>>;
    const aliceInC = cAfter.find((r) => r["email"] === "alice@example.com");
    expect(aliceInC?.["name"]).toBe("Alice Updated");  // caught up during addConnector ✓

    // Subsequent A ingest is a no-op (nothing to re-process)
    const engine2 = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB), makeInstance(db, "system-c", dirC)], channels: [CHANNEL_ABC] }, db);
    const noOpResult = await engine2.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), fullSync: true });
    const writesToC = noOpResult.records.filter((r) => r.targetConnectorId === "system-c");
    expect(writesToC).toHaveLength(0);  // nothing left to deliver ✓
  });
});

// ─── Suite: addConnector() with shadow-backed matching ────────────────────────

describe("addConnector() with shadow-backed matching", () => {
  /** Collect-and-onboard A+B, then return an ABC engine with C collected. */
  async function onboardABCollectC(db: Db, dirA: string, dirB: string, dirC: string) {
    // Phase 1: collect + onboard A↔B
    const engineAB = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);
    await engineAB.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engineAB.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
    const report = await engineAB.discover("contacts-channel");
    await engineAB.onboard("contacts-channel", report);

    // Phase 2: collect C only (no addConnector yet)
    const engineABC = new SyncEngine({
      connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB), makeInstance(db, "system-c", dirC)],
      channels: [CHANNEL_ABC],
    }, db);
    await engineABC.ingest("contacts-channel", "system-c", { batchId: crypto.randomUUID(), collectOnly: true });
    return engineABC;
  }

  it("throws if joiner has not been pre-ingested (no shadow_state)", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    const engineAB = new SyncEngine({ connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB)], channels: [CHANNEL_AB] }, db);
    await engineAB.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engineAB.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
    const report = await engineAB.discover("contacts-channel");
    await engineAB.onboard("contacts-channel", report);

    // C exists in engine config but was NOT collected yet
    const engineABC = new SyncEngine({
      connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB), makeInstance(db, "system-c", dirC)],
      channels: [CHANNEL_ABC],
    }, db);

    await expect(engineABC.addConnector("contacts-channel", "system-c")).rejects.toThrow(/no shadow_state.*collectOnly/);
  });

  it("reads joiner's shadow_state — correct linked/new/missing counts", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    const engine = await onboardABCollectC(db, dirA, dirB, dirC);
    const addReport = await engine.addConnector("contacts-channel", "system-c", { dryRun: true });

    expect(addReport.summary.linked).toBe(2);          // Alice + Bob
    expect(addReport.summary.newFromJoiner).toBe(1);   // Dave
    expect(addReport.summary.missingInJoiner).toBe(1); // Carol
  });

  it("merges joiner's provisional canonicals into existing layer", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    const engine = await onboardABCollectC(db, dirA, dirB, dirC);
    await engine.addConnector("contacts-channel", "system-c");

    // Alice, Bob, Carol, Dave — each linked to 3 connectors → 12 rows
    const imTotal = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
    expect(imTotal).toBe(12);
  });

  it("newFromJoiner (Dave) is created in all existing connectors", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    const engine = await onboardABCollectC(db, dirA, dirB, dirC);
    await engine.addConnector("contacts-channel", "system-c");

    const aRecords = readJson(join(dirA, "contacts.json"));
    const bRecords = readJson(join(dirB, "contacts.json"));
    expect(aRecords.length).toBe(4);  // Alice, Bob, Carol, Dave
    expect(bRecords.length).toBe(4);
  });

  it("missingInJoiner (Carol) is created in the joining connector", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    const engine = await onboardABCollectC(db, dirA, dirB, dirC);
    await engine.addConnector("contacts-channel", "system-c");

    const cRecords = readJson(join(dirC, "contacts.json")) as Array<{ email: string }>;
    expect(cRecords.length).toBe(4);
    expect(cRecords.some((r) => r.email === "carol@example.com")).toBe(true);
  });

  it("after addConnector, full ingest of all 3 connectors produces 0 writes", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    const engine = await onboardABCollectC(db, dirA, dirB, dirC);
    await engine.addConnector("contacts-channel", "system-c");

    const engine2 = new SyncEngine({
      connectors: [makeInstance(db, "system-a", dirA), makeInstance(db, "system-b", dirB), makeInstance(db, "system-c", dirC)],
      channels: [CHANNEL_ABC],
    }, db);

    const [r1, r2, r3] = await Promise.all([
      engine2.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() }),
      engine2.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID() }),
      engine2.ingest("contacts-channel", "system-c", { batchId: crypto.randomUUID() }),
    ]);

    const writes = [...r1.records, ...r2.records, ...r3.records].filter((r) => r.action !== "skip").length;
    expect(writes).toBe(0);
  });

  it("channelStatus() is 'ready' after addConnector", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    const engine = await onboardABCollectC(db, dirA, dirB, dirC);
    expect(engine.channelStatus("contacts-channel")).toBe("partially-onboarded");

    await engine.addConnector("contacts-channel", "system-c");
    expect(engine.channelStatus("contacts-channel")).toBe("ready");
  });
});
