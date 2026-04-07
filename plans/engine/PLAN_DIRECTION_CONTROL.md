# Direction Control (`bidirectional` / `forward_only` / `reverse_only`)

**Status:** complete  
**Date:** 2026-04-07  
**Domain:** Engine — field mapping  
**Scope:** `packages/engine/src/config/loader.ts`, `packages/engine/src/config/schema.ts`, `packages/engine/src/core/mapping.ts`, `plans/engine/GAP_OSI_PRIMITIVES.md`  

---

## § 1 Summary

`specs/field-mapping.md §1.2` documents three per-field direction modes:

| `direction` | Forward (source → canonical) | Reverse (canonical → source) |
|-------------|------------------------------|------------------------------|
| `bidirectional` (default) | ✓ | ✓ |
| `reverse_only` | ✗ | ✓ |
| `forward_only` | ✓ | ✗ |

This primitive is **fully implemented**. The spec section is already marked *implemented*.
`GAP_OSI_PRIMITIVES.md §5` carried a stale `❌ Gap` marker that predates the implementation.

---

## § 2 What Was Implemented

- `packages/engine/src/config/schema.ts` — `FieldDirectionSchema` (`z.enum(["bidirectional", "forward_only", "reverse_only"])`) and `FieldMappingEntrySchema.direction` (optional).
- `packages/engine/src/config/loader.ts` — `FieldMapping.direction` typed as the three-value union.
- `packages/engine/src/core/mapping.ts` — `applyMapping()` honours the direction guard:
  - `inbound` pass skips `forward_only` entries.
  - `outbound` pass skips `reverse_only` entries.
- Test coverage: `mapping.test.ts` cases FE5 (`forward_only`) and FE6 (`reverse_only`) verify both
  direction modes with and without expressions.

---

## § 3 Spec Changes Planned

None — `specs/field-mapping.md §1.2` is already correct and up to date.

The only outstanding action is updating `GAP_OSI_PRIMITIVES.md §5` to change the
**Direction control** foundation marker from `❌ Gap` to `✅ Foundation exists` (matching the
actual implementation state).

---

## § 4 Closed-Out Action

- [ ] Update `GAP_OSI_PRIMITIVES.md §5 — Direction control` foundation marker to `✅`.
