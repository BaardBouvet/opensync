# Expression Source Declarations: `reverseSources` and `defaultSources`

**Status:** proposed  
**Date:** 2026-04-07  
**Effort:** XS  
**Domain:** Engine — field mapping  
**Scope:** `packages/engine/src/config/loader.ts`, `packages/engine/src/core/mapping.ts`, `specs/field-mapping.md`  

---

## § 1 Problem Statement

`FieldMapping.sources` names the connector-side fields that `expression` reads from the inbound
source record — both as a lineage hint today and as the enforced scope once
`PLAN_FIELD_SOURCES_ENFORCEMENT.md` is implemented.

Two other expression fields on the same interface have no parallel declaration:

| Expression | Receives | Lineage declaration | Status |
|---|---|---|---|
| `expression` | full incoming source record | `sources?: string[]` | implemented |
| `reverseExpression` | full canonical record (outbound pass) | — | missing |
| `defaultExpression` | partially-built canonical record (inbound, fields-so-far) | — | missing |

Without these declarations:
- Lineage diagrams cannot show which canonical fields a `reverseExpression` depends on.
- When `PLAN_FIELD_SOURCES_ENFORCEMENT.md` lands it can only enforce `expression` scope; the
  other two expressions would remain un-scopeable, making the enforcement incomplete.
- There is no contract documenting what `defaultExpression` assumes about prior field order.

This plan adds `reverseSources` and `defaultSources` as peer declarations, completing the
expression lineage picture and unblocking full enforcement.

---

## § 2 Spec Changes Planned

### `specs/field-mapping.md §1.3` — add `reverseSources` under `reverseExpression`

Add a paragraph analogous to the existing `sources` paragraph:

> **`reverseSources` — lineage hint for `reverseExpression`.** When `reverseExpression` is
> present, the optional `reverseSources` array names the canonical fields that the expression
> reads. This is a declaration for tooling (lineage diagram, static analysis) and has no effect
> at runtime today. When `reverseSources` is absent and `reverseExpression` is present, the
> lineage diagram shows a `(reverseExpression)` placeholder pill.

### `specs/field-mapping.md §1.5` — add `defaultSources` under `defaultExpression`

Add a paragraph:

> **`defaultSources` — lineage hint for `defaultExpression`.** When `defaultExpression` is
> present, the optional `defaultSources` array names the canonical fields (already mapped in
> this pass, i.e. earlier entries in the fields list) that the expression reads from the
> partially-built canonical record. This is a declaration for tooling and has no effect at
> runtime today.

No other spec files require changes.

---

## § 3 Design

### § 3.1 `FieldMapping` type additions — `loader.ts`

```ts
/** Canonical field names read by `reverseExpression`. Declared for lineage: when present,
 *  `buildChannelLineage` can show which canonical fields fan into this reverse transform.
 *  When absent and reverseExpression is set, the lineage diagram shows a placeholder pill.
 *  Designed to be enforced as a scope boundary by PLAN_FIELD_SOURCES_ENFORCEMENT.md.
 *  Spec: specs/field-mapping.md §1.3 */
reverseSources?: string[];

/** Canonical field names (already mapped in this pass) read by `defaultExpression`. Declared
 *  for lineage and future enforcement. Fields not yet processed in the same pass are always
 *  absent from the partially-built record regardless; this declaration covers those that ARE
 *  present and intentionally read.
 *  Spec: specs/field-mapping.md §1.5 */
defaultSources?: string[];
```

Both fields are `string[]`. No special tokens (`"id"` etc.) — `reverseExpression` operates on
the canonical record, which has no external ID concept; `defaultExpression` operates on
canonical-so-far, which similarly does not expose the connector ID.

### § 3.2 No runtime changes — `mapping.ts`

`applyMapping()` does not change. The declarations are additive metadata only. Runtime
enforcement is the responsibility of `PLAN_FIELD_SOURCES_ENFORCEMENT.md`, which reads these
fields to build scoped records.

---

## § 4 Test Plan

No new runtime behaviour → no new unit tests required.

Type-level coverage: existing tests in `packages/engine/src/core/mapping.test.ts` continue to
pass unchanged. Type-check (`bun run tsc --noEmit`) confirms the new optional fields are accepted
on `FieldMapping` objects.

A brief smoke test asserting that `FieldMapping` objects with `reverseSources` / `defaultSources`
compile and pass through `applyMapping()` unchanged can be added if desired, but is not required
for merge.

---

## § 5 Non-Goals

- Runtime enforcement (belongs in `PLAN_FIELD_SOURCES_ENFORCEMENT.md`).
- A `reverseSources` declaration on `defaultExpression` — `defaultExpression` is an inbound
  fallback, not a reverse-pass concern.
- Config-file (YAML/JSON) surface for these fields — expressions are TypeScript-only.
