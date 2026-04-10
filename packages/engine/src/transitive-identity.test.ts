/**
 * packages/engine/src/transitive-identity.test.ts
 *
 * Tests for transitive closure identity and compound identity groups.
 * Spec: plans/engine/PLAN_TRANSITIVE_CLOSURE_IDENTITY.md
 *
 * T-TC-1  Three connectors, email+taxId. A has email only, B has both, C has taxId only.
 *         After discover+onboard, all three share one canonical UUID.
 * T-TC-2  Four-leg chain: A–B via email, B–C via taxId, C–D via phone. All four → one canonical.
 * T-TC-3  Ambiguous component: two records from the same connector share email + one from another.
 *         Neither same-connector record appears in matched; both remain in uniquePerSide.
 * T-TC-4  _resolveCanonical ingest-time fix: incoming record bridges two existing canonicals.
 *         After ingest, the two canonicals are merged.
 * T-TC-5  addConnector bridge: joiner record matches two separate existing canonicals via
 *         different fields. After addConnector they share one canonical.
 * T-LG-1  identity compound group: no match when only some fields of the group are present.
 * T-LG-2  identity compound group + transitive: A has email; B has email+name+dob; C has name+dob.
 *         A matches B via email group; C matches B via compound group → A=B=C.
 * T-LG-3  identity compound group at ingest-time via _resolveCanonical.
 * T-LG-4  identity compound group: only declared fields trigger a match; sharing unlisted fields does not.
 */

import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { SyncEngine, openDb, type ResolvedConfig, type DiscoveryReport } from "./index.js";
import type { Db } from "./db/index.js";
import jsonfiles from "@opensync/connector-jsonfiles";

// ─── helpers ─────────────────────────────────────────────────────────────────

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "opensync-tc-test-"));
}

function write(dir: string, filename: string, records: unknown[]): void {
  writeFileSync(join(dir, filename), JSON.stringify(records, null, 2), "utf8");
}

function inst(id: string, dir: string, filename = "contacts.json"): ResolvedConfig["connectors"][0] {
  const entityName = filename.replace(/\.[^/.]+$/, "");
  return {
    id,
    connector: jsonfiles,
    config: { entities: { [entityName]: { filePath: join(dir, filename) } } },
    auth: {},
    batchIdRef: { current: undefined },
    triggerRef: { current: undefined },
  };
}

// Comprehensive field map covering all identity + data fields used across T-TC and T-LG tests.
// Enriched onto every channel member so identity matching works without implicit passthrough.
const TC_FIELD_MAP = ["email", "taxId", "phone", "name", "firstName", "lastName", "dob"]
  .map(f => ({ source: f, target: f }));

function makeEngine(
  db: Db,
  connectors: ResolvedConfig["connectors"],
  members: { connectorId: string; entity: string }[],
  channelOverride?: Partial<ResolvedConfig["channels"][0]>,
): SyncEngine {
  return new SyncEngine(
    {
      connectors,
      channels: [{ id: "ch", members: members.map(m => ({ ...m, inbound: TC_FIELD_MAP, outbound: TC_FIELD_MAP })), identity: ["email", "taxId"], ...channelOverride }],
      conflict: {},
      readTimeoutMs: 10_000,
    },
    db,
  );
}

function canonicalIds(db: Db): Set<string> {
  return new Set(
    db.prepare<{ canonical_id: string }>("SELECT DISTINCT canonical_id FROM identity_map").all().map((r) => r.canonical_id),
  );
}

function canonicalFor(db: Db, connectorId: string, externalId: string): string | undefined {
  return db
    .prepare<{ canonical_id: string }>("SELECT canonical_id FROM identity_map WHERE connector_id = ? AND external_id = ?")
    .get(connectorId, externalId)?.canonical_id;
}

// ─── T-TC-1 ──────────────────────────────────────────────────────────────────

