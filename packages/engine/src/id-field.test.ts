/**
 * packages/engine/src/id-field.test.ts
 *
 * Tests for the id_field / idField PK-injection feature.
 * Spec: specs/field-mapping.md §4.1
 * Plan: plans/engine/PLAN_PK_AS_CHANNEL_FIELD.md
 *
 * IF-1  idField injection: connector omits PK from data; idField injects record.id as the
 *       named field into stripped before applyMapping; canonical shadow contains the value.
 * IF-2  idField does not override connector data: when connector already provides the field
 *       in record.data, the connector value wins (data overwrites injected base).
 * IF-3  Reverse pass excluded: mapping with direction reverse_only on the erpId field reads
 *       it into canonical but does not include it in the outbound payload written back to
 *       the erp connector (confirmed via written_state).
 * IF-4  Cross-connector FK via canonical field: erp uses idField; crm maps a local property
 *       to the same canonical target; after sync both sides share the stable id string.
 * IF-5  Regression guard — idField not set: no injection; record.id is not added to
 *       stripped; existing behaviour unchanged.
 */

import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { SyncEngine, openDb, type ResolvedConfig } from "./index.js";
import type { Db } from "./db/index.js";
import jsonfiles from "@opensync/connector-jsonfiles";

// ─── helpers ─────────────────────────────────────────────────────────────────

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "opensync-id-field-test-"));
}

function write(dir: string, filename: string, records: unknown[]): void {
  writeFileSync(join(dir, filename), JSON.stringify(records, null, 2), "utf8");
}

function inst(id: string, dir: string, filename = "accounts.json"): ResolvedConfig["connectors"][0] {
  return {
    id,
    connector: jsonfiles,
    config: { filePaths: [join(dir, filename)] },
    auth: {},
    batchIdRef: { current: undefined },
    triggerRef: { current: undefined },
  };
}

/** Read the FieldData for a shadow row by querying the db directly. */
function shadowData(
  db: Db,
  connectorId: string,
  entity: string,
  externalId: string,
): Record<string, unknown> | undefined {
  const row = db
    .prepare<{ canonical_data: string }>(
      "SELECT canonical_data FROM shadow_state WHERE connector_id = ? AND entity_name = ? AND external_id = ?",
    )
    .get(connectorId, entity, externalId);
  if (!row) return undefined;
  const fd = JSON.parse(row.canonical_data) as Record<string, { val: unknown }>;
  return Object.fromEntries(Object.entries(fd).map(([k, v]) => [k, v.val]));
}

/** Read what was dispatched to a connector from written_state. */
function writtenData(
  db: Db,
  connectorId: string,
  entity: string,
): Record<string, unknown>[] {
  return db
    .prepare<{ data: string }>(
      "SELECT data FROM written_state WHERE connector_id = ? AND entity_name = ?",
    )
    .all(connectorId, entity)
    .map((r) => JSON.parse(r.data) as Record<string, unknown>);
}

// ─── IF-1: idField injection ──────────────────────────────────────────────────

describe("IF-1: idField injection — record.id injected as named field into canonical shadow", () => {
  it("canonical shadow contains the injected field when connector omits PK from data", async () => {
    const db = openDb(":memory:");
    const dA = tmp();

    // Connector omits erpId from data — only name is present
    write(dA, "accounts.json", [{ id: "ACC-001", data: { name: "Acme Corp" } }]);

    const engine = new SyncEngine(
      {
        connectors: [inst("erp", dA)],
        channels: [
          {
            id: "ch",
            members: [
              {
                connectorId: "erp",
                entity: "accounts",
                // Spec: specs/field-mapping.md §4.1 — inject record.id before applyMapping
                idField: "erpId",
                inbound: [
                  { source: "erpId", target: "erpId" },
                  { source: "name",  target: "name"  },
                ],
              },
            ],
            identityFields: ["name"],
          },
        ],
        conflict: { strategy: "lww" },
        readTimeoutMs: 10_000,
      },
      db,
    );

    await engine.ingest("ch", "erp", { batchId: crypto.randomUUID(), collectOnly: true });

    const shadow = shadowData(db, "erp", "accounts", "ACC-001");
    expect(shadow).toBeDefined();
    // Injected from record.id
    expect(shadow!["erpId"]).toBe("ACC-001");
    // Regular field still present
    expect(shadow!["name"]).toBe("Acme Corp");
  });
});

// ─── IF-2: idField does not override connector data ───────────────────────────

describe("IF-2: idField does not override connector data — connector value wins", () => {
  it("when connector already provides the field in data, connector value takes precedence", async () => {
    const db = openDb(":memory:");
    const dA = tmp();

    // Connector explicitly provides erpId = "data-value" in data
    write(dA, "accounts.json", [{ id: "sys-id", data: { erpId: "data-value", name: "Acme Corp" } }]);

    const engine = new SyncEngine(
      {
        connectors: [inst("erp", dA)],
        channels: [
          {
            id: "ch",
            members: [
              {
                connectorId: "erp",
                entity: "accounts",
                idField: "erpId",
                inbound: [
                  { source: "erpId", target: "erpId" },
                  { source: "name",  target: "name"  },
                ],
              },
            ],
            identityFields: ["name"],
          },
        ],
        conflict: { strategy: "lww" },
        readTimeoutMs: 10_000,
      },
      db,
    );

    await engine.ingest("ch", "erp", { batchId: crypto.randomUUID(), collectOnly: true });

    const shadow = shadowData(db, "erp", "accounts", "sys-id");
    expect(shadow).toBeDefined();
    // Connector-provided value wins over injected record.id ("sys-id")
    expect(shadow!["erpId"]).toBe("data-value");
    expect(shadow!["name"]).toBe("Acme Corp");
  });
});

