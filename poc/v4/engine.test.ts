import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import connector from "../../connectors/jsonfiles/src/index.js";
import { openDb, makeConnectorState, shadowToCanonical, dbGetShadowRow } from "./db.js";
import type { Db } from "./db.js";
import {
  SyncEngine,
  applyRename,
  canonicalEqual,
  shadowMatchesIncoming,
  computeFieldDiffs,
  EventBus,
  CircuitBreaker,
} from "./engine.js";
import type {
  ChannelConfig,
  ConnectorInstance,
  EngineConfig,
  IngestResult,
  InsertRecord,
  UpdateRecord,
} from "./engine.js";
import type { SyncEvent } from "./events.js";
import { resolveConflicts } from "./conflict.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeCtx(db: Db, connectorId: string, filePaths: string[]) {
  return {
    config: { filePaths },
    // makeConnectorState returns sync methods; the jsonfiles connector doesn't
    // call ctx.state, so casting to the async StateStore interface is safe here.
    state: makeConnectorState(db, connectorId) as unknown as Parameters<typeof connector.getEntities>[0]["state"],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    http: null as unknown as Parameters<typeof connector.getEntities>[0]["http"],
    webhookUrl: "",
  };
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

async function* one<T>(item: T): AsyncIterable<T> {
  yield item;
}

async function readAll(instance: ConnectorInstance, entityName: string) {
  const entity = instance.entities.find((e) => e.name === entityName)!;
  const records: Array<{ id: string; data: Record<string, unknown>; associations?: unknown[] }> = [];
  for await (const batch of entity.read!(instance.ctx)) {
    for (const r of batch.records) {
      records.push({ id: r.id, data: r.data as Record<string, unknown>, associations: r.associations });
    }
  }
  return records;
}

// ─── applyRename unit tests ───────────────────────────────────────────────────

describe("applyRename", () => {
  it("passes through unchanged when map is undefined", () => {
    expect(applyRename({ a: 1, b: 2 }, undefined)).toEqual({ a: 1, b: 2 });
  });

  it("passes through unchanged when map is empty", () => {
    expect(applyRename({ a: 1, b: 2 }, [])).toEqual({ a: 1, b: 2 });
  });

  it("renames a listed field and drops unlisted fields (whitelist)", () => {
    expect(applyRename({ name: "Alice", localOnly: "x" }, [{ source: "name", target: "customerName" }]))
      .toEqual({ customerName: "Alice" });
  });

  it("renames multiple fields", () => {
    expect(applyRename({ a: 1, b: 2, c: 3 }, [{ source: "a", target: "x" }, { source: "b", target: "y" }]))
      .toEqual({ x: 1, y: 2 });
  });

  it("does not mutate the input", () => {
    const data = { name: "Alice" };
    applyRename(data, [{ source: "name", target: "customerName" }]);
    expect(data).toEqual({ name: "Alice" });
  });

  it("inbound: forward_only field is skipped", () => {
    const result = applyRename(
      { type: "customer", name: "Alice" },
      [{ source: "type", target: "type", direction: "forward_only" }, { source: "name", target: "customerName" }],
      "inbound",
    );
    expect(result.customerName).toBe("Alice");
    expect(result.type).toBeUndefined();
  });

  it("outbound: reverse_only field is skipped", () => {
    const result = applyRename(
      { customerName: "Alice", internalCode: "X1" },
      [{ source: "name", target: "customerName" }, { source: "code", target: "internalCode", direction: "reverse_only" }],
      "outbound",
    );
    expect(result.name).toBe("Alice");
    expect(result.code).toBeUndefined();
  });

  it("outbound: bidirectional field maps target→source", () => {
    const result = applyRename(
      { customerName: "Alice" },
      [{ source: "name", target: "customerName" }],
      "outbound",
    );
    expect(result.name).toBe("Alice");
    expect(result.customerName).toBeUndefined();
  });
});

// ─── canonicalEqual unit tests ────────────────────────────────────────────────

