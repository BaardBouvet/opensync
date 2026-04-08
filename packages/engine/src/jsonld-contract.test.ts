/**
 * JSON-LD Connector Contract tests.
 * Spec: plans/connectors/PLAN_JSONLD_CONNECTOR_CONTRACT.md
 *
 * JLC1  Connector yields Ref value → engine extracts association → dispatches remapped plain string
 * JLC2  Engine write injection: data.companyId = remappedId as plain string
 * JLC3  { type: 'ref' } schema drives inference rule (rule 2 — schema field)
 * JLC4  associationSchema drives inference (rule 3 — backward compat path)
 * JLC5  Neither: Ref-shaped value treated as opaque; no association derived
 * JLC7  Inexpressible predicates preserved as plain string values in data on update
 */

import { describe, it, expect } from "bun:test";
import { SyncEngine } from "./engine.js";
import { openDb } from "./db/index.js";
import { isRef } from "@opensync/sdk";
import type {
  Connector,
  EntityDefinition,
  InsertRecord,
  InsertResult,
  UpdateRecord,
  UpdateResult,
  AssociationDescriptor,
} from "@opensync/sdk";
import type { ResolvedConfig, ChannelMember } from "./config/loader.js";

// ─── JLC1 + JLC2: Basic Ref roundtrip ─────────────────────────────────────────

