# Demo

The `demo/` directory is the interactive developer entry point for OpenSync. It is designed to
answer one question in under ten seconds: "does this thing actually work?"

Each example is a self-contained `opensync.json` project that `bun run demo` can run. Examples
are not tests — they are standalone demonstrations of the engine's capabilities, covering the
full onboarding pipeline and, in later examples, field mappings.

---

## § 1 Command

```sh
bun run demo                          # runs the default example (two-system)
bun run demo/run.ts -d <example-dir>  # runs any folder containing opensync.json
POLL_MS=500 bun run demo              # faster polling (default: 2000 ms)
```

`<example-dir>` is resolved as follows:
1. If absolute — used as-is
2. If a name matching a folder in `demo/examples/` — resolved to that folder
3. Otherwise — resolved relative to the workspace root

The runner validates that `opensync.json` exists in the resolved directory before proceeding.
If `-d` is omitted, the runner lists available built-in examples by scanning `demo/examples/`
at runtime — no hardcoded list.

The `demo` script in `package.json` pins the default: `bun run demo/run.ts -d two-system`.
Adding a new example never requires touching `run.ts` or `package.json`.

---

## § 2 Example Folder Convention

Each example is a directory under `demo/examples/<name>/` with the following structure:

```
demo/examples/<name>/
  opensync.json       ← connector registry (required)
  mappings/           ← channel definitions and field mappings (required)
    <file>.yaml
  seed/               ← initial data, copied to demo/data/<name>/ on first run (optional)
    <connector-id>/
      <entity>.json
  README.md           ← describes the example, prerequisites, how to interact
```

### § 2.1 `opensync.json`

Standard `opensync.json` format (see `specs/config.md`). Plugin paths are relative to the
example directory. Data file paths in connector `config` are relative to the workspace root
(`process.cwd()` when `bun run demo` is invoked from the repo root).

```json
{
  "connectors": {
    "system-a": {
      "plugin": "../../../dev/connectors/jsonfiles/src/index.ts",
      "config": {
        "filePaths": ["demo/data/two-system/system-a/contacts.json"]
      }
    }
  }
}
```

Auth credentials go under the `auth:` key (see `specs/auth.md §Credentials in opensync.json`):

```json
{
  "connectors": {
    "crm": {
      "plugin": "../../../dev/connectors/mock-crm/src/index.ts",
      "auth": { "apiKey": "${MOCK_CRM_API_KEY}" },
      "config": { "baseUrl": "http://localhost:4001" }
    }
  }
}
```

### § 2.2 `seed/`

The `seed/` directory is copied verbatim to `demo/data/<name>/` on first run (when all
channels are uninitialized). Once the runner has persisted state to `demo/data/<name>/state.db`,
seed is not used again until the data directory is deleted.

Seed files must be in the exact format the connector writes. For `connector-jsonfiles`, records use a nested envelope serialised with `JSON.stringify(records, null, 2)` — nested objects are fully expanded, never inlined:

```json
[
  {
    "id": "a1",
    "data": {
      "name": "Alice Liddell",
      "email": "alice@example.com"
    }
  }
]
```

Fields:
- `id` — required; unique record identifier within the file.
- `data` — required; the record payload passed to the engine.
- `updated` — optional watermark. ISO 8601 timestamp or monotonically-increasing integer. Records without this field are always included in every read, regardless of `since`. Omit it in seed files unless incremental-sync behaviour is specifically being tested.
- `associations` — optional; pre-declared edges in the SDK `Association` shape.

### § 2.3 First-run flow

1. Detect uninitialized channels: `engine.channelStatus(ch.id) === "uninitialized"`
2. Copy `seed/<connector-id>/` to `demo/data/<name>/<connector-id>/` for each connector that
   has a seed directory
3. For each uninitialized channel: run `ingest(collectOnly) → discover → onboard`
4. Print discover + onboard summary
5. Enter the poll loop

### § 2.4 Poll loop

For each channel, for each member connector in order:

```
engine.ingest(channelId, connectorId)
```

Any result with `action !== "skip"` is printed:

```
[HH:MM:SS.mmm] <from>→<to>  INSERT  contacts  abc12345… → def67890…
```

Steady state (no changes) produces no output.

---

