/**
 * packages/engine/src/split-canonical.test.ts
 *
 * Unit and integration tests for the splitCanonical / no_link anti-affinity system.
 * Spec: specs/identity.md § Split Operation, § Anti-Affinity
 * Plan: plans/playground/PLAN_CLUSTER_SPLIT.md § 7
 *
 * DB-unit tests (manipulate schema directly, no connectors):
 *   T-SC-1  dbInsertNoLink stores A-side as the owner (as passed — no normalization)
 *   T-SC-2  dbInsertNoLink is idempotent (INSERT OR IGNORE — second call does not throw)
 *   T-SC-3  dbRemoveNoLink deletes the correct row; no-op when entry is absent
 *   T-SC-4  dbMergeBlockedByNoLink returns true when a no_link entry spans the two canonicals
 *   T-SC-5  dbMergeBlockedByNoLink returns false when the pair lives in the same canonical
 *   T-SC-6  dbSplitCanonical moves the nominated record to a new canonical, writes no_link for each sibling
 *   T-SC-7  dbSplitCanonical throws when the record is the last link in a cluster
 *   T-SC-8  dbSplitCanonical throws when the record does not belong to the given canonical
 *
 * Integration tests (SyncEngine + jsonfiles connector):
 *   T-SC-9   splitCanonical detaches one record; the remaining cluster stays intact
 *   T-SC-10  splitCanonical result contains correct oldCanonicalId, newCanonicalId, noLinkWritten
 *   T-SC-11  no_link prevents re-merge on the next ingest tick (_resolveCanonical)
 *   T-SC-12  removeNoLink removes the entry; re-merge becomes possible again on next ingest
 *   T-SC-13  three-way cluster: splitCanonical on one record → the other two stay merged
 *   T-SC-14  splitCanonical throws on a sole-member cluster
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { SyncEngine, openDb, type ResolvedConfig } from "./index.js";
import {
  dbInsertNoLink,
  dbRemoveNoLink,
  dbMergeBlockedByNoLink,
  dbGetAllNoLinks,
  dbSplitCanonical,
  dbLinkIdentity,
  dbGetCanonicalId,
} from "./db/queries.js";
import { createSchema } from "./db/migrations.js";
import type { Db } from "./db/index.js";
import jsonfiles from "@opensync/connector-jsonfiles";

// ─── helpers ─────────────────────────────────────────────────────────────────

function memDb(): Db {
  const db = openDb(":memory:");
  createSchema(db);
  return db;
}

/** Seed a minimal shadow_state + identity_map row for testing. */
function seedRecord(
  db: Db,
  connectorId: string,
  entityName: string,
  externalId: string,
  canonicalId: string,
): void {
  // identity_map
  db.prepare(
    `INSERT OR REPLACE INTO identity_map (canonical_id, connector_id, external_id) VALUES (?, ?, ?)`,
  ).run(canonicalId, connectorId, externalId);
  // shadow_state (minimal — canonical_data is required NOT NULL)
  db.prepare(
    `INSERT OR REPLACE INTO shadow_state
       (connector_id, entity_name, external_id, canonical_id, canonical_data)
     VALUES (?, ?, ?, ?, '{}')`,
  ).run(connectorId, entityName, externalId, canonicalId);
}

// ─── jsonfiles engine helpers ────────────────────────────────────────────────

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "opensync-sc-test-"));
}

function write(dir: string, filename: string, records: unknown[]): void {
  writeFileSync(join(dir, filename), JSON.stringify(records, null, 2), "utf8");
}

function inst(id: string, dir: string, filename = "contacts.json"): ResolvedConfig["connectors"][0] {
  const entity = filename.replace(/\.[^/.]+$/, "");
  return {
    id,
    connector: jsonfiles,
    config: { entities: { [entity]: { filePath: join(dir, filename) } } },
    auth: {},
    batchIdRef: { current: undefined },
    triggerRef: { current: undefined },
  };
}

