/**
 * packages/engine/src/array-element-associations.test.ts
 *
 * Integration tests for association extraction from array-expanded child elements.
 * Spec: specs/associations.md §9
 * Plans: PLAN_ARRAY_ELEMENT_ASSOCIATIONS.md
 *
 * AEA1  Schema-based element FK (Pass 2 via getArrayElementSchema): engine extracts
 *       an Association from a plain-string productId field that is annotated with
 *       entity in the source connector's EntityDefinition schema.
 * AEA2  element() factory: connector wraps an element with element({ data, id });
 *       the engine uses er.id as the element key (not the array index);
 *       normal expansion + association extraction still fire.
 * AEA4  Null FK value in element data → no Association extracted; element still
 *       expanded and dispatched normally.
 * AEA7  collectOnly path: child shadow row carries __assoc__ sentinel when the
 *       element has a FK field annotated in the schema.
 */

import { describe, it, expect } from "bun:test";
import type {
  Connector,
  ConnectorContext,
  EntityDefinition,
  FieldDescriptor,
  InsertRecord,
  InsertResult,
  ReadBatch,
  UpdateRecord,
  UpdateResult,
} from "@opensync/sdk";
import { element } from "@opensync/sdk";
import { SyncEngine, openDb, type ResolvedConfig } from "./index.js";
import type { Db } from "./db/index.js";
import type { ChannelMember } from "./config/loader.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeDb(): Db {
  return openDb(":memory:");
}

// ─── Connector factories ──────────────────────────────────────────────────────

type OrderLine = { lineNo: string; sku: string; productId?: string | null };
type Order = { id: string; lines: OrderLine[] };

/** ERP connector: orders with embedded lines; optional schema for the lines element type. */
function makeErpConnector(
  orders: Order[],
  elementSchema?: Record<string, FieldDescriptor>,
): Connector {
  const linesType: FieldDescriptor["type"] = {
    type: "array",
    items: elementSchema
      ? { type: "object", properties: elementSchema }
      : { type: "object" },
  };

  return {
    metadata: { name: "erp", version: "0.0.0", auth: { type: "none" } },
    getEntities(): EntityDefinition[] {
      return [
        {
          name: "orders",
          schema: { lines: { type: linesType } },
          async *read(_ctx: ConnectorContext, _since?: string): AsyncIterable<ReadBatch> {
            yield {
              records: orders.map((o) => ({
                id: o.id,
                data: { lines: o.lines.map((l) => ({ ...l })) },
              })),
              since: "ts-1",
            };
          },
        },
      ];
    },
  };
}

