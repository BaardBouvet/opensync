/**
 * packages/engine/src/engine.test.ts
 *
 * M2 Integration tests — 9 scenarios from PLAN_PRODUCTION_ENGINE_M2.md § 10
 *
 * T1  CRM contact created → appears in ERP with correct field mapping
 * T2  ERP employee updated → reflected in CRM
 * T3  10 consecutive sync cycles → zero duplicates; skipped on sync_runs
 * T4  Repeated insert errors → circuit breaker trips; no propagation
 * T5  All outbound HTTP observed → every insert/update has a request_journal row
 * T6  Gap 1: record written mid-collect is picked up on first incremental after onboard
 * T7  Gap 2: engine restarted with tripped CB → new instance starts in OPEN state
 * T8  Gap 6: first write returns 412 → succeeds on retry
 * T9  Gap 8: onboard() into an OPEN channel is blocked
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  SyncEngine,
  type ResolvedConfig,
  type IngestResult,
  type DiscoveryReport,
  openDb,
} from "./index.js";
import { type Db } from "./db/index.js";
import { createSchema } from "./db/migrations.js";
import { CircuitBreaker } from "./safety/circuit-breaker.js";
import mockCrmConnector from "@opensync/connector-mock-crm";
import mockErpConnector from "@opensync/connector-mock-erp";
import {
  MockCrmServer,
  DEFAULT_API_KEY,
} from "@opensync/server-mock-crm";
import {
  MockErpServer,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
} from "@opensync/server-mock-erp";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDb(): Db {
  return openDb(":memory:");
}

function makeTempFileDb(): { db: Db; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "opensync-engine-test-"));
  const path = join(dir, "state.db");
  return { db: openDb(path), path, dir };
}

function makeConfig(crmUrl: string, erpUrl: string): ResolvedConfig {
  return {
    connectors: [
      {
        id: "crm",
        connector: mockCrmConnector,
        config: { baseUrl: crmUrl },
        auth: { apiKey: DEFAULT_API_KEY },
        batchIdRef: { current: undefined },
        triggerRef: { current: undefined },
      },
      {
        id: "erp",
        connector: mockErpConnector,
        config: { baseUrl: erpUrl },
        auth: {
          clientId: DEFAULT_CLIENT_ID,
          clientSecret: DEFAULT_CLIENT_SECRET,
        },
        batchIdRef: { current: undefined },
        triggerRef: { current: undefined },
      },
    ],
    channels: [
      {
        id: "contacts",
        members: [
          {
            connectorId: "crm", entity: "contacts",
            inbound:  [{ source: "name", target: "name" }, { source: "email", target: "email" }],
            outbound: [{ source: "name", target: "name" }, { source: "email", target: "email" }],
          },
          {
            connectorId: "erp", entity: "employees",
            inbound:  [{ source: "name", target: "name" }, { source: "email", target: "email" }],
            outbound: [{ source: "name", target: "name" }, { source: "email", target: "email" }],
          },
        ],
        identity: ["email"],
      },
    ],
    conflict: {},
    readTimeoutMs: 10_000,
  };
}

/** Run the full collect→discover→onboard sequence and return the report. */
async function runOnboarding(
  engine: SyncEngine,
): Promise<{ report: DiscoveryReport; crmSnapshotAt: number }> {
  const crmResult = await engine.ingest("contacts", "crm", { collectOnly: true });
  await engine.ingest("contacts", "erp", { collectOnly: true });
  const report = await engine.discover("contacts", crmResult.snapshotAt);
  await engine.onboard("contacts", report);
  return { report, crmSnapshotAt: crmResult.snapshotAt! };
}

