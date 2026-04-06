# Remove sql-wasm Binaries from Git History

**Status:** backlog  
**Date:** 2026-04-06  
**Effort:** XS  
**Domain:** Repository hygiene  
**Scope:** `.gitignore`, `playground/public/`, `.github/`, git history  

---

## § 1 Goal

Expunge the two committed `sql.js` WASM binaries from the git object store and prevent
them from ever being re-committed.

The files (`playground/public/sql-wasm.wasm` and `playground/public/sql-wasm-browser.wasm`,
645 KB each) are binary build artifacts. Every `git clone` of the repo fetches 1.3 MB of
opaque binary data that (a) cannot be diffed, (b) will never change except when the
`sql.js` version bumps, and (c) is already regenerated at build time.

The build-time copy is already in place: `playground/vite.config.ts` runs
`copySqlWasmFiles()` before every dev/build invocation, pulling the files from
`node_modules/sql.js/dist/` into `public/`. Nothing needs to change in the build system.

---

## § 2 Current state

| Fact | Detail |
|------|--------|
| Files committed | `playground/public/sql-wasm.wasm`, `playground/public/sql-wasm-browser.wasm` |
| Size each | ~645 KB |
| Introduced in | `13be7aa` ("refactor: move demo/demo-browser → playground") |
| Commits on top | 7 (up to current HEAD) |
| Build-time copy | Already implemented in `vite.config.ts` → `copySqlWasmFiles()` |
| `.gitignore` rule | Missing — root cause of the re-commit risk |

---

## § 3 Spec changes planned

None. This is a repository hygiene task with no behavioural change to the engine,
connectors, or SDK.

---

## § 4 Steps

### § 4.1 Add `.gitignore` rule (do first, before touching history)

Add to the root `.gitignore`:

```
# sql.js WASM files — generated at build time by vite.config.ts; do not commit
playground/public/sql-wasm*.wasm
```

Stage and commit this change *before* running the history rewrite so the new ignore rule
is present in the rewritten HEAD and there is no window where the files could be
re-staged accidentally.

### § 4.2 Install `git filter-repo`

`git filter-repo` is the modern, Git-team-recommended replacement for `git filter-branch`.
Install it once in the dev container (or CI environment):

```sh
pip3 install git-filter-repo
# verify
git filter-repo --version
```

`filter-repo` rewrites the entire DAG in a single fast pass using `git fast-export` /
`git fast-import` internals. It is orders of magnitude faster than `filter-branch` and
does not leave backup refs that can re-inflate the pack.

### § 4.3 Rewrite history

Run from the repo root. `filter-repo` must be run against a **fresh clone** (it refuses to
run against a non-pristine working tree as a safety measure). The recommended workflow:

```sh
# 1. Clone into a scratch directory
cd /tmp
git clone --no-local /workspaces/opensync opensync-clean
cd opensync-clean

# 2. Rewrite — strip both WASM files from every commit
git filter-repo \
  --path playground/public/sql-wasm.wasm --invert-paths \
  --path playground/public/sql-wasm-browser.wasm --invert-paths

# 3. Verify the blobs are gone
git log --all --full-history -- 'playground/public/sql-wasm*.wasm'
# (should return nothing)

# 4. Check size reduction
git count-objects -vH
```

The `--invert-paths` flag tells `filter-repo` to keep everything *except* the listed paths.
All 7 commits on top of `13be7aa` are preserved; their SHAs change because parent hashes
change.

### § 4.4 Replace the original repo (local)

```sh
# Back in the original working directory
cd /workspaces/opensync

# Add the rewritten clone as a remote and fetch
git remote add clean /tmp/opensync-clean
git fetch clean

# Hard-reset the local main to the rewritten main
# WARNING: this is destructive — any local uncommitted work will be lost.
# Stash or commit everything first.
git checkout main
git reset --hard clean/main

# Remove the temporary remote
git remote remove clean
```

Alternatively, simply delete the original checkout and move the scratch clone into place:

```sh
mv /tmp/opensync-clean /workspaces/opensync  # swap directories
```

### § 4.5 Remove the files from the working tree and run GC

After the reset, the WASM files will no longer be tracked. If physical files remain in
`playground/public/` from before the reset, remove them manually:

```sh
rm -f playground/public/sql-wasm.wasm playground/public/sql-wasm-browser.wasm
```

They will be regenerated the next time `bun run dev` or `bun run build` is invoked (via
`vite.config.ts`). Run GC to reclaim the freed object storage:

```sh
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

### § 4.6 Force-push to the remote

**Coordinate with all collaborators before this step.** After a history rewrite, every
clone of the repo has diverged history. Contributors must re-clone or hard-reset their
local copies.

```sh
# Preferred: force-with-lease fails if the remote has advanced beyond what you expect,
# preventing accidental overwrites of others' pushes.
git push origin main --force-with-lease
```

Do **not** run this without explicit user instruction (per AGENTS.md operational safety).

### § 4.7 Update CI: ensure WASM files exist before build

The GitHub Actions playground deploy workflow runs `bun run build`. Because the WASM files
are now gitignored, `vite.config.ts` must be able to find them in `node_modules` at build
time. Verify the deploy workflow installs dependencies before building:

```yaml
- run: bun install --frozen-lockfile
- run: bun run build
```

`bun install` populates `node_modules/sql.js/dist/`, which `copySqlWasmFiles()` reads.
If the install step is already present (it should be), no CI change is needed.

---

## § 5 Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Collaborators' local clones diverge after force-push | Announce before pushing; provide re-clone instructions |
| WASM copy silently fails in CI (node_modules path changes) | `copySqlWasmFiles()` in `vite.config.ts` already logs a warning; promote it to a thrown error so the build fails loudly |
| Re-committed accidentally in future | `.gitignore` rule (§ 4.1) prevents `git add .` from staging the files |
| `git filter-repo` not available in CI/CD | Only needed once, locally; not a CI dependency |

---

## § 6 Definition of done

- [ ] `.gitignore` contains `playground/public/sql-wasm*.wasm`
- [ ] `git log --all --full-history -- 'playground/public/sql-wasm*.wasm'` returns nothing
- [ ] `bun run build` in `playground/` succeeds and the WASM files appear in `dist/`
- [ ] `git count-objects -vH` shows a smaller pack size (≥ 1 MB reclaimed)
- [ ] Remote history rewritten and force-pushed (with user sign-off)
