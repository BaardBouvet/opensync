# PLAN: `detectRefs` Opt-In for Structural Ref Detection

**Status:** backlog  
**Date:** 2026-04-09  
**Effort:** XS  
**Domain:** packages/sdk, packages/engine  
**Scope:** `EntityDefinition`, `_extractRefsFromData` ingest path  
**Spec:** specs/associations.md, specs/connector-sdk.md  
**Depends on:** PLAN_SCHEMA_REF_AUTOSYNTH.md (complete)  

---

## 1. Problem

`_extractRefsFromData` contains two passes:

- **Pass 1** — structural scan: any field value that satisfies `isRef(v)` (i.e. is an object
  with a string `'@id'` property) is treated as a Ref, regardless of whether the field is
  declared in `schema`.
- **Pass 2** — schema auto-synthesis: plain string fields declared with `entity` in `schema`
  are wrapped as Refs.

Pass 1 is unconditional and causes silent data loss for any API that returns objects
containing a string `'@id'` key as plain data (common in JSON-LD-flavoured APIs). Such
fields are stripped from the dispatched payload by the engine's write-side Ref filter
(`filter(([, v]) => !isRef(v))`), meaning ordinary data fields are silently dropped without
any error.

The "Why Inline in `data`?" section of `specs/associations.md` claims structural Ref
detection is "unambiguous", which is incorrect: it is only unambiguous when the connector
controls every field and can guarantee no plain data field will ever return an object with
a string `@id` property. That guarantee cannot be made for arbitrary SaaS API payloads.

For the overwhelmingly common case — SaaS connectors declared with `entity` in schema, no
explicit Ref objects constructed — Pass 1 provides zero benefit and adds data-loss risk.

---

## 2. Proposed Change

### 2.1 New `EntityDefinition` field

```typescript
interface EntityDefinition {
  // … existing fields …

  /**
   * When true, the engine scans all data fields for structurally Ref-shaped values
   * ({ '@id': string, '@entity'?: string }) and derives associations from them in
   * addition to schema auto-synthesis.
   *
   * Set this on connectors that construct Ref objects explicitly (e.g. SPARQL/RDF
   * connectors). Leave unset (default: false) for SaaS connectors that rely on
   * schema auto-synthesis — this avoids false-positive Ref detection on API payloads
   * that happen to contain objects with an '@id' key.
   *
   * Default: false
   */
  detectRefs?: boolean;
}
```

### 2.2 Updated ingest logic in `_extractRefsFromData`

When `entityDef.detectRefs !== true`, Pass 1 is skipped entirely. Only schema auto-synthesis
(Pass 2) runs.

When `entityDef.detectRefs === true`, the current Pass 1 runs first (structural scan),
followed by Pass 2. For structurally-detected Refs, the entity name resolution order is:

1. `@entity` on the Ref object itself — used directly.
2. `entity` on the `FieldDescriptor` in `schema` for that field — used when `@entity` is absent.
3. Neither — Ref treated as opaque, no association derived.

This preserves the full existing behaviour for connectors that opt in.

### 2.3 No change to write-side filtering

The write-side `filter(([, v]) => !isRef(v))` must only strip fields that were *originated
as Refs*. Since structurally-detected Refs are only possible when `detectRefs: true`, and
schema-synthesised Refs can only arise on fields declared with `entity`, the filter does
not need to change — it continues to strip Ref-shaped values from outbound `data`.

However, the plain-data safety guarantee is now complete: when `detectRefs` is false (the
default), no plain data field can be structurally detected as a Ref and stripped, because
Pass 1 never runs.

---

## 3. Affected files

| File | Change |
|------|--------|
| `packages/sdk/src/types.ts` | Add `detectRefs?: boolean` to `EntityDefinition` with JSDoc |
| `packages/engine/src/engine.ts` | Gate Pass 1 of `_extractRefsFromData` on `entityDef?.detectRefs === true` |
| `connectors/sparql/src/index.ts` | Set `detectRefs: true` on each entity definition |

---

## 4. Spec changes planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/associations.md` | Entity Inference | Update list to reflect three inference paths under `detectRefs: true` vs two under the default; note the opt-in |
| `specs/associations.md` | Design Rationale → "Why Inline in `data`?" | Correct the "unambiguous" claim; document the `detectRefs` flag as the mechanism that makes it unambiguous |
| `specs/connector-sdk.md` | EntityDefinition / schema section | Document `detectRefs` alongside `schema` |

No new spec sections are needed. The change is additive documentation only.

---

## 5. Tests

- Add a unit test to `packages/engine/src/association-schema.test.ts`: entity with
  `detectRefs` absent (default) — a field returning `{ '@id': 'x', '@entity': 'y' }` but
  no `entity` in schema must **not** be detected as a Ref, and the field value must survive
  in dispatched `data` unchanged.
- Existing tests for explicit Ref objects on the SPARQL connector serve as the `detectRefs: true`
  regression guard once the SPARQL entity definitions are updated.

---

## 6. Migration

No data migration. Shadow state is unaffected. Config changes: `detectRefs: true` must be
added to the SPARQL connector's entity definitions. All other connectors change nothing.
