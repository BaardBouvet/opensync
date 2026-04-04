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
      "plugin": "../../../connectors/jsonfiles/src/index.ts",
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
      "plugin": "../../../connectors/mock-crm/src/index.ts",
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

Seed files must be in the exact format the connector writes. For `connector-jsonfiles`:

```json
[
  {
    "_id": "a1",
    "name": "Alice Liddell",
    "email": "alice@example.com",
    "_updatedAt": "2025-01-01T00:00:00.000Z"
  }
]
```

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

## § 5 Runner Architecture

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

## § 6 Path Resolution

Two types of relative paths coexist in example `opensync.json` files and resolve differently:

| Path type | Example | Resolved relative to |
|-----------|---------|---------------------|
| Plugin path | `../../../connectors/jsonfiles/src/index.ts` | Example directory (`loadConfig` root) |
| Data file path | `demo/data/two-system/system-a/contacts.json` | `process.cwd()` (workspace root) |

The runner calls `process.chdir(workspaceRoot)` before `loadConfig()` to ensure data paths
always resolve from the workspace root regardless of the caller's cwd.

This asymmetry is a known limitation. A future improvement (`${CONFIG_DIR}` token or
explicit path resolution mode in `loadConfig`) would unify the two conventions.
See `plans/engine/PLAN_CONFIG_VALIDATION.md` for related work.

---

## § 7 What the Demo Is Not

- Not a test suite. The demo is not run in CI.
- Not a benchmark. Performance characteristics are validated in the engine test suite.
- Not a tutorial. It shows a working system; prose explanation belongs in `docs/`.
- Not a connector validation harness. Engine tests (`engine.test.ts`) cover correctness.
