# Plan: Move demo-browser to workspace root

**Status:** complete  
**Date:** 2026-04-06  
**Domain:** project structure  
**Scope:** `demo-browser/` (new), `package.json`, `AGENTS.md`, `specs/demo.md`, `plans/meta/PLAN_GITHUB_PAGES.md`

---

## Problem

`demo/demo-browser/` is nested inside `demo/` but is not a child of it in any meaningful sense:

- `@opensync/demo-browser` does **not** import from `@opensync/demo`
- The root `package.json` workspaces array registers them independently: `"demo"` and `"demo/demo-browser"`
- A workspace that must reach *into* another workspace to register a child package signals a layout error
- The nesting implies a parent-child dependency that is absent in the code

`demo-browser` is its own package — a Vite browser app that imports directly from
`@opensync/engine` and `@opensync/sdk`. It belongs at the same level as `demo/`, not inside it.

---

## Goal

Move `demo/demo-browser/` to `demo-browser/` at the workspace root, making both demo surfaces
siblings with a flat, honest layout.

Desired end state:

```
demo/           — CLI runner (run.ts, inspect.ts, examples/, data/)
demo-browser/   — Vite browser playground (vite.config.ts, src/, public/)
```

---

## Spec changes planned

`specs/demo.md` — update all `demo/demo-browser/` path references to `demo-browser/`.  
No other spec files need changes; this is a structural rename with no behavioural impact.

---

## Changes required

### 1. Move the directory

```sh
mv demo/demo-browser demo-browser
```

### 2. Root `package.json` — workspaces

```diff
-    "demo/demo-browser"
+    "demo-browser"
```

### 3. `demo-browser/vite.config.ts` — sql.js WASM path candidates

The current paths resolve relative to the file's location inside `demo/demo-browser/`:

```ts
path.resolve(import.meta.dirname, "../../node_modules/.bun/sql.js@1.14.1/…")
path.resolve(import.meta.dirname, "../../node_modules/sql.js/…")
```

After the move the file is one level shallower, so both `../../` become `../`:

```ts
path.resolve(import.meta.dirname, "../node_modules/.bun/sql.js@1.14.1/…")
path.resolve(import.meta.dirname, "../node_modules/sql.js/…")
```

The Vite `server.fs.allow` entry `"../.."` similarly becomes `".."`.

### 4. `AGENTS.md` — module layout

Add `demo-browser/` as a separate top-level entry alongside `demo/`:

```diff
 demo/               — interactive demo runner and examples
+demo-browser/       — browser playground (Vite, sql.js WASM, in-memory connectors)
```

### 5. `specs/demo.md` — path references

Replace every occurrence of `` `demo/demo-browser/` `` with `` `demo-browser/` `` (and
`` `demo/demo-browser` `` with `` `demo-browser` `` where no trailing slash is present).
Affected lines are in § 10 and the build/hosting subsections. No structural content changes.

### 6. `plans/meta/PLAN_GITHUB_PAGES.md` — path references

This plan is still in draft and contains many absolute path references to
`demo/demo-browser/`. Update all occurrences to `demo-browser/`.

### 7. `bun.lock`

Regenerated automatically by `bun install` after the workspace entry is updated. No manual edit.

---

## Out of scope

Historical plan files (`PLAN_BROWSER_DEMO.md`, `PLAN_PLAYGROUND_MVU.md`, etc.) describe
work that was done or is backlogged. Their `demo/demo-browser` references are historical
record — they do not need updating.

No code logic changes. No spec behaviour changes.

---

## Verification

```sh
bun install                                      # refresh lockfile + symlinks
bun run tsc --noEmit                             # type-check all packages
bun test demo-browser/src/inmemory.test.ts       # browser playground unit test
cd demo-browser && bun run build                 # Vite production build succeeds
```