describe("T-TC-1: three-connector transitive bridge (email + taxId)", () => {
  it("A–B via email, B–C via taxId → all three share one canonical", async () => {
    const db = openDb(":memory:");
    const [dA, dB, dC] = [tmp(), tmp(), tmp()];

    // A has email only, B has both, C has taxId only
    write(dA, "contacts.json", [{ id: "a1", data: { name: "Alice", email: "alice@example.com" } }]);
    write(dB, "contacts.json", [{ id: "b1", data: { name: "Alice", email: "alice@example.com", taxId: "123" } }]);
    write(dC, "contacts.json", [{ id: "c1", data: { name: "Alice", taxId: "123" } }]);

    const engine = makeEngine(db, [inst("A", dA), inst("B", dB), inst("C", dC)], [
      { connectorId: "A", entity: "contacts" },
      { connectorId: "B", entity: "contacts" },
      { connectorId: "C", entity: "contacts" },
    ]);

    await engine.ingest("ch", "A", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "B", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "C", { batchId: crypto.randomUUID(), collectOnly: true });

    const report = await engine.discover("ch");

    expect(report.matched).toHaveLength(1);
    expect(report.matched[0].sides).toHaveLength(3);
    expect(report.uniquePerSide).toHaveLength(0);

    await engine.onboard("ch", report);

    // All three external IDs must share one canonical UUID
    const cA = canonicalFor(db, "A", "a1");
    const cB = canonicalFor(db, "B", "b1");
    const cC = canonicalFor(db, "C", "c1");
    expect(cA).toBeDefined();
    expect(cA).toBe(cB);
    expect(cA).toBe(cC);
    expect(canonicalIds(db).size).toBe(1);
  });
});

// ─── T-TC-2 ──────────────────────────────────────────────────────────────────

describe("T-TC-2: four-leg transitive chain (email → taxId → phone)", () => {
  it("A–B via email, B–C via taxId, C–D via phone → one canonical", async () => {
    const db = openDb(":memory:");
    const [dA, dB, dC, dD] = [tmp(), tmp(), tmp(), tmp()];

    write(dA, "contacts.json", [{ id: "a1", data: { email: "alice@example.com" } }]);
    write(dB, "contacts.json", [{ id: "b1", data: { email: "alice@example.com", taxId: "123" } }]);
    write(dC, "contacts.json", [{ id: "c1", data: { taxId: "123", phone: "555-0100" } }]);
    write(dD, "contacts.json", [{ id: "d1", data: { phone: "555-0100" } }]);

    const engine = makeEngine(
      db,
      [inst("A", dA), inst("B", dB), inst("C", dC), inst("D", dD)],
      [
        { connectorId: "A", entity: "contacts" },
        { connectorId: "B", entity: "contacts" },
        { connectorId: "C", entity: "contacts" },
        { connectorId: "D", entity: "contacts" },
      ],
      { identity: ["email", "taxId", "phone"] },
    );

    for (const id of ["A", "B", "C", "D"]) {
      await engine.ingest("ch", id, { batchId: crypto.randomUUID(), collectOnly: true });
    }

    const report = await engine.discover("ch");

    expect(report.matched).toHaveLength(1);
    expect(report.matched[0].sides).toHaveLength(4);
    expect(report.uniquePerSide).toHaveLength(0);

    await engine.onboard("ch", report);

    const canon = canonicalFor(db, "A", "a1");
    expect(canon).toBe(canonicalFor(db, "B", "b1"));
    expect(canon).toBe(canonicalFor(db, "C", "c1"));
    expect(canon).toBe(canonicalFor(db, "D", "d1"));
    expect(canonicalIds(db).size).toBe(1);
  });
});

// ─── T-TC-3 ──────────────────────────────────────────────────────────────────

describe("T-TC-3: ambiguous component — same-connector duplicate bridged to another connector", () => {
  it("two same-connector records sharing an email field stay in uniquePerSide", async () => {
    const db = openDb(":memory:");
    const [dA, dB] = [tmp(), tmp()];

    // connectorA has two records with the same email — an intra-connector duplicate
    write(dA, "contacts.json", [
      { id: "a1", data: { email: "dup@example.com" } },
      { id: "a2", data: { email: "dup@example.com" } },
    ]);
    write(dB, "contacts.json", [{ id: "b1", data: { email: "dup@example.com" } }]);

    const engine = makeEngine(db, [inst("A", dA), inst("B", dB)], [
      { connectorId: "A", entity: "contacts" },
      { connectorId: "B", entity: "contacts" },
    ], { identity: ["email"] });

    await engine.ingest("ch", "A", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "B", { batchId: crypto.randomUUID(), collectOnly: true });

    const report = await engine.discover("ch");

    // Ambiguous component: a1 and a2 both share the email with b1.
    // Engine cannot resolve which A record is "the same" — neither a1 nor a2 should be in matched.
    expect(report.matched).toHaveLength(0);
    const uniqueIds = report.uniquePerSide.map((s) => s.externalId).sort();
    expect(uniqueIds).toEqual(["a1", "a2", "b1"].sort());
  });
});

