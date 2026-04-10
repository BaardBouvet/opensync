# PLAN: Schema Enforcement — required / immutable on entity fields and nested properties

**Status:** backlog  
**Date:** 2026-04-09  
**Effort:** M  
**Domain:** packages/engine  
**Scope:** `_dispatchToTarget` pre-write enforcement pass; recursive descent into object/array `FieldType` properties  
**Spec:** specs/connector-sdk.md, specs/sync-engine.md  
**Depends on:** PLAN_ARRAY_ITEM_SCHEMA.md (for `FieldDescriptor` to be available in nested object properties)  
**Related:** PLAN_FIELD_READONLY.md (orthogonal — `readonly` server-computed strip; separate concern)

---

## 1. Problem

### 1.1 Top-level enforcement is spec'd but not implemented

`specs/connector-sdk.md` states:

> Fields marked `required: true` are enforced: the engine produces a synthetic error result
> for any record missing a required field before it reaches `insert()` or `update()`.
> Fields marked `immutable: true` are frozen after creation: the engine strips them from
> `UpdateRecord.data` before calling `update()`, so the connector never sees an attempt to
> overwrite them.

`_dispatchToTarget` in `engine.ts` does not implement either of these checks. The
`FieldDescriptor.required` and `FieldDescriptor.immutable` properties on the target entity's
`schema` are never consulted during the fan-out write path. The spec is aspirational — the
enforcement is entirely missing.

### 1.2 Nested enforcement is also missing

Once `PLAN_ARRAY_ITEM_SCHEMA` lands and `FieldType.object.properties` becomes
`Record<string, FieldDescriptor>`, a connector can declare:

```typescript
schema: {
  lines: {
    type: {
      type: "array",
      items: {
        type: "object",
        properties: {
          lineNo:     { type: "string", required: true },
          sku:        { type: "string", required: true },
          customerId: { type: "string", entity: "accounts", required: true },
          internalId: { type: "string", immutable: true },
        },
      },
    },
  },
}
```

Nothing enforces those nested descriptors. The engine passes `lines` as an opaque JSON
blob to the connector without inspecting the item schema at all.

---

## 2. Proposed Design

All enforcement happens inside `_dispatchToTarget`, immediately before the `doWrite` call,
acting on `localData` (post-mapping, post-ref-strip). Two separate passes:

### 2.1 Pass 1 — required check

Walk the target entity's `schema`. For each top-level `FieldDescriptor` marked
`required: true`, check that the corresponding key exists in `localData` with a non-null
value. If any violation is found, return `{ type: "error", error: "..." }` without calling
`insert()` or `update()`. This matches the spec-stated behaviour ("synthetic error result").

Recursively descend into `FieldType.object.properties` for any field whose value in
`localData` is an array of objects or a plain object. The recursive check applies the same
rule: if `properties[p].required` is `true` and `p` is absent or null in the item, it
is a violation. Apply the check to every element of an array field.

```typescript
// Pseudocode
function checkRequired(
  data: Record<string, unknown>,
  schema: Record<string, FieldDescriptor>,
  path: string,
): string | null {
  for (const [field, desc] of Object.entries(schema)) {
    const value = data[field];
    if (desc.required && (value === undefined || value === null)) {
      return `required field '${path}${field}' is missing or null`;
    }
    // Recurse into object/array items
    if (
      desc.type &&
      typeof desc.type === "object" &&
      desc.type.type === "object" &&
      desc.type.properties
    ) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const msg = checkRequired(value as Record<string, unknown>, desc.type.properties, `${path}${field}.`);
        if (msg) return msg;
      }
    }
    if (
      desc.type &&
      typeof desc.type === "object" &&
      desc.type.type === "array" &&
      typeof desc.type.items === "object" &&
      desc.type.items?.type === "object" &&
      desc.type.items.properties
    ) {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (typeof item === "object" && item !== null) {
            const msg = checkRequired(item as Record<string, unknown>, desc.type.items.properties!, `${path}${field}[${i}].`);
            if (msg) return msg;
          }
        }
      }
    }
  }
  return null;
}
```

Error message format: `required field 'lines[2].lineNo' is missing or null` so the
connector author can trace the exact element.

### 2.2 Pass 2 — immutable strip

Walk the target entity's `schema`. For each top-level `FieldDescriptor` marked
`immutable: true`, delete (or omit) that key from `localData` when `existingTargetId` is
defined (i.e., this is an update, not an insert). On insert, `immutable` fields pass through
unchanged — a connector may need to receive them on creation.

