/**
 * packages/engine/src/nested-array.test.ts
 *
 * Integration tests for nested array expansion.
 * Spec: specs/field-mapping.md §3.2
 * Plans: PLAN_NESTED_ARRAY_PIPELINE.md, PLAN_CROSS_CHANNEL_EXPANSION.md
 *
 * NA1  Same-channel expansion: ERP orders → expanded lines dispatched to flat CRM target
 * NA2  Parent orders shadow written; child source shadow also written (for cluster view)
 * NA3  Parent echo detection: unchanged order skips all child expansion
 * NA4  Element-level noop: only changed elements re-dispatched (via written_state)
 * NA5  Deterministic canonical IDs: same input → same child canonical UUID
 * NA6  empty lines array produces no child dispatches
 * NA7  Cross-channel: child member reads from parent entity via sourceEntity
 * NA8  Cross-channel watermarks advance independently
 * NA9  Config validation: parent reference to unknown name → throws
 * NA10 Config validation: array_path omitted when parent set → throws
 * NA11 getChannelIdentityMap returns source-connector slot for array children
 * NA12 _resolveCanonical finds canonical across different entity names in same channel
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
import {
  SyncEngine,
  type ResolvedConfig,
  openDb,
} from "./index.js";
import { loadConfig } from "./config/loader.js";
import type { Db } from "./db/index.js";
import { deriveChildCanonicalId } from "./core/array-expander.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Db {
  return openDb(":memory:");
}

// ─── In-memory ERP connector ──────────────────────────────────────────────────
// Provides "orders" entity with embedded "lines" arrays

type Order = { id: string; customerId: string; total: number; lines: Line[] };
type Line  = { lineNo: string; sku: string; qty: number; price: number };

function makeErpConnector(orders: Order[]): Connector {
  return {
    metadata: {
      name: "test-erp",
      version: "0.0.1",
      auth: { type: "none" },
    },
    getEntities(): EntityDefinition[] {
      return [
        {
          name: "orders",
          async *read(_ctx: ConnectorContext, _since?: string): AsyncIterable<ReadBatch> {
            yield {
              records: orders.map((o) => ({
                id: o.id,
                data: {
                  customerId: o.customerId,
                  total: o.total,
                  lines: o.lines.map((l) => ({ lineNo: l.lineNo, sku: l.sku, qty: l.qty, price: l.price })),
                },
              })),
              since: "ts-1",
            };
          },
        },
      ];
    },
  };
}

// ─── In-memory flat CRM connector ────────────────────────────────────────────
// Provides "line_items" entity with individual flat records (no arrays)

function makeLineTarget(): {
  connector: Connector;
  inserts: Record<string, unknown>[];
  updates: Record<string, unknown>[];
  records: Map<string, Record<string, unknown>>;
} {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const records = new Map<string, Record<string, unknown>>();
  let nextId = 1;

  const connector: Connector = {
    metadata: {
      name: "test-crm",
      version: "0.0.1",
      auth: { type: "none" },
    },
    getEntities(): EntityDefinition[] {
      return [
        {
          name: "line_items",
          async *insert(
            batch: AsyncIterable<InsertRecord>,
            _ctx: ConnectorContext,
          ): AsyncIterable<InsertResult> {
            for await (const rec of batch) {
              const id = String(nextId++);
              records.set(id, rec.data as Record<string, unknown>);
              inserts.push(rec.data as Record<string, unknown>);
              yield { id };
            }
          },
          async *update(
            batch: AsyncIterable<UpdateRecord>,
            _ctx: ConnectorContext,
          ): AsyncIterable<UpdateResult> {
            for await (const rec of batch) {
              records.set(rec.id, rec.data as Record<string, unknown>);
              updates.push({ ...rec.data as Record<string, unknown>, _id: rec.id });
              yield { id: rec.id };
            }
          },
        },
      ];
    },
  };

  return { connector, inserts, updates, records };
}

// ─── Config helpers ────────────────────────────────────────────────────────────

function makeArrayConfig(erpConnector: Connector, crmConnector: Connector): ResolvedConfig {
  return {
    connectors: [
      {
        id: "erp",
        connector: erpConnector,
        config: {},
        auth: {},
        batchIdRef: { current: undefined },
        triggerRef: { current: undefined },
      },
      {
        id: "crm",
        connector: crmConnector,
        config: {},
        auth: {},
        batchIdRef: { current: undefined },
        triggerRef: { current: undefined },
      },
    ],
    channels: [
      {
        id: "order-lines",
        members: [
          {
            connectorId: "erp",
            entity: "order_lines",      // logical entity name
            sourceEntity: "orders",     // inherited read source
            arrayPath: "lines",
            parentMappingName: "erp_orders",
            elementKey: "lineNo",
            inbound: [
              { source: "lineNo",  target: "lineNumber" },
              { source: "sku",     target: "sku" },
              { source: "qty",     target: "quantity" },
              { source: "orderId", target: "orderId" },
            ],
            outbound: [
              { source: "lineNo",  target: "lineNumber" },
              { source: "sku",     target: "sku" },
              { source: "qty",     target: "quantity" },
              { source: "orderId", target: "orderId" },
            ],
            parentFields: { orderId: "customerId" }, // bring customerId into child scope as orderId
          },
          {
            connectorId: "crm",
            entity: "line_items",
            inbound: [
              { source: "lineNumber", target: "lineNumber" },
              { source: "sku",        target: "sku" },
              { source: "quantity",   target: "quantity" },
              { source: "orderId",    target: "orderId" },
            ],
            outbound: [
              { source: "lineNumber", target: "lineNumber" },
              { source: "sku",        target: "sku" },
              { source: "quantity",   target: "quantity" },
              { source: "orderId",    target: "orderId" },
            ],
          },
        ],
      },
    ],
    conflict: {},
    readTimeoutMs: 10_000,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Nested array expansion — integration", () => {
  it("NA1 — same-channel expansion dispatches each element to flat target", async () => {
    const orders: Order[] = [
      {
        id: "order-1",
        customerId: "cust-A",
        total: 100,
        lines: [
          { lineNo: "L01", sku: "SKU-X", qty: 2,  price: 25 },
          { lineNo: "L02", sku: "SKU-Y", qty: 1,  price: 50 },
        ],
      },
    ];
    const crm = makeLineTarget();
    const config = makeArrayConfig(makeErpConnector(orders), crm.connector);
    const engine = new SyncEngine(config, makeDb());

    const result = await engine.ingest("order-lines", "erp");
    expect(result.records.some((r) => r.action === "insert")).toBe(true);
    // Both lines inserted into CRM
    expect(crm.inserts).toHaveLength(2);
    const skus = crm.inserts.map((r) => r["sku"]).sort();
    expect(skus).toEqual(["SKU-X", "SKU-Y"]);
  });

  it("NA2 — parent orders shadow written; child source shadow also written for cluster view", async () => {
    const orders: Order[] = [
      { id: "order-1", customerId: "cust-A", total: 100, lines: [{ lineNo: "L01", sku: "A", qty: 1, price: 10 }] },
    ];
    const crm = makeLineTarget();
    const config = makeArrayConfig(makeErpConnector(orders), crm.connector);
    const db = makeDb();
    const engine = new SyncEngine(config, db);

    await engine.ingest("order-lines", "erp");

    // Parent shadow exists with source entity "orders"
    const parentRow = db.prepare<{ n: number }>(
      "SELECT COUNT(*) as n FROM shadow_state WHERE connector_id = 'erp' AND entity_name = 'orders' AND external_id = 'order-1'",
    ).get();
    expect(parentRow?.n).toBe(1);

    // Child source shadow IS written (entity = order_lines, connector = erp).
    // This enables getChannelIdentityMap to return a non-null slot for the
    // array-source member so the playground cluster view renders webshop cards.
    const childRow = db.prepare<{ n: number }>(
      "SELECT COUNT(*) as n FROM shadow_state WHERE connector_id = 'erp' AND entity_name = 'order_lines'",
    ).get();
    expect(childRow?.n).toBe(1);
  });

  it("NA3 — parent echo detection: unchanged order skips all child expansion", async () => {
    const orders: Order[] = [
      { id: "order-1", customerId: "cust-A", total: 100, lines: [{ lineNo: "L01", sku: "A", qty: 1, price: 10 }] },
    ];
    const crm = makeLineTarget();
    const config = makeArrayConfig(makeErpConnector(orders), crm.connector);
    const engine = new SyncEngine(config, makeDb());

    // First ingest: inserts
    await engine.ingest("order-lines", "erp");
    expect(crm.inserts).toHaveLength(1);

    // Second ingest with no changes: parent echo detection should skip everything
    const result2 = await engine.ingest("order-lines", "erp");
    expect(crm.inserts).toHaveLength(1); // no new inserts
    expect(result2.records.some((r) => r.action === "skip")).toBe(true);
  });

  it("NA4 — element-level noop: only changed elements re-dispatched", async () => {
    // First ingest: 2 lines
    const orders1: Order[] = [
      {
        id: "order-1",
        customerId: "cust-A",
        total: 100,
        lines: [
          { lineNo: "L01", sku: "A", qty: 1, price: 10 },
          { lineNo: "L02", sku: "B", qty: 2, price: 20 },
        ],
      },
    ];
    const crm = makeLineTarget();
    const config = makeArrayConfig(makeErpConnector(orders1), crm.connector);
    const engine = new SyncEngine(config, makeDb());
    await engine.ingest("order-lines", "erp");
    expect(crm.inserts).toHaveLength(2);

    // Second ingest with one line changed
    const orders2: Order[] = [
      {
        id: "order-1",
        customerId: "cust-A",
        total: 100,
        lines: [
          { lineNo: "L01", sku: "A", qty: 1,  price: 10 },  // unchanged
          { lineNo: "L02", sku: "B", qty: 99, price: 20 },  // qty changed
        ],
      },
    ];
    // Swap in updated data by rebuilding the engine with new connector
    const crm2 = makeLineTarget();
    const config2 = makeArrayConfig(makeErpConnector(orders2), crm2.connector);
    const engine2 = new SyncEngine(config2, (engine as unknown as { db: Db }).db);
    const result2 = await engine2.ingest("order-lines", "erp");

    // Only the changed line should be dispatched (L02 qty=99)
    // L01 should be suppressed by written_state
    const updates = result2.records.filter((r) => r.action === "update");
    expect(updates).toHaveLength(1);
  });

  it("NA5 — deterministic canonical IDs: same parent + element key → same child canonical", async () => {
    const parentCanonId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const id1 = deriveChildCanonicalId(parentCanonId, "lines", "L01");
    const id2 = deriveChildCanonicalId(parentCanonId, "lines", "L01");
    expect(id1).toBe(id2);
    // Version nibble should be 5 (UUID v5 style)
    expect(id1.charAt(14)).toBe("5");
  });

  it("NA6 — empty lines array produces no child dispatches", async () => {
    const orders: Order[] = [
      { id: "order-1", customerId: "cust-A", total: 0, lines: [] },
    ];
    const crm = makeLineTarget();
    const config = makeArrayConfig(makeErpConnector(orders), crm.connector);
    const engine = new SyncEngine(config, makeDb());

    const result = await engine.ingest("order-lines", "erp");
    expect(crm.inserts).toHaveLength(0);
    // READ result emitted for parent record (even if no children)
    expect(result.records.some((r) => r.action === "read")).toBe(true);
  });

  it("NA7 — cross-channel: child member reads from sourceEntity (parent entity)", async () => {
    // Build a config where the child member has sourceEntity = 'orders'
    // and the channel only has the child (cross-channel pattern)
    const orders: Order[] = [
      { id: "order-1", customerId: "c1", total: 50, lines: [{ lineNo: "L01", sku: "X", qty: 3, price: 15 }] },
    ];
    const crm = makeLineTarget();
    // makeArrayConfig already sets sourceEntity = 'orders' on the ERP member
    const config = makeArrayConfig(makeErpConnector(orders), crm.connector);
    const engine = new SyncEngine(config, makeDb());

    // Verify: the engine reads using sourceEntity ('orders'), not entity ('order_lines')
    // Orders entity IS registered in the connector, so reading should succeed
    const result = await engine.ingest("order-lines", "erp");
    expect(result.records.some((r) => r.action !== "error")).toBe(true);
    expect(crm.inserts).toHaveLength(1);
    expect(crm.inserts[0]?.["sku"]).toBe("X");
  });

  it("NA8 — watermark stored for logical entity name (order_lines), not source entity (orders)", async () => {
    const orders: Order[] = [
      { id: "order-1", customerId: "c1", total: 50, lines: [{ lineNo: "L01", sku: "X", qty: 1, price: 10 }] },
    ];
    const crm = makeLineTarget();
    const config = makeArrayConfig(makeErpConnector(orders), crm.connector);
    const db = makeDb();
    const engine = new SyncEngine(config, db);
    await engine.ingest("order-lines", "erp");

    // Watermark should be for (erp, order_lines) since that is the logical entity name
    const row = db.prepare<{ since: string }>(
      "SELECT since FROM watermarks WHERE connector_id = 'erp' AND entity_name = 'order_lines'",
    ).get();
    expect(row?.since).toBe("ts-1");

    // No watermark for (erp, orders) specifically from this channel
    // (it might be absent since the parent is a source descriptor)
    // Just verify order_lines watermark exists
    expect(row).toBeTruthy();
  });

  it("NA9 — config validation rejects parent referencing unknown mapping name", async () => {
    const dir = join(tmpdir(), `opensync-test-${Date.now()}`);
    mkdirSync(join(dir, "mappings"), { recursive: true });
    writeFileSync(join(dir, "opensync.json"), JSON.stringify({
      connectors: { erp: { plugin: "./fake.ts", config: {} } },
    }));
    writeFileSync(join(dir, "mappings", "orders.yaml"), [
      "mappings:",
      "  - channel: order-lines",
      "    parent: nonexistent_name",   // references unknown parent
      "    array_path: lines",
    ].join("\n"));

    await expect(loadConfig(dir)).rejects.toThrow(/unknown parent/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("NA11 — getChannelIdentityMap returns source-connector slot for array children", async () => {
    // Regression guard: when an array-source member (erp) expands its children,
    // the source connector's external IDs must be recorded in identity_map so that
    // getChannelIdentityMap() returns a non-null slot — enabling the playground
    // cluster view to render source-side record cards.
    const orders: Order[] = [
      {
        id: "order-1",
        customerId: "cust-A",
        total: 100,
        lines: [
          { lineNo: "L01", sku: "A", qty: 1, price: 10 },
          { lineNo: "L02", sku: "B", qty: 2, price: 20 },
        ],
      },
    ];
    const crm = makeLineTarget();
    const config = makeArrayConfig(makeErpConnector(orders), crm.connector);
    const engine = new SyncEngine(config, makeDb());

    await engine.ingest("order-lines", "erp");

    const identityMap = engine.getChannelIdentityMap("order-lines");
    // Both child elements must appear as canonical clusters
    expect(identityMap.size).toBe(2);
    for (const [, linkedMap] of identityMap) {
      // Source connector (erp) must be present alongside the target (crm)
      expect(linkedMap.has("erp")).toBe(true);
      expect(linkedMap.has("crm")).toBe(true);
      // Source external ID must follow the derived child-ID format
      const erpId = linkedMap.get("erp")!;
      expect(erpId).toMatch(/^order-1#lines\[L0[12]\]$/);
    }
  });

  it("NA10 — config validation rejects child with parent but no array_path", async () => {
    const dir = join(tmpdir(), `opensync-test-${Date.now()}`);
    mkdirSync(join(dir, "mappings"), { recursive: true });
    writeFileSync(join(dir, "opensync.json"), JSON.stringify({
      connectors: { erp: { plugin: "./fake.ts", config: {} } },
    }));
    writeFileSync(join(dir, "mappings", "orders.yaml"), [
      "mappings:",
      "  - name: erp_orders",
      "    connector: erp",
      "    channel: order-lines",
      "    entity: orders",
      "  - channel: order-lines",
      "    parent: erp_orders",
      // array_path deliberately omitted
    ].join("\n"));

    await expect(loadConfig(dir)).rejects.toThrow(/array_path/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("NA12 — _resolveCanonical finds canonical across different entity names in same channel", async () => {
    // Regression guard: when the array-source member uses entity "order_lines" and the flat
    // member uses "line_items", a flat record from the second connector must be identity-linked
    // to the canonical created by the first connector's expansion.
    //
    // Without the fix: dbFindCanonicalByGroup searches entity_name = 'line_items' only,
    // missing the ERP shadow row stored as entity_name = 'order_lines' → creates a spurious
    // unlinked canonical for the CRM record.
    //
    // With the fix: _resolveCanonical searches all other channel member entity names
    // (["line_items", "order_lines"]) and finds the ERP canonical correctly.
    const orders: Order[] = [
      {
        id: "order-1",
        customerId: "cust-A",
        total: 100,
        lines: [{ lineNo: "L01", sku: "SKU-X", qty: 2, price: 25 }],
      },
    ];

    // CRM connector: read-only (no insert) so that expansion cannot auto-insert a CRM record.
    // This forces CRM records to be identity-matched via _resolveCanonical on CRM ingest.
    const crmRecords: ReadRecord[] = [
      // Pre-existing CRM record matching ERP child via identity fields
      { id: "crm-pre", data: { lineNumber: "L01", sku: "SKU-X", quantity: 2, orderId: "cust-A" } },
    ];
    const crmConnector: Connector = {
      metadata: { name: "test-crm-na12", version: "0.0.1", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [
          {
            name: "line_items",
            async *read(_ctx: ConnectorContext, _since?: string): AsyncIterable<ReadBatch> {
              yield { records: crmRecords, since: "ts-1" };
            },
            // No insert() — forces identity resolution rather than auto-insert
          },
        ];
      },
    };

    const config: ResolvedConfig = {
      connectors: [
        { id: "erp", connector: makeErpConnector(orders), config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "crm", connector: crmConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels: [
        {
          id: "order-lines",
          // Compound identity group: both fields must match simultaneously.
          identity: [{ fields: ["lineNumber", "sku"] }],
          members: makeArrayConfig(makeErpConnector(orders), crmConnector).channels[0]!.members,
        },
      ],
      conflict: {},
      readTimeoutMs: 10_000,
    };

    const db = makeDb();
    const engine = new SyncEngine(config, db);

    // Expand from ERP: creates CCAN_L01 linked to erp.  CRM insert is skipped (no insert()).
    await engine.ingest("order-lines", "erp");

    // ERP child canonical is linked only to erp at this point
    const identityMap1 = engine.getChannelIdentityMap("order-lines");
    expect(identityMap1.size).toBe(1);
    const [ccanL01, linked1] = [...identityMap1][0]!;
    expect(linked1.has("erp")).toBe(true);
    expect(linked1.has("crm")).toBe(false); // no CRM record yet (insert was skipped)

    // Ingest CRM: identity match should bridge crm-pre → CCAN_L01.
    // _resolveCanonical must search both "line_items" AND "order_lines" entity names.
    await engine.ingest("order-lines", "crm");

    const identityMap2 = engine.getChannelIdentityMap("order-lines");
    // Still one cluster, now with both connectors linked
    expect(identityMap2.size).toBe(1);
    const [, linked2] = [...identityMap2][0]!;
    expect(linked2.has("erp")).toBe(true);
    // The CRM pre-existing record should now be linked to the same canonical as ERP
    expect(linked2.has("crm")).toBe(true);
    expect(linked2.get("crm")).toBe("crm-pre");
    // Confirm it's the same canonical that was created by ERP expansion
    const [ccanAfter] = [...identityMap2][0]!;
    expect(ccanAfter).toBe(ccanL01);
  });
});
