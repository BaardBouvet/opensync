# PLAN: Consolidate Dev-Only Packages Under `dev/`

**Status:** complete  
**Scope:** Repository layout — connectors/mock-crm, connectors/mock-erp, connectors/jsonfiles, servers/mock-crm, servers/mock-erp

---

## Why

`connectors/` is meant to hold distributable connector implementations. Three of the eight
packages there are dev-only fixtures (`mock-crm`, `mock-erp`, `jsonfiles`) that will never be
published and exist only to support the engine's test suite and the local demo. They currently
sit alongside publishable connectors (hubspot, kafka, postgres, sparql, tripletex, waveapps),
making the boundary unclear.

All five dev packages are already explicitly marked:
- `connector-mock-crm`, `connector-mock-erp`, `server-mock-crm`, `server-mock-erp` — `"private": true`
- `connector-jsonfiles` — description: "LOCAL-ONLY: development/test fixture using node:fs"

Moving them to `dev/` makes the boundary structural rather than relying on comments.

## No import-path changes required

All consumers import by package name (`@opensync/connector-mock-crm`, etc.), not by relative
path. Moving the directories leaves package names unchanged, so no `.ts` source files need
editing. Only workspace globs and documented paths change.

---

## Target layout

```
dev/
  connectors/
    jsonfiles/      ← was connectors/jsonfiles/
    mock-crm/       ← was connectors/mock-crm/
    mock-erp/       ← was connectors/mock-erp/
  servers/
    mock-crm/       ← was servers/mock-crm/
    mock-erp/       ← was servers/mock-erp/
```

The `servers/` top-level directory is removed (all entries move to `dev/servers/`).

---

## Steps

### 1. Move directories

```sh
mkdir -p dev/connectors dev/servers

git mv connectors/jsonfiles  dev/connectors/jsonfiles
git mv connectors/mock-crm   dev/connectors/mock-crm
git mv connectors/mock-erp   dev/connectors/mock-erp
git mv servers/mock-crm      dev/servers/mock-crm
git mv servers/mock-erp      dev/servers/mock-erp

rmdir servers   # now empty
```

### 2. Update root `package.json` workspace globs

```diff
 "workspaces": [
   "packages/*",
   "connectors/*",
-  "servers/*"
+  "dev/connectors/*",
+  "dev/servers/*"
 ],
```

### 3. Add `"private": true` to `dev/connectors/jsonfiles/package.json`

jsonfiles does not yet carry `"private": true`. Add it to be consistent with the other
dev packages and prevent accidental publish.

```diff
 {
   "name": "@opensync/connector-jsonfiles",
+  "private": true,
   ...
 }
```

### 4. Update AGENTS.md — module layout section

Add entries for `dev/` and `demo/` in the module layout table:

```
demo/             — interactive polling demo (bun run demo)
dev/
  connectors/     — local-only test fixture connectors (jsonfiles, mock-crm, mock-erp)
  servers/        — companion HTTP servers for mock connectors
```

Remove the `connectors/` paragraph that lists mock-crm/mock-erp as
distributable connectors.

### 5. Update specs/connector-sdk.md — Mock Servers section

Replace all path references that point to `connectors/mock-*` or `servers/mock-*` with
`dev/connectors/mock-*` and `dev/servers/mock-*`.

Affected paragraphs:
- § Mock Servers — directory layout callout
- § Example Connectors table — jsonfiles, mock-crm, mock-erp rows

No semantic changes to the spec text are needed; only paths change.

### 6. Verify workspace resolution

```sh
bun install
bun run tsc --noEmit
bun test
```

All 272 tests must continue to pass. The engine's devDependencies
(`@opensync/connector-jsonfiles`, `@opensync/connector-mock-crm`, etc.) resolve via
package name and are unaffected by the directory move.

### 7. CHANGELOG.md

```md
### Changed
- Dev-only packages (connector-jsonfiles, connector-mock-crm, connector-mock-erp,
  server-mock-crm, server-mock-erp) moved from `connectors/` and `servers/` to
  `dev/connectors/` and `dev/servers/` to clearly separate fixtures from
  distributable connectors.
```

---

## Out of scope

- Renaming package names (they stay `@opensync/connector-mock-crm` etc.)
- Any changes to connector source code or test logic
- Any changes to the demo script (`demo/run.ts`)
