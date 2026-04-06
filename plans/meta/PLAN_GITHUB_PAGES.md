# Deploy Playground to GitHub Pages

**Status:** complete  
**Date:** 2026-04-06  
**Domain:** Infrastructure, Demo  
**Scope:** `playground/`, `.github/workflows/`, `playground/vite.config.ts`  

---

## § 1 Goal

Publish the browser playground at a stable public URL so anyone can try OpenSync without
cloning the repo.  The playground is self-contained (WASM SQLite, in-memory connectors,
no backend), making it a perfect fit for GitHub Pages static hosting.

Target URL pattern: `https://<org>.github.io/<repo>/` (or a custom domain if one is
configured later).

---

## § 2 Spec Changes Planned

No spec changes are required.  The playground spec (`specs/playground.md`) already describes
the playground as a fully in-browser application.  This plan only covers the CI/CD plumbing
to publish it.

---

## § 3 What Needs to Change

### § 3.1 Vite `base` path

GitHub Pages serves the site from `/<repo-name>/` (e.g. `/opensync/`), not `/`.  The
current `vite.config.ts` has `base: "./"` (relative), which works for `index.html` asset
references but breaks the sql.js WASM fetch:

```typescript
// db-sqljs.ts — runtime fetch of WASM file
locateFile: (file: string) => `./${file}`,
```

A relative `./` fetch from `https://<org>.github.io/opensync/` resolves correctly to
`https://<org>.github.io/opensync/sql-wasm-browser.wasm` only if the HTML page is the
document root, which it is when served from GitHub Pages with a single-page layout.

**Action:** Verify that `base: "./"` in `vite.config.ts` and `locateFile: (f) => `./${f}``
in `db-sqljs.ts` are both relative (not absolute).  They already are — no change needed
for the default `github.io/<repo>/` URL.

If a custom root domain is used (`https://play.opensync.dev/`), `base: "/"` works without
any path prefix.  The workflow should accept a `BASE_PATH` input to override.

### § 3.2 GitHub Actions workflow

Create `.github/workflows/deploy-playground.yml`.

**Trigger:** push to `main` when any file under `playground/` or
`packages/engine/src/` changes, or when manually triggered (`workflow_dispatch`).

**Steps:**
1. `actions/checkout@v4`
2. `oven-sh/setup-bun@v2` — install Bun
3. `bun install` — install all workspace deps (includes sql.js, vite, etc.)
4. `cd playground && bun run build` — produces `playground/dist/`
5. `actions/upload-pages-artifact@v3` — upload `playground/dist/` as the Pages artifact
6. `actions/deploy-pages@v4` — deploy to GitHub Pages

**Permissions required** on the workflow job:
```yaml
permissions:
  pages: write
  id-token: write
```

**GitHub repository settings required** (one-time, done in the repo UI):
- Settings → Pages → Source: "GitHub Actions" (not a branch)

### § 3.3 `bun run build` script

The build currently runs from `playground/` with `bun run build`.  The workspace
root `package.json` does not have a top-level `build:playground` script.  Add one so the
workflow can also be triggered from the root:

```json
"scripts": {
  "build:playground": "cd playground && bun run build"
}
```

This is optional but convenient for local verification.

### § 3.4 WASM file handling

The WASM plugin in `vite.config.ts` copies WASM files from `node_modules` into `public/`
at build time.  The copied files are already committed to the repo (`public/sql-wasm*.wasm`)
for local dev convenience.  During CI the copy runs again at build time — this is correct
because `node_modules` is populated by `bun install`.

No special WASM handling is required in the workflow.

---

## § 4 Workflow File (draft)

```yaml
# .github/workflows/deploy-playground.yml
name: Deploy Playground to GitHub Pages

on:
  push:
    branches: [main]
    paths:
      - "demo-browser/**"
      - "packages/engine/src/**"
      - "packages/sdk/src/**"
  workflow_dispatch:

permissions:
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Build playground
        run: cd demo-browser && bun run build

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: demo-browser/dist

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

---

## § 5 Verification Steps

After the workflow completes:

1. Navigate to `https://<org>.github.io/<repo>/` — the playground should load.
2. Open browser DevTools → Network: `sql-wasm-browser.wasm` should return HTTP 200.
3. Select a scenario and verify the systems pane populates with records.
4. Edit a record and verify it flashes green.
5. Check the Log tab and confirm the boot tick READ/INSERT events appear.

---

## § 6 Custom Domain (optional, later)

If a custom domain is added (e.g. `play.opensync.dev`):

1. Add a `CNAME` file to `demo-browser/public/` with the domain name.
2. Configure the DNS record to point to `<org>.github.io`.
3. Set `base: "/"` in `vite.config.ts` (or via `VITE_BASE` env var in the workflow).
4. Enable HTTPS in repository Settings → Pages.

No code changes are required until a custom domain is chosen.

---

## § 7 Implementation Steps

1. Create `.github/workflows/deploy-playground.yml` (§ 4 draft).
2. Verify `base: "./"` and `locateFile` are relative (they already are — § 3.1).
3. Enable GitHub Pages in repo Settings → Pages → Source: "GitHub Actions".
4. Push to `main` and confirm the workflow runs and deploys successfully.
5. Optionally add `build:playground` to root `package.json` (§ 3.3).
6. Update `README.md` with the live playground URL once confirmed working.