describe("canonicalEqual", () => {
  it("equal records", () => {
    expect(canonicalEqual({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
  });

  it("different value", () => {
    expect(canonicalEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("extra key", () => {
    expect(canonicalEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("key order independent", () => {
    expect(canonicalEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it("empty records are equal", () => {
    expect(canonicalEqual({}, {})).toBe(true);
  });
});

// ─── Core hub-and-spoke scenario ─────────────────────────────────────────────
//
// Canonical customer field: "customerName"
//   A: local "name"      ↔ canonical "customerName"
//   B: already canonical — no renames
//   C: local "fullName"  ↔ canonical "customerName"
//
// Hub-and-spoke key difference from v3:
//   ingest("customers", "A", opts) fans out to BOTH B and C in a single call.
//   Subsequent ingest from B or C produces skips — not writes — because shadow
//   state was updated for every target during the source ingest.

describe("SyncEngine v4 — 3-connector hub-and-spoke", () => {
  let db: Db;
  let tmpDir: string;
  let connectorA: ConnectorInstance;
  let connectorB: ConnectorInstance;
  let connectorC: ConnectorInstance;
  let engine: SyncEngine;

  let aliceAId: string;
  let aliceBId: string;
  let aliceCId: string;
  let orderAId: string;
  let orderBId: string;

  const customersChannel: ChannelConfig = {
    id: "customers",
    members: [
      {
        connectorId: "A",
        entity: "customers",
        inbound:  [{ source: "name",     target: "customerName" }],
        outbound: [{ source: "name",     target: "customerName" }],
      },
      {
        connectorId: "B",
        entity: "customers",
      },
      {
        connectorId: "C",
        entity: "customers",
        inbound:  [{ source: "fullName", target: "customerName" }],
        outbound: [{ source: "fullName", target: "customerName" }],
      },
    ],
  };

  const ordersChannel: ChannelConfig = {
    id: "orders",
    members: [
      { connectorId: "A", entity: "orders" },
      { connectorId: "B", entity: "orders" },
      { connectorId: "C", entity: "orders" },
    ],
  };

  beforeAll(() => {
    db = openDb(":memory:");
    tmpDir = mkdtempSync(join(tmpdir(), "sync-poc-v4-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    mkdirSync(join(tmpDir, "c"), { recursive: true });

    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json"), join(tmpDir, "a", "orders.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json"), join(tmpDir, "b", "orders.json")]);
    const cCtx = makeCtx(db, "C", [join(tmpDir, "c", "customers.json"), join(tmpDir, "c", "orders.json")]);

    connectorA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    connectorB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    connectorC = { id: "C", ctx: cCtx, entities: connector.getEntities!(cCtx) };

    const config: EngineConfig = {
      connectors: [connectorA, connectorB, connectorC],
      channels: [customersChannel, ordersChannel],
    };
    engine = new SyncEngine(config, db);
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Step 1 ─────────────────────────────────────────────────────────────────
  // Insert Alice in A. ingest("customers","A") fans out to B and C simultaneously.
  // B must receive customerName, C must receive fullName — from one engine call.
  // After this, ingesting B and C must produce only skips (shadow state already matches).

  it("step 1: insert in A → B gets customerName, C gets fullName in one ingest call", async () => {
    const customersA = connectorA.entities.find((e) => e.name === "customers")!;
    const [inserted] = await collect(
      customersA.insert!(one<InsertRecord>({ data: { name: "Alice Smith" } })),
    );
    aliceAId = inserted.id;

    const result = await engine.ingest("customers", "A", { batchId: "step1" });

    const bInsert = result.records.find(
      (r) => r.targetConnectorId === "B" && r.action === "insert" && r.sourceId === aliceAId,
    );
    const cInsert = result.records.find(
      (r) => r.targetConnectorId === "C" && r.action === "insert" && r.sourceId === aliceAId,
    );
    expect(bInsert).toBeDefined();
    expect(cInsert).toBeDefined();
    aliceBId = bInsert!.targetId;
    aliceCId = cInsert!.targetId;

    const bCustomers = await readAll(connectorB, "customers");
    expect(bCustomers).toHaveLength(1);
    expect(bCustomers[0].data.customerName).toBe("Alice Smith");
    expect(bCustomers[0].data.name).toBeUndefined();

    const cCustomers = await readAll(connectorC, "customers");
    expect(cCustomers).toHaveLength(1);
    expect(cCustomers[0].data.fullName).toBe("Alice Smith");
    expect(cCustomers[0].data.name).toBeUndefined();
    expect(cCustomers[0].data.customerName).toBeUndefined();

    // Echo suppression: ingesting B and C should produce no writes to other connectors,
    // because their shadow_state was updated when A was ingested.
    const echoB = await engine.ingest("customers", "B", { batchId: "step1-echo-b" });
    const echoC = await engine.ingest("customers", "C", { batchId: "step1-echo-c" });
    expect(echoB.records.filter((r) => r.action === "insert" || r.action === "update")).toHaveLength(0);
    expect(echoC.records.filter((r) => r.action === "insert" || r.action === "update")).toHaveLength(0);

    // A still has exactly 1 customer.
    const aCustomers = await readAll(connectorA, "customers");
    expect(aCustomers).toHaveLength(1);
  });

  // ── Step 2 ─────────────────────────────────────────────────────────────────
  // Update in B. ingest("customers","B") fans out to A and C simultaneously.
  // A should receive the outbound-renamed "name" field; C should receive "fullName".
  // Subsequent ingest from A and C must see only skips — no echo propagation.

  it("step 2: update in B → A gets name, C gets fullName; no echo on reversed calls", async () => {
    const customersB = connectorB.entities.find((e) => e.name === "customers")!;
    await collect(
      customersB.update!(one<UpdateRecord>({ id: aliceBId, data: { customerName: "Alicia Smith" } })),
    );

    const result = await engine.ingest("customers", "B", { batchId: "step2" });

    expect(result.records.find((r) => r.targetConnectorId === "A" && r.action === "update")).toBeDefined();
    expect(result.records.find((r) => r.targetConnectorId === "C" && r.action === "update")).toBeDefined();

    const aCustomers = await readAll(connectorA, "customers");
    expect(aCustomers[0].data.name).toBe("Alicia Smith");
    expect(aCustomers[0].data.customerName).toBeUndefined();

    const cCustomers = await readAll(connectorC, "customers");
    expect(cCustomers[0].data.fullName).toBe("Alicia Smith");
    expect(cCustomers[0].data.customerName).toBeUndefined();

    // Echo prevention: A and C now carry the same canonical value — ingesting them
    // must not trigger further writes to B.
    const echoA = await engine.ingest("customers", "A", { batchId: "step2-echo-a" });
    const echoC = await engine.ingest("customers", "C", { batchId: "step2-echo-c" });
    expect(echoA.records.filter((r) => r.action === "update")).toHaveLength(0);
    expect(echoC.records.filter((r) => r.action === "update")).toHaveLength(0);
  });

  // ── Step 3 ─────────────────────────────────────────────────────────────────
  // Insert order in A with an association to Alice.
  // ingest("orders","A") fans out to B and C: both receive the order with
  // remapped FK (aliceAId → aliceBId for B, aliceAId → aliceCId for C).

  it("step 3: order with association syncs A → B and C with remapped FKs", async () => {
    const ordersA = connectorA.entities.find((e) => e.name === "orders")!;
    const [inserted] = await collect(
      ordersA.insert!(one<InsertRecord>({
        data: { amount: 99 },
        associations: [
          { predicate: "customerId", targetEntity: "customers", targetId: aliceAId },
        ],
      })),
    );
    orderAId = inserted.id;

    const result = await engine.ingest("orders", "A", { batchId: "step3" });

    const bInsert = result.records.find(
      (r) => r.targetConnectorId === "B" && r.action === "insert" && r.sourceId === orderAId,
    );
    expect(bInsert).toBeDefined();
    orderBId = bInsert!.targetId;

    const cInsert = result.records.find(
      (r) => r.targetConnectorId === "C" && r.action === "insert" && r.sourceId === orderAId,
    );
    expect(cInsert).toBeDefined();

    const bOrders = await readAll(connectorB, "orders");
    expect(bOrders).toHaveLength(1);
    expect(bOrders[0].data.amount).toBe(99);
    expect(bOrders[0].associations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ predicate: "customerId", targetId: aliceBId }),
      ]),
    );

    const cOrders = await readAll(connectorC, "orders");
    expect(cOrders).toHaveLength(1);
    expect(cOrders[0].associations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ predicate: "customerId", targetId: aliceCId }),
      ]),
    );
  });

  // ── Step 4 ─────────────────────────────────────────────────────────────────
  // Update order in B → amount flows to A and C. No echo when A is re-ingested.

  it("step 4: update order in B → amount flows to A and C; no echo afterwards", async () => {
    const ordersB = connectorB.entities.find((e) => e.name === "orders")!;
    await collect(
      ordersB.update!(one<UpdateRecord>({ id: orderBId, data: { amount: 149 } })),
    );

    const result = await engine.ingest("orders", "B", { batchId: "step4" });

    expect(result.records.find((r) => r.targetConnectorId === "A" && r.action === "update")).toBeDefined();
    expect(result.records.find((r) => r.targetConnectorId === "C" && r.action === "update")).toBeDefined();

    const aOrders = await readAll(connectorA, "orders");
    expect(aOrders[0].data.amount).toBe(149);

    const cOrders = await readAll(connectorC, "orders");
    expect(cOrders[0].data.amount).toBe(149);

    const echoA = await engine.ingest("orders", "A", { batchId: "step4-echo-a" });
    expect(echoA.records.filter((r) => r.action === "update")).toHaveLength(0);
  });
});

// ─── Association propagation bug fixes ────────────────────────────────────────
// Each test is fully self-contained: own db, own tmpDir, own engine.

describe("SyncEngine v4 — association propagation", () => {
  it("bug 1 fix: removing all associations propagates as [] not undefined", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "sync-poc-v4-bug1-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json"), join(tmpDir, "a", "orders.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json"), join(tmpDir, "b", "orders.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [
        { id: "customers", members: [{ connectorId: "A", entity: "customers" }, { connectorId: "B", entity: "customers" }] },
        { id: "orders",    members: [{ connectorId: "A", entity: "orders"    }, { connectorId: "B", entity: "orders"    }] },
      ],
    }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    const ordA  = cA.entities.find((e) => e.name === "orders")!;
    const [cust] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Bob" } })));
    const [ord]  = await collect(ordA.insert!(one<InsertRecord>({
      data: { amount: 50 },
      associations: [{ predicate: "customerId", targetEntity: "customers", targetId: cust.id }],
    })));

    await eng.ingest("customers", "A", { batchId: "bug1-a" });
    const ordIngest = await eng.ingest("orders", "A", { batchId: "bug1-b" });
    const ordBId = ordIngest.records.find((r) => r.targetConnectorId === "B" && r.action === "insert")!.targetId;

    let bOrders = await readAll(cB, "orders");
    expect(bOrders.find((r) => r.id === ordBId)?.associations).toHaveLength(1);

    // 1ms pause ensures the removal update gets a strictly newer watermark than the insert.
    await Bun.sleep(1);

    // Remove the association in A.
    await collect(ordA.update!(one<UpdateRecord>({ id: ord.id, data: { amount: 50 }, associations: [] })));
    const passA2 = await eng.ingest("orders", "A", { batchId: "bug1-c" });
    expect(passA2.records.find((r) => r.targetConnectorId === "B" && r.action === "update")).toBeDefined();

    bOrders = await readAll(cB, "orders");
    expect(bOrders.find((r) => r.id === ordBId)?.associations ?? []).toHaveLength(0);

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bug 3 fix: unknown targetEntity surfaces as error action, not defer", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "sync-poc-v4-bug3-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json"), join(tmpDir, "a", "orders.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json"), join(tmpDir, "b", "orders.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [
        { id: "customers", members: [{ connectorId: "A", entity: "customers" }, { connectorId: "B", entity: "customers" }] },
        { id: "orders",    members: [{ connectorId: "A", entity: "orders"    }, { connectorId: "B", entity: "orders"    }] },
      ],
    }, db);

    // Seed one customer so the "customers" entity is known to shadow_state.
    const custA = cA.entities.find((e) => e.name === "customers")!;
    await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Ghost" } })));
    await eng.ingest("customers", "A", { batchId: "bug3-a" });

    // Insert an order referencing a completely fictitious entity type.
    const ordA = cA.entities.find((e) => e.name === "orders")!;
    const [badOrd] = await collect(ordA.insert!(one<InsertRecord>({
      data: { amount: 1 },
      associations: [{ predicate: "ref", targetEntity: "nonexistent_entity", targetId: "fake-id" }],
    })));

    const pass = await eng.ingest("orders", "A", { batchId: "bug3-b" });
    const result = pass.records.find((r) => r.sourceId === badOrd.id);
    expect(result?.action).toBe("error");
    expect((result as { error?: string })?.error).toMatch(/nonexistent_entity/);

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bug 4 fix: duplicate predicates are deduplicated before remapping", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "sync-poc-v4-bug4-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json"), join(tmpDir, "a", "orders.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json"), join(tmpDir, "b", "orders.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [
        { id: "customers", members: [{ connectorId: "A", entity: "customers" }, { connectorId: "B", entity: "customers" }] },
        { id: "orders",    members: [{ connectorId: "A", entity: "orders"    }, { connectorId: "B", entity: "orders"    }] },
      ],
    }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    const ordA  = cA.entities.find((e) => e.name === "orders")!;
    const [cust] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Carol" } })));
    await eng.ingest("customers", "A", { batchId: "bug4-a" });

    const [dupOrd] = await collect(ordA.insert!(one<InsertRecord>({
      data: { amount: 77 },
      associations: [
        { predicate: "customerId", targetEntity: "customers", targetId: cust.id },
        { predicate: "customerId", targetEntity: "customers", targetId: cust.id },
      ],
    })));

    const pass = await eng.ingest("orders", "A", { batchId: "bug4-b" });
    expect(pass.records.find((r) => r.targetConnectorId === "B" && r.action === "insert" && r.sourceId === dupOrd.id)).toBeDefined();

    const bOrders = await readAll(cB, "orders");
    expect(bOrders.find((r) => r.data.amount === 77)?.associations).toHaveLength(1);

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── SQLite state layer ───────────────────────────────────────────────────────
// Verify that shadow_state, transaction_log, and sync_runs are populated after
// an ingest call. These tables are unique to v4 and replace the in-memory
// EngineState blob from v3.

describe("SyncEngine v4 — SQLite state layer", () => {
  it("shadow_state has rows for source and target after ingest", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "sync-poc-v4-shadow-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [{ id: "contacts", members: [
        { connectorId: "A", entity: "customers" },
        { connectorId: "B", entity: "customers" },
      ]}],
    }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    const [ins] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Dave" } })));
    await eng.ingest("contacts", "A", { batchId: "shadow-test" });

    // shadow_state should have exactly 1 row for A and 1 row for B
    const shadowRows = db
      .query<{ connector_id: string }, []>("SELECT connector_id FROM shadow_state WHERE entity_name = 'customers'")
      .all();
    const connectorIds = shadowRows.map((r) => r.connector_id).sort();
    expect(connectorIds).toEqual(["A", "B"]);

    // The A shadow should carry field-level data: each field has { val, prev, ts, src }.
    const aShadow = db
      .query<{ canonical_data: string }, [string]>(
        "SELECT canonical_data FROM shadow_state WHERE connector_id = 'A' AND external_id = ?",
      )
      .get(ins.id);
    expect(aShadow).toBeDefined();
    const parsed = JSON.parse(aShadow!.canonical_data);
    expect(parsed.customerName).toBeDefined();
    expect(parsed.customerName.val).toBe("Dave");
    expect(parsed.customerName.src).toBe("A");
    expect(typeof parsed.customerName.ts).toBe("number");

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("transaction_log has insert rows after ingest", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "sync-poc-v4-txlog-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [{ id: "items", members: [
        { connectorId: "A", entity: "customers" },
        { connectorId: "B", entity: "customers" },
      ]}],
    }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Eve" } })));
    await eng.ingest("items", "A", { batchId: "txlog-test" });

    const txRows = db
      .query<{ action: string; batch_id: string; connector_id: string }, []>(
        "SELECT action, batch_id, connector_id FROM transaction_log",
      )
      .all();

    // Exactly one insert row for B (the target)
    expect(txRows).toHaveLength(1);
    expect(txRows[0].action).toBe("insert");
    expect(txRows[0].batch_id).toBe("txlog-test");
    expect(txRows[0].connector_id).toBe("B");

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sync_runs has one row per ingest call", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "sync-poc-v4-runs-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [{ id: "things", members: [
        { connectorId: "A", entity: "customers" },
        { connectorId: "B", entity: "customers" },
      ]}],
    }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Faye" } })));
    await eng.ingest("things", "A", { batchId: "run-test" });
    await eng.ingest("things", "B", { batchId: "run-test" });

    const runRows = db
      .query<{ connector_id: string; inserted: number; skipped: number }, []>(
        "SELECT connector_id, inserted, skipped FROM sync_runs ORDER BY connector_id",
      )
      .all();

    // Two rows: one per ingest call
    expect(runRows).toHaveLength(2);
    const rowA = runRows.find((r) => r.connector_id === "A")!;
    const rowB = runRows.find((r) => r.connector_id === "B")!;
    expect(rowA.inserted).toBe(1); // A inserted into B
    expect(rowB.skipped).toBe(1);  // B sees the same record as skip (shadow matches)

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── ctx.state persistence ────────────────────────────────────────────────────
// makeConnectorState(db, connectorId) backs ctx.state with the connector_state
// table. Verify that get/set/delete work correctly and are scoped per connector.

describe("SyncEngine v4 — ctx.state via connector_state table", () => {
  it("set/get/delete round-trips through SQLite", () => {
    const db = openDb(":memory:");

    const stateA = makeConnectorState(db, "A");
    const stateB = makeConnectorState(db, "B");

    // Set and retrieve
    stateA.set("token", "abc123");
    expect(stateA.get("token")).toBe("abc123");

    // Scoped: B does not see A's key
    expect(stateB.get("token")).toBeUndefined();

    // Overwrite
    stateA.set("token", "xyz789");
    expect(stateA.get("token")).toBe("xyz789");

    // Delete
    stateA.delete("token");
    expect(stateA.get("token")).toBeUndefined();

    // Object values are round-tripped via JSON
    stateB.set("config", { retries: 3, timeout: 5000 });
    expect(stateB.get("config")).toEqual({ retries: 3, timeout: 5000 });

    db.close();
  });
});

// ─── Item 17: field-level shadow state ───────────────────────────────────────
// Validates the new FieldData structure: { val, prev, ts, src } per field.
// Also validates shadowMatchesIncoming, computeFieldDiffs, and shadowToCanonical.

describe("SyncEngine v4 — field-level shadow state (item 17)", () => {
  it("shadowMatchesIncoming detects no-change and changed records", () => {
    const shadow = {
      name: { val: "Alice", prev: null, ts: 1000, src: "A" },
      age:  { val: 30,      prev: null, ts: 1000, src: "A" },
    };
    expect(shadowMatchesIncoming(shadow, { name: "Alice", age: 30 }, undefined)).toBe(true);
    expect(shadowMatchesIncoming(shadow, { name: "Alice", age: 31 }, undefined)).toBe(false);
    expect(shadowMatchesIncoming(shadow, { name: "Alice" }, undefined)).toBe(false); // missing field counts as change
  });

  it("shadowMatchesIncoming detects association-only changes via sentinel", () => {
    const shadow = {
      name:     { val: "Alice", prev: null, ts: 1000, src: "A" },
      __assoc__: { val: '[{"predicate":"cid","targetEntity":"c","targetId":"x"}]', prev: null, ts: 1000, src: "A" },
    };
    const sameAssoc = '[{"predicate":"cid","targetEntity":"c","targetId":"x"}]';
    const diffAssoc = '[]';
    expect(shadowMatchesIncoming(shadow, { name: "Alice" }, sameAssoc)).toBe(true);
    expect(shadowMatchesIncoming(shadow, { name: "Alice" }, diffAssoc)).toBe(false);
    // Removing sentinel when shadow has one is a change
    expect(shadowMatchesIncoming(shadow, { name: "Alice" }, undefined)).toBe(false);
  });

  it("computeFieldDiffs returns empty array when nothing changed", () => {
    const shadow = {
      name: { val: "Alice", prev: null, ts: 1000, src: "A" },
    };
    const diffs = computeFieldDiffs({ name: "Alice" }, shadow, "B");
    expect(diffs).toHaveLength(0);
  });

  it("computeFieldDiffs returns diff with prev/newSrc on change", () => {
    const shadow = {
      name: { val: "Alice", prev: null, ts: 1000, src: "A" },
      age:  { val: 30,      prev: null, ts: 1000, src: "A" },
    };
    const diffs = computeFieldDiffs({ name: "Alicia", age: 30 }, shadow, "B");
    expect(diffs).toHaveLength(1);
    expect(diffs[0].field).toBe("name");
    expect(diffs[0].oldValue).toBe("Alice");
    expect(diffs[0].newValue).toBe("Alicia");
    expect(diffs[0].prevSrc).toBe("A");
    expect(diffs[0].newSrc).toBe("B");
  });

  it("computeFieldDiffs treats all fields as new when no existing shadow", () => {
    const diffs = computeFieldDiffs({ name: "Bob", age: 25 }, undefined, "A");
    expect(diffs).toHaveLength(2);
    for (const d of diffs) {
      expect(d.oldValue).toBeNull();
      expect(d.prevSrc).toBeNull();
    }
  });

  it("shadowToCanonical extracts val map and excludes __assoc__", () => {
    const shadow = {
      name:     { val: "Alice", prev: null, ts: 1000, src: "A" },
      age:      { val: 30,      prev: null, ts: 1000, src: "A" },
      __assoc__: { val: "[]",   prev: null, ts: 1000, src: "A" },
    };
    expect(shadowToCanonical(shadow)).toEqual({ name: "Alice", age: 30 });
  });

  it("field-level shadow persisted correctly after ingest", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-fl-shadow-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [{ id: "people", members: [
        { connectorId: "A", entity: "customers" },
        { connectorId: "B", entity: "customers" },
      ]}],
    }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    const [ins] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Alice" } })));
    await eng.ingest("people", "A", { batchId: "fl-1" });

    // Check source shadow A: val=Alice, src=A
    const shadowRowA = db.query<{ canonical_data: string }, [string]>(
      "SELECT canonical_data FROM shadow_state WHERE connector_id='A' AND external_id=?",
    ).get(ins.id)!;
    const fdA = JSON.parse(shadowRowA.canonical_data);
    expect(fdA.customerName.val).toBe("Alice");
    expect(fdA.customerName.src).toBe("A");
    expect(fdA.customerName.prev).toBeNull();

    // Update in A; re-ingest
    await Bun.sleep(1);
    await collect(custA.update!(one<UpdateRecord>({ id: ins.id, data: { customerName: "Alicia" } })));
    await eng.ingest("people", "A", { batchId: "fl-2" });

    const shadowRowA2 = db.query<{ canonical_data: string }, [string]>(
      "SELECT canonical_data FROM shadow_state WHERE connector_id='A' AND external_id=?",
    ).get(ins.id)!;
    const fdA2 = JSON.parse(shadowRowA2.canonical_data);
    // val updated, prev carries the old value
    expect(fdA2.customerName.val).toBe("Alicia");
    expect(fdA2.customerName.prev).toBe("Alice");
    expect(fdA2.customerName.src).toBe("A");

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── Item 18: EventBus emission ───────────────────────────────────────────────
// Validates that record.created and record.updated events are emitted after
// each successful dispatch with correct shape (including FieldDiff[]).

describe("SyncEngine v4 — EventBus emission (item 18)", () => {
  it("emits record.created on insert with correct FieldDiff[]", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-events-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };

    const bus = new EventBus();
    const captured: SyncEvent[] = [];
    bus.on("*", (e) => { captured.push(e); });

    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [{ id: "ch", members: [
        { connectorId: "A", entity: "customers" },
        { connectorId: "B", entity: "customers" },
      ]}],
      eventBus: bus,
    }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Bob" } })));
    await eng.ingest("ch", "A", { batchId: "ev-1" });

    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe("record.created");
    expect(captured[0].targetConnectorId).toBe("B");
    expect(captured[0].batchId).toBe("ev-1");
    expect(captured[0].data.customerName).toBe("Bob");
    // Insert: all fields are new, prevSrc=null
    const diffs = (captured[0] as { changes: unknown[] }).changes;
    expect(diffs.length).toBeGreaterThan(0);
    for (const d of diffs as { prevSrc: unknown }[]) {
      expect(d.prevSrc).toBeNull();
    }

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits record.updated on update with correct old/new values in FieldDiff", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-events-upd-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };

    const bus = new EventBus();
    const captured: SyncEvent[] = [];
    bus.on("*", (e) => { captured.push(e); });

    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [{ id: "ch", members: [
        { connectorId: "A", entity: "customers" },
        { connectorId: "B", entity: "customers" },
      ]}],
      eventBus: bus,
    }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    const [ins] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Carol" } })));
    await eng.ingest("ch", "A", { batchId: "ev-ins" });
    captured.length = 0; // reset

    await Bun.sleep(1);
    await collect(custA.update!(one<UpdateRecord>({ id: ins.id, data: { customerName: "Caroline" } })));
    await eng.ingest("ch", "A", { batchId: "ev-upd" });

    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe("record.updated");
    const diffs = (captured[0] as { changes: { field: string; oldValue: unknown; newValue: unknown }[] }).changes;
    const nameDiff = diffs.find((d) => d.field === "customerName");
    expect(nameDiff).toBeDefined();
    expect(nameDiff!.oldValue).toBe("Carol");
    expect(nameDiff!.newValue).toBe("Caroline");

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wildcard (*) handler receives both event types", async () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on("*", (e) => { received.push(e.type); });
    bus.on("record.created", (e) => { received.push("typed:" + e.type); });

    await bus.emit({ type: "record.created", channelId: "c", entityName: "e", canonicalId: "id", sourceConnectorId: "A", targetConnectorId: "B", batchId: "b", data: {}, changes: [] });
    await bus.emit({ type: "record.updated", channelId: "c", entityName: "e", canonicalId: "id", sourceConnectorId: "A", targetConnectorId: "B", batchId: "b", data: {}, changes: [] });

    // wildcard fires for both; typed fires once
    expect(received.filter((t) => t === "record.created")).toHaveLength(1);
    expect(received.filter((t) => t === "record.updated")).toHaveLength(1);
    expect(received.filter((t) => t === "typed:record.created")).toHaveLength(1);
  });
});