function makeEngine(
  db: Db,
  dirs: { crm: string; erp: string },
  extra?: Partial<ResolvedConfig["channels"][0]>,
): SyncEngine {
  return new SyncEngine(
    {
      connectors: [inst("crm", dirs.crm), inst("erp", dirs.erp)],
      channels: [{
        id: "contacts",
        members: [
          {
            connectorId: "crm", entity: "contacts",
            inbound:  [{ source: "name", target: "name" }, { source: "email", target: "email" }],
            outbound: [{ source: "name", target: "name" }, { source: "email", target: "email" }],
          },
          {
            connectorId: "erp", entity: "contacts",
            inbound:  [{ source: "name", target: "name" }, { source: "email", target: "email" }],
            outbound: [{ source: "name", target: "name" }, { source: "email", target: "email" }],
          },
        ],
        identity: ["email"],
        ...extra,
      }],
      conflict: {},
      readTimeoutMs: 10_000,
    },
    db,
  );
}

async function onboard(engine: SyncEngine, connectors = ["crm", "erp"]): Promise<void> {
  for (const cid of connectors) {
    await engine.ingest("contacts", cid, { collectOnly: true });
  }
  const dr = await engine.discover("contacts");
  if (dr.matched.length > 0) await engine.onboard("contacts", dr);
}

// ─── T-SC-1 through T-SC-8: DB-unit tests ────────────────────────────────────

describe("T-SC-1: dbInsertNoLink stores A-side as the owner (as passed)", () => {
  it("the row is stored with exactly the columns passed — no reordering", () => {
    const db = memDb();
    // Pass conn-b as A-side (owner) even though conn-a is lexicographically smaller
    dbInsertNoLink(db, "conn-b", "contacts", "ext-b", "conn-a", "contacts", "ext-a");
    const rows = dbGetAllNoLinks(db);
    expect(rows).toHaveLength(1);
    // A-side must be exactly what was passed as owner — no lexicographic flip
    expect(rows[0]!.connector_id_a).toBe("conn-b");
    expect(rows[0]!.external_id_a).toBe("ext-b");
    expect(rows[0]!.connector_id_b).toBe("conn-a");
    expect(rows[0]!.external_id_b).toBe("ext-a");
  });

  it("(A,B) and (B,A) produce two distinct rows (different owners)", () => {
    const db = memDb();
    dbInsertNoLink(db, "conn-a", "contacts", "ext-a", "conn-b", "contacts", "ext-b");
    dbInsertNoLink(db, "conn-b", "contacts", "ext-b", "conn-a", "contacts", "ext-a");
    expect(dbGetAllNoLinks(db)).toHaveLength(2);
  });
});

describe("T-SC-2: dbInsertNoLink is idempotent", () => {
  it("calling insert twice does not throw or duplicate the row", () => {
    const db = memDb();
    dbInsertNoLink(db, "c1", "contacts", "e1", "c2", "contacts", "e2");
    dbInsertNoLink(db, "c1", "contacts", "e1", "c2", "contacts", "e2");
    expect(dbGetAllNoLinks(db)).toHaveLength(1);
  });
});

describe("T-SC-3: dbRemoveNoLink", () => {
  it("removes the row when called with the owner as A-side (same order as insert)", () => {
    const db = memDb();
    dbInsertNoLink(db, "c1", "contacts", "e1", "c2", "contacts", "e2");
    dbRemoveNoLink(db, "c1", "contacts", "e1", "c2", "contacts", "e2"); // owner-first order
    expect(dbGetAllNoLinks(db)).toHaveLength(0);
  });

  it("does NOT remove the row when called with reversed order (different owner-semantics row)", () => {
    const db = memDb();
    dbInsertNoLink(db, "c1", "contacts", "e1", "c2", "contacts", "e2");
    dbRemoveNoLink(db, "c2", "contacts", "e2", "c1", "contacts", "e1"); // wrong side = no-op
    expect(dbGetAllNoLinks(db)).toHaveLength(1);
  });

  it("is a no-op when the entry does not exist", () => {
    const db = memDb();
    expect(() =>
      dbRemoveNoLink(db, "c1", "contacts", "e1", "c2", "contacts", "e2"),
    ).not.toThrow();
  });
});

