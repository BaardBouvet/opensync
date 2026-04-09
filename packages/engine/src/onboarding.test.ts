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
 * T26  collectOnly with integer watermarks stores integer since, not ISO timestamp
 * T46  record with empty data fans out and is linked in identity_map (zero-key guard regression)
 * T47  channelStatus / onboardedConnectors with zero members returns uninitialized without SQL error
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
import { createSchema } from "./db/migrations.js";
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
    config: { entities: { contacts: { filePath: join(dir, "contacts.json") } } },
    auth: {},
    batchIdRef: { current: undefined },
    triggerRef: { current: undefined },
  };
}

function makeInstanceEntity(id: string, dir: string, filename: string): ResolvedConfig["connectors"][0] {
  const entityName = filename.replace(/\.[^/.]+$/, "");
  return {
    id,
    connector: jsonfiles,
    config: { entities: { [entityName]: { filePath: join(dir, filename) } } },
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
    { id: "a1", data: { name: "Alice Liddell", email: "alice@example.com" } },
    { id: "a2", data: { name: "Bob Martin",    email: "bob@example.com"   } },
    { id: "a3", data: { name: "Carol White",   email: "carol@example.com" } },
  ]);
  writeJson(join(dirB, "contacts.json"), [
    { id: "b1", data: { name: "Alice Liddell", email: "alice@example.com" } },
    { id: "b2", data: { name: "Bob Martin",    email: "bob@example.com"   } },
    { id: "b3", data: { name: "Carol White",   email: "carol@example.com" } },
  ]);
}

function seedC(dirC: string): void {
  writeJson(join(dirC, "contacts.json"), [
    { id: "c1", data: { name: "Alice Liddell", email: "alice@example.com" } },
    { id: "c2", data: { name: "Bob Martin",    email: "bob@example.com"   } },
    { id: "c3", data: { name: "Dave Spencer",  email: "dave@example.com"  } },
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
    const bIds = (readJson(join(dirB, "contacts.json")) as Array<{ id: string }>).map(r => r.id);
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
      { id: "a1", data: { name: "Alice", email: "alice@example.com" } },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "b1", data: { name: "Alice", email: "ALICE@EXAMPLE.COM" } },
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
      { id: "a1", data: { name: "Alice", email: "alice@example.com" } },
      { id: "a2", data: { name: "Carol", email: "carol@example.com" } },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "b1", data: { name: "Alice", email: "alice@example.com" } },
    ]);

    const { engine, report } = await collectAndDiscoverAB(db, dirA, dirB);

    expect(report.uniquePerSide.length).toBe(1);
    expect(report.uniquePerSide[0]!.externalId).toBe("a2");

    const result = await engine.onboard("ch", report);
    expect(result.uniqueQueued).toBe(1);

    const bAfter = readJson(join(dirB, "contacts.json")) as Array<{ data: { email: string } }>;
    expect(bAfter.some(r => r.data.email === "carol@example.com")).toBe(true);
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
    const alice = aContacts.find(r => (r["data"] as Record<string, unknown>)?.["email"] === "alice@example.com")!;
    (alice["data"] as Record<string, unknown>)["name"] = "Alice Updated";
    alice["updatedAt"] = new Date().toISOString();
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
    const aliceInC = cAfter.find(r => (r["data"] as Record<string, unknown>)?.["email"] === "alice@example.com");
    expect((aliceInC?.["data"] as Record<string, unknown> | undefined)?.["name"]).toBe("Alice Liddell");
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

    const cRecords = readJson(join(dirC, "contacts.json")) as Array<{ data: { email: string } }>;
    expect(cRecords.length).toBe(4);
    expect(cRecords.some(r => r.data.email === "carol@example.com")).toBe(true);
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

// ─── T26: collectOnly with integer watermarks stores integer since ─────────────
// Regression for bug: collectOnly always stored new Date(snapshotAt).toISOString()
// regardless of watermark type. Integer-mode connectors received an ISO `since` on
// the first incremental poll, causing isNewerThan(2, "2026-...") → NaN → false →
// nothing ever picked up.

describe("T26: integer watermarks stored correctly after collectOnly", () => {
  it("stores the connector's integer since, not an ISO timestamp", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    // Seed with explicit integer watermarks
    writeJson(join(dirA, "contacts.json"), [
      { id: "a1", data: { name: "Alice", email: "alice@example.com" }, updated: 1 },
      { id: "a2", data: { name: "Bob",   email: "bob@example.com"   }, updated: 1 },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "b1", data: { name: "Alice", email: "alice@example.com" }, updated: 1 },
    ]);

    const iA = makeInstance("system-a", dirA);
    const iB = makeInstance("system-b", dirB);
    const engine = new SyncEngine(
      makeConfig([iA, iB], [
        { connectorId: "system-a", entity: "contacts" },
        { connectorId: "system-b", entity: "contacts" },
      ]),
      db,
    );

    // Run collectOnly for both connectors
    await engine.ingest("ch", "system-a", { collectOnly: true });
    await engine.ingest("ch", "system-b", { collectOnly: true });

    // Watermarks must be exactly what the connector returned in batch.since — opaque,
    // no fabrication. jsonfiles returns the integer max ("1") for these seeds.
    const rows = db
      .prepare<{ connector_id: string; since: string }>("SELECT connector_id, since FROM watermarks ORDER BY connector_id")
      .all();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.since).toBe("1");
    expect(rows[1]!.since).toBe("1");

    // Onboard, then bump a record to updated: 2
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);

    // onboard must not have touched the watermarks
    const rowsAfterOnboard = db
      .prepare<{ connector_id: string; since: string }>("SELECT connector_id, since FROM watermarks ORDER BY connector_id")
      .all();
    expect(rowsAfterOnboard[0]!.since).toBe("1");
    expect(rowsAfterOnboard[1]!.since).toBe("1");

    writeJson(join(dirA, "contacts.json"), [
      { id: "a1", data: { name: "Alice Smith", email: "alice@example.com" }, updated: 2 },
      { id: "a2", data: { name: "Bob",         email: "bob@example.com"   }, updated: 1 },
    ]);

    // Normal ingest must pick up the bumped record and fan-out to system-b
    const result = await engine.ingest("ch", "system-a");
    const updates = result.records.filter((r) => r.action === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.targetConnectorId).toBe("system-b");

    // system-b contacts.json should have Alice's new name
    const bRecords = readJson(join(dirB, "contacts.json")) as Array<{ data: { name: string } }>;
    const alice = bRecords.find((r) => r.data.name === "Alice Smith");
    expect(alice).toBeDefined();
  });
});

// ─── T27–T30: Noop update suppression ────────────────────────────────────────
// Spec: plans/engine/PLAN_NOOP_UPDATE_SUPPRESSION.md
//
// Echo detection on the source side fires when existingShadow !== undefined AND
// the canonical matches. The noop guard fires when echo detection is bypassed
// (existingShadow === undefined) but the target shadow already contains the same
// values — i.e. no actual write is needed.
//
// We simulate the missing-source-shadow case by deleting it from the DB directly
// after the first successful ingest. On the next ingest, existingShadow === undefined
// → echo detection is skipped → resolveConflicts runs → guard should suppress.

describe("T27: second poll with no source shadow → noop suppressed", () => {
  it("suppresses dispatch when target shadow already matches resolved values", async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    writeJson(join(dirA, "contacts.json"), [
      { id: "a1", data: { name: "Alice", email: "alice@example.com" }, updated: 1 },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "b1", data: { name: "Alice", email: "alice@example.com" }, updated: 1 },
    ]);

    const iA = makeInstance("system-a", dirA);
    const iB = makeInstance("system-b", dirB);
    const db = openDb(":memory:");
    const engine = new SyncEngine(makeConfig([iA, iB], [
      { connectorId: "system-a", entity: "contacts" },
      { connectorId: "system-b", entity: "contacts" },
    ]), db);

    await engine.ingest("ch", "system-a", { collectOnly: true });
    await engine.ingest("ch", "system-b", { collectOnly: true });
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);

    // Settle: first incremental so target shadow is up to date
    await engine.ingest("ch", "system-a");

    // Simulate missing source shadow (resurrection / cleared shadow scenario):
    // delete system-a's shadow so echo detection is bypassed on the next ingest.
    // Bump updated so the connector returns the record again.
    db.prepare("DELETE FROM shadow_state WHERE connector_id = 'system-a'").run();
    writeJson(join(dirA, "contacts.json"), [
      { id: "a1", data: { name: "Alice", email: "alice@example.com" }, updated: 2 },
    ]);
    // Reset watermark so the connector returns updated:2
    db.prepare("DELETE FROM watermarks WHERE connector_id = 'system-a'").run();

    // Without the noop guard: _dispatchToTarget would fire → noop write to system-b.
    // With the guard: target shadow matches resolved → skip.
    const result = await engine.ingest("ch", "system-a");
    const updates = result.records.filter((r) => r.action === "update" && r.targetConnectorId === "system-b");
    expect(updates).toHaveLength(0);
  });
});