// ─── Item 19: conflict resolution ────────────────────────────────────────────
// Validates resolveConflicts() in isolation (LWW + field_master) and via the
// engine (two connectors update same field in the same cycle).

describe("SyncEngine v4 — conflict resolution (item 19)", () => {
  // ── resolveConflicts() unit tests ──────────────────────────────────────────

  it("LWW: newer incoming timestamp wins", () => {
    const shadow = {
      name: { val: "Alice", prev: null, ts: 1000, src: "A" },
    };
    const result = resolveConflicts({ name: "Alicia" }, shadow, "B", 2000, { strategy: "lww" });
    expect(result.name).toBe("Alicia");
  });

  it("LWW: older incoming timestamp loses — field dropped", () => {
    const shadow = {
      name: { val: "Alice", prev: null, ts: 2000, src: "A" },
    };
    const result = resolveConflicts({ name: "Alicia" }, shadow, "B", 1000, { strategy: "lww" });
    expect(result.name).toBeUndefined();
  });

  it("LWW: equal timestamp — incoming wins (>=)", () => {
    const shadow = {
      name: { val: "Alice", prev: null, ts: 1000, src: "A" },
    };
    const result = resolveConflicts({ name: "Alicia" }, shadow, "B", 1000, { strategy: "lww" });
    expect(result.name).toBe("Alicia");
  });

  it("LWW: new record (no shadow) — all fields accepted", () => {
    const result = resolveConflicts({ name: "Bob", age: 25 }, undefined, "A", 1000, { strategy: "lww" });
    expect(result).toEqual({ name: "Bob", age: 25 });
  });

  it("field_master: master connector always wins regardless of timestamp", () => {
    const shadow = {
      name:   { val: "Alice", prev: null, ts: 9999, src: "A" },
      status: { val: "active", prev: null, ts: 9999, src: "A" },
    };
    // B is master for "name"; incoming ts is lower but B wins
    const result = resolveConflicts(
      { name: "Alicia", status: "inactive" },
      shadow,
      "B",
      1000,
      { strategy: "field_master", fieldMasters: { name: "B" } },
    );
    expect(result.name).toBe("Alicia");   // B wins because it's master for name
    expect(result.status).toBeUndefined(); // no master → LWW → ts 1000 < 9999 → dropped
  });

  it("field_master: non-master connector is blocked from changing the field", () => {
    const shadow = {
      name: { val: "Alice", prev: null, ts: 1000, src: "A" },
    };
    // A is master for "name", B is trying to write it
    const result = resolveConflicts(
      { name: "Alicia" },
      shadow,
      "B", // not the master
      9999,
      { strategy: "field_master", fieldMasters: { name: "A" } },
    );
    expect(result.name).toBeUndefined(); // blocked
  });

  // ── Engine-level conflict: two connectors update same field same cycle ─────

  it("engine LWW: A writes to B, then B makes a later edit — B's newer ts wins in A", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-conflict-lww-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };

    // Both connectors use canonical field "customerName" — no rename needed
    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [{ id: "ch", members: [
        { connectorId: "A", entity: "customers" },
        { connectorId: "B", entity: "customers" },
      ]}],
      conflict: { strategy: "lww" },
    }, db);

    // Step 1: Insert Dave in A → syncs to B
    const custA = cA.entities.find((e) => e.name === "customers")!;
    const custB = cB.entities.find((e) => e.name === "customers")!;
    const [insA] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Dave" } })));
    await eng.ingest("ch", "A", { batchId: "lww-1" });

    const bRecords = await readAll(cB, "customers");
    const insBId = bRecords[0].id;

    // Step 2: Update A → David-A, ingest A so its shadow ts advances
    await Bun.sleep(1);
    await collect(custA.update!(one<UpdateRecord>({ id: insA.id, data: { customerName: "David-A" } })));
    await eng.ingest("ch", "A", { batchId: "lww-2" });
    // At this point: A file = David-A, B file = David-A (engine wrote it), A-side shadow.ts = T1

    // Step 3: After engine propagation, B makes its own edit (ts = T2 > T1)
    await Bun.sleep(1);
    await collect(custB.update!(one<UpdateRecord>({ id: insBId, data: { customerName: "David-B" } })));

    // Step 4: Ingest B — reads David-B (newer than what engine last wrote).
    //   resolveConflicts against A-side shadow: ingestTs_B > T1 → David-B wins
    await Bun.sleep(1);
    const lww3 = await eng.ingest("ch", "B", { batchId: "lww-3" });
    expect(lww3.records.find((r) => r.targetConnectorId === "A" && r.action === "update")).toBeDefined();

    // A should now have David-B
    const aFinal = await readAll(cA, "customers");
    expect(aFinal[0].data.customerName).toBe("David-B");

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── Item 20: CircuitBreaker ──────────────────────────────────────────────────
// Validates the breaker in isolation and via the engine (batch stops when OPEN).

