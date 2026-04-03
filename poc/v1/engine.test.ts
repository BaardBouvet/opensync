import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import connector from "../../connectors/jsonfiles/src/index.js";
import { SyncEngine } from "./engine.js";
import type { ConnectedSystem, ConnectorContext, InsertRecord, UpdateRecord } from "./engine.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeCtx(filePaths: string[]): ConnectorContext {
  return {
    config: { filePaths },
    state: {} as ConnectorContext["state"],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    http: null as unknown as ConnectorContext["http"],
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

/** Drain all records from one entity (full read, no watermark). */
async function readAll(
  entity: ReturnType<typeof connector.getEntities>[number],
  ctx: ConnectorContext,
): Promise<Array<{ id: string; data: Record<string, unknown>; associations?: unknown[] }>> {
  const records: Array<{ id: string; data: Record<string, unknown>; associations?: unknown[] }> = [];
  for await (const batch of entity.read!(ctx)) {
    for (const r of batch.records) {
      records.push({
        id: r.id,
        data: r.data as Record<string, unknown>,
        associations: r.associations,
      });
    }
  }
  return records;
}

// ─── 4-Step Demo ──────────────────────────────────────────────────────────────
//
// Tests build on each other sequentially using shared state in the describe scope.
// If an earlier step fails the later ones will also fail — that is intentional,
// since the scenario is a linear narrative.

describe("SyncEngine — 4-step demo", () => {
  let tmpDir: string;
  let systemA: ConnectedSystem;
  let systemB: ConnectedSystem;
  let engine: SyncEngine;

  // IDs captured during test execution and referenced by later steps.
  let aliceAId: string;
  let aliceBId: string;
  let orderAId: string;
  let orderBId: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sync-poc-demo-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });

    // Both systems expose entities named "customers" and "orders" (from the file basenames).
    // Customers comes first so the identity map is populated before orders are processed.
    const aCtx = makeCtx([
      join(tmpDir, "a", "customers.json"),
      join(tmpDir, "a", "orders.json"),
    ]);
    const bCtx = makeCtx([
      join(tmpDir, "b", "customers.json"),
      join(tmpDir, "b", "orders.json"),
    ]);

    systemA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    systemB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    engine = new SyncEngine();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Step 1 ──────────────────────────────────────────────────────────────────
  //
  // Write a customer (Alice) into System A.
  // After one full sync cycle the record must appear in System B with its own B-side ID,
  // and the bidirectional identity map must be populated.

  it("step 1: insert customer Alice in System A → appears in System B", async () => {
    const customersA = systemA.entities.find((e) => e.name === "customers")!;

    const [inserted] = await collect(
      customersA.insert!(one<InsertRecord>({ data: { name: "Alice" } })),
    );
    aliceAId = inserted.id;

    const pass1 = await engine.sync(systemA, systemB);
    await engine.sync(systemB, systemA);

    // The customer was inserted during the A→B pass.
    const insertResult = pass1.find(
      (r) => r.entity === "customers" && r.action === "insert" && r.sourceId === aliceAId,
    );
    expect(insertResult).toBeDefined();
    aliceBId = insertResult!.targetId;

    // System B contains exactly one customer with the correct name.
    const bCustomers = await readAll(
      systemB.entities.find((e) => e.name === "customers")!,
      systemB.ctx,
    );
    expect(bCustomers).toHaveLength(1);
    expect(bCustomers[0].id).toBe(aliceBId);
    expect(bCustomers[0].data.name).toBe("Alice");

    // Identity map is bidirectional.
    expect(engine.lookupTargetId("customers", "A", aliceAId, "B")).toBe(aliceBId);
    expect(engine.lookupTargetId("customers", "B", aliceBId, "A")).toBe(aliceAId);

    // System A still has exactly 1 customer — no echo bounced back.
    const aCustomers = await readAll(customersA, systemA.ctx);
    expect(aCustomers).toHaveLength(1);
  });

  // Step 2 inserts an order into System A that references Alice via associations only
  // (no customerId in data). After sync the order must appear in System B with:
  //   • its own B-side ID
  //   • _associations carrying the remapped reference to Alice's B-side ID

  it("step 2: insert order in System A → syncs to B with remapped association", async () => {
    const ordersA = systemA.entities.find((e) => e.name === "orders")!;

    const [inserted] = await collect(
      ordersA.insert!(
        one<InsertRecord>({
          data: { amount: 99 },
          associations: [
            { predicate: "customerId", targetEntity: "customers", targetId: aliceAId },
          ],
        }),
      ),
    );
    orderAId = inserted.id;

    const pass1 = await engine.sync(systemA, systemB);
    await engine.sync(systemB, systemA);

    const insertResult = pass1.find(
      (r) => r.entity === "orders" && r.action === "insert" && r.sourceId === orderAId,
    );
    expect(insertResult).toBeDefined();
    orderBId = insertResult!.targetId;

    const bOrders = await readAll(
      systemB.entities.find((e) => e.name === "orders")!,
      systemB.ctx,
    );
    expect(bOrders).toHaveLength(1);
    expect(bOrders[0].id).toBe(orderBId);
    expect(bOrders[0].data.amount).toBe(99);

    // No customerId field in data — FK lives only in associations.
    expect(bOrders[0].data.customerId).toBeUndefined();

    // Associations array must be remapped to Alice's B-side ID.
    expect(bOrders[0].associations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "customerId",
          targetEntity: "customers",
          targetId: aliceBId,
        }),
      ]),
    );

    // System A must still have exactly 1 order (no echo bounced back).
    const aOrders = await readAll(ordersA, systemA.ctx);
    expect(aOrders).toHaveLength(1);
  });

  // ── Step 3 ──────────────────────────────────────────────────────────────────
  //
  // Edit Alice's name in System A.
  // After sync System B must reflect the new name; System A must have no duplicates.

  it("step 3: update customer name in System A → flows to System B", async () => {
    const customersA = systemA.entities.find((e) => e.name === "customers")!;

    await collect(
      customersA.update!(
        one<UpdateRecord>({ id: aliceAId, data: { name: "Alice Smith" } }),
      ),
    );

    const pass1 = await engine.sync(systemA, systemB);
    const pass2 = await engine.sync(systemB, systemA);

    // A→B pass must contain an update for Alice.
    expect(pass1.find((r) => r.entity === "customers" && r.action === "update")).toBeDefined();

    // B→A pass must NOT propagate the change back (echo prevention).
    expect(pass2.filter((r) => r.entity === "customers" && r.action === "update")).toHaveLength(0);

    // System B has the new name.
    const bCustomers = await readAll(
      systemB.entities.find((e) => e.name === "customers")!,
      systemB.ctx,
    );
    expect(bCustomers.find((r) => r.id === aliceBId)?.data.name).toBe("Alice Smith");

    // System A has exactly 1 customer with the correct name — no duplicate.
    const aCustomers = await readAll(customersA, systemA.ctx);
    expect(aCustomers).toHaveLength(1);
    expect(aCustomers[0].data.name).toBe("Alice Smith");
  });

  // ── Step 4 ──────────────────────────────────────────────────────────────────
  //
  // Edit the order amount directly in System B.
  // After sync System A must reflect the new amount; System B must have no duplicates.

  it("step 4: update order amount in System B → flows to System A", async () => {
    const ordersB = systemB.entities.find((e) => e.name === "orders")!;

    await collect(
      ordersB.update!(one<UpdateRecord>({ id: orderBId, data: { amount: 149 } })),
    );

    const pass1 = await engine.sync(systemB, systemA);
    const pass2 = await engine.sync(systemA, systemB);

    // B→A pass must contain an update for the order.
    expect(pass1.find((r) => r.entity === "orders" && r.action === "update")).toBeDefined();

    // A→B pass must NOT propagate the change back (echo prevention).
    expect(pass2.filter((r) => r.entity === "orders" && r.action === "update")).toHaveLength(0);

    // System A has the updated amount.
    const aOrders = await readAll(
      systemA.entities.find((e) => e.name === "orders")!,
      systemA.ctx,
    );
    const orderInA = aOrders.find((r) => r.id === orderAId)!;
    expect(orderInA.data.amount).toBe(149);

    // System B still has exactly 1 order — no duplicate.
    const bOrders = await readAll(ordersB, systemB.ctx);
    expect(bOrders).toHaveLength(1);
    expect(bOrders[0].data.amount).toBe(149);
  });
});

