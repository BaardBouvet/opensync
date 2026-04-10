# Normalize (Precision-Loss Noop)

**Status:** complete  
**Date:** 2026-04-07  
**Effort:** S  
**Domain:** Engine — field mapping  
**Scope:** `packages/engine/src/config/loader.ts`, `packages/engine/src/core/diff.ts`, `packages/engine/src/core/conflict.ts`, `packages/engine/src/core/mapping.ts`, `specs/field-mapping.md`  

---

## § 1 Problem Statement

`specs/field-mapping.md §1.4` documents `normalize` as a per-field transform applied to **both**
the incoming value and the stored shadow value before the noop diff check. It is currently marked
*designed, not yet implemented*.

Without normalization, a connector that stores phone numbers without formatting, floats rounded to
fewer decimal places, or dates without a time component will always differ from the higher-fidelity
canonical value, triggering a write every cycle and creating an infinite update loop.

`normalize` is a **diff-time comparator only** — it does not alter the value stored in canonical or
shadow state, nor the value dispatched to any target. The higher-fidelity canonical value is
preserved; the lower-fidelity source is simply prevented from triggering redundant writes.

A secondary effect (echo-aware resolution): during conflict resolution, if
`normalize(incoming) === normalize(golden)` for each field in a group, the lower-fidelity source
is treated as equal to the canonical value and does not win resolution, preventing it from
overwriting a higher-fidelity value contributed by another source (OSI-mapping §5 "Normalize"
clause: "used for echo-aware resolution").

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §1.4 | Update status from "designed, not yet implemented" to "implemented". No structural changes needed — the YAML snippet and behaviour description already match the intended design. |

---

## § 3 Design

### § 3.1 Type changes — `FieldMapping` in `loader.ts`

```typescript
export interface FieldMapping {
  source?:            string;
  target:             string;
  direction?:         "bidirectional" | "forward_only" | "reverse_only";
  expression?:        (record: Record<string, unknown>) => unknown;
  reverseExpression?: (record: Record<string, unknown>) => unknown;
  /** Applied to both the incoming value and the stored shadow value before the noop diff
   *  check. If normalize(incoming) === normalize(shadow), the field is a noop even if the
   *  raw strings differ. Does not affect stored or dispatched values.
   *  Spec: specs/field-mapping.md §1.4 */
  normalize?:         (v: unknown) => unknown;
}
```

The Zod schema (`FieldMappingEntrySchema` in `schema.ts`) does **not** gain a `normalize` field —
functions cannot be serialised to JSON/YAML. This property is available only through the embedded
TypeScript API.

### § 3.2 Logic changes — `diff.ts`

`diff()` gains an optional `fieldMappings` parameter and applies per-field normalization before
equality comparison:

```typescript
export function diff(
  incoming: Record<string, unknown>,
  shadow: FieldData | undefined,
  assocSentinel: string | undefined,
  fieldMappings?: FieldMappingList,    // NEW — optional; default: no normalization
): DiffAction {
  if (shadow === undefined) return "insert";

  const shadowKeys = Object.keys(shadow).filter((k) => k !== "__assoc__");
  const incomingKeys = Object.keys(incoming);
  if (incomingKeys.length !== shadowKeys.length) return "update";

  for (const [k, v] of Object.entries(incoming)) {
    const entry = shadow[k];
    if (!entry) return "update";
    const normalizer = fieldMappings?.find((m) => (m.target ?? m.source) === k)?.normalize;
    const lhs = normalizer ? normalizer(v) : v;
    const rhs = normalizer ? normalizer(entry.val) : entry.val;
    if (JSON.stringify(lhs) !== JSON.stringify(rhs)) return "update";
  }
  // ... assoc sentinel check unchanged ...
}
```

All call sites of `diff()` in `engine.ts` pass the channel member's `fieldMappings` as the fourth
argument. Because the parameter is optional and defaults to no-normalization, call sites that do
not carry field mappings (e.g. association diff paths) are unaffected.

### § 3.3 Logic changes — `conflict.ts`

`resolveConflicts()` gains an optional `fieldMappings` parameter. Before each per-field strategy
decision, if a normalizer is present and `normalize(incoming) === normalize(existing.val)`, the
field is treated as equal and the lower-fidelity source does not win:

```typescript
export function resolveConflicts(
  incoming: Record<string, unknown>,
  targetShadow: FieldData | undefined,
  incomingSrc: string,
  incomingTs: number,
  config: ConflictConfig,
  fieldMappings?: FieldMappingList,    // NEW
): Record<string, unknown> {
  if (!targetShadow) return incoming;

  const resolved: Record<string, unknown> = {};
  for (const [field, incomingVal] of Object.entries(incoming)) {
    const existing = targetShadow[field];
    if (!existing) { resolved[field] = incomingVal; continue; }

    // Precision-loss guard — if normalized values are equal, skip resolution for this field.
    const normalizer = fieldMappings?.find((m) => (m.target ?? m.source) === field)?.normalize;
    if (normalizer) {
      if (JSON.stringify(normalizer(incomingVal)) === JSON.stringify(normalizer(existing.val))) {
        continue;   // lower-fidelity source matches canonical; do not overwrite
      }
    }

    // ... existing per-field strategy + global strategy unchanged ...
  }
  return resolved;
}
```

### § 3.4 Tests

New test group `normalize` in `packages/engine/src/core/diff.test.ts` (and/or `mapping.test.ts`):

| ID | Scenario |
|----|----------|
| N1 | Phone: `"(555) 123-4567"` vs shadow `"5551234567"` with `normalize: (v) => String(v).replace(/\D/g,'')` → `diff` returns `skip` |
| N2 | Float: `1.23456` vs shadow `1.23`, `normalize: (v) => Number(v).toFixed(2)` → `diff` returns `skip` |
| N3 | Float out of band: `1.30` vs shadow `1.23`, same normalize → `diff` returns `update` |
| N4 | No normalizer — raw comparison unchanged (regression guard) |
| N5 | `resolveConflicts`: lower-precision source matches normalized canonical → field skipped (not overwritten) |
| N6 | `resolveConflicts`: lower-precision source differs beyond precision band → normal resolution applies |