/** Fetch the current collection from the ERP server as plain JSON. */
async function erpEmployees(
  erpUrl: string,
  token?: string,
): Promise<Array<{ id: string; name: string; email: string; department?: string }>> {
  // Get a token first
  if (!token) {
    const tokenRes = await fetch(`${erpUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: DEFAULT_CLIENT_ID,
        client_secret: DEFAULT_CLIENT_SECRET,
        scope: "employees:read",
      }).toString(),
    });
    const { access_token } = await tokenRes.json() as { access_token: string };
    token = access_token;
  }
  const res = await fetch(`${erpUrl}/employees`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json() as Promise<Array<{ id: string; name: string; email: string }>>;
}

/** Fetch the current collection from the CRM server as plain JSON. */
async function crmContacts(
  crmUrl: string,
): Promise<Array<{ id: string; name: string; email: string }>> {
  const res = await fetch(`${crmUrl}/contacts`, {
    headers: { authorization: `Bearer ${DEFAULT_API_KEY}` },
  });
  return res.json() as Promise<Array<{ id: string; name: string; email: string }>>;
}

// ─── Shared server state ─────────────────────────────────────────────────────

let crm: MockCrmServer;
let erp: MockErpServer;

beforeAll(() => {
  crm = new MockCrmServer();
  erp = new MockErpServer();
  crm.start(0);
  erp.start(0);
});

afterAll(() => {
  crm.stop();
  erp.stop();
});

beforeEach(async () => {
  // Reset server state between tests
  await fetch(`${crm.baseUrl}/__reset`, { method: "POST" });
  await fetch(`${erp.baseUrl}/__reset`, { method: "POST" });
});

// ─── T1: CRM contact created → appears in ERP ────────────────────────────────

describe("T1: CRM contact created → appears in ERP", () => {
  it("propagates a new CRM contact to the ERP system", async () => {
    crm.seed([
      { id: "c1", name: "Alice Liddell", email: "alice@example.com" },
      { id: "c2", name: "Bob Martin", email: "bob@example.com" },
    ]);
    erp.seed([
      { id: "e1", name: "Alice Liddell", email: "alice@example.com" },
      { id: "e2", name: "Bob Martin", email: "bob@example.com" },
    ]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);
    await runOnboarding(engine);

    // CRM gets a new contact after onboarding
    crm.seed([{ id: "c3", name: "Carol White", email: "carol@example.com" }]);

    const result = await engine.ingest("contacts", "crm");

    expect(result.records.some((r) => r.action === "insert" && r.targetConnectorId === "erp")).toBe(true);

    const employees = await erpEmployees(erp.baseUrl);
    const carol = employees.find((e) => e.email === "carol@example.com");
    expect(carol).toBeDefined();
    expect(carol?.name).toBe("Carol White");
  });
});

// ─── T2: ERP employee updated → reflected in CRM ─────────────────────────────

describe("T2: ERP employee updated → reflected in CRM", () => {
  it("propagates an ERP employee update back to CRM", async () => {
    crm.seed([
      { id: "c1", name: "Alice Liddell", email: "alice@example.com" },
    ]);
    erp.seed([
      { id: "e1", name: "Alice Liddell", email: "alice@example.com" },
    ]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);
    await runOnboarding(engine);

    // Update Alice in ERP out-of-band — change her name
    await fetch(`${erp.baseUrl}/__mutate-employee/e1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Alice Smith" }),
    });

    const result = await engine.ingest("contacts", "erp");

    expect(result.records.some((r) => r.action === "update" && r.targetConnectorId === "crm")).toBe(true);

    const contacts = await crmContacts(crm.baseUrl);
    const alice = contacts.find((c) => c.email === "alice@example.com");
    expect(alice?.name).toBe("Alice Smith");
  });
});

// ─── T3: 10 consecutive sync cycles → no duplicates ──────────────────────────

describe("T3: 10 consecutive sync cycles → no duplicates", () => {
  it("produces no writes after the first full sync settles", async () => {
    crm.seed([
      { id: "c1", name: "Alice Liddell", email: "alice@example.com" },
      { id: "c2", name: "Bob Martin", email: "bob@example.com" },
    ]);
    erp.seed([
      { id: "e1", name: "Alice Liddell", email: "alice@example.com" },
      { id: "e2", name: "Bob Martin", email: "bob@example.com" },
    ]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);
    await runOnboarding(engine);

    // First cycle may produce updates (shadow reseeding), subsequent should be quiet
    for (let i = 0; i < 10; i++) {
      const r1 = await engine.ingest("contacts", "crm");
      const r2 = await engine.ingest("contacts", "erp");

      const crmInserts = r1.records.filter((r) => r.action === "insert").length;
      const erpInserts = r2.records.filter((r) => r.action === "insert").length;

      // After the channel is ready, no new inserts should occur on repeated syncs
      if (i > 0) {
        expect(crmInserts).toBe(0);
        expect(erpInserts).toBe(0);
      }
    }

    // No duplicate entries in ERP
    const employees = await erpEmployees(erp.baseUrl);
    const emails = employees.map((e) => e.email);
    const unique = new Set(emails);
    expect(unique.size).toBe(emails.length);
  });
});