/** Same connector but wraps each line element with element() to override the key. */
function makeErpConnectorWithElementFactory(
  orders: Array<{ id: string; lines: Array<{ customKey: string; sku: string; productId?: string }> }>,
): Connector {
  return {
    metadata: { name: "erp", version: "0.0.0", auth: { type: "none" } },
    getEntities(): EntityDefinition[] {
      return [
        {
          name: "orders",
          async *read(): AsyncIterable<ReadBatch> {
            yield {
              records: orders.map((o) => ({
                id: o.id,
                data: {
                  lines: o.lines.map((l) =>
                    element({ data: { sku: l.sku, productId: l.productId }, id: l.customKey }),
                  ),
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

/** Minimal flat target that records inserts. */
function makeLineTarget(): { connector: Connector; inserts: InsertRecord[] } {
  const inserts: InsertRecord[] = [];
  const connector: Connector = {
    metadata: { name: "crm", version: "0.0.0", auth: { type: "none" } },
    getEntities(): EntityDefinition[] {
      return [
        {
          name: "line_items",
          async *read(): AsyncIterable<ReadBatch> {
            yield { records: [], since: "t0" };
          },
          async *insert(batch: AsyncIterable<InsertRecord>): AsyncIterable<InsertResult> {
            for await (const rec of batch) {
              inserts.push(rec);
              yield { id: crypto.randomUUID() };
            }
          },
          async *update(batch: AsyncIterable<UpdateRecord>): AsyncIterable<UpdateResult> {
            for await (const rec of batch) yield { id: rec.id };
          },
        },
      ];
    },
  };
  return { connector, inserts };
}

// ─── Config builder ───────────────────────────────────────────────────────────

function makeConfig(
  erpConnector: Connector,
  crmConnector: Connector,
  erpMemberOverride?: Partial<ChannelMember>,
): ResolvedConfig {
  const erpMember: ChannelMember = {
    connectorId: "erp",
    entity: "order_lines",
    sourceEntity: "orders",
    arrayPath: "lines",
    elementKey: "lineNo",
    expansionChain: [{ arrayPath: "lines", elementKey: "lineNo" }],
    inbound: [
      { source: "lineNo", target: "lineNo" },
      { source: "sku", target: "sku" },
      { source: "productId", target: "productId" },
    ],
    outbound: [
      { source: "lineNo", target: "lineNo" },
      { source: "sku", target: "sku" },
    ],
    ...erpMemberOverride,
  };

  return {
    connectors: [
      { id: "erp", connector: erpConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      { id: "crm", connector: crmConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
    ],
    channels: [
      {
        id: "order-lines",
        members: [
          erpMember,
          {
            connectorId: "crm",
            entity: "line_items",
            inbound: [
              { source: "lineNo", target: "lineNo" },
              { source: "sku", target: "sku" },
            ],
            outbound: [
              { source: "lineNo", target: "lineNo" },
              { source: "sku", target: "sku" },
            ],
          },
        ],
        identity: ["lineNo"],
      },
    ],
    conflict: {},
    readTimeoutMs: 10_000,
  };
}

// ─── AEA1: Schema-based element FK extracted via getArrayElementSchema ─────────

describe("AEA1: schema-annotated element FK extracted via getArrayElementSchema (Pass 2)", () => {
  it("child shadow carries __assoc__ sentinel for a plain-string productId with entity annotation", async () => {
    const orders: Order[] = [
      { id: "ord-1", lines: [{ lineNo: "L01", sku: "SKU-A", productId: "prod-101" }] },
    ];
    // Annotate the element schema: productId.entity = 'products'
    const elementSchema: Record<string, FieldDescriptor> = {
      lineNo: { type: "string" },
      sku: { type: "string" },
      productId: { type: "string", entity: "products" },
    };
    const erpConnector = makeErpConnector(orders, elementSchema);
    const { connector: crmConnector } = makeLineTarget();
    const db = makeDb();
    // The ERP member must have assocMappings for productId to be forwarded
    const erpMemberOverride: Partial<ChannelMember> = {
      assocMappings: [{ source: "productId", target: "productId" }],
    };
    const engine = new SyncEngine(makeConfig(erpConnector, crmConnector, erpMemberOverride), db);

    await engine.ingest("order-lines", "erp");

    // Verify child source shadow has __assoc__ sentinel
    const shadowRow = db
      .prepare<{ canonical_data: string }>(
        "SELECT canonical_data FROM shadow_state WHERE connector_id = 'erp' AND entity_name = 'order_lines'",
      )
      .get();
    expect(shadowRow).toBeDefined();
    const fd = JSON.parse(shadowRow!.canonical_data) as Record<string, { val: unknown }>;
    const assocSentinel = fd["__assoc__"]?.val;
    expect(typeof assocSentinel).toBe("string");
    const assocs = JSON.parse(assocSentinel as string) as Array<{ predicate: string; targetEntity: string; targetId: string }>;
    expect(assocs).toHaveLength(1);
    expect(assocs[0]!.predicate).toBe("productId");
    expect(assocs[0]!.targetEntity).toBe("products");
    expect(assocs[0]!.targetId).toBe("prod-101");
  });
});

// ─── AEA2: element() factory overrides the element key ────────────────────────

describe("AEA2: element() factory — connector overrides element key at runtime", () => {
  it("engine uses er.id as child external-ID suffix", async () => {
    const orders = [
      {
        id: "ord-2",
        lines: [
          { customKey: "line-custom-key", sku: "SKU-B", productId: "prod-202" },
        ],
      },
    ];
    const erpConnector = makeErpConnectorWithElementFactory(orders);
    const { connector: crmConnector } = makeLineTarget();
    // No elementKey on this config — engine falls back to er.id when factory is used
    const erpMemberOverride: Partial<ChannelMember> = {
      elementKey: undefined,
      expansionChain: [{ arrayPath: "lines" }],
    };
    const db = makeDb();
    const engine = new SyncEngine(makeConfig(erpConnector, crmConnector, erpMemberOverride), db);

    const result = await engine.ingest("order-lines", "erp");

    // The child external ID must contain 'line-custom-key', not '0'
    const insertResult = result.records.find((r) => r.action === "insert");
    expect(insertResult).toBeDefined();
    expect(insertResult!.sourceId).toContain("line-custom-key");
    expect(insertResult!.sourceId).not.toMatch(/#0$/);
  });
});

// ─── AEA4: Null FK value — no association but element still expanded ───────────

describe("AEA4: null FK value in element → no association; element still dispatched", () => {
  it("element with null productId is inserted without __assoc__ sentinel", async () => {
    const orders: Order[] = [
      { id: "ord-4", lines: [{ lineNo: "L01", sku: "SKU-C", productId: null }] },
    ];
    const elementSchema: Record<string, FieldDescriptor> = {
      lineNo: { type: "string" },
      sku: { type: "string" },
      productId: { type: "string", entity: "products" },
    };
    const erpConnector = makeErpConnector(orders, elementSchema);
    const { connector: crmConnector, inserts } = makeLineTarget();
    const erpMemberOverride: Partial<ChannelMember> = {
      assocMappings: [{ source: "productId", target: "productId" }],
    };
    const db = makeDb();
    const engine = new SyncEngine(makeConfig(erpConnector, crmConnector, erpMemberOverride), db);

    await engine.ingest("order-lines", "erp");

    // Element was dispatched
    expect(inserts).toHaveLength(1);

    // Child shadow exists but has no __assoc__ sentinel
    const shadowRow = db
      .prepare<{ canonical_data: string }>(
        "SELECT canonical_data FROM shadow_state WHERE connector_id = 'erp' AND entity_name = 'order_lines'",
      )
      .get();
    expect(shadowRow).toBeDefined();
    const fd = JSON.parse(shadowRow!.canonical_data) as Record<string, unknown>;
    expect(fd["__assoc__"]).toBeUndefined();
  });
});

// ─── AEA7: collectOnly path stores __assoc__ sentinel in child shadow ──────────

describe("AEA7: collectOnly path — child shadow includes __assoc__ sentinel", () => {
  it("after collectOnly ingest, child shadow has __assoc__ for elements with FK annotations", async () => {
    const orders: Order[] = [
      { id: "ord-7", lines: [{ lineNo: "L01", sku: "SKU-D", productId: "prod-701" }] },
    ];
    const elementSchema: Record<string, FieldDescriptor> = {
      lineNo: { type: "string" },
      sku: { type: "string" },
      productId: { type: "string", entity: "products" },
    };
    const erpConnector = makeErpConnector(orders, elementSchema);
    const { connector: crmConnector } = makeLineTarget();

    // collectOnly: ERP source member needs assocMappings so the sentinel is written
    const erpMemberOverride: Partial<ChannelMember> = {
      assocMappings: [{ source: "productId", target: "productId" }],
    };
    const db = makeDb();
    const engine = new SyncEngine(makeConfig(erpConnector, crmConnector, erpMemberOverride), db);

    // Run collectOnly — shadow state is updated; no dispatches to CRM
    await engine.ingest("order-lines", "erp", { collectOnly: true });

    const shadowRow = db
      .prepare<{ canonical_data: string }>(
        "SELECT canonical_data FROM shadow_state WHERE connector_id = 'erp' AND entity_name = 'order_lines'",
      )
      .get();
    expect(shadowRow).toBeDefined();
    const fd = JSON.parse(shadowRow!.canonical_data) as Record<string, { val: unknown }>;
    const assocSentinel = fd["__assoc__"]?.val;
    expect(typeof assocSentinel).toBe("string");
    const assocs = JSON.parse(assocSentinel as string) as Array<{ predicate: string }>;
    expect(assocs[0]!.predicate).toBe("productId");
  });
});
