/**
 * packages/engine/src/onboarding.test.ts
 *
 * Tests for the ingest-first onboarding pipeline (discover / onboard / addConnector).
 * Uses the jsonfiles connector (no HTTP servers needed) to stay fast and isolated.
 *
 * Scenarios ported from poc/v9/engine.test.ts — confirms POC parity so poc/v9 can be removed.
 *
 * T10  collectOnly writes shadow_state, does NOT fan-out
 * T11  collectOnly creates provisional canonicals (no cross-links until onboard)
 * T12  channelStatus transitions: uninitialized → collected → ready
 * T13  discover returns correct report from shadow_state (no live I/O)
 * T14  discover works after source files are deleted (zero live I/O guarantee)
 * T15  discover normalises identity fields (case-insensitive match)
 * T16  discover throws if a connector has no shadow_state rows
 * T17  onboard merges provisional canonicals — correct identity_map row count
 * T18  onboard sets same canonical_id for A-row and B-row of each matched record
 * T19  onboard propagates unique-per-side records to the other connector
 * T20  normal ingest after onboard produces 0 writes
 * T21  onboard dryRun returns preview counts without modifying the DB
 * T22  C collected but not linked — A+B ingest does NOT fan-out to C
 * T23  addConnector reads joiner shadow_state and returns correct linked/new/missing counts
 * T24  addConnector merges joiner canonicals and backfills missing records both ways
 * T25  full ingest of all 3 connectors after addConnector produces 0 writes
 */
import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import {
  SyncEngine,
  openDb,
  type ResolvedConfig,
  type DiscoveryReport,
} from "./index.js";
import type { Db } from "./db/index.js";
import jsonfiles from "@opensync/connector-jsonfiles";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "opensync-onboard-test-"));
}

function writeJson(filePath: string, records: unknown[]): void {
  writeFileSync(filePath, JSON.stringify(records, null, 2), "utf8");
}

function readJson(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown[];
}

function makeInstance(id: string, dir: string): ResolvedConfig["connectors"][0] {
  return {
    id,
    connector: jsonfiles,
    config: { filePaths: [join(dir, "contacts.json")] },
    auth: {},
    batchIdRef: { current: undefined },
    triggerRef: { current: undefined },
  };
}

function makeConfig(
  connectors: ResolvedConfig["connectors"],
  channelMembers: { connectorId: string; entity: string }[],
): ResolvedConfig {
  return {
    connectors,
    channels: [
      {
        id: "ch",
        members: channelMembers,
        identityFields: ["email"],
      },
    ],
    conflict: { strategy: "lww" },
    readTimeoutMs: 10_000,
  };
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

async function collectAndDiscoverAB(
  db: Db,
  dirA: string,
  dirB: string,
): Promise<{ engine: SyncEngine; report: DiscoveryReport }> {
  const iA = makeInstance("system-a", dirA);
  const iB = makeInstance("system-b", dirB);
  const engine = new SyncEngine(
    makeConfig([iA, iB], [
      { connectorId: "system-a", entity: "contacts" },
      { connectorId: "system-b", entity: "contacts" },
    ]),
    db,
  );
  await engine.ingest("ch", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
  await engine.ingest("ch", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
  const report = await engine.discover("ch");
  return { engine, report };
}

async function onboardABCollectC(
  db: Db,
  dirA: string,
  dirB: string,
  dirC: string,
): Promise<SyncEngine> {
  const { engine, report } = await collectAndDiscoverAB(db, dirA, dirB);
  await engine.onboard("ch", report);

  // Replace config with 3-connector version to collect C
  const iA = makeInstance("system-a", dirA);
  const iB = makeInstance("system-b", dirB);
  const iC = makeInstance("system-c", dirC);
  const engine3 = new SyncEngine(
    makeConfig([iA, iB, iC], [
      { connectorId: "system-a", entity: "contacts" },
      { connectorId: "system-b", entity: "contacts" },
      { connectorId: "system-c", entity: "contacts" },
    ]),
    db,
  );
  await engine3.ingest("ch", "system-c", { batchId: crypto.randomUUID(), collectOnly: true });
  return engine3;
}

// ─── T10: collectOnly ─────────────────────────────────────────────────────────

describe("T10: collectOnly — shadow_state written, no fan-out", () => {
  it("writes shadow_state for the ingested connector only", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const engine = new SyncEngine(
      makeConfig(
        [makeInstance("system-a", dirA), makeInstance("system-b", dirB)],
        [{ connectorId: "system-a", entity: "contacts" }, { connectorId: "system-b", entity: "contacts" }],
      ),
      db,
    );

    await engine.ingest("ch", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });

    const ssA = db.prepare<{ n: number }>("SELECT COUNT(*) as n FROM shadow_state WHERE connector_id = 'system-a'").get()!.n;
    const ssB = db.prepare<{ n: number }>("SELECT COUNT(*) as n FROM shadow_state WHERE connector_id = 'system-b'").get()!.n;
    expect(ssA).toBe(3);
    expect(ssB).toBe(0);
  });

  it("does not fan-out to other connectors", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const engine = new SyncEngine(
      makeConfig(
        [makeInstance("system-a", dirA), makeInstance("system-b", dirB)],
        [{ connectorId: "system-a", entity: "contacts" }, { connectorId: "system-b", entity: "contacts" }],
      ),
      db,
    );

    await engine.ingest("ch", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });

    // B's file is untouched — no records from A should appear
    const bIds = (readJson(join(dirB, "contacts.json")) as Array<{ _id: string }>).map(r => r._id);
    expect(bIds).toEqual(["b1", "b2", "b3"]);
    expect(bIds).not.toContain("a1");
  });
});

