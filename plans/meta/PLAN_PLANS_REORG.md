# Plan: Reorganise plans/ into subsystem folders

**Status:** backlog  
**Date:** 2026-04-06  
**Domain:** project structure  
**Scope:** `plans/` — file moves only, no content changes

---

## § 1 Problem

`plans/meta/` has grown to nine files, most of which are not genuinely cross-cutting project-level
concerns.  Plans for the interactive demo runner, browser playground, and GitHub Pages deployment
ended up in `meta/` because no better folder existed at the time they were written.  Meanwhile
`plans/demo/` holds two playground UX plans that clearly belong with the browser app.

The result is a `meta/` directory that is hard to scan and a `demo/` directory that is
inconsistently scoped.

---

## § 2 Target structure

```
plans/
  poc/           — unchanged (archive)
  engine/        — unchanged
  connectors/    — unchanged
  demo/          — plans for the CLI demo runner (@opensync/demo)
  playground/    — plans for the Vite browser playground (@opensync/playground)  ← NEW
  meta/          — genuinely cross-cutting project-level plans only
  INDEX.md
  README.md
```

---

## § 3 File movements

### § 3.1 From `meta/` → `demo/`

| File | Reason |
|------|--------|
| `PLAN_DEMO.md` | Describes the interactive CLI demo runner |
| `PLAN_DEMO_ENHANCEMENTS.md` | Enhancements to the CLI demo runner |

### § 3.2 From `meta/` → `playground/` (new folder)

| File | Reason |
|------|--------|
| `PLAN_BROWSER_DEMO.md` | The original plan for the browser playground |
| `PLAN_PLAYGROUND_TESTING.md` | Playwright E2E tests for the browser playground |
| `PLAN_PLAYGROUND_MVU.md` | MVU architecture migration for the browser playground |
| `PLAN_GITHUB_PAGES.md` | Deploy browser playground to GitHub Pages |
| `PLAN_MOVE_DEMO_BROWSER.md` | Move demo-browser to workspace root (now complete) |

### § 3.3 From `demo/` → `playground/`

| File | Reason |
|------|--------|
| `PLAN_MAPPING_VISUALIZATION.md` | The mapping diagram lives in the Vite playground UI |
| `PLAN_NOTIFICATION_POLL.md` | Playground UX — debounced mutation trigger in the browser app |

### § 3.4 Stays in `meta/`

| File | Reason |
|------|--------|
| `PLAN_SPEC_DRIVEN_MIGRATION.md` | Cross-cutting project methodology (complete — historical) |
| `PLAN_DEV_PACKAGES.md` | Cross-cutting dev workspace layout (complete) |

---

## § 4 Result summary

| Folder | Before | After |
|--------|--------|-------|
| `meta/` | 9 | 2 |
| `demo/` | 2 | 4 |
| `playground/` | — | 7 |
| `engine/` | 22 | 22 |
| `connectors/` | 9 | 9 |
| `poc/` | 5 | 5 |

---

## § 5 Steps

1. Create `plans/playground/` (git tracks directories via files, so the first moved file creates it)
2. `git mv` each file listed in § 3.1 – § 3.3 to its target folder
3. Update all internal cross-references in moved files (check for `plans/meta/` or `plans/demo/` paths)
4. Rewrite `plans/INDEX.md` — rename sections, update all file paths, add `playground/` section
5. Update `AGENTS.md` module layout table to list `playground/` as a plans subfolder

---

## § 6 Spec changes planned

No spec changes required. This is a file-layout change only.