## § 3 Available Examples

### § 3.1 `two-system` (default)

Two `connector-jsonfiles` instances syncing a `contacts` channel bidirectionally.

Seed: system-a has Alice + Bob + Carol; system-b has Alice + Bob. Onboard matches two
records by email, propagates Carol from A to B. Demonstrates the core collect → discover →
onboard pipeline and bidirectional incremental sync.

### § 3.2 `three-system`

Three `connector-jsonfiles` instances on a single `contacts` channel. Demonstrates fan-out:
a write to any connector propagates to the other two. Seed: A and B share Alice + Bob; C
has Carol only.

### § 3.3 `mock-crm-erp`

`connector-mock-crm` (contacts) synced with `connector-mock-erp` (employees) on a `people`
channel with identity field `email`. Requires both mock servers running locally — see
`demo/examples/mock-crm-erp/README.md`.

Demonstrates: HTTP connectors, OAuth2 + API key auth, field name divergence (CRM calls
them "contacts", ERP calls them "employees" — same channel bridges them).

### § 3.4 `associations-demo`

Three `connector-jsonfiles` instances (`crm`, `erp`, `hr`) syncing two channels (`companies`
and `contacts`) with field renames and associations.

Each connector uses different field names:

| Canonical | crm | erp | hr |
|-----------|-----|-----|----|
| `name` (company) | `name` | `accountName` | `orgName` |
| `domain` | `domain` | `website` | `site` |
| `name` (contact) | `name` | `fullName` | `displayName` |
| `companyId` | `companyId` | `orgId` | `orgRef` |

Seed: crm has Acme, Globex, Initech + Alice, Bob, Carol; erp has Acme, Globex + Alice, Bob;
hr has Globex, Initech + Bob, Carol. Three companies are matched across systems by `domain`;
three contacts are matched by `email`. Demonstrates the full mapping pipeline in a realistic
multi-system layout.

---

## § 4 Field Mapping Showcase (planned)

The two-system and three-system examples use identity field mapping only (`email`). A
dedicated example should demonstrate full field mapping:

- Two systems with different field names for the same concept:
  - System A: `{ firstName, lastName, workEmail }`
  - System B: `{ name, email }`
- Mapping YAML maps `firstName + lastName` → `name`, `workEmail` → `email`
- Demonstrate `forward_only`, `reverse_only`, and `bidirectional` direction rules

This example should be named `field-mapping` and placed in `demo/examples/field-mapping/`.
It is the primary vehicle for showcasing the `specs/field-mapping.md` spec to new contributors.

_Prerequisite: the field mapping engine is exercised in tests but not yet in a demo with
visible before/after data. This is the next example to add after the three current ones._

---

## § 6 Engine State Inspector

```sh
bun run demo/inspect.ts -d <example-name> [table...]
```

`inspect.ts` opens `demo/data/<name>/state.db` and prints selected engine tables to stdout.
Run it on demand in a second terminal while the demo runner is polling. No flags required on
the demo runner itself — the two processes are independent.

### § 6.1 Arguments

If no table argument is given, all tables are printed.

| Argument | SQLite table | Rows shown |
|----------|-------------|------------|
| `identity` | `identity_map` | All rows, ordered by `canonical_id` |
| `shadow` | `shadow_state` | All rows, ordered by `connector_id`, `entity_name` |
| `watermarks` | `watermarks` | All rows — the engine's incremental-sync cursor per connector/entity |
| `log` | `transaction_log` | Last 40 rows, newest first |

### § 6.2 Examples

```sh
# All tables for the two-system example
bun run demo/inspect.ts -d two-system

# Identity map only for associations-demo
bun run demo/inspect.ts -d associations-demo identity

# Watermarks only, refreshed every 2 s
watch -n2 bun run demo/inspect.ts -d associations-demo watermarks
```

`canonical_id` values are shown truncated to 8 characters + `…` for readability.

---

## § 7 Runner Architecture

`demo/run.ts` is a generic runner. It knows nothing about individual examples and contains
no hardcoded list of example names:

1. Parse `-d <dir>` from `process.argv`; if absent, scan `demo/examples/` and print available names
2. Resolve the directory (built-in shorthand, absolute, or workspace-relative)
3. Validate that `opensync.json` exists in the resolved directory
4. Load config via `loadConfig(exampleDir)` from `@opensync/engine`
5. First-run detection uses `engine.channelStatus()`
6. Seed copy uses `cpSync(seedDir, dataDir, { recursive: true })`
7. The poll loop iterates `config.channels` and `ch.members` generically

The default example is set in `package.json`:
```json
"demo": "bun run demo/run.ts -d two-system"
```

Adding a new example never requires touching `run.ts` or `package.json` (unless changing the
default).

---

## § 8 Path Resolution

Two types of relative paths coexist in example `opensync.json` files and resolve differently:

| Path type | Example | Resolved relative to |
|-----------|---------|---------------------|
| Plugin path | `../../../dev/connectors/jsonfiles/src/index.ts` | Example directory (`loadConfig` root) |
| Data file path | `demo/data/two-system/system-a/contacts.json` | `process.cwd()` (workspace root) |

The runner calls `process.chdir(workspaceRoot)` before `loadConfig()` to ensure data paths
always resolve from the workspace root regardless of the caller's cwd.

This asymmetry is a known limitation. A future improvement (`${CONFIG_DIR}` token or
explicit path resolution mode in `loadConfig`) would unify the two conventions.
See `plans/engine/PLAN_CONFIG_VALIDATION.md` for related work.

---

## § 9 What the Demo Is Not

- Not a test suite. The demo is not run in CI.
- Not a benchmark. Performance characteristics are validated in the engine test suite.
- Not a tutorial. It shows a working system; prose explanation belongs in `docs/`.
- Not a connector validation harness. Engine tests (`engine.test.ts`) cover correctness.

---

## § 10 Browser Demo Playground

`demo/demo-browser/` is a self-contained Vite package that runs the full OpenSync engine
entirely in a browser — no install, no terminal, no server required.

### § 10.1 What it shows

A split-pane developer playground:
- **Left pane** — CodeMirror JSON editors: one for the channel/mapping config and one per
  `(system × entity)` pair. Saving a data editor triggers an immediate poll; saving the
  config editor triggers a full engine reload (db wiped, re-seeded, engine re-initialised).
- **Right pane** — One column per system, entity tabs, record cards, and a timestamped
  engine event log at the bottom.
- **Top bar** — Scenario dropdown, status indicator, and Reset button.

### § 10.2 Scenarios

Built-in scenarios live in `demo/demo-browser/src/scenarios/`. Each is a static TypeScript
module exporting a `ScenarioDefinition`. The registry in `scenarios/index.ts` lists them.
Adding a new scenario requires only a new module + one registry entry.

Default scenario: `associations-demo` (three systems × two entities, field renames,
associations).

### § 10.3 Engine stack in the browser

| Layer | Implementation |
|-------|---------------|
| SQLite | `sql.js` (Emscripten WASM port) via `demo/demo-browser/src/db-sqljs.ts` |
| Connector | `InMemoryConnector` in `demo/demo-browser/src/inmemory.ts` (Map-backed, no fs) |
| Engine | `@opensync/engine` unchanged — no browser-specific modifications |
| Bundler | Vite; dead-code stubs replace `better-sqlite3`, `bun:sqlite`, `node:fs`, `node:path` |

### § 10.4 Build and hosting

```sh
cd demo/demo-browser
bun run dev    # local dev server (hot reload)
bun run build  # produces dist/ — deploy to any static host
```

`dist/` contains `index.html`, the JS bundle, and `sql-wasm.wasm`. The `locateFile`
callback in `db-sqljs.ts` fetches the WASM from the same base path so it works on
GitHub Pages, S3, or any sub-path hosting without configuration.

### § 10.5 Config-change reload behaviour

When the user saves the config editor:
1. The running poll interval is cleared.
2. The sql.js database is dropped (in-memory — just GC'd).
3. The new config JSON is parsed and merged with the current scenario shape.
4. All in-memory connectors are re-seeded from the scenario's original seed data.
5. The engine is reconstructed and the onboard sequence is re-run from scratch.
6. The editor pane rebuilds to reflect any new/removed systems.

Data-only saves (per-system entity editors) call `InMemoryConnector.mutate()` and trigger
one immediate poll cycle — no engine restart needed.
