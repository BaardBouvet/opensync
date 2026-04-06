/**
 * OpenSync demo runner
 *
 *   bun run demo/run.ts -d <example-dir>
 *
 * <example-dir> is a path to any folder containing an opensync.json file.
 * Paths relative to demo/examples/ are resolved automatically; absolute
 * paths and paths relative to cwd also work.
 *
 * On first run:
 *   - Copies seed data from <example-dir>/seed/ into demo/data/<name>/
 *   - Runs collect → discover → onboard for each channel
 *
 * On subsequent runs:
 *   - Picks up from the persisted SQLite state and enters the poll loop immediately
 *
 * Stop with Ctrl+C. Delete demo/data/<name>/ for a clean slate.
 *
 * POLL_MS env var controls the poll interval (default: 2000 ms).
 */

import { mkdirSync, existsSync, readdirSync, cpSync } from "node:fs";
import { join, resolve, basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { SyncEngine, openDb, loadConfig } from "@opensync/engine";

const POLL_MS = Number(process.env["POLL_MS"] ?? 2_000);

const demoDir = join(fileURLToPath(import.meta.url), "..");
const workspaceRoot = resolve(demoDir, "..");
const builtinExamplesDir = join(demoDir, "examples");

// ── Parse -d <dir> ────────────────────────────────────────────────────────────

function availableExamples(): string[] {
  try {
    return readdirSync(builtinExamplesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

const flagIdx = process.argv.indexOf("-d");
const rawDir = flagIdx !== -1 ? process.argv[flagIdx + 1] : undefined;

if (!rawDir) {
  const examples = availableExamples();
  console.error("Usage: bun run demo/run.ts -d <example-dir>");
  if (examples.length > 0) {
    console.error(`\nBuilt-in examples (demo/examples/):\n${examples.map((e) => `  ${e}`).join("\n")}`);
  }
  process.exit(1);
}

// filePaths in opensync.json are relative to the workspace root (cwd when bun run demo
// is invoked from the repo root). Enforce this regardless of the caller's cwd.
process.chdir(workspaceRoot);

// Resolve: absolute → as-is; relative → try demo/examples/<dir> first, then cwd
function resolveExampleDir(raw: string): string {
  if (isAbsolute(raw)) return raw;
  const builtin = join(builtinExamplesDir, raw);
  if (existsSync(builtin)) return builtin;
  return resolve(workspaceRoot, raw);
}

const exampleDir = resolveExampleDir(rawDir);
const exampleName = basename(exampleDir);
const dataDir = join(demoDir, "data", exampleName);
const dbPath = join(dataDir, "state.db");

if (!existsSync(join(exampleDir, "opensync.json"))) {
  console.error(`No opensync.json found in "${exampleDir}"`);
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });

// ── Load config + open DB ─────────────────────────────────────────────────────

const config = await loadConfig(exampleDir);
const db = openDb(dbPath);
const engine = new SyncEngine(config, db);

// ── First-run: seed + onboard ─────────────────────────────────────────────────

const uninitChannels = config.channels.filter(
  (ch) => engine.channelStatus(ch.id) === "uninitialized",
);

if (uninitChannels.length > 0) {
  const seedDir = join(exampleDir, "seed");
  if (existsSync(seedDir)) {
    console.log(`First run — copying seed data for "${exampleName}"…`);
    cpSync(seedDir, dataDir, { recursive: true });
  }

  for (const ch of uninitChannels) {
    console.log(`\nOnboarding channel "${ch.id}"…`);

    const collects = [];
    for (const member of ch.members) {
      collects.push(await engine.ingest(ch.id, member.connectorId, { collectOnly: true }));
    }

    const snapshotAt = collects.reduce(
      (min, c) => Math.min(min, c.snapshotAt ?? Date.now()),
      Date.now(),
    );

    const report = await engine.discover(ch.id, snapshotAt);
    console.log(`  discover: ${report.matched.length} matched, ${report.uniquePerSide.length} unique`);

    const result = await engine.onboard(ch.id, report);
    console.log(
      `  onboard:  ${result.linked} linked, ` +
      `${result.uniqueQueued} unique records propagated, ` +
      `${result.shadowsSeeded} shadows seeded`,
    );
  }
  console.log();
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

console.log(`[${exampleName}] polling every ${POLL_MS}ms — Ctrl+C to stop`);
for (const ci of config.connectors) {
  const filePaths = ci.config["filePaths"] as string[] | undefined;
  if (filePaths) {
    for (const p of filePaths) console.log(`  ${ci.id}  ${p}`);
  }
}
console.log();

process.on("SIGINT", () => {
  console.log("\nStopped.");
  db.close();
  process.exit(0);
});

function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

while (true) {
  for (const ch of config.channels) {
    for (const member of ch.members) {
      const result = await engine.ingest(ch.id, member.connectorId);
      for (const r of result.records) {
        if (r.action === "skip" || r.action === "read") continue;
        const tag =
          r.action === "insert" ? "INSERT" :
          r.action === "update" ? "UPDATE" :
          r.action === "defer"  ? "DEFER " : r.action.toUpperCase();
        const src = r.sourceId.slice(0, 8);
        const tgt = r.targetId ? r.targetId.slice(0, 8) : "?";
        const dir = `${member.connectorId}→${r.targetConnectorId}`;
        const changedKeys = r.action === "update" && r.before && r.after
          ? Object.keys(r.after).filter((k) => JSON.stringify(r.before![k]) !== JSON.stringify(r.after![k]))
          : undefined;
        const fieldHint = changedKeys?.length ? `  [${changedKeys.join(", ")}]` : "";
        console.log(`[${ts()}] ${dir}  ${tag}  ${r.entity}  ${src}… → ${tgt}…${fieldHint}`);
      }
    }
  }

  await Bun.sleep(POLL_MS);
}
