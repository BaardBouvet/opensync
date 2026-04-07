# Resolution Strategies: `collect`, `bool_or`, and Expression Resolver

**Status:** complete  
**Date:** 2026-04-07  
**Effort:** S  
**Domain:** Engine — conflict resolution  
**Scope:** `packages/engine/src/config/loader.ts`, `packages/engine/src/config/schema.ts`, `packages/engine/src/core/conflict.ts`, `packages/engine/src/core/conflict.test.ts`, `specs/field-mapping.md`, `specs/sync-engine.md`  
**Depends on:** nothing — builds on existing `resolveConflicts` infrastructure  

---

## § 1 Problem Statement

`specs/field-mapping.md §2` documents six resolution strategies. Three (`identity`,
`coalesce`, `last_modified`) map directly to the existing engine. The remaining three
are marked partial or unimplemented in `plans/engine/GAP_OSI_PRIMITIVES.md §1`:

| Strategy | Code state | Spec state |
|----------|-----------|-----------|
| `collect` | Implemented in `conflict.ts` (case "collect") | **Stale: says "not yet implemented"** |
| `bool_or` | Not implemented | Designed, not yet implemented |
| Expression resolver | Not implemented | Designed, not yet implemented |

`collect` is already functional in the engine but:
- Has no dedicated tests in `conflict.test.ts`.
- The spec (`specs/field-mapping.md §2.4`) incorrectly says "designed, not yet implemented".

`bool_or` is the simplest gap: it is semantically equivalent to `collect` followed by
`Array.some(Boolean)`. The use case is deletion flags or soft-delete signals that should
propagate if *any* upstream source marks a record deleted.

The **expression resolver** (`specs/field-mapping.md §2.3`) is more involved. The spec
describes it as receiving an array of all contributing `{ value, sourceId, timestamp }` items.
However, the engine resolves conflicts incrementally — one source at a time during each ingest
pass. Collecting all source values simultaneously would require a DB look-up inside
`resolveConflicts`, breaking its pure-function contract.

This plan adopts an **incremental reducer** signature instead, which covers the full set of
useful OSI-mapping expression cases (`max`, `min`, `sum`, `count`, `concat`) without altering
the engine's architecture. A full multi-source snapshot approach is deferred to post-v1.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §2.3 | Update status to "implemented" and document the incremental reducer signature. Replace the YAML `resolve: (values) => …` signature with the two-arg `(incoming, existing) => canonical` form. |
| `specs/field-mapping.md` | §2.4 | Update status to "implemented". Add a note that the implementation uses the target shadow as accumulator. |
| `specs/field-mapping.md` | §2.5 | Update status to "implemented". |
| `specs/sync-engine.md` | `ConflictConfig` interface block | Add `"bool_or"` to the `fieldStrategies` strategy union. Add `resolve` function to `FieldMapping`. |

---

## § 3 Design

### § 3.1 `collect` — tests only

`collect` is already implemented in `conflict.ts`:

```typescript
case "collect": {
  const arr = Array.isArray(existing.val) ? existing.val : [existing.val];
  resolved[field] = arr.includes(incomingVal) ? arr : [...arr, incomingVal];
  break;
}
```

When the target shadow has no prior value, the `!existing` fast-path runs first and accepts
the incoming scalar directly. On each subsequent source's ingest the `collect` branch appends
to the accumulated array, deduplicating by value. The result is a growing set of all source
contributions, stored under the target shadow for the field.

**Changes required:** none to conflict.ts. Add dedicated tests (§4 below). Fix spec status.

---

### § 3.2 `bool_or`

Add `"bool_or"` to the `fieldStrategies` strategy union:

```typescript
// loader.ts — ConflictConfig
fieldStrategies?: Record<string, { strategy: "coalesce" | "last_modified" | "collect" | "bool_or" }>;
```

```typescript
// schema.ts — FieldStrategySchema (if a Zod schema exists for this)
z.enum(["coalesce", "last_modified", "collect", "bool_or"])
```

Add a `case "bool_or"` branch to `resolveConflicts()`:

```typescript
case "bool_or": {
  // Resolved value is true if the existing canonical is already true,
  // OR if the incoming value is truthy.
  const alreadyTrue = Boolean(existing?.val);
  if (!alreadyTrue && Boolean(incomingVal)) {
    resolved[field] = true;
  }
  // If alreadyTrue: no change needed; the shadow already holds true.
  // If neither is truthy: no change needed; we don't write false to
  // avoid overwriting a prior true contributed by another source.
  break;
}
```

Note: `bool_or` never writes `false` because doing so would erase a `true` that an earlier
source contributed. A field can therefore only transition `null/false → true`, never
`true → false`. Resetting the flag requires removing it from all sources' shadow states
(outside the scope of this plan).

---

### § 3.3 Expression resolver (`resolve` function on `FieldMapping`)

Named strategies (`collect`, `bool_or`) belong in `ConflictConfig.fieldStrategies` where
they are config-file serialisable. A custom resolver function, however, cannot be serialised
to YAML — it is only usable via the TypeScript embedded API, like `expression`,
`reverseExpression`, `normalize`, `default`, `defaultExpression`, and `group`.