describe("T-SC-4: dbMergeBlockedByNoLink returns true when blocked", () => {
  it("detects a block when one no_link endpoint is in canonicalA and the other in canonicalB", () => {
    const db = memDb();
    seedRecord(db, "crm", "contacts", "ext-crm", "canon-A");
    seedRecord(db, "erp", "contacts", "ext-erp", "canon-B");
    dbInsertNoLink(db, "crm", "contacts", "ext-crm", "erp", "contacts", "ext-erp");
    expect(dbMergeBlockedByNoLink(db, "canon-A", "canon-B")).toBe(true);
    expect(dbMergeBlockedByNoLink(db, "canon-B", "canon-A")).toBe(true); // symmetric
  });
});

describe("T-SC-5: dbMergeBlockedByNoLink returns false when both records share a canonical", () => {
  it("same canonical → not blocked", () => {
    const db = memDb();
    seedRecord(db, "crm", "contacts", "ext-crm", "canon-A");
    seedRecord(db, "erp", "contacts", "ext-erp", "canon-A"); // same canonical!
    dbInsertNoLink(db, "crm", "contacts", "ext-crm", "erp", "contacts", "ext-erp");
    expect(dbMergeBlockedByNoLink(db, "canon-A", "canon-A")).toBe(false);
  });

  it("no no_link entry → not blocked", () => {
    const db = memDb();
    seedRecord(db, "crm", "contacts", "ext-crm", "canon-A");
    seedRecord(db, "erp", "contacts", "ext-erp", "canon-B");
    expect(dbMergeBlockedByNoLink(db, "canon-A", "canon-B")).toBe(false);
  });
});

describe("T-SC-6: dbSplitCanonical splits one record out and writes no_link", () => {
  it("detaches the record, assigns it a new canonical_id, and writes no_link for each sibling", () => {
    const db = memDb();
    const canon = "shared-canon";
    seedRecord(db, "crm", "contacts", "c1", canon);
    seedRecord(db, "erp", "contacts", "e1", canon);

    const result = dbSplitCanonical(db, canon, "crm", "contacts", "c1");

    // New canonical must differ from old
    expect(result.newCanonicalId).not.toBe(canon);

    // crm/c1 must be under newCanonicalId in identity_map
    expect(dbGetCanonicalId(db, "crm", "c1")).toBe(result.newCanonicalId);

    // erp/e1 must still be under old canonical
    expect(dbGetCanonicalId(db, "erp", "e1")).toBe(canon);

    // One no_link row must exist
    const links = dbGetAllNoLinks(db);
    expect(links).toHaveLength(1);
    // A-side must be the split-out record (owner); B-side must be the sibling
    const row = links[0]!;
    expect(row.connector_id_a).toBe("crm");
    expect(row.entity_name_a).toBe("contacts");
    expect(row.external_id_a).toBe("c1");
    expect(row.connector_id_b).toBe("erp");
    expect(row.entity_name_b).toBe("contacts");
    expect(row.external_id_b).toBe("e1");

    // siblings returned correctly
    expect(result.siblings).toHaveLength(1);
    expect(result.siblings[0]).toMatchObject({ connectorId: "erp", entityName: "contacts", externalId: "e1" });
  });
});

describe("T-SC-7: dbSplitCanonical throws when sole link", () => {
  it("throws when there is only one member in the cluster", () => {
    const db = memDb();
    seedRecord(db, "crm", "contacts", "c1", "solo-canon");
    expect(() => dbSplitCanonical(db, "solo-canon", "crm", "contacts", "c1")).toThrow(
      "cannot split the last link",
    );
  });
});

describe("T-SC-8: dbSplitCanonical throws when record not in canonical", () => {
  it("throws when (connectorId, externalId) is not linked to the given canonicalId", () => {
    const db = memDb();
    seedRecord(db, "crm", "contacts", "c1", "canon-A");
    seedRecord(db, "erp", "contacts", "e1", "canon-B"); // different canonical
    expect(() => dbSplitCanonical(db, "canon-A", "erp", "contacts", "e1")).toThrow(
      "identity link not found",
    );
  });
});

// ─── T-SC-9 through T-SC-14: Integration tests ───────────────────────────────