Recurse into object/array items: for each element of an array or object value, strip any
nested property key where `properties[p].immutable === true` (again only on update).

Because `localData` may be a shared reference, perform the strip on a shallow copy so
the caller's view is not mutated:

```typescript
function stripImmutable(
  data: Record<string, unknown>,
  schema: Record<string, FieldDescriptor>,
  isUpdate: boolean,
): Record<string, unknown> {
  if (!isUpdate) return data;
  const out: Record<string, unknown> = { ...data };
  for (const [field, desc] of Object.entries(schema)) {
    if (desc.immutable) {
      delete out[field];
      continue;
    }
    const value = out[field];
    // Recurse into plain object
    if (
      typeof desc.type === "object" &&
      desc.type.type === "object" &&
      desc.type.properties &&
      typeof value === "object" && value !== null && !Array.isArray(value)
    ) {
      out[field] = stripImmutable(value as Record<string, unknown>, desc.type.properties, true);
    }
    // Recurse per element of an array
    if (
      typeof desc.type === "object" &&
      desc.type.type === "array" &&
      typeof desc.type.items === "object" &&
      desc.type.items?.type === "object" &&
      desc.type.items.properties &&
      Array.isArray(value)
    ) {
      out[field] = value.map((item) =>
        typeof item === "object" && item !== null
          ? stripImmutable(item as Record<string, unknown>, desc.type.items!.properties!, true)
          : item
      );
    }
  }
  return out;
}
```

### 2.3 Ordering

1. `stripImmutable` — remove frozen fields from `localData` (produces `safeLocalData`)
2. `checkRequired` — validate `safeLocalData` against `schema.required` (error if violated)
3. Proceed to `doWrite` with `safeLocalData`

Stripping first means an immutable field cannot simultaneously trigger a required violation
on update — the strip wins. If a field is both `required` and `immutable` on update, the
engine strips it (which is the correct behaviour: the target connector already has the value
from the original insert).

### 2.4 Schema source

The schema consulted is `targetEntityDef.schema` — the target connector's entity schema, not
the source connector's. The target knows which of its own fields are required or immutable.
The source schema is irrelevant to write-side enforcement.

---

## 3. Edge cases

| Case | Behaviour |
|------|-----------|
| `required` field on insert — value absent in `localData` | Error returned; `insert()` not called |
| `required` field on update — value absent | Same: error returned; `update()` not called |
| `immutable` field on insert | Field passes through unchanged (connector may set it on first write) |
| `immutable` field on update | Stripped from `localData` before `update()` |
| Array field value is not an array at runtime | Skip recursive descent; treat as opaque value |
| Array element is not an object | Skip that element; do not recurse |
| `schema` absent from `targetEntityDef` | Both passes are no-ops; behaviour unchanged from today |
| `required` + `immutable` on same field, on update | Strip wins; field absent → no required error |
| Deeply nested (`array → object → array → object`) | Recursion handles it naturally; depth is bounded by the declared `FieldType` tree |

---

## 4. Spec changes planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-sdk.md` | § Entities (`schema` prose) | Clarify that enforcement already applies recursively to nested `FieldType.object.properties` and `FieldType.array.items.properties` after `PLAN_ARRAY_ITEM_SCHEMA` lands |
| `specs/sync-engine.md` | § Dispatch (fan-out write path) | Add a § describing the two-pass schema enforcement: immutable strip then required check, applied before `doWrite`, with path-qualified error messages for nested violations |

---

## 5. Implementation checklist

- [ ] Extract `checkRequired(data, schema, path)` as a pure function in `engine.ts` (or a new `core/schema-enforcement.ts` module)
- [ ] Extract `stripImmutable(data, schema, isUpdate)` as a pure function
- [ ] Call both at the start of `_dispatchToTarget` before `doWrite`, using `targetEntityDef.schema`
- [ ] Write unit tests covering:
  - Top-level `required`: absent field → error
  - Top-level `required`: null field → error
  - Top-level `required`: present field → no error
  - Top-level `immutable` on insert: field passed through
  - Top-level `immutable` on update: field stripped
  - Nested `required` in array item: one absent element → error with path like `lines[1].lineNo`
  - Nested `immutable` in array item on update: stripped per element
  - No schema on entity: no enforcement, no error
  - `required` + `immutable` on same field, update: field stripped, no required error
- [ ] Update `specs/connector-sdk.md` and `specs/sync-engine.md` (§ 4 above)
- [ ] Run `bun run tsc --noEmit` and `bun test`
- [ ] Add `CHANGELOG.md` entry under `[Unreleased] ### Added`