Add an optional `resolve` function to `FieldMapping` in `loader.ts`:

```typescript
export interface FieldMapping {
  source?:            string;
  target:             string;
  direction?:         "bidirectional" | "forward_only" | "reverse_only";
  expression?:        (record: Record<string, unknown>) => unknown;
  reverseExpression?: (record: Record<string, unknown>) => unknown;
  normalize?:         (value: unknown) => unknown;
  group?:             string;
  default?:           unknown;
  defaultExpression?: (record: Record<string, unknown>) => unknown;
  /** Resolution-time aggregator.
   *  Called during conflict resolution instead of the global strategy.
   *  @param incoming  The value arriving from the current source.
   *  @param existing  The current canonical value (previous winner, possibly
   *                   accumulated by earlier ingests). `undefined` on first ingest.
   *  @returns The new canonical value to store.
   *  Spec: specs/field-mapping.md §2.3 */
  resolve?: (incoming: unknown, existing: unknown | undefined) => unknown;
}
```

**`FieldMappingEntrySchema` in `schema.ts` does not gain this field** — functions cannot be
serialised to JSON/YAML. Config-file expression support (e.g. SQL strings evaluated server-side)
is a separate future item.

**Algorithm change in `resolveConflicts()`:**

The `resolve` function is checked before the `fieldStrategies` override and before the global
strategy. It must run after the group pre-pass and after the `normalize` noop guard (a resolver
should still respect the precision-loss guard):

```typescript
// In the per-field loop, after the group gate and normalize guard:

const resolverFn = fieldMappings?.find((m) => m.target === field)?.resolve;
if (resolverFn) {
  resolved[field] = resolverFn(incomingVal, existing?.val);
  continue;
}

// … existing fieldStrategies / fieldMasters / global LWW …
```

**Usage examples:**

```typescript
// Max score across CRM and ERP
{ target: "score", resolve: (v, acc) =>
    Math.max(Number(v) || 0, Number(acc) || 0) }

// Concatenate descriptions (ordered accumulation)
{ target: "notes", resolve: (v, acc) =>
    [acc, v].filter(Boolean).join('\n---\n') }

// Earliest timestamp wins (min-date)
{ target: "createdAt", resolve: (v, acc) => {
    if (!acc) return v;
    return String(v) < String(acc) ? v : acc;
  }
}
```

---

### § 3.4 Interaction with existing mechanisms

| Mechanism | Interaction |
|-----------|-------------|
| `group` pre-pass | Runs before resolve; group winner still governs which sources may contribute. |
| `normalize` guard | Precision-loss check still applies before the resolver is called. |
| `fieldStrategies` | `resolve` function takes precedence over `fieldStrategies[field]` when both are declared. |
| Target-centric noop (written_state) | Resolver output is treated as the resolved value; noop check runs after resolution as normal. |
| Echo prevention | Resolver output feeds into the per-field diff; if resolver output equals shadow, field is noop. |

---

## § 4 Tests

All new test cases go in `packages/engine/src/core/conflict.test.ts`.

### § 4.1 `collect` tests

| ID | Scenario |
|----|---------|
| RS1 | First source: field accepted as scalar → shadow holds the scalar |
| RS2 | Second source: appends to scalar → shadow holds `[first, second]` |
| RS3 | Third source sends duplicate value → array unchanged |
| RS4 | Two sources with array values: merges unique values |

### § 4.2 `bool_or` tests

| ID | Scenario |
|----|---------|
| BO1 | First source sends `true`: accepted, shadow = `true` |
| BO2 | First source sends `false`: accepted by fast-path (no existing shadow), shadow = `false` |
| BO3 | Existing shadow = `true`, incoming = `false`: no change (does not overwrite `true`) |
| BO4 | Existing shadow = `false`, incoming = `true`: updated to `true` |
| BO5 | Existing shadow = `false`, incoming = `false`: no change |
| BO6 | Existing shadow = `null/undefined`, incoming = truthy string: updated to `true` |

### § 4.3 Expression resolver tests

| ID | Scenario |
|----|---------|
| ER1 | `Math.max` resolver — first source sets initial value |
| ER2 | `Math.max` resolver — second source with higher value wins |
| ER3 | `Math.max` resolver — second source with lower value: existing preserved |
| ER4 | Resolver returning `undefined` produces noop (no write) |
| ER5 | Resolver takes precedence over `fieldStrategies[field]` when both present |
| ER6 | Resolver runs after `normalize` guard — precision-equivalent value still noop |

---

## § 5 Sequence of Changes

1. Add tests RS1–RS4 for `collect` in `conflict.test.ts` (TDD — all should pass immediately).  
2. Add `"bool_or"` to `ConflictConfig.fieldStrategies` type in `loader.ts` + schema.ts.  
3. Implement `bool_or` case in `conflict.ts`.  
4. Add tests BO1–BO6 (write failing, implement, verify passing).  
5. Add `resolve?` to `FieldMapping` in `loader.ts`.  
6. Implement `resolve` branch in `resolveConflicts()`.  
7. Add tests ER1–ER6.  
8. Update specs per §2.  
9. Run `bun run tsc --noEmit && bun test`.  
