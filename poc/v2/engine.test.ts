import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import connector from "../../connectors/jsonfiles/src/index.js";
import { SyncEngine, applyRename } from "./engine.js";
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
    const data = { a: 1, b: 2 };
    expect(applyRename(data, undefined)).toEqual({ a: 1, b: 2 });
  });

  it("passes through unchanged when map is empty", () => {
    const data = { a: 1, b: 2 };
    expect(applyRename(data, {})).toEqual({ a: 1, b: 2 });
  });

  it("renames a listed field", () => {
    expect(applyRename({ name: "Alice" }, { name: "customerName" }))
      .toEqual({ customerName: "Alice" });
  });

  it("drops unlisted fields (whitelist) when a map is provided", () => {
    // When a rename map is provided, only mapped fields are included.
    // Unlisted fields are connector-local and must not leak into canonical form.
    expect(applyRename({ name: "Alice", amount: 99 }, { name: "customerName" }))
      .toEqual({ customerName: "Alice" });
  });

  it("renames multiple fields and drops unlisted fields", () => {
    expect(applyRename({ a: 1, b: 2, c: 3 }, { a: "x", b: "y" }))
      .toEqual({ x: 1, y: 2 });
  });

  it("does not mutate the input", () => {
    const data = { name: "Alice" };
    applyRename(data, { name: "customerName" });
    expect(data).toEqual({ name: "Alice" });
  });
});

// ─── 3-connector field mapping scenario ──────────────────────────────────────
//
// Canonical customer field: "customerName"
//
// Connector A: local field "name"
//   inbound:  { name → customerName }
//   outbound: { customerName → name }
//
// Connector B: already uses "customerName" (no renames)
//
// Connector C: local field "fullName"
//   inbound:  { fullName → customerName }
//   outbound: { customerName → fullName }
//
// Orders use the same field names across all connectors (no renames).