// ─── T11: Provisional canonicals ─────────────────────────────────────────────

describe("T11: collectOnly creates provisional canonicals (no cross-links)", () => {
  it("each connector has its own provisional canonical rows with no shared canonical_id", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const engine = new SyncEngine(
      makeConfig(
        [makeInstance("system-a", dirA), makeInstance("system-b", dirB)],
        [{ connectorId: "system-a", entity: "contacts" }, { connectorId: "system-b", entity: "contacts" }],
      ),
      db,
    );

    await engine.ingest("ch", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });

    const imA = db.prepare<{ n: number }>("SELECT COUNT(*) as n FROM identity_map WHERE connector_id = 'system-a'").get()!.n;
    const imB = db.prepare<{ n: number }>("SELECT COUNT(*) as n FROM identity_map WHERE connector_id = 'system-b'").get()!.n;
    expect(imA).toBe(3);
    expect(imB).toBe(3);

    // No cross-links: no canonical_id shared between A and B
    const crossLinks = db.prepare<{ n: number }>(
      `SELECT COUNT(*) as n FROM (
         SELECT canonical_id FROM identity_map
         GROUP BY canonical_id HAVING COUNT(DISTINCT connector_id) > 1
       )`,
    ).get()!.n;
    expect(crossLinks).toBe(0);
  });
});

// ─── T12: channelStatus transitions ──────────────────────────────────────────

describe("T12: channelStatus transitions uninitialized → collected → ready", () => {
  it("starts uninitialized, becomes collected after both sides ingest, ready after onboard", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const engine = new SyncEngine(
      makeConfig(
        [makeInstance("system-a", dirA), makeInstance("system-b", dirB)],
        [{ connectorId: "system-a", entity: "contacts" }, { connectorId: "system-b", entity: "contacts" }],
      ),
      db,
    );

    expect(engine.channelStatus("ch")).toBe("uninitialized");

    await engine.ingest("ch", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
    expect(engine.channelStatus("ch")).toBe("collected");

    const report = await engine.discover("ch");
    await engine.onboard("ch", report);
    expect(engine.channelStatus("ch")).toBe("ready");
  });
});

// ─── T13: discover from shadow_state ─────────────────────────────────────────

describe("T13: discover returns correct report from shadow_state only", () => {
  it("returns matched and uniquePerSide counts without calling any connector", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const { report } = await collectAndDiscoverAB(db, dirA, dirB);

    expect(report.matched.length).toBe(3);
    expect(report.uniquePerSide.length).toBe(0);
    expect(report.summary["system-a"]).toMatchObject({ total: 3, matched: 3, unique: 0 });
    expect(report.summary["system-b"]).toMatchObject({ total: 3, matched: 3, unique: 0 });
  });
});