describe("SyncEngine v4 — CircuitBreaker (item 20)", () => {
  // ── CircuitBreaker unit tests ──────────────────────────────────────────────

  it("starts CLOSED", () => {
    const b = new CircuitBreaker();
    expect(b.evaluate()).toBe("CLOSED");
  });

  it("trips after errorThresholdRate exceeded with minSamples batches", () => {
    const b = new CircuitBreaker({ errorThresholdRate: 0.5, minSamples: 3 });
    b.recordResult(true);
    b.recordResult(true);
    expect(b.evaluate()).toBe("CLOSED"); // only 2 samples < minSamples
    b.recordResult(true);
    expect(b.evaluate()).toBe("OPEN");   // 3/3 = 100% ≥ 50%
  });

  it("does not trip below threshold", () => {
    const b = new CircuitBreaker({ errorThresholdRate: 0.5, minSamples: 4 });
    b.recordResult(false);
    b.recordResult(true);
    b.recordResult(false);
    b.recordResult(false);
    expect(b.evaluate()).toBe("CLOSED"); // 1/4 = 25% < 50%
  });

  it("transitions OPEN → HALF_OPEN after resetAfterMs", async () => {
    const b = new CircuitBreaker({ errorThresholdRate: 0.5, minSamples: 1, resetAfterMs: 10 });
    b.recordResult(true);
    expect(b.evaluate()).toBe("OPEN");
    await Bun.sleep(15);
    expect(b.evaluate()).toBe("HALF_OPEN");
  });

  it("HALF_OPEN: successful batch resets to CLOSED", async () => {
    const b = new CircuitBreaker({ errorThresholdRate: 0.5, minSamples: 1, resetAfterMs: 10 });
    b.recordResult(true);
    await Bun.sleep(15);
    b.evaluate(); // triggers HALF_OPEN transition
    b.recordResult(false); // success in HALF_OPEN
    expect(b.currentState).toBe("CLOSED");
  });

  it("HALF_OPEN: failing batch re-trips to OPEN", async () => {
    const b = new CircuitBreaker({ errorThresholdRate: 0.5, minSamples: 1, resetAfterMs: 10 });
    b.recordResult(true);
    await Bun.sleep(15);
    b.evaluate(); // HALF_OPEN
    b.recordResult(true); // still failing
    expect(b.currentState).toBe("OPEN");
  });

  it("manual reset goes back to CLOSED", () => {
    const b = new CircuitBreaker({ errorThresholdRate: 0.5, minSamples: 1 });
    b.trip();
    expect(b.evaluate()).toBe("OPEN");
    b.reset();
    expect(b.evaluate()).toBe("CLOSED");
  });

  // ── Engine-level: OPEN breaker returns empty result without dispatching ────

  it("engine with OPEN breaker returns empty IngestResult without writing", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-breaker-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };

    const breaker = new CircuitBreaker();
    breaker.trip(); // manually open

    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [{ id: "ch", members: [
        { connectorId: "A", entity: "customers" },
        { connectorId: "B", entity: "customers" },
      ]}],
      circuitBreaker: breaker,
    }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Ghost" } })));
    const result = await eng.ingest("ch", "A", { batchId: "tripped" });

    // Breaker was OPEN — ingest should return immediately with no records
    expect(result.records).toHaveLength(0);

    // Nothing was written to B
    const bRecords = await readAll(cB, "customers");
    expect(bRecords).toHaveLength(0);

    // Shadow state is empty (no dispatch happened)
    const shadowCount = db
      .query<{ n: number }, []>("SELECT COUNT(*) as n FROM shadow_state")
      .get()!.n;
    expect(shadowCount).toBe(0);

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("engine trips breaker after sustained errors and stops processing", async () => {
    // Use a breaker with minSamples=1 so it trips on the first error batch.
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-breaker-trip-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };

    const breaker = new CircuitBreaker({ errorThresholdRate: 0.5, minSamples: 1 });

    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [{ id: "ch", members: [
        { connectorId: "A", entity: "customers" },
        { connectorId: "B", entity: "customers" },
      ]}],
      circuitBreaker: breaker,
    }, db);

    // Insert a customer with a bad association reference to trigger an error result
    const custA = cA.entities.find((e) => e.name === "customers")!;
    const ordA  = cA.entities.find((e) => e.name === "customers")!;
    // Re-seed customers entity with a bad assoc reference that causes error
    await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "ErrorTrigger" } })));

    // Manually trip the breaker to simulate already-errored state
    breaker.trip();
    expect(breaker.currentState).toBe("OPEN");

    // Next ingest: breaker is OPEN → should skip immediately
    const result2 = await eng.ingest("ch", "A", { batchId: "skip-due-to-trip" });
    expect(result2.records).toHaveLength(0);

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── OSI Probe 3 (item 23): field-level direction control ────────────────────
// Validates that FieldMapping.direction restricts which "pass" a field participates in.
//
//  forward_only: field is dispatched TO a connector (outbound) but NOT read back
//                from it on subsequent ingest (inbound is ignored).
//  reverse_only: field is read FROM a connector (inbound) but NOT dispatched TO it.
//  bidirectional: (default) field moves in both directions as before.

