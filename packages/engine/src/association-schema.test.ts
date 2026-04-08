/**
 * packages/engine/src/association-schema.test.ts
 *
 * Tests for FK-field-driven association filtering and pre-flight warnings.
 * FK declarations live on FieldDescriptor.entity — no separate associationSchema.
 * Spec: specs/associations.md § 8 — Association Schema
 *
 * AS-2  Pre-flight warning fires when schema[field].entity is not in channel.
 * AS-3  Pre-flight warning is silent when all entity values are in channel.
 * AS-4  Write-side filter: associations for fields without schema.entity are dropped before dispatch.
 * AS-5  Write-side pass-through: entity without FK schema fields receives all associations.
 */

import { describe, it, expect } from "bun:test";
import type {
  Connector,
  EntityDefinition,
  InsertRecord,
  InsertResult,
  ReadBatch,
  UpdateRecord,
  UpdateResult,
} from "@opensync/sdk";
import { SyncEngine, openDb, type ResolvedConfig } from "./index.js";
import type { ChannelMember } from "./config/loader.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal ResolvedConfig with two connectors and one channel. */
function makeConfig(
  sourceEntities: EntityDefinition[],
  targetEntities: EntityDefinition[],
  members: ChannelMember[],
): ResolvedConfig {
  const noop = (): Connector => ({
    metadata: { name: "noop", version: "0.0.0", auth: { type: "none" } },
    getEntities: () => [],
  });
  const src: Connector = {
    metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
    getEntities() { return sourceEntities; },
  };
  const tgt: Connector = {
    metadata: { name: "tgt", version: "0.0.0", auth: { type: "none" } },
    getEntities() { return targetEntities; },
  };
  void noop;
  return {
    connectors: [
      { id: "src", connector: src, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      { id: "tgt", connector: tgt, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
    ],
    channels: [{ id: "ch", members, identityFields: ["email"] }],
    conflict: { strategy: "lww" },
    readTimeoutMs: 10_000,
  };
}

/** Minimal source entity that yields one record with given associations. */
function makeSourceEntity(name: string, records: ReadBatch["records"]): EntityDefinition {
  return {
    name,
    async *read() {
      yield { records, since: "t1" };
    },
    async *insert(records) {
      for await (const r of records) {
        yield { id: crypto.randomUUID(), data: r.data };
      }
    },
    async *update(records) {
      for await (const r of records) {
        yield { id: r.id };
      }
    },
  };
}

/** Target entity that captures received InsertRecord / UpdateRecord for inspection. */
function makeTargetEntity(
  name: string,
  receivedInserts: InsertRecord[],
  receivedUpdates: UpdateRecord[],
): EntityDefinition {
  return {
    name,
    async *read() { yield { records: [], since: "t0" }; },
    async *insert(records): AsyncIterable<InsertResult> {
      for await (const r of records) {
        receivedInserts.push(r);
        yield { id: crypto.randomUUID(), data: r.data };
      }
    },
    async *update(records): AsyncIterable<UpdateResult> {
      for await (const r of records) {
        receivedUpdates.push(r);
        yield { id: r.id };
      }
    },
  };
}

// ─── AS-2 ─────────────────────────────────────────────────────────────────────

describe("AS-2: pre-flight warning fires when schema entity is absent from channel", () => {
  it("logs a warning at construction time", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };

    try {
      const sourceWithSchema = makeSourceEntity("contact", []);
      // 'company' is NOT a member of the channel below
      sourceWithSchema.schema = { companyId: { entity: "company" } };

      makeConfig(
        [sourceWithSchema],
        [makeTargetEntity("contact", [], [])],
        [
          { connectorId: "src", entity: "contact", assocMappings: [{ source: "companyId", target: "companyId" }] },
          { connectorId: "tgt", entity: "contact" },
        ],
      );

      // Engine construction triggers pre-flight
      const db = openDb(":memory:");
      new SyncEngine(makeConfig(
        [sourceWithSchema],
        [makeTargetEntity("contact", [], [])],
        [
          { connectorId: "src", entity: "contact", assocMappings: [{ source: "companyId", target: "companyId" }] },
          { connectorId: "tgt", entity: "contact" },
        ],
      ), db);

      expect(warnings.some((w) => w.includes("company") && w.includes("contact") && w.includes("companyId"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ─── AS-3 ─────────────────────────────────────────────────────────────────────

describe("AS-3: pre-flight is silent when all entity values are channel members", () => {
  it("no warning when entity exists in channel", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };

    try {
      const sourceWithSchema = makeSourceEntity("contact", []);
      // 'contact' IS a member of the channel (self-referential)
      sourceWithSchema.schema = { managerId: { entity: "contact" } };

      const db = openDb(":memory:");
      new SyncEngine(makeConfig(
        [sourceWithSchema],
        [makeTargetEntity("contact", [], [])],
        [
          { connectorId: "src", entity: "contact", assocMappings: [{ source: "managerId", target: "managerId" }] },
          { connectorId: "tgt", entity: "contact" },
        ],
      ), db);

      // No entity-related warning
      expect(warnings.some((w) => w.includes("managerId") || (w.includes("unresolvable") && w.includes("contact")))).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ─── AS-4 ─────────────────────────────────────────────────────────────────────

describe("AS-4: write-side filter drops predicates absent from schema entity fields", () => {
  it("only schema-declared FK predicates reach update() after a change", async () => {
    const receivedUpdates4: UpdateRecord[] = [];
    const db4 = openDb(":memory:");
    let callN4 = 0;
    let tgtCallN4 = 0;

    const members4: ChannelMember[] = [
      {
        connectorId: "src",
        entity: "contact",
        assocMappings: [
          { source: "managerId", target: "managerId" },
          { source: "tagId",     target: "tagId" },
        ],
      },
      {
        connectorId: "tgt",
        entity: "contact",
        assocMappings: [
          { source: "managerId", target: "managerId" },
          { source: "tagId",     target: "tagId" },
        ],
      },
    ];

    // Source: first read = initial (no associations), second read = alice with TWO assocs.
    const srcEnt4: EntityDefinition = {
      name: "contact",
      async *read() {
        callN4++;
        if (callN4 === 1) {
          yield { records: [{ id: "alice-1", data: { email: "alice@example.com", name: "Alice" } }], since: "t1" };
        } else if (callN4 === 2) {
          yield {
            records: [{
              id: "alice-1",
              // Self-referential Ref values so both IDs resolve via identity map
              data: {
                email: "alice@example.com",
                name: "Alice Updated",
                managerId: { '@id': 'alice-1', '@entity': 'contact' },
                tagId:     { '@id': 'alice-1', '@entity': 'contact' },
              },
            }],
            since: "t2",
          };
        } else {
          yield { records: [], since: "t3" };
        }
      },
      async *insert(records) { for await (const r of records) yield { id: crypto.randomUUID(), data: r.data }; },
      async *update(records) { for await (const r of records) yield { id: r.id }; },
    };

    // Target: only managerId is listed as a schema FK field
    const tgtEnt4: EntityDefinition = {
      name: "contact",
      schema: { managerId: { entity: "contact" } },
      async *read() {
        tgtCallN4++;
        if (tgtCallN4 === 1) {
          yield { records: [{ id: "tgt-alice-1", data: { email: "alice@example.com", name: "Alice" } }], since: "t1" };
        } else {
          yield { records: [], since: "t2" };
        }
      },
      async *insert(records): AsyncIterable<InsertResult> {
        for await (const r of records) yield { id: crypto.randomUUID(), data: r.data };
      },
      async *update(records): AsyncIterable<UpdateResult> {
        for await (const r of records) {
          receivedUpdates4.push(r);
          yield { id: r.id };
        }
      },
    };
    void tgtCallN4;

    const cfg4 = makeConfig([srcEnt4], [tgtEnt4], members4);
    const eng4 = new SyncEngine(cfg4, db4);

    // Bootstrap: collect both sides, cross-link
    await eng4.ingest("ch", "src", { collectOnly: true });
    await eng4.ingest("ch", "tgt", { collectOnly: true });
    const rep4 = await eng4.discover("ch");
    await eng4.onboard("ch", rep4);

    // Second ingest: alice updated + TWO associations
    const result4 = await eng4.ingest("ch", "src");

    const updated = result4.records.filter((r) => r.action === "update" && r.targetConnectorId === "tgt");
    expect(updated.length).toBeGreaterThan(0);

    // afterAssociations in result should only contain managerId (schema filter dropped tagId)
    const withAssoc = updated.find((r) => r.afterAssociations && r.afterAssociations.length > 0);
    if (withAssoc?.afterAssociations) {
      const predicates = withAssoc.afterAssociations.map((a) => a.predicate);
      expect(predicates).not.toContain("tagId");
      expect(predicates).toContain("managerId");
    }

    // update() data should have managerId as a Ref but NOT tagId (schema filter dropped tagId)
    const captured = receivedUpdates4.find((r) => r.data["managerId"] !== undefined || r.data["tagId"] !== undefined);
    if (captured) {
      expect(captured.data["managerId"]).toBeDefined();
      expect(captured.data["tagId"]).toBeUndefined();
    }
  });
});

// ─── AS-5 ─────────────────────────────────────────────────────────────────────

describe("AS-5: entity without FK schema fields receives all associations (pass-through)", () => {
  it("all remapped predicates pass through to update() when no schema declared", async () => {
    const receivedUpdates5: UpdateRecord[] = [];
    const db5 = openDb(":memory:");
    let callN5 = 0;
    let tgtCallN5 = 0;

    const members5: ChannelMember[] = [
      {
        connectorId: "src",
        entity: "contact",
        assocMappings: [
          { source: "managerId", target: "managerId" },
          { source: "tagId",     target: "tagId" },
        ],
      },
      {
        connectorId: "tgt",
        entity: "contact",
        assocMappings: [
          { source: "managerId", target: "managerId" },
          { source: "tagId",     target: "tagId" },
        ],
      },
    ];

    const srcEnt5: EntityDefinition = {
      name: "contact",
      async *read() {
        callN5++;
        if (callN5 === 1) {
          yield { records: [{ id: "bob-1", data: { email: "bob@example.com", name: "Bob" } }], since: "t1" };
        } else if (callN5 === 2) {
          yield {
            records: [{
              id: "bob-1",
              data: {
                email: "bob@example.com",
                name: "Bob Updated",
                managerId: { '@id': 'bob-1', '@entity': 'contact' },
                tagId:     { '@id': 'bob-1', '@entity': 'contact' },
              },
            }],
            since: "t2",
          };
        } else {
          yield { records: [], since: "t3" };
        }
      },
      async *insert(records) { for await (const r of records) yield { id: crypto.randomUUID(), data: r.data }; },
      async *update(records) { for await (const r of records) yield { id: r.id }; },
    };

    // No associationSchema — pass-through
    const tgtEnt5: EntityDefinition = {
      name: "contact",
      async *read() {
        tgtCallN5++;
        if (tgtCallN5 === 1) {
          yield { records: [{ id: "tgt-bob-1", data: { email: "bob@example.com", name: "Bob" } }], since: "t1" };
        } else {
          yield { records: [], since: "t2" };
        }
      },
      async *insert(records): AsyncIterable<InsertResult> {
        for await (const r of records) yield { id: crypto.randomUUID(), data: r.data };
      },
      async *update(records): AsyncIterable<UpdateResult> {
        for await (const r of records) {
          receivedUpdates5.push(r);
          yield { id: r.id };
        }
      },
    };
    void tgtCallN5;

    const cfg5 = makeConfig([srcEnt5], [tgtEnt5], members5);
    const eng5 = new SyncEngine(cfg5, db5);

    await eng5.ingest("ch", "src", { collectOnly: true });
    await eng5.ingest("ch", "tgt", { collectOnly: true });
    const rep5 = await eng5.discover("ch");
    await eng5.onboard("ch", rep5);

    const result5 = await eng5.ingest("ch", "src");

    const updated5 = result5.records.filter((r) => r.action === "update" && r.targetConnectorId === "tgt");
    expect(updated5.length).toBeGreaterThan(0);

    // Without associationSchema on the target, both Ref values should be injected into data
    const captured5 = receivedUpdates5.find((r) =>
      (r.data["managerId"] !== undefined) || (r.data["tagId"] !== undefined)
    );
    if (captured5) {
      expect(captured5.data["managerId"]).toBeDefined();
      expect(captured5.data["tagId"]).toBeDefined();
    }
  });
});

// ─── AS-7 ─────────────────────────────────────────────────────────────────────

describe("AS-7: target-local associations not expressible by source are preserved on update (regression)", () => {
  // Regression: when ERP (orgId → primaryRef) triggers a CRM update, CRM's
  // secondaryCompanyId association (secondaryRef, no ERP counterpart) must be
  // preserved in the outbound write — it must not be silently dropped.
  it("secondaryCompanyId is preserved when an ERP field change triggers a CRM update", async () => {
    const db7 = openDb(":memory:");
    let crmCallN = 0;
    let erpCallN = 0;
    const crmUpdates: UpdateRecord[] = [];

    // CRM: two typed company predicates; ERP: only orgId (no secondaryRef mapping).
    const members7: ChannelMember[] = [
      {
        connectorId: "crm",
        entity: "contacts",
        assocMappings: [
          { source: "primaryCompanyId",   target: "primaryRef"   },
          { source: "secondaryCompanyId", target: "secondaryRef" },
        ],
      },
      {
        connectorId: "erp",
        entity: "employees",
        assocMappings: [
          { source: "orgId", target: "primaryRef" },
          // No secondaryRef mapping — ERP cannot express secondaryCompanyId
        ],
      },
    ];

    const crmConnector: Connector = {
      metadata: { name: "crm", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "contacts",
          async *read() {
            crmCallN++;
            if (crmCallN === 1) {
              yield {
                records: [{
                  id: "crm-alice",
                  // CRM contact has BOTH typed company associations as Ref values
                  data: {
                    email: "alice@example.com",
                    name: "Alice",
                    primaryCompanyId:   { '@id': '', '@entity': 'contacts' },
                    secondaryCompanyId: { '@id': '', '@entity': 'contacts' },
                  },
                }],
                since: "t1",
              };
            } else {
              yield { records: [], since: "t2" };
            }
          },
          async *insert(records): AsyncIterable<InsertResult> {
            for await (const r of records) yield { id: crypto.randomUUID(), data: r.data };
          },
          async *update(records): AsyncIterable<UpdateResult> {
            for await (const r of records) {
              crmUpdates.push(r);
              yield { id: r.id };
            }
          },
        }];
      },
    };

    const erpConnector: Connector = {
      metadata: { name: "erp", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "employees",
          async *read() {
            erpCallN++;
            if (erpCallN === 1) {
              yield {
                records: [{
                  id: "erp-alice",
                  data: { email: "alice@example.com", name: "Alice", orgId: { '@id': '', '@entity': 'employees' } },
                }],
                since: "t1",
              };
            } else if (erpCallN === 2) {
              // Field change triggers a dispatch to CRM
              yield {
                records: [{
                  id: "erp-alice",
                  data: { email: "alice@example.com", name: "Alice Updated", orgId: { '@id': '', '@entity': 'employees' } },
                }],
                since: "t2",
              };
            } else {
              yield { records: [], since: "t3" };
            }
          },
          async *insert(records): AsyncIterable<InsertResult> {
            for await (const r of records) yield { id: crypto.randomUUID(), data: r.data };
          },
          async *update(records): AsyncIterable<UpdateResult> {
            for await (const r of records) yield { id: r.id };
          },
        }];
      },
    };

    const config7: ResolvedConfig = {
      connectors: [
        { id: "crm", connector: crmConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "erp", connector: erpConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels: [{ id: "contacts", members: members7, identityFields: ["email"] }],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    };

    const engine7 = new SyncEngine(config7, db7);

    // Bootstrap: both sides already have matching records
    await engine7.ingest("contacts", "crm", { collectOnly: true });
    await engine7.ingest("contacts", "erp", { collectOnly: true });
    const report7 = await engine7.discover("contacts");
    await engine7.onboard("contacts", report7);

    // Second ERP poll: alice's name changed — triggers a CRM update
    await engine7.ingest("contacts", "erp");

    // CRM must have received exactly one update
    expect(crmUpdates.length).toBe(1);
    const update7 = crmUpdates[0]!;

    // The update data must contain BOTH association predicates as Ref values, not just primaryCompanyId
    expect(update7.data["primaryCompanyId"]).toBeDefined();
    expect(update7.data["secondaryCompanyId"]).toBeDefined(); // regression: this was silently dropped
  });
});


