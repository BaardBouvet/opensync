/**
 * packages/engine/src/multilevel-array.test.ts
 *
 * Tests for multi-level nested array expansion (§3.4) and reverse array collapse (§3.2/§3.4).
 * Spec: specs/field-mapping.md §3.2, §3.4
 * Plans: PLAN_MULTILEVEL_ARRAY_EXPANSION.md, PLAN_ARRAY_COLLAPSE.md
 *
 * ML1  Two-level config loads correctly: sourceEntity = "orders", expansionChain.length === 2
 * ML2  Three-level config loads correctly: sourceEntity = "orders", expansionChain.length === 3
 * ML3  Cycle in parent chain is rejected at load time
 * ML4  Cross-connector hop is rejected at load time
 * ML5  Forward expansion produces correct number of grandchild records (2 orders × 2 lines × 2 components = 8)
 * ML6  Grandchild external IDs follow composite ord#lines[L01]#components[C01] formula
 * ML7  Grandchild canonical IDs are stable and distinct from parent/child IDs
 * ML8  array_parent_map contains entries for every hop (2 per grandchild for 2-level)
 * ML9  collectOnly expansion writes child shadows and array_parent_map entries for all hops
 * ML10 Single-level member continues to work unchanged (backward compat with existig NA tests)
 * AC1  Round-trip: forward expand to flat connector, edit flat record, collapse patches correct array slot
 * AC2  Two lines updated in one poll → single parent write per parent
 * AC3  Unknown child (no array_parent_map entry) → skip with no error
 * AC4  collectOnly expansion stores child shadows → discover() matches them against flat side
 * AC5  Partial patch: only mapped fields overwritten, other element fields preserved
 * AC6  Collapse works with multi-level chain (grandchild → child → root write-back)
 */
import { describe, it, expect, beforeEach } from "bun:test";
import type {
  Connector,
  ConnectorContext,
  EntityDefinition,
  ReadRecord,
  InsertRecord,
  InsertResult,
  UpdateRecord,
  UpdateResult,
  ReadBatch,
} from "@opensync/sdk";
import { SyncEngine, type ResolvedConfig, openDb } from "./index.js";
import { loadConfig } from "./config/loader.js";
import type { Db } from "./db/index.js";
import { deriveChildCanonicalId, extractHopKeys } from "./core/array-expander.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Db {
  return openDb(":memory:");
}

// ─── In-memory ERP connector (two-level: orders → lines → components) ─────────

type Component   = { compNo: string; partSku: string; qty: number };
type Line        = { lineNo: string; sku: string; qty: number; price: number; components: Component[] };
type NestedOrder = { id: string; orderRef: string; lines: Line[] };

function makeNestedErpConnector(orders: NestedOrder[], updates: { id: string; data: Record<string, unknown> }[] = []): {
  connector: Connector;
  writtenUpdates: Array<{ id: string; data: Record<string, unknown> }>;
} {
  const writtenUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];

  const connector: Connector = {
    metadata: { name: "nested-erp", version: "0.0.1", auth: { type: "none" } },
    getEntities(): EntityDefinition[] {
      return [
        {
          name: "orders",
          async *read(_ctx: ConnectorContext, _since?: string): AsyncIterable<ReadBatch> {
            yield {
              records: orders.map((o) => ({
                id: o.id,
                data: {
                  orderRef: o.orderRef,
                  lines: o.lines.map((l) => ({
                    lineNo: l.lineNo,
                    sku: l.sku,
                    qty: l.qty,
                    price: l.price,
                    components: l.components.map((c) => ({
                      compNo: c.compNo,
                      partSku: c.partSku,
                      qty: c.qty,
                    })),
                  })),
                },
              })),
              since: "ts-1",
            };
          },
          async lookup(ids: string[], _ctx: ConnectorContext) {
            return orders
              .filter((o) => ids.includes(o.id))
              .map((o) => ({
                id: o.id,
                data: {
                  orderRef: o.orderRef,
                  lines: o.lines.map((l) => ({
                    lineNo: l.lineNo,
                    sku: l.sku,
                    qty: l.qty,
                    price: l.price,
                    components: l.components.map((c) => ({ compNo: c.compNo, partSku: c.partSku, qty: c.qty })),
                  })),
                },
              }));
          },
          async *update(items: AsyncIterable<UpdateRecord>, _ctx: ConnectorContext): AsyncIterable<UpdateResult> {
            for await (const item of items) {
              // Apply the update to the in-memory orders array
              const idx = orders.findIndex((o) => o.id === item.id);
              if (idx !== -1) {
                orders[idx] = { ...orders[idx]!, ...(item.data as Partial<NestedOrder>) } as NestedOrder;
              }
              writtenUpdates.push({ id: item.id, data: item.data as Record<string, unknown> });
              yield { id: item.id };
            }
          },
        },
      ];
    },
  };
  return { connector, writtenUpdates };
}

// ─── In-memory flat component connector ───────────────────────────────────────

