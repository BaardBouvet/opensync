import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import connector from "../../connectors/jsonfiles/src/index.js";
import { SyncEngine, applyRename, canonicalEqual } from "./engine.js";
import type {
  ChannelConfig,
  ConnectorInstance,
  EngineConfig,
  InsertRecord,
  UpdateRecord,
} from "./engine.js";
// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeCtx(filePaths: string[]) {
  return {
    config: { filePaths },
    state: {} as Parameters<typeof connector.getEntities>[0]["state"],
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
    expect(applyRename({ a: 1, b: 2 }, {})).toEqual({ a: 1, b: 2 });
  });

  it("renames a listed field and drops unlisted fields (whitelist)", () => {
    // Unlisted fields must NOT pass through when a map is provided.
    expect(applyRename({ name: "Alice", localOnly: "x" }, { name: "customerName" }))
      .toEqual({ customerName: "Alice" });
  });

  it("renames multiple fields", () => {
    expect(applyRename({ a: 1, b: 2, c: 3 }, { a: "x", b: "y" }))
      .toEqual({ x: 1, y: 2 });
  });

  it("does not mutate the input", () => {
    const data = { name: "Alice" };
    applyRename(data, { name: "customerName" });
    expect(data).toEqual({ name: "Alice" });
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

// ─── 3-connector field mapping + echo detection scenario ──────────────────────
//
// Canonical customer field: "customerName"
//   A: local "name"      ↔ canonical "customerName"
//   B: already canonical — no renames
//   C: local "fullName"  ↔ canonical "customerName"
//
// Key v3 difference: reverse passes are NOT needed to drain an echo set.
// Echo detection is content-based: if we read back exactly what we last wrote,
// it's skipped regardless of which cycle or pass order it arrives in.

describe("SyncEngine v3 — 3-connector canonical field mapping", () => {
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
        inbound:  { name: "customerName" },
        outbound: { customerName: "name" },
      },
      {
        connectorId: "B",
        entity: "customers",
      },
      {
        connectorId: "C",
        entity: "customers",
        inbound:  { fullName: "customerName" },
        outbound: { customerName: "fullName" },
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
    tmpDir = mkdtempSync(join(tmpdir(), "sync-poc-v3-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    mkdirSync(join(tmpDir, "c"), { recursive: true });

    const aCtx = makeCtx([join(tmpDir, "a", "customers.json"), join(tmpDir, "a", "orders.json")]);
    const bCtx = makeCtx([join(tmpDir, "b", "customers.json"), join(tmpDir, "b", "orders.json")]);
    const cCtx = makeCtx([join(tmpDir, "c", "customers.json"), join(tmpDir, "c", "orders.json")]);

    connectorA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    connectorB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    connectorC = { id: "C", ctx: cCtx, entities: connector.getEntities!(cCtx) };

    const config: EngineConfig = {
      connectors: [connectorA, connectorB, connectorC],
      channels: [customersChannel, ordersChannel],
    };
    engine = new SyncEngine(config);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Step 1 ─────────────────────────────────────────────────────────────────
  // Insert Alice in A. Sync A→B and A→C.
  // v3 key: no reverse passes needed. B and C echo records are suppressed by
  // content comparison, even on a separate subsequent cycle.

  it("step 1: insert in A → B gets customerName, C gets fullName, no reverse-pass needed", async () => {
    const customersA = connectorA.entities.find((e) => e.name === "customers")!;
    const [inserted] = await collect(
      customersA.insert!(one<InsertRecord>({ data: { name: "Alice Smith" } })),
    );
    aliceAId = inserted.id;

    const passAB = await engine.sync("customers", "A", "B");
    const passAC = await engine.sync("customers", "A", "C");

    const abInsert = passAB.find((r) => r.action === "insert" && r.sourceId === aliceAId);
    const acInsert = passAC.find((r) => r.action === "insert" && r.sourceId === aliceAId);
    expect(abInsert).toBeDefined();
    expect(acInsert).toBeDefined();
    aliceBId = abInsert!.targetId;
    aliceCId = acInsert!.targetId;

    const bCustomers = await readAll(connectorB, "customers");
    expect(bCustomers).toHaveLength(1);
    expect(bCustomers[0].data.customerName).toBe("Alice Smith");
    expect(bCustomers[0].data.name).toBeUndefined();

    const cCustomers = await readAll(connectorC, "customers");
    expect(cCustomers).toHaveLength(1);
    expect(cCustomers[0].data.fullName).toBe("Alice Smith");
    expect(cCustomers[0].data.name).toBeUndefined();
    expect(cCustomers[0].data.customerName).toBeUndefined();

    // Echo suppression: reverse passes see no inserts/updates even without
    // having run before — content-based detection works across cycles.
    const passBA = await engine.sync("customers", "B", "A");
    const passCA = await engine.sync("customers", "C", "A");
    expect(passBA.filter((r) => r.action === "insert" || r.action === "update")).toHaveLength(0);
    expect(passCA.filter((r) => r.action === "insert" || r.action === "update")).toHaveLength(0);

    // A still has exactly 1 customer.
    const aCustomers = await readAll(connectorA, "customers");
    expect(aCustomers).toHaveLength(1);
  });

  // ── Step 2 ─────────────────────────────────────────────────────────────────
  // Edit in B. v3 key: we do NOT run B→A before editing — the echo set approach
  // would have left a stale echo and swallowed this genuine change. Content-based
  // detection handles it correctly even when the first reverse pass runs after the edit.

  it("step 2: update in B → A gets name, C gets fullName, no echo", async () => {
    const customersB = connectorB.entities.find((e) => e.name === "customers")!;
    await collect(
      customersB.update!(one<UpdateRecord>({ id: aliceBId, data: { customerName: "Alicia Smith" } })),
    );

    const passBA = await engine.sync("customers", "B", "A");
    const passBC = await engine.sync("customers", "B", "C");

    expect(passBA.find((r) => r.action === "update")).toBeDefined();
    expect(passBC.find((r) => r.action === "update")).toBeDefined();

    const aCustomers = await readAll(connectorA, "customers");
    expect(aCustomers[0].data.name).toBe("Alicia Smith");
    expect(aCustomers[0].data.customerName).toBeUndefined();

    const cCustomers = await readAll(connectorC, "customers");
    expect(cCustomers[0].data.fullName).toBe("Alicia Smith");
    expect(cCustomers[0].data.customerName).toBeUndefined();

    // Echo prevention: A and C write the same canonical value back — must be skipped.
    const passAB = await engine.sync("customers", "A", "B");
    const passCB = await engine.sync("customers", "C", "B");
    expect(passAB.filter((r) => r.action === "update")).toHaveLength(0);
    expect(passCB.filter((r) => r.action === "update")).toHaveLength(0);
  });

  // ── Step 3 ─────────────────────────────────────────────────────────────────
  // Insert order in A with association → syncs to B with remapped FK.

  it("step 3: order with association syncs A→B with remapped FK", async () => {
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

    const passAB = await engine.sync("orders", "A", "B");
    const insertResult = passAB.find((r) => r.action === "insert" && r.sourceId === orderAId);
    expect(insertResult).toBeDefined();
    orderBId = insertResult!.targetId;

    const bOrders = await readAll(connectorB, "orders");
    expect(bOrders).toHaveLength(1);
    expect(bOrders[0].data.amount).toBe(99);
    expect(bOrders[0].associations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ predicate: "customerId", targetId: aliceBId }),
      ]),
    );
    // Note: we deliberately do NOT run a B→A pass here so that the watermark
    // for B→A:orders remains unset. Step 4 will therefore do a full (un-filtered)
    // read from B, making it immune to same-millisecond timestamp collisions.
  });

  // ── Step 4 ─────────────────────────────────────────────────────────────────
  // Update order in B → amount flows to A, no echo.

  it("step 4: update order in B → amount flows to A, no echo", async () => {
    const ordersB = connectorB.entities.find((e) => e.name === "orders")!;
    await collect(
      ordersB.update!(one<UpdateRecord>({ id: orderBId, data: { amount: 149 } })),
    );

    const passBA = await engine.sync("orders", "B", "A");
    expect(passBA.find((r) => r.action === "update")).toBeDefined();

    const aOrders = await readAll(connectorA, "orders");
    expect(aOrders[0].data.amount).toBe(149);

    const passAB = await engine.sync("orders", "A", "B");
    expect(passAB.filter((r) => r.action === "update")).toHaveLength(0);
  });
});

