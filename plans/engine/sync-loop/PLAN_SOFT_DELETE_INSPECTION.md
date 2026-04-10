# Soft Delete Field Inspection

**Status:** complete  
**Date:** 2026-04-07  
**Effort:** S  
**Domain:** Engine — deletion, config  
**Scope:** `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/engine.ts`, `specs/field-mapping.md`  
**Depends on:** nothing — independent of `PLAN_DELETE_PROPAGATION` and `PLAN_HARD_DELETE`; runs before the `record.deleted` path in `_processRecords`  

---

## § 1 Problem Statement

Some source connectors return records with soft-delete indicator fields rather than omitting
deleted records from their read results. Examples:

- A CRM that populates `deleted_at` when a contact is archived.
- An ERP that sets `is_active = false` on deactivated items.
- A legacy API that exposes `is_deleted = 1` on removed records.

Currently the engine has no mechanism to interpret these fields. The connector is expected to
inspect them itself and set `ReadRecord.deleted = true`. That works for connectors you own, but
breaks down for third-party connectors (community connectors, connectors not yet updated) and
adds boilerplate that belongs in the mapping layer.

`specs/field-mapping.md §8.2` documents a `soft_delete:` config block with four strategies.
It is marked *designed, not yet implemented*. This plan implements it.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §8.2 | Update status from "designed, not yet implemented" to "implemented". Add note that the engine sets `record.deleted = true` before the standard `_processRecords` path, so fan-out behaviour is identical to a connector-reported deletion. |
| `specs/field-mapping.md` | Summary table | Update "Soft-delete field inspection" row from 🔶 to ✅. |

No new spec sections are needed — §8.2 already has the full config syntax and strategy list.

---

## § 3 Design

The `soft_delete:` block is a pre-processing step applied in `_processRecords` (and its
`collectOnly` counterpart) **before** echo detection and before any field mapping. If the
evaluated condition is truthy for the raw stripped record, the engine sets
`record.deleted = true` and lets the existing delete path handle the rest.

This keeps the implementation minimal: all deletion semantics (shadow marking, fan-out
decision, circuit breaker, event emission) continue to live in `PLAN_DELETE_PROPAGATION`'s
`_handleDeletedRecord` path. This plan only adds the condition evaluation that sets the flag.

### § 3.1 Config schema changes

**`config/schema.ts`** — add `SoftDeleteSchema` and wire it into `MappingEntrySchema`:

```ts
const SoftDeleteSchema = z.union([
  z.object({
    strategy: z.enum(["deleted_flag", "timestamp", "active_flag"]),
    field: z.string(),
  }),
  z.object({
    strategy: z.literal("expression"),
    expression: z.string(),
  }),
]);

// Inside MappingEntrySchema:
soft_delete: SoftDeleteSchema.optional(),
```

Mutual exclusion: `soft_delete` is only valid on flat (non-array) members. Add a
refinement to `MappingEntrySchema` that rejects `soft_delete` when `array_path` or
`parent` is also present.

### § 3.2 Loader changes

**`config/loader.ts`** — compile `soft_delete` at load time into a typed predicate.

New type on `ChannelMember`:

```ts
/** Spec: specs/field-mapping.md §8.2 — soft-delete field inspection.
 * When set, records for which this returns true are treated as deleted before
 * any further processing. Not present on array expansion members. */
softDeletePredicate?: (record: Record<string, unknown>) => boolean;
```

New compile function `compileSoftDeletePredicate`:

```ts
function compileSoftDeletePredicate(
  entry: SoftDeleteEntry,
  channelId: string,
): (record: Record<string, unknown>) => boolean {
  switch (entry.strategy) {
    case "deleted_flag":
      return (r) => r[entry.field] !== false && r[entry.field] != null;
    case "timestamp":
      return (r) => r[entry.field] != null;
    case "active_flag":
      return (r) => r[entry.field] !== true;
    case "expression": {
      let fn: (record: Record<string, unknown>) => unknown;
      try {
        // eslint-disable-next-line no-new-func
        fn = new Function("record", `return (${entry.expression});`) as typeof fn;
      } catch (err) {
        throw new Error(
          `soft_delete expression in channel "${channelId}" failed to compile: ${String(err)}\n  Expression: ${entry.expression}`,
        );
      }
      return (r) => Boolean(fn(r));
    }
  }
}
```

Wire in the loader's member construction block (alongside `recordFilter`):