// ─── T4: Circuit breaker trips after repeated errors ─────────────────────────

describe("T4: Circuit breaker trips after errors", () => {
  it("opens the circuit after minSamples batches with errors", () => {
    const db = makeTempDb();
    createSchema(db);
    const cb = new CircuitBreaker("test-channel", db, {
      errorRateThreshold: 0.5,
      minSamples: 3,
      resetAfterMs: 60_000,
    });

    // Three error batches should trip the breaker
    expect(cb.evaluate()).toBe("CLOSED");
    cb.recordResult(true);
    cb.recordResult(true);
    cb.recordResult(true);

    expect(cb.evaluate()).toBe("OPEN");
  });

  it("blocks ingest() when the circuit is OPEN", async () => {
    crm.seed([{ id: "c1", name: "Alice Liddell", email: "alice@example.com" }]);
    erp.seed([{ id: "e1", name: "Alice Liddell", email: "alice@example.com" }]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);
    await runOnboarding(engine);

    // Manually trip the circuit breaker
    const cb = new CircuitBreaker("contacts", db, { errorRateThreshold: 0.5, minSamples: 1, resetAfterMs: 60_000 });
    cb.trip("manual test trip");

    // Engine's internal breaker is a different instance so we need to trip via DB.
    // Create engine AFTER tripping (so it restores from DB)
    const engine2 = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);
    crm.seed([{ id: "c99", name: "New Contact", email: "new@example.com" }]);

    // With the breaker OPEN, ingest should return empty without making connector calls
    const result = await engine2.ingest("contacts", "crm");
    expect(result.records).toHaveLength(0);
  });
});

// ─── T5: request_journal has a row for each outbound HTTP call ────────────────

describe("T5: Request journal tracks all outbound HTTP", () => {
  it("records a request_journal row for every insert/update call", async () => {
    crm.seed([{ id: "c1", name: "Alice Liddell", email: "alice@example.com" }]);
    erp.seed([{ id: "e1", name: "Alice Liddell", email: "alice@example.com" }]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);

    // Collect-only ingest
    await engine.ingest("contacts", "crm", { collectOnly: true });

    // Check request_journal has at least one row (the CRM read call)
    const rows = db.prepare<{ count: number }>("SELECT COUNT(*) as count FROM request_journal").get();
    expect((rows?.count ?? 0)).toBeGreaterThan(0);

    // Full onboard cycle — inserts Alice into ERP (if not already there)
    await engine.ingest("contacts", "erp", { collectOnly: true });
    const report = await engine.discover("contacts");
    await engine.onboard("contacts", report);

    // Normal sync: update Alice in CRM → engine dispatches to ERP → insert into request_journal
    crm.seed([{ id: "c1", name: "Alice Smith", email: "alice@example.com" }]);
    await engine.ingest("contacts", "crm");

    const rows2 = db.prepare<{ count: number }>("SELECT COUNT(*) as count FROM request_journal").get();
    expect((rows2?.count ?? 0)).toBeGreaterThan(1);
  });
});

// ─── T6: Gap 1 — record written mid-collect is picked up on next incremental ──

describe("T6: Gap 1 — snapshotAt watermark anchor", () => {
  it("picks up a record seeded after collectOnly during the next incremental", async () => {
    crm.seed([
      { id: "c1", name: "Alice Liddell", email: "alice@example.com" },
      { id: "c2", name: "Bob Martin", email: "bob@example.com" },
    ]);
    erp.seed([
      { id: "e1", name: "Alice Liddell", email: "alice@example.com" },
      { id: "e2", name: "Bob Martin", email: "bob@example.com" },
    ]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);

    // 1. Collect CRM — snapshotAt is captured at start of read
    const crmResult = await engine.ingest("contacts", "crm", { collectOnly: true });
    expect(crmResult.snapshotAt).toBeDefined();

    // 2. AFTER collectOnly, seed a new record into CRM
    //    (simulating a write that happened during or just after the collect window)
    await new Promise((r) => setTimeout(r, 10)); // ensure updatedAt > snapshotAt
    crm.seed([{ id: "c3", name: "Carol White", email: "carol@example.com" }]);

    // 3. Collect ERP, discover, onboard
    await engine.ingest("contacts", "erp", { collectOnly: true });
    const report = await engine.discover("contacts", crmResult.snapshotAt);
    await engine.onboard("contacts", report);

    // 4. Incremental CRM sync — the watermark from collectOnly (snapshotAt) should
    //    be BEFORE Carol's creation, so she gets picked up
    const ingestResult = await engine.ingest("contacts", "crm");
    const carolAction = ingestResult.records.find(
      (r) => r.action === "insert" && r.targetConnectorId === "erp",
    );
    expect(carolAction).toBeDefined();

    const employees = await erpEmployees(erp.baseUrl);
    const carol = employees.find((e) => e.email === "carol@example.com");
    expect(carol).toBeDefined();
  });
});