function makeFlatComponentConnector(initialRecords: Array<{ id: string; data: Record<string, unknown> }>): {
  connector: Connector;
  inserts: Record<string, unknown>[];
  records: Map<string, Record<string, unknown>>;
} {
  const inserts: Record<string, unknown>[] = [];
  const records = new Map<string, Record<string, unknown>>(initialRecords.map((r) => [r.id, r.data]));
  let nextId = 1;

  const connector: Connector = {
    metadata: { name: "flat-warehouse", version: "0.0.1", auth: { type: "none" } },
    getEntities(): EntityDefinition[] {
      return [
        {
          name: "components",
          async *read(_ctx: ConnectorContext, _since?: string): AsyncIterable<ReadBatch> {
            yield {
              records: Array.from(records.entries()).map(([id, data]) => ({ id, data })),
              since: "ts-1",
            };
          },
          async *insert(items: AsyncIterable<InsertRecord>, _ctx: ConnectorContext): AsyncIterable<InsertResult> {
            for await (const item of items) {
              const id = `comp-${nextId++}`;
              inserts.push(item.data as Record<string, unknown>);
              records.set(id, item.data as Record<string, unknown>);
              yield { id };
            }
          },
          async *update(items: AsyncIterable<UpdateRecord>, _ctx: ConnectorContext): AsyncIterable<UpdateResult> {
            for await (const item of items) {
              records.set(item.id, item.data as Record<string, unknown>);
              yield { id: item.id };
            }
          },
        },
      ];
    },
  };
  return { connector, inserts, records };
}

// ─── In-memory flat line-items connector ──────────────────────────────────────

function makeFlatLineConnector(initialRecords: Array<{ id: string; data: Record<string, unknown> }>): {
  connector: Connector;
  inserts: Record<string, unknown>[];
  updates: Array<{ id: string; data: Record<string, unknown> }>;
  records: Map<string, Record<string, unknown>>;
} {
  const inserts: Record<string, unknown>[] = [];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const records = new Map<string, Record<string, unknown>>(initialRecords.map((r) => [r.id, r.data]));
  let nextId = 1;

  const connector: Connector = {
    metadata: { name: "flat-shop", version: "0.0.1", auth: { type: "none" } },
    getEntities(): EntityDefinition[] {
      return [
        {
          name: "lineItems",
          async *read(_ctx: ConnectorContext, _since?: string): AsyncIterable<ReadBatch> {
            yield {
              records: Array.from(records.entries()).map(([id, data]) => ({ id, data })),
              since: "ts-2",
            };
          },
          async *insert(items: AsyncIterable<InsertRecord>, _ctx: ConnectorContext): AsyncIterable<InsertResult> {
            for await (const item of items) {
              const id = `li-${nextId++}`;
              inserts.push(item.data as Record<string, unknown>);
              records.set(id, item.data as Record<string, unknown>);
              yield { id };
            }
          },
          async *update(items: AsyncIterable<UpdateRecord>, _ctx: ConnectorContext): AsyncIterable<UpdateResult> {
            for await (const item of items) {
              updates.push({ id: item.id, data: item.data as Record<string, unknown> });
              records.set(item.id, item.data as Record<string, unknown>);
              yield { id: item.id };
            }
          },
        },
      ];
    },
  };
  return { connector, inserts, updates, records };
}

// ─── Config helpers ────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `opensync-ml-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "mappings"), { recursive: true });
  return dir;
}

function writeConfig(dir: string, mappingsYaml: string): void {
  // Write minimal connector stubs so loadConfig's plugin loader doesn't fail
  const stub = `const c = { getEntities: () => [] }; export default c;\n`;
  writeFileSync(join(dir, "erp-stub.ts"), stub);
  writeFileSync(join(dir, "warehouse-stub.ts"), stub);
  writeFileSync(join(dir, "shop-stub.ts"), stub);
  writeFileSync(join(dir, "opensync.json"), JSON.stringify({
    connectors: {
      erp: { plugin: "./erp-stub.ts", config: {} },
      warehouse: { plugin: "./warehouse-stub.ts", config: {} },
      shop: { plugin: "./shop-stub.ts", config: {} },
    },
  }));
  writeFileSync(join(dir, "mappings", "mappings.yaml"), mappingsYaml);
}

// ─── Single-level order connector (no components) ────────────────────────────

function makeSimpleOrderConnector(orders: Array<{ id: string; lines: Array<{ lineNo: string; sku: string; qty: number; price: number }> }>, extraFields: Record<string, unknown> = {}): {
  connector: Connector;
  writtenUpdates: Array<{ id: string; data: Record<string, unknown> }>;
} {
  const writtenUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const connector: Connector = {
    metadata: { name: "simple-erp", version: "0.0.1", auth: { type: "none" } },
    getEntities(): EntityDefinition[] {
      return [{
        name: "orders",
        async *read(_ctx: ConnectorContext, _since?: string): AsyncIterable<ReadBatch> {
          yield {
            records: orders.map((o) => ({
              id: o.id,
              data: { lines: o.lines.map((l) => ({ lineNo: l.lineNo, sku: l.sku, qty: l.qty, price: l.price, ...extraFields })) },
            })),
            since: "ts-1",
          };
        },
        async lookup(ids: string[], _ctx: ConnectorContext) {
          return orders
            .filter((o) => ids.includes(o.id))
            .map((o) => ({
              id: o.id,
              data: { lines: o.lines.map((l) => ({ lineNo: l.lineNo, sku: l.sku, qty: l.qty, price: l.price, ...extraFields })) },
            }));
        },
        async *update(items: AsyncIterable<UpdateRecord>, _ctx: ConnectorContext): AsyncIterable<UpdateResult> {
          for await (const item of items) {
            const d = item.data as { lines?: Array<{ lineNo: string; qty: number; price: number }> };
            const idx = orders.findIndex((o) => o.id === item.id);
            if (idx !== -1 && d.lines) {
              for (const updLine of d.lines) {
                const lineIdx = orders[idx]!.lines.findIndex((l) => l.lineNo === updLine.lineNo);
                if (lineIdx !== -1) {
                  orders[idx]!.lines[lineIdx] = { ...orders[idx]!.lines[lineIdx]!, ...updLine };
                }
              }
            }
            writtenUpdates.push({ id: item.id, data: item.data as Record<string, unknown> });
            yield { id: item.id };
          }
        },
      }];
    },
  };
  return { connector, writtenUpdates };
}

