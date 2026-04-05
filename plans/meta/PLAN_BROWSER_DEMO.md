# PLAN_BROWSER_DEMO.md

> **Status:** draft
> **Date:** 2026-04-05

Run the OpenSync demo entirely in a browser — no install, no terminal, just a URL.
A visitor clicks a link, sees two (or three) virtual systems syncing contacts in real time,
and can edit a record to watch the change propagate.

---

## Motivation

The current demo requires cloning the repo and running `bun run demo`. That is a fine
developer experience but a poor *first* impression. A browser-hosted demo answers the
question "does this actually work?" without any local setup.

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
3. A browser entry point — HTML page with a simple visual layout.
4. A Vite (or esbuild) bundle that produces a single static `index.html`.

---

## Approach — two options ranked by effort

### Option A — StackBlitz WebContainer embed (lower effort)

StackBlitz WebContainers run a full Node.js environment in the browser via WebAssembly.
A single URL (`stackblitz.com/github/…`) opens your GitHub repo and executes it.

**What works already:**
- The engine's Node.js path (`_openBetterSqlite3`) would theoretically run.
- `bun run demo` becomes `npx tsx demo/run.ts -d two-system` (or a small shim).

**What blocks it today:**
- `better-sqlite3` is a native addon (compiled C). WebContainers cannot load native modules.
- There is no other synchronous SQLite option in the current adapter.

**Unblock path:**
1. Add an `@sqlite.org/sqlite-wasm` adapter (pure WASM, no native bindings).
2. Auto-detect WebContainer environment (or detect `typeof process.versions.node !== "undefined" && typeof importScripts === "undefined"` — i.e. Node.js but not a Web Worker — and check for native module availability, falling back to WASM).
3. Point the StackBlitz config at `npm run demo:node` (a Node-friendly demo script).

**Result:** A one-click StackBlitz URL, output rendered in a terminal pane inside the
browser. The experience looks like a terminal, not a polished page — acceptable for a
developer audience, less so for a wider audience.

---

### Option B — Static browser demo page (higher effort, better UX)

Build a fully browser-native demo: static HTML + JS bundle, no server required.
Can be hosted on GitHub Pages and embedded via iframe in the README or docs site.

#### Architecture

```
browser
  └── demo-browser/        (new package under demo/)
        index.html         ← page shell + CSS
        src/
          main.ts          ← entry point: wires engine + inmemory connectors + UI
          db-sqljs.ts      ← sql.js Db adapter (implements packages/engine Db interface)
          inmemory.ts      ← in-memory connector (mirrors jsonfiles, no node:fs)
          ui.ts            ← DOM renderer: two panels + event log
        vite.config.ts
        package.json
```

The engine, SDK, and the sync logic are **unchanged**. Only the glue layer (db adapter,
connector, entry point) is new.

#### Component breakdown

**`db-sqljs.ts` — sql.js adapter**

`@jsr/sqlite-wasm` or `sql.js` exposes a synchronous API very close to better-sqlite3.
The adapter wraps it in the existing `Db` interface. The main difference: sql.js databases
are in-memory by default; optional persistence via OPFS (Origin-Private File System) is
available in modern browsers. For a demo, in-memory is sufficient.

```ts
// Implements the same Db interface as bun:sqlite and better-sqlite3 adapters
import initSqlJs from "sql.js";
export async function openBrowserDb(): Promise<Db> { … }
```

One complication: the existing `openDb(path)` is synchronous. An async variant
(`openDbAsync`) is needed for the browser entry point. The engine itself is already
async at the public API level, so this only touches the bootstrap call in `main.ts`.

**`inmemory.ts` — in-memory connector**

Mirrors the jsonfiles connector contract. State lives in a `Map<string, FileRecord[]>`.
Pre-seeded from a static JSON object bundled with the page (the same seed data used by
the `two-system` example). Because the data is in-memory, writes are immediate and
visible to reads in the next tick — identical behaviour to jsonfiles on a fast local disk.

Exposes a `setRecord(entity, id, patch)` function used by the UI edit panel.

**`ui.ts` — DOM renderer**

Two columns (System A | System B), each showing a live contact list. A third column
shows a timestamped event log (`A→B  UPSERT  contacts  abc12345…`). Below each contact
card: an inline edit form. Submitting the form calls `inmemory.setRecord()` and triggers
the poll cycle. No framework — plain DOM + a bit of CSS.

**Vite config**

- `optimizeDeps.exclude: ["sql.js"]` + `server.fs.allow` for the WASM binary.
- Single-output `dist/` with `base: "./"` so it works from any path (GitHub Pages, S3, etc.).
- The WASM file is fetched at runtime via a relative URL (`sql-wasm.wasm` next to `index.js`).

---

## Implementation plan (Option B)

### Phase 1 — sql.js adapter

1. Add `sql.js` as a dependency of `packages/engine` (or `demo/demo-browser`).
2. Add `openDbAsync(path: string): Promise<Db>` export from `packages/engine/src/db/index.ts`
   that detects browser context and loads the sql.js adapter.
3. Unit-test the sql.js adapter against the same fixture queries used by the engine tests.

### Phase 2 — in-memory connector

1. Create `demo/demo-browser/src/inmemory.ts` implementing the full connector contract.
2. Seed from `demo/examples/two-system/seed/` (JSON imported statically).
3. Expose `mutate(entity, id, patch)` for UI interactions.

### Phase 3 — browser entry point

1. Scaffold `demo/demo-browser/` with `vite.config.ts` and `package.json`.
2. `main.ts`: create sql.js db, instantiate `SyncEngine`, wire two inmemory connectors,
   start a `setInterval` poll loop (replacing the Node.js setInterval — identical API).
3. Every engine write event calls `ui.renderWrite(event)`.

### Phase 4 — UI layer

1. Two-column contact card layout (System A / System B).
2. Real-time event log.
3. Inline edit form that mutates System A and lets the sync propagate to System B.
4. "Reset" button that re-seeds to the initial state.

### Phase 5 — hosting + integration

1. GitHub Actions: `vite build` on push to `main`, deploy `dist/` to GitHub Pages.
2. Add a "Live Demo" link near the top of `README.md`.
3. Optional: embed as an `<iframe>` in the docs site.

---

## Spec changes planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/demo.md` | new §5 | Describe the browser demo: package location, entry point, what it shows |
| `specs/database.md` | §openDb | Document the async browser variant (`openDbAsync`) and the sql.js adapter |

No changes to `specs/connector-sdk.md` — the inmemory connector implements the existing
contract unchanged.

---

## Open questions

1. **Which sql.js package?** `sql.js` (Emscripten, mature, large bundle ~1.5 MB) vs
   `@sqlite.org/sqlite-wasm` (official SQLite WASM port, smaller, newer API). The official
   WASM port requires `SharedArrayBuffer` and COOP/COEP headers, which complicates GitHub
   Pages hosting. `sql.js` has no such requirement and is the safer starting point.

2. **Persistence?** In-memory only is fine for a demo — no OPFS complexity needed.
   If we want the user's edits to survive a page refresh, OPFS can be added later.

3. **StackBlitz vs static page?** Option A is 2–3 days of work; Option B is 1–2 weeks.
   Option A produces a terminal-style experience. Option B produces a visual one.
   Recommend: start with Option A to validate the sql.js adapter, then build Option B on top.

4. **Three-system example?** Plan for two systems initially (simpler UI). The three-system
   layout (three columns) can follow once the two-system model works.