describe("T28: poll after real change → update (not suppressed)", () => {
  it("does not suppress when a field value actually changed", async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    writeJson(join(dirA, "contacts.json"), [
      { id: "a1", data: { name: "Alice", email: "alice@example.com" }, updated: 1 },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "b1", data: { name: "Alice", email: "alice@example.com" }, updated: 1 },
    ]);

    const iA = makeInstance("system-a", dirA);
    const iB = makeInstance("system-b", dirB);
    const db = openDb(":memory:");
    const engine = new SyncEngine(makeConfig([iA, iB], [
      { connectorId: "system-a", entity: "contacts" },
      { connectorId: "system-b", entity: "contacts" },
    ]), db);

    await engine.ingest("ch", "system-a", { collectOnly: true });
    await engine.ingest("ch", "system-b", { collectOnly: true });
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);
    await engine.ingest("ch", "system-a");

    // Delete source shadow and reset watermark, then write a REAL change
    db.prepare("DELETE FROM shadow_state WHERE connector_id = 'system-a'").run();
    db.prepare("DELETE FROM watermarks WHERE connector_id = 'system-a'").run();
    writeJson(join(dirA, "contacts.json"), [
      { id: "a1", data: { name: "Alice Smith", email: "alice@example.com" }, updated: 2 },
    ]);

    const result = await engine.ingest("ch", "system-a");
    const updates = result.records.filter((r) => r.action === "update" && r.targetConnectorId === "system-b");
    expect(updates).toHaveLength(1);
  });
});

describe("T29: first propagation of association → update (not suppressed)", () => {
  it("does not suppress when an association appears that wasn't in target shadow", async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    writeJson(join(dirA, "contacts.json"), [
      { id: "a1", data: { name: "Alice", email: "alice@example.com" }, updated: 1 },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "b1", data: { name: "Alice", email: "alice@example.com" }, updated: 1 },
    ]);

    const iA = makeInstance("system-a", dirA);
    const iB = makeInstance("system-b", dirB);
    const db = openDb(":memory:");
    const engine = new SyncEngine({
      connectors: [iA, iB],
      channels: [{
        id: "ch",
        members: [
          { connectorId: "system-a", entity: "contacts", assocMappings: [{ source: "works_at", target: "worksAt" }] },
          { connectorId: "system-b", entity: "contacts", assocMappings: [{ source: "works_at", target: "worksAt" }] },
        ],
        identityFields: ["email"],
      }],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    }, db);

    await engine.ingest("ch", "system-a", { collectOnly: true });
    await engine.ingest("ch", "system-b", { collectOnly: true });
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);
    await engine.ingest("ch", "system-a");

    // Delete source shadow, reset watermark, add a new association (no targetId → passes through)
    db.prepare("DELETE FROM shadow_state WHERE connector_id = 'system-a'").run();
    db.prepare("DELETE FROM watermarks WHERE connector_id = 'system-a'").run();
    writeJson(join(dirA, "contacts.json"), [
      {
        id: "a1",
        data: { name: "Alice", email: "alice@example.com", works_at: "org-1" },
        updated: 2,
      },
    ]);

    // New field on the target → must NOT suppress
    const result = await engine.ingest("ch", "system-a");
    const updates = result.records.filter((r) => r.action === "update" && r.targetConnectorId === "system-b");
    expect(updates).toHaveLength(1);
  });
});

describe("T30: second poll with unchanged association → noop suppressed", () => {
  it("suppresses when both fields and association already match target shadow", async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    writeJson(join(dirA, "contacts.json"), [
      { id: "a1", data: { name: "Alice", email: "alice@example.com" }, updated: 1 },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "b1", data: { name: "Alice", email: "alice@example.com" }, updated: 1 },
    ]);

    const iA = makeInstance("system-a", dirA);
    const iB = makeInstance("system-b", dirB);
    const db = openDb(":memory:");
    const engine = new SyncEngine(makeConfig([iA, iB], [
      { connectorId: "system-a", entity: "contacts" },
      { connectorId: "system-b", entity: "contacts" },
    ]), db);

    await engine.ingest("ch", "system-a", { collectOnly: true });
    await engine.ingest("ch", "system-b", { collectOnly: true });
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);

    // First clear: delete source shadow + watermark, write updated:2 with association.
    // This is the first time the association is dispatched → target shadow gets __assoc__.
    db.prepare("DELETE FROM shadow_state WHERE connector_id = 'system-a'").run();
    db.prepare("DELETE FROM watermarks WHERE connector_id = 'system-a'").run();
    writeJson(join(dirA, "contacts.json"), [
      {
        id: "a1",
        data: { name: "Alice", email: "alice@example.com", works_at: "org-1" },
        updated: 2,
      },
    ]);
    await engine.ingest("ch", "system-a"); // dispatches new field → target shadow updated

    // Second clear: same data + same association, updated:3.
    // Target shadow now has __assoc__ → guard should suppress.
    db.prepare("DELETE FROM shadow_state WHERE connector_id = 'system-a'").run();
    db.prepare("DELETE FROM watermarks WHERE connector_id = 'system-a'").run();
    writeJson(join(dirA, "contacts.json"), [
      {
        id: "a1",
        data: { name: "Alice", email: "alice@example.com", works_at: "org-1" },
        updated: 3,
      },
    ]);

    const result = await engine.ingest("ch", "system-a");
    const updates = result.records.filter((r) => r.action === "update");
    expect(updates).toHaveLength(0);
  });
});

// ─── T31–T34: Deferred association retry ─────────────────────────────────────
// Spec: plans/engine/PLAN_DEFERRED_ASSOCIATIONS.md
//
// When _remapAssociations returns null (target entity not yet in identity map),
// the engine must persist a deferred_associations row and retry via lookup() on
// subsequent ingest calls so the association is not permanently lost once the
// watermark advances.

describe("T31: deferred association persisted and retried on next ingest", () => {
  it("resolves Carol's company association on the next ingest after companies are linked", async () => {
    const dirA = makeTempDir(); // system-a: contacts + companies
    const dirB = makeTempDir(); // system-b: employees + accounts

    // system-a: three contacts, three companies (including Initech)
    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com", companyId: "co1" }, updated: 1 },
      { id: "c3", data: { name: "Carol", email: "carol@example.com", companyId: "co3" }, updated: 1 },
    ]);
    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
      { id: "co3", data: { name: "Initech", domain: "initech.com" }, updated: 1 },
    ]);

    // system-b: one contact (Alice), one account (Acme) — NO Initech, NO Carol
    writeJson(join(dirB, "contacts.json"), [
      { id: "e1", data: { name: "Alice", email: "alice@example.com", companyId: "acc1" }, updated: 1 },
    ]);
    writeJson(join(dirB, "accounts.json"), [
      { id: "acc1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);

    const makeInst = (id: string, dir: string, entities: string[]) => ({
      id,
      connector: jsonfiles,
      config: { entities: Object.fromEntries(entities.map((e) => [e, { filePath: join(dir, `${e}.json`), ...(e === "contacts" ? { schema: { companyId: { entity: "companies" } } } : {}) }])) },
      auth: {},
      batchIdRef: { current: undefined } as { current: string | undefined },
      triggerRef: { current: undefined } as { current: "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh" | undefined },
    });

    const iA = makeInst("system-a", dirA, ["contacts", "companies"]);
    const iB = makeInst("system-b", dirB, ["contacts", "accounts"]);

    const db = openDb(":memory:");
    const engine = new SyncEngine({
      connectors: [iA, iB],
      channels: [
        { id: "companies", members: [
            { connectorId: "system-a", entity: "companies" },
            { connectorId: "system-b", entity: "accounts" },
          ], identityFields: ["domain"] },
        { id: "contacts", members: [
            { connectorId: "system-a", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
            { connectorId: "system-b", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
          ], identityFields: ["email"] },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    }, db);

    // Onboard contacts first — Initech not yet in identity map, Carol's association deferred
    await engine.ingest("contacts", "system-a", { collectOnly: true });
    await engine.ingest("contacts", "system-b", { collectOnly: true });
    const contactsReport = await engine.discover("contacts");
    await engine.onboard("contacts", contactsReport);

    // Onboard companies — Initech identity link now established
    await engine.ingest("companies", "system-a", { collectOnly: true });
    await engine.ingest("companies", "system-b", { collectOnly: true });
    const companiesReport = await engine.discover("companies");
    await engine.onboard("companies", companiesReport);

    // First incremental: Carol's watermark is "1", updated=1 → not returned by connector.
    // But Carol's companyId→co3 association was deferred during onboard.
    // The retry should call lookup("c3") and propagate the association.
    const result = await engine.ingest("contacts", "system-a");
    const carolUpdate = result.records.find(
      (r) => r.action === "update" && r.targetConnectorId === "system-b",
    );
    expect(carolUpdate).toBeDefined();

    // Carol's entry in system-b should now have a companyId association pointing to Initech
    const bContacts = JSON.parse(
      (await import("node:fs")).readFileSync(join(dirB, "contacts.json"), "utf8"),
    ) as Array<{ id: string; data: { email: string; companyId?: string } }>;
    const carol = bContacts.find((r) => r.data.email === "carol@example.com");
    expect(carol).toBeDefined();
    expect(carol!.data.companyId).toBeDefined();
  });
});

describe("T32: deferred row removed after successful retry", () => {
  it("removes the deferred_associations row once the association is propagated", async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com", companyId: "co2" }, updated: 1 },
    ]);
    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
      { id: "co2", data: { name: "Initech", domain: "initech.com" }, updated: 1 },
    ]);
    // sb has Acme but not Initech; contacts has no one matching Alice so she is unique
    writeJson(join(dirB, "contacts.json"), [
      { id: "e1", data: { name: "Bob", email: "bob@example.com" }, updated: 1 },
    ]);
    writeJson(join(dirB, "accounts.json"), [
      { id: "acc1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);

    const makeInst = (id: string, dir: string, entities: string[]) => ({
      id, connector: jsonfiles,
      config: { entities: Object.fromEntries(entities.map((e) => [e, { filePath: join(dir, `${e}.json`), ...(e === "contacts" ? { schema: { companyId: { entity: "companies" } } } : {}) }])) },
      auth: {},
      batchIdRef: { current: undefined } as { current: string | undefined },
      triggerRef: { current: undefined } as { current: "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh" | undefined },
    });

    const db = openDb(":memory:");
    const engine = new SyncEngine({
      connectors: [makeInst("sa", dirA, ["contacts", "companies"]), makeInst("sb", dirB, ["contacts", "accounts"])],
      channels: [
        { id: "companies", members: [{ connectorId: "sa", entity: "companies" }, { connectorId: "sb", entity: "accounts" }], identityFields: ["domain"] },
        { id: "contacts", members: [{ connectorId: "sa", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] }, { connectorId: "sb", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] }], identityFields: ["email"] },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    }, db);

    // Onboard contacts first — Initech not yet in identity map, Alice's association deferred
    await engine.ingest("contacts", "sa", { collectOnly: true });
    await engine.ingest("contacts", "sb", { collectOnly: true });
    await engine.onboard("contacts", await engine.discover("contacts"));

    // Onboard companies — establishes Initech identity link
    await engine.ingest("companies", "sa", { collectOnly: true });
    await engine.ingest("companies", "sb", { collectOnly: true });
    await engine.onboard("companies", await engine.discover("companies"));

    // After onboard, deferred row should exist for Alice's companyId
    const deferredBefore = db.prepare("SELECT COUNT(*) as n FROM deferred_associations").get() as { n: number };
    expect(deferredBefore.n).toBeGreaterThan(0);

    // Retry: should propagate and clear the row
    await engine.ingest("contacts", "sa");
    const deferredAfter = db.prepare("SELECT COUNT(*) as n FROM deferred_associations").get() as { n: number };
    expect(deferredAfter.n).toBe(0);
  });
});

