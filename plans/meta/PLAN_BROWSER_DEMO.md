# PLAN_BROWSER_DEMO.md

**Status:** in-progress  
**Date:** 2026-04-05  

Run the OpenSync demo entirely in a browser — no install, no terminal, just a URL.
A developer visits a page, sees N virtual systems syncing records in real time through the
live engine, edits either the data or the sync config as JSON, and watches the effects
propagate immediately.

---

## Motivation

The current demo requires cloning the repo and running `bun run demo`. That is fine once
you have already committed to investigating the project, but a poor *first* impression. A
browser-hosted demo lets a developer answer "does this actually work, and what does it feel
like to configure?" in under a minute.

**Target audience:** developers evaluating OpenSync. The experience should feel like a
REPL or a playground, not a marketing page.

---

## Viability

Short answer: **viable with modest effort.** The engine was designed with portability in mind.

Key facts:

- `packages/engine` and `packages/sdk` have **no `bun:*` imports** (see `AGENTS.md §3`).
  The engine already uses an adapter pattern that abstracts the SQLite driver.
- The `Db` interface in `packages/engine/src/db/index.ts` has two implementations today
  (bun:sqlite and better-sqlite3). A third — `sql.js` (SQLite compiled to WebAssembly) —
  slots in exactly the same way.
- Connectors use `global fetch()`, which is available in both runtimes and in browsers.
- The only connector that touches the filesystem is `dev/connectors/jsonfiles`, which already
  carries this notice: "cannot run in an isolated sandbox … because it directly imports
  node:fs". For a browser demo, we replace it with an in-memory variant.

The biggest pieces of new work are:
1. `sql.js` adapter in the db package.
2. An `inmemory` connector (mirrors jsonfiles but stores records in a `Map`).
3. A browser entry point — split-pane layout with JSON editors and live system views.
4. A Vite bundle that produces a single static `index.html` deployable to GitHub Pages.

---

## Chosen approach — Static browser demo page (Option B)

Build a fully browser-native demo: static HTML + JS bundle, no server required.
Hosted on GitHub Pages; the engine runs entirely in the browser via `sql.js`.

The page is a **REPL-style playground**:
- Left pane: single full-height CodeMirror JSON editor for the channels + mappings config.
- Right pane: channel tabs at top; below each tab, one column per channel member (system +
  entity); each card has Edit / Delete buttons and a last-modified timestamp; a "+ New" button
  sits at the bottom of each column. A timestamped event log spans the bottom.
- Editing the config editor and saving triggers a full engine reload.
- Clicking Edit or New opens a CodeMirror-backed `<dialog>` modal for the record's data JSON.
  Saving the modal mutates the in-memory connector and triggers an immediate poll.

The default scenario is `associations-demo` (crm/erp/hr × companies+contacts, with field
renames and associations). Additional scenario presets are selectable via the dropdown to
demonstrate different channel configurations on the same fixed systems.

---