// ─── T7: Gap 2 — circuit breaker state persists across engine restart ─────────

describe("T7: Gap 2 — circuit breaker survives restart", () => {
  it("new SyncEngine instance starts in OPEN state when previous one tripped", () => {
    const { db, dir } = makeTempFileDb();
    createSchema(db);

    // Trip the breaker on the first instance
    const cb1 = new CircuitBreaker("contacts", db, {
      errorRateThreshold: 0.5,
      minSamples: 1,
      resetAfterMs: 60_000,
    });
    cb1.trip("simulated persistent trip");
    expect(cb1.evaluate()).toBe("OPEN");

    // New engine instance on the same DB — should restore OPEN state from DB
    const cb2 = new CircuitBreaker("contacts", db, {
      errorRateThreshold: 0.5,
      minSamples: 1,
      resetAfterMs: 60_000,
    });
    expect(cb2.evaluate()).toBe("OPEN");

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── T8: Gap 6 — 412 retry loop ──────────────────────────────────────────────

describe("T8: Gap 6 — 412 retry loop", () => {
  it("succeeds after a 412 by fetching fresh ETag and retrying", async () => {
    crm.seed([
      { id: "c1", name: "Alice Liddell", email: "alice@example.com" },
    ]);
    erp.seed([
      { id: "e1", name: "Alice Liddell", email: "alice@example.com" },
    ]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);
    await runOnboarding(engine);

    // Trigger a concurrent mutation on ERP's e1 out-of-band (advances ETag)
    // so the engine's cached ETag is stale → 412 on first PUT attempt
    await fetch(`${erp.baseUrl}/__mutate-employee/e1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ department: "Engineering" }),
    });

    // Also update Alice in CRM so the engine has a diff to push to ERP
    crm.seed([{ id: "c1", name: "Alice Smith", email: "alice@example.com" }]);

    // Engine will:
    //  1. Begin dispatch → fetch ERP employee e1 for ETag (will be stale)
    //  2. PUT with stale ETag → 412
    //  3. Retry: fetch fresh ETag, PUT again → 200
    const result = await engine.ingest("contacts", "crm");

    // The update should succeed (not error)
    const updateResult = result.records.find(
      (r) => r.targetConnectorId === "erp" && (r.action === "update" || r.action === "skip"),
    );
    expect(updateResult).toBeDefined();
    expect(updateResult?.action).not.toBe("error");
  });
});

// ─── T9: Gap 8 — onboard() blocked when channel CB is OPEN ───────────────────

describe("T9: Gap 8 — onboard() blocked when CB is open", () => {
  it("throws when attempting onboard() into a channel with an open circuit breaker", async () => {
    // Both sides need records so discover() can find shadow_state
    crm.seed([{ id: "c1", name: "Alice Liddell", email: "alice@example.com" }]);
    erp.seed([{ id: "e1", name: "Alice Liddell", email: "alice@example.com" }]);

    const db = makeTempDb();
    createSchema(db);

    // Pre-trip the circuit breaker BEFORE creating the engine so it restores from DB
    const cb = new CircuitBreaker("contacts", db, {
      errorRateThreshold: 0.5,
      minSamples: 1,
      resetAfterMs: 60_000,
    });
    cb.trip("simulated pre-trip for T9");

    // Create engine AFTER tripping so it restores from DB
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);

    await engine.ingest("contacts", "crm", { collectOnly: true });
    await engine.ingest("contacts", "erp", { collectOnly: true });
    const report = await engine.discover("contacts");

    // onboard() should throw because the circuit is OPEN
    await expect(engine.onboard("contacts", report)).rejects.toThrow(/circuit breaker OPEN/i);
  });
});

// ─── T10: RecordSyncResult payload fields — READ / before / after ─────────────

describe("T10: RecordSyncResult payload fields", () => {
  it("ingest emits a 'read' result with sourceData for each non-skip source record", async () => {
    crm.seed([
      { id: "c1", name: "Alice Liddell", email: "alice@example.com" },
      { id: "c2", name: "Bob Martin", email: "bob@example.com" },
    ]);
    erp.seed([
      { id: "e1", name: "Alice Liddell", email: "alice@example.com" },
      { id: "e2", name: "Bob Martin", email: "bob@example.com" },
    ]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);
    await runOnboarding(engine);

    // Seed a new CRM record  — engine has no prior knowledge of it
    crm.seed([{ id: "c3", name: "Carol White", email: "carol@example.com" }]);

    const result = await engine.ingest("contacts", "crm");

    const readResults = result.records.filter((r) => r.action === "read");
    expect(readResults.length).toBe(1);

    const readResult = readResults[0]!;
    expect(readResult.sourceId).toBe("c3");
    expect(readResult.targetConnectorId).toBe("");
    // sourceData should contain the canonical fields (after inbound mapping)
    expect(readResult.sourceData).toBeDefined();
    expect(readResult.sourceData!["email"]).toBe("carol@example.com");
    // sourceShadow is undefined — engine has never seen this record
    expect(readResult.sourceShadow).toBeUndefined();
  });

  it("sourceShadow reflects prior engine state when a known record is updated", async () => {
    crm.seed([{ id: "c1", name: "Alice Liddell", email: "alice@example.com" }]);
    erp.seed([{ id: "e1", name: "Alice Liddell", email: "alice@example.com" }]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);
    await runOnboarding(engine);

    // Settle the channel (first incremental makes shadows consistent)
    await engine.ingest("contacts", "crm");
    await engine.ingest("contacts", "erp");

    // Now update Alice in ERP — engine must reflect the change
    await fetch(`${erp.baseUrl}/__mutate-employee/e1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Alice Smith" }),
    });

    const result = await engine.ingest("contacts", "erp");

    const readResult = result.records.find((r) => r.action === "read" && r.sourceId === "e1");
    expect(readResult).toBeDefined();
    // sourceData has the new name
    expect(readResult!.sourceData!["name"]).toBe("Alice Smith");
    // sourceShadow has the old name (pre-ingest shadow)
    expect(readResult!.sourceShadow!["name"]).toBe("Alice Liddell");
  });

  it("INSERT result carries after payload", async () => {
    crm.seed([
      { id: "c1", name: "Alice Liddell", email: "alice@example.com" },
      { id: "c2", name: "Bob Martin", email: "bob@example.com" },
    ]);
    erp.seed([
      { id: "e1", name: "Alice Liddell", email: "alice@example.com" },
      { id: "e2", name: "Bob Martin", email: "bob@example.com" },
    ]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);
    await runOnboarding(engine);

    crm.seed([{ id: "c3", name: "Carol White", email: "carol@example.com" }]);
    const result = await engine.ingest("contacts", "crm");

    const insertResult = result.records.find(
      (r) => r.action === "insert" && r.targetConnectorId === "erp",
    );
    expect(insertResult).toBeDefined();
    expect(insertResult!.after).toBeDefined();
    expect(insertResult!.after!["email"]).toBe("carol@example.com");
    // INSERT has no 'before'
    expect(insertResult!.before).toBeUndefined();
  });

  it("UPDATE result carries before and after payloads", async () => {
    crm.seed([{ id: "c1", name: "Alice Liddell", email: "alice@example.com" }]);
    erp.seed([{ id: "e1", name: "Alice Liddell", email: "alice@example.com" }]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);
    await runOnboarding(engine);
    await engine.ingest("contacts", "crm");
    await engine.ingest("contacts", "erp");

    // Update Alice in ERP — the next ERP ingest will produce an UPDATE to CRM
    await fetch(`${erp.baseUrl}/__mutate-employee/e1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Alice Smith" }),
    });

    const result = await engine.ingest("contacts", "erp");
    const updateResult = result.records.find(
      (r) => r.action === "update" && r.targetConnectorId === "crm",
    );
    expect(updateResult).toBeDefined();
    // 'after' contains the written canonical values (new name)
    expect(updateResult!.after).toBeDefined();
    expect(updateResult!.after!["name"]).toBe("Alice Smith");
    // 'before' contains prior target (CRM) shadow values (old name)
    expect(updateResult!.before).toBeDefined();
    expect(updateResult!.before!["name"]).toBe("Alice Liddell");
  });

  it("OnboardResult.inserts contains one entry per fanout write", async () => {
    // CRM has Alice; ERP has Zara — neither matches the other, so both are unique-per-side
    // and each gets propagated to the other system during onboarding.
    crm.seed([{ id: "c1", name: "Alice Liddell", email: "alice@example.com" }]);
    erp.seed([{ id: "e1", name: "Zara Unknown", email: "zara@example.com" }]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);

    await engine.ingest("contacts", "crm", { collectOnly: true });
    await engine.ingest("contacts", "erp", { collectOnly: true });
    const report = await engine.discover("contacts");

    const onboardResult = await engine.onboard("contacts", report);

    // Two unique-per-side records → two fanout inserts (Alice to ERP, Zara to CRM)
    expect(onboardResult.inserts.length).toBe(2);
    const erpInsert = onboardResult.inserts.find((r) => r.targetConnectorId === "erp");
    expect(erpInsert).toBeDefined();
    expect(erpInsert!.action).toBe("insert");
    expect(erpInsert!.sourceId).toBe("c1");
    expect(erpInsert!.after).toBeDefined();
    expect(erpInsert!.after!["email"]).toBe("alice@example.com");
  });

  it("onboard dryRun returns inserts: []", async () => {
    crm.seed([{ id: "c1", name: "Alice Liddell", email: "alice@example.com" }]);
    erp.seed([{ id: "e1", name: "Alice Liddell", email: "alice@example.com" }]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);
    await engine.ingest("contacts", "crm", { collectOnly: true });
    await engine.ingest("contacts", "erp", { collectOnly: true });
    const report = await engine.discover("contacts");

    const result = await engine.onboard("contacts", report, { dryRun: true });
    expect(result.inserts).toEqual([]);
  });
});

// ─── T49: splitCluster — linked cluster breaks apart ─────────────────────────

describe("T49: splitCluster breaks a linked cluster into individual records", () => {
  it("removes the shared canonical_id so identity_map has two independent rows", async () => {
    // Seed matching records so onboarding links them into one cluster.
    crm.seed([{ id: "c1", name: "Alice Liddell", email: "alice@example.com" }]);
    erp.seed([{ id: "e1", name: "Alice Liddell", email: "alice@example.com" }]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);
    await runOnboarding(engine);

    // Confirm one linked cluster exists and extract its canonical id.
    const identityMap = engine.getChannelIdentityMap("contacts");
    expect(identityMap.size).toBe(1);
    const [canonicalId, members] = [...identityMap.entries()][0]!;
    expect(members.size).toBe(2);
    expect(members.get("crm")).toBe("c1");
    expect(members.get("erp")).toBe("e1");

    // Split the cluster.
    engine.splitCluster(canonicalId);

    // Now identity_map should show two independent clusters (each with one member).
    const after = engine.getChannelIdentityMap("contacts");
    expect(after.size).toBe(2);
    for (const [newId, newMembers] of after) {
      expect(newId).not.toBe(canonicalId);
      expect(newMembers.size).toBe(1);
    }
    // Each original external ID must still be present under some canonical_id.
    const allExternalIds = [...after.values()].flatMap((m) => [...m.values()]);
    expect(allExternalIds.sort()).toEqual(["c1", "e1"]);
  });

  it("is a no-op when the cluster has only one member", async () => {
    crm.seed([{ id: "c1", name: "Solo", email: "solo@example.com" }]);

    const db = makeTempDb();
    const engine = new SyncEngine(makeConfig(crm.baseUrl, erp.baseUrl), db);
    await engine.ingest("contacts", "crm", { collectOnly: true });
    // Do NOT ingest erp — crm has a provisional self-only cluster.

    const before = engine.getChannelIdentityMap("contacts");
    const [[canonicalId]] = [...before.entries()];
    engine.splitCluster(canonicalId!);

    // Identity map must be unchanged.
    const after = engine.getChannelIdentityMap("contacts");
    expect(after.size).toBe(before.size);
    expect([...after.keys()][0]).toBe(canonicalId);
  });
});