// ─── 3-System Cascade ─────────────────────────────────────────────────────────────
//
// Three systems A, B, C all connected. Tests verify:
//  • Inserts in A cascade to both B and C in a single poll cycle.
//  • Edits in B flow to A and C without bouncing back to B.
//  • Edits in C flow to A and B without bouncing back to C.
//
// Poll order: A→B, B→C, A→C, C→B, B→A, C→A
// A→B then B→C ensures A’s changes cascade to C in one cycle via B.

describe("SyncEngine — 3-system cascade", () => {
  let tmpDir: string;
  let sA: ConnectedSystem;
  let sB: ConnectedSystem;
  let sC: ConnectedSystem;
  let engine: SyncEngine;

  let aliceAId: string;
  let aliceBId: string;
  let aliceCId: string;
  let orderAId: string;
  let orderCId: string;

  /** Run one full bidirectional poll across all three systems. */
  async function poll(): Promise<ReturnType<SyncEngine["sync"]>> {
    return [
      ...await engine.sync(sA, sB),
      ...await engine.sync(sB, sC),
      ...await engine.sync(sA, sC),
      ...await engine.sync(sC, sB),
      ...await engine.sync(sB, sA),
      ...await engine.sync(sC, sA),
    ];
  }

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sync-poc-3sys-"));
    mkdirSync(join(tmpDir, "a"), { recursive: true });
    mkdirSync(join(tmpDir, "b"), { recursive: true });
    mkdirSync(join(tmpDir, "c"), { recursive: true });

    const aCtx = makeCtx([join(tmpDir, "a", "customers.json"), join(tmpDir, "a", "orders.json")]);
    const bCtx = makeCtx([join(tmpDir, "b", "customers.json"), join(tmpDir, "b", "orders.json")]);
    const cCtx = makeCtx([join(tmpDir, "c", "customers.json"), join(tmpDir, "c", "orders.json")]);

    sA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
    sB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
    sC = { id: "C", ctx: cCtx, entities: connector.getEntities!(cCtx) };
    engine = new SyncEngine();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("insert Alice in A → cascades to B and C in a single poll cycle", async () => {
    const customersA = sA.entities.find((e) => e.name === "customers")!;
    const ordersA = sA.entities.find((e) => e.name === "orders")!;

    // Insert customer and order in A.
    const [alice] = await collect(customersA.insert!(one<InsertRecord>({ data: { name: "Alice" } })));
    aliceAId = alice.id;
    const [order] = await collect(ordersA.insert!(one<InsertRecord>({
      data: { amount: 99 },
      associations: [{ predicate: "customerId", targetEntity: "customers", targetId: aliceAId }],
    })));
    orderAId = order.id;

    const results = await poll();

    // Customer inserted into both B and C.
    const custInserts = results.filter((r) => r.entity === "customers" && r.action === "insert");
    expect(custInserts).toHaveLength(2);

    aliceBId = engine.lookupTargetId("customers", "A", aliceAId, "B")!;
    aliceCId = engine.lookupTargetId("customers", "A", aliceAId, "C")!;
    expect(aliceBId).toBeDefined();
    expect(aliceCId).toBeDefined();
    expect(aliceBId).not.toBe(aliceCId);

    // Order inserted into both B and C with remapped associations.
    const orderInserts = results.filter((r) => r.entity === "orders" && r.action === "insert");
    expect(orderInserts).toHaveLength(2);

    orderCId = engine.lookupTargetId("orders", "A", orderAId, "C")!;
    const cOrders = await readAll(sC.entities.find((e) => e.name === "orders")!, sC.ctx);
    expect(cOrders[0].associations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ predicate: "customerId", targetEntity: "customers", targetId: aliceCId }),
      ]),
    );

    // Each system has exactly 1 customer and 1 order — no duplicates.
    expect(await readAll(customersA, sA.ctx)).toHaveLength(1);
    expect(await readAll(sB.entities.find((e) => e.name === "customers")!, sB.ctx)).toHaveLength(1);
    expect(await readAll(sC.entities.find((e) => e.name === "customers")!, sC.ctx)).toHaveLength(1);
  });

  it("edit name in B → flows to A and C; does not bounce back to B", async () => {
    const customersB = sB.entities.find((e) => e.name === "customers")!;

    await collect(customersB.update!(one<UpdateRecord>({ id: aliceBId, data: { name: "Alice Smith" } })));

    const results = await poll();

    // B→C and B→A both update directly (2 writes). C→A also fires because C was just
    // updated by B→C and C→A runs in the same cycle before a new watermark suppresses it.
    // That third write is a redundant cascade but writes the correct value.
    expect(results.filter((r) => r.entity === "customers" && r.action === "update")).toHaveLength(3);
    expect(results.filter((r) => r.entity === "customers" && r.action === "insert")).toHaveLength(0);

    // All three systems reflect the new name.
    const aName = (await readAll(sA.entities.find((e) => e.name === "customers")!, sA.ctx))[0].data.name;
    const bName = (await readAll(customersB, sB.ctx))[0].data.name;
    const cName = (await readAll(sC.entities.find((e) => e.name === "customers")!, sC.ctx))[0].data.name;
    expect(aName).toBe("Alice Smith");
    expect(bName).toBe("Alice Smith");
    expect(cName).toBe("Alice Smith");
  });

  it("edit order amount in C → flows to A and B; does not bounce back to C", async () => {
    const ordersC = sC.entities.find((e) => e.name === "orders")!;

    await collect(ordersC.update!(one<UpdateRecord>({ id: orderCId, data: { amount: 149 } })));

    const results = await poll();

    // C→B and C→A both update directly (2 writes). B→A also fires because B was just
    // updated by C→B and B→A runs in the same cycle. Same correct-value redundant cascade.
    expect(results.filter((r) => r.entity === "orders" && r.action === "update")).toHaveLength(3);
    expect(results.filter((r) => r.entity === "orders" && r.action === "insert")).toHaveLength(0);

    const aAmount = (await readAll(sA.entities.find((e) => e.name === "orders")!, sA.ctx))[0].data.amount;
    const bAmount = (await readAll(sB.entities.find((e) => e.name === "orders")!, sB.ctx))[0].data.amount;
    const cAmount = (await readAll(ordersC, sC.ctx))[0].data.amount;
    expect(aAmount).toBe(149);
    expect(bAmount).toBe(149);
    expect(cAmount).toBe(149);
  });
});