// ─── IF-3: Reverse pass excluded ─────────────────────────────────────────────

describe("IF-3: reverse pass excluded — direction reverse_only keeps erpId out of outbound", () => {
  it("written_state for erp does not contain erpId after a dispatch cycle", async () => {
    const db = openDb(":memory:");
    const [dErp, dCrm] = [tmp(), tmp()];

    // Both start with the same entity matched by name
    write(dErp, "accounts.json", [{ id: "ACC-001", data: { name: "Acme Corp" } }]);
    write(dCrm, "accounts.json", [{ id: "crm-1",  data: { name: "Acme Corp" } }]);

    const engine = new SyncEngine(
      {
        connectors: [inst("erp", dErp), inst("crm", dCrm)],
        channels: [
          {
            id: "ch",
            members: [
              {
                connectorId: "erp",
                entity: "accounts",
                idField: "erpId",
                // inbound: erpId read into canonical from idField injection
                inbound: [
                  { source: "erpId", target: "erpId" },
                  { source: "name",  target: "name"  },
                ],
                // outbound: erpId declared with reverse_only → excluded on dispatch to erp
                outbound: [
                  { source: "erpId", target: "erpId", direction: "reverse_only" },
                  { source: "name",  target: "name"  },
                  { source: "foo",   target: "foo"   },
                ],
              },
              {
                connectorId: "crm",
                entity: "accounts",
                inbound: [
                  { source: "name", target: "name" },
                  { source: "foo",  target: "foo"  },
                ],
                outbound: [
                  { source: "name", target: "name" },
                  { source: "foo",  target: "foo"  },
                ],
              },
            ],
            identityFields: ["name"],
          },
        ],
        conflict: { strategy: "lww" },
        readTimeoutMs: 10_000,
      },
      db,
    );

    // Onboard both sides
    const erpResult = await engine.ingest("ch", "erp", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "crm", { batchId: crypto.randomUUID(), collectOnly: true });
    const report = await engine.discover("ch", erpResult.snapshotAt);
    await engine.onboard("ch", report);

    // CRM adds a new field — triggers incremental dispatch to ERP
    write(dCrm, "accounts.json", [{ id: "crm-1", data: { name: "Acme Corp", foo: "CRM-DAT" } }]);
    await engine.ingest("ch", "crm");

    // written_state for erp must exist and must NOT contain erpId
    const rows = writtenData(db, "erp", "accounts");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.prototype.hasOwnProperty.call(row, "erpId")).toBe(false);
    }
  });
});

// ─── IF-4: Cross-connector FK via canonical field ─────────────────────────────

describe("IF-4: cross-connector FK — erp idField + crm local property share one canonical field", () => {
  it("both canonical shadows carry the stable erp id string after sync", async () => {
    const db = openDb(":memory:");
    const [dErp, dCrm] = [tmp(), tmp()];

    // ERP: id is "ACC-001"; no erpId in data — idField injects it
    write(dErp, "accounts.json", [{ id: "ACC-001", data: { name: "Acme Corp" } }]);
    // CRM: stores erp_account_id = "ACC-001" as a regular data field
    write(dCrm, "accounts.json", [{ id: "crm-1", data: { name: "Acme Corp", erp_account_id: "ACC-001" } }]);

    const engine = new SyncEngine(
      {
        connectors: [inst("erp", dErp), inst("crm", dCrm)],
        channels: [
          {
            id: "ch",
            members: [
              {
                connectorId: "erp",
                entity: "accounts",
                idField: "erpId",
                inbound: [
                  { source: "erpId", target: "erpId" },
                  { source: "name",  target: "name"  },
                ],
              },
              {
                connectorId: "crm",
                entity: "accounts",
                inbound: [
                  { source: "erp_account_id", target: "erpId" },
                  { source: "name",            target: "name"  },
                ],
              },
            ],
            identityFields: ["name"],
          },
        ],
        conflict: { strategy: "lww" },
        readTimeoutMs: 10_000,
      },
      db,
    );

    await engine.ingest("ch", "erp", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "crm", { batchId: crypto.randomUUID(), collectOnly: true });

    // Both shadows should carry erpId = "ACC-001"
    const erpShadow = shadowData(db, "erp", "accounts", "ACC-001");
    const crmShadow = shadowData(db, "crm", "accounts", "crm-1");

    expect(erpShadow!["erpId"]).toBe("ACC-001");
    expect(crmShadow!["erpId"]).toBe("ACC-001");
  });
});

// ─── IF-5: regression guard — no injection without idField ───────────────────

describe("IF-5: regression guard — no idField declared means record.id is not injected", () => {
  it("canonical shadow does not gain a field from record.id when idField is absent", async () => {
    const db = openDb(":memory:");
    const dA = tmp();

    write(dA, "accounts.json", [{ id: "ACC-001", data: { name: "Acme Corp" } }]);

    const engine = new SyncEngine(
      {
        connectors: [inst("erp", dA)],
        channels: [
          {
            id: "ch",
            members: [
              {
                connectorId: "erp",
                entity: "accounts",
                // No idField declared
                inbound: [{ source: "name", target: "name" }],
              },
            ],
            identityFields: ["name"],
          },
        ],
        conflict: { strategy: "lww" },
        readTimeoutMs: 10_000,
      },
      db,
    );

    await engine.ingest("ch", "erp", { batchId: crypto.randomUUID(), collectOnly: true });

    const shadow = shadowData(db, "erp", "accounts", "ACC-001");
    expect(shadow).toBeDefined();
    expect(shadow!["name"]).toBe("Acme Corp");
    // record.id ("ACC-001") must not appear as a data field
    expect(Object.prototype.hasOwnProperty.call(shadow, "erpId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(shadow, "ACC-001")).toBe(false);
  });
});