## UI layout (updated)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  OpenSync Playground    Scenario: [ associations-demo ▼ ]   ● running    [Reset]             │
├──────────────────────┬───────────────────────────────────────────────────────────────────────┤
│  CONFIG              │  [ companies ]  [ contacts ]   ← channel tabs                        │
│  channels + mappings ├──────────────────────────────────────────────────────────────────────┤
│  ┌────────────────┐  │  ┌─── crm ──────────┐  ┌─── erp ──────────┐  ┌─── hr ───────────┐  │
│  │ {              │  │  │  companies ▪      │  │  accounts ▪       │  │  orgs ▪          │  │
│  │  "channels": { │  │  │─────────────────  │  │─────────────────  │  │────────────────  │  │
│  │    "companies":│  │  │ id: co1           │  │ id: acc1          │  │ id: org2         │  │
│  │      { ... }   │  │  │ name  Acme Corp   │  │ accountName Acme  │  │ orgName  Globex  │  │
│  │    "contacts": │  │  │ domain acme.com   │  │ website  acme.com │  │ site    globex.. │  │
│  │      { ... }   │  │  │ mod 14:02:31      │  │ mod 14:02:31      │  │ mod 14:02:29     │  │
│  │  },            │  │  │ [Edit]  [Delete]  │  │ [Edit]  [Delete]  │  │ [Edit]  [Delete] │  │
│  │  "conflict":   │  │  │─────────────────  │  │─────────────────  │  │─────────────────  │  │
│  │    { "lww" }   │  │  │ id: co2           │  │ id: acc2          │  │ id: org3         │  │
│  │ }              │  │  │ ...               │  │ ...               │  │ ...              │  │
│  └────────────────┘  │  │                   │  │                   │  │                  │  │
│                      │  │ [+ New]           │  │ [+ New]           │  │ [+ New]          │  │
│  [Save + Reload]     │  └───────────────────┘  └───────────────────┘  └──────────────────┘  │
│                      ├──────────────────────────────────────────────────────────────────────┤
│                      │  14:02:31  companies  crm→erp  INSERT  co3…       Event log           │
│                      │  14:02:33  contacts   crm→hr   UPDATE  alice…                         │
└──────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  OpenSync Playground   Scenario: [ associations-demo ▼ ]   ● running   [Reset]  [Reload cfg] │
├────────────────────────────────┬─────────────────────────────────────────────────────────────┤
│  EDITOR (scrollable)           │  SYSTEMS (horizontally scrollable)                          │
│                                │                                                             │
│  ▾ Config (opensync.json)      │  ┌── CRM ──────────────┐ ┌── ERP ──────────────┐ ┌── HR ─ │
│  ┌──────────────────────────┐  │  │  [companies] [contacts]  [accounts][employees]   [orgs] │
│  │ {                        │  │  │                      │ │                      │ │        │
│  │   "channels": {          │  │  │  companies           │ │  accounts            │ │  orgs  │
│  │     "companies": {       │  │  │  ┌────────────────┐  │ │  ┌────────────────┐  │ │  ┌─── │
│  │       "identityFields":  │  │  │  │ Acme Corp      │  │ │  │ Acme Corp      │  │ │  │ Gl │
│  │         ["domain"]       │  │  │  │ acme.com       │  │ │  │ acme.com       │  │ │  │ gl │
│  │     },                   │  │  │  └────────────────┘  │ │  └────────────────┘  │ │  └─── │
│  │     "contacts": { … }    │  │  │  ┌────────────────┐  │ │  ┌────────────────┐  │ │  ┌─── │
│  │   },                     │  │  │  │ Globex Inc     │  │ │  │ Globex Inc     │  │ │  │ In │
│  │   "mappings": [ … ]      │  │  │  │ globex.com     │  │ │  │ globex.com     │  │ │  │ in │
│  │ }                        │  │  │  └────────────────┘  │ │  └────────────────┘  │ │  └─── │
│  └──────────────────────────┘  │  │                      │ │                      │ │        │
│  [Save + Reload]               │  │  contacts            │ │  employees           │ │  peop  │
│                                │  │  ┌────────────────┐  │ │  ┌────────────────┐  │ │  ┌─── │
│  ▾ CRM / companies      [Save] │  │  │ Alice Liddell  │  │ │  │ Alice Liddell  │  │ │  │ Bo │
│  ┌──────────────────────────┐  │  │  │ alice@ex…      │  │ │  │ alice@ex…      │  │ │  │ bo │
│  │ [                        │  │  │  │ ● Acme Corp    │  │ │  │ ● Acme Corp    │  │ │  └─── │
│  │   {                      │  │  │  └────────────────┘  │ │  └────────────────┘  │ │        │
│  │     "id": "co1",         │  │  │  ┌────────────────┐  │ │  ┌────────────────┐  │ └────── │
│  │     "data": {            │  │  │  │ Bob Martin     │  │ │  │ Bob Martin     │  │          │
│  │       "name": "Acme",    │  │  │  │ bob@ex…        │  │ │  │ bob@ex…        │  │          │
│  │       "domain": "acme"   │  │  │  │ ● Globex Inc   │  │ │  │ ● Globex Inc   │  │          │
│  │     }                    │  │  │  └────────────────┘  │ └──────────────────────┘          │
│  │   },                     │  │  └──────────────────────┘                                   │
│  │   …                      │  │                                                             │
│  └──────────────────────────┘  │  ── Event log ──────────────────────────────────── [Clear] │
│                                │  14:02:31  companies  crm→erp  UPSERT  initech.com          │
│  ▾ CRM / contacts       [Save] │  14:02:31  companies  crm→hr   UPSERT  acme.com             │
│  [ … ]                         │  14:02:33  contacts   crm→erp  UPSERT  carol@example.com    │
│                                │  14:02:33  contacts   crm→hr   UPSERT  carol@example.com    │
│  ▾ ERP / accounts       [Save] │  14:02:35  contacts   erp→hr   SKIP    bob@example.com      │
│  [ … ]                         │                                                             │
│                                │                                                             │
│  ▾ ERP / employees      [Save] │                                                             │
│  [ … ]                         │                                                             │
│                                │                                                             │
│  ▾ HR / orgs            [Save] │                                                             │
│  [ … ]                         │                                                             │
│                                │                                                             │
│  ▾ HR / people          [Save] │                                                             │
│  [ … ]                         │                                                             │
└──────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

**Top bar:** scenario dropdown (loads and resets to that scenario's seed state), a live
status indicator, and a "Reset" button (re-seeds without changing the config).

**Left pane (~360 px, config editor full height):** a single CodeMirror JSON editor for the
channels + mappings config. "Save + Reload" (or Ctrl+Enter) applies config changes with a
full engine restart.

**Right pane (flex):** channel tabs at the top (one per channel in the active scenario). The
active channel shows one column per member. Each column shows record cards with a footer
containing a "mod HH:MM:SS" timestamp and Edit/Delete buttons. A "+ New" button at the
bottom of each column inserts a new record. Edit/New open a CodeMirror `<dialog>` modal.
Cards flash green briefly when their watermark changes. The event log sits below the system
columns, fixed height, auto-scrolling.

---

## Architecture

```
demo/demo-browser/          (new package under demo/)
  index.html                ← page shell + CSS (two-pane split layout)
  src/
    main.ts                 ← entry: wires engine + connectors + UI; manages reload lifecycle
    db-sqljs.ts             ← sql.js Db adapter (implements packages/engine Db interface)
    inmemory.ts             ← in-memory connector (N systems × M entities, no node:fs)
    scenarios/
      three-system.ts       ← default scenario: config + seed data (static import)
    ui/
      editor-pane.ts        ← left pane: JSON editors for config and per-system data
      systems-pane.ts       ← right pane: live record columns (dynamic, respects N systems)
      eventlog.ts           ← engine event feed (UPSERT / DELETE / SKIP lines)
  vite.config.ts
  package.json
```

The engine, SDK, and sync logic are **unchanged**. Only the glue layer is new.

---

## Component breakdown

### `db-sqljs.ts` — sql.js adapter

`sql.js` exposes a synchronous API very close to better-sqlite3. The adapter wraps it in
the existing `Db` interface. Databases are in-memory (no OPFS complexity for a demo).

```ts
// Implements the same Db interface as the bun:sqlite and better-sqlite3 adapters
import initSqlJs from "sql.js";
export async function openBrowserDb(): Promise<Db> { … }
```

The existing `openDb(path)` is synchronous. An async variant `openDbAsync()` is added to
`packages/engine/src/db/index.ts` for the browser entry point. The engine's public API is
already async, so this only touches the bootstrap call in `main.ts`.

**`sql.js` is the chosen package** (Emscripten port, mature, no `SharedArrayBuffer`
requirement). This avoids the COOP/COEP header complexity that the official
`@sqlite.org/sqlite-wasm` port requires for GitHub Pages hosting.

### `inmemory.ts` — in-memory connector

Mirrors the jsonfiles connector contract. State lives in a
`Map<systemId, Map<entity, Record[]>>`. Pre-seeded from the scenario's static seed data.

Exports `mutate(systemId, entity, id, patch)` — called by the editor pane when the user
saves changes to a system's JSON view. Because the data is in-memory, writes are visible
to reads in the very next poll tick, identical to jsonfiles on a fast local disk.

Supports an arbitrary number of systems and entities: the connector is instantiated once
per system at engine initialisation time, using the system names derived from the loaded
config.

### `scenarios/` — bundled scenarios

Each scenario is a static TypeScript module exporting a config and seed data. A top-level
`index.ts` registers them by name so the UI dropdown can list them without hardcoding names.

```ts
// scenarios/index.ts
export const scenarios: Record<string, Scenario> = {
  "associations-demo": () => import("./associations-demo.js"),
  "three-system":      () => import("./three-system.js"),
  "two-system":        () => import("./two-system.js"),
};
```

Each scenario module:

```ts
export const label = "associations-demo";     // display name in the dropdown
export const config: OpenSyncConfig = { … };  // channels + mappings (no file paths)
export const seed: ScenarioSeed = {           // { [systemId]: { [entity]: Record[] } }
  "crm": { companies: [ … ], contacts: [ … ] },
  "erp": { accounts:  [ … ], employees: [ … ] },
  "hr":  { orgs:      [ … ], people:    [ … ] },
};
```

**Default scenario is `associations-demo`** — three systems (crm / erp / hr), two entities
each (companies + contacts / accounts + employees / orgs + people), field renames, and
associations. This is the richest existing example and demonstrates the engine's
distinguishing capabilities (field mapping, identity resolution across heterogeneous schemas).

`three-system` and `two-system` are included as simpler reference points. Additional
scenarios can be added as new modules without touching any other code (the index is the
only registry).

### `main.ts` — engine lifecycle

Manages two states: **running** and **reloading**.

**Start-up sequence:**
1. Load the active scenario.
2. Call `openBrowserDb()` (async, loads WASM).
3. Instantiate one `InMemoryConnector` per system, seeded with scenario data.
4. Construct `SyncEngine(config, db)`.
5. Run the onboard phase (ingest + snapshot, same logic as `demo/run.ts`).
6. Start a `setInterval` poll loop (2 s default, configurable via a slider in the UI).
7. On every engine write event, call `ui.eventlog.append(event)` and `ui.systems.refresh()`.

**Config-change reload sequence** (triggered when the user saves the config editor):
1. Stop the poll interval.
2. Discard the existing db (in-memory — just drop the reference).
3. Parse the new config from the editor JSON.
4. Re-seed all connectors from the new config's seed data (or existing data if the system
   already existed and the user only changed mappings).
5. Restart from step 2 of the start-up sequence above.
6. The editor pane updates to reflect any new/removed systems.

### `ui/editor-pane.ts` — left pane

A scrollable column of [CodeMirror](https://codemirror.net/) JSON editors (lightweight,
no framework required, good keyboard UX for developers):

- **Config editor**: the `opensync.json`-equivalent (connectors + channels + mappings).
  A "Reload" button (or `Ctrl+Enter`) triggers the config-change reload sequence.
- **Per-system data editors**: one editor per system, showing that system's records as a
  JSON array. A "Save" button (or `Ctrl+Enter`) calls `mutate()` and triggers an immediate
  poll. The number of system editors tracks the running config dynamically.

### `ui/systems-pane.ts` — right pane

A horizontally-scrolling row of system columns. Each column shows:
- System name header.
- One card per record, rendered as a key-value table.
- A small entity selector if the system has multiple entities.

The column count is dynamic — adding a system to the config creates a new column on reload.

### `ui/eventlog.ts` — event feed

A fixed-height scrolling log at the bottom of the right pane. Each line:

```
14:02:31  contacts  system-a → system-b  UPSERT  carol@example.com
```

Auto-scrolls to the latest entry. A "Clear" button resets it.

### Vite config

- `optimizeDeps.exclude: ["sql.js"]` + `server.fs.allow` for the WASM binary.
- Single-output `dist/` with `base: "./"` so it works from any path.
- The WASM file is fetched at runtime via a relative URL (`sql-wasm.wasm` next to `index.js`).

---

## Implementation plan

### Phase 1 — sql.js adapter

1. Add `sql.js` as a dev dependency of `demo/demo-browser` (not `packages/engine` — keeps
   the engine package browser-agnostic).
2. Add `openDbAsync(): Promise<Db>` export from `packages/engine/src/db/index.ts`.
3. Implement `db-sqljs.ts`: wrap `initSqlJs()` in the `Db` interface.
4. Unit-test the adapter against the same fixture queries used by the engine tests.

### Phase 2 — in-memory connector

1. Create `demo/demo-browser/src/inmemory.ts` implementing the full connector contract.
2. Support arbitrary `(systemId, entity)` keys; seed from a `ScenarioSeed` object.
3. Export `mutate(systemId, entity, id, patch)`.

### Phase 3 — bundled scenarios

1. Create `demo/demo-browser/src/scenarios/associations-demo.ts` from the existing
   `demo/examples/associations-demo/` seed + config (static import, no fs). This is the
   default scenario.
2. Create `three-system.ts` and `two-system.ts` as simpler reference scenarios.
3. Create `scenarios/index.ts` as the scenario registry (dynamic imports keyed by name).
   The dropdown reads its keys — no hardcoded list elsewhere.

### Phase 4 — browser entry point and engine lifecycle

1. Scaffold `demo/demo-browser/` with `vite.config.ts` and `package.json`.
2. Implement `main.ts`: start-up sequence, poll loop, config-change reload sequence.
3. Wire engine write events to UI callbacks.

### Phase 5 — UI layer

1. Integrate CodeMirror for the config and per-system data editors.
2. Implement `systems-pane.ts`: dynamic column layout, record cards.
3. Implement `eventlog.ts`: appending log lines, auto-scroll.
4. Wire the "Reload" and "Save" buttons to the lifecycle functions in `main.ts`.
5. Add a poll-interval slider.

### Phase 6 — hosting + integration

1. GitHub Actions: `vite build` on push to `main`, deploy `dist/` to GitHub Pages.
2. Add a "Live Demo" link near the top of `README.md`.
3. Optional: embed as an `<iframe>` in the docs site.

---

## Spec changes planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/demo.md` | new §5 | Describe the browser demo: package location, entry point, what it shows, config-reload behaviour |
| `specs/database.md` | §openDb | Document `openDbAsync()` and the sql.js adapter |

No changes to `specs/connector-sdk.md` — the inmemory connector implements the existing
contract unchanged.

---

## Future improvements

- **Hot module replacement / live config reload without full reset**: detect which parts of
  the config changed (new system added, mapping changed, identity field changed) and apply
  minimal engine updates rather than a full teardown. Warrants its own plan once the base
  demo exists.
- **OPFS persistence**: allow the shadow db to survive a page refresh via the
  Origin-Private File System API. Optional progressive enhancement once the demo is live.
- **Additional scenarios**: more example configs selectable from a dropdown (e.g. the
  `associations-demo`).
- **Export state**: download the current in-memory state as a zip of JSON files, matching
  the `demo/data/` layout so it can be replayed locally.