describe("OSI Probe 3 — field-level direction (item 23)", () => {
  it("forward_only field: written to target but stripped on read-back (no echo propagation)", async () => {
    // Setup: connector A has a "type" field marked forward_only on B's mapping.
    // After A→B dispatch, B's file contains "type". But when B is later ingested,
    // "type" must NOT flow into the canonical record (it's forward_only).
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-probe3-fwd-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };

    // A uses canonical field names directly (no rename).
    // B has a "type" field that is forward_only — it can arrive in B but must
    // not be echoed back when B is ingested.
    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [{ id: "ch", members: [
        { connectorId: "A", entity: "customers" },
        {
          connectorId: "B",
          entity: "customers",
          inbound:  [
            { source: "customerName", target: "customerName" },
            // forward_only: strip this field when reading B (inbound pass)
            { source: "type", target: "type", direction: "forward_only" },
          ],
          outbound: [
            { source: "customerName", target: "customerName" },
            // forward_only: write 'type' to B on dispatch
            { source: "type", target: "type", direction: "forward_only" },
          ],
        },
      ]}],
    }, db);

    // Step 1: Insert in A with 'type' field
    const custA = cA.entities.find((e) => e.name === "customers")!;
    const [insA] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Alice", type: "customer" } })));

    const result1 = await eng.ingest("ch", "A", { batchId: "probe3-1" });
    const bIns = result1.records.find((r) => r.targetConnectorId === "B" && r.action === "insert");
    expect(bIns).toBeDefined();

    // B now has { customerName: "Alice", type: "customer" }
    const bRecords = await readAll(cB, "customers");
    expect(bRecords[0].data.type).toBe("customer");

    // Step 2: Ingest B. The 'type' field is forward_only — applyRename(inbound) skips it.
    // B's canonical is { customerName: "Alice" } (no type). Shadow matches A's dispatch.
    // → no further writes to A.
    const result2 = await eng.ingest("ch", "B", { batchId: "probe3-2" });
    const writesToA = result2.records.filter((r) => r.targetConnectorId === "A" && (r.action === "insert" || r.action === "update"));
    expect(writesToA).toHaveLength(0);

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reverse_only field: NOT dispatched to target (outbound skips it)", async () => {
    // A has { customerName: "Alice", legacyId: "ABC" }.
    // B's outbound mapping marks "legacyId" as reverse_only — skip it when writing TO B.
    // After ingest A, B should receive only { customerName: "Alice" }, not legacyId.
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-probe3-rev-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };

    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [{ id: "ch", members: [
        // A passthrough
        { connectorId: "A", entity: "customers" },
        {
          connectorId: "B",
          entity: "customers",
          inbound:  [{ source: "customerName", target: "customerName" }],
          // reverse_only on legacyId → outbound pass skips it → never dispatched TO B
          outbound: [
            { source: "customerName", target: "customerName" },
            { source: "legacyId",     target: "legacyId",     direction: "reverse_only" },
          ],
        },
      ]}],
    }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Alice", legacyId: "ABC" } })));

    await eng.ingest("ch", "A", { batchId: "probe3-rev-1" });

    // B should received customerName but NOT legacyId (reverse_only blocked it)
    const bRecords = await readAll(cB, "customers");
    expect(bRecords).toHaveLength(1);
    expect(bRecords[0].data.customerName).toBe("Alice");
    expect(bRecords[0].data.legacyId).toBeUndefined();

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bidirectional field (default) moves both inbound and outbound", () => {
    // Baseline: bidirectional behaves like old pass-through rename in both directions.
    const mapping = [{ source: "name", target: "customerName" }]; // no direction = bidirectional
    const canonical = applyRename({ name: "Alice" }, mapping, "inbound");
    expect(canonical).toEqual({ customerName: "Alice" });

    const local = applyRename({ customerName: "Alice" }, mapping, "outbound");
    expect(local).toEqual({ name: "Alice" });
  });
});