// ─── T-TC-4 ──────────────────────────────────────────────────────────────────

describe("T-TC-4: _resolveCanonical merges two existing canonicals at ingest time", () => {
  it("incoming record with email matching canonical-A and taxId matching canonical-C merges them", async () => {
    const db = openDb(":memory:");
    const [dA, dB, dC] = [tmp(), tmp(), tmp()];

    // Collect A and C in isolation first (they have no fields in common)
    write(dA, "contacts.json", [{ id: "a1", data: { email: "alice@example.com" } }]);
    write(dC, "contacts.json", [{ id: "c1", data: { taxId: "123" } }]);
    // B bridges them — it has both fields
    write(dB, "contacts.json", [{ id: "b1", data: { email: "alice@example.com", taxId: "123" } }]);

    const engineAC = makeEngine(db, [inst("A", dA), inst("C", dC)], [
      { connectorId: "A", entity: "contacts" },
      { connectorId: "C", entity: "contacts" },
    ]);

    // Collect A and C so they each get their own provisional canonicals
    await engineAC.ingest("ch", "A", { batchId: crypto.randomUUID(), collectOnly: true });
    await engineAC.ingest("ch", "C", { batchId: crypto.randomUUID(), collectOnly: true });

    const canonABefore = canonicalFor(db, "A", "a1");
    const canonCBefore = canonicalFor(db, "C", "c1");
    expect(canonABefore).toBeDefined();
    expect(canonCBefore).toBeDefined();
    expect(canonABefore).not.toBe(canonCBefore);

    // Now add B to the channel and ingest normally — B bridges A and C at _resolveCanonical time
    const engine3 = makeEngine(db, [inst("A", dA), inst("B", dB), inst("C", dC)], [
      { connectorId: "A", entity: "contacts" },
      { connectorId: "B", entity: "contacts" },
      { connectorId: "C", entity: "contacts" },
    ]);

    await engine3.ingest("ch", "B", { batchId: crypto.randomUUID() });

    // A and C should now share the same canonical UUID
    const canonAAfter = canonicalFor(db, "A", "a1");
    const canonCAfter = canonicalFor(db, "C", "c1");
    const canonB = canonicalFor(db, "B", "b1");
    expect(canonAAfter).toBe(canonCAfter);
    expect(canonB).toBe(canonAAfter);
    expect(canonicalIds(db).size).toBe(1);
  });
});

// ─── T-TC-5 ──────────────────────────────────────────────────────────────────