describe("T33: deferred row retained when source record deleted before retry", () => {
  it("removes the deferred row (nothing to propagate) when lookup returns empty", async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com", companyId: "co2" }, updated: 1 },
    ]);
    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
      { id: "co2", data: { name: "Initech", domain: "initech.com" }, updated: 1 },
    ]);
    // sb has Bob and Acme, not Alice and not Initech — Alice is unique, her company deferred
    writeJson(join(dirB, "contacts.json"), [
      { id: "e1", data: { name: "Bob", email: "bob@example.com" }, updated: 1 },
    ]);
    writeJson(join(dirB, "accounts.json"), [
      { id: "acc1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);

    const makeInst = (id: string, dir: string, entities: string[]) => ({
      id, connector: jsonfiles,
      config: { entities: Object.fromEntries(entities.map((e) => [e, { filePath: join(dir, `${e}.json`), ...(e === "contacts" ? { schema: { companyId: { entity: "companies" } } } : {}) }])) },
      auth: {},
      batchIdRef: { current: undefined } as { current: string | undefined },
      triggerRef: { current: undefined } as { current: "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh" | undefined },
    });

    const db = openDb(":memory:");
    const engine = new SyncEngine({
      connectors: [makeInst("sa", dirA, ["contacts", "companies"]), makeInst("sb", dirB, ["contacts", "accounts"])],
      channels: [
        { id: "companies", members: [{ connectorId: "sa", entity: "companies" }, { connectorId: "sb", entity: "accounts" }], identityFields: ["domain"] },
        { id: "contacts", members: [{ connectorId: "sa", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] }, { connectorId: "sb", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] }], identityFields: ["email"] },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    }, db);

    // Onboard contacts first — Initech not yet in identity map, Alice's association deferred
    await engine.ingest("contacts", "sa", { collectOnly: true });
    await engine.ingest("contacts", "sb", { collectOnly: true });
    await engine.onboard("contacts", await engine.discover("contacts"));

    // Onboard companies — establishes Initech identity link
    await engine.ingest("companies", "sa", { collectOnly: true });
    await engine.ingest("companies", "sb", { collectOnly: true });
    await engine.onboard("companies", await engine.discover("companies"));

    // Delete Alice from source before retry
    writeJson(join(dirA, "contacts.json"), []);

    // Retry: lookup returns nothing → row should be removed (no point retrying)
    await engine.ingest("contacts", "sa");
    const deferredAfter = db.prepare("SELECT COUNT(*) as n FROM deferred_associations").get() as { n: number };
    expect(deferredAfter.n).toBe(0);
  });
});

// ─── T34–T35: Association remap correctness ───────────────────────────────────
// Spec: plans/engine/PLAN_DEFERRED_ASSOCIATIONS.md

describe("T34: deferred retry updates association for record inserted without it on first pass (echo bypass)", () => {
  it("issues an update with the association on retry even though the source shadow was already written", async () => {
    // Scenario: Dave is added to sa.contacts AFTER onboarding is complete. His company
    // (Globex/co2) is also new — not yet synced to sb. On the first ingest Dave is returned
    // by read(), all targets are deferred, and the source shadow is written (with assoc
    // sentinel). After companies are synced the watermark has already passed Dave so the
    // retry loop must bypass echo detection, otherwise the matching source shadow causes
    // a SKIP and the association is never propagated.
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com", companyId: "co1" }, updated: 1 },
    ]);
    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "e1", data: { name: "Alice", email: "alice@example.com", companyId: "acc1" }, updated: 1 },
    ]);
    writeJson(join(dirB, "accounts.json"), [
      { id: "acc1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);

    const makeInst = (id: string, dir: string, entities: string[]) => ({
      id, connector: jsonfiles,
      config: { entities: Object.fromEntries(entities.map((e) => [e, { filePath: join(dir, `${e}.json`), ...(e === "contacts" ? { schema: { companyId: { entity: "companies" } } } : {}) }])) },
      auth: {},
      batchIdRef: { current: undefined } as { current: string | undefined },
      triggerRef: { current: undefined } as { current: "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh" | undefined },
    });

    const db = openDb(":memory:");
    const engine = new SyncEngine({
      connectors: [makeInst("sa", dirA, ["contacts", "companies"]), makeInst("sb", dirB, ["contacts", "accounts"])],
      channels: [
        { id: "companies", members: [{ connectorId: "sa", entity: "companies" }, { connectorId: "sb", entity: "accounts" }], identityFields: ["domain"] },
        { id: "contacts",  members: [{ connectorId: "sa", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }]  }, { connectorId: "sb", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }]  }], identityFields: ["email"] },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    }, db);

    // Full onboard — Alice/Acme linked across both systems
    for (const ch of ["companies", "contacts"]) {
      await engine.ingest(ch, "sa", { collectOnly: true });
      await engine.ingest(ch, "sb", { collectOnly: true });
      await engine.onboard(ch, await engine.discover(ch));
    }

    // Add Dave to sa + Globex company — but only ingest contacts first (Globex not yet synced)
    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com", companyId: "co1" }, updated: 1 },
      { id: "c2", data: { name: "Dave", email: "dave@example.com", companyId: "co2" }, updated: 2 },
    ]);
    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme",   domain: "acme.com"   }, updated: 1 },
      { id: "co2", data: { name: "Globex", domain: "globex.com" }, updated: 2 },
    ]);

    // Ingest contacts: Dave returned. co2 not yet linked → eager: Dave inserted WITHOUT
    // the companyId association; source shadow written WITHOUT assoc sentinel;
    // deferred row written for the retry update.
    const firstPass = await engine.ingest("contacts", "sa");
    const daveInsert = firstPass.records.find(
      (r) => r.action === "insert" && r.sourceId === "c2" && r.targetConnectorId === "sb",
    );
    expect(daveInsert).toBeDefined();

    const deferredAfterFirst = db.prepare(
      "SELECT COUNT(*) as n FROM deferred_associations WHERE source_external_id = 'c2'",
    ).get() as { n: number };
    expect(deferredAfterFirst.n).toBeGreaterThan(0);

    // Sync companies: co2/Globex → sb creates acc_new, identity link established
    await engine.ingest("companies", "sa");

    // Second contacts ingest: c2 NOT in regular read (watermark already at "2").
    // Retry loop must bypass echo detection and dispatch the association.
    const secondPass = await engine.ingest("contacts", "sa");
    const daveUpdate = secondPass.records.find(
      (r) => (r.action === "insert" || r.action === "update") && r.targetConnectorId === "sb",
    );
    expect(daveUpdate).toBeDefined();

    const deferredAfterRetry = db.prepare(
      "SELECT COUNT(*) as n FROM deferred_associations WHERE source_external_id = 'c2'",
    ).get() as { n: number };
    expect(deferredAfterRetry.n).toBe(0);
  });
});