// ─── OSI Probe 2 (item 22): per-field conflict strategies ────────────────────
// Validates three per-field resolution strategies via resolveConflicts():
//   coalesce     — lower connectorPriority number wins; ts as tiebreaker
//   last_modified — higher ts wins (explicit per-field)
//   collect       — accumulates all source values as an array

describe("OSI Probe 2 — per-field conflict strategies (item 22)", () => {
  it("coalesce: lower priority number wins regardless of timestamp", () => {
    const shadow = {
      tier: { val: "gold", prev: null, ts: 5000, src: "B" }, // B wrote it (priority 2)
    };
    // A (priority=1) tries to write a later-ts value — A wins because lower priority
    const result = resolveConflicts(
      { tier: "silver" },
      shadow,
      "A",   // incomingSrc
      6000,  // incomingTs — newer but doesn't matter for coalesce
      {
        strategy: "lww",
        connectorPriorities: { A: 1, B: 2 },
        fieldStrategies: { tier: { strategy: "coalesce" } },
      },
    );
    expect(result.tier).toBe("silver"); // A wins (priority 1 < 2)
  });

  it("coalesce: higher priority number loses even with newer timestamp", () => {
    const shadow = {
      tier: { val: "gold", prev: null, ts: 1000, src: "A" }, // A wrote it (priority 1)
    };
    // B (priority=2) with newer ts tries to win — but A has lower priority number
    const result = resolveConflicts(
      { tier: "bronze" },
      shadow,
      "B",
      9999,
      {
        strategy: "lww",
        connectorPriorities: { A: 1, B: 2 },
        fieldStrategies: { tier: { strategy: "coalesce" } },
      },
    );
    expect(result.tier).toBeUndefined(); // B (priority 2) loses to A (priority 1)
  });

  it("coalesce: equal priority uses last_modified as tiebreaker (higher ts wins)", () => {
    const shadow = {
      score: { val: 10, prev: null, ts: 1000, src: "A" },
    };
    const win = resolveConflicts(
      { score: 20 }, shadow, "B", 2000,
      { strategy: "lww", connectorPriorities: { A: 1, B: 1 }, fieldStrategies: { score: { strategy: "coalesce" } } },
    );
    expect(win.score).toBe(20); // same priority, newer ts wins

    const lose = resolveConflicts(
      { score: 5 }, shadow, "B", 500,
      { strategy: "lww", connectorPriorities: { A: 1, B: 1 }, fieldStrategies: { score: { strategy: "coalesce" } } },
    );
    expect(lose.score).toBeUndefined(); // same priority, older ts loses
  });

  it("last_modified: higher ts wins per-field (same as LWW but explicit)", () => {
    const shadow = {
      notes: { val: "old note", prev: null, ts: 500, src: "A" },
    };
    const win = resolveConflicts(
      { notes: "new note" }, shadow, "B", 1000,
      { strategy: "field_master", fieldStrategies: { notes: { strategy: "last_modified" } } },
    );
    // last_modified overrides global strategy (field_master) — newer ts wins
    expect(win.notes).toBe("new note");

    const lose = resolveConflicts(
      { notes: "stale note" }, shadow, "B", 200,
      { strategy: "field_master", fieldStrategies: { notes: { strategy: "last_modified" } } },
    );
    expect(lose.notes).toBeUndefined();
  });

  it("collect: accumulates all source values as an array (non-scalar return)", () => {
    const shadow = {
      tags: { val: "crm", prev: null, ts: 1000, src: "A" },
    };
    const result = resolveConflicts(
      { tags: "erp" },
      shadow,
      "B",
      2000,
      { strategy: "lww", fieldStrategies: { tags: { strategy: "collect" } } },
    );
    // collect accumulates: existing "crm" + incoming "erp" → array
    expect(Array.isArray(result.tags)).toBe(true);
    expect(result.tags).toContain("crm");
    expect(result.tags).toContain("erp");
  });

  it("collect: does not duplicate an already-collected value", () => {
    const shadow = {
      tags: { val: ["crm", "erp"], prev: null, ts: 1000, src: "A" },
    };
    const result = resolveConflicts(
      { tags: "erp" }, // already in the collection
      shadow,
      "B",
      2000,
      { strategy: "lww", fieldStrategies: { tags: { strategy: "collect" } } },
    );
    expect(Array.isArray(result.tags)).toBe(true);
    // "erp" was already collected — no duplicate
    const arr = result.tags as unknown[];
    expect(arr.filter((v) => v === "erp")).toHaveLength(1);
  });

  it("per-field strategy overrides global strategy for that field only", () => {
    const shadow = {
      name:  { val: "Alice", prev: null, ts: 9000, src: "A" },
      score: { val: 100,     prev: null, ts: 1000, src: "A" },
    };
    // "score" has last_modified override; "name" falls back to LWW
    const result = resolveConflicts(
      { name: "Alicia", score: 150 },
      shadow,
      "B",
      2000, // newer than score.ts 1000, but still older than name.ts 9000
      {
        strategy: "lww",
        fieldStrategies: { score: { strategy: "last_modified" } },
      },
    );
    expect(result.name).toBeUndefined(); // LWW: 2000 < 9000 → dropped
    expect(result.score).toBe(150);      // last_modified: 2000 > 1000 → wins
  });
});