// ─── T14: discover after source files deleted ─────────────────────────────────

describe("T14: discover works after source files are deleted (no live I/O)", () => {
  it("returns correct report even when source JSON files no longer exist", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const engine = new SyncEngine(
      makeConfig(
        [makeInstance("system-a", dirA), makeInstance("system-b", dirB)],
        [{ connectorId: "system-a", entity: "contacts" }, { connectorId: "system-b", entity: "contacts" }],
      ),
      db,
    );

    await engine.ingest("ch", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });

    // Delete source files — discover() must still work from shadow_state alone
    rmSync(join(dirA, "contacts.json"));
    rmSync(join(dirB, "contacts.json"));

    const report = await engine.discover("ch");
    expect(report.matched.length).toBe(3);
  });
});

// ─── T15: discover normalises identity fields ─────────────────────────────────

describe("T15: discover normalises identity fields (case-insensitive)", () => {
  it("matches uppercase email in B against lowercase in A", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();

    writeJson(join(dirA, "contacts.json"), [
      { _id: "a1", name: "Alice", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { _id: "b1", name: "Alice", email: "ALICE@EXAMPLE.COM", _updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);

    const { report } = await collectAndDiscoverAB(db, dirA, dirB);

    expect(report.matched.length).toBe(1);
    expect(report.uniquePerSide.length).toBe(0);
  });
});

// ─── T16: discover throws if connector has no shadow rows ─────────────────────

describe("T16: discover throws if a connector has no shadow_state rows", () => {
  it("throws a helpful error when only one side has been collected", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const engine = new SyncEngine(
      makeConfig(
        [makeInstance("system-a", dirA), makeInstance("system-b", dirB)],
        [{ connectorId: "system-a", entity: "contacts" }, { connectorId: "system-b", entity: "contacts" }],
      ),
      db,
    );

    // Only ingest A — B has no shadow rows yet
    await engine.ingest("ch", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });

    await expect(engine.discover("ch")).rejects.toThrow(/no shadow_state.*collectOnly/i);
  });
});

// ─── T17: onboard merges provisional canonicals ───────────────────────────────

describe("T17: onboard merges provisional canonicals", () => {
  it("identity_map has 6 rows (3 canonicals × 2 connectors) after onboard", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const { engine, report } = await collectAndDiscoverAB(db, dirA, dirB);

    await engine.onboard("ch", report);

    const total = db.prepare<{ n: number }>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
    expect(total).toBe(6);

    const crossLinks = db.prepare<{ n: number }>(
      `SELECT COUNT(*) as n FROM (
         SELECT canonical_id FROM identity_map
         GROUP BY canonical_id HAVING COUNT(DISTINCT connector_id) > 1
       )`,
    ).get()!.n;
    expect(crossLinks).toBe(3);
  });
});

// ─── T18: onboard sets same canonical_id for matched pair ────────────────────

describe("T18: onboard sets same canonical_id for both rows of a matched pair", () => {
  it("a1 and b1 (same person, different external IDs) share a canonical_id", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const { engine, report } = await collectAndDiscoverAB(db, dirA, dirB);
    await engine.onboard("ch", report);

    const a1 = db.prepare<{ canonical_id: string }>(
      "SELECT canonical_id FROM identity_map WHERE connector_id = 'system-a' AND external_id = 'a1'",
    ).get()!.canonical_id;
    const b1 = db.prepare<{ canonical_id: string }>(
      "SELECT canonical_id FROM identity_map WHERE connector_id = 'system-b' AND external_id = 'b1'",
    ).get()!.canonical_id;

    expect(a1).toBe(b1);
  });
});

// ─── T19: onboard propagates unique-per-side records ─────────────────────────