```ts
const softDeletePredicate = !isArrayMember && entry.soft_delete
  ? compileSoftDeletePredicate(entry.soft_delete, entry.channel)
  : undefined;

// … then inside ch.members.push({ … }):
softDeletePredicate,
```

### § 3.3 Engine changes

**`engine.ts`** — `_processRecords` (standard path) and the `collectOnly` expansion path.

In `_processRecords`, in the per-record loop after stripping `_`-prefixed fields and
**before** `recordFilter` is evaluated:

```ts
// Spec: specs/field-mapping.md §8.2 — soft-delete field inspection.
// Evaluated on the raw stripped record before echo detection or field mapping.
if (!record.deleted && sourceMember.softDeletePredicate?.(stripped)) {
  record = { ...record, deleted: true };
}
```

The mutated `record` (with `deleted: true`) flows into the existing handling. Until
`PLAN_DELETE_PROPAGATION` is shipped, the minimal guard added by `PLAN_HARD_DELETE §3.1`
(mark shadow + skip) applies. Once `PLAN_DELETE_PROPAGATION` ships, full fan-out applies.

Apply the identical guard in the `collectOnly` branch (lines ~360 in `engine.ts`), before
the existing `recordFilter` check.

#### Ordering relative to other record-level checks

```
1. Strip _-prefix fields
2. soft_delete inspection  ← NEW
3. recordFilter check (if record is not deleted)
4. echo detection
5. inbound field mapping
6. resolution / fan-out
```

`recordFilter` is skipped when `record.deleted === true` because a deleted record should
not be silently dropped by a routing filter — it needs to propagate its deletion signal.
If a record is both filtered out (fails `recordFilter`) AND soft-deleted, the
`recordFilter` shadow-clear path already applied on the previous ingested non-deleted
version; the deletion arrives now and correctly marks the shadow as deleted.

---

## § 4 Strategy Semantics

| Strategy | Field required | Condition evaluates to deleted when… |
|----------|---------------|--------------------------------------|
| `deleted_flag` | `field` | `record[field] !== false && record[field] != null` — truthy and not explicitly false |
| `timestamp` | `field` | `record[field] != null` — any non-null value in the timestamp column |
| `active_flag` | `field` | `record[field] !== true` — not explicitly true (null and false both classify as deleted) |
| `expression` | `expression` | result of the JS expression is truthy; binding is `record` |

The `expression` strategy is compiled once at load time via `new Function` on the same
security footing as `filter` / `reverse_filter` (see `PLAN_RECORD_FILTER.md §6`).

---

## § 5 Tests

All tests in `packages/engine/src/soft-delete-inspection.test.ts` (or appended to
`packages/engine/src/engine.test.ts`):

| ID | Description |
|----|-------------|
| SD1 | `deleted_flag`: record with `is_deleted = true` is treated as deleted |
| SD2 | `deleted_flag`: record with `is_deleted = false` is NOT treated as deleted |
| SD3 | `deleted_flag`: record with `is_deleted = null` is NOT treated as deleted |
| SD4 | `timestamp`: record with `deleted_at = "2026-01-01"` is treated as deleted |
| SD5 | `timestamp`: record with `deleted_at = null` is NOT treated as deleted |
| SD6 | `active_flag`: record with `is_active = false` is treated as deleted |
| SD7 | `active_flag`: record with `is_active = null` is treated as deleted |
| SD8 | `active_flag`: record with `is_active = true` is NOT treated as deleted |
| SD9 | `expression`: custom expression `record.archived && !record.vip` evaluated correctly |
| SD10 | Compile-time error thrown for invalid `expression` syntax |
| SD11 | `soft_delete` on array expansion member is rejected at config load time |
| SD12 | Connector-reported `deleted: true` is unaffected when no `soft_delete` config is present |
| SD13 | Shadow row has `deleted_at` set after soft-delete field triggers deletion |
| SD14 | Same record re-ingested without soft-delete field → treated as resurrection |

---

## § 6 Relationship to Other Deletion Plans

| Plan | Responsibility |
|------|---------------|
| This plan | Config-level field inspection that sets `record.deleted = true` |
| `PLAN_HARD_DELETE` | Synthesises `record.deleted = true` from entity/element *absence* |
| `PLAN_DELETE_PROPAGATION` | Handles `record.deleted = true`: shadow marking, fan-out dispatch, circuit breaker |

All three plans feed the same `record.deleted` path. They are independent and can ship in
any order. Shipping this plan or `PLAN_HARD_DELETE` before `PLAN_DELETE_PROPAGATION` means
deletion is detected and shadow-marked but not fanned out to targets — which is the safe
default.