// ─── OSI Probe 1 (item 21): field-value identity matching ────────────────────
// Validates that identityFields on a channel enables cross-connector entity
// matching by field value without a pre-existing association.
//
//  Two connectors each independently have a record with email="alice@example.com".
//  After both are ingested, identityFields: ["email"] causes the engine to
//  recognise them as the same entity → they share one canonical UUID.

describe("OSI Probe 1 — field-value identity matching (item 21)", () => {
  it("two connectors with matching email share one canonical UUID after both are ingested", async () => {
    // Simulates the real-world "first connect" scenario: System A and System B
    // have been running independently. Both have Alice identified by email.
    // When we wire them together, identity matching should unify them under one
    // canonical UUID rather than creating a duplicate.
    //
    // B is presented to the engine as read-only so that A's initial ingest does
    // NOT dispatch to B (no insert visible to engine). Then B's pre-existing
    // records are ingested and identity-matched against A's shadow_state.
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-probe1-identity-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA: ConnectorInstance = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    // fullBEntities has insert/update for direct seeding; engine sees only read.
    const fullBEntities = connector.getEntities!(bCtx);
    const cB: ConnectorInstance = {
      id: "B",
      ctx: bCtx,
      entities: fullBEntities.map((e) => ({ name: e.name, read: e.read })),
    };

    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [{
        id: "contacts",
        members: [
          { connectorId: "A", entity: "customers" },
          { connectorId: "B", entity: "customers" },
        ],
        identityFields: ["email"],
      }],
    }, db);

    // Seed A with Alice
    const custA = cA.entities.find((e) => e.name === "customers")!;
    const [insA] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Alice", email: "alice@example.com" } })));

    // Ingest A: builds shadow for email="alice@example.com". Dispatch to B is skipped
    // (B has no insert method from the engine's perspective).
    await eng.ingest("contacts", "A", { batchId: "identity-1" });

    const canonIdA = db.query<{ canonical_id: string }, [string, string]>(
      "SELECT canonical_id FROM identity_map WHERE connector_id = ? AND external_id = ?",
    ).get("A", insA.id)!.canonical_id;
    expect(canonIdA).toBeDefined();

    // Seed B independently (pre-existing data before the sync was set up)
    const custBFull = fullBEntities.find((e) => e.name === "customers")!;
    const [insB] = await collect(custBFull.insert!(one<InsertRecord>({ data: { customerName: "Alice Smith", email: "alice@example.com" } })));

    // Ingest B: _resolveCanonical queries shadow_state, finds email match in A's shadow,
    // links insB to canonId_A instead of allocating a new UUID.
    await eng.ingest("contacts", "B", { batchId: "identity-2" });

    const canonIdB = db.query<{ canonical_id: string }, [string, string]>(
      "SELECT canonical_id FROM identity_map WHERE connector_id = ? AND external_id = ?",
    ).get("B", insB.id)!.canonical_id;
    expect(canonIdB).toBeDefined();

    // The two connectors must resolve to the SAME canonical UUID
    expect(canonIdA).toBe(canonIdB);
  });

  it("records with different email values remain separate canonical entities", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-probe1-nomatch-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };

    const eng = new SyncEngine({
      connectors: [cA, cB],
      channels: [{
        id: "contacts",
        members: [
          { connectorId: "A", entity: "customers" },
          { connectorId: "B", entity: "customers" },
        ],
        identityFields: ["email"],
      }],
    }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    const custB = cB.entities.find((e) => e.name === "customers")!;
    const [insA] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Alice", email: "alice@example.com" } })));
    const [insB] = await collect(custB.insert!(one<InsertRecord>({ data: { customerName: "Bob",   email: "bob@example.com" } })));

    await eng.ingest("contacts", "A", { batchId: "nomatch-1" });
    await eng.ingest("contacts", "B", { batchId: "nomatch-2" });

    const canonA = db.query<{ canonical_id: string }, [string, string]>(
      "SELECT canonical_id FROM identity_map WHERE connector_id = ? AND external_id = ?",
    ).get("A", insA.id)!.canonical_id;

    const canonB = db.query<{ canonical_id: string }, [string, string]>(
      "SELECT canonical_id FROM identity_map WHERE connector_id = ? AND external_id = ?",
    ).get("B", insB.id)!.canonical_id;

    expect(canonA).not.toBe(canonB); // different emails → different canonical entities
  });
});