describe("SyncEngine — 3-connector canonical field mapping", () => {
  let tmpDir: string;
  let connectorA: ConnectorInstance;
  let connectorB: ConnectorInstance;
  let connectorC: ConnectorInstance;
  let engine: SyncEngine;
  let config: EngineConfig;

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
        // B already uses "customerName" — no renames needed
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

    const aCtx = makeCtx([
      join(tmpDir, "a", "customers.json"),
      join(tmpDir, "a", "orders.json"),
    ]);
    const bCtx = makeCtx([
      join(tmpDir, "b", "customers.json"),
      join(tmpDir, "b", "orders.json"),
    ]);
    const cCtx = makeCtx([
      join(tmpDir, "c", "customers.json"),
      join(tmpDir, "c", "orders.json"),
    ]);

    connectorA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    connectorB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    connectorC = { id: "C", ctx: cCtx, entities: connector.getEntities!(cCtx) };

    config = {
      connectors: [connectorA, connectorB, connectorC],
      channels: [customersChannel, ordersChannel],
    };
    engine = new SyncEngine(config);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Step 1 ─────────────────────────────────────────────────────────────────
  //
  // Insert { name: "Alice Smith" } into connector A.
  // After syncing A→B and A→C:
  //   B must have { customerName: "Alice Smith" }
  //   C must have { fullName: "Alice Smith" }

  it("step 1: insert into A → B gets customerName, C gets fullName", async () => {
    const customersA = connectorA.entities.find((e) => e.name === "customers")!;

    const [inserted] = await collect(
      customersA.insert!(one<InsertRecord>({ data: { name: "Alice Smith" } })),
    );
    aliceAId = inserted.id;

    const passAB = await engine.sync("customers", "A", "B");
    const passAC = await engine.sync("customers", "A", "C");
    // Run reverse passes to consume echoes (mirrors what the poll loop does every cycle).
    await engine.sync("customers", "B", "A");
    await engine.sync("customers", "C", "A");
    await engine.sync("customers", "B", "C");
    await engine.sync("customers", "C", "B");

    // Both passes should have inserted Alice.
    const abInsert = passAB.find((r) => r.action === "insert" && r.sourceId === aliceAId);
    const acInsert = passAC.find((r) => r.action === "insert" && r.sourceId === aliceAId);
    expect(abInsert).toBeDefined();
    expect(acInsert).toBeDefined();
    aliceBId = abInsert!.targetId;
    aliceCId = acInsert!.targetId;

    // B: field must be "customerName", not "name".
    const bCustomers = await readAll(connectorB, "customers");
    expect(bCustomers).toHaveLength(1);
    expect(bCustomers[0].id).toBe(aliceBId);
    expect(bCustomers[0].data.customerName).toBe("Alice Smith");
    expect(bCustomers[0].data.name).toBeUndefined();

    // C: field must be "fullName", not "name" or "customerName".
    const cCustomers = await readAll(connectorC, "customers");
    expect(cCustomers).toHaveLength(1);
    expect(cCustomers[0].id).toBe(aliceCId);
    expect(cCustomers[0].data.fullName).toBe("Alice Smith");
    expect(cCustomers[0].data.name).toBeUndefined();
    expect(cCustomers[0].data.customerName).toBeUndefined();

    // A still has exactly 1 customer — no echoes bounced back.
    const aCustomers = await readAll(connectorA, "customers");
    expect(aCustomers).toHaveLength(1);
  });

  // ── Step 2 ─────────────────────────────────────────────────────────────────
  //
  // Edit customerName in B to "Alicia Smith".
  // After syncing B→A and B→C:
  //   A must have { name: "Alicia Smith" }
  //   C must have { fullName: "Alicia Smith" }
  // No echo: A→B and C→B passes must not re-propagate.

  it("step 2: update in B → A gets name, C gets fullName, no echo", async () => {
    const customersB = connectorB.entities.find((e) => e.name === "customers")!;

    await collect(
      customersB.update!(one<UpdateRecord>({ id: aliceBId, data: { customerName: "Alicia Smith" } })),
    );

    const passBA = await engine.sync("customers", "B", "A");
    const passBC = await engine.sync("customers", "B", "C");

    expect(passBA.find((r) => r.action === "update")).toBeDefined();
    expect(passBC.find((r) => r.action === "update")).toBeDefined();

    // A: field "name" updated.
    const aCustomers = await readAll(connectorA, "customers");
    expect(aCustomers).toHaveLength(1);
    expect(aCustomers[0].data.name).toBe("Alicia Smith");
    expect(aCustomers[0].data.customerName).toBeUndefined();

    // C: field "fullName" updated.
    const cCustomers = await readAll(connectorC, "customers");
    expect(cCustomers).toHaveLength(1);
    expect(cCustomers[0].data.fullName).toBe("Alicia Smith");
    expect(cCustomers[0].data.customerName).toBeUndefined();

    // Echo prevention: reverse passes should see no updates.
    const passAB = await engine.sync("customers", "A", "B");
    const passCB = await engine.sync("customers", "C", "B");
    expect(passAB.filter((r) => r.action === "update")).toHaveLength(0);
    expect(passCB.filter((r) => r.action === "update")).toHaveLength(0);
  });

  // ── Step 3 ─────────────────────────────────────────────────────────────────
  //
  // Insert an order in A referencing Alice via associations.
  // After syncing A→B the order must appear with the remapped association (B-side Alice ID).

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

    const passAB2 = await engine.sync("orders", "A", "B");
    // Run reverse passes to consume echoes.
    await engine.sync("orders", "B", "A");
    await engine.sync("orders", "C", "A");
    await engine.sync("orders", "B", "C");
    await engine.sync("orders", "C", "B");

    const insertResult = passAB2.find((r) => r.action === "insert" && r.sourceId === orderAId);
    expect(insertResult).toBeDefined();
    orderBId = insertResult!.targetId;    const bOrders = await readAll(connectorB, "orders");
    expect(bOrders).toHaveLength(1);
    expect(bOrders[0].data.amount).toBe(99);
    expect(bOrders[0].associations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "customerId",
          targetEntity: "customers",
          targetId: aliceBId,
        }),
      ]),
    );
  });

  // ── Step 4 ─────────────────────────────────────────────────────────────────
  //
  // Update order amount in B → flows back to A. No echo.

  it("step 4: update order in B → amount flows to A, no echo", async () => {
    const ordersB = connectorB.entities.find((e) => e.name === "orders")!;

    await collect(
      ordersB.update!(one<UpdateRecord>({ id: orderBId, data: { amount: 149 } })),
    );

    const passBA = await engine.sync("orders", "B", "A");
    expect(passBA.find((r) => r.action === "update")).toBeDefined();

    const aOrders = await readAll(connectorA, "orders");
    expect(aOrders).toHaveLength(1);
    expect(aOrders[0].data.amount).toBe(149);

    // Echo prevention.
    const passAB = await engine.sync("orders", "A", "B");
    expect(passAB.filter((r) => r.action === "update")).toHaveLength(0);
  });
});
