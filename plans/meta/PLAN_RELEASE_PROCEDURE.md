# Release Procedure

**Status:** backlog  
**Date:** 2026-04-06  
**Effort:** S  
**Domain:** Infrastructure  
**Scope:** `.github/workflows/`, `CHANGELOG.md`, `package.json` files  

---

## § 1 Goal

Define and implement a repeatable release procedure for OpenSync.

The first "release" is a **playground release**: a controlled point at which the GitHub
Pages site is rebuilt from a tagged commit.  Full package publishing (npm) is deferred
until the Connector SDK and distribution spec are stable (Milestone 1 exit criteria).

---

## § 2 Background

The current `deploy-playground.yml` workflow deploys on every push to `main` that touches
files under `playground/`, `packages/engine/src/`, or `packages/sdk/src/`.  This is
useful during active development but has two problems:

1. **No control over when the public site changes.** A half-finished feature or a debug
   commit can land on the live URL.
2. **No version marker.** There is no git tag or GitHub Release to anchor "what is live
   right now".

The fix is to make the playground deploy **tag-triggered**: the live site only updates
when a maintainer explicitly cuts a release by pushing a version tag.

---

## § 3 Spec Changes Planned

No spec changes required.  `specs/playground.md` describes the playground as a browser
application; the deploy mechanism is infrastructure, not behaviour.

---

## § 4 What Needs to Change

### § 4.1 Change `deploy-playground.yml` trigger

Remove the `push: branches: [main]` trigger from `.github/workflows/deploy-playground.yml`.
Replace with a version-tag trigger plus a manual escape hatch:

```yaml
on:
  push:
    tags: ["v*"]
  workflow_dispatch:
```

`workflow_dispatch` preserves the ability to redeploy a hotfix or recover without cutting
a new tag.

### § 4.2 Add `.github/workflows/release.yml`

A new tag-triggered workflow that runs quality gates before the playground deploys.
Because the playground deploy is a separate job (via `deploy-playground.yml`), the release
workflow's job is lighter: verify the build is healthy and create the GitHub Release.

Jobs (in order):

1. **preflight** — `bun run tsc --noEmit` + `bun test`
2. **build-playground** — `cd playground && bun run build` (smoke-tests the Vite build)
3. **publish-release** — Extract the `[vX.Y.Z]` section from `CHANGELOG.md` and create
   a GitHub Release via `softprops/action-gh-release`, marking as prerelease when the tag
   contains `-rc`, `-beta`, or `-alpha`.

The `deploy-playground.yml` workflow fires independently on the same tag push (both
workflows listen to `push: tags: ["v*"]`), so no explicit chaining is needed.

---

## § 5 Release Procedure (human steps)

Run these steps when cutting a release:

```sh
# 1. Confirm all checks pass
bun run tsc --noEmit
bun test
cd playground && bun run build && cd ..

# 2. Finalize CHANGELOG.md
#    Rename [Unreleased] → [vX.Y.Z] — YYYY-MM-DD
#    Add a new empty [Unreleased] section above it

# 3. Verify all package.json version fields match vX.Y.Z
#    packages/engine/package.json
#    packages/sdk/package.json
#    playground/package.json
#    connectors/*/package.json

# 4. Commit, tag, push
git add -A
git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

On tag push, GitHub Actions runs `release.yml` (preflight + GH Release) and
`deploy-playground.yml` (playground build + Pages deploy) in parallel.

---

## § 6 Out of Scope (deferred)

- **npm publish** — deferred until Milestone 1 (Connector SDK + distribution spec).
  When that is ready, a `publish` job should be added to `release.yml` that runs
  `bun publish` for `@opensync/sdk`, `@opensync/engine`, and each connector.
- **Provenance / SBOM** — can be added to the release workflow at the same time as npm publish.
- **`CONTRIBUTING.md`** — should document this procedure once it is stable in practice.
