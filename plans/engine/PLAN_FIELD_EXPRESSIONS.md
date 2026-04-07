# Field Expressions

**Status:** backlog  
**Date:** 2026-04-07  
**Effort:** S  
**Domain:** Engine — field mapping  
**Scope:** `packages/engine/src/config/loader.ts`, `packages/engine/src/core/mapping.ts`, `specs/field-mapping.md`  

---

## § 1 Problem Statement

`specs/field-mapping.md §1.3` documents `expression` and `reverseExpression` as the way
to combine, compute, or decompose fields during a sync pass.  They are marked *implemented* —
but the types, schema, and `applyMapping()` function have no expression support at all.

The embedded engine API (constructing `ResolvedConfig` directly in TypeScript) is where this
matters most: callers already have a full TypeScript environment and want to pass real functions
rather than duplicate transform logic in connector `read()` methods.

---

## § 2 Spec Changes Planned

- `specs/field-mapping.md §1.3` — update status from "designed, not yet implemented" to
  "implemented" once the plan is complete.  No structural changes to the spec text are needed;
  the YAML snippets there already describe the intended interface.

No other spec files require changes.

---

## § 3 Design

### § 3.1 Type changes — `FieldMapping` in `loader.ts`

```typescript
export interface FieldMapping {
  source?:            string;
  target:             string;
  direction?:         "bidirectional" | "forward_only" | "reverse_only";
  /** Forward pass (source → canonical).
   *  Receives the full incoming record; returns the value for `target`.
   *  When present, `source` is ignored — the expression has access to all fields. */
  expression?:        (record: Record<string, unknown>) => unknown;
  /** Reverse pass (canonical → source).
   *  Receives the full canonical record.
   *  Return a single value to assign to the source field (`source ?? target`),
   *  or return a plain object to merge multiple source fields at once (decomposition). */
  reverseExpression?: (record: Record<string, unknown>) => unknown;
}
```

The Zod schema (`FieldMappingEntrySchema` in `schema.ts`) is for config-file parsing only
and does **not** gain function fields — functions cannot be serialised to JSON/YAML.
Config-file expression support (e.g. SQL strings evaluated via SQLite) is a separate future
item.

### § 3.2 Logic changes — `applyMapping()` in `mapping.ts`

**Inbound pass** — after the existing direction guard:

```
if m.expression:
  result[m.target] = m.expression(data)   // data = full incoming record
else:
  // existing source-key rename logic
```

`forward_only` direction entries that have no `source` and no `expression` currently produce
nothing (the source key is missing).  With expressions this is the normal usage pattern for
computed / synthetic fields — the expression creates the value from scratch.

**Outbound pass** — after the existing direction guard:

```
if m.reverseExpression:
  const v = m.reverseExpression(data)     // data = full canonical record
  if v !== null && typeof v === "object" && !Array.isArray(v):
    Object.assign(result, v)              // decomposition: spread multiple source keys
  else:
    result[m.source ?? m.target] = v      // single-value assignment
else:
  // existing target-key rename logic
```

### § 3.3 Examples (matches spec §1.3)

**Combine first + last name (forward only)**

```typescript
{
  target: "fullName",
  direction: "forward_only",
  expression: (r) => `${r.firstName} ${r.lastName}`,
  reverseExpression: (r) => ({
    firstName: String(r.fullName ?? "").split(" ")[0],
    lastName:  String(r.fullName ?? "").split(" ").slice(1).join(" "),
  }),
}
```

The `reverseExpression` returns an object → both `firstName` and `lastName` are written back
to the target connector.

**Normalize email**

```typescript
{
  source: "email",
  target: "email",
  expression: (r) => typeof r.email === "string" ? r.email.toLowerCase() : r.email,
}
```

**Status enum mapping**

```typescript
{
  source: "is_active",
  target: "status",
  expression: (r) => r.is_active ? "active" : "inactive",
  reverseExpression: (r) => r.status === "active",
}
```

---

## § 4 Implementation Steps

1. Add `expression?` and `reverseExpression?` to `FieldMapping` interface in
   `packages/engine/src/config/loader.ts`.
2. Update `applyMapping()` in `packages/engine/src/core/mapping.ts`:
   - Inbound: call `m.expression(data)` when present; skip source-key lookup.
   - Outbound: call `m.reverseExpression(data)` when present; spread or assign based on
     return type.
3. Write unit tests in a new `packages/engine/src/core/mapping.test.ts`:
   - Combine-fields (forward_only, expression + reverseExpression decomposition)
   - Single-value expression (email normalise)
   - Enum mapping (expression → scalar, reverseExpression → scalar)
   - Expression with `direction: "forward_only"` → no reverse pass
   - Expression with `direction: "reverse_only"` → no forward pass
   - Mix of expression entries and plain rename entries in the same mapping list
4. Update `specs/field-mapping.md §1.3` status to **implemented**.
5. Update `plans/INDEX.md` and `CHANGELOG.md`.

---

## § 5 Out of Scope

- **Config-file (YAML/JSON) expression strings** — SQL or template expression support for
  non-embedded deployments.  Deferred; the Zod schema is not changed.
- **`normalize` (§1.4)** — diff-time comparator, separate plan.
- **`default` / `defaultExpression` (§1.5)** — separate plan.