describe("T35: targetEntity is translated to the target connector's entity name on remap", () => {
  it("stores 'accounts' (not 'companies') as targetEntity in the ERP employee insert", async () => {
    // When crm/contacts has associations pointing at crm/companies, and those are synced
    // to erp/employees, the stored association's targetEntity must become 'accounts'
    // (the erp-side entity name in the companies channel) — not 'companies'.
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com", companyId: "co1" }, updated: 1 },
    ]);
    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "e_dummy", data: { name: "Other Person", email: "other@example.com" }, updated: 1 },
    ]);
    writeJson(join(dirB, "accounts.json"), [
      { id: "acc1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);

    const makeInst = (id: string, dir: string, entities: string[]) => ({
      id, connector: jsonfiles,
      config: { entities: Object.fromEntries(entities.map((e) => [e, { filePath: join(dir, `${e}.json`), ...(e === "contacts" ? { schema: { companyId: { entity: "companies" } } } : {}) }])) },
      auth: {},
      batchIdRef: { current: undefined } as { current: string | undefined },
      triggerRef: { current: undefined } as { current: "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh" | undefined },
    });

    const db = openDb(":memory:");
    const engine = new SyncEngine({
      connectors: [makeInst("sa", dirA, ["contacts", "companies"]), makeInst("sb", dirB, ["contacts", "accounts"])],
      channels: [
        { id: "companies", members: [{ connectorId: "sa", entity: "companies" }, { connectorId: "sb", entity: "accounts" }], identityFields: ["domain"] },
        { id: "contacts",  members: [{ connectorId: "sa", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }]  }, { connectorId: "sb", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }]  }], identityFields: ["email"] },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    }, db);

    // Onboard companies first (Acme/co1 ↔ acc1 linked), then contacts.
    // Alice is unique to sa and will be inserted into sb during contacts onboard.
    for (const ch of ["companies", "contacts"]) {
      await engine.ingest(ch, "sa", { collectOnly: true });
      await engine.ingest(ch, "sb", { collectOnly: true });
      await engine.onboard(ch, await engine.discover(ch));
    }

    // Alice should now exist in sb/contacts with her companyId pointing at the sb-side account.
    const sbContacts = readJson(join(dirB, "contacts.json")) as Array<{
      id: string;
      data: { email: string; companyId?: string };
    }>;
    const alice = sbContacts.find((r) => r.data.email === "alice@example.com");
    expect(alice).toBeDefined();
    // companyId must be the sb-side account ID (acc1)
    expect(alice!.data.companyId).toBe("acc1");
  });
});

// ─── T36–T38: Eager association dispatch (default behaviour change) ────────────
// Spec: plans/engine/PLAN_EAGER_ASSOCIATION_MODE.md
//
// When _remapAssociations returns null (association target not yet cross-linked),
// the engine must insert/update the record immediately with the resolvable associations
// only, and write a deferred row so the retry loop adds the missing association once
// the identity link is established. No record is ever withheld.

describe("T36: record with unresolvable association is inserted immediately without it", () => {
  it("inserts the contact into sb on the first pass, without the company association", async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    // Both systems start with Acme only. Globex exists only in sa.
    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com", companyId: "co1" }, updated: 1 },
      { id: "c2", data: { name: "Dave", email: "dave@example.com", companyId: "co2" }, updated: 2 },
    ]);
    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme",   domain: "acme.com"   }, updated: 1 },
      { id: "co2", data: { name: "Globex", domain: "globex.com" }, updated: 2 },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "e1", data: { name: "Alice", email: "alice@example.com", companyId: "acc1" }, updated: 1 },
    ]);
    writeJson(join(dirB, "accounts.json"), [
      { id: "acc1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);

    const makeInst = (id: string, dir: string, entities: string[]) => ({
      id, connector: jsonfiles,
      config: { entities: Object.fromEntries(entities.map((e) => [e, { filePath: join(dir, `${e}.json`), ...(e === "contacts" ? { schema: { companyId: { entity: "companies" } } } : {}) }])) },
      auth: {},
      batchIdRef: { current: undefined } as { current: string | undefined },
      triggerRef: { current: undefined } as { current: "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh" | undefined },
    });

    const db = openDb(":memory:");
    const engine = new SyncEngine({
      connectors: [makeInst("sa", dirA, ["contacts", "companies"]), makeInst("sb", dirB, ["contacts", "accounts"])],
      channels: [
        { id: "companies", members: [{ connectorId: "sa", entity: "companies" }, { connectorId: "sb", entity: "accounts" }], identityFields: ["domain"] },
        { id: "contacts",  members: [{ connectorId: "sa", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }]  }, { connectorId: "sb", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }]  }], identityFields: ["email"] },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    }, db);

    // Onboard companies first (Acme linked, Globex unique to sa → inserted into sb)
    // then contacts (Alice matched, Dave unique to sa)
    for (const ch of ["companies", "contacts"]) {
      await engine.ingest(ch, "sa", { collectOnly: true });
      await engine.ingest(ch, "sb", { collectOnly: true });
      await engine.onboard(ch, await engine.discover(ch));
    }

    // Now add a new contact Eve pointing at Globex (co2), which IS linked (inserted during
    // onboard above). This should just work — but let's use a contact pointing at a truly
    // new company (co3/Hooli) that hasn't been synced yet to test eager dispatch.
    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme",   domain: "acme.com"   }, updated: 1 },
      { id: "co2", data: { name: "Globex", domain: "globex.com" }, updated: 1 },
      { id: "co3", data: { name: "Hooli",  domain: "hooli.com"  }, updated: 3 },
    ]);
    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com", companyId: "co1" }, updated: 1 },
      { id: "c2", data: { name: "Dave", email: "dave@example.com", companyId: "co2" }, updated: 1 },
      { id: "c3", data: { name: "Eve", email: "eve@example.com", companyId: "co3" }, updated: 3 },
    ]);

    // Ingest contacts only — Hooli (co3) has never been ingested into companies channel.
    // Eve should be INSERTED into sb immediately (eager), without the companyId association.
    const result = await engine.ingest("contacts", "sa");
    const eveInsert = result.records.find(
      (r) => r.action === "insert" && r.targetConnectorId === "sb",
    );
    expect(eveInsert).toBeDefined();

    // A deferred row must exist so the retry loop will add the association later.
    const deferred = db.prepare(
      "SELECT COUNT(*) as n FROM deferred_associations WHERE source_external_id = 'c3'",
    ).get() as { n: number };
    expect(deferred.n).toBeGreaterThan(0);

    // Eve exists in sb but without the companyId value.
    const sbContacts = readJson(join(dirB, "contacts.json")) as Array<{
      data: { email: string; companyId?: string };
    }>;
    const eve = sbContacts.find((r) => r.data.email === "eve@example.com");
    expect(eve).toBeDefined();
    expect(eve!.data.companyId).toBeUndefined();
  });
});

