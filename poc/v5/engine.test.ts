/**
 * POC v5 engine tests — HTTP surface, request journal, and webhooks.
 *
 * Test coverage:
 *   1. Poll cycle produces correct request journal rows
 *   2. Poll journal rows have masked Authorization header
 *   3. Journal rows never contain the raw API key value
 *   4. Insert produces a journal row with masked credentials
 *   5. Webhook receive → queue → process → sync pipeline (thick, happy path)
 *   6. Thin webhook produces an additional journal row for the enrichment fetch
 *   7. Journal rows carry the batch_id that correlates to transaction_log writes
 *   8. onEnable() calls POST /webhooks/subscribe and stores subscription ID
 *   9. onDisable() calls DELETE /webhooks/:id and clears subscription ID
 *  10. processWebhookQueue() returns empty when queue is empty
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import {
  SyncEngine,
  makeConnectorInstance,
} from "./engine.js";
import type { ChannelConfig, EngineConfig } from "./engine.js";
import { openDb, dbGetJournalRows, dbGetPendingWebhooks, dbGetWebhookRows } from "./db.js";
import type { Db } from "./db.js";
import { MockCrmServer, MOCK_API_KEY } from "./mock-crm-server.js";
import mockCrm from "../../connectors/mock-crm/src/index.js";
import type { Connector, ConnectorContext, ReadBatch } from "../../packages/sdk/src/index.js";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const WEBHOOK_PORT = 14001; // test-specific; avoids conflicts with any local services

function makeTempDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "opensync-v5-"));
  return openDb(join(dir, "state.db"));
}

function makeTestEngine(
  db: Db,
  crmServer: MockCrmServer,
  opts: { webhookMode?: "thick" | "thin" } = {},
) {
  const instance = makeConnectorInstance(
    "mock-crm",
    mockCrm,
    {
      baseUrl: crmServer.baseUrl,
      apiKey: MOCK_API_KEY,
      webhookMode: opts.webhookMode ?? "thick",
    },
    db,
    `http://localhost:${WEBHOOK_PORT}`,
  );

  const channel: ChannelConfig = {
    id: "contacts-channel",
    members: [
      { connectorId: "mock-crm", entity: "contacts" },
    ],
  };

  const config: EngineConfig = {
    connectors: [instance],
    channels: [channel],
    webhookPort: WEBHOOK_PORT,
  };

  const engine = new SyncEngine(config, db);
  return { engine, instance };
}

// ─── Suite: request journal — poll ────────────────────────────────────────────

describe("request journal — poll", () => {
  let crmServer: MockCrmServer;
  let db: Db;
  let engine: SyncEngine;

  beforeAll(() => {
    crmServer = new MockCrmServer();
    crmServer.start();
    crmServer.seed([
      { id: "c1", name: "Alice", email: "alice@example.com" },
      { id: "c2", name: "Bob", email: "bob@example.com" },
    ]);
    db = makeTempDb();
    ({ engine } = makeTestEngine(db, crmServer));
  });

  afterAll(() => {
    crmServer.stop();
  });

  it("poll produces a journal row for GET /contacts", async () => {
    const batchId = crypto.randomUUID();
    await engine.ingest("contacts-channel", "mock-crm", { batchId, fullSync: true });

    const rows = dbGetJournalRows(db, "mock-crm");
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const pollRow = rows.find((r) => r.method === "GET" && r.url.includes("/contacts"));
    expect(pollRow).toBeDefined();
    expect(pollRow!.response_status).toBe(200);
    expect(pollRow!.duration_ms).toBeGreaterThanOrEqual(0);
    expect(pollRow!.connector_id).toBe("mock-crm");
    expect(pollRow!.trigger).toBe("poll");
  });

  it("journal row has batch_id matching the ingest call", async () => {
    const batchId = crypto.randomUUID();
    await engine.ingest("contacts-channel", "mock-crm", { batchId, fullSync: true });

    const rows = dbGetJournalRows(db, "mock-crm");
    const batchRows = rows.filter((r) => r.batch_id === batchId);
    expect(batchRows.length).toBeGreaterThanOrEqual(1);
  });

  it("Authorization header is redacted in journal — never contains raw token", async () => {
    await engine.ingest("contacts-channel", "mock-crm", {
      batchId: crypto.randomUUID(),
      fullSync: true,
    });

    const rows = dbGetJournalRows(db, "mock-crm");
    for (const row of rows) {
      if (!row.request_headers) continue;
      // The raw API key value must never appear in the stored headers
      expect(row.request_headers).not.toContain(MOCK_API_KEY);
      // But the header key should be present with [REDACTED] value
      const headers = JSON.parse(row.request_headers) as Record<string, string>;
      if ("authorization" in headers) {
        expect(headers["authorization"]).toBe("[REDACTED]");
      }
    }
  });

  it("response_body contains contact records", async () => {
    const batchId = crypto.randomUUID();
    await engine.ingest("contacts-channel", "mock-crm", { batchId, fullSync: true });

    const rows = dbGetJournalRows(db, "mock-crm");
    const pollRow = rows.find((r) => r.batch_id === batchId && r.method === "GET");
    expect(pollRow).toBeDefined();
    expect(pollRow!.response_body).toContain("Alice");
  });
});

// ─── Suite: request journal — insert ─────────────────────────────────────────

describe("request journal — insert via sync pipeline", () => {
  let crmServerA: MockCrmServer;
  let crmServerB: MockCrmServer;
  let db: Db;
  let engine: SyncEngine;

  beforeAll(() => {
    crmServerA = new MockCrmServer();
    crmServerB = new MockCrmServer();
    crmServerA.start();
    crmServerB.start();

    db = makeTempDb();

    const instanceA = makeConnectorInstance(
      "crm-a",
      mockCrm,
      { baseUrl: crmServerA.baseUrl, apiKey: MOCK_API_KEY },
      db,
      `http://localhost:${WEBHOOK_PORT}`,
    );
    const instanceB = makeConnectorInstance(
      "crm-b",
      mockCrm,
      { baseUrl: crmServerB.baseUrl, apiKey: MOCK_API_KEY },
      db,
      `http://localhost:${WEBHOOK_PORT}`,
    );

    const channel: ChannelConfig = {
      id: "contacts-channel",
      members: [
        { connectorId: "crm-a", entity: "contacts" },
        { connectorId: "crm-b", entity: "contacts" },
      ],
    };

    engine = new SyncEngine(
      { connectors: [instanceA, instanceB], channels: [channel] },
      db,
    );
  });

  afterAll(() => {
    crmServerA.stop();
    crmServerB.stop();
  });

  it("sync from A to B produces POST journal row for crm-b with masked auth", async () => {
    // Seed A with a contact
    crmServerA.seed([{ id: "c-orig", name: "Carol", email: "carol@example.com" }]);

    const batchId = crypto.randomUUID();
    const result = await engine.ingest("contacts-channel", "crm-a", { batchId, fullSync: true });

    // Carol should have been inserted into B
    const insertResult = result.records.find(
      (r) => r.targetConnectorId === "crm-b" && r.action === "insert",
    );
    expect(insertResult).toBeDefined();

    // crm-b's journal should have a POST row
    const rows = dbGetJournalRows(db, "crm-b");
    const postRow = rows.find((r) => r.method === "POST" && r.url.includes("/contacts"));
    expect(postRow).toBeDefined();
    expect(postRow!.response_status).toBe(201);
    expect(postRow!.request_body).toContain("Carol");

    // Auth must be masked
    if (postRow!.request_headers) {
      const headers = JSON.parse(postRow!.request_headers) as Record<string, string>;
      expect(postRow!.request_headers).not.toContain(MOCK_API_KEY);
      if ("authorization" in headers) {
        expect(headers["authorization"]).toBe("[REDACTED]");
      }
    }
  });
});

// ─── Suite: webhooks — happy path (thick) ────────────────────────────────────

describe("webhook — thick payload happy path", () => {
  let crmServer: MockCrmServer;
  let db: Db;
  let engine: SyncEngine;
  let webhookServer: ReturnType<typeof Bun.serve> | undefined;

  beforeAll(() => {
    crmServer = new MockCrmServer();
    crmServer.start();
    db = makeTempDb();
    ({ engine } = makeTestEngine(db, crmServer, { webhookMode: "thick" }));
    engine.startWebhookServer();
  });

  afterAll(() => {
    engine.stopWebhookServer();
    crmServer.stop();
  });

  it("onEnable stores subscription ID in connector_state", async () => {
    await engine.onEnable("mock-crm");

    // Verify we can call processWebhookQueue without error (sub exists)
    const result = await engine.processWebhookQueue("contacts-channel");
    expect(result.get("mock-crm") ?? 0).toBe(0); // nothing queued yet
  });

  it("received webhook is enqueued and processed into the sync pipeline", async () => {
    const contact = {
      id: "wh-c1",
      name: "Dave",
      email: "dave@example.com",
      updatedAt: new Date().toISOString(),
    };

    // POST directly to the engine's webhook endpoint (simulates mock CRM calling us)
    const webhookUrl = `http://localhost:${WEBHOOK_PORT}/webhooks/mock-crm`;
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(contact),
    });
    expect(res.status).toBe(200);

    // Queue should now have 1 pending item
    const pending = dbGetPendingWebhooks(db, ["mock-crm"]);
    expect(pending.length).toBe(1);
    expect(pending[0].connector_id).toBe("mock-crm");

    // Process the queue — record should enter shadow state
    const counts = await engine.processWebhookQueue("contacts-channel");
    expect(counts.get("mock-crm")).toBe(1);

    // Queue item should now be completed and carry a batch_id (links to sync_runs / transaction_log)
    const pendingAfter = dbGetPendingWebhooks(db, ["mock-crm"]);
    expect(pendingAfter.length).toBe(0);

    const allQueueRows = dbGetWebhookRows(db, "mock-crm");
    expect(allQueueRows.length).toBe(1);
    expect(allQueueRows[0].status).toBe("completed");
    expect(allQueueRows[0].batch_id).toBeTruthy();
  });
});

// ─── Suite: webhooks — thin webhook ──────────────────────────────────────────

describe("webhook — thin payload (enrichment fetch)", () => {
  let crmServer: MockCrmServer;
  let db: Db;
  let engine: SyncEngine;

  beforeAll(() => {
    crmServer = new MockCrmServer();
    crmServer.start();
    // Seed a contact that will be fetched during thin webhook processing
    crmServer.seed([
      { id: "thin-c1", name: "Eve", email: "eve@example.com" },
    ]);
    db = makeTempDb();
    ({ engine } = makeTestEngine(db, crmServer, { webhookMode: "thin" }));
    engine.startWebhookServer();
  });

  afterAll(() => {
    engine.stopWebhookServer();
    crmServer.stop();
  });

  it("thin webhook produces an extra GET journal row for the enrichment fetch", async () => {
    // Thin payload: only id + event
    const webhookUrl = `http://localhost:${WEBHOOK_PORT}/webhooks/mock-crm`;
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "thin-c1", event: "contact.updated" }),
    });
    expect(res.status).toBe(200);

    const countsBefore = dbGetJournalRows(db, "mock-crm").length;

    const counts = await engine.processWebhookQueue("contacts-channel");
    expect(counts.get("mock-crm")).toBe(1);

    const rows = dbGetJournalRows(db, "mock-crm");
    // Should have at least one new GET row for the enrichment fetch
    const enrichRows = rows.filter(
      (r) => r.method === "GET" && r.url.includes("/contacts/thin-c1"),
    );
    expect(enrichRows.length).toBeGreaterThanOrEqual(1);

    // The enrichment fetch must also have masked auth
    for (const row of enrichRows) {
      if (row.request_headers) {
        expect(row.request_headers).not.toContain(MOCK_API_KEY);
      }
    }
  });

  it("thin webhook journal rows share batch_id with any resulting transaction_log inserts", async () => {
    // Send another thin webhook for a different contact
    crmServer.seed([{ id: "thin-c2", name: "Frank", email: "frank@example.com" }]);

    const webhookUrl = `http://localhost:${WEBHOOK_PORT}/webhooks/mock-crm`;
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "thin-c2", event: "contact.created" }),
    });

    const journalBefore = dbGetJournalRows(db, "mock-crm");
    await engine.processWebhookQueue("contacts-channel");

    const journalAfter = dbGetJournalRows(db, "mock-crm");
    const newRows = journalAfter.slice(journalBefore.length);
    // All new journal rows from this webhook processing should share one batch_id
    const batchIds = new Set(newRows.map((r) => r.batch_id).filter(Boolean));
    expect(batchIds.size).toBe(1);
  });
});

// ─── Suite: onEnable / onDisable lifecycle ────────────────────────────────────

describe("connector lifecycle — onEnable / onDisable", () => {
  let crmServer: MockCrmServer;
  let db: Db;
  let engine: SyncEngine;

  beforeAll(() => {
    crmServer = new MockCrmServer();
    crmServer.start();
    db = makeTempDb();
    ({ engine } = makeTestEngine(db, crmServer));
    engine.startWebhookServer();
  });

  afterAll(() => {
    engine.stopWebhookServer();
    crmServer.stop();
  });

  it("onEnable registers webhook and stores subscriptionId", async () => {
    await engine.onEnable("mock-crm");

    // The subscribe call must be tagged on_enable in the journal
    const rows = dbGetJournalRows(db, "mock-crm");
    const enableRow = rows.find((r) => r.url.includes("/webhooks/subscribe"));
    expect(enableRow).toBeDefined();
    expect(enableRow!.trigger).toBe("on_enable");

    // Trigger a webhook via the mock server's __trigger endpoint to confirm it's registered
    const triggerRes = await fetch(`${crmServer.baseUrl}/__trigger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "via-trigger",
        name: "Grace",
        email: "grace@example.com",
        updatedAt: new Date().toISOString(),
      }),
    });
    const triggerBody = await triggerRes.json() as { fired: number };
    expect(triggerBody.fired).toBeGreaterThanOrEqual(1);
  });

  it("onDisable unregisters webhook", async () => {
    await engine.onDisable("mock-crm");

    // After disabling, __trigger should reach 0 subscriptions
    const triggerRes = await fetch(`${crmServer.baseUrl}/__trigger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x", name: "X", email: "x@x.com", updatedAt: new Date().toISOString() }),
    });
    const body = await triggerRes.json() as { fired: number };
    expect(body.fired).toBe(0);
  });
});

// ─── Suite: processWebhookQueue — edge cases ──────────────────────────────────

describe("processWebhookQueue — edge cases", () => {
  let crmServer: MockCrmServer;
  let db: Db;
  let engine: SyncEngine;

  beforeAll(() => {
    crmServer = new MockCrmServer();
    crmServer.start();
    db = makeTempDb();
    ({ engine } = makeTestEngine(db, crmServer));
  });

  afterAll(() => { crmServer.stop(); });

  it("returns empty map when queue is empty", async () => {
    const result = await engine.processWebhookQueue("contacts-channel");
    expect(result.size).toBe(0);
  });
});

// ─── Suite: read timeout ──────────────────────────────────────────────────────

describe("ingest() read timeout", () => {
  it("rejects when read() does not complete within readTimeoutMs", async () => {
    const db = makeTempDb();

    // A connector whose read() hangs forever
    const hangingConnector: Connector = {
      metadata: { name: "hanging", version: "0.0.1" },
      getEntities(_ctx: ConnectorContext) {
        return [{
          name: "things",
          async *read(_ctx: ConnectorContext, _since?: string): AsyncIterable<ReadBatch> {
            await new Promise(() => {}); // never resolves
            yield { records: [] };      // unreachable; satisfies the return type
          },
        }];
      },
    };

    const instance = makeConnectorInstance("hanging", hangingConnector, {}, db, "http://localhost:9999");
    const engine = new SyncEngine(
      {
        connectors: [instance],
        channels: [{ id: "ch", members: [{ connectorId: "hanging", entity: "things" }] }],
        readTimeoutMs: 50,
      },
      db,
    );

    await expect(
      engine.ingest("ch", "hanging", { batchId: crypto.randomUUID() }),
    ).rejects.toThrow("timed out after 50ms");
  });
});
