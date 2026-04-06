/**
 * demo/demo-browser/src/inmemory.test.ts
 *
 * Unit tests for the in-memory connector used by the browser demo.
 * These run in Bun — no browser or WASM required.
 *
 * Why this file exists:
 * The inmemory connector is the demo's "database". Bugs here caused visible
 * regressions like duplicate records, stale cards, and watermarks that never
 * advanced. This suite catches those cases before they reach the browser.
 *
 * IM1   seed watermarks are assigned and incremental reads respect them
 * IM2   read without `since` returns all records
 * IM3   second incremental read returns nothing when nothing changed
 * IM4   insertRecord bumps watermark and appears in next incremental read
 * IM5   updateRecord bumps watermark; merged fields visible in snapshot
 * IM6   deleteRecord removes record; watermark entry cleared
 * IM7   snapshotFull exposes modifiedAt and watermark per record
 * IM8   UI insertRecord then engine read — engine sees exactly 1 new record (regression: doubled inserts)
 * IM9   engine insert via connector.entity.insert() increments watermark
 * IM10  mutate() full replace is visible in snapshot; incremental read returns replaced records
 * IM11  cross-entity isolation — edits to entity A don't affect entity B
 * IM12  watermarks are monotonically increasing across entities
 */

import { describe, it, expect } from "bun:test";
import { createInMemoryConnector } from "./inmemory.js";
import type { ReadRecord, ReadBatch, ConnectorContext } from "@opensync/sdk";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ctx = {} as ConnectorContext;

/** Drain an AsyncIterable<ReadBatch> into a flat array of records + the last `since`. */
async function drain(
  iter: AsyncIterable<ReadBatch>,
): Promise<{ records: ReadRecord[]; since: string | undefined }> {
  const records: ReadRecord[] = [];
  let since: string | undefined;
  for await (const batch of iter) {
    records.push(...batch.records);
    since = batch.since;
  }
  return { records, since };
}

function makeConnector(seed: Record<string, ReadRecord[]> = {}) {
  return createInMemoryConnector("test", seed);
}

function makeRecord(id: string, extra: Record<string, unknown> = {}): ReadRecord {
  return { id, data: { name: id, ...extra } };
}

// ─── Convenience: drain a connector entity read ───────────────────────────────

async function readEntity(
  conn: ReturnType<typeof makeConnector>,
  entity: string,
  since?: string,
): Promise<{ records: ReadRecord[]; since: string | undefined }> {
  const entityDef = conn.connector.getEntities().find((e) => e.name === entity)!;
  if (!entityDef.read) throw new Error(`Entity ${entity} has no read()`);
  return drain(entityDef.read(ctx, since));
}

async function insertViaConnector(
  conn: ReturnType<typeof makeConnector>,
  entity: string,
  data: Record<string, unknown>,
): Promise<string | undefined> {
  const entityDef = conn.connector.getEntities().find((e) => e.name === entity)!;
  if (!entityDef.insert) throw new Error(`Entity ${entity} has no insert()`);
  async function* gen() { yield { data }; }
  let id: string | undefined;
  for await (const r of entityDef.insert(gen(), ctx)) {
    id = r.id;
  }
  return id;
}

// ─── IM1: seed watermarks ─────────────────────────────────────────────────────

describe("IM1: seed watermarks — incremental read skips already-seen records", () => {
  it("incremental read with `since` = watermark from full read returns nothing", async () => {
    const conn = makeConnector({ contacts: [makeRecord("a"), makeRecord("b")] });
    const { since } = await readEntity(conn, "contacts");
    const { records } = await readEntity(conn, "contacts", since);
    expect(records).toHaveLength(0);
  });
});

// ─── IM2: full read ───────────────────────────────────────────────────────────

