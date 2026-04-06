# Release Procedure

**Status:** backlog  
**Date:** 2026-04-06  
**Effort:** S  
**Domain:** Infrastructure  
**Scope:** `.github/workflows/`, `CHANGELOG.md`, `package.json` files  

---

## § 1 Goal

Define and implement a repeatable, two-phase release procedure for OpenSync.

**Phase 1 — Playground releases (now):** Versioned releases of the browser playground
only.  Each release rebuilds the GitHub Pages site and creates a GitHub Release with
changelog notes.  No package publishing.  These releases can be cut frequently as the
playground evolves.

**Phase 2 — Engine/package releases (deferred):** Full releases including npm publish of
`@opensync/sdk`, `@opensync/engine`, and connectors.  Deferred until Milestone 1
(Connector SDK + distribution spec) exit criteria are met.

Both phases share the same tag scheme (`v0.1.0`, `v0.2.0`, …) and the same changelog
discipline, so the transition from phase 1 to phase 2 only adds jobs to the release
workflow — the procedure itself does not change.

---

## § 2 Background

The original `deploy-playground.yml` workflow deployed on every push to `main` that
touched playground or engine source files.  This gave no control over when the public
site changes and left no version marker for "what is live right now".

**Already done:** the trigger has been changed to `push: tags: ["v*"]` plus
`workflow_dispatch`.  Pushes to `main` no longer redeploy the playground.

---

## § 3 Spec Changes Planned

No spec changes required.  `specs/playground.md` describes the playground as a browser
application; the deploy and release mechanism is infrastructure, not behaviour.

---

## § 4 What Needs to Change

### § 4.1 `deploy-playground.yml` trigger ✅ done

Already changed to:

```yaml
on:
  push:
    tags: ["v*"]
  workflow_dispatch:
```

### § 4.2 Add `.github/workflows/release.yml`

A new tag-triggered workflow that runs quality gates and creates the GitHub Release.
The playground deploy continues to fire from `deploy-playground.yml` on the same tag
push — no explicit chaining needed.

Jobs (in order):

1. **preflight** — `bun run tsc --noEmit` + `bun test`
2. **build-playground** — `cd playground && bun run build` (smoke-tests the Vite build)
3. **publish-release** — Extract the `[vX.Y.Z]` section from `CHANGELOG.md` and create
   a GitHub Release via `softprops/action-gh-release`.  Mark as prerelease when the tag
   contains `-rc`, `-beta`, or `-alpha`.  Include a link to the playground URL in the
   release body.

### § 4.3 Changelog structure for playground releases

The `CHANGELOG.md` already uses `## [Unreleased]` + `### Added / Fixed / Changed`.
No structural change needed.  A playground release reads naturally in the changelog
alongside future engine releases.

### § 4.4 Version scope for playground releases

Playground releases only bump `playground/package.json`.  Engine, SDK, and connector
`package.json` versions stay at their current value and are **not** bumped until a
phase-2 release.  This avoids implying API stability before Milestone 1.

---

## § 5 Release Procedure — Phase 1 (playground only)

Run these steps when cutting a playground release:

```sh
# 1. Confirm all checks pass
bun run tsc --noEmit
bun test
cd playground && bun run build && cd ..

# 2. Finalize CHANGELOG.md
#    Rename [Unreleased] → [vX.Y.Z] — YYYY-MM-DD
#    Add a new empty [Unreleased] section above it

# 3. Bump playground/package.json version to vX.Y.Z
#    (engine/sdk/connector package.json versions are NOT changed)

# 4. Commit, tag, push
git add -A
git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

On tag push, GitHub Actions runs `release.yml` (preflight + GH Release) and
`deploy-playground.yml` (playground build + Pages deploy) in parallel.

---

## § 6 Release Procedure — Phase 2 (engine + packages, deferred)

When Milestone 1 exit criteria are met, extend the phase-1 steps with:

- Bump `packages/engine/package.json`, `packages/sdk/package.json`, and
  `connectors/*/package.json` to the same version as `playground/package.json`.
- Add a `publish` job to `release.yml` that runs `bun publish` for `@opensync/sdk`,
  `@opensync/engine`, and each connector after the preflight job passes.

No other procedure changes are needed — the tag scheme, changelog format, and
commit/tag/push steps remain identical.

---

## § 7 Out of Scope (deferred to phase 2)

- **npm publish** — deferred until Milestone 1 (Connector SDK + distribution spec).
- **Provenance / SBOM** — can be added to the release workflow at the same time as npm publish.
- **`CONTRIBUTING.md`** — should document this procedure once it is stable in practice.