describe("T37: deferred retry adds the association once the company is synced", () => {
  it("updates Eve's sb record with the companyId association after Hooli is synced", async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Eve", email: "eve@example.com", companyId: "co2" }, updated: 2 },
    ]);
    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme",  domain: "acme.com"  }, updated: 1 },
      { id: "co2", data: { name: "Hooli", domain: "hooli.com" }, updated: 2 },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "e1", data: { name: "Other", email: "other@example.com" }, updated: 1 },
    ]);
    writeJson(join(dirB, "accounts.json"), [
      { id: "acc1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);

    const makeInst = (id: string, dir: string, entities: string[]) => ({
      id, connector: jsonfiles,
      config: { entities: Object.fromEntries(entities.map((e) => [e, { filePath: join(dir, `${e}.json`), ...(e === "contacts" ? { schema: { companyId: { entity: "companies" } } } : {}) }])) },
      auth: {},
      batchIdRef: { current: undefined } as { current: string | undefined },
      triggerRef: { current: undefined } as { current: "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh" | undefined },
    });

    const db = openDb(":memory:");
    const engine = new SyncEngine({
      connectors: [makeInst("sa", dirA, ["contacts", "companies"]), makeInst("sb", dirB, ["contacts", "accounts"])],
      channels: [
        { id: "companies", members: [{ connectorId: "sa", entity: "companies" }, { connectorId: "sb", entity: "accounts" }], identityFields: ["domain"] },
        { id: "contacts",  members: [{ connectorId: "sa", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }]  }, { connectorId: "sb", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }]  }], identityFields: ["email"] },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    }, db);

    // Onboard contacts before companies → Eve inserted without her companyId association
    await engine.ingest("contacts", "sa", { collectOnly: true });
    await engine.ingest("contacts", "sb", { collectOnly: true });
    await engine.onboard("contacts", await engine.discover("contacts"));
    await engine.ingest("companies", "sa", { collectOnly: true });
    await engine.ingest("companies", "sb", { collectOnly: true });
    await engine.onboard("companies", await engine.discover("companies"));

    // Hooli now linked. Next contacts ingest should retry c1 and issue an update.
    const retry = await engine.ingest("contacts", "sa");
    const eveUpdate = retry.records.find(
      (r) => r.action === "update" && r.targetConnectorId === "sb",
    );
    expect(eveUpdate).toBeDefined();

    // Deferred row cleared.
    const deferred = db.prepare(
      "SELECT COUNT(*) as n FROM deferred_associations WHERE source_external_id = 'c1'",
    ).get() as { n: number };
    expect(deferred.n).toBe(0);

    // Eve's sb record now has the companyId pointing at the Hooli account.
    const sbContacts = readJson(join(dirB, "contacts.json")) as Array<{
      data: { email: string; companyId?: string };
    }>;
    const eve = sbContacts.find((r) => r.data.email === "eve@example.com");
    expect(eve).toBeDefined();
    expect(eve!.data.companyId).toBeDefined();
  });
});

describe("T38: mutual reference — no permanent stall, both associations resolve within two passes", () => {
  it("inserts both mutually-referencing new records eagerly then resolves associations on retry", async () => {
    // c1 points to c2 and c2 points to c1 — both new incremental records (post-onboard).
    // With strict mode both would stall forever. With eager, c1 (processed first) is
    // inserted without its association and gets a deferred row; c2 (processed second,
    // after c1 is committed) gets the full remap and is inserted WITH its association.
    // The retry on the next ingest resolves c1's deferred row.
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    // Seed so both systems are cross-linked
    writeJson(join(dirA, "contacts.json"), [
      { id: "seed1", data: { name: "Seed", email: "seed@example.com" }, updated: 1 },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "seed2", data: { name: "Seed", email: "seed@example.com" }, updated: 1 },
    ]);

    const makeInst = (id: string, dir: string, entities: string[]) => ({
      id, connector: jsonfiles,
      config: { entities: Object.fromEntries(entities.map((e) => [e, { filePath: join(dir, `${e}.json`), ...(e === "contacts" ? { schema: { managerId: { entity: "contacts" } } } : {}) }])) },
      auth: {},
      batchIdRef: { current: undefined } as { current: string | undefined },
      triggerRef: { current: undefined } as { current: "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh" | undefined },
    });

    const db = openDb(":memory:");
    const engine = new SyncEngine({
      connectors: [makeInst("sa", dirA, ["contacts"]), makeInst("sb", dirB, ["contacts"])],
      channels: [
        { id: "contacts", members: [{ connectorId: "sa", entity: "contacts", assocMappings: [{ source: "managerId", target: "managerId" }] }, { connectorId: "sb", entity: "contacts", assocMappings: [{ source: "managerId", target: "managerId" }] }], identityFields: ["email"] },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    }, db);

    await engine.ingest("contacts", "sa", { collectOnly: true });
    await engine.ingest("contacts", "sb", { collectOnly: true });
    await engine.onboard("contacts", await engine.discover("contacts"));

    // Add c1 and c2 referencing each other — both new to sb
    writeJson(join(dirA, "contacts.json"), [
      { id: "seed1", data: { name: "Seed", email: "seed@example.com" }, updated: 1 },
      { id: "c1", data: { name: "Alice", email: "alice@example.com", managerId: "c2" }, updated: 2 },
      { id: "c2", data: { name: "Bob", email: "bob@example.com", managerId: "c1" }, updated: 2 },
    ]);

    // First ingest: c1 processed first → partial remap, inserted without assoc, deferred.
    //              c2 processed second → c1 now committed → full remap, inserted WITH assoc.
    const firstIngest = await engine.ingest("contacts", "sa");
    const inserts = firstIngest.records.filter(
      (r) => r.action === "insert" && r.targetConnectorId === "sb",
    );
    expect(inserts.length).toBe(2);

    const deferredAfterFirst = db.prepare(
      "SELECT COUNT(*) as n FROM deferred_associations",
    ).get() as { n: number };
    expect(deferredAfterFirst.n).toBe(1); // c1 deferred; c2 resolved immediately

    // Second ingest: regular read returns nothing new (watermark past c1/c2).
    // Retry loop looks up c1 → c2 now in sb → update c1 with association.
    const secondIngest = await engine.ingest("contacts", "sa");
    const retryUpdate = secondIngest.records.find(
      (r) => r.action === "update" && r.targetConnectorId === "sb",
    );
    expect(retryUpdate).toBeDefined();

    // No permanent stall — all deferred rows cleared in two passes.
    const deferredAfterRetry = db.prepare(
      "SELECT COUNT(*) as n FROM deferred_associations",
    ).get() as { n: number };
    expect(deferredAfterRetry.n).toBe(0);

    // Both sb contacts now have their managerId value
    const sbFinal = readJson(join(dirB, "contacts.json")) as Array<{
      data: { email: string; managerId?: string };
    }>;
    const aliceFinal = sbFinal.find((r) => r.data.email === "alice@example.com");
    const bobFinal   = sbFinal.find((r) => r.data.email === "bob@example.com");
    expect(aliceFinal!.data.managerId).toBeDefined();
    expect(bobFinal!.data.managerId).toBeDefined();
  });
});

// ─── T39: 3-connector partial match — no duplicate propagation ───────────────
//
// Bug: discover() required a record to appear in ALL connectors to be "matched".
// A record in 2 of 3 connectors ended up as uniquePerSide from BOTH sides,
// causing onboard() to insert it twice into the missing connector.
// Fix: match any record appearing in 2+ connectors; 1-of-N = uniquePerSide.

describe("T39: 3-connector partial match — no duplicate propagation on onboard", () => {
  function makePartialMatchSetup() {
    const dirA = makeTempDir(); const dirB = makeTempDir(); const dirC = makeTempDir();
    writeJson(join(dirA, "contacts.json"), [
      { id: "a1", data: { name: "Alice", email: "alice@example.com" } },
      { id: "a2", data: { name: "Bob",   email: "bob@example.com"   } },
      { id: "a3", data: { name: "Carol", email: "carol@example.com" } },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "b1", data: { name: "Alice", email: "alice@example.com" } },
      { id: "b2", data: { name: "Bob",   email: "bob@example.com"   } },
    ]);
    writeJson(join(dirC, "contacts.json"), [
      { id: "c1", data: { name: "Bob",   email: "bob@example.com"   } },
    ]);
    return { dirA, dirB, dirC };
  }

  it("discover classifies Alice (in A+B) as matched, Carol (A only) as unique", async () => {
    const db = openDb(":memory:");
    const { dirA, dirB, dirC } = makePartialMatchSetup();
    const engine = new SyncEngine(
      makeConfig(
        [makeInstance("system-a", dirA), makeInstance("system-b", dirB), makeInstance("system-c", dirC)],
        [
          { connectorId: "system-a", entity: "contacts" },
          { connectorId: "system-b", entity: "contacts" },
          { connectorId: "system-c", entity: "contacts" },
        ],
      ),
      db,
    );
    await engine.ingest("ch", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "system-c", { batchId: crypto.randomUUID(), collectOnly: true });
    const report = await engine.discover("ch");

    // Bob (all 3) + Alice (A+B) = 2 matches
    expect(report.matched.length).toBe(2);
    // Carol (A only) = 1 unique
    expect(report.uniquePerSide.length).toBe(1);
    expect(report.uniquePerSide[0]!.externalId).toBe("a3");
  });

  it("onboard writes exactly one Alice per connector — no duplicates", async () => {
    const db = openDb(":memory:");
    const { dirA, dirB, dirC } = makePartialMatchSetup();
    const engine = new SyncEngine(
      makeConfig(
        [makeInstance("system-a", dirA), makeInstance("system-b", dirB), makeInstance("system-c", dirC)],
        [
          { connectorId: "system-a", entity: "contacts" },
          { connectorId: "system-b", entity: "contacts" },
          { connectorId: "system-c", entity: "contacts" },
        ],
      ),
      db,
    );
    await engine.ingest("ch", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "system-c", { batchId: crypto.randomUUID(), collectOnly: true });
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);

    const bRecords = readJson(join(dirB, "contacts.json")) as Array<{ data: { email: string } }>;
    const cRecords = readJson(join(dirC, "contacts.json")) as Array<{ data: { email: string } }>;

    // B (had Alice + Bob): gets Carol added → 3 records, exactly 1 Alice
    expect(bRecords.length).toBe(3);
    expect(bRecords.filter(r => r.data.email === "alice@example.com").length).toBe(1);

    // C (had Bob): gets Alice + Carol added → 3 records, exactly 1 Alice
    expect(cRecords.length).toBe(3);
    expect(cRecords.filter(r => r.data.email === "alice@example.com").length).toBe(1);

    // 3 people × 3 connectors = 9 identity_map rows
    const imTotal = db.prepare<{ n: number }>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
    expect(imTotal).toBe(9);
  });
});

