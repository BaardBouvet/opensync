# Plan: Rename demo-browser/ to playground/

**Status:** complete  
**Date:** 2026-04-06  
**Domain:** project structure  
**Scope:** `demo-browser/`, `playground/` (new name), root `package.json`, `AGENTS.md`, `specs/demo.md`, `CHANGELOG.md`, active plan Scope lines  

---

## § 1 Problem

`demo-browser` is a compound name that implies it is a browser-variant sub-package of
`demo`. In practice the two packages are unrelated: `demo` is a CLI runner and
`demo-browser` is a standalone interactive browser playground. The implicit hierarchy
is misleading.

`demo-browser` is also already called "playground" in `specs/playground.md`, in the
`PLAN_GITHUB_PAGES.md` plan, and in everyday conversation — the code just hasn't caught up
with the name that stuck.

---

## § 2 Goal

Rename the `demo-browser/` directory and its package name to `playground` everywhere.
No code logic changes — this is purely a renaming exercise.

Desired end state:

```
demo/           — CLI runner (run.ts, inspect.ts, examples/, data/)
playground/     — Vite browser playground (vite.config.ts, src/, public/)
```

---

## § 3 Spec changes planned

`specs/demo.md` — rename every `demo-browser` path reference in § 10 to `playground`.  
No other spec files need changes; `specs/playground.md` already uses the name correctly.

---

## § 4 Changes required

### § 4.1 Directory move

```sh
mv demo-browser playground
```

### § 4.2 Package name

`playground/package.json`:
- `"name"`: `@opensync/demo-browser` → `@opensync/playground`

### § 4.3 Root workspace registration

Root `package.json`, `workspaces` array:
- `"demo-browser"` → `"playground"`

### § 4.4 AGENTS.md module layout

```
demo-browser/       — browser playground ...
```
→
```
playground/         — browser playground ...
```

### § 4.5 specs/demo.md

Six path references in § 10 (lines ~290–324) — replace every occurrence of
`demo-browser/` and `demo-browser` with `playground/` / `playground`.

### § 4.6 Internal comment in inmemory.test.ts

`playground/src/inmemory.test.ts` line 2:
```
 * demo/demo-browser/src/inmemory.test.ts
```
→
```
 * playground/src/inmemory.test.ts
```

### § 4.7 Active plan Scope lines

Update `**Scope:**` metadata lines in active (non-historical) plans that reference
`demo-browser`:

| Plan file | Status |
|-----------|--------|
| `plans/meta/PLAN_GITHUB_PAGES.md` | draft |
| `plans/meta/PLAN_PLAYGROUND_MVU.md` | backlog |
| `plans/meta/PLAN_PLAYGROUND_TESTING.md` | backlog |
| `plans/meta/PLAN_PLANS_REORG.md` | backlog |
| `plans/demo/PLAN_NOTIFICATION_POLL.md` | draft |
| `plans/demo/PLAN_MAPPING_VISUALIZATION.md` | draft |
| `plans/engine/PLAN_ENGINE_SYNC_EVENTS.md` | draft |

Complete / historical plans (`PLAN_BROWSER_DEMO.md`, `PLAN_MOVE_DEMO_BROWSER.md`,
`PLAN_ENGINE_USABILITY.md`) are left as-is — they document what was done at the time.
CHANGELOG historical entries are similarly left unchanged.

### § 4.8 Lockfile

After all renames run:

```sh
bun install
```

to regenerate `bun.lock` with the updated workspace paths and package name.

### § 4.9 CHANGELOG entry

Add to the `[Unreleased]` section:

```
### Changed
- `demo-browser/` renamed to `playground/`; package renamed from `@opensync/demo-browser`
  to `@opensync/playground`. Removes the false parent-child implication with `demo/`.
```

---

## § 5 Verification

```sh
bun run tsc --noEmit
bun test
```

Check that `bun test playground/src/inmemory.test.ts` still passes.