describe("T19: onboard propagates unique-per-side records to the other connector", () => {
  it("a record unique to A is written into B during onboard", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();

    writeJson(join(dirA, "contacts.json"), [
      { _id: "a1", name: "Alice", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
      { _id: "a2", name: "Carol", email: "carol@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { _id: "b1", name: "Alice", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);

    const { engine, report } = await collectAndDiscoverAB(db, dirA, dirB);

    expect(report.uniquePerSide.length).toBe(1);
    expect(report.uniquePerSide[0]!.externalId).toBe("a2");

    const result = await engine.onboard("ch", report);
    expect(result.uniqueQueued).toBe(1);

    const bAfter = readJson(join(dirB, "contacts.json")) as Array<{ email: string }>;
    expect(bAfter.some(r => r.email === "carol@example.com")).toBe(true);
  });
});

// ─── T20: normal ingest after onboard produces 0 writes ──────────────────────

describe("T20: normal ingest after onboard produces 0 writes", () => {
  it("re-ingesting both connectors after onboard results in zero mutations", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const { engine, report } = await collectAndDiscoverAB(db, dirA, dirB);
    await engine.onboard("ch", report);

    // New engine instance to clear in-memory state
    const engine2 = new SyncEngine(
      makeConfig(
        [makeInstance("system-a", dirA), makeInstance("system-b", dirB)],
        [{ connectorId: "system-a", entity: "contacts" }, { connectorId: "system-b", entity: "contacts" }],
      ),
      db,
    );
    const r1 = await engine2.ingest("ch", "system-a", { batchId: crypto.randomUUID() });
    const r2 = await engine2.ingest("ch", "system-b", { batchId: crypto.randomUUID() });

    const writes = [...r1.records, ...r2.records].filter(r => r.action !== "skip").length;
    expect(writes).toBe(0);
  });
});

// ─── T21: onboard dryRun ──────────────────────────────────────────────────────

describe("T21: onboard dryRun returns preview counts without modifying DB", () => {
  it("returns linked/shadowsSeeded but rolls back all DB changes", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();
    seedAB(dirA, dirB);
    const { engine, report } = await collectAndDiscoverAB(db, dirA, dirB);

    const before = db.prepare<{ n: number }>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
    const preview = await engine.onboard("ch", report, { dryRun: true });

    expect(preview.linked).toBe(6);
    expect(preview.shadowsSeeded).toBe(6);
    // DB is unchanged
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) as n FROM identity_map").get()!.n).toBe(before);
  });
});

// ─── T22: collected-but-not-linked connector is skipped by fan-out ────────────

describe("T22: A+B ingest does not fan-out to collected-but-not-linked C", () => {
  it("updates go to B but not to C while C is being onboarded", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    // Phase 1: onboard A+B
    const { engine: engineAB, report } = await collectAndDiscoverAB(db, dirA, dirB);
    await engineAB.onboard("ch", report);

    // Phase 2: collect C (still not linked)
    const iA = makeInstance("system-a", dirA);
    const iB = makeInstance("system-b", dirB);
    const iC = makeInstance("system-c", dirC);
    const engine3 = new SyncEngine(
      makeConfig([iA, iB, iC], [
        { connectorId: "system-a", entity: "contacts" },
        { connectorId: "system-b", entity: "contacts" },
        { connectorId: "system-c", entity: "contacts" },
      ]),
      db,
    );
    await engine3.ingest("ch", "system-c", { batchId: crypto.randomUUID(), collectOnly: true });
    expect(engine3.channelStatus("ch")).toBe("ready"); // A+B still ready

    // Update Alice in A
    const aContacts = readJson(join(dirA, "contacts.json")) as Array<Record<string, unknown>>;
    const alice = aContacts.find(r => r["email"] === "alice@example.com")!;
    alice["name"] = "Alice Updated";
    alice["_updatedAt"] = new Date().toISOString();
    writeJson(join(dirA, "contacts.json"), aContacts);

    const ingestResult = await engine3.ingest("ch", "system-a", {
      batchId: crypto.randomUUID(),
      fullSync: true,
    });

    const actionsToB = ingestResult.records
      .filter(r => r.targetConnectorId === "system-b")
      .map(r => r.action);
    const actionsToC = ingestResult.records
      .filter(r => r.targetConnectorId === "system-c");

    expect(actionsToB).toContain("update"); // B gets the update
    expect(actionsToC).toHaveLength(0);     // C is invisible — not yet linked

    // C's file unchanged
    const cAfter = readJson(join(dirC, "contacts.json")) as Array<Record<string, unknown>>;
    const aliceInC = cAfter.find(r => r["email"] === "alice@example.com");
    expect(aliceInC?.["name"]).toBe("Alice Liddell");
  });
});