describe("T-TC-5: addConnector bridges a fully-linked canonical and a provisional via different fields", () => {
  it("joiner record matching two distinct canonicals (one live, one provisional) merges them", async () => {
    const db = openDb(":memory:");
    const [dA, dB, dD, dC] = [tmp(), tmp(), tmp(), tmp()];

    write(dA, "contacts.json", [{ id: "a1", data: { email: "alice@example.com" } }]);
    write(dB, "contacts.json", [{ id: "b1", data: { email: "alice@example.com" } }]);
    write(dD, "contacts.json", [{ id: "d1", data: { taxId: "123" } }]);
    write(dC, "contacts.json", [{ id: "c1", data: { email: "alice@example.com", taxId: "123" } }]);

    const cfg = (connectors: ResolvedConfig["connectors"], mems: { connectorId: string; entity: string }[]): ResolvedConfig => ({
      connectors,
      channels: [{ id: "ch", members: mems.map(m => ({ ...m, inbound: TC_FIELD_MAP, outbound: TC_FIELD_MAP })), identity: ["email", "taxId"] }],
      conflict: {},
      readTimeoutMs: 10_000,
    });

    // Phase 1: onboard A+B using a 2-member channel so discover() doesn't need D or C
    const engineAB = new SyncEngine(cfg([inst("A", dA), inst("B", dB)], [
      { connectorId: "A", entity: "contacts" },
      { connectorId: "B", entity: "contacts" },
    ]), db);
    await engineAB.ingest("ch", "A", { batchId: crypto.randomUUID(), collectOnly: true });
    await engineAB.ingest("ch", "B", { batchId: crypto.randomUUID(), collectOnly: true });
    const reportAB = await engineAB.discover("ch");
    expect(reportAB.matched).toHaveLength(1); // a1+b1 match via email
    await engineAB.onboard("ch", reportAB);
    // canon-AB = {(A, a1), (B, b1)} — cross-linked, channel ready

    // Phase 2: expand to 3-member channel and collect D as a provisional (self-only)
    const engineABD = new SyncEngine(cfg([inst("A", dA), inst("B", dB), inst("D", dD)], [
      { connectorId: "A", entity: "contacts" },
      { connectorId: "B", entity: "contacts" },
      { connectorId: "D", entity: "contacts" },
    ]), db);
    await engineABD.ingest("ch", "D", { batchId: crypto.randomUUID(), collectOnly: true });
    // canon-D = {(D, d1)} — provisional, no A or B entries

    const canonABefore = canonicalFor(db, "A", "a1");
    const canonDProvisional = canonicalFor(db, "D", "d1");
    expect(canonABefore).toBeDefined();
    expect(canonDProvisional).toBeDefined();
    expect(canonABefore).not.toBe(canonDProvisional);

    // Phase 3: add C to 4-member channel. c1 bridges canon-AB (email) and canon-D (taxId).
    const engine4 = new SyncEngine(cfg([inst("A", dA), inst("B", dB), inst("D", dD), inst("C", dC)], [
      { connectorId: "A", entity: "contacts" },
      { connectorId: "B", entity: "contacts" },
      { connectorId: "D", entity: "contacts" },
      { connectorId: "C", entity: "contacts" },
    ]), db);
    await engine4.ingest("ch", "C", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine4.addConnector("ch", "C");

    const finalCanon = canonicalFor(db, "A", "a1");
    expect(finalCanon).toBeDefined();
    expect(canonicalFor(db, "B", "b1")).toBe(finalCanon);
    expect(canonicalFor(db, "C", "c1")).toBe(finalCanon);
    expect(canonicalFor(db, "D", "d1")).toBe(finalCanon);
    expect(canonicalIds(db).size).toBe(1);
  });
});

// ─── T-LG-1 ──────────────────────────────────────────────────────────────────

describe("T-LG-1: identityGroups compound group — no partial match", () => {
  it("records with only some fields of a compound group do NOT match", async () => {
    const db = openDb(":memory:");
    const [dA, dB] = [tmp(), tmp()];

    // A has only firstName+lastName, B has only dob — the compound group needs all three
    write(dA, "contacts.json", [{ id: "a1", data: { firstName: "Alice", lastName: "Smith" } }]);
    write(dB, "contacts.json", [{ id: "b1", data: { dob: "1990-01-01" } }]);

    const engine = new SyncEngine(
      {
        connectors: [inst("A", dA), inst("B", dB)],
        channels: [{
          id: "ch",
          members: [
            { connectorId: "A", entity: "contacts" },
            { connectorId: "B", entity: "contacts" },
          ],
          identity: [{ fields: ["firstName", "lastName", "dob"] }],
        }],
        conflict: {},
        readTimeoutMs: 10_000,
      },
      db,
    );

    await engine.ingest("ch", "A", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "B", { batchId: crypto.randomUUID(), collectOnly: true });
    const report = await engine.discover("ch");

    // No match — partial group is not a key
    expect(report.matched).toHaveLength(0);
    expect(report.uniquePerSide).toHaveLength(2);
  });
});

// ─── T-LG-2 ──────────────────────────────────────────────────────────────────

describe("T-LG-2: identityGroups compound group + transitive", () => {
  it("A matches B via email group; C matches B via compound group → A=B=C", async () => {
    const db = openDb(":memory:");
    const [dA, dB, dC] = [tmp(), tmp(), tmp()];

    write(dA, "contacts.json", [{ id: "a1", data: { email: "alice@example.com" } }]);
    write(dB, "contacts.json", [{ id: "b1", data: { email: "alice@example.com", firstName: "Alice", lastName: "Smith", dob: "1990-01-01" } }]);
    write(dC, "contacts.json", [{ id: "c1", data: { firstName: "Alice", lastName: "Smith", dob: "1990-01-01" } }]);

    const engine = new SyncEngine(
      {
        connectors: [inst("A", dA), inst("B", dB), inst("C", dC)],
        channels: [{
          id: "ch",
          members: [
            { connectorId: "A", entity: "contacts", inbound: TC_FIELD_MAP, outbound: TC_FIELD_MAP },
            { connectorId: "B", entity: "contacts", inbound: TC_FIELD_MAP, outbound: TC_FIELD_MAP },
            { connectorId: "C", entity: "contacts", inbound: TC_FIELD_MAP, outbound: TC_FIELD_MAP },
          ],
          identity: [
            { fields: ["email"] },
            { fields: ["firstName", "lastName", "dob"] },
          ],
        }],
        conflict: {},
        readTimeoutMs: 10_000,
      },
      db,
    );

    await engine.ingest("ch", "A", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "B", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "C", { batchId: crypto.randomUUID(), collectOnly: true });

    const report = await engine.discover("ch");
    expect(report.matched).toHaveLength(1);
    expect(report.matched[0].sides).toHaveLength(3);

    await engine.onboard("ch", report);

    const cA = canonicalFor(db, "A", "a1");
    const cB = canonicalFor(db, "B", "b1");
    const cC = canonicalFor(db, "C", "c1");
    expect(cA).toBe(cB);
    expect(cA).toBe(cC);
    expect(canonicalIds(db).size).toBe(1);
  });
});

// ─── T-LG-3 ──────────────────────────────────────────────────────────────────

describe("T-LG-3: identityGroups compound group at _resolveCanonical ingest time", () => {
  it("incoming record satisfying compound group matches existing canonical, not creating new one", async () => {
    const db = openDb(":memory:");
    const [dA, dB] = [tmp(), tmp()];

    // Collect A first so it has a provisional canonical
    write(dA, "contacts.json", [{ id: "a1", data: { firstName: "Alice", lastName: "Smith", dob: "1990-01-01" } }]);
    write(dB, "contacts.json", [{ id: "b1", data: { firstName: "Alice", lastName: "Smith", dob: "1990-01-01" } }]);

    const config = {
      connectors: [inst("A", dA), inst("B", dB)],
      channels: [{
        id: "ch",
        members: [
          { connectorId: "A", entity: "contacts", inbound: TC_FIELD_MAP, outbound: TC_FIELD_MAP },
          { connectorId: "B", entity: "contacts", inbound: TC_FIELD_MAP, outbound: TC_FIELD_MAP },
        ],
        identity: [{ fields: ["firstName", "lastName", "dob"] }],
      }],
      conflict: {},
      readTimeoutMs: 10_000,
    };

    const engineA = new SyncEngine(config, db);
    await engineA.ingest("ch", "A", { batchId: crypto.randomUUID(), collectOnly: true });

    const canonABefore = canonicalFor(db, "A", "a1");
    expect(canonABefore).toBeDefined();

    // Now ingest B normally — _resolveCanonical should find A's canonical via compound group
    const engineB = new SyncEngine(config, db);
    await engineB.ingest("ch", "B", { batchId: crypto.randomUUID() });

    const canonB = canonicalFor(db, "B", "b1");
    expect(canonB).toBe(canonABefore);
    expect(canonicalIds(db).size).toBe(1);
  });
});

// ─── T-LG-4 ──────────────────────────────────────────────────────────────────

describe("T-LG-4: identity compound group — only declared fields trigger a match", () => {
  it("records sharing an unlisted field are not matched when that field is not in any identity group", async () => {
    const db = openDb(":memory:");
    const [dA, dB] = [tmp(), tmp()];

    // A has email only; B has taxId only.
    // identity: [{ fields: ['taxId'] }] — only taxId matching.
    // A and B share no taxId value → should NOT match.
    write(dA, "contacts.json", [{ id: "a1", data: { email: "alice@example.com" } }]);
    write(dB, "contacts.json", [{ id: "b1", data: { taxId: "123" } }]);

    const engine = new SyncEngine(
      {
        connectors: [inst("A", dA), inst("B", dB)],
        channels: [{
          id: "ch",
          members: [
            { connectorId: "A", entity: "contacts" },
            { connectorId: "B", entity: "contacts" },
          ],
          identity: [{ fields: ["taxId"] }],
        }],
        conflict: {},
        readTimeoutMs: 10_000,
      },
      db,
    );

    await engine.ingest("ch", "A", { batchId: crypto.randomUUID(), collectOnly: true });
    await engine.ingest("ch", "B", { batchId: crypto.randomUUID(), collectOnly: true });
    const report = await engine.discover("ch");

    // Compound group on taxId: A has no taxId → no match.
    expect(report.matched).toHaveLength(0);
    expect(report.uniquePerSide).toHaveLength(2);
  });
});
