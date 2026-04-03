# Plan: Code Quality (Linting, Formatting, Type Hygiene)

**Status:** `backlog`

## Goal

Add a coherent quality toolchain at the monorepo root covering formatting, linting, and
doc hygiene. Everything runs from a single `check` script and is auto-fixable where possible.

---

## Problem

There are no automated quality gates beyond `tsc --build`. That leaves style drift,
dead code, misused APIs, inconsistent formatting, and stale comments all invisible
until code review. The SDK's embedded JSDoc has a few known inaccuracies (see below)
that tooling would have caught at authoring time.

Known JSDoc issues in `packages/sdk/src/`:

- `ValidationError` class comment still says *"Use `status: 'error'` on write results"* — the
  write-result types use `error?: string`, not a `status` discriminant. The comment predates the
  field rename and is now stale.
- `InsertRecord.data` comment is circular: *"only meaningful on creation, not insert (which IS
  creation)"* — should just state what fields are omitted and why.
- Inline field comments (`/** ... */` trailing same line) are intermixed with block-style
  multi-line JSDoc on sibling fields in the same interface, inconsistent within a single type.

---

## Solution

### Tooling

| Package | Purpose |
|---------|---------|
| `prettier` | Opinionated formatter — eliminates all style debates |
| `eslint` | Linter |
| `typescript-eslint` | TS parser + type-aware lint rules |
| `eslint-config-prettier` | Disables ESLint rules that conflict with Prettier |
| `eslint-plugin-jsdoc` | JSDoc/TSDoc quality rules |
| `typedoc` | API reference site from source comments |

All packages installed as `devDependencies` at the repo root.

Prettier handles **formatting**. ESLint handles **correctness and doc quality**.
They do not overlap thanks to `eslint-config-prettier`.

### Prettier

One `.prettierrc` at the repo root, applied to all `.ts` and `.js` files.
Suggested baseline (adjust to taste before committing):

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

Add `.prettierignore` excluding `dist/`, `node_modules/`, and generated files.

### ESLint flat config

One `eslint.config.js` at the root. Two rule tiers:

1. **All TS files** — syntax and basic TS rules (no type-aware rules, fast).
2. **`packages/sdk/src/**` only** — stricter type-aware checks and JSDoc enforcement,
   because the SDK is public API surface. Connectors are internal; doc requirements
   are omitted there.

**All TS files:**
- `@typescript-eslint/no-unused-vars` — catch dead variables the compiler permits
- `@typescript-eslint/no-explicit-any` — warn on `any` escapes
- `@typescript-eslint/consistent-type-imports` — `import type` where applicable

**SDK only (type-aware):**
- `@typescript-eslint/no-floating-promises` — unhandled async in connector hooks
- `@typescript-eslint/no-unnecessary-type-assertion` — dead casts
- `jsdoc/require-description` — every exported symbol needs a description
- `jsdoc/check-param-names` — param names must match the signature
- `jsdoc/no-undefined-types` — type references in JSDoc must resolve

### TypeDoc

Generate an API reference site from the SDK's existing prose comments. No TSDoc tag migration required — TypeDoc renders `/** ... */` descriptions as-is.

Config at `typedoc.json` in the repo root:

```json
{
  "entryPointStrategy": "packages",
  "entryPoints": ["packages/sdk"],
  "out": "docs/api",
  "readme": "none",
  "excludePrivate": true,
  "excludeInternal": true
}
```

Output goes into `docs/api/` (add to `.gitignore` — built in CI, not committed).
A GitHub Actions job can publish to GitHub Pages on every merge to `main`.

Add to root `package.json`:
```json
"docs": "typedoc"
```

The `check` script does not need to run TypeDoc — it is a separate publish step.
TypeDoc failing (e.g. unresolved type reference in a comment) should be a CI warning,
not a blocking gate, until the output stabilises.

### Scripts

Root `package.json`:
```json
"format":    "prettier --write .",
"format:check": "prettier --check .",
"lint":      "eslint .",
"lint:fix":  "eslint . --fix",
"docs":      "typedoc",
"check":     "npm run format:check && npm run lint && npm run typecheck"
```

`check` is the canonical CI target. `format` + `lint:fix` together constitute the
auto-fix pass a developer runs locally.

### SDK doc fixes (prerequisite)

Fix before enabling `jsdoc/require-description` so the first lint run is clean:

1. Rewrite `ValidationError` class comment — drop the stale `status: 'error'` reference;
   replace with the actual `error?: string` field name.
2. Rewrite `InsertRecord.data` comment — remove the circular parenthetical and replace
   with *"Immutable fields (schema.immutable: true) are stripped before this reaches the connector."*
3. Normalise comment style in `types.ts` — pick block JSDoc on its own line(s) and apply
   it consistently; eliminate trailing same-line `/** ... */` on interface fields.

---

## Out of Scope

- TSDoc tag migration (`@param`, `@returns`) — TypeDoc renders prose descriptions fine;
  tags can be added incrementally as the SDK stabilises
- Enforcing JSDoc on connector internals — connectors are ecosystem implementations,
  not public API; `jsdoc/require-description` applies to `packages/sdk` only
- CSS / markdown linting