// ─── T40: heterogeneous entity names ─────────────────────────────────────────
//
// Bug: onboard() used report.entity (= channel.members[0].entity) for ALL
// shadow_state writes, even for connectors that have a different entity name.
// E.g. channel[0]="contacts", channel[1]="employees" → B's shadow was stored
// as (system-b, "contacts") → echo detection failed on subsequent polls.
// Fix: use memberByConnector.get(connectorId).entity for each shadow write.

describe("T40: heterogeneous entity names — shadow stored with per-connector entity name", () => {
  it("shadow_state entry for matched record uses the connector's own entity name", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();
    writeJson(join(dirA, "contacts.json"), [
      { id: "a1", data: { name: "Alice", email: "alice@example.com" } },
    ]);
    writeJson(join(dirB, "employees.json"), [
      { id: "b1", data: { name: "Alice", email: "alice@example.com" } },
    ]);
    const iA = makeInstanceEntity("system-a", dirA, "contacts.json");
    const iB = makeInstanceEntity("system-b", dirB, "employees.json");
    const engine = new SyncEngine(
      makeConfig([iA, iB], [
        { connectorId: "system-a", entity: "contacts" },
        { connectorId: "system-b", entity: "employees" },
      ]),
      db,
    );
    await engine.ingest("ch", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);

    const correctRow = db.prepare<{ n: number }>(
      "SELECT COUNT(*) as n FROM shadow_state WHERE connector_id = 'system-b' AND entity_name = 'employees'",
    ).get()!.n;
    const wrongRow = db.prepare<{ n: number }>(
      "SELECT COUNT(*) as n FROM shadow_state WHERE connector_id = 'system-b' AND entity_name = 'contacts'",
    ).get()!.n;

    expect(correctRow).toBe(1); // shadow stored under correct entity name
    expect(wrongRow).toBe(0);   // NOT stored under first connector's entity name
  });

  it("normal ingest after onboard with heterogeneous entities produces 0 writes", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir(); const dirB = makeTempDir();
    writeJson(join(dirA, "contacts.json"), [
      { id: "a1", data: { name: "Alice", email: "alice@example.com" } },
    ]);
    writeJson(join(dirB, "employees.json"), [
      { id: "b1", data: { name: "Alice", email: "alice@example.com" } },
    ]);
    const iA = makeInstanceEntity("system-a", dirA, "contacts.json");
    const iB = makeInstanceEntity("system-b", dirB, "employees.json");
    const config = makeConfig([iA, iB], [
      { connectorId: "system-a", entity: "contacts" },
      { connectorId: "system-b", entity: "employees" },
    ]);
    const engine = new SyncEngine(config, db);
    await engine.ingest("ch", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
    const report = await engine.discover("ch");
    await engine.onboard("ch", report);

    // Re-ingest both — 0 writes (echo detection must work with correct entity name)
    const r1 = await engine.ingest("ch", "system-a", { batchId: crypto.randomUUID() });
    const r2 = await engine.ingest("ch", "system-b", { batchId: crypto.randomUUID() });
    const writes = [...r1.records, ...r2.records].filter(r => r.action !== "skip").length;
    expect(writes).toBe(0);
  });
});

// ─── T41: multi-channel channelStatus entity-scoping ─────────────────────────
// Regression: when two channels share the same connectors (e.g. crm/erp/hr for
// both "companies" and "contacts"), channelStatus() for the second channel must
// not see the first channel's shadow rows and falsely report "collected" — which
// caused the contacts channel to skip onboarding entirely, inserting duplicates.

describe("T41: channelStatus is scoped to the channel's own entities", () => {
  it("second channel is 'uninitialized' until its own entities are collected", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme", domain: "acme.com" } },
    ]);
    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com" } },
    ]);
    writeJson(join(dirB, "accounts.json"), [
      { id: "acc1", data: { name: "Acme", domain: "acme.com" } },
    ]);
    writeJson(join(dirB, "employees.json"), [
      { id: "e1", data: { name: "Alice", email: "alice@example.com" } },
    ]);

    const iA = {
      id: "system-a",
      connector: jsonfiles,
      config: { entities: { companies: { filePath: join(dirA, "companies.json") }, contacts: { filePath: join(dirA, "contacts.json") } } },
      auth: {},
      batchIdRef: { current: undefined },
      triggerRef: { current: undefined },
    } satisfies ResolvedConfig["connectors"][0];
    const iB = {
      id: "system-b",
      connector: jsonfiles,
      config: { entities: { accounts: { filePath: join(dirB, "accounts.json") }, employees: { filePath: join(dirB, "employees.json") } } },
      auth: {},
      batchIdRef: { current: undefined },
      triggerRef: { current: undefined },
    } satisfies ResolvedConfig["connectors"][0];

    const engine = new SyncEngine(
      {
        connectors: [iA, iB],
        channels: [
          {
            id: "companies",
            identityFields: ["domain"],
            members: [
              { connectorId: "system-a", entity: "companies" },
              { connectorId: "system-b", entity: "accounts" },
            ],
          },
          {
            id: "contacts",
            identityFields: ["email"],
            members: [
              { connectorId: "system-a", entity: "contacts" },
              { connectorId: "system-b", entity: "employees" },
            ],
          },
        ],
        conflict: { strategy: "lww" },
        readTimeoutMs: 10_000,
      },
      db,
    );

    // Before anything: both channels uninitialized
    expect(engine.channelStatus("companies")).toBe("uninitialized");
    expect(engine.channelStatus("contacts")).toBe("uninitialized");

    // Collect companies channel only
    await engine.ingest("companies", "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("companies", "system-b", { batchId: crypto.randomUUID(), collectOnly: true });

    // Companies collected; contacts must still be uninitialized (not affected by companies shadow rows)
    expect(engine.channelStatus("companies")).toBe("collected");
    expect(engine.channelStatus("contacts")).toBe("uninitialized");
  });

  it("onboarding both channels produces 0 fanout inserts on first normal ingest", async () => {
    const db = openDb(":memory:");
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme", domain: "acme.com" } },
    ]);
    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com" } },
    ]);
    writeJson(join(dirB, "accounts.json"), [
      { id: "acc1", data: { name: "Acme", domain: "acme.com" } },
    ]);
    writeJson(join(dirB, "employees.json"), [
      { id: "e1", data: { name: "Alice", email: "alice@example.com" } },
    ]);

    const iA = {
      id: "system-a",
      connector: jsonfiles,
      config: { entities: { companies: { filePath: join(dirA, "companies.json") }, contacts: { filePath: join(dirA, "contacts.json") } } },
      auth: {},
      batchIdRef: { current: undefined },
      triggerRef: { current: undefined },
    } satisfies ResolvedConfig["connectors"][0];
    const iB = {
      id: "system-b",
      connector: jsonfiles,
      config: { entities: { accounts: { filePath: join(dirB, "accounts.json") }, employees: { filePath: join(dirB, "employees.json") } } },
      auth: {},
      batchIdRef: { current: undefined },
      triggerRef: { current: undefined },
    } satisfies ResolvedConfig["connectors"][0];

    const channelDefs = [
      {
        id: "companies",
        identityFields: ["domain"],
        members: [
          { connectorId: "system-a", entity: "companies" },
          { connectorId: "system-b", entity: "accounts" },
        ],
      },
      {
        id: "contacts",
        identityFields: ["email"],
        members: [
          { connectorId: "system-a", entity: "contacts" },
          { connectorId: "system-b", entity: "employees" },
        ],
      },
    ];

    const engine = new SyncEngine(
      { connectors: [iA, iB], channels: channelDefs, conflict: { strategy: "lww" }, readTimeoutMs: 10_000 },
      db,
    );

    // Onboard both channels
    for (const ch of channelDefs) {
      await engine.ingest(ch.id, "system-a", { batchId: crypto.randomUUID(), collectOnly: true });
      await engine.ingest(ch.id, "system-b", { batchId: crypto.randomUUID(), collectOnly: true });
      const report = await engine.discover(ch.id);
      await engine.onboard(ch.id, report);
    }

    expect(engine.channelStatus("companies")).toBe("ready");
    expect(engine.channelStatus("contacts")).toBe("ready");

    // Normal ingest after onboarding — must produce 0 INSERT fanouts
    const allRecords = [];
    for (const ch of channelDefs) {
      const r1 = await engine.ingest(ch.id, "system-a", { batchId: crypto.randomUUID() });
      const r2 = await engine.ingest(ch.id, "system-b", { batchId: crypto.randomUUID() });
      allRecords.push(...r1.records, ...r2.records);
    }
    const inserts = allRecords.filter(r => r.action === "insert").length;
    expect(inserts).toBe(0);
  });
});