describe("ML1: two-level config loads with correct expansionChain", () => {
  it("sourceEntity = orders, expansionChain.length === 2", async () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, `
mappings:
  - name: erp_orders
    connector: erp
    channel: orders
    entity: orders
    fields: []
  - name: erp_lines
    connector: erp
    channel: line-components
    parent: erp_orders
    array_path: lines
    element_key: lineNo
    fields: []
  - name: erp_components
    connector: erp
    channel: line-components
    parent: erp_lines
    array_path: components
    element_key: compNo
    fields: []
  - connector: warehouse
    channel: line-components
    entity: components
    fields: []
`);
      const config = await loadConfig(dir);
      const ch = config.channels.find((c) => c.id === "line-components");
      const erpMember = ch?.members.find((m) => m.connectorId === "erp");

      expect(erpMember?.sourceEntity).toBe("orders");
      expect(erpMember?.expansionChain).toHaveLength(2);
      expect(erpMember?.expansionChain![0]!.arrayPath).toBe("lines");
      expect(erpMember?.expansionChain![1]!.arrayPath).toBe("components");
      expect(erpMember?.expansionChain![0]!.elementKey).toBe("lineNo");
      expect(erpMember?.expansionChain![1]!.elementKey).toBe("compNo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── ML2: Three-level config loads correctly ─────────────────────────────────

describe("ML2: three-level config loads with correct expansionChain", () => {
  it("sourceEntity = root, expansionChain.length === 3", async () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, `
mappings:
  - name: root
    connector: erp
    channel: deep
    entity: invoices
    fields: []
  - name: sections
    connector: erp
    channel: deep
    parent: root
    array_path: sections
    element_key: secId
    fields: []
  - name: items
    connector: erp
    channel: deep
    parent: sections
    array_path: items
    element_key: itemId
    fields: []
  - name: tags
    connector: erp
    channel: deep
    parent: items
    array_path: tags
    element_key: tagId
    fields: []
  - connector: warehouse
    channel: deep
    entity: tags
    fields: []
`);
      const config = await loadConfig(dir);
      const ch = config.channels.find((c) => c.id === "deep");
      const erpMember = ch?.members.find((m) => m.connectorId === "erp");

      expect(erpMember?.sourceEntity).toBe("invoices");
      expect(erpMember?.expansionChain).toHaveLength(3);
      expect(erpMember?.expansionChain!.map((l) => l.arrayPath)).toEqual(["sections", "items", "tags"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── ML3: Cycle in parent chain is rejected ───────────────────────────────────

describe("ML3: cycle in parent chain", () => {
  it("throws an error", async () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, `
mappings:
  - name: a
    connector: erp
    channel: ch
    entity: orders
    fields: []
  - name: b
    connector: erp
    channel: ch2
    parent: a
    array_path: lines
    fields: []
  - name: c
    connector: erp
    channel: ch3
    parent: b
    array_path: components
    fields: []
  - name: a2
    connector: erp
    channel: ch3
    parent: c
    array_path: tags
    fields: []
  - connector: warehouse
    channel: ch3
    entity: tags
    fields: []
`);
      // c references b which references a, BUT a2 references c making it cyclic
      // To make a true cycle: a2 references c which references b which references a ...
      // Let's use a simpler direct cycle via cross-channel to trigger resolveExpansionChain
      // The cycle: x.parent = y, y.parent = x in different channels
      rmSync(dir, { recursive: true, force: true });
      const dir2 = makeTmpDir();
      try {
        writeConfig(dir2, `
mappings:
  - name: x
    connector: erp
    channel: ch-x
    entity: orders
    parent: y
    array_path: lines
    fields: []
  - name: y
    connector: erp
    channel: ch-y
    entity: lines
    parent: x
    array_path: items
    fields: []
  - connector: warehouse
    channel: ch-y
    entity: items
    parent: y
    array_path: items
    fields: []
`);
        await expect(loadConfig(dir2)).rejects.toThrow(/cycle/i);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── ML4: Cross-connector hop is rejected ─────────────────────────────────────

describe("ML4: cross-connector hop in chain", () => {
  it("throws an error", async () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, `
mappings:
  - name: erp_orders
    connector: erp
    channel: ch
    entity: orders
    fields: []
  - name: erp_lines
    connector: erp
    channel: ch
    parent: erp_orders
    array_path: lines
    element_key: lineNo
    fields: []
  - connector: warehouse
    channel: ch
    parent: erp_lines
    array_path: components
    element_key: compNo
    fields: []
`);
      await expect(loadConfig(dir)).rejects.toThrow(/cross-connector/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── ML5–ML8: Forward expansion integration ────────────────────────────────────

const ORDERS_2L: NestedOrder[] = [
  {
    id: "ord1", orderRef: "ORD-1001",
    lines: [
      { lineNo: "L01", sku: "SKU-A", qty: 5, price: 10, components: [{ compNo: "C01", partSku: "P1", qty: 2 }, { compNo: "C02", partSku: "P2", qty: 3 }] },
      { lineNo: "L02", sku: "SKU-B", qty: 2, price: 20, components: [{ compNo: "C01", partSku: "P3", qty: 1 }, { compNo: "C02", partSku: "P4", qty: 4 }] },
    ],
  },
  {
    id: "ord2", orderRef: "ORD-1002",
    lines: [
      { lineNo: "L01", sku: "SKU-C", qty: 1, price: 30, components: [{ compNo: "C01", partSku: "P5", qty: 1 }] },
    ],
  },
];

function makeTwoLevelConfig(erpConnector: Connector, warehouseConnector: Connector): ResolvedConfig {
  return {
    connectors: [
      { id: "erp", connector: erpConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      { id: "warehouse", connector: warehouseConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
    ],
    channels: [
      {
        id: "line-components",
        members: [
          {
            connectorId: "erp",
            entity: "line_components",
            sourceEntity: "orders",
            arrayPath: "components",
            elementKey: "compNo",
            expansionChain: [
              { arrayPath: "lines", elementKey: "lineNo" },
              { arrayPath: "components", elementKey: "compNo" },
            ],
            inbound: [
              { source: "compNo", target: "compNo" },
              { source: "partSku", target: "partSku" },
              { source: "qty", target: "qty" },
            ],
            outbound: [
              { source: "compNo", target: "compNo" },
              { source: "partSku", target: "partSku" },
              { source: "qty", target: "qty" },
            ],
          },
          {
            connectorId: "warehouse",
            entity: "components",
            inbound: [
              { source: "compNo", target: "compNo" },
              { source: "partSku", target: "partSku" },
              { source: "qty", target: "qty" },
            ],
            outbound: [
              { source: "compNo", target: "compNo" },
              { source: "partSku", target: "partSku" },
              { source: "qty", target: "qty" },
            ],
          },
        ],
        identityFields: ["compNo"],
      },
    ],
    conflict: { strategy: "lww" },
    readTimeoutMs: 30_000,
  };
}

describe("ML5: two-level forward expansion produces correct records", () => {
  it("2 orders × {2+2 lines} × 2+2+1 components = 5 total granchildren dispatched", async () => {
    // ord1: L01(C01,C02) + L02(C01,C02) = 4 components
    // ord2: L01(C01) = 1 component
    // Total = 5 components
    const orders = JSON.parse(JSON.stringify(ORDERS_2L)) as NestedOrder[];
    const { connector: erpConnector } = makeNestedErpConnector(orders);
    const { connector: warehouseConnector, inserts } = makeFlatComponentConnector([]);
    const db = makeDb();
    const engine = new SyncEngine(makeTwoLevelConfig(erpConnector, warehouseConnector), db);

    await engine.ingest("line-components", "erp");

    expect(inserts).toHaveLength(5);
  });
});

describe("ML6: grandchild external IDs use composite formula", () => {
  it("leaf IDs match ord#lines[L01]#components[C01] pattern", async () => {
    const orders = JSON.parse(JSON.stringify(ORDERS_2L)) as NestedOrder[];
    const { connector: erpConnector } = makeNestedErpConnector(orders);
    const { connector: warehouseConnector, inserts } = makeFlatComponentConnector([]);
    const db = makeDb();
    const engine = new SyncEngine(makeTwoLevelConfig(erpConnector, warehouseConnector), db);

    const result = await engine.ingest("line-components", "erp");

    // All dispatched records have sourceIDs that include compound path segments
    const insertResults = result.records.filter((r) => r.action === "insert");
    const sourceIds = insertResults.map((r) => r.sourceId);
    expect(sourceIds.some((id) => id.includes("#lines[L01]#components[C01]"))).toBe(true);
    expect(sourceIds.some((id) => id.includes("#lines[L02]#components[C02]"))).toBe(true);
  });
});

describe("ML7: grandchild canonical IDs are stable and distinct", () => {
  it("same input always produces the same canonical ID; different inputs differ", () => {
    const parentCanonId = "00000000-0000-0000-0000-000000000001";
    // Two-level derivation
    const lineCanon = deriveChildCanonicalId(parentCanonId, "lines", "L01");
    const compCanon = deriveChildCanonicalId(lineCanon, "components", "C01");

    // Stability
    const lineCanon2 = deriveChildCanonicalId(parentCanonId, "lines", "L01");
    const compCanon2 = deriveChildCanonicalId(lineCanon2, "components", "C01");
    expect(compCanon).toBe(compCanon2);

    // Distinct from each level
    expect(compCanon).not.toBe(parentCanonId);
    expect(compCanon).not.toBe(lineCanon);

    // Different element key → different canonical
    const compCanon3 = deriveChildCanonicalId(lineCanon, "components", "C02");
    expect(compCanon).not.toBe(compCanon3);
  });
});

describe("ML8: array_parent_map written for every hop", () => {
  it("each grandchild has two rows: grandchild→child and child→parent", async () => {
    const orders = JSON.parse(JSON.stringify(ORDERS_2L)) as NestedOrder[];
    const { connector: erpConnector } = makeNestedErpConnector(orders);
    const { connector: warehouseConnector } = makeFlatComponentConnector([]);
    const db = makeDb();
    const engine = new SyncEngine(makeTwoLevelConfig(erpConnector, warehouseConnector), db);

    await engine.ingest("line-components", "erp");

    const rows = db.prepare("SELECT * FROM array_parent_map").all() as Array<{
      child_canon_id: string; parent_canon_id: string; array_path: string; element_key: string;
    }>;
    // 5 grandchild rows + 3 intermediate line rows (ord1:L01, ord1:L02, ord2:L01) = 8 rows total
    // ord1 has 2 lines, ord2 has 1 line → 3 line-level rows
    // 5 component rows (as above)
    expect(rows.filter((r) => r.array_path === "lines")).toHaveLength(3);
    expect(rows.filter((r) => r.array_path === "components")).toHaveLength(5);
  });
});

// ─── ML9: collectOnly expansion ───────────────────────────────────────────────

describe("ML9: collectOnly writes child shadows and parent_map for all hops", () => {
  it("stores child-level shadows under entity name and writes array_parent_map for every hop", async () => {
    const orders = JSON.parse(JSON.stringify(ORDERS_2L)) as NestedOrder[];
    const { connector: erpConnector } = makeNestedErpConnector(orders);
    const { connector: warehouseConnector } = makeFlatComponentConnector([]);
    const db = makeDb();
    const engine = new SyncEngine(makeTwoLevelConfig(erpConnector, warehouseConnector), db);

    await engine.ingest("line-components", "erp", { collectOnly: true });

    // Child-level shadows stored under "line_components" entity
    const shadowRows = db.prepare("SELECT * FROM shadow_state WHERE entity_name = ?").all("line_components") as unknown[];
    expect(shadowRows.length).toBeGreaterThan(0);

    // Parent_map rows for both hops
    const mapRows = db.prepare("SELECT * FROM array_parent_map").all() as Array<{ array_path: string }>;
    expect(mapRows.some((r) => r.array_path === "lines")).toBe(true);
    expect(mapRows.some((r) => r.array_path === "components")).toBe(true);
  });
});

// ─── ML10: single-level backward compat ───────────────────────────────────────

describe("ML10: single-level member works unchanged", () => {
  it("produces flat dispatch results identical to pre-multilevel behaviour", async () => {
    // This is a single-level member — expansionChain.length === 1.
    // Verifies backward compatibility.
    type Order = { id: string; lines: Array<{ lineNo: string; sku: string; qty: number }> };
    const orders: Order[] = [
      { id: "o1", lines: [{ lineNo: "L01", sku: "A", qty: 10 }, { lineNo: "L02", sku: "B", qty: 5 }] },
    ];
    const erpConnector: Connector = {
      metadata: { name: "erp-compat", version: "0.0.1", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "orders",
          async *read(): AsyncIterable<ReadBatch> {
            yield {
              records: orders.map((o) => ({ id: o.id, data: { lines: o.lines } })),
              since: "ts-1",
            };
          },
        }];
      },
    };
    const { connector: flatConnector, inserts } = makeFlatComponentConnector([]);
    const db = makeDb();
    const config: ResolvedConfig = {
      connectors: [
        { id: "erp", connector: erpConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "flat", connector: flatConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels: [{
        id: "lines",
        members: [
          {
            connectorId: "erp",
            entity: "order_lines",
            sourceEntity: "orders",
            arrayPath: "lines",
            elementKey: "lineNo",
            expansionChain: [{ arrayPath: "lines", elementKey: "lineNo" }],
            inbound: [{ source: "lineNo", target: "lineNo" }, { source: "sku", target: "sku" }, { source: "qty", target: "qty" }],
            outbound: [{ source: "lineNo", target: "lineNo" }, { source: "sku", target: "sku" }, { source: "qty", target: "qty" }],
          },
          {
            connectorId: "flat",
            entity: "components",
            inbound: [{ source: "lineNo", target: "lineNo" }, { source: "sku", target: "sku" }, { source: "qty", target: "qty" }],
            outbound: [{ source: "lineNo", target: "lineNo" }, { source: "sku", target: "sku" }, { source: "qty", target: "qty" }],
          },
        ],
        identityFields: ["lineNo"],
      }],
      conflict: { strategy: "lww" },
      readTimeoutMs: 30_000,
    };
    const engine = new SyncEngine(config, db);
    await engine.ingest("lines", "erp");
    expect(inserts).toHaveLength(2); // L01 and L02
  });
});

// ─── AC1: Round-trip collapse ─────────────────────────────────────────────────

function makeSingleLevelConfig(erpConn: Connector, shopConn: Connector): ResolvedConfig {
  return {
    connectors: [
      { id: "erp", connector: erpConn, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      { id: "shop", connector: shopConn, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
    ],
    channels: [{
      id: "order-lines",
      members: [
        {
          connectorId: "erp",
          entity: "order_lines",
          sourceEntity: "orders",
          arrayPath: "lines",
          elementKey: "lineNo",
          expansionChain: [{ arrayPath: "lines", elementKey: "lineNo" }],
          inbound: [{ source: "lineNo", target: "lineNo" }, { source: "sku", target: "sku" }, { source: "qty", target: "qty" }, { source: "price", target: "price" }],
          outbound: [{ source: "lineNo", target: "lineNo" }, { source: "sku", target: "sku" }, { source: "qty", target: "qty" }, { source: "price", target: "price" }],
        },
        {
          connectorId: "shop",
          entity: "lineItems",
          inbound: [{ source: "lineNo", target: "lineNo" }, { source: "sku", target: "sku" }, { source: "quantity", target: "qty" }, { source: "unitPrice", target: "price" }],
          outbound: [{ source: "lineNo", target: "lineNo" }, { source: "sku", target: "sku" }, { source: "qty", target: "quantity" }, { source: "price", target: "unitPrice" }],
        },
      ],
      identityFields: ["lineNo"],
    }],
    conflict: { strategy: "lww" },
    readTimeoutMs: 30_000,
  };
}

describe("AC1: round-trip — forward expand then collapse patches correct slot", () => {
  it("editing a flat shop lineItem writes the change back into the correct ERP order slot", async () => {
    const orders = [
      { id: "ord1", lines: [{ lineNo: "L01", sku: "SKU-A", qty: 5, price: 10 }, { lineNo: "L02", sku: "SKU-B", qty: 2, price: 20 }] },
    ];
    const { connector: erpConn, writtenUpdates } = makeSimpleOrderConnector(orders);

    // Forward pass: populate flat shop lineItems
    const { connector: shopConn, records: shopRecords } = makeFlatLineConnector([]);
    const db = makeDb();
    const engine = new SyncEngine(makeSingleLevelConfig(erpConn, shopConn), db);

    await engine.ingest("order-lines", "erp");

    // Shop now has li-1 (L01) and li-2 (L02)
    expect(shopRecords.size).toBe(2);

    // Simulate a shop edit: change L01 quantity to 99
    const [li1Id] = Array.from(shopRecords.keys());
    shopRecords.set(li1Id!, { lineNo: "L01", sku: "SKU-A", quantity: 99, unitPrice: 10 });

    // Reverse pass: shop ingests its updated lineItem, engine collapses to ERP
    await engine.ingest("order-lines", "shop");

    // ERP order should have been updated with qty=99 for L01
    expect(writtenUpdates.length).toBeGreaterThan(0);
    const updatedOrder = writtenUpdates[writtenUpdates.length - 1]!;
    const updatedLines = (updatedOrder.data as { lines: Array<{ lineNo: string; qty: number }> }).lines;
    const l01 = updatedLines.find((l) => l.lineNo === "L01");
    expect(l01?.qty).toBe(99);
    // L02 should be unchanged
    const l02 = updatedLines.find((l) => l.lineNo === "L02");
    expect(l02?.qty).toBe(2);
  });
});

// ─── AC2: Per-parent batching ─────────────────────────────────────────────────

describe("AC2: two lines updated in one poll → single parent write", () => {
  it("writes the parent only once when two child elements change together", async () => {
    const orders = [
      { id: "ord1", lines: [{ lineNo: "L01", sku: "A", qty: 1, price: 5 }, { lineNo: "L02", sku: "B", qty: 2, price: 10 }] },
    ];
    const { connector: erpConn, writtenUpdates } = makeSimpleOrderConnector(orders);
    const { connector: shopConn, records: shopRecords } = makeFlatLineConnector([]);
    const db = makeDb();
    const engine = new SyncEngine(makeSingleLevelConfig(erpConn, shopConn), db);

    // Forward pass
    await engine.ingest("order-lines", "erp");
    expect(shopRecords.size).toBe(2);

    // Edit BOTH lines in the shop
    const shopIds = Array.from(shopRecords.keys());
    shopRecords.set(shopIds[0]!, { lineNo: "L01", sku: "A", quantity: 10, unitPrice: 5 });
    shopRecords.set(shopIds[1]!, { lineNo: "L02", sku: "B", quantity: 20, unitPrice: 10 });

    writtenUpdates.length = 0; // reset counter
    await engine.ingest("order-lines", "shop");

    // Should be exactly one parent write for ord1 (not two)
    expect(writtenUpdates).toHaveLength(1);
  });
});

// ─── AC3: Unknown child skipped ───────────────────────────────────────────────

describe("AC3: unknown child → skip with no error", () => {
  it("records in the flat connector not from forward expansion produce skip results", async () => {
    const orders: Array<{ id: string; lines: Array<{ lineNo: string; sku: string; qty: number; price: number }> }> = [];
    const { connector: erpConn } = makeSimpleOrderConnector(orders);
    const { connector: shopConn } = makeFlatLineConnector([
      { id: "li-orphan", data: { lineNo: "L99", sku: "X", quantity: 1, unitPrice: 1 } },
    ]);
    const db = makeDb();
    const engine = new SyncEngine(makeSingleLevelConfig(erpConn, shopConn), db);

    // No forward pass — shop has a record that was never seeded from ERP
    const result = await engine.ingest("order-lines", "shop");

    expect(result.records.some((r) => r.action === "error")).toBe(false);
  });
});

// ─── AC4: collectOnly + discover ─────────────────────────────────────────────

describe("AC4: collectOnly expansion enables discover() to match against flat side", () => {
  it("child shadows stored during collectOnly allow discover() to find matches", async () => {
    const orders = [
      { id: "ord1", lines: [{ lineNo: "L01", sku: "SKU-A", qty: 5, price: 10 }] },
    ];
    const { connector: erpConn } = makeSimpleOrderConnector(orders);
    const { connector: shopConn } = makeFlatLineConnector([
      { id: "li1", data: { lineNo: "L01", sku: "SKU-A", quantity: 5, unitPrice: 10 } },
    ]);
    const db = makeDb();
    const engine = new SyncEngine(makeSingleLevelConfig(erpConn, shopConn), db);

    const erpCollect = await engine.ingest("order-lines", "erp", { collectOnly: true });
    await engine.ingest("order-lines", "shop", { collectOnly: true });

    const report = await engine.discover("order-lines", erpCollect.snapshotAt);

    // The lineNo="L01" record from ERP-expanded and shop-flat should match
    expect(report.matched.length).toBeGreaterThan(0);
  });
});

// ─── AC5: Partial patch ───────────────────────────────────────────────────────

describe("AC5: partial patch — only mapped fields overwritten", () => {
  it("element fields not in the mapping are preserved after collapse", async () => {
    const orders = [
      { id: "ord1", lines: [{ lineNo: "L01", sku: "SKU-A", qty: 5, price: 10, notes: "special" }] },
    ];
    const { connector: erpConn, writtenUpdates } = makeSimpleOrderConnector(orders, { notes: "special" });
    const { connector: shopConn, records: shopRecords } = makeFlatLineConnector([]);
    const db = makeDb();
    const engine = new SyncEngine(makeSingleLevelConfig(erpConn, shopConn), db);

    await engine.ingest("order-lines", "erp");

    const [li1Id] = Array.from(shopRecords.keys());
    shopRecords.set(li1Id!, { lineNo: "L01", sku: "SKU-A", quantity: 99, unitPrice: 10 });

    await engine.ingest("order-lines", "shop");

    const lastUpdate = writtenUpdates[writtenUpdates.length - 1]!;
    const updatedLines = (lastUpdate.data as { lines: Array<{ lineNo: string; qty: number; notes: string }> }).lines;
    const l01 = updatedLines.find((l) => l.lineNo === "L01");

    // qty was mapped → updated
    expect(l01?.qty).toBe(99);
    // notes was NOT in the mapping → preserved
    expect(l01?.notes).toBe("special");
  });
});

// ─── AC6: Multi-level collapse ────────────────────────────────────────────────

describe("AC6: two-level collapse writes back grandchild change to root parent", () => {
  it("editing a flat warehouse component collapses back through lines into the ERP order", async () => {
    const orders = JSON.parse(JSON.stringify([
      {
        id: "ord1", orderRef: "ORD-1001",
        lines: [
          { lineNo: "L01", sku: "SKU-A", qty: 5, price: 10, components: [{ compNo: "C01", partSku: "P1", qty: 2 }, { compNo: "C02", partSku: "P2", qty: 3 }] },
        ],
      },
    ])) as NestedOrder[];
    const { connector: erpConn, writtenUpdates } = makeNestedErpConnector(orders);
    const { connector: warehouseConn, records: whRecords } = makeFlatComponentConnector([]);
    const db = makeDb();
    const engine = new SyncEngine(makeTwoLevelConfig(erpConn, warehouseConn), db);

    // Forward pass: populate warehouse
    await engine.ingest("line-components", "erp");
    expect(whRecords.size).toBeGreaterThan(0);

    // Edit C01 in warehouse: change qty to 99
    const [whId] = Array.from(whRecords.entries()).find(([, d]) => (d as Record<string, unknown>)["compNo"] === "C01") ?? [];
    if (!whId) throw new Error("test setup: C01 not found in warehouse");
    whRecords.set(whId, { compNo: "C01", partSku: "P1", qty: 99 });

    writtenUpdates.length = 0;
    await engine.ingest("line-components", "warehouse");

    // ERP order should be written back with C01.qty = 99
    expect(writtenUpdates.length).toBeGreaterThan(0);
    const updated = writtenUpdates[writtenUpdates.length - 1]!;
    const lines = (updated.data as { lines: Array<{ lineNo: string; components: Array<{ compNo: string; qty: number }> }> }).lines;
    const l01 = lines.find((l) => l.lineNo === "L01");
    const c01 = l01?.components.find((c) => c.compNo === "C01");
    expect(c01?.qty).toBe(99);
    // C02 should be unchanged
    const c02 = l01?.components.find((c) => c.compNo === "C02");
    expect(c02?.qty).toBe(3);
  });
});

// ─── EF1: forward filter skips elements ──────────────────────────────────────

describe("EF1: elementFilter skips elements that do not match", () => {
  it("only elements matching the filter are dispatched to the flat connector", async () => {
    const orders = [
      {
        id: "ord1",
        lines: [
          { lineNo: "L01", sku: "A", qty: 1, price: 5, type: "product" },
          { lineNo: "L02", sku: "B", qty: 2, price: 10, type: "service" },
          { lineNo: "L03", sku: "C", qty: 3, price: 15, type: "product" },
        ],
      },
    ];
    const erpConnector: Connector = {
      metadata: { name: "erp-filter-test", version: "0.0.1", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "orders",
          async *read(): AsyncIterable<ReadBatch> {
            yield { records: orders.map((o) => ({ id: o.id, data: { lines: o.lines } })), since: "ts-1" };
          },
        }];
      },
    };
    const { connector: shopConn, inserts } = makeFlatComponentConnector([]);
    const db = makeDb();
    const config: ResolvedConfig = {
      connectors: [
        { id: "erp", connector: erpConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "shop", connector: shopConn, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels: [{
        id: "product-lines",
        members: [
          {
            connectorId: "erp",
            entity: "order_lines",
            sourceEntity: "orders",
            arrayPath: "lines",
            elementKey: "lineNo",
            expansionChain: [{ arrayPath: "lines", elementKey: "lineNo" }],
            inbound: [{ source: "lineNo", target: "lineNo" }, { source: "sku", target: "sku" }, { source: "qty", target: "qty" }],
            outbound: [{ source: "lineNo", target: "lineNo" }, { source: "sku", target: "sku" }, { source: "qty", target: "qty" }],
            elementFilter: (el) => (el as Record<string, unknown>)["type"] === "product",
          },
          {
            connectorId: "shop",
            entity: "components",
            inbound: [{ source: "lineNo", target: "lineNo" }, { source: "sku", target: "sku" }, { source: "qty", target: "qty" }],
            outbound: [{ source: "lineNo", target: "lineNo" }, { source: "sku", target: "sku" }, { source: "qty", target: "qty" }],
          },
        ],
        identityFields: ["lineNo"],
      }],
      conflict: { strategy: "lww" },
      readTimeoutMs: 30_000,
    };

    const engine = new SyncEngine(config, db);
    await engine.ingest("product-lines", "erp");

    // Only L01 and L03 (type=product) should be dispatched; L02 (service) skipped
    expect(inserts).toHaveLength(2);
    const skus = inserts.map((r) => (r as Record<string, unknown>)["sku"]);
    expect(skus).toContain("A");
    expect(skus).toContain("C");
    expect(skus).not.toContain("B");
  });
});

// ─── EF2: reverse_filter skips patch on mismatch ─────────────────────────────

describe("EF2: elementReverseFilter blocks patches when it returns false", () => {
  it("no ERP updates when reverse_filter always returns false", async () => {
    const orders = [
      { id: "ord1", lines: [{ lineNo: "L01", sku: "A", qty: 5, price: 10 }] },
    ];
    const { connector: erpConn, writtenUpdates } = makeSimpleOrderConnector(orders);
    const { connector: shopConn, records: shopRecords } = makeFlatLineConnector([]);
    const db = makeDb();

    const config: ResolvedConfig = {
      connectors: [
        { id: "erp", connector: erpConn, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "shop", connector: shopConn, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels: [{
        id: "order-lines-ef2",
        members: [
          {
            connectorId: "erp",
            entity: "order_lines",
            sourceEntity: "orders",
            arrayPath: "lines",
            elementKey: "lineNo",
            expansionChain: [{ arrayPath: "lines", elementKey: "lineNo" }],
            inbound: [{ source: "lineNo", target: "lineNo" }, { source: "qty", target: "qty" }],
            outbound: [{ source: "lineNo", target: "lineNo" }, { source: "qty", target: "qty" }],
            // reverse_filter always returns false — no write-back ever
            elementReverseFilter: () => false,
          },
          {
            connectorId: "shop",
            entity: "lineItems",
            inbound: [{ source: "lineNo", target: "lineNo" }, { source: "quantity", target: "qty" }],
            outbound: [{ source: "lineNo", target: "lineNo" }, { source: "qty", target: "quantity" }],
          },
        ],
        identityFields: ["lineNo"],
      }],
      conflict: { strategy: "lww" },
      readTimeoutMs: 30_000,
    };

    const engine = new SyncEngine(config, db);
    await engine.ingest("order-lines-ef2", "erp");
    expect(shopRecords.size).toBe(1);

    // Shop edits the line
    const [shopId] = Array.from(shopRecords.keys());
    shopRecords.set(shopId!, { lineNo: "L01", quantity: 99 });

    writtenUpdates.length = 0;
    await engine.ingest("order-lines-ef2", "shop");

    // reverse_filter returned false — no update dispatched to ERP
    expect(writtenUpdates).toHaveLength(0);
  });
});

// ─── EF3: loadConfig compiles filter / reverse_filter from YAML ──────────────

describe("EF3: loadConfig compiles filter and reverse_filter strings", () => {
  it("compiled elementFilter is a function that evaluates the expression", async () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, `
mappings:
  - name: erp_orders
    connector: erp
    channel: product-lines
    entity: orders
    fields: []
  - name: erp_lines
    channel: product-lines
    parent: erp_orders
    array_path: lines
    element_key: lineNo
    filter: "element.type === 'product'"
    reverse_filter: "element.type === 'product'"
    fields: []
  - connector: warehouse
    channel: product-lines
    entity: components
    fields: []
`);
      const config = await loadConfig(dir);
      const ch = config.channels.find((c) => c.id === "product-lines");
      const erpMember = ch?.members.find((m) => m.connectorId === "erp");

      expect(typeof erpMember?.elementFilter).toBe("function");
      expect(typeof erpMember?.elementReverseFilter).toBe("function");

      // Evaluate the compiled predicates
      expect(erpMember?.elementFilter!({ type: "product" }, {}, 0)).toBe(true);
      expect(erpMember?.elementFilter!({ type: "service" }, {}, 0)).toBe(false);
      expect(erpMember?.elementReverseFilter!({ type: "product" }, {}, 0)).toBe(true);
      expect(erpMember?.elementReverseFilter!({ type: "service" }, {}, 0)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws at load time for an invalid filter expression", async () => {
    const dir = makeTmpDir();
    try {
      writeConfig(dir, `
mappings:
  - name: erp_orders
    connector: erp
    channel: product-lines
    entity: orders
    fields: []
  - name: erp_lines
    channel: product-lines
    parent: erp_orders
    array_path: lines
    element_key: lineNo
    filter: "element.type ==="
    fields: []
  - connector: warehouse
    channel: product-lines
    entity: components
    fields: []
`);
      await expect(loadConfig(dir)).rejects.toThrow(/filter.*compile|compile.*filter/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
