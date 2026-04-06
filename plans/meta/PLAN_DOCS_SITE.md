# Docs Site on GitHub Pages

**Status:** draft  
**Date:** 2026-04-06  
**Effort:** M  
**Domain:** Infrastructure, Documentation  
**Scope:** `docs/`, `.github/workflows/deploy-playground.yml`, `playground/vite.config.ts`  
**Spec changes planned:** none — this plan covers CI/CD and tooling only; no engine or connector
behaviour changes. `specs/playground.md` may receive a minor note pointing to the docs URL.

---

## § 1 Goal

Host a public documentation site alongside the playground on the same GitHub Pages origin,
so that `https://<org>.github.io/opensync/docs/` serves rendered Markdown documentation and
`https://<org>.github.io/opensync/` continues to serve the interactive playground.

---

## § 2 Options Analysed

Five approaches were evaluated:

### § 2.1 mdBook

- Rust-based static site generator; produces a single `book/` directory.
- Excellent built-in full-text search (WASM).
- CI requires `cargo install mdbook` or the `peaceiris/actions-mdbook` action.
- `[output.html] site-url = "/opensync/docs/"` sets the sub-path correctly.
- **Downside:** a second build toolchain (Rust / Cargo) alongside Bun. Slow cold install
  (~2 minutes) unless the Cargo cache is primed. The aesthetic ("Rust book") is slightly
  mismatched to a TypeScript project.

### § 2.2 VitePress

- Official Vue/Vite documentation framework. Pure Node/npm, no extra toolchain.
- Shares the Bun workspace: `bun add -D vitepress` in a new `docs/` package, or as a
  workspace devDependency.
- `base: '/opensync/docs/'` in `docs/.vitepress/config.ts`.
- Fast incremental builds, hot-reload for local editing.
- Built-in full-text search (Minisearch, no server required).
- Outputs to `docs/.vitepress/dist/`.
- **Downside:** brings in Vue as a dependency even though the playground uses vanilla JS.
  In practice, Vue is a devDependency with zero effect on the playground bundle.

### § 2.3 Docusaurus

- React-based; excellent for large docs with versioning.
- Much heavier than the project needs right now.
- Build times are significantly longer than VitePress.
- **Verdict:** over-engineered for current scale. Revisit if versioned API docs are needed.

### § 2.4 MDX inside the existing Vite app

- Add `@mdx-js/rollup` to `playground/vite.config.ts`; Markdown files become React/Preact
  components and are bundled into the SPA.
- Keeps everything in one build, no sub-path merging.
- **Downside:** blurs the boundary between the interactive tool and the documentation;
  makes it harder to read docs without loading the full WASM runtime. Docs pages would
  load the sql.js WASM even when not needed.

### § 2.5 Plain GitHub-rendered Markdown (status quo)

- `docs/` directory in the repo; readable on github.com but not rendered as a site.
- No search, no navigation, no versioning.
- **Verdict:** acceptable short-term but not the desired end state.

---

## § 3 Recommendation: VitePress

VitePress is the recommended approach because:

1. **Same toolchain.** Bun installs it; `vitepress build` produces a static directory.
   No second language runtime in CI.
2. **Sub-path routing is first-class.** `base` in config handles the `/opensync/docs/`
   prefix cleanly, the same way the playground uses Vite's `base` option.
3. **Built-in search.** Full-text search works on GitHub Pages with no backend.
4. **Incremental adoption.** The existing Markdown files in `docs/` (e.g.
   `docs/getting-started.md`) can be moved in with minimal front-matter additions.
5. **Separation of concerns.** The docs site and the playground are independent builds;
   the WASM runtime is never loaded when browsing docs.

The two builds are merged in CI by copying the VitePress output into a subdirectory of
the Vite playground output before the single `upload-pages-artifact` step.

---

## § 4 Sub-path Layout

```
GitHub Pages artifact root
  /                         ← playground (Vite build, playground/dist/)
  /docs/                    ← documentation site (VitePress build, docs/.vitepress/dist/)
```

VitePress `base` must be `/opensync/docs/` (or `/<repo>/docs/` when on a project pages
site).  The playground Vite `base` stays at `./` (already correct).

---

## § 5 Proposed Directory Structure

```
docs/
  .vitepress/
    config.ts               ← VitePress config (title, nav, sidebar, base, search)
  index.md                  ← landing page (introduction / overview)
  getting-started.md        ← moved from docs/getting-started.md (already exists)
  connectors/
    guide.md                ← moved from docs/connectors/guide.md
    advanced.md             ← moved from docs/connectors/advanced.md
  package.json              ← {"name": "@opensync/docs", "private": true}
  tsconfig.json             ← extends root tsconfig
```

No new top-level workspace entry is strictly required; VitePress can be installed as a
dev dependency here and built with `cd docs && bunx vitepress build`.

---

## § 6 CI Changes

Extend `.github/workflows/deploy-playground.yml`:

1. Add `docs/**` to the `paths:` trigger filter.
2. Add a build step after the playground build:
   ```yaml
   - name: Build docs site
     run: cd docs && bunx vitepress build
   ```
3. Merge the docs output into the playground dist before uploading:
   ```yaml
   - name: Merge docs into dist
     run: cp -r docs/.vitepress/dist playground/dist/docs
   ```
4. The `upload-pages-artifact` step remains unchanged (`path: playground/dist`).

No other workflow files are affected.

---

## § 7 Local Development

```sh
# playground (unchanged)
cd playground && bun run dev

# docs site
cd docs && bunx vitepress dev
# → http://localhost:5173/opensync/docs/
```

The two dev servers run independently and do not conflict.

---

## § 8 Implementation Steps

1. `bun add -D vitepress` inside `docs/` (or root, as a workspace dep).
2. Create `docs/.vitepress/config.ts` with `base`, `title`, nav, and sidebar.
3. Add `docs/index.md` (landing page).
4. Move existing `docs/getting-started.md` and `docs/connectors/` pages as-is
   (front-matter additions only — `title`, optional `outline`).
5. Verify local build: `cd docs && bunx vitepress build`.
6. Update `.github/workflows/deploy-playground.yml` per § 6.
7. Update `plans/INDEX.md` and mark this plan `complete`.

No spec files need to change. A one-line note pointing from `specs/playground.md` to the
docs URL is optional but low priority.

---

## § 9 Risk and Mitigations

| Risk | Mitigation |
|------|-----------|
| VitePress `base` path wrong on Pages | Test with `vitepress build --base /opensync/docs/` in CI preview |
| `cp -r` merge clobbers playground files | The `docs` sub-directory is new; no collision possible |
| Cargo/mdBook chosen later after all | VitePress output is just a `dist/` directory; swapping generators later is a one-line CI change |
| Docs source diverges from `specs/` | Keep `docs/` as entry points that *link to* specs in the repo; don't duplicate spec prose |