describe("T-SC-9: SyncEngine.splitCanonical detaches one record", () => {
  it("the detached record gets a new canonical; the rest of the cluster stays", async () => {
    const crmDir = tmp(); const erpDir = tmp();
    write(crmDir, "contacts.json", [{ id: "c1", data: { email: "alice@example.com" } }]);
    write(erpDir, "contacts.json", [{ id: "e1", data: { email: "alice@example.com" } }]);

    const db = memDb();
    const engine = makeEngine(db, { crm: crmDir, erp: erpDir });
    await onboard(engine);

    const map = engine.getChannelIdentityMap("contacts");
    expect(map.size).toBe(1);
    const [[canonicalId]] = [...map.entries()];

    engine.splitCanonical(canonicalId!, "crm", "contacts", "c1");

    const after = engine.getChannelIdentityMap("contacts");
    expect(after.size).toBe(2);
    for (const members of after.values()) expect(members.size).toBe(1);
    const allExtIds = [...after.values()].flatMap((m) => [...m.values()]);
    expect(allExtIds.sort()).toEqual(["c1", "e1"]);
  });
});

describe("T-SC-10: splitCanonical result shape", () => {
  it("returns oldCanonicalId, newCanonicalId, connectorId, entityName, externalId, noLinkWritten", async () => {
    const crmDir = tmp(); const erpDir = tmp();
    write(crmDir, "contacts.json", [{ id: "c1", data: { email: "bob@example.com" } }]);
    write(erpDir, "contacts.json", [{ id: "e1", data: { email: "bob@example.com" } }]);

    const db = memDb();
    const engine = makeEngine(db, { crm: crmDir, erp: erpDir });
    await onboard(engine);

    const map = engine.getChannelIdentityMap("contacts");
    const [[canonicalId]] = [...map.entries()];

    const result = engine.splitCanonical(canonicalId!, "crm", "contacts", "c1");

    expect(result.oldCanonicalId).toBe(canonicalId);
    expect(result.newCanonicalId).not.toBe(canonicalId);
    expect(result.connectorId).toBe("crm");
    expect(result.entityName).toBe("contacts");
    expect(result.externalId).toBe("c1");
    expect(result.noLinkWritten).toHaveLength(1);
    expect(result.noLinkWritten[0]).toMatchObject({ connectorId: "erp", entityName: "contacts", externalId: "e1" });
  });
});

describe("T-SC-11: no_link prevents re-merge on next ingest tick", () => {
  it("after splitCanonical, ingesting same identity fields does not re-merge the records", async () => {
    const crmDir = tmp(); const erpDir = tmp();
    write(crmDir, "contacts.json", [{ id: "c1", data: { email: "carol@example.com" } }]);
    write(erpDir, "contacts.json", [{ id: "e1", data: { email: "carol@example.com" } }]);

    const db = memDb();
    const engine = makeEngine(db, { crm: crmDir, erp: erpDir });
    await onboard(engine);

    const [[canonicalId]] = [...engine.getChannelIdentityMap("contacts").entries()];
    engine.splitCanonical(canonicalId!, "crm", "contacts", "c1");

    // Re-ingest crm — _resolveCanonical would normally merge, but no_link must block it
    await engine.ingest("contacts", "crm");

    const after = engine.getChannelIdentityMap("contacts");
    expect(after.size).toBe(2);
  });
});

describe("T-SC-12: removeNoLink re-enables merging", () => {
  it("after removeNoLink, the next discover+onboard can re-merge the records", async () => {
    const crmDir = tmp(); const erpDir = tmp();
    write(crmDir, "contacts.json", [{ id: "c1", data: { email: "dan@example.com" } }]);
    write(erpDir, "contacts.json", [{ id: "e1", data: { email: "dan@example.com" } }]);

    const db = memDb();
    const engine = makeEngine(db, { crm: crmDir, erp: erpDir });
    await onboard(engine);

    const [[canonicalId]] = [...engine.getChannelIdentityMap("contacts").entries()];
    engine.splitCanonical(canonicalId!, "crm", "contacts", "c1");
    expect(engine.getChannelIdentityMap("contacts").size).toBe(2);

    // Remove the block
    engine.removeNoLink("crm", "contacts", "c1", "erp", "contacts", "e1");

    // Re-run discover + onboard to actually re-merge (incremental ingest skips unchanged records
    // via echo detection, so re-merging requires a fresh discover+onboard cycle).
    const dr2 = await engine.discover("contacts");
    if (dr2.matched.length > 0) await engine.onboard("contacts", dr2);

    const after = engine.getChannelIdentityMap("contacts");
    expect(after.size).toBe(1);
  });
});