// ─── T23: addConnector counts ─────────────────────────────────────────────────

describe("T23: addConnector returns correct linked/newFromJoiner/missingInJoiner counts", () => {
  it("dryRun shows 2 linked, 1 newFromJoiner (Dave), 1 missingInJoiner (Carol)", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    const engine = await onboardABCollectC(db, dirA, dirB, dirC);
    const addReport = await engine.addConnector("ch", "system-c", { dryRun: true });

    expect(addReport.summary.linked).toBe(2);           // Alice + Bob
    expect(addReport.summary.newFromJoiner).toBe(1);    // Dave
    expect(addReport.summary.missingInJoiner).toBe(1);  // Carol
  });

  it("throws if joiner has not been collected (no shadow_state rows)", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    // Onboard A+B without collecting C
    const { engine: engineAB, report } = await collectAndDiscoverAB(db, dirA, dirB);
    await engineAB.onboard("ch", report);

    const iA = makeInstance("system-a", dirA);
    const iB = makeInstance("system-b", dirB);
    const iC = makeInstance("system-c", dirC);
    const engine3 = new SyncEngine(
      makeConfig([iA, iB, iC], [
        { connectorId: "system-a", entity: "contacts" },
        { connectorId: "system-b", entity: "contacts" },
        { connectorId: "system-c", entity: "contacts" },
      ]),
      db,
    );

    // C was NOT collected — addConnector should throw
    await expect(engine3.addConnector("ch", "system-c")).rejects.toThrow(/no shadow_state.*collectOnly/i);
  });
});

// ─── T24: addConnector backfills both ways ────────────────────────────────────

describe("T24: addConnector merges joiner canonicals and backfills missing records", () => {
  it("identity_map has 12 rows after addConnector (4 records × 3 connectors)", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    const engine = await onboardABCollectC(db, dirA, dirB, dirC);
    await engine.addConnector("ch", "system-c");

    const imTotal = db.prepare<{ n: number }>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
    expect(imTotal).toBe(12); // Alice, Bob, Carol, Dave — each in 3 connectors
  });

  it("newFromJoiner Dave is created in all existing connectors", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    const engine = await onboardABCollectC(db, dirA, dirB, dirC);
    await engine.addConnector("ch", "system-c");

    expect((readJson(join(dirA, "contacts.json")) as unknown[]).length).toBe(4);
    expect((readJson(join(dirB, "contacts.json")) as unknown[]).length).toBe(4);
  });

  it("missingInJoiner Carol is created in the joining connector", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    const engine = await onboardABCollectC(db, dirA, dirB, dirC);
    await engine.addConnector("ch", "system-c");

    const cRecords = readJson(join(dirC, "contacts.json")) as Array<{ email: string }>;
    expect(cRecords.length).toBe(4);
    expect(cRecords.some(r => r.email === "carol@example.com")).toBe(true);
  });
});

// ─── T25: full ingest after addConnector produces 0 writes ───────────────────

describe("T25: full ingest of all 3 connectors after addConnector produces 0 writes", () => {
  it("re-ingesting A, B, C after addConnector results in zero mutations", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    seedAB(dirA, dirB); seedC(dirC);

    const engine = await onboardABCollectC(db, dirA, dirB, dirC);
    await engine.addConnector("ch", "system-c");

    const iA = makeInstance("system-a", dirA);
    const iB = makeInstance("system-b", dirB);
    const iC = makeInstance("system-c", dirC);
    const engine2 = new SyncEngine(
      makeConfig([iA, iB, iC], [
        { connectorId: "system-a", entity: "contacts" },
        { connectorId: "system-b", entity: "contacts" },
        { connectorId: "system-c", entity: "contacts" },
      ]),
      db,
    );

    const [r1, r2, r3] = await Promise.all([
      engine2.ingest("ch", "system-a", { batchId: crypto.randomUUID() }),
      engine2.ingest("ch", "system-b", { batchId: crypto.randomUUID() }),
      engine2.ingest("ch", "system-c", { batchId: crypto.randomUUID() }),
    ]);

    const writes = [...r1.records, ...r2.records, ...r3.records]
      .filter(r => r.action !== "skip").length;
    expect(writes).toBe(0);
  });
});