// ─── Association propagation bug fixes ────────────────────────────────────────
// Each test is fully self-contained: own tmpDir, own engine, own connectors.

describe("SyncEngine v3 — association propagation", () => {
  it("bug 1 fix: removing all associations propagates as [] not undefined", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sync-poc-v3-bug1-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx([join(tmpDir, "a", "customers.json"), join(tmpDir, "a", "orders.json")]);
    const bCtx = makeCtx([join(tmpDir, "b", "customers.json"), join(tmpDir, "b", "orders.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    const eng = new SyncEngine({ connectors: [cA, cB], channels: [
      { id: "customers", members: [{ connectorId: "A", entity: "customers" }, { connectorId: "B", entity: "customers" }] },
      { id: "orders",    members: [{ connectorId: "A", entity: "orders"    }, { connectorId: "B", entity: "orders"    }] },
    ]});

    const custA = cA.entities.find((e) => e.name === "customers")!;
    const ordA  = cA.entities.find((e) => e.name === "orders")!;
    const [cust] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Bob" } })));
    const [ord]  = await collect(ordA.insert!(one<InsertRecord>({
      data: { amount: 50 },
      associations: [{ predicate: "customerId", targetEntity: "customers", targetId: cust.id }],
    })));

    await eng.sync("customers", "A", "B");
    const passAB = await eng.sync("orders", "A", "B");
    const ordBId = passAB.find((r) => r.action === "insert")!.targetId;

    let bOrders = await readAll(cB, "orders");
    expect(bOrders[0].associations).toHaveLength(1);

    // 1ms pause ensures the removal update gets a strictly newer _updatedAt than
    // the insert watermark. ISO timestamps have millisecond precision; without this
    // the since-filter (strict >) would drop the update.
    await Bun.sleep(1);

    // Remove the association in A.
    await collect(ordA.update!(one<UpdateRecord>({ id: ord.id, data: { amount: 50 }, associations: [] })));
    const passAB2 = await eng.sync("orders", "A", "B");
    expect(passAB2.find((r) => r.action === "update")).toBeDefined();

    bOrders = await readAll(cB, "orders");
    expect(bOrders.find((r) => r.id === ordBId)?.associations ?? []).toHaveLength(0);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bug 3 fix: unknown targetEntity surfaces as error action, not defer", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sync-poc-v3-bug3-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx([join(tmpDir, "a", "customers.json"), join(tmpDir, "a", "orders.json")]);
    const bCtx = makeCtx([join(tmpDir, "b", "customers.json"), join(tmpDir, "b", "orders.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    const eng = new SyncEngine({ connectors: [cA, cB], channels: [
      { id: "customers", members: [{ connectorId: "A", entity: "customers" }, { connectorId: "B", entity: "customers" }] },
      { id: "orders",    members: [{ connectorId: "A", entity: "orders"    }, { connectorId: "B", entity: "orders"    }] },
    ]});

    // Seed one customer so the "customers" entity is known to the engine.
    const custA = cA.entities.find((e) => e.name === "customers")!;
    await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Ghost" } })));
    await eng.sync("customers", "A", "B");

    // Insert an order referencing a completely fictitious entity type.
    const ordA = cA.entities.find((e) => e.name === "orders")!;
    const [badOrd] = await collect(ordA.insert!(one<InsertRecord>({
      data: { amount: 1 },
      associations: [{ predicate: "ref", targetEntity: "nonexistent_entity", targetId: "fake-id" }],
    })));

    const pass = await eng.sync("orders", "A", "B");
    const result = pass.find((r) => r.sourceId === badOrd.id);
    expect(result?.action).toBe("error");
    expect((result as { error?: string })?.error).toMatch(/nonexistent_entity/);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bug 4 fix: duplicate predicates are deduplicated before remapping", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sync-poc-v3-bug4-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    const aCtx = makeCtx([join(tmpDir, "a", "customers.json"), join(tmpDir, "a", "orders.json")]);
    const bCtx = makeCtx([join(tmpDir, "b", "customers.json"), join(tmpDir, "b", "orders.json")]);
    const cA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const cB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    const eng = new SyncEngine({ connectors: [cA, cB], channels: [
      { id: "customers", members: [{ connectorId: "A", entity: "customers" }, { connectorId: "B", entity: "customers" }] },
      { id: "orders",    members: [{ connectorId: "A", entity: "orders"    }, { connectorId: "B", entity: "orders"    }] },
    ]});

    const custA = cA.entities.find((e) => e.name === "customers")!;
    const ordA  = cA.entities.find((e) => e.name === "orders")!;
    const [cust] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Carol" } })));
    await eng.sync("customers", "A", "B");

    const [dupOrd] = await collect(ordA.insert!(one<InsertRecord>({
      data: { amount: 77 },
      associations: [
        { predicate: "customerId", targetEntity: "customers", targetId: cust.id },
        { predicate: "customerId", targetEntity: "customers", targetId: cust.id },
      ],
    })));

    const pass = await eng.sync("orders", "A", "B");
    expect(pass.find((r) => r.action === "insert" && r.sourceId === dupOrd.id)).toBeDefined();

    const bOrders = await readAll(cB, "orders");
    expect(bOrders.find((r) => r.data.amount === 77)?.associations).toHaveLength(1);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── State serialisation round-trip ──────────────────────────────────────────

describe("SyncEngine v3 — state serialisation", () => {
  it("toJSON/fromJSON round-trips identityMap, watermarks, and lastWritten", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sync-poc-v3-state-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });

    const aCtx = makeCtx([join(tmpDir, "a", "customers.json")]);
    const bCtx = makeCtx([join(tmpDir, "b", "customers.json")]);
    const connA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    const connB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };

    const cfg: EngineConfig = {
      connectors: [connA, connB],
      channels: [{ id: "customers", members: [
        { connectorId: "A", entity: "customers" },
        { connectorId: "B", entity: "customers" },
      ]}],
    };

    const engine1 = new SyncEngine(cfg);
    const custA = connA.entities.find((e) => e.name === "customers")!;
    const [ins] = await collect(custA.insert!(one<InsertRecord>({ data: { customerName: "Dave" } })));
    await engine1.sync("customers", "A", "B");

    const snapshot = engine1.toJSON();
    expect(snapshot.lastWritten).toBeDefined();
    expect(Object.keys(snapshot.lastWritten)).toContain("B");

    // Restore into a new engine and verify echo detection still works.
    const engine2 = new SyncEngine(cfg);
    engine2.fromJSON(snapshot);

    const passBA = await engine2.sync("customers", "B", "A");
    expect(passBA.filter((r) => r.action === "insert" || r.action === "update")).toHaveLength(0);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
