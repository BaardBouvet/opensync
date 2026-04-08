/**
 * packages/engine/src/association-schema.test.ts
 *
 * Tests for the associationSchema feature on EntityDefinition.
 * Spec: specs/associations.md § 8 — Association Schema
 *
 * AS-1  AssociationDescriptor is exported from the SDK.
 * AS-2  Pre-flight warning fires when associationSchema.targetEntity is not in channel.
 * AS-3  Pre-flight warning is silent when all targetEntity values are in channel.
 * AS-4  Write-side filter: associations not listed in associationSchema are dropped before dispatch.
 * AS-5  Write-side pass-through: entity without associationSchema receives all associations.
 * AS-6  Required-association warning appears in RecordSyncResult when predicate is absent.
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
  AssociationDescriptor,
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
  associationSchema?: Record<string, AssociationDescriptor>,
): EntityDefinition {
  return {
    name,
    associationSchema,
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

// ─── AS-1 ─────────────────────────────────────────────────────────────────────

describe("AS-1: AssociationDescriptor exported from SDK", () => {
  it("type exists and carries expected shape", () => {
    // Compile-time check: assigning a valid AssociationDescriptor must not error.
    const d: AssociationDescriptor = {
      targetEntity: "company",
      description: "The company this contact belongs to.",
      required: true,
      multiple: false,
    };
    expect(d.targetEntity).toBe("company");
    expect(d.required).toBe(true);
  });
});

// ─── AS-2 ─────────────────────────────────────────────────────────────────────

describe("AS-2: pre-flight warning fires when targetEntity is absent from channel", () => {
  it("logs a warning at construction time", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };

    try {
      const sourceWithSchema = makeSourceEntity("contact", []);
      sourceWithSchema.associationSchema = {
        // 'company' is NOT a member of the channel below
        companyId: { targetEntity: "company", description: "The company." },
      };

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

describe("AS-3: pre-flight is silent when all targetEntity values are channel members", () => {
  it("no warning when targetEntity exists in channel", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };

    try {
      const sourceWithSchema = makeSourceEntity("contact", []);
      sourceWithSchema.associationSchema = {
        // 'contact' IS a member of the channel (same entity type, cross-reference)
        managerId: { targetEntity: "contact", description: "The manager contact." },
      };

      const db = openDb(":memory:");
      new SyncEngine(makeConfig(
        [sourceWithSchema],
        [makeTargetEntity("contact", [], [])],
        [
          { connectorId: "src", entity: "contact", assocMappings: [{ source: "managerId", target: "managerId" }] },
          { connectorId: "tgt", entity: "contact" },
        ],
      ), db);

      // No associationSchema-related warning
      expect(warnings.some((w) => w.includes("managerId") || (w.includes("unresolvable") && w.includes("contact")))).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ─── AS-4 ─────────────────────────────────────────────────────────────────────

describe("AS-4: write-side filter drops predicates absent from associationSchema", () => {
  it("only declared predicates reach update() after a change", async () => {
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
              data: { email: "alice@example.com", name: "Alice Updated" },
              // Self-referential associations so both IDs resolve via identity map
              associations: [
                { predicate: "managerId", targetEntity: "contact", targetId: "alice-1" },
                { predicate: "tagId",     targetEntity: "contact", targetId: "alice-1" },
              ],
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

    // Target: only managerId is listed in associationSchema
    const tgtEnt4: EntityDefinition = {
      name: "contact",
      associationSchema: { managerId: { targetEntity: "contact" } },
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

    // update() received associations should not include tagId
    const captured = receivedUpdates4.find((r) => r.associations && r.associations.length > 0);
    if (captured?.associations) {
      const predicates = captured.associations.map((a) => a.predicate);
      expect(predicates).not.toContain("tagId");
      expect(predicates).toContain("managerId");
    }
  });
});

// ─── AS-5 ─────────────────────────────────────────────────────────────────────

describe("AS-5: entity without associationSchema receives all associations (pass-through)", () => {
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
              data: { email: "bob@example.com", name: "Bob Updated" },
              associations: [
                { predicate: "managerId", targetEntity: "contact", targetId: "bob-1" },
                { predicate: "tagId",     targetEntity: "contact", targetId: "bob-1" },
              ],
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

    // Without associationSchema on the target, both predicates should be present
    const captured5 = receivedUpdates5.find((r) => r.associations && r.associations.length > 0);
    if (captured5?.associations) {
      const predicates = captured5.associations.map((a) => a.predicate);
      expect(predicates).toContain("managerId");
      expect(predicates).toContain("tagId");
    }
  });
});

// ─── AS-6 ─────────────────────────────────────────────────────────────────────

describe("AS-6: required-association warning appears in RecordSyncResult", () => {
  it("warnings[] contains missing_required_association when required predicate is absent", async () => {
    const db6: ReturnType<typeof openDb> = openDb(":memory:");
    let callN6 = 0;
    let tgtCallN6 = 0;

    const members6: ChannelMember[] = [
      { connectorId: "src", entity: "contact", assocMappings: [{ source: "managerId", target: "managerId" }] },
      { connectorId: "tgt", entity: "contact", assocMappings: [{ source: "managerId", target: "managerId" }] },
    ];

    // Source: first read = carol with no associations; second read = carol updated, still no assocs
    const srcEnt6: EntityDefinition = {
      name: "contact",
      async *read() {
        callN6++;
        if (callN6 === 1) {
          yield { records: [{ id: "carol-1", data: { email: "carol@example.com", name: "Carol" } }], since: "t1" };
        } else if (callN6 === 2) {
          yield { records: [{ id: "carol-1", data: { email: "carol@example.com", name: "Carol Updated" } }], since: "t2" };
        } else {
          yield { records: [], since: "t3" };
        }
      },
      async *insert(records) { for await (const r of records) yield { id: crypto.randomUUID(), data: r.data }; },
      async *update(records) { for await (const r of records) yield { id: r.id }; },
    };

    // Target: managerId is required but never present
    const tgtEnt6: EntityDefinition = {
      name: "contact",
      associationSchema: { managerId: { targetEntity: "contact", required: true } },
      async *read() {
        tgtCallN6++;
        if (tgtCallN6 === 1) {
          yield { records: [{ id: "tgt-carol-1", data: { email: "carol@example.com", name: "Carol" } }], since: "t1" };
        } else {
          yield { records: [], since: "t2" };
        }
      },
      async *insert(records): AsyncIterable<InsertResult> {
        for await (const r of records) yield { id: crypto.randomUUID(), data: r.data };
      },
      async *update(records): AsyncIterable<UpdateResult> {
        for await (const r of records) yield { id: r.id };
      },
    };
    void tgtCallN6;

    const cfg6 = makeConfig([srcEnt6], [tgtEnt6], members6);
    const eng6 = new SyncEngine(cfg6, db6);

    await eng6.ingest("ch", "src", { collectOnly: true });
    await eng6.ingest("ch", "tgt", { collectOnly: true });
    const rep6 = await eng6.discover("ch");
    await eng6.onboard("ch", rep6);

    // Second ingest: carol updated, still no managerId → required warning expected
    const result6 = await eng6.ingest("ch", "src");

    const updateResults = result6.records.filter((r) => r.action === "update" && r.targetConnectorId === "tgt");
    expect(updateResults.length).toBeGreaterThan(0);

    const withWarning = updateResults.find((r) =>
      r.warnings?.some((w) => w.includes("missing_required_association"))
    );
    expect(withWarning).toBeDefined();
    expect(withWarning!.warnings!.some((w) => w.includes("managerId"))).toBe(true);
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
                  data: { email: "alice@example.com", name: "Alice" },
                  // CRM contact has BOTH typed company associations
                  associations: [
                    { predicate: "primaryCompanyId",   targetEntity: "contacts", targetId: "" },
                    { predicate: "secondaryCompanyId", targetEntity: "contacts", targetId: "" },
                  ],
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
                  data: { email: "alice@example.com", name: "Alice" },
                  associations: [
                    { predicate: "orgId", targetEntity: "employees", targetId: "" },
                  ],
                }],
                since: "t1",
              };
            } else if (erpCallN === 2) {
              // Field change triggers a dispatch to CRM
              yield {
                records: [{
                  id: "erp-alice",
                  data: { email: "alice@example.com", name: "Alice Updated" },
                  associations: [
                    { predicate: "orgId", targetEntity: "employees", targetId: "" },
                  ],
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

    // The update must contain BOTH association predicates, not just primaryCompanyId
    const predicates7 = (update7.associations ?? []).map((a) => a.predicate);
    expect(predicates7).toContain("primaryCompanyId");
    expect(predicates7).toContain("secondaryCompanyId"); // regression: this was silently dropped
  });
});


