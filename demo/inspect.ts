/**
 * OpenSync engine state inspector
 *
 *   bun run demo/inspect.ts -d <example-name> [table...]
 *
 * Opens demo/data/<name>/state.db and prints selected engine tables as ASCII
 * tables to stdout. If no table argument is given, all tables are printed.
 *
 * Available tables:
 *   identity   — identity_map (canonical_id, connector_id, external_id)
 *   shadow     — shadow_state (connector_id, entity_name, external_id, canonical_data)
 *   watermarks — watermarks (connector_id, entity_name, since)
 *   log        — last 40 rows of transaction_log
 *
 * Example:
 *   bun run demo/inspect.ts -d two-system
 *   bun run demo/inspect.ts -d associations-demo identity shadow
 *   watch -n2 bun run demo/inspect.ts -d two-system watermarks
 */

import { existsSync } from "node:fs";
import { join, resolve, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "@opensync/engine";

const demoDir = join(fileURLToPath(import.meta.url), "..");
const workspaceRoot = resolve(demoDir, "..");
const builtinExamplesDir = join(demoDir, "examples");

// ── Parse args ────────────────────────────────────────────────────────────────

const flagIdx = process.argv.indexOf("-d");
const rawDir = flagIdx !== -1 ? process.argv[flagIdx + 1] : undefined;

if (!rawDir) {
  console.error("Usage: bun run demo/inspect.ts -d <example-name> [identity|shadow|watermarks|log]");
  process.exit(1);
}

// Collect remaining positional args (table names) — everything after the -d <dir> pair
const tableArgs = process.argv.slice(2).filter((a, i, arr) => {
  if (a === "-d") return false;
  if (i > 0 && arr[i - 1] === "-d") return false;
  return true;
});

function resolveExampleDir(raw: string): string {
  if (isAbsolute(raw)) return raw;
  const builtin = join(builtinExamplesDir, raw);
  if (existsSync(builtin)) return builtin;
  return resolve(workspaceRoot, raw);
}

const exampleDir = resolveExampleDir(rawDir);
const exampleName = basename(exampleDir);
const dbPath = join(demoDir, "data", exampleName, "state.db");

if (!existsSync(dbPath)) {
  console.error(`No state.db found at "${dbPath}"`);
  console.error(`Run the demo first: bun run demo/run.ts -d ${exampleName}`);
  process.exit(1);
}

const db = openDb(dbPath);

// ── ASCII table renderer ──────────────────────────────────────────────────────

const MAX_COL = 36; // maximum column display width (characters)

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function printTable(title: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log(`\n${title}\n  (empty)\n`);
    return;
  }

  const cols = Object.keys(rows[0]!);
  const widths = cols.map((c) =>
    Math.min(
      MAX_COL,
      Math.max(
        c.length,
        ...rows.map((r) => String(r[c] ?? "").length)
      )
    )
  );

  const sep = "┼─" + widths.map((w) => "─".repeat(w)).join("─┼─") + "─┤";
  const top = "┌─" + widths.map((w) => "─".repeat(w)).join("─┬─") + "─┐";
  const bot = "└─" + widths.map((w) => "─".repeat(w)).join("─┴─") + "─┘";
  const header = "│ " + cols.map((c, i) => c.padEnd(widths[i]!)).join(" │ ") + " │";
  const mid    = "├─" + widths.map((w) => "─".repeat(w)).join("─┼─") + "─┤";

  console.log(`\n${title}`);
  console.log(top);
  console.log(header);
  console.log(mid);
  for (const row of rows) {
    const line = "│ " + cols.map((c, i) => truncate(String(row[c] ?? ""), widths[i]!).padEnd(widths[i]!)).join(" │ ") + " │";
    console.log(line);
  }
  console.log(bot);
  console.log();
}

// ── Table definitions ─────────────────────────────────────────────────────────

type TableDef = { name: string; label: string; query: string };

const TABLE_DEFS: TableDef[] = [
  {
    name: "identity",
    label: "identity_map",
    query: `
      SELECT
        substr(canonical_id, 1, 8) || '…' AS canonical_id,
        connector_id,
        external_id
      FROM identity_map
      ORDER BY canonical_id, connector_id
    `,
  },
  {
    name: "shadow",
    label: "shadow_state",
    query: `
      SELECT
        connector_id,
        entity_name,
        external_id,
        substr(canonical_id, 1, 8) || '…' AS canonical_id,
        canonical_data,
        updated_at
      FROM shadow_state
      ORDER BY connector_id, entity_name, external_id
    `,
  },
  {
    name: "watermarks",
    label: "watermarks",
    query: `
      SELECT connector_id, entity_name, since
      FROM watermarks
      ORDER BY connector_id, entity_name
    `,
  },
  {
    name: "log",
    label: "transaction_log (last 40)",
    query: `
      SELECT
        synced_at,
        connector_id,
        entity_name,
        action,
        external_id,
        substr(canonical_id, 1, 8) || '…' AS canonical_id
      FROM transaction_log
      ORDER BY synced_at DESC
      LIMIT 40
    `,
  },
];

// ── Run ───────────────────────────────────────────────────────────────────────

const selected = tableArgs.length > 0
  ? TABLE_DEFS.filter((t) => tableArgs.includes(t.name))
  : TABLE_DEFS;

if (selected.length === 0) {
  const valid = TABLE_DEFS.map((t) => t.name).join(", ");
  console.error(`Unknown table(s). Valid names: ${valid}`);
  process.exit(1);
}

console.log(`[${exampleName}] ${dbPath}\n`);

for (const def of selected) {
  const rows = db.prepare<Record<string, unknown>>(def.query).all();
  printTable(def.label, rows);
}

db.close();
