# Plan: Code Quality (Linting, Formatting, Type Hygiene)

**Status:** `backlog`

## Goal

Add a coherent quality toolchain at the monorepo root covering formatting, linting, and
doc hygiene. Everything runs from a single `check` script and is auto-fixable where possible.

---

## Problem

There are no automated quality gates beyond `tsc --build`. That leaves style drift,
dead code, misused APIs, and inconsistent formatting all invisible until code review.

---

## Solution

### Tooling

| Package | Purpose |
|---------|---------|
| `@biomejs/biome` | Formatter + linter in one tool |

Single `devDependency` at the repo root. Biome handles both formatting and linting
with no configuration overlap issues and no separate parser package needed.

### Biome

One `biome.json` at the repo root:

```json
{
  "$schema": "https://biomejs.dev/schemas/1.x.x/schema.json",
  "organizeImports": { "enabled": true },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": {
        "noExplicitAny": "warn"
      }
    }
  },
  "files": {
    "ignore": ["dist/", "node_modules/", "*.js"]
  }
}
```

`recommended` covers the most valuable rules including `noUnusedVariables`,
`useImportType` (consistent type imports), and common correctness checks.
`noExplicitAny` is a warning rather than an error to allow gradual cleanup.

### Scripts

Root `package.json`:
```json
"format":  "biome format --write .",
"lint":    "biome lint --write .",
"fix":     "biome check --write .",
"check":   "biome check . && npm run typecheck"
```

`check` is the canonical CI target (read-only, exits non-zero on any violation).
`fix` is the local auto-fix pass — runs format + lint fixes in one command.

---

## Out of Scope

- JSDoc enforcement — the connector SDK surface is small enough that comment
  quality is handled in review, not by tooling
- Type-aware lint rules (`no-floating-promises` etc.) — `tsc --build` already
  gates the serious type mistakes; the marginal value doesn't justify carrying
  a full ESLint + typescript-eslint stack
- CSS / markdown linting