// ─── Echo Prevention (unit) ───────────────────────────────────────────────────
//
// Isolated test verifying the echo guard is enforced even when there is no
// prior watermark, meaning the target record would appear as a "new" record
// on the first reverse poll.

describe("SyncEngine — echo prevention", () => {
  it("writing A→B does not create a duplicate back in A on the next B→A cycle", async () => {
    const td = mkdtempSync(join(tmpdir(), "sync-poc-echo-ab-"));
    mkdirSync(join(td, "a"), { recursive: true });
    mkdirSync(join(td, "b"), { recursive: true });
    try {
      const aCtx = makeCtx([join(td, "a", "customers.json")]);
      const bCtx = makeCtx([join(td, "b", "customers.json")]);
      const sA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
      const sB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
      const engine = new SyncEngine();
      const customersA = sA.entities.find((e) => e.name === "customers")!;

      await collect(customersA.insert!(one<InsertRecord>({ data: { name: "Alice" } })));

      await engine.sync(sA, sB);
      const reverseResults = await engine.sync(sB, sA);

      // The B→A pass should skip the record we just wrote — not insert it again.
      expect(reverseResults.filter((r) => r.action === "insert")).toHaveLength(0);

      // System A still has exactly 1 customer.
      const aCustomers = await readAll(customersA, aCtx);
      expect(aCustomers).toHaveLength(1);
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  });

  it("writing B→A does not bounce back as A→B on the following cycle", async () => {
    const td = mkdtempSync(join(tmpdir(), "sync-poc-echo-ba-"));
    mkdirSync(join(td, "a"), { recursive: true });
    mkdirSync(join(td, "b"), { recursive: true });
    try {
      const aCtx = makeCtx([join(td, "a", "customers.json")]);
      const bCtx = makeCtx([join(td, "b", "customers.json")]);
      const sA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
      const sB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
      const engine = new SyncEngine();
      const customersB = sB.entities.find((e) => e.name === "customers")!;

      await collect(customersB.insert!(one<InsertRecord>({ data: { name: "Bob" } })));

      await engine.sync(sB, sA);
      const reverseResults = await engine.sync(sA, sB);

      expect(reverseResults.filter((r) => r.action === "insert")).toHaveLength(0);

      const bCustomers = await readAll(customersB, bCtx);
      expect(bCustomers).toHaveLength(1);
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  });
});

// ─── Deferred Records (unit) ──────────────────────────────────────────────────
//
// Demonstrate that the engine returns action="defer" when an order's FK target
// is not yet in the identity map, rather than inserting a record with a broken
// (wrong-system) customer ID.

describe("SyncEngine — deferred records", () => {
  it("order with unresolved customerId returns action=defer for that record", async () => {
    const td = mkdtempSync(join(tmpdir(), "sync-poc-defer-"));
    mkdirSync(join(td, "a"), { recursive: true });
    mkdirSync(join(td, "b"), { recursive: true });

    try {
      // Entity ordering is intentionally REVERSED (orders before customers) to
      // force the engine to attempt the order before the identity map has Alice.
      const aCtx = makeCtx([
        join(td, "a", "orders.json"),
        join(td, "a", "customers.json"),
      ]);
      const bCtx = makeCtx([
        join(td, "b", "orders.json"),
        join(td, "b", "customers.json"),
      ]);
      const sA = { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) };
      const sB = { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) };
      const engine = new SyncEngine();

      const ordersA = sA.entities.find((e) => e.name === "orders")!;
      const customersA = sA.entities.find((e) => e.name === "customers")!;

      // Insert customer and order together in A.
      const [c] = await collect(
        customersA.insert!(one<InsertRecord>({ data: { name: "Alice" } })),
      );
      await collect(
        ordersA.insert!(
          one<InsertRecord>({
            data: { amount: 42 },
            associations: [
              { predicate: "customerId", targetEntity: "customers", targetId: c.id },
            ],
          }),
        ),
      );

      // Sync with reversed entity order: orders are processed before customers.
      const results = await engine.sync(sA, sB);

      const deferredOrders = results.filter(
        (r) => r.entity === "orders" && r.action === "defer",
      );
      // The order must be deferred (Alice not yet in the identity map when orders run).
      expect(deferredOrders).toHaveLength(1);

      // The customer was inserted in the same pass (it came second in the entity list).
      const insertedCustomers = results.filter(
        (r) => r.entity === "customers" && r.action === "insert",
      );
      expect(insertedCustomers).toHaveLength(1);

      // No broken order record inserted in B.
      const bOrders = await readAll(sB.entities.find((e) => e.name === "orders")!, sB.ctx);
      expect(bOrders).toHaveLength(0);
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  });
});
