# Reverse Required

**Status:** backlog  
**Date:** 2026-04-07  
**Effort:** XS  
**Domain:** Engine — field mapping  
**Scope:** `packages/engine/src/config/loader.ts`, `packages/engine/src/core/mapping.ts`, `packages/engine/src/engine.ts`, `specs/field-mapping.md`  

---

## § 1 Problem Statement

`GAP_OSI_PRIMITIVES.md §6` documents `reverse_required` as a per-field boolean. When `true`, the
entire dispatched row is **suppressed** (not written to the target connector) if the resolved value
for that field is null or absent after outbound mapping.

Currently the engine dispatches records to targets regardless of whether critical fields are
populated. `reverse_required` is the mechanism for holding back a write until essential values are
available — for example, suppressing an ERP insert until a canonical ID resolved by the CRM has
been linked, or preventing an upstream system from receiving a record whose required identifier has
not yet been assigned.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §1.x (new, after §1.5) | Add `reverseRequired` section: purpose, YAML and TypeScript examples, interaction with `written_state` (no entry written on suppression). Status: "designed, not yet implemented". |

---

## § 3 Design

### § 3.1 Type changes — `FieldMapping` in `loader.ts`

```typescript
export interface FieldMapping {
  // ... existing fields ...
  /** When true, the entire dispatched row is suppressed if this field's value is null or
   *  absent in the outbound-mapped record. No entry is written to written_state.
   *  Spec: specs/field-mapping.md §1.6 (placeholder number — assign at write time) */
  reverseRequired?: boolean;
}
```

The Zod `FieldMappingEntrySchema` in `schema.ts` gains:

```typescript
reverseRequired: z.boolean().optional(),
```

This is safe to include in the YAML schema because it is a plain boolean, not a function.

### § 3.2 Helper — `mapping.ts`

A small pure function alongside `applyMapping`:

```typescript
/** Returns true when any field with reverseRequired:true maps to a null/undefined value,
 *  signalling that the dispatch to this target should be suppressed.
 *  Spec: specs/field-mapping.md §1.6 */
export function isDispatchBlocked(
  outboundRecord: Record<string, unknown>,
  mappings: FieldMappingList | undefined,
): boolean {
  if (!mappings) return false;
  for (const m of mappings) {
    if (!m.reverseRequired) continue;
    const key = m.source ?? m.target;
    const val = outboundRecord[key];
    if (val === null || val === undefined) return true;
  }
  return false;
}
```

### § 3.3 Engine.ts fan-out change

In the fan-out loop, after `applyMapping(canonical, member.fieldMappings, "outbound")` and before
calling `connector.insert()` / `connector.update()`:

```typescript
// Spec: specs/field-mapping.md §1.6 — reverse_required guard
if (isDispatchBlocked(outboundRecord, member.fieldMappings)) {
  continue;    // skip dispatch; no written_state entry
}
```

A suppressed dispatch:
- Does not call `connector.insert()` or `connector.update()`
- Does not write a `written_state` row (the target never received the data)
- Does not advance the watermark for this entity on this connector

### § 3.4 Tests

New test group `reverse_required` in `packages/engine/src/core/mapping.test.ts` and/or an
integration case in `packages/engine/src/engine.test.ts`:

| ID | Scenario |
|----|----------|
| RR1 | Required field present and non-null → `isDispatchBlocked` returns `false` |
| RR2 | Required field is `null` → `isDispatchBlocked` returns `true` |
| RR3 | Required field is `undefined` (key missing from outbound record) → `isDispatchBlocked` returns `true` |
| RR4 | Multiple required fields, all present → dispatch proceeds |
| RR5 | Multiple required fields, one null → dispatch suppressed |
| RR6 | No `reverseRequired` fields on mapping → `isDispatchBlocked` always returns `false` (regression guard) |
| RR7 | Integration: engine fan-out suppressed when required field missing → connector mock receives zero calls |
