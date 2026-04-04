/**
 * POC v7 engine tests — Discoverability & Onboarding
 *
 * Test coverage:
 *   discover()
 *     1.  Returns correct match/unique counts for pre-seeded JSON files
 *     2.  Makes zero DB writes (snapshot before = snapshot after)
 *     3.  Records with no identity fields are all treated as unique
 *
 *   onboard()
 *     4.  Writes correct identity_map and shadow_state rows for matched records
 *     5.  After onboard(), ingest() on both sides produces zero inserts
 *     6.  After onboard() + one edit on side A, ingest() produces exactly one update on side B
 *     7.  propagateUnique: true (default) — unique records are created in the other connector
 *     8.  propagateUnique: false — unique records are skipped (no writes to the other connector)
 *     9.  Watermarks are advanced so next incremental sync is clean
 *
 *   channelStatus()
 *    10.  Returns "uninitialized" before onboard(), "ready" after
 *
 *   ingest() guard
 *    11.  Throws OnboardingRequiredError when target has data and channel is uninitialized
 *    12.  skipOnboardingCheck: true → succeeds and creates duplicates (negative test)
 *    13.  Guard does not fire when target is empty (fresh install, one side only)
 *    14.  Guard does not fire after onboard()
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import {
  SyncEngine,
  makeConnectorInstance,
  OnboardingRequiredError,
  applyRename,
} from "./engine.js";
import type { ChannelConfig } from "./engine.js";
import { openDb } from "./db.js";
import type { Db } from "./db.js";
import jsonfiles from "../../connectors/jsonfiles/src/index.js";

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeTempDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "opensync-v7-"));
  return openDb(join(dir, "state.db"));
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "opensync-v7-data-"));
}

function writeJson(filePath: string, records: unknown[]): void {
  writeFileSync(filePath, JSON.stringify(records, null, 2), "utf8");
}

function readJson(filePath: string): unknown[] {
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown[];
}

/** Seed both sides with the same 3 contacts using different IDs (simulating a prior sync). */
function seedBothSides(dirA: string, dirB: string): void {
  writeJson(join(dirA, "contacts.json"), [
    { _id: "a1", name: "Alice Liddell", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "a2", name: "Bob Martin", email: "bob@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "a3", name: "Carol White", email: "carol@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
  ]);
  writeJson(join(dirB, "contacts.json"), [
    { _id: "b1", name: "Alice Liddell", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "b2", name: "Bob Martin", email: "bob@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    { _id: "b3", name: "Carol White", email: "carol@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
  ]);
}

function makeInstances(db: Db, dirA: string, dirB: string) {
  const instanceA = makeConnectorInstance(
    "system-a",
    jsonfiles,
    { filePaths: [join(dirA, "contacts.json")] },
    {},
    db,
    "http://localhost:14007",
  );
  const instanceB = makeConnectorInstance(
    "system-b",
    jsonfiles,
    { filePaths: [join(dirB, "contacts.json")] },
    {},
    db,
    "http://localhost:14007",
  );
  return { instanceA, instanceB };
}

const CHANNEL: ChannelConfig = {
  id: "contacts-channel",
  members: [
    { connectorId: "system-a", entity: "contacts" },
    { connectorId: "system-b", entity: "contacts" },
  ],
  identityFields: ["email"],
};

function makeEngine(db: Db, dirA: string, dirB: string): SyncEngine {
  const { instanceA, instanceB } = makeInstances(db, dirA, dirB);
  return new SyncEngine({ connectors: [instanceA, instanceB], channels: [CHANNEL] }, db);
}

// ─── Suite: discover() ───────────────────────────────────────────────────────

describe("discover()", () => {
  it("returns correct match/unique counts for pre-seeded JSON files", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    seedBothSides(dirA, dirB);
    const engine = makeEngine(db, dirA, dirB);

    const report = await engine.discover("contacts-channel");

    expect(report.channelId).toBe("contacts-channel");
    expect(report.entity).toBe("contacts");
    expect(report.matched.length).toBe(3);
    expect(report.uniquePerSide.length).toBe(0);
    expect(report.summary["system-a"]).toEqual({ total: 3, matched: 3, unique: 0 });
    expect(report.summary["system-b"]).toEqual({ total: 3, matched: 3, unique: 0 });
  });

  it("returns unique records when sides have non-overlapping data", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    writeJson(join(dirA, "contacts.json"), [
      { _id: "a1", name: "Alice", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    writeJson(join(dirB, "contacts.json"), [
      { _id: "b1", name: "Bob", email: "bob@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    const engine = makeEngine(db, dirA, dirB);

    const report = await engine.discover("contacts-channel");

    expect(report.matched.length).toBe(0);
    expect(report.uniquePerSide.length).toBe(2);
    expect(report.summary["system-a"]).toEqual({ total: 1, matched: 0, unique: 1 });
    expect(report.summary["system-b"]).toEqual({ total: 1, matched: 0, unique: 1 });
  });

  it("makes zero DB writes", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    seedBothSides(dirA, dirB);
    const engine = makeEngine(db, dirA, dirB);

    // Snapshot DB state
    const beforeIM = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
    const beforeSS = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM shadow_state").get()!.n;

    await engine.discover("contacts-channel");

    expect(db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n).toBe(beforeIM);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM shadow_state").get()!.n).toBe(beforeSS);
  });

  it("returns all records as unique when no identityFields are set", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    seedBothSides(dirA, dirB);

    const instanceA = makeConnectorInstance("sys-a", jsonfiles, { filePaths: [join(dirA, "contacts.json")] }, {}, db, "http://localhost:14007");
    const instanceB = makeConnectorInstance("sys-b", jsonfiles, { filePaths: [join(dirB, "contacts.json")] }, {}, db, "http://localhost:14007");
    const engine = new SyncEngine({
      connectors: [instanceA, instanceB],
      channels: [{ id: "ch", members: [{ connectorId: "sys-a", entity: "contacts" }, { connectorId: "sys-b", entity: "contacts" }] }],
      // intentionally no identityFields
    }, db);

    const report = await engine.discover("ch");
    expect(report.matched.length).toBe(0);
    expect(report.uniquePerSide.length).toBe(6); // 3 per side
  });
});

// ─── Suite: onboard() ────────────────────────────────────────────────────────

describe("onboard()", () => {
  it("writes correct identity_map and shadow_state rows for matched records", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    seedBothSides(dirA, dirB);
    const engine = makeEngine(db, dirA, dirB);

    const report = await engine.discover("contacts-channel");
    const result = await engine.onboard("contacts-channel", report);

    expect(result.linked).toBe(6); // 3 pairs × 2 sides
    expect(result.shadowsSeeded).toBe(6);
    expect(result.uniqueQueued).toBe(0);
    expect(result.uniqueSkipped).toBe(0);

    // Verify identity_map has 6 rows
    const imRows = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM identity_map").get()!.n;
    expect(imRows).toBe(6);

    // Verify each pair shares the same canonical_id
    const a1Canon = db.query<{ canonical_id: string }, [string, string]>(
      "SELECT canonical_id FROM identity_map WHERE connector_id = ? AND external_id = ?",
    ).get("system-a", "a1")!.canonical_id;
    const b1Canon = db.query<{ canonical_id: string }, [string, string]>(
      "SELECT canonical_id FROM identity_map WHERE connector_id = ? AND external_id = ?",
    ).get("system-b", "b1")!.canonical_id;
    expect(a1Canon).toBe(b1Canon);
  });

  it("after onboard(), ingest() on both sides produces zero inserts", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    seedBothSides(dirA, dirB);
    const engine = makeEngine(db, dirA, dirB);

    const report = await engine.discover("contacts-channel");
    await engine.onboard("contacts-channel", report);

    const r1 = await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() });
    const r2 = await engine.ingest("contacts-channel", "system-b", { batchId: crypto.randomUUID() });

    const insertedA = r1.records.filter((r) => r.action === "insert").length;
    const insertedB = r2.records.filter((r) => r.action === "insert").length;
    expect(insertedA).toBe(0);
    expect(insertedB).toBe(0);
    // The advanced watermark means the connector filters records at source — nothing comes back
  });

  it("after onboard() + one edit on side A, ingest() produces exactly one update on side B", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    seedBothSides(dirA, dirB);
    const engine = makeEngine(db, dirA, dirB);

    const report = await engine.discover("contacts-channel");
    await engine.onboard("contacts-channel", report);

    // Modify Alice's email on side A (after watermark)
    const contacts = readJson(join(dirA, "contacts.json")) as Array<Record<string, unknown>>;
    const alice = contacts.find((c) => c["email"] === "alice@example.com")!;
    alice["email"] = "alice@updated.com";
    alice["_updatedAt"] = new Date().toISOString();
    writeJson(join(dirA, "contacts.json"), contacts);

    // Incremental ingest from A should pick up the change and update B
    await new Promise((r) => setTimeout(r, 5)); // ensure watermark chronology
    const result = await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() });

    const updates = result.records.filter((r) => r.action === "update");
    expect(updates.length).toBe(1);

    // Confirm system-b was updated
    const bContacts = readJson(join(dirB, "contacts.json")) as Array<Record<string, unknown>>;
    expect(bContacts.some((c) => c["email"] === "alice@updated.com")).toBe(true);
  });

  it("propagateUnique: true — unique records are created in the other connector", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    // A has 3 contacts, B is empty
    writeJson(join(dirA, "contacts.json"), [
      { _id: "a1", name: "Alice", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
      { _id: "a2", name: "Bob", email: "bob@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
      { _id: "a3", name: "Carol", email: "carol@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    writeJson(join(dirB, "contacts.json"), []);
    const engine = makeEngine(db, dirA, dirB);

    const report = await engine.discover("contacts-channel");
    expect(report.matched.length).toBe(0);
    expect(report.uniquePerSide.length).toBe(3);

    const result = await engine.onboard("contacts-channel", report, { propagateUnique: true });
    expect(result.uniqueQueued).toBe(3);

    // system-b should now have 3 records
    const bContacts = readJson(join(dirB, "contacts.json")) as unknown[];
    expect(bContacts.length).toBe(3);
  });

  it("propagateUnique: false — unique records are skipped", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    writeJson(join(dirA, "contacts.json"), [
      { _id: "a1", name: "Alice", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    writeJson(join(dirB, "contacts.json"), []);
    const engine = makeEngine(db, dirA, dirB);

    const report = await engine.discover("contacts-channel");
    const result = await engine.onboard("contacts-channel", report, { propagateUnique: false });

    expect(result.uniqueSkipped).toBe(1);
    expect(result.uniqueQueued).toBe(0);

    // system-b should still be empty
    expect(readJson(join(dirB, "contacts.json")).length).toBe(0);
  });

  it("watermarks are advanced so next incremental ingest starts clean", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    seedBothSides(dirA, dirB);
    const engine = makeEngine(db, dirA, dirB);

    const report = await engine.discover("contacts-channel");
    await engine.onboard("contacts-channel", report);

    // Verify watermarks were written for both connectors
    const wmA = db.query<{ since: string }, [string, string]>(
      "SELECT since FROM watermarks WHERE connector_id = ? AND entity_name = ?",
    ).get("system-a", "contacts");
    const wmB = db.query<{ since: string }, [string, string]>(
      "SELECT since FROM watermarks WHERE connector_id = ? AND entity_name = ?",
    ).get("system-b", "contacts");

    expect(wmA).toBeDefined();
    expect(wmB).toBeDefined();

    // Watermark should be a valid ISO timestamp
    expect(new Date(wmA!.since).getFullYear()).toBeGreaterThanOrEqual(2025);
    expect(new Date(wmB!.since).getFullYear()).toBeGreaterThanOrEqual(2025);

    // Incremental ingest after onboard should produce zero results (all already onboarded, watermark filters them)
    const r = await engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() });
    expect(r.records.filter((x) => x.action === "insert").length).toBe(0);
  });
});

// ─── Suite: channelStatus() ──────────────────────────────────────────────────

describe("channelStatus()", () => {
  it("returns 'uninitialized' before onboard(), 'ready' after", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    seedBothSides(dirA, dirB);
    const engine = makeEngine(db, dirA, dirB);

    expect(engine.channelStatus("contacts-channel")).toBe("uninitialized");

    const report = await engine.discover("contacts-channel");
    await engine.onboard("contacts-channel", report);

    expect(engine.channelStatus("contacts-channel")).toBe("ready");
  });
});

