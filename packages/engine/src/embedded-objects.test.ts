/**
 * packages/engine/src/embedded-objects.test.ts
 *
 * Tests for embedded-object child mappings (`parent:` set, no `array_path`).
 * Spec: specs/field-mapping.md §3.1
 * Plan: plans/engine/PLAN_EMBEDDED_OBJECTS.md
 *
 * EO1   Single embedded child — child fields land in separate canonical entity
 * EO2   Child external ID derived as <parentId>#<childEntity>
 * EO3   Multiple children from same parent row — two independent canonical entities
 * EO4   Only declared child fields are mapped (whitelist semantics)
 * EO5   Reverse pass — child canonical change triggers update on parent row
 * EO6   Parent deletion cascades to child shadow tombstone
 * EO7   Unchanged child row → noop (no update dispatched)
 * EO8   buildChannelsFromEntries: embedded-object parent stays a channel member (regression)
 * EO9   discover() / onboard() skip embedded children — no "has no shadow_state" error
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { SyncEngine } from "./engine.js";
import { openDb } from "./db/index.js";
import { buildChannelsFromEntries } from "./config/loader.js";
import type {
  Connector,
  EntityDefinition,
  InsertResult,
  UpdateResult,
  ReadRecord,
} from "@opensync/sdk";
import type { ResolvedConfig } from "./config/loader.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb() { return openDb(":memory:"); }

function wired(id: string, connector: Connector): ResolvedConfig["connectors"][number] {
  return { id, connector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } };
}

function getShadowRow(db: ReturnType<typeof makeDb>, connectorId: string, entity: string, externalId: string) {
  return db.prepare<{ canonical_data: string; deleted_at: string | null }>(
    `SELECT canonical_data, deleted_at FROM shadow_state WHERE connector_id = ? AND entity_name = ? AND external_id = ?`,
  ).get(connectorId, entity, externalId);
}

function getCanonicalId(db: ReturnType<typeof makeDb>, connectorId: string, externalId: string) {
  return db.prepare<{ canonical_id: string }>(
    `SELECT canonical_id FROM identity_map WHERE connector_id = ? AND external_id = ?`,
  ).get(connectorId, externalId)?.canonical_id;
}

// ─── EO1-EO4: forward pass ────────────────────────────────────────────────────

describe("EO1-EO4: embedded object forward pass — CRM splits flat row into contacts + addresses", () => {
  // CRM has a flat contacts row with both contact fields and address fields.
  // ERP has separate employees. The canonical model has separate contacts and addresses entities.

  const crmRecords: ReadRecord[] = [
    {
      id: "C-001",
      data: {
        email: "alice@example.com",
        name: "Alice",
        ship_street: "1 Main St",
        ship_city: "Oslo",
      },
    },
  ];

  const erpUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const erpAddrUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];

  function makeCrm(): Connector {
    return {
      metadata: { name: "crm", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [
          {
            name: "contacts",
            async *read() { yield { records: crmRecords, since: "t1" }; },
            async *insert(recs): AsyncIterable<InsertResult> {
              for await (const r of recs) yield { id: `crm-${r.data.email}`, data: r.data };
            },
            async *update(recs): AsyncIterable<UpdateResult> {
              for await (const r of recs) yield { id: r.id };
            },
          },
        ];
      },
    };
  }

  function makeErp(): Connector {
    return {
      metadata: { name: "erp", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [
          {
            name: "employees",
            async *read() { yield { records: [], since: "t1" }; },
            async *insert(recs): AsyncIterable<InsertResult> {
              for await (const r of recs) {
                const id = `E-${r.data.email ?? "x"}`;
                erpUpdates.push({ id, data: r.data });
                yield { id, data: r.data };
              }
            },
            async *update(recs): AsyncIterable<UpdateResult> {
              for await (const r of recs) {
                erpUpdates.push({ id: r.id, data: r.data });
                yield { id: r.id };
              }
            },
          },
        ];
      },
    };
  }

  let db: ReturnType<typeof makeDb>;
  let engine: SyncEngine;

  beforeEach(() => {
    erpUpdates.length = 0;
    erpAddrUpdates.length = 0;
    db = makeDb();
    const config: ResolvedConfig = {
      connectors: [wired("crm", makeCrm()), wired("erp", makeErp())],
      channels: [
        {
          id: "persons",
          members: [
            // CRM flat member (parent)
            {
              name: "crm_contacts",
              connectorId: "crm",
              entity: "contacts",
              inbound: [
                { source: "email", target: "email" },
                { source: "name", target: "name" },
              ],
              outbound: [
                { source: "email", target: "email" },
                { source: "name", target: "name" },
              ],
            },
            // CRM embedded child (addresses from same contacts row)
            {
              connectorId: "crm",
              entity: "addresses",
              parentMappingName: "crm_contacts",
              embeddedChild: true,
              embeddedParentEntity: "contacts",
              sourceEntity: "contacts",
              inbound: [
                { source: "ship_street", target: "street" },
                { source: "ship_city", target: "city" },
              ],
              outbound: [
                { source: "ship_street", target: "street" },
                { source: "ship_city", target: "city" },
              ],
            },
            // ERP flat member
            {
              name: "erp_employees",
              connectorId: "erp",
              entity: "employees",
              inbound: [
                { source: "emailAddress", target: "email" },
                { source: "firstName", target: "name" },
              ],
              outbound: [
                { source: "emailAddress", target: "email" },
                { source: "firstName", target: "name" },
              ],
            },
          ],
          identity: ["email"],
        },
      ],
      conflict: {},
      readTimeoutMs: 5000,
    };
    engine = new SyncEngine(config, db);
  });

  it("EO1: child entity created separately from parent entity", async () => {
    // CRM polls first — creates canonical contacts + canonical addresses
    await engine.ingest("persons", "crm");

    // contacts shadow
    const contactShadow = getShadowRow(db, "crm", "contacts", "C-001");
    expect(contactShadow).toBeTruthy();
    expect(contactShadow!.deleted_at).toBeNull();

    // addresses shadow — derived ID
    const addrShadow = getShadowRow(db, "crm", "addresses", "C-001#addresses");
    expect(addrShadow).toBeTruthy();
    expect(addrShadow!.deleted_at).toBeNull();
  });

  it("EO2: child external ID is <parentId>#<childEntity>", async () => {
    await engine.ingest("persons", "crm");

    const canonId = getCanonicalId(db, "crm", "C-001#addresses");
    expect(canonId).toBeTruthy();
    // It's a different canonical ID than the parent contacts
    const parentCanonId = getCanonicalId(db, "crm", "C-001");
    expect(canonId).not.toBe(parentCanonId);
  });

  it("EO4: only declared child fields are in the child shadow", async () => {
    await engine.ingest("persons", "crm");

    const row = getShadowRow(db, "crm", "addresses", "C-001#addresses");
    expect(row).toBeTruthy();
    const fd = JSON.parse(row!.canonical_data) as Record<string, { val: unknown }>;
    // Child's canonical fields come from inbound mapping: ship_street → street, ship_city → city
    expect(fd["street"]?.val).toBe("1 Main St");
    expect(fd["city"]?.val).toBe("Oslo");
    // Parent fields are NOT in the child shadow (they map to contacts entity fields)
    expect(fd["email"]).toBeUndefined();
    expect(fd["name"]).toBeUndefined();
  });
});

// ─── EO5: reverse pass — child canonical change triggers parent row update ─────

describe("EO5: reverse pass — embedded child dispatch updates the parent row", () => {
  const erpAddrUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];

  function makeErpWithAddr(): Connector {
    return {
      metadata: { name: "erp", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [
          {
            name: "employees",
            async *read() {
              yield {
                records: [{ id: "E-001", data: { emailAddress: "alice@example.com", street: "Old St", city: "Bergen" } }],
                since: "t1",
              };
            },
            async *insert(recs): AsyncIterable<InsertResult> {
              for await (const r of recs) {
                const id = `E-${r.data.email ?? "x"}`;
                erpAddrUpdates.push({ id, data: r.data });
                yield { id, data: r.data };
              }
            },
            async *update(recs): AsyncIterable<UpdateResult> {
              for await (const r of recs) {
                erpAddrUpdates.push({ id: r.id, data: r.data });
                yield { id: r.id };
              }
            },
          },
        ];
      },
    };
  }

  function makeCrmWithAddr(): Connector {
    return {
      metadata: { name: "crm", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [
          {
            name: "contacts",
            async *read() {
              yield {
                records: [{ id: "C-001", data: { email: "alice@example.com", name: "Alice", ship_street: "1 Main St", ship_city: "Oslo" } }],
                since: "t1",
              };
            },
            async *insert(recs): AsyncIterable<InsertResult> {
              for await (const r of recs) yield { id: `crm-${r.data.email}`, data: r.data };
            },
            async *update(recs): AsyncIterable<UpdateResult> {
              for await (const r of recs) yield { id: r.id };
            },
          },
        ];
      },
    };
  }

  it("EO5: child address change dispatched to ERP using the parent entity (employees) and parent external ID", async () => {
    erpAddrUpdates.length = 0;
    const db = makeDb();
    const config: ResolvedConfig = {
      connectors: [wired("crm", makeCrmWithAddr()), wired("erp", makeErpWithAddr())],
      channels: [
        {
          id: "persons",
          members: [
            {
              name: "crm_contacts",
              connectorId: "crm",
              entity: "contacts",
              inbound: [{ source: "email", target: "email" }],
              outbound: [{ source: "email", target: "email" }],
            },
            {
              connectorId: "crm",
              entity: "addresses",
              parentMappingName: "crm_contacts",
              embeddedChild: true,
              embeddedParentEntity: "contacts",
              sourceEntity: "contacts",
              inbound: [
                { source: "ship_street", target: "street" },
                { source: "ship_city", target: "city" },
              ],
              outbound: [
                { source: "ship_street", target: "street" },
                { source: "ship_city", target: "city" },
              ],
            },
            {
              name: "erp_employees",
              connectorId: "erp",
              entity: "employees",
              inbound: [{ source: "emailAddress", target: "email" }],
              outbound: [{ source: "emailAddress", target: "email" }],
            },
            {
              connectorId: "erp",
              entity: "addresses",
              parentMappingName: "erp_employees",
              embeddedChild: true,
              embeddedParentEntity: "employees",
              sourceEntity: "employees",
              inbound: [
                { source: "street", target: "street" },
                { source: "city", target: "city" },
              ],
              outbound: [
                { source: "street", target: "street" },
                { source: "city", target: "city" },
              ],
            },
          ],
          identity: ["email"],
        },
      ],
      conflict: {},
      readTimeoutMs: 5000,
    };
    const engine = new SyncEngine(config, db);

    // Cycle 1: ERP polls first — creates canonical contacts (E-001#email → alice@) and addresses (E-001#addresses)
    await engine.ingest("persons", "erp");
    // Cycle 1: CRM polls — canonical already exists via ERP identity; fan-out updates ERP
    await engine.ingest("persons", "crm");

    // Check that an update was dispatched to ERP `employees` entity for addresses
    // (embedded child dispatches via the parent entity)
    const addressUpdates = erpAddrUpdates.filter((u) => u.data.street !== undefined || u.data.city !== undefined);
    expect(addressUpdates.length).toBeGreaterThan(0);

    // The target ID used in the update should be the parent ERP external ID (E-001),
    // not the derived child ID (E-001#addresses)
    const targetIdUsed = addressUpdates[0]!.id;
    expect(targetIdUsed).toBe("E-001");
  });
});

// ─── EO6: parent deletion cascades to child shadow tombstone ──────────────────

describe("EO6: parent deletion cascades child shadow tombstone", () => {
  it("when parent record is deleted, child shadow is also tombstoned", async () => {
    let returnDeleted = false;
    const db = makeDb();

    function makeConnector(id: string): Connector {
      return {
        metadata: { name: id, version: "0.0.0", auth: { type: "none" } },
        getEntities(): EntityDefinition[] {
          return [{
            name: "contacts",
            async *read() {
              if (returnDeleted) {
                yield { records: [{ id: "C-001", data: {}, deleted: true }], since: "t2" };
              } else {
                yield { records: [{ id: "C-001", data: { email: "alice@example.com", ship_street: "1 Main St" } }], since: "t1" };
              }
            },
            async *insert(recs): AsyncIterable<InsertResult> {
              for await (const r of recs) yield { id: `${id}-new`, data: r.data };
            },
            async *update(recs): AsyncIterable<UpdateResult> {
              for await (const r of recs) yield { id: r.id };
            },
          }];
        },
      };
    }

    const config: ResolvedConfig = {
      connectors: [wired("crm", makeConnector("crm"))],
      channels: [
        {
          id: "persons",
          members: [
            {
              name: "crm_contacts",
              connectorId: "crm",
              entity: "contacts",
              inbound: [{ source: "email", target: "email" }],
              outbound: [{ source: "email", target: "email" }],
            },
            {
              connectorId: "crm",
              entity: "addresses",
              parentMappingName: "crm_contacts",
              embeddedChild: true,
              embeddedParentEntity: "contacts",
              sourceEntity: "contacts",
              inbound: [{ source: "ship_street", target: "street" }],
              outbound: [{ source: "ship_street", target: "street" }],
            },
          ],
          identity: ["email"],
        },
      ],
      conflict: {},
      readTimeoutMs: 5000,
    };
    const engine = new SyncEngine(config, db);

    // Cycle 1: create parent + child
    await engine.ingest("persons", "crm");
    const addrBefore = getShadowRow(db, "crm", "addresses", "C-001#addresses");
    expect(addrBefore).toBeTruthy();
    expect(addrBefore!.deleted_at).toBeNull();

    // Cycle 2: parent deleted
    returnDeleted = true;
    await engine.ingest("persons", "crm");

    // Parent shadow tombstoned
    const contactAfter = getShadowRow(db, "crm", "contacts", "C-001");
    expect(contactAfter!.deleted_at).not.toBeNull();

    // Child shadow also tombstoned (derived: C-001#addresses)
    const addrAfter = getShadowRow(db, "crm", "addresses", "C-001#addresses");
    expect(addrAfter!.deleted_at).not.toBeNull();
  });
});

// ─── EO8: buildChannelsFromEntries regression ─────────────────────────────────
// Regression guard: when an embedded-object child references a named parent in the
// same channel, buildChannelsFromEntries must NOT drop the parent as a "source
// descriptor". The parent must remain a channel member so engine.ingest() can find
// it. If this test fails, the playground throws "crm is not a member of channel persons".
// Spec: specs/field-mapping.md §3.1

describe("EO8: buildChannelsFromEntries keeps embedded-object parent as a channel member", () => {
  it("named embedded-object parent is not dropped from channel.members", () => {
    const channels = buildChannelsFromEntries(
      [{ id: "persons", identity: ["email"] }],
      [
        // Named parent — must survive as a channel member
        {
          name: "crm_contacts",
          connector: "crm",
          entity: "contacts",
          channel: "persons",
          fields: [{ source: "email", target: "email" }],
        },
        // Embedded child with parent: — must NOT cause parent to be skipped
        {
          connector: "crm",
          parent: "crm_contacts",
          entity: "addresses",
          channel: "persons",
          fields: [{ source: "ship_street", target: "street" }],
        },
      ],
    );

    const persons = channels.find((c) => c.id === "persons");
    expect(persons).toBeTruthy();

    const memberEntities = persons!.members.map((m) => m.entity);
    // Parent must be present
    expect(memberEntities).toContain("contacts");
    // Child must also be present (as embeddedChild)
    expect(memberEntities).toContain("addresses");

    const parentMember = persons!.members.find((m) => m.entity === "contacts");
    expect(parentMember?.embeddedChild).toBeFalsy();

    const childMember = persons!.members.find((m) => m.entity === "addresses");
    expect(childMember?.embeddedChild).toBe(true);
  });

  it("engine.ingest does not throw after buildChannelsFromEntries with embedded child", async () => {
    const channels = buildChannelsFromEntries(
      [{ id: "persons", identity: ["email"] }],
      [
        {
          name: "crm_contacts",
          connector: "crm",
          entity: "contacts",
          channel: "persons",
          fields: [{ source: "email", target: "email" }],
        },
        {
          connector: "crm",
          parent: "crm_contacts",
          entity: "addresses",
          channel: "persons",
          fields: [{ source: "ship_street", target: "street" }],
        },
      ],
    );

    const crmConnector: Connector = {
      metadata: { name: "crm", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "contacts",
          async *read() { yield { records: [{ id: "C-1", data: { email: "a@b.com", ship_street: "1 Main St" } }], since: "t1" }; },
          async *insert(recs): AsyncIterable<InsertResult> { for await (const r of recs) yield { id: `c-${r.data.email}`, data: r.data }; },
          async *update(recs): AsyncIterable<UpdateResult> { for await (const r of recs) yield { id: r.id }; },
        }];
      },
    };

    const config: ResolvedConfig = {
      connectors: [{ id: "crm", connector: crmConnector, config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } }],
      channels,
      conflict: {},
      readTimeoutMs: 5000,
    };

    const engine = new SyncEngine(config, openDb(":memory:"));
    // This must not throw "crm is not a member of channel persons"
    await expect(engine.ingest("persons", "crm")).resolves.toBeDefined();
  });
});

// ─── EO9: discover() / onboard() skip embedded children ──────────────────────
// Regression guard: discover() and onboard() must not iterate embedded-child members
// because those members have no shadow_state from collectOnly. If this test fails,
// the playground throws "Connector crm has no shadow_state for contact_addresses".
// Spec: specs/field-mapping.md §3.1

describe("EO9: discover and onboard skip embedded-object children", () => {
  function makeEo9Config(): ResolvedConfig {
    const channels = buildChannelsFromEntries(
      [{ id: "persons", identity: ["email"] }],
      [
        { name: "crm_contacts", connector: "crm", entity: "contacts", channel: "persons",
          fields: [{ source: "email", target: "email" }, { source: "name", target: "name" }] },
        { connector: "crm", parent: "crm_contacts", entity: "addresses", channel: "persons",
          fields: [{ source: "ship_street", target: "street" }] },
        { connector: "erp", entity: "employees", channel: "persons",
          fields: [{ source: "email", target: "email" }, { source: "fullName", target: "name" }] },
      ],
    );

    const makeCrm = (): Connector => ({
      metadata: { name: "crm", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "contacts",
          async *read() { yield { records: [{ id: "C-1", data: { email: "a@b.com", name: "Alice", ship_street: "1 Main St" } }], since: "t1" }; },
          async *insert(recs): AsyncIterable<InsertResult> { for await (const r of recs) yield { id: `c-new`, data: r.data }; },
          async *update(recs): AsyncIterable<UpdateResult> { for await (const r of recs) yield { id: r.id }; },
        }];
      },
    });
    const makeErp = (): Connector => ({
      metadata: { name: "erp", version: "0.0.0", auth: { type: "none" } },
      getEntities(): EntityDefinition[] {
        return [{
          name: "employees",
          async *read() { yield { records: [{ id: "E-1", data: { email: "a@b.com", fullName: "Alice" } }], since: "t1" }; },
          async *insert(recs): AsyncIterable<InsertResult> { for await (const r of recs) yield { id: `e-new`, data: r.data }; },
          async *update(recs): AsyncIterable<UpdateResult> { for await (const r of recs) yield { id: r.id }; },
        }];
      },
    });

    return {
      connectors: [
        { id: "crm", connector: makeCrm(), config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
        { id: "erp", connector: makeErp(), config: {}, auth: {}, batchIdRef: { current: undefined }, triggerRef: { current: undefined } },
      ],
      channels,
      conflict: {},
      readTimeoutMs: 5000,
    };
  }

  it("discover() does not throw 'has no shadow_state' for embedded child", async () => {
    const config = makeEo9Config();
    const engine = new SyncEngine(config, openDb(":memory:"));

    // collectOnly for each non-embedded connector
    await engine.ingest("persons", "crm", { collectOnly: true });
    await engine.ingest("persons", "erp", { collectOnly: true });

    // Must not throw "has no shadow_state for contact_addresses"
    await expect(engine.discover("persons")).resolves.toBeDefined();
  });

  it("full collect→discover→onboard cycle completes without error", async () => {
    const config = makeEo9Config();
    const engine = new SyncEngine(config, openDb(":memory:"));

    await engine.ingest("persons", "crm", { collectOnly: true });
    await engine.ingest("persons", "erp", { collectOnly: true });
    const report = await engine.discover("persons");
    await expect(engine.onboard("persons", report)).resolves.toBeDefined();
  });
});