describe("JLC1: connector Ref value → engine extracts association → dispatches remapped Ref", () => {
  it("read-side Ref is extracted and written as remapped Ref into the target's data", async () => {
    const receivedInserts: InsertRecord[] = [];
    const db = openDb(":memory:");

    // Source: contact with companyId as a Ref
    const srcConnector: Connector = {
      metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [
          {
            name: "contacts",
            async *read() {
              yield {
                records: [
                  {
                    id: "c1",
                    data: {
                      name: "Alice",
                      email: "alice@example.com",
                      companyId: { '@id': 'co1', '@entity': 'companies' },
                    },
                  },
                ],
                since: "t1",
              };
            },
            async *insert(records) {
              for await (const r of records) yield { id: crypto.randomUUID(), data: r.data };
            },
            async *update(records) {
              for await (const r of records) yield { id: r.id };
            },
          },
          {
            name: "companies",
            async *read() {
              yield {
                records: [{ id: "co1", data: { name: "Acme", domain: "acme.com" } }],
                since: "t1",
              };
            },
            async *insert(records) {
              for await (const r of records) yield { id: crypto.randomUUID(), data: r.data };
            },
            async *update(records) {
              for await (const r of records) yield { id: r.id };
            },
          },
        ];
      },
    };

    // Target: receives Alice via insert — captures the insert record
    const tgtConnector: Connector = {
      metadata: { name: "tgt", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [
          {
            name: "contacts",
            async *read() {
              // Seed record so discover() finds shadow_state
              yield { records: [{ id: "seed", data: { name: "Seed", email: "seed@tgt.example.com" } }], since: "t1" };
            },
            async *insert(records): AsyncIterable<InsertResult> {
              for await (const r of records) {
                receivedInserts.push(r);
                yield { id: crypto.randomUUID(), data: r.data };
              }
            },
            async *update(records): AsyncIterable<UpdateResult> {
              for await (const r of records) yield { id: r.id };
            },
          },
          {
            name: "companies",
            async *read() {
              yield {
                records: [{ id: "acc1", data: { name: "Acme", domain: "acme.com" } }],
                since: "t1",
              };
            },
            async *insert(records): AsyncIterable<InsertResult> {
              for await (const r of records) yield { id: crypto.randomUUID(), data: r.data };
            },
            async *update(records): AsyncIterable<UpdateResult> {
              for await (const r of records) yield { id: r.id };
            },
          },
        ];
      },
    };

    const config: ResolvedConfig = {
      connectors: [
        { id: "src", connector: srcConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "tgt", connector: tgtConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels: [
        {
          id: "companies",
          members: [
            { connectorId: "src", entity: "companies" },
            { connectorId: "tgt", entity: "companies" },
          ],
          identityFields: ["domain"],
        },
        {
          id: "contacts",
          members: [
            { connectorId: "src", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
            { connectorId: "tgt", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
          ],
          identityFields: ["email"],
        },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    };

    const engine = new SyncEngine(config, db);

    // Onboard companies first so co1/acc1 are linked
    for (const id of ["src", "tgt"]) {
      await engine.ingest("companies", id, { collectOnly: true });
    }
    await engine.onboard("companies", await engine.discover("companies"));

    // Onboard contacts — Alice is unique to src
    for (const id of ["src", "tgt"]) {
      await engine.ingest("contacts", id, { collectOnly: true });
    }
    await engine.onboard("contacts", await engine.discover("contacts"));

    // JLC1: the insert was dispatched to tgt
    expect(receivedInserts.length).toBeGreaterThan(0);
    const alice = receivedInserts.find((r) => r.data["email"] === "alice@example.com");
    expect(alice).toBeDefined();

    // JLC2: companyId in the write payload is the remapped target-local ID as a plain string
    expect(alice!.data["companyId"]).toBe("acc1");
  });
});

// ─── JLC3: { type: 'ref' } schema field drives inference ─────────────────────

describe("JLC3: { type: 'ref' } schema field drives association inference", () => {
  it("engine derives association from schema when @entity is absent in Ref", async () => {
    const receivedInserts: InsertRecord[] = [];
    const db = openDb(":memory:");

    const srcConnector: Connector = {
      metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "contacts",
          // Schema declares companyId as a ref — engine uses this when @entity is absent
          schema: {
            name: { type: "string" as const },
            email: { type: "string" as const },
            companyId: { type: "string" as const, entity: "companies" },
          },
          async *read() {
            yield {
              records: [{
                id: "c1",
                // No @entity on the Ref — engine falls back to schema
                data: { name: "Alice", email: "alice@example.com", companyId: { '@id': 'co1' } },
              }],
              since: "t1",
            };
          },
          async *insert(records) {
            for await (const r of records) yield { id: crypto.randomUUID(), data: r.data };
          },
          async *update(records) {
            for await (const r of records) yield { id: r.id };
          },
        }, {
          name: "companies",
          async *read() {
            yield { records: [{ id: "co1", data: { name: "Acme", domain: "acme.com" } }], since: "t1" };
          },
          async *insert(records) {
            for await (const r of records) yield { id: crypto.randomUUID(), data: r.data };
          },
          async *update(records) {
            for await (const r of records) yield { id: r.id };
          },
        }];
      },
    };

    const tgtConnector: Connector = {
      metadata: { name: "tgt", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "contacts",
          async *read() {
            yield { records: [{ id: "seed", data: { name: "Seed", email: "seed@tgt.example.com" } }], since: "t1" };
          },
          async *insert(records): AsyncIterable<InsertResult> {
            for await (const r of records) {
              receivedInserts.push(r);
              yield { id: crypto.randomUUID(), data: r.data };
            }
          },
          async *update(records): AsyncIterable<UpdateResult> {
            for await (const r of records) yield { id: r.id };
          },
        }, {
          name: "companies",
          async *read() {
            yield { records: [{ id: "acc1", data: { name: "Acme", domain: "acme.com" } }], since: "t1" };
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

    const config: ResolvedConfig = {
      connectors: [
        { id: "src", connector: srcConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "tgt", connector: tgtConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels: [
        { id: "companies", members: [{ connectorId: "src", entity: "companies" }, { connectorId: "tgt", entity: "companies" }], identityFields: ["domain"] },
        {
          id: "contacts",
          members: [
            { connectorId: "src", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
            { connectorId: "tgt", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
          ],
          identityFields: ["email"],
        },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    };

    const engine = new SyncEngine(config, db);

    for (const id of ["src", "tgt"]) await engine.ingest("companies", id, { collectOnly: true });
    await engine.onboard("companies", await engine.discover("companies"));
    for (const id of ["src", "tgt"]) await engine.ingest("contacts", id, { collectOnly: true });
    await engine.onboard("contacts", await engine.discover("contacts"));

    const alice = receivedInserts.find((r) => r.data["email"] === "alice@example.com");
    expect(alice).toBeDefined();

    // Schema-driven inference: companyId should be the remapped ID as a plain string
    expect(alice!.data["companyId"]).toBe("acc1");
  });
});

// ─── JLC4: associationSchema drives inference ─────────────────────────────────

describe("JLC4: associationSchema drives association inference when @entity absent and no schema ref", () => {
  it("derives association from associationSchema when neither @entity nor schema ref is present", async () => {
    const receivedInserts: InsertRecord[] = [];
    const db = openDb(":memory:");

    const srcConnector: Connector = {
      metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "contacts",
          // No schema ref, but associationSchema declares companyId
          associationSchema: { companyId: { targetEntity: "companies" } satisfies AssociationDescriptor },
          async *read() {
            yield {
              records: [{
                id: "c1",
                // Ref with no @entity — engine uses associationSchema
                data: { name: "Alice", email: "alice@example.com", companyId: { '@id': 'co1' } },
              }],
              since: "t1",
            };
          },
          async *insert(records) {
            for await (const r of records) yield { id: crypto.randomUUID(), data: r.data };
          },
          async *update(records) {
            for await (const r of records) yield { id: r.id };
          },
        }, {
          name: "companies",
          async *read() {
            yield { records: [{ id: "co1", data: { name: "Acme", domain: "acme.com" } }], since: "t1" };
          },
          async *insert(records) {
            for await (const r of records) yield { id: crypto.randomUUID(), data: r.data };
          },
          async *update(records) {
            for await (const r of records) yield { id: r.id };
          },
        }];
      },
    };

    const tgtConnector: Connector = {
      metadata: { name: "tgt", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "contacts",
          async *read() {
            yield { records: [{ id: "seed", data: { name: "Seed", email: "seed@tgt.example.com" } }], since: "t1" };
          },
          async *insert(records): AsyncIterable<InsertResult> {
            for await (const r of records) {
              receivedInserts.push(r);
              yield { id: crypto.randomUUID(), data: r.data };
            }
          },
          async *update(records): AsyncIterable<UpdateResult> {
            for await (const r of records) yield { id: r.id };
          },
        }, {
          name: "companies",
          async *read() {
            yield { records: [{ id: "acc1", data: { name: "Acme", domain: "acme.com" } }], since: "t1" };
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

    const config: ResolvedConfig = {
      connectors: [
        { id: "src", connector: srcConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "tgt", connector: tgtConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels: [
        { id: "companies", members: [{ connectorId: "src", entity: "companies" }, { connectorId: "tgt", entity: "companies" }], identityFields: ["domain"] },
        {
          id: "contacts",
          members: [
            { connectorId: "src", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
            { connectorId: "tgt", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
          ],
          identityFields: ["email"],
        },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    };

    const engine = new SyncEngine(config, db);

    for (const id of ["src", "tgt"]) await engine.ingest("companies", id, { collectOnly: true });
    await engine.onboard("companies", await engine.discover("companies"));
    for (const id of ["src", "tgt"]) await engine.ingest("contacts", id, { collectOnly: true });
    await engine.onboard("contacts", await engine.discover("contacts"));

    const alice = receivedInserts.find((r) => r.data["email"] === "alice@example.com");
    expect(alice).toBeDefined();

    expect(alice!.data["companyId"]).toBe("acc1");
  });
});

// ─── JLC5: opaque Ref — no association derived ────────────────────────────────

describe("JLC5: Ref-shaped value treated as opaque when no inference rule applies", () => {
  it("does not derive association or remap a Ref with no @entity and no schema/assocSchema", async () => {
    const receivedInserts: InsertRecord[] = [];
    const db = openDb(":memory:");

    const srcConnector: Connector = {
      metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "contacts",
          // No schema, no associationSchema — opaque Ref
          async *read() {
            yield {
              records: [{
                id: "c1",
                data: {
                  name: "Alice",
                  email: "alice@example.com",
                  // Ref with no @entity and no schema/assocSchema → opaque
                  externalRef: { '@id': 'some-external-id' },
                },
              }],
              since: "t1",
            };
          },
          async *insert(records) {
            for await (const r of records) yield { id: crypto.randomUUID(), data: r.data };
          },
          async *update(records) {
            for await (const r of records) yield { id: r.id };
          },
        }];
      },
    };

    const tgtConnector: Connector = {
      metadata: { name: "tgt", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "contacts",
          async *read() {
            yield { records: [{ id: "opaque-seed", data: { name: "Seed", email: "seed@tgt.example.com" } }], since: "t1" };
          },
          async *insert(records): AsyncIterable<InsertResult> {
            for await (const r of records) {
              receivedInserts.push(r);
              yield { id: crypto.randomUUID(), data: r.data };
            }
          },
          async *update(records): AsyncIterable<UpdateResult> {
            for await (const r of records) yield { id: r.id };
          },
        }];
      },
    };

    const config: ResolvedConfig = {
      connectors: [
        { id: "src", connector: srcConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "tgt", connector: tgtConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels: [{
        id: "contacts",
        members: [
          { connectorId: "src", entity: "contacts" },
          { connectorId: "tgt", entity: "contacts" },
        ],
        identityFields: ["email"],
      }],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    };

    const engine = new SyncEngine(config, db);
    for (const id of ["src", "tgt"]) await engine.ingest("contacts", id, { collectOnly: true });
    await engine.onboard("contacts", await engine.discover("contacts"));

    // Alice should have been inserted into tgt
    const alice = receivedInserts.find((r) => r.data["email"] === "alice@example.com");
    expect(alice).toBeDefined();

    // externalRef is opaque — it is passed through as-is (no association remapping)
    // It should be stripped from the write payload (Ref values are stripped before inject)
    // Actually: since externalRef has no @entity and no assocMappings, it is opaque and
    // stripped from the outboundData (Refs without a resolved association are not injected).
    // The canonical MAY store it, but since assocMappings is absent, no assocSentinel is stored.
    // The engine strips Refs from localData before dispatch — externalRef won't reach tgt.
    expect(alice!.data["externalRef"]).toBeUndefined();
  });
});

// ─── JLC7: inexpressible predicates preserved ─────────────────────────────────

describe("JLC7: inexpressible predicates preserved as Ref values in data on update", () => {
  it("target-local Ref not expressible by source is preserved in the update payload", async () => {
    const db = openDb(":memory:");
    let crmCallN = 0;
    let erpCallN = 0;
    const crmUpdates: UpdateRecord[] = [];

    const members: ChannelMember[] = [
      {
        connectorId: "crm",
        entity: "contacts",
        assocMappings: [
          { source: "primaryCompanyId", target: "primaryRef" },
          { source: "secondaryCompanyId", target: "secondaryRef" },
        ],
      },
      {
        connectorId: "erp",
        entity: "employees",
        assocMappings: [
          { source: "orgId", target: "primaryRef" },
          // No secondaryRef mapping: ERP cannot express secondaryCompanyId
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
              // Field change → dispatch to CRM
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

    const config: ResolvedConfig = {
      connectors: [
        { id: "crm", connector: crmConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "erp", connector: erpConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels: [{ id: "contacts", members, identityFields: ["email"] }],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    };

    const engine = new SyncEngine(config, db);

    await engine.ingest("contacts", "crm", { collectOnly: true });
    await engine.ingest("contacts", "erp", { collectOnly: true });
    await engine.onboard("contacts", await engine.discover("contacts"));

    // Second ERP poll: field change → CRM update
    await engine.ingest("contacts", "erp");

    expect(crmUpdates.length).toBe(1);
    const update = crmUpdates[0]!;

    // JLC7: secondaryCompanyId is preserved as a plain string value in the update data
    expect(update.data["primaryCompanyId"]).toBeDefined();
    expect(update.data["secondaryCompanyId"]).toBeDefined();
  });
});

// ─── ASYN: Schema-driven auto-synthesis ───────────────────────────────────────
// Spec: plans/connectors/PLAN_SCHEMA_REF_AUTOSYNTH.md

describe("ASYN1: plain string FK field + schema { type: 'ref' } → engine synthesizes association and dispatches remapped Ref", () => {
  it("connector returns raw string; schema declares ref; target insert receives Ref", async () => {
    const receivedInserts: InsertRecord[] = [];
    const db = openDb(":memory:");

    // Source: returns companyId as plain string — no makeRefs() call, no explicit Ref
    const srcConnector: Connector = {
      metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [
          {
            name: "contacts",
            schema: {
              name: { type: "string" as const },
              email: { type: "string" as const },
              companyId: { type: "string" as const, entity: "companies" },
            },
            async *read() {
              yield {
                records: [{
                  id: "c1",
                  data: { name: "Alice", email: "alice@example.com", companyId: "co1" }, // plain string
                }],
                since: "t1",
              };
            },
            async *insert(records) { for await (const r of records) yield { id: crypto.randomUUID(), data: r.data }; },
            async *update(records) { for await (const r of records) yield { id: r.id }; },
          },
          {
            name: "companies",
            async *read() {
              yield { records: [{ id: "co1", data: { name: "Acme", domain: "acme.com" } }], since: "t1" };
            },
            async *insert(records) { for await (const r of records) yield { id: crypto.randomUUID(), data: r.data }; },
            async *update(records) { for await (const r of records) yield { id: r.id }; },
          },
        ];
      },
    };

    const tgtConnector: Connector = {
      metadata: { name: "tgt", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [
          {
            name: "contacts",
            async *read() {
              yield { records: [{ id: "seed", data: { name: "Seed", email: "seed@tgt.com" } }], since: "t1" };
            },
            async *insert(records): AsyncIterable<InsertResult> {
              for await (const r of records) { receivedInserts.push(r); yield { id: crypto.randomUUID(), data: r.data }; }
            },
            async *update(records): AsyncIterable<UpdateResult> { for await (const r of records) yield { id: r.id }; },
          },
          {
            name: "companies",
            async *read() {
              yield { records: [{ id: "acc1", data: { name: "Acme", domain: "acme.com" } }], since: "t1" };
            },
            async *insert(records): AsyncIterable<InsertResult> { for await (const r of records) yield { id: crypto.randomUUID(), data: r.data }; },
            async *update(records): AsyncIterable<UpdateResult> { for await (const r of records) yield { id: r.id }; },
          },
        ];
      },
    };

    const config: ResolvedConfig = {
      connectors: [
        { id: "src", connector: srcConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "tgt", connector: tgtConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels: [
        {
          id: "companies",
          members: [
            { connectorId: "src", entity: "companies" },
            { connectorId: "tgt", entity: "companies" },
          ],
          identityFields: ["domain"],
        },
        {
          id: "contacts",
          members: [
            { connectorId: "src", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
            { connectorId: "tgt", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
          ],
          identityFields: ["email"],
        },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    };

    const engine = new SyncEngine(config, db);

    for (const id of ["src", "tgt"]) await engine.ingest("companies", id, { collectOnly: true });
    await engine.onboard("companies", await engine.discover("companies"));
    for (const id of ["src", "tgt"]) await engine.ingest("contacts", id, { collectOnly: true });
    await engine.onboard("contacts", await engine.discover("contacts"));

    const alice = receivedInserts.find((r) => r.data["email"] === "alice@example.com");
    expect(alice).toBeDefined();

    // companyId in the write payload must be the remapped target-local ID as a plain string
    expect(alice!.data["companyId"]).toBe("acc1");
  });
});

describe("ASYN2: plain string + no schema ref declaration → not synthesized (opaque)", () => {
  it("plain FK string without a schema { type: 'ref' } declaration is not treated as an association", async () => {
    const receivedInserts: InsertRecord[] = [];
    const db = openDb(":memory:");

    const srcConnector: Connector = {
      metadata: { name: "src", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [
          {
            name: "contacts",
            // schema has no ref type for companyId
            schema: {
              name: { type: "string" as const },
              email: { type: "string" as const },
              companyId: { type: "string" as const },
            },
            async *read() {
              yield {
                records: [{ id: "c1", data: { name: "Bob", email: "bob@example.com", companyId: "co1" } }],
                since: "t1",
              };
            },
            async *insert(records) { for await (const r of records) yield { id: crypto.randomUUID(), data: r.data }; },
            async *update(records) { for await (const r of records) yield { id: r.id }; },
          },
          {
            name: "companies",
            async *read() {
              yield { records: [{ id: "co1", data: { name: "Acme", domain: "acme.com" } }], since: "t1" };
            },
            async *insert(records) { for await (const r of records) yield { id: crypto.randomUUID(), data: r.data }; },
            async *update(records) { for await (const r of records) yield { id: r.id }; },
          },
        ];
      },
    };

    const tgtConnector: Connector = {
      metadata: { name: "tgt", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [
          {
            name: "contacts",
            async *read() {
              yield { records: [{ id: "seed", data: { name: "Seed", email: "seed@tgt.com" } }], since: "t1" };
            },
            async *insert(records): AsyncIterable<InsertResult> {
              for await (const r of records) { receivedInserts.push(r); yield { id: crypto.randomUUID(), data: r.data }; }
            },
            async *update(records): AsyncIterable<UpdateResult> { for await (const r of records) yield { id: r.id }; },
          },
          {
            name: "companies",
            async *read() {
              yield { records: [{ id: "acc1", data: { name: "Acme", domain: "acme.com" } }], since: "t1" };
            },
            async *insert(records): AsyncIterable<InsertResult> { for await (const r of records) yield { id: crypto.randomUUID(), data: r.data }; },
            async *update(records): AsyncIterable<UpdateResult> { for await (const r of records) yield { id: r.id }; },
          },
        ];
      },
    };

    const config: ResolvedConfig = {
      connectors: [
        { id: "src", connector: srcConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "tgt", connector: tgtConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels: [
        {
          id: "companies",
          members: [{ connectorId: "src", entity: "companies" }, { connectorId: "tgt", entity: "companies" }],
          identityFields: ["domain"],
        },
        {
          id: "contacts",
          members: [
            { connectorId: "src", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
            { connectorId: "tgt", entity: "contacts", assocMappings: [{ source: "companyId", target: "companyRef" }] },
          ],
          identityFields: ["email"],
        },
      ],
      conflict: { strategy: "lww" },
      readTimeoutMs: 10_000,
    };

    const engine = new SyncEngine(config, db);
    for (const id of ["src", "tgt"]) await engine.ingest("companies", id, { collectOnly: true });
    await engine.onboard("companies", await engine.discover("companies"));
    for (const id of ["src", "tgt"]) await engine.ingest("contacts", id, { collectOnly: true });
    await engine.onboard("contacts", await engine.discover("contacts"));

    const bob = receivedInserts.find((r) => r.data["email"] === "bob@example.com");
    expect(bob).toBeDefined();
    // No Ref in the payload — companyId was a plain string with no schema ref
    expect(isRef(bob!.data["companyId"])).toBe(false);
  });
});