// ─── Suite: ingest() guard ───────────────────────────────────────────────────

describe("ingest() OnboardingRequiredError guard", () => {
  it("throws OnboardingRequiredError when target has data and channel is uninitialized", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    seedBothSides(dirA, dirB);
    const engine = makeEngine(db, dirA, dirB);

    await expect(
      engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() }),
    ).rejects.toThrow(OnboardingRequiredError);
  });

  it("skipOnboardingCheck: true succeeds and creates duplicates", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    seedBothSides(dirA, dirB);
    const engine = makeEngine(db, dirA, dirB);

    const result = await engine.ingest("contacts-channel", "system-a", {
      batchId: crypto.randomUUID(),
      skipOnboardingCheck: true,
    });

    // All 3 records should be inserted into system-b (duplicates)
    const inserts = result.records.filter((r) => r.action === "insert");
    expect(inserts.length).toBe(3);

    // system-b now has 6 records (3 original + 3 duplicates)
    const bContacts = readJson(join(dirB, "contacts.json")) as unknown[];
    expect(bContacts.length).toBe(6);
  });

  it("guard does not fire when target connector is empty", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    // Only system-a has data; system-b is empty
    writeJson(join(dirA, "contacts.json"), [
      { _id: "a1", name: "Alice", email: "alice@example.com", _updatedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    writeJson(join(dirB, "contacts.json"), []);
    const engine = makeEngine(db, dirA, dirB);

    // Should not throw — B is empty so there is no duplication risk
    await expect(
      engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() }),
    ).resolves.toBeDefined();

    // system-b should now have 1 record
    expect((readJson(join(dirB, "contacts.json")) as unknown[]).length).toBe(1);
  });

  it("guard does not fire after onboard()", async () => {
    const db = makeTempDb();
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    seedBothSides(dirA, dirB);
    const engine = makeEngine(db, dirA, dirB);

    const report = await engine.discover("contacts-channel");
    await engine.onboard("contacts-channel", report);

    // Should not throw
    await expect(
      engine.ingest("contacts-channel", "system-a", { batchId: crypto.randomUUID() }),
    ).resolves.toBeDefined();
  });
});