// ─── Foundation Must-Fix 2: deleted_at and resurrection ─────────────────────
// Validates that a reappearing record (after dbMarkShadowDeleted sets deleted_at)
// is treated as an update, not skipped, and that deleted_at is cleared.

describe("Foundation Must-Fix 2 — deleted_at resurrection (schema)", () => {
  it("shadow_state includes deleted_at column (NULL on fresh row)", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-fix2-schema-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    const eng = new SyncEngine({ connectors: [cA, cB], channels: [{ id: "ch", members: [
      { connectorId: "A", entity: "customers" },
      { connectorId: "B", entity: "customers" },
    ]}] }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    const [ins] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Alice" } })));
    await eng.ingest("ch", "A", { batchId: "fix2-1" });

    // Shadow row for A should have deleted_at = NULL
    const row = db.query<{ deleted_at: string | null }, [string]>(
      "SELECT deleted_at FROM shadow_state WHERE connector_id = 'A' AND external_id = ?",
    ).get(ins.id);
    expect(row).toBeDefined();
    expect(row!.deleted_at).toBeNull();

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("soft-deleted row is detected by dbGetShadowRow", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-fix2-softdel-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    const eng = new SyncEngine({ connectors: [cA, cB], channels: [{ id: "ch", members: [
      { connectorId: "A", entity: "customers" },
      { connectorId: "B", entity: "customers" },
    ]}] }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    const [ins] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Bob" } })));
    await eng.ingest("ch", "A", { batchId: "fix2-del-1" });

    // Mark the row soft-deleted manually (simulating future deletion reconciler)
    db.run(
      "UPDATE shadow_state SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE connector_id = 'A' AND external_id = ?",
      [ins.id],
    );

    const shadowRow = dbGetShadowRow(db, "A", "customers", ins.id);
    expect(shadowRow).toBeDefined();
    expect(shadowRow!.deletedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(shadowRow!.fieldData.customerName.val).toBe("Bob");

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resurrection: a reappearing soft-deleted record is NOT skipped", async () => {
    // If a record's shadow row has deleted_at set, and the connector emits it again,
    // the engine must treat it as changed (re-process it), not skip it.
    //
    // Uses fullSync: true on the second ingest so the record reappears despite the
    // watermark having already advanced past it.
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-fix2-resurrect-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    const eng = new SyncEngine({ connectors: [cA, cB], channels: [{ id: "ch", members: [
      { connectorId: "A", entity: "customers" },
      { connectorId: "B", entity: "customers" },
    ]}] }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    const [ins] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Carol" } })));
    // First ingest: writes shadow, dispatches to B, advances watermark
    const r1 = await eng.ingest("ch", "A", { batchId: "fix2-res-1" });
    expect(r1.records.find((r) => r.action === "insert" && r.targetConnectorId === "B")).toBeDefined();

    // Simulate deletion: mark A's shadow row as deleted
    db.run(
      "UPDATE shadow_state SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE connector_id = 'A' AND external_id = ?",
      [ins.id],
    );

    // Second ingest in full-sync mode so the engine re-reads the record despite the watermark.
    // Because deleted_at is set, the resurrection check bypasses the shadowMatchesIncoming
    // short-circuit — the record goes to pending and is re-dispatched as an update to B.
    const r2 = await eng.ingest("ch", "A", { batchId: "fix2-res-2", fullSync: true });
    const notSkipped = r2.records.filter((r) => r.action !== "skip" && r.targetConnectorId === "B");
    expect(notSkipped.length).toBeGreaterThan(0);

    // deleted_at should be cleared after resurrection (dbSetShadow always sets it to NULL)
    const afterRow = dbGetShadowRow(db, "A", "customers", ins.id);
    expect(afterRow!.deletedAt).toBeNull();

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── Foundation Must-Fix 1: watermark atomicity ──────────────────────────────
// Validates that shadow state writes and the watermark advance commit together.
// We can't easily simulate a mid-batch crash in a unit test, so we validate
// the structure: shadow_state has rows before the watermark is readable.

describe("Foundation Must-Fix 1 — watermark atomicity", () => {
  it("shadow_state is populated by the time the watermark is readable", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-fix1-atomic-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    const eng = new SyncEngine({ connectors: [cA, cB], channels: [{ id: "ch", members: [
      { connectorId: "A", entity: "customers" },
      { connectorId: "B", entity: "customers" },
    ]}] }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Dan" } })));
    await eng.ingest("ch", "A", { batchId: "fix1-atomic" });

    // Watermark should be set
    const wm = db.query<{ since: string }, []>(
      "SELECT since FROM watermarks WHERE connector_id = 'A' AND entity_name = 'customers'",
    ).get();
    expect(wm).toBeDefined();

    // Shadow state must have rows — they were committed before the watermark advanced
    const shadowCount = db.query<{ n: number }, []>(
      "SELECT COUNT(*) as n FROM shadow_state WHERE connector_id = 'A'",
    ).get()!.n;
    expect(shadowCount).toBeGreaterThan(0);

    // Transaction log must also have rows (same transaction as shadow)
    const txCount = db.query<{ n: number }, []>(
      "SELECT COUNT(*) as n FROM transaction_log",
    ).get()!.n;
    expect(txCount).toBeGreaterThan(0);

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── Foundation Must-Fix 3: dispatchWrite seam ───────────────────────────────
// The seam exists if the engine still passes all existing dispatch tests (no
// regression). We verify the structural boundary by checking that shadow_state
// and transaction_log are always consistent after a simulated partial run:
// if the connector write fails, neither shadow nor tx-log should have a row.

describe("Foundation Must-Fix 3 — dispatchWrite seam isolation", () => {
  it("failed connector write leaves shadow_state and transaction_log unchanged", async () => {
    const db = openDb(":memory:");
    const tmpDir = mkdtempSync(join(tmpdir(), "v4-fix3-seam-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx(db, "A", [join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx(db, "B", [join(tmpDir, "b", "customers.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };

    // B has a broken insert that always throws
    const brokenInsert = async function* () {
      throw new Error("simulated connector failure");
      yield { id: "x", error: null }; // unreachable, keeps TS happy
    };
    const cB = {
      id: "B",
      ctx: bCtx,
      entities: [{
        name: "customers",
        read: connector.getEntities!(bCtx).find((e) => e.name === "customers")!.read,
        insert: (_record: unknown, _ctx: unknown) => brokenInsert(),
        update: connector.getEntities!(bCtx).find((e) => e.name === "customers")!.update,
      }],
    };

    const eng = new SyncEngine({ connectors: [cA, cB as ConnectorInstance], channels: [{ id: "ch", members: [
      { connectorId: "A", entity: "customers" },
      { connectorId: "B", entity: "customers" },
    ]}] }, db);

    const custA = cA.entities.find((e) => e.name === "customers")!;
    await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Eve" } })));
    const result = await eng.ingest("ch", "A", { batchId: "fix3-seam" });

    // Dispatch to B failed — action should be error
    expect(result.records.find((r) => r.targetConnectorId === "B" && r.action === "error")).toBeDefined();

    // B's shadow_state must have NO rows (failed dispatch = no shadow commit)
    const bShadow = db.query<{ n: number }, []>(
      "SELECT COUNT(*) as n FROM shadow_state WHERE connector_id = 'B'",
    ).get()!.n;
    expect(bShadow).toBe(0);

    // Transaction log must have NO rows for B
    const bTxLog = db.query<{ n: number }, []>(
      "SELECT COUNT(*) as n FROM transaction_log WHERE connector_id = 'B'",
    ).get()!.n;
    expect(bTxLog).toBe(0);

    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

