# Derived Fields (`default` / `defaultExpression`)

**Status:** backlog  
**Date:** 2026-04-07  
**Effort:** XS  
**Domain:** Engine — field mapping  
**Scope:** `packages/engine/src/config/loader.ts`, `packages/engine/src/config/schema.ts`, `packages/engine/src/core/mapping.ts`, `specs/field-mapping.md`  

---

## § 1 Problem Statement

`specs/field-mapping.md §1.5` documents `default` and `defaultExpression` as per-field fallback
values applied during the forward pass when the source field is absent or null. Both are currently
marked *designed, not yet implemented*.

Without this primitive, callers must inject fallback logic inside connector `read()` methods or
write a `forward_only` `expression` that wraps every field with a null-coalesce. `default` and
`defaultExpression` provide a clean config-level declaration point for the common case.

`default` covers static values (e.g. `"active"`, `0`, `false`). `defaultExpression` covers dynamic
defaults that depend on other fields already resolved in the current record
(e.g. `(r) => r.email` or `(r) => r.firstName + ' ' + r.lastName`).

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §1.5 | Update status from "designed, not yet implemented" to "implemented". No structural changes needed — the YAML snippet and behaviour description already match the intended design. |

---

## § 3 Design

### § 3.1 Type changes — `FieldMapping` in `loader.ts`

```typescript
export interface FieldMapping {
  // ... existing fields ...
  /** Static fallback value used when the source field is absent or null on the forward pass.
   *  Applied before resolution. Mutually exclusive with defaultExpression.
   *  Spec: specs/field-mapping.md §1.5 */
  default?: unknown;
  /** Dynamic fallback function used when the source field is absent or null on the forward pass.
   *  Receives the partially-built canonical record (fields processed so far in declaration order).
   *  Applied before resolution. Mutually exclusive with default.
   *  Spec: specs/field-mapping.md §1.5 */
  defaultExpression?: (record: Record<string, unknown>) => unknown;
}
```

The Zod `FieldMappingEntrySchema` in `schema.ts` gains a `default` field for config-file support:

```typescript
default: z.unknown().optional(),
```

`defaultExpression` is function-valued and **not** added to the Zod schema — it is only available
through the embedded TypeScript API.

### § 3.2 Logic changes — `applyMapping()` in `mapping.ts`

In the `inbound` pass, after resolving the value (via `expression` or the source-key lookup), apply
the fallback when the resolved value is null or absent:

```typescript
if (pass === "inbound") {
  if (dir === "forward_only") continue;

  let value: unknown;
  if (m.expression) {
    value = m.expression(data);
  } else {
    const sourceKey = m.source ?? m.target;
    value = Object.prototype.hasOwnProperty.call(data, sourceKey) ? data[sourceKey] : undefined;
  }

  // Spec: specs/field-mapping.md §1.5 — apply default when value is null/undefined
  if (value === null || value === undefined) {
    if (m.defaultExpression) {
      value = m.defaultExpression(result);   // result holds fields already written this pass
    } else if (m.default !== undefined) {
      value = m.default;
    }
  }

  if (value !== undefined) {
    result[m.target] = value;
  }
}
```

`defaultExpression` receives `result` (the partially-built output record) rather than the raw
input record, consistent with the spec's wording: "receives the partially-built canonical record
and can reference other fields". Field order is declaration order, so callers should declare
`defaultExpression` fields after the fields they reference.

### § 3.3 Behaviour notes

- `default` and `defaultExpression` apply **only on the inbound (forward) pass**. They have no
  effect on reverse mapping.
- A value of `null` is treated as absent and triggers the fallback. A value of `0`, `false`, or
  `""` is not absent and does not trigger the fallback.
- `default` and `defaultExpression` are mutually exclusive. If both are set,
  `defaultExpression` takes precedence (a lint/config-validation warning is appropriate).

### § 3.4 Tests

New test group `defaults` in `packages/engine/src/core/mapping.test.ts`:

| ID | Scenario |
|----|----------|
| DF1 | Field absent from source → `default` value used |
| DF2 | Field present but `null` → `default` value used |
| DF3 | Field present with value `""` (empty string) → `default` NOT applied |
| DF4 | Field present with value `0` (falsy) → `default` NOT applied |
| DF5 | `defaultExpression` applied; result references earlier field in same mapping |
| DF6 | `defaultExpression` absent, `default` absent → field dropped normally (field absent) |
| DF7 | Reverse pass — `default` / `defaultExpression` have no effect (outbound mapping unchanged) |