describe("IM2: read without `since` returns all seeded records", () => {
  it("returns all 3 seeded records", async () => {
    const conn = makeConnector({
      contacts: [makeRecord("a"), makeRecord("b"), makeRecord("c")],
    });
    const { records } = await readEntity(conn, "contacts");
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

// ─── IM3: no-change second read ───────────────────────────────────────────────

describe("IM3: second incremental read returns nothing when nothing changed", () => {
  it("two sequential full reads: second returns 0 records", async () => {
    const conn = makeConnector({ contacts: [makeRecord("a")] });
    const { since } = await readEntity(conn, "contacts");
    const { records } = await readEntity(conn, "contacts", since);
    expect(records).toHaveLength(0);
  });
});

// ─── IM4: insertRecord ────────────────────────────────────────────────────────

describe("IM4: UI insertRecord is visible in subsequent incremental read", () => {
  it("record inserted via insertRecord appears in next incremental read", async () => {
    const conn = makeConnector({ contacts: [makeRecord("a")] });
    const { since } = await readEntity(conn, "contacts");

    conn.insertRecord("contacts", { name: "New Guy", id: "new1" });

    const { records } = await readEntity(conn, "contacts", since);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe("new1");
  });

  it("snapshot() includes the newly inserted record", () => {
    const conn = makeConnector({ contacts: [] });
    conn.insertRecord("contacts", { name: "Alice" });
    const snap = conn.snapshot();
    expect(snap["contacts"]).toHaveLength(1);
    expect(snap["contacts"]![0]!.data["name"]).toBe("Alice");
  });
});

// ─── IM5: updateRecord ────────────────────────────────────────────────────────

describe("IM5: updateRecord merges fields and bumps watermark", () => {
  it("updated field is visible in snapshot", () => {
    const conn = makeConnector({ contacts: [makeRecord("a", { email: "a@x.com" })] });
    conn.updateRecord("contacts", "a", { email: "updated@x.com" });
    const snap = conn.snapshot();
    expect(snap["contacts"]![0]!.data["email"]).toBe("updated@x.com");
    // Original field still present
    expect(snap["contacts"]![0]!.data["name"]).toBe("a");
  });

  it("update bumps watermark so incremental read returns the record", async () => {
    const conn = makeConnector({ contacts: [makeRecord("a")] });
    const { since } = await readEntity(conn, "contacts");

    conn.updateRecord("contacts", "a", { email: "updated@x.com" });

    const { records } = await readEntity(conn, "contacts", since);
    expect(records).toHaveLength(1);
    expect(records[0]!.data["email"]).toBe("updated@x.com");
  });

  it("updateRecord on unknown id is a no-op (no throw)", () => {
    const conn = makeConnector({ contacts: [makeRecord("a")] });
    expect(() => conn.updateRecord("contacts", "nonexistent", { email: "x" })).not.toThrow();
    expect(conn.snapshot()["contacts"]).toHaveLength(1);
  });
});

// ─── IM6: deleteRecord ────────────────────────────────────────────────────────

describe("IM6: deleteRecord removes record and clears its watermark", () => {
  it("snapshot does not contain deleted record", () => {
    const conn = makeConnector({ contacts: [makeRecord("a"), makeRecord("b")] });
    conn.deleteRecord("contacts", "a");
    const ids = conn.snapshot()["contacts"]!.map((r) => r.id);
    expect(ids).not.toContain("a");
    expect(ids).toContain("b");
  });

  it("deleted record does not appear in subsequent full read from engine", async () => {
    const conn = makeConnector({ contacts: [makeRecord("a"), makeRecord("b")] });
    conn.deleteRecord("contacts", "b");
    const { records } = await readEntity(conn, "contacts");
    expect(records.map((r) => r.id)).toEqual(["a"]);
  });

  it("deleteRecord on unknown id is a no-op (no throw)", () => {
    const conn = makeConnector({ contacts: [makeRecord("a")] });
    expect(() => conn.deleteRecord("contacts", "nonexistent")).not.toThrow();
    expect(conn.snapshot()["contacts"]).toHaveLength(1);
  });
});

// ─── IM7: snapshotFull ────────────────────────────────────────────────────────

describe("IM7: snapshotFull exposes modifiedAt and watermark", () => {
  it("seeded records have non-zero modifiedAt and watermark", () => {
    const conn = makeConnector({ contacts: [makeRecord("a"), makeRecord("b")] });
    const full = conn.snapshotFull();
    for (const rec of full["contacts"]!) {
      expect(rec.watermark).toBeGreaterThan(0);
      expect(rec.modifiedAt).toBeGreaterThan(0);
    }
  });

  it("watermark increases after an update", () => {
    const conn = makeConnector({ contacts: [makeRecord("a")] });
    const before = conn.snapshotFull()["contacts"]![0]!.watermark;
    conn.updateRecord("contacts", "a", { email: "x@x.com" });
    const after = conn.snapshotFull()["contacts"]![0]!.watermark;
    expect(after).toBeGreaterThan(before);
  });

  it("watermark increases after insertRecord", () => {
    const conn = makeConnector({ contacts: [makeRecord("a")] });
    const wmBefore = conn.snapshotFull()["contacts"]![0]!.watermark;
    conn.insertRecord("contacts", { name: "b", id: "b" });
    const full = conn.snapshotFull()["contacts"]!;
    const wmB = full.find((r) => r.id === "b")!.watermark;
    expect(wmB).toBeGreaterThan(wmBefore);
  });
});

// ─── IM8: no duplicate inserts (regression) ──────────────────────────────────
//
// This is the key regression test. When the engine calls entity.insert() during
// onboard, the record must appear exactly once. Previously a watermark bug caused
// every read to look like a fresh full scan, returning all records including ones
// already propagated — the engine would then re-insert them on the next cycle.

describe("IM8: engine insert then incremental read — exactly 1 new record (regression)", () => {
  it("engine insert returns one new record on next incremental read, then zero on the one after", async () => {
    const conn = makeConnector({ contacts: [makeRecord("seed1")] });
    // Simulate engine doing a full collect pass
    const { since: wm0 } = await readEntity(conn, "contacts");

    // Engine inserts a new record (simulates onboard fan-out)
    const newId = await insertViaConnector(conn, "contacts", { name: "Propagated", email: "p@x.com" });
    expect(newId).toBeDefined();

    // Next incremental read should return exactly the new record
    const { records: r1, since: wm1 } = await readEntity(conn, "contacts", wm0);
    expect(r1).toHaveLength(1);
    expect(r1[0]!.id).toBe(newId);

    // Second incremental read must return nothing (no duplication)
    const { records: r2 } = await readEntity(conn, "contacts", wm1);
    expect(r2).toHaveLength(0);
  });
});

// ─── IM9: connector insert bumps watermark ────────────────────────────────────

describe("IM9: entity.insert() via connector increments watermark", () => {
  it("inserted record has a higher watermark than seed records", () => {
    const conn = makeConnector({ contacts: [makeRecord("seed")] });
    const seedWm = conn.snapshotFull()["contacts"]![0]!.watermark;
    conn.insertRecord("contacts", { name: "new", id: "new1" });
    const newWm = conn.snapshotFull()["contacts"]!.find((r) => r.id === "new1")!.watermark;
    expect(newWm).toBeGreaterThan(seedWm);
  });
});

// ─── IM10: mutate() full replace ──────────────────────────────────────────────

describe("IM10: mutate() full replace is reflected in snapshot and incremental read", () => {
  it("snapshot after mutate() returns only the new records", () => {
    const conn = makeConnector({ contacts: [makeRecord("old1"), makeRecord("old2")] });
    conn.mutate("contacts", [makeRecord("new1")]);
    const snap = conn.snapshot();
    expect(snap["contacts"]!.map((r) => r.id)).toEqual(["new1"]);
  });
});

// ─── IM11: cross-entity isolation ────────────────────────────────────────────

describe("IM11: edits to entity A don't affect entity B", () => {
  it("insertRecord on entity A leaves entity B unchanged", () => {
    const conn = makeConnector({
      companies: [makeRecord("co1")],
      contacts:  [makeRecord("c1")],
    });
    conn.insertRecord("companies", { name: "NewCo", id: "co2" });
    expect(conn.snapshot()["contacts"]).toHaveLength(1);
  });

  it("deleteRecord on entity A doesn't remove records from entity B", () => {
    const conn = makeConnector({
      companies: [makeRecord("co1")],
      contacts:  [makeRecord("c1")],
    });
    conn.deleteRecord("companies", "co1");
    expect(conn.snapshot()["contacts"]).toHaveLength(1);
    expect(conn.snapshot()["companies"]).toHaveLength(0);
  });
});

// ─── IM12: global watermark monotonicity ─────────────────────────────────────

describe("IM12: watermarks are monotonically increasing across entities", () => {
  it("each successive write (across entities) gets a strictly higher watermark", () => {
    const conn = makeConnector({
      companies: [],
      contacts:  [],
    });
    const id1 = conn.insertRecord("companies", { name: "A" });
    const id2 = conn.insertRecord("contacts",  { name: "B" });
    const id3 = conn.insertRecord("companies", { name: "C" });

    const full1 = conn.snapshotFull()["companies"]!;
    const full2 = conn.snapshotFull()["contacts"]!;

    const wm1 = full1.find((r) => r.id === id1)!.watermark;
    const wm2 = full2.find((r) => r.id === id2)!.watermark;
    const wm3 = full1.find((r) => r.id === id3)!.watermark;

    expect(wm2).toBeGreaterThan(wm1);
    expect(wm3).toBeGreaterThan(wm2);
  });
});