// ─── T42: onboard step 1b includes associations in fanout inserts ─────────────
// Regression for: onboard step 1b (matched+missing-connector fanout) issued
// INSERT without associations.
// Fix: step 1b now calls lookup() on the first available source side and includes
// the remapped associations in the INSERT, matching step 2 behaviour.
// Spec: plans/engine/PLAN_ENGINE_USABILITY.md § 3.2

describe("T42: onboard step 1b includes associations in the fanout INSERT", () => {
  it("inserted record has correct remapped associations", async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    const dirC = makeTempDir();

    // sa has companies + contacts (Alice with a companyId FK)
    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com", companyId: "co1" }, updated: 1 },
    ]);
    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);

    // sb has the same records matched (Alice + Acme)
    writeJson(join(dirB, "contacts.json"), [
      { id: "e1", data: { name: "Alice", email: "alice@example.com", companyId: "acc1" }, updated: 1 },
    ]);
    writeJson(join(dirB, "companies.json"), [
      { id: "acc1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);

    // sc has NO contacts yet — Alice will be created via step 1b fanout
    writeJson(join(dirC, "contacts.json"), [
      // sc needs at least one row so discover() doesn't throw; Dave is unrelated to Alice
      { id: "p1", data: { name: "Dave Palmer", email: "dave@example.com" }, updated: 1 },
    ]);
    writeJson(join(dirC, "companies.json"), [
      { id: "org1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);

    const makeInst = (id: string, dir: string, entities: string[]) => ({
      id, connector: jsonfiles,
      config: { entities: Object.fromEntries(entities.map((e) => [e, { filePath: join(dir, `${e}.json`), ...(e === "contacts" ? { schema: { companyId: { entity: "companies" } } } : {}) }])) },
      auth: {},
      batchIdRef: { current: undefined } as { current: string | undefined },
      triggerRef: { current: undefined } as { current: "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh" | undefined },
    });

    const db = openDb(":memory:");
    const engine = new SyncEngine({
      connectors: [
        makeInst("sa", dirA, ["contacts", "companies"]),
        makeInst("sb", dirB, ["contacts", "companies"]),
        makeInst("sc", dirC, ["contacts", "companies"]),
      ],
      channels: [
        {
          id: "companies",
          members: [
            { connectorId: "sa", entity: "companies" },
            { connectorId: "sb", entity: "companies" },
            { connectorId: "sc", entity: "companies" },
          ],
          identityFields: ["domain"],
        },
        {
          id: "contacts",
          members: [
            { connectorId: "sa", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
            { connectorId: "sb", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
            { connectorId: "sc", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
          ],
          identityFields: ["email"],
        },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    }, db);

    // Onboard companies first so the identity link is ready when contacts onboard runs
    for (const connId of ["sa", "sb", "sc"]) {
      await engine.ingest("companies", connId, { collectOnly: true });
    }
    await engine.onboard("companies", await engine.discover("companies"));

    // Onboard contacts
    for (const connId of ["sa", "sb", "sc"]) {
      await engine.ingest("contacts", connId, { collectOnly: true });
    }
    await engine.onboard("contacts", await engine.discover("contacts"));

    // sc should now have Alice with her companyId pointing at the sc-side company ID
    const scContacts = readJson(join(dirC, "contacts.json")) as Array<{
      id: string;
      data: { email: string; companyId?: string };
    }>;
    const alice = scContacts.find((r) => r.data.email === "alice@example.com");
    expect(alice).toBeDefined();
    // The companyId must be the sc-side company ID (org1)
    expect(alice!.data.companyId).toBe("org1");
  });
});

// ─── T44: RecordSyncResult association payloads ────────────────────────────────
// Regression for: before/after carry only field data, so an association-only change
// produced an UPDATE event where before == after (the actual change was invisible).
// Fix: RecordSyncResult now carries beforeAssociations / afterAssociations alongside
// before / after.  Callers can compare them to detect association-only changes.
// Spec: specs/sync-engine.md § RecordSyncResult

describe("T44: RecordSyncResult association payload fields", () => {
  it("READ result carries sourceAssociations from the incoming record", async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);
    writeJson(join(dirB, "companies.json"), [
      { id: "org1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);
    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com", companyId: "co1" }, updated: 1 },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "e1", data: { name: "Alice", email: "alice@example.com", companyId: "org1" }, updated: 1 },
    ]);

    const makeInst = (id: string, dir: string, entities: string[]) => ({
      id, connector: jsonfiles,
      config: { entities: Object.fromEntries(entities.map((e) => [e, { filePath: join(dir, `${e}.json`), ...(e === "contacts" ? { schema: { companyId: { entity: "companies" } } } : {}) }])) },
      auth: {},
      batchIdRef: { current: undefined } as { current: string | undefined },
      triggerRef: { current: undefined } as { current: "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh" | undefined },
    });

    const db = openDb(":memory:");
    const engine = new SyncEngine({
      connectors: [
        makeInst("sa", dirA, ["contacts", "companies"]),
        makeInst("sb", dirB, ["contacts", "companies"]),
      ],
      channels: [
        { id: "companies", members: [
          { connectorId: "sa", entity: "companies" },
          { connectorId: "sb", entity: "companies" },
        ], identityFields: ["domain"] },
        { id: "contacts", members: [
          { connectorId: "sa", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
          { connectorId: "sb", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
        ], identityFields: ["email"] },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    }, db);

    for (const connId of ["sa", "sb"]) await engine.ingest("companies", connId, { collectOnly: true });
    await engine.onboard("companies", await engine.discover("companies"));
    for (const connId of ["sa", "sb"]) await engine.ingest("contacts", connId, { collectOnly: true });
    await engine.onboard("contacts", await engine.discover("contacts"));

    // Warmup: settle shadows
    await engine.ingest("contacts", "sa", { fullSync: true });
    await engine.ingest("contacts", "sb", { fullSync: true });

    // Add a new contact with a FK — sa has never seen this record
    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com", companyId: "co1" }, updated: 1 },
      { id: "c2", data: { name: "Bob", email: "bob@example.com", companyId: "co1" }, updated: 2 },
    ]);

    const result = await engine.ingest("contacts", "sa");
    const readResult = result.records.find((r) => r.action === "read" && r.sourceId === "c2");
    expect(readResult).toBeDefined();
    expect(readResult!.sourceAssociations).toBeDefined();
    expect(readResult!.sourceAssociations![0].predicate).toBe("companyId");
    // No prior shadow → sourceShadowAssociations is undefined
    expect(readResult!.sourceShadowAssociations).toBeUndefined();
  });

  it("UPDATE result carries non-equal beforeAssociations/afterAssociations for an association-only change", async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
      { id: "co2", data: { name: "Beta Corp", domain: "beta.com" }, updated: 1 },
    ]);
    writeJson(join(dirB, "companies.json"), [
      { id: "org1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
      { id: "org2", data: { name: "Beta Corp", domain: "beta.com" }, updated: 1 },
    ]);
    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com", companyId: "co1" }, updated: 1 },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "e1", data: { name: "Alice", email: "alice@example.com", companyId: "org1" }, updated: 1 },
    ]);

    const makeInst = (id: string, dir: string, entities: string[]) => ({
      id, connector: jsonfiles,
      config: { entities: Object.fromEntries(entities.map((e) => [e, { filePath: join(dir, `${e}.json`), ...(e === "contacts" ? { schema: { companyId: { entity: "companies" } } } : {}) }])) },
      auth: {},
      batchIdRef: { current: undefined } as { current: string | undefined },
      triggerRef: { current: undefined } as { current: "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh" | undefined },
    });

    const db = openDb(":memory:");
    const engine = new SyncEngine({
      connectors: [
        makeInst("sa", dirA, ["contacts", "companies"]),
        makeInst("sb", dirB, ["contacts", "companies"]),
      ],
      channels: [
        { id: "companies", members: [
          { connectorId: "sa", entity: "companies" },
          { connectorId: "sb", entity: "companies" },
        ], identityFields: ["domain"] },
        { id: "contacts", members: [
          { connectorId: "sa", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
          { connectorId: "sb", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
        ], identityFields: ["email"] },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    }, db);

    for (const connId of ["sa", "sb"]) await engine.ingest("companies", connId, { collectOnly: true });
    await engine.onboard("companies", await engine.discover("companies"));
    for (const connId of ["sa", "sb"]) await engine.ingest("contacts", connId, { collectOnly: true });
    await engine.onboard("contacts", await engine.discover("contacts"));

    // Settle: warmup passes make shadows consistent
    await engine.ingest("contacts", "sa", { fullSync: true });
    await engine.ingest("contacts", "sb", { fullSync: true });
    await engine.ingest("contacts", "sa", { fullSync: true });
    await engine.ingest("contacts", "sb", { fullSync: true });

    // Alice changes company in sa (co1 → co2), fields unchanged (name/email same, timestamp bumped)
    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com", companyId: "co2" }, updated: 2 },
    ]);

    const result = await engine.ingest("contacts", "sa");

    const updateToSb = result.records.find((r) => r.action === "update" && r.targetConnectorId === "sb");
    expect(updateToSb).toBeDefined();

    // Field payloads must be equal — only the association changed
    expect(updateToSb!.before!["name"]).toBe(updateToSb!.after!["name"]);
    expect(updateToSb!.before!["email"]).toBe(updateToSb!.after!["email"]);

    // Association payloads must differ, showing the company change
    expect(updateToSb!.beforeAssociations).toBeDefined();
    expect(updateToSb!.afterAssociations).toBeDefined();
    expect(updateToSb!.beforeAssociations![0].targetId).toBe("org1"); // Acme in sb
    expect(updateToSb!.afterAssociations![0].targetId).toBe("org2"); // Beta Corp in sb
  });
});

// ─── T45: Association predicate mapping — cross-system rename ─────────────────
// Regression for: _remapAssociations passed predicate unchanged, so ERP received
// CRM's "companyId" instead of its own "orgId".
// Fix: assocMappings on each ChannelMember maps local predicate ↔ canonical name;
// outbound dispatch translates source→canonical→target predicate.
// Spec: plans/engine/PLAN_PREDICATE_MAPPING.md §2.4

describe("T45: association predicate is translated from source name to target name on dispatch", () => {
  it("CRM contact with 'companyId' is written to ERP with 'orgId' predicate", async () => {
    const dirA = makeTempDir(); // CRM: contacts with companyId, companies
    const dirB = makeTempDir(); // ERP: employees with orgId, accounts

    writeJson(join(dirA, "contacts.json"), [
      { id: "c1", data: { name: "Alice", email: "alice@example.com", companyId: "co1" }, updated: 1 },
    ]);
    writeJson(join(dirA, "companies.json"), [
      { id: "co1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);

    // ERP starts with no contacts, one account
    writeJson(join(dirB, "contacts.json"), [
      { id: "e_seed", data: { name: "Seed", email: "seed@erp.example.com" }, updated: 1 },
    ]);
    writeJson(join(dirB, "accounts.json"), [
      { id: "acc1", data: { name: "Acme", domain: "acme.com" }, updated: 1 },
    ]);

    const makeInst = (id: string, dir: string, entities: string[], schemas?: Record<string, Record<string, { entity: string }>>) => ({
      id, connector: jsonfiles,
      config: { entities: Object.fromEntries(entities.map((e) => [e, { filePath: join(dir, `${e}.json`), ...(schemas?.[e] ? { schema: schemas[e] } : {}) }])) },
      auth: {},
      batchIdRef: { current: undefined } as { current: string | undefined },
      triggerRef: { current: undefined } as { current: "poll" | "webhook" | "on_enable" | "on_disable" | "oauth_refresh" | undefined },
    });

    const db = openDb(":memory:");
    const engine = new SyncEngine({
      connectors: [
        makeInst("crm", dirA, ["contacts", "companies"], { contacts: { companyId: { entity: "companies" } } }),
        makeInst("erp", dirB, ["contacts", "accounts"], { contacts: { orgId: { entity: "accounts" } } }),
      ],
      channels: [
        { id: "companies", members: [
          { connectorId: "crm", entity: "companies" },
          { connectorId: "erp", entity: "accounts" },
        ], identityFields: ["domain"] },
        { id: "contacts", members: [
          { connectorId: "crm", entity: "contacts",
            assocMappings: [{ source: "companyId", target: "companyRef" }] },
          { connectorId: "erp", entity: "contacts",
            assocMappings: [{ source: "orgId", target: "companyRef" }] },
        ], identityFields: ["email"] },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    }, db);

    // Onboard companies first so acc1/co1 identity link exists
    for (const connId of ["crm", "erp"]) {
      await engine.ingest("companies", connId, { collectOnly: true });
    }
    await engine.onboard("companies", await engine.discover("companies"));

    // Onboard contacts — Alice is unique to CRM and will be inserted into ERP
    for (const connId of ["crm", "erp"]) {
      await engine.ingest("contacts", connId, { collectOnly: true });
    }
    await engine.onboard("contacts", await engine.discover("contacts"));

    // ERP's contacts file should have Alice with orgId pointing at the ERP-side account
    const erpContacts = readJson(join(dirB, "contacts.json")) as Array<{
      id: string;
      data: { email: string; orgId?: string };
    }>;
    const alice = erpContacts.find((r) => r.data.email === "alice@example.com");
    expect(alice).toBeDefined();
    // orgId must be the ERP-side account ID (acc1)
    expect(alice!.data.orgId).toBe("acc1");

    // Incremental ingest from CRM → no spurious UPDATEs to ERP (echo detection correct)
    const result = await engine.ingest("contacts", "crm");
    const updatesToErp = result.records.filter((r) => r.action === "update" && r.targetConnectorId === "erp");
    expect(updatesToErp).toHaveLength(0);
  });
});

// ─── T46: empty-data record fanout ────────────────────────────────────────────
// Regression: a record with no declared identity field and empty data ({}}) was
// silently skipped during fanout because resolveConflicts({}, undefined) === {}
// and the zero-key guard treated it as a noop.  The engine must insert the record
// in the target connector and write an identity_map row even when canonical data
// is empty.

describe("T46: record with empty data fans out and is linked in identity_map", () => {
  it("inserts the empty record in the target and creates an identity_map row", async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    // Seed both sides with a matching record so the channel is onboarded and
    // cross-linked (fan-out guard requires cross-linked connectors).
    writeJson(join(dirA, "contacts.json"), [
      { id: "seed1", data: { email: "seed@example.com" } },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { id: "seed1b", data: { email: "seed@example.com" } },
    ]);

    const db = openDb(":memory:");
    const iA = makeInstance("system-a", dirA);
    const iB = makeInstance("system-b", dirB);
    const engine = new SyncEngine(
      makeConfig([iA, iB], [
        { connectorId: "system-a", entity: "contacts" },
        { connectorId: "system-b", entity: "contacts" },
      ]),
      db,
    );

    // Onboard so both sides are cross-linked
    await engine.ingest("ch", "system-a", { collectOnly: true });
    await engine.ingest("ch", "system-b", { collectOnly: true });
    await engine.onboard("ch", await engine.discover("ch"));

    // Insert a new record with empty data into system-a
    const emptyRecord = { id: "empty1", data: {} };
    const existing = readJson(join(dirA, "contacts.json")) as unknown[];
    writeJson(join(dirA, "contacts.json"), [...existing, emptyRecord]);

    // Ingest from system-a — should fan out to system-b
    const result = await engine.ingest("ch", "system-a");
    const insertToB = result.records.filter(
      (r) => r.action === "insert" && r.targetConnectorId === "system-b",
    );

    // The empty record must be inserted in system-b (not skipped)
    expect(insertToB).toHaveLength(1);
    expect(insertToB[0]!.sourceId).toBe("empty1");

    // system-b must have a non-empty targetId (the assigned ID)
    expect(insertToB[0]!.targetId).not.toBe("");

    // identity_map must have a row for system-b
    const identityRows = db
      .prepare<{ connector_id: string; external_id: string }>(
        "SELECT connector_id, external_id FROM identity_map WHERE canonical_id = " +
        "(SELECT canonical_id FROM identity_map WHERE connector_id = 'system-a' AND external_id = 'empty1')",
      )
      .all();
    const bRow = identityRows.find((r) => r.connector_id === "system-b");
    expect(bRow).toBeDefined();
    expect(bRow!.external_id).not.toBe("");

    // system-b output file must contain the new record
    const bRecords = readJson(join(dirB, "contacts.json")) as Array<{ id: string }>;
    expect(bRecords.some((r) => r.id === bRow!.external_id)).toBe(true);
  });
});

// ─── T47: channelStatus and onboardedConnectors with zero members ─────────────
// Regression: building the SQL WHERE clause from an empty members array produced
// "WHERE ()" and "IN ()", which are syntax errors in SQLite.

describe("T47: channel with zero members does not throw", () => {
  it("channelStatus returns 'uninitialized' for a memberless channel", () => {
    const db = openDb(":memory:");
    createSchema(db);
    const engine = new SyncEngine(
      {
        connectors: [],
        channels: [{ id: "empty-ch", members: [], identityFields: [] }],
        conflict: { strategy: "lww" },
        readTimeoutMs: 10_000,
      },
      db,
    );
    expect(engine.channelStatus("empty-ch")).toBe("uninitialized");
    expect(engine.onboardedConnectors("empty-ch")).toEqual([]);
    db.close();
  });
});
