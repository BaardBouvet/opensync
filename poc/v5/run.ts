/**
 * POC v5 manual runner — starts the mock CRM server and runs one sync cycle.
 *
 * Usage:
 *   bun poc/v5/run.ts
 */
import { MockCrmServer, MOCK_API_KEY } from "./mock-crm-server.js";
import { openDb } from "./db.js";
import { SyncEngine, makeConnectorInstance } from "./engine.js";
import mockCrm from "../../connectors/mock-crm/src/index.js";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WEBHOOK_PORT = 4001;
const thisDir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(thisDir, "data");
const tablesDir = join(dataDir, "tables");
mkdirSync(tablesDir, { recursive: true });

async function main() {
  const crm = new MockCrmServer();
  crm.start(4000);

  crm.seed([
    { id: "c1", name: "Alice Liddell", email: "alice@example.com" },
    { id: "c2", name: "Bob Martin", email: "bob@example.com" },
  ]);

  console.log(`Mock CRM API running at ${crm.baseUrl}`);

  const dbPath = join(dataDir, "opensync.db");
  const db = openDb(dbPath);
  console.log(`SQLite state: ${dbPath}`);

  const instance = makeConnectorInstance(
    "mock-crm",
    mockCrm,
    {
      // Extra config from openlink.json (e.g. webhookMode) — runtime values win
      ...(() => {
        try {
          const ol = JSON.parse(readFileSync(join(thisDir, "openlink.json"), "utf8")) as {
            connectors?: Record<string, { config?: Record<string, unknown> }>;
          };
          return ol.connectors?.["mock-crm"]?.config ?? {};
        } catch { return {}; }
      })(),
      // Runtime overrides always take precedence
      baseUrl: crm.baseUrl,
      apiKey: MOCK_API_KEY,
    },
    db,
    `http://localhost:${WEBHOOK_PORT}`,
  );

  const engine = new SyncEngine(
    {
      connectors: [instance],
      channels: [
        {
          id: "contacts-channel",
          members: [{ connectorId: "mock-crm", entity: "contacts" }],
        },
      ],
      webhookPort: WEBHOOK_PORT,
    },
    db,
  );

  engine.startWebhookServer();
  console.log(`Webhook server listening at http://localhost:${WEBHOOK_PORT}`);

  // Enable connector — subscribes to webhooks
  await engine.onEnable("mock-crm");
  console.log("onEnable() complete — webhook registered");

  // Poll cycle
  const batchId = crypto.randomUUID();
  const result = await engine.ingest("contacts-channel", "mock-crm", { batchId, fullSync: true });
  console.log(`ingest() batch=${batchId} results:`, result.records);

  // Fire a webhook via the mock server's __trigger endpoint
  // This simulates the CRM notifying us of a new contact created externally.
  crm.seed([{ id: "c3", name: "Carol Orange", email: "carol@example.com" }]);
  console.log("\nFiring webhook via /__trigger...");
  const triggerRes = await fetch(`${crm.baseUrl}/__trigger`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "c3",
      name: "Carol Orange",
      email: "carol@example.com",
      updatedAt: new Date().toISOString(),
    }),
  });
  const triggerBody = await triggerRes.json() as { fired: number };
  console.log(`  Fired to ${triggerBody.fired} subscriber(s)`);

  // Process the webhook queue — routes the payload through the sync pipeline
  const webhookCounts = await engine.processWebhookQueue("contacts-channel");
  console.log(`  Processed: ${JSON.stringify(Object.fromEntries(webhookCounts))}`);

  // Show journal
  const { dbGetJournalRows } = await import("./db.js");
  const journalRows = dbGetJournalRows(db, "mock-crm");
  console.log("\nRequest journal:");
  for (const row of journalRows) {
    console.log(
      `  [${row.trigger ?? "-"}] ${row.method} ${row.url} → ${row.response_status} (${row.duration_ms}ms) batch=${row.batch_id ?? "-"}`,
    );
  }

  // Dump all tables to data/tables/<table>.json for inspection
  const JSON_COLS: Record<string, string[]> = {
    shadow_state:    ["canonical_data"],
    transaction_log: ["data_before", "data_after"],
    request_journal: ["request_headers"],
  };

  const DUMP_TABLES = [
    "identity_map",
    "watermarks",
    "shadow_state",
    "connector_state",
    "transaction_log",
    "sync_runs",
    "request_journal",
    "webhook_queue",
  ] as const;

  console.log(`\nDumping tables to ${tablesDir}/`);
  for (const table of DUMP_TABLES) {
    const rows = db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    const parsed = JSON_COLS[table]
      ? rows.map((row) => {
          const out = { ...row };
          for (const col of JSON_COLS[table]) {
            if (typeof out[col] === "string") {
              try { out[col] = JSON.parse(out[col] as string); } catch { /* leave as-is */ }
            }
          }
          return out;
        })
      : rows;
    const dest = join(tablesDir, `${table}.json`);
    writeFileSync(dest, JSON.stringify(parsed, null, 2));
    console.log(`  ${table}.json (${rows.length} rows)`);
  }

  // Cleanup
  await engine.onDisable("mock-crm");
  engine.stopWebhookServer();
  crm.stop();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