describe("T-SC-13: three-way cluster — splitCanonical leaves the other two merged", () => {
  it("splitting the crm record out leaves erp+extra as a two-member cluster", async () => {
    const crmDir = tmp(); const erpDir = tmp(); const extraDir = tmp();
    write(crmDir, "contacts.json", [{ id: "c1", data: { email: "eve@example.com" } }]);
    write(erpDir, "contacts.json", [{ id: "e1", data: { email: "eve@example.com" } }]);
    write(extraDir, "contacts.json", [{ id: "x1", data: { email: "eve@example.com" } }]);

    const db = memDb();
    const engine = new SyncEngine(
      {
        connectors: [inst("crm", crmDir), inst("erp", erpDir), inst("extra", extraDir)],
        channels: [{
          id: "contacts",
          members: [
            {
              connectorId: "crm", entity: "contacts",
              inbound:  [{ source: "name", target: "name" }, { source: "email", target: "email" }],
              outbound: [{ source: "name", target: "name" }, { source: "email", target: "email" }],
            },
            {
              connectorId: "erp", entity: "contacts",
              inbound:  [{ source: "name", target: "name" }, { source: "email", target: "email" }],
              outbound: [{ source: "name", target: "name" }, { source: "email", target: "email" }],
            },
            {
              connectorId: "extra", entity: "contacts",
              inbound:  [{ source: "name", target: "name" }, { source: "email", target: "email" }],
              outbound: [{ source: "name", target: "name" }, { source: "email", target: "email" }],
            },
          ],
          identity: ["email"],
        }],
        conflict: {},
        readTimeoutMs: 10_000,
      },
      db,
    );

    await engine.ingest("contacts", "crm", { collectOnly: true });
    await engine.ingest("contacts", "erp", { collectOnly: true });
    await engine.ingest("contacts", "extra", { collectOnly: true });
    const dr = await engine.discover("contacts");
    await engine.onboard("contacts", dr);

    const map = engine.getChannelIdentityMap("contacts");
    expect(map.size).toBe(1);
    const [[canonicalId, members]] = [...map.entries()];
    expect(members!.size).toBe(3);

    engine.splitCanonical(canonicalId!, "crm", "contacts", "c1");

    const after = engine.getChannelIdentityMap("contacts");
    expect(after.size).toBe(2);

    // Find the cluster that has erp AND extra together
    const bigCluster = [...after.entries()].find(([, m]) => m.size === 2);
    expect(bigCluster).toBeDefined();
    expect([...bigCluster![1].values()].sort()).toEqual(["e1", "x1"]);

    // The solo cluster must be crm/c1
    const soloCluster = [...after.entries()].find(([, m]) => m.size === 1);
    expect([...soloCluster![1].values()]).toEqual(["c1"]);

    // Two no_link rows: crm/c1 ↔ erp/e1 and crm/c1 ↔ extra/x1
    const links = dbGetAllNoLinks(db);
    expect(links).toHaveLength(2);
  });
});

describe("T-SC-14: splitCanonical throws on a sole-member cluster", () => {
  it("throws when the cluster has only one member", async () => {
    const crmDir = tmp(); const erpDir = tmp();
    write(crmDir, "contacts.json", [{ id: "c1", email: "frank@example.com" }]);
    write(erpDir, "contacts.json", []);

    const db = memDb();
    const engine = makeEngine(db, { crm: crmDir, erp: erpDir });
    await engine.ingest("contacts", "crm", { collectOnly: true });
    await engine.ingest("contacts", "erp", { collectOnly: true });

    const [[canonicalId]] = [...engine.getChannelIdentityMap("contacts").entries()];
    expect(() =>
      engine.splitCanonical(canonicalId!, "crm", "contacts", "c1"),
    ).toThrow("cannot split the last link");
  });
});
