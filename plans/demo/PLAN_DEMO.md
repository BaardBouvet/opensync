# PLAN: demo/ Directory

**Status:** largely complete — generic runner + all three examples implemented  
**Date:** 2026-04-04  
**Scope:** `demo/` top-level directory  

---

## Purpose

`demo/` is the interactive entry point for new contributors and evaluators. It should answer
the question "does this thing actually work?" with a single command that requires no external
services and no configuration.

It also serves as the canonical home for saved config examples that would otherwise
be lost when `poc/` is removed.

---

## Current state (implemented)

```
demo/
  run.ts                        ← generic runner: loadConfig + poll loop
  package.json                  ← workspace package; declares @opensync/engine dep
  README.md                     ← usage guide, example table, structure, path conventions
  data/
    .gitignore                  ← ignores generated runtime state
  examples/
    two-system/                 ← DEFAULT (bun run demo)
      README.md
      opensync.json
      mappings/contacts.yaml
      seed/
        system-a/contacts.json  ← Alice, Bob, Carol
        system-b/contacts.json  ← Alice, Bob  (Carol is unique → propagated on onboard)
    three-system/               ← bun run demo three-system
      README.md
      opensync.json
      mappings/contacts.yaml
      seed/
        system-a/contacts.json  ← Alice, Bob
        system-b/contacts.json  ← Alice, Bob
        system-c/contacts.json  ← Carol
    mock-crm-erp/               ← bun run demo mock-crm-erp (requires servers)
      README.md
      opensync.json             ← ports 4001 (CRM) / 4002 (ERP)
      mappings/people.yaml
```

`bun run demo [example]` (root package.json script):
1. Loads `demo/examples/<name>/opensync.json` via `loadConfig()` — plugin paths, connector configs, channels from mappings/
2. First run (channel uninitialized): copies `seed/` to `demo/data/<name>/`, then runs `collectOnly → discover → onboard` for each channel
3. All runs: polls every `POLL_MS` ms (default 2 s), prints sync events as `[HH:MM:SS.mmm] <from>→<to>  ACTION  entity  src… → tgt…`
4. Persists state to `demo/data/<name>/state.db`; `Ctrl+C` exits cleanly

### Path conventions in opensync.json

Two types of relative paths exist in the same file and resolve differently:

- **Plugin paths** (`"plugin": "../../../connectors/..."`) — resolved relative to the example
  directory by `loadConfig()` using `resolve(root, entry.plugin)`.
- **Data file paths** (`"filePaths": ["demo/data/..."]`) — passed through as-is by `loadConfig()`;
  resolved by the jsonfiles connector against `process.cwd()`. The runner calls
  `process.chdir(workspaceRoot)` before `loadConfig()` to ensure this is always the repo root,
  regardless of where the user invoked `bun run demo`.

This asymmetry is a known limitation of the current config loader. A future improvement would
be a `${CONFIG_DIR}` variable or explicit path resolution mode. See `specs/config.md` for the
loader spec.

---

## Open items

### 1. Verify `mock-crm-erp` end-to-end

Auth wiring in the engine is complete — `clientId`/`clientSecret` are read from config by
`context.ts` and `apiKey` by `http.ts`, and the `auth:` key in opensync.json is now merged
into config by the loader. The mock-erp connector derives its `tokenUrl` from `baseUrl`
(`getOAuthConfig`), so no extra config is needed.

End-to-end smoke test still needed: start both servers, run `bun run demo mock-crm-erp`,
confirm INSERT events appear. No code changes expected — this is a manual verification step.

### 2. `bun run demo:servers` convenience script

Once PLAN_DEV_PACKAGES.md is executed (servers moved to `dev/`), add a root script that
starts both mock servers in background processes:

```json
"demo:servers": "bun run --cwd dev/servers/mock-crm start & bun run --cwd dev/servers/mock-erp start"
```

_Blocked on PLAN_DEV_PACKAGES.md._

---

## Non-goals

- The demo is NOT a test. It is not run in CI.
- The demo does not validate connector behaviour — engine tests do that.
- No synthetic data generation beyond the fixed seed files.

---

## Relationship to other plans

| Plan | Interaction |
|------|-------------|
| `plans/poc/PLAN_REMOVE_POC.md` | openlink.json examples from poc/ are now in `demo/examples/`; preservation gate is met |
| `plans/meta/PLAN_DEV_PACKAGES.md` | mock-crm-erp example paths will need updating when dev packages move |
| `specs/config.md` | loadConfig() path resolution must be spec-correct before wiring run.ts to it |
