/**
 * POC v6 manual runner — starts mock-crm + mock-erp and runs one sync cycle.
 *
 * Usage:
 *   bun poc/v6/run.ts
 */
import { MockCrmServer, MOCK_API_KEY } from "../v5/mock-crm-server.js";
import { MockErpServer, MOCK_CLIENT_ID, MOCK_CLIENT_SECRET } from "./mock-erp-server.js";
import { openDb, dbGetJournalRows, dbGetAllOAuthTokens } from "./db.js";
import { SyncEngine, makeConnectorInstance } from "./engine.js";
import mockCrm from "../../connectors/mock-crm/src/index.js";
import mockErp from "../../connectors/mock-erp/src/index.js";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(thisDir, "data");
const tablesDir = join(dataDir, "tables");
mkdirSync(tablesDir, { recursive: true });

async function main() {
  // ── Start mock servers ──────────────────────────────────────────────────────

  const crm = new MockCrmServer();
  crm.start(4000);
  crm.seed([
    { id: "c1", name: "Alice Liddell", email: "alice@example.com" },
    { id: "c2", name: "Bob Martin", email: "bob@example.com" },
  ]);
  console.log(`CRM running at ${crm.baseUrl}`);

  const erp = new MockErpServer();
  erp.start(4001);
  erp.seed([
    { id: "e1", name: "Charlie Watts", email: "charlie@corp.com", department: "Engineering" },
  ]);
  console.log(`ERP running at ${erp.baseUrl}`);

  // ── Open DB ─────────────────────────────────────────────────────────────────

  const dbPath = join(dataDir, "opensync.db");
  // Always start fresh — mock servers generate new IDs and tokens each run
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(f)) rmSync(f);
  }
  const db = openDb(dbPath);
  console.log(`SQLite state: ${dbPath}`);

  // ── Build connector instances ────────────────────────────────────────────────

  const crmInstance = makeConnectorInstance(
    "crm",
    mockCrm,
    { baseUrl: crm.baseUrl, apiKey: MOCK_API_KEY, webhookMode: "thick" },
    db,
    "http://localhost:4003",
  );

  const erpInstance = makeConnectorInstance(
    "erp",
    mockErp,
    {
      baseUrl: erp.baseUrl,
      clientId: MOCK_CLIENT_ID,
      clientSecret: MOCK_CLIENT_SECRET,
    },
    db,
    "http://localhost:4003",
  );

  const engine = new SyncEngine(
    {
      connectors: [crmInstance, erpInstance],
      channels: [
        {
          id: "people-channel",
          members: [
            { connectorId: "crm", entity: "contacts" },
            { connectorId: "erp", entity: "employees" },
          ],
        },
      ],
    },
    db,
  );

  // ── Sync cycle ───────────────────────────────────────────────────────────────

  // Pull CRM contacts → propagate to ERP employees
  console.log("\n── Ingest CRM → ERP ───────────────────────────────");
  const crmResult = await engine.ingest("people-channel", "crm", {
    batchId: crypto.randomUUID(),
    fullSync: true,
  });
  console.log("CRM results:", crmResult.records);

  // Pull ERP employees → propagate to CRM contacts
  console.log("\n── Ingest ERP → CRM ───────────────────────────────");
  const erpResult = await engine.ingest("people-channel", "erp", {
    batchId: crypto.randomUUID(),
    fullSync: true,
  });
  console.log("ERP results:", erpResult.records);

  // ── Show request journal ────────────────────────────────────────────────────

  console.log("\nRequest journal (all connectors):");
  const allRows = dbGetJournalRows(db);
  for (const row of allRows) {
    console.log(
      `  [${row.connector_id}] [${row.trigger ?? "-"}] ${row.method} ${row.url}` +
      ` → ${row.response_status} (${row.duration_ms}ms)`,
    );
  }

  // ── Dump tables ─────────────────────────────────────────────────────────────

  console.log(`\nDumping tables to ${tablesDir}/`);

  const JSON_COLS: Record<string, string[]> = {
    shadow_state: ["canonical_data"],
    transaction_log: ["data_before", "data_after"],
    request_journal: ["request_headers"],
  };

  const tablesToDump = [
    "identity_map",
    "watermarks",
    "shadow_state",
    "connector_state",
    "transaction_log",
    "sync_runs",
    "request_journal",
    "webhook_queue",
    "oauth_tokens",
  ];

  for (const table of tablesToDump) {
    try {
      const rows = db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
      const jsonCols = JSON_COLS[table] ?? [];
      const parsed = rows.map((row) => {
        const out = { ...row };
        for (const col of jsonCols) {
          if (typeof out[col] === "string") {
            try { out[col] = JSON.parse(out[col] as string); } catch { /* keep raw */ }
          }
        }
        return out;
      });
      writeFileSync(join(tablesDir, `${table}.json`), JSON.stringify(parsed, null, 2));
      console.log(`  ${table}.json (${rows.length} rows)`);
    } catch {
      console.log(`  ${table}.json — table not found`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("run.ts error:", err);
  process.exit(1);
});
