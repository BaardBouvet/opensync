# Field Groups (Atomic Resolution)

**Status:** backlog  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** Engine — field mapping  
**Scope:** `packages/engine/src/config/loader.ts`, `packages/engine/src/config/schema.ts`, `packages/engine/src/core/conflict.ts`, `specs/field-mapping.md`  
**Depends on:** nothing — uses existing `resolveConflicts` infrastructure  

---

## § 1 Problem Statement

`specs/field-mapping.md §1.8` documents field groups as a mechanism for **atomic resolution**:
all fields sharing the same `group` label are resolved from a single winning source. The primitive
is currently marked *designed, not yet implemented*.

Without groups, conflict resolution operates per-field independently. This allows incoherent mixes:
the ERP wins `street`, the CRM wins `city`, and the resolved address is a chimera of two
different addresses. Groups prevent this by ensuring that once any field in the group is won by a
source, all remaining fields in that group are also taken from the same source.

The spec example (§1.8) is a shipping address: `ship_street`, `ship_city`, `ship_zip` share
`group: shipping_address`. The source that wins any one field wins all three.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §1.8 | Update status from "designed, not yet implemented" to "implemented". Add group timestamp semantics paragraph (see §3.3 below). No other structural changes needed. |

---

## § 3 Design

### § 3.1 Type changes — `FieldMapping` in `loader.ts`

```typescript
export interface FieldMapping {
  // ... existing fields ...
  /** Atomic resolution group label. All fields sharing the same label resolve from
   *  the same winning source. Spec: specs/field-mapping.md §1.8 */
  group?: string;
}
```

The Zod `FieldMappingEntrySchema` in `schema.ts` gains:

```typescript
group: z.string().optional(),
```

### § 3.2 Algorithm — group-aware `resolveConflicts()`

`resolveConflicts()` already iterates fields independently. The change is a **group pre-pass**:
before entering the per-field loop, collect group membership and elect a winning source for each
group. The per-field loop then uses the group winner (if the field belongs to a group) instead of
per-field independent resolution.

**Pre-pass: elect group winners**

```
groupWinner: Record<groupLabel, { srcId: string; ts: number }> = {}

For each group label G:
  candidates = all incoming fields that belong to G
  For each candidate field f in G:
    incomingSrc and incomingTs apply to all fields (same record, same source)
  existing winners in targetShadow (one per field, possibly different sources):
    groupExistingTs = max(existing.ts) across all fields in G that have a shadow entry
  Elect winner using the channel-level conflict strategy (coalesce or last_modified):
    - last_modified: incoming wins if incomingTs >= groupExistingTs
    - coalesce:      incoming wins if incomingPriority < existingMinPriority,
                     or (equal priority and incomingTs >= groupExistingTs)
  Record groupWinner[G] = { srcId: incomingSrc, ts: incomingTs } if incoming wins,
                           else groupWinner[G] = existing (do not overwrite)
```

**Per-field loop change**

When processing a field that belongs to group G:
- If `groupWinner[G].srcId === incomingSrc` → accept `incomingVal` (incoming source won the group).
- Otherwise → skip this field (the existing canonical value stays; the losing source yields all
  group fields, not just the ones it would have won individually).

Fields not assigned to any group continue per-field independent resolution unchanged.

### § 3.3 Group timestamp semantics

Per the spec (§1.8):

- **`last_modified` strategy**: the group's effective timestamp is the `MAX` of all field
  timestamps within the group from the winning source. This prevents a source from losing an
  atomic group just because one of its group fields has an older timestamp than another source's
  corresponding field, when the source updated the group as a unit.

- **`coalesce` strategy**: the winning source provides all non-null group fields together. A
  source that provides at least one non-null value in the group and holds the highest priority
  wins the entire group.

### § 3.4 Edge cases

| Case | Behaviour |
|------|-----------|
| Group field missing from incoming record | Field is treated as `null` for group election purposes; if the incoming source still wins the group (due to other group fields), the missing field is absent from the resolved output. |
| Only one field in a group | Behaves identically to an ungrouped field; no visible change. |
| Group spans multiple mappings with different resolution strategies | Not supported in initial implementation — group resolution uses the channel-level strategy. Per-field strategy overrides that belong to a grouped field are ignored for group election (a config-validation warning should be emitted). |
| Incoming supplies a group field; shadow has no entry for that field | Treated as "existing = null / lowest priority" for election purposes. |

### § 3.5 `resolveConflicts()` signature change

```typescript
export function resolveConflicts(
  incoming: Record<string, unknown>,
  targetShadow: FieldData | undefined,
  incomingSrc: string,
  incomingTs: number,
  config: ConflictConfig,
  fieldMappings?: FieldMappingList,    // NEW — needed to read group labels
): Record<string, unknown>
```

`fieldMappings` is already added by `PLAN_NORMALIZE_NOOP.md`. If both plans are implemented
together, the parameter is shared.

### § 3.6 Tests

New test group `field-groups` in `packages/engine/src/core/conflict.test.ts`:

| ID | Scenario |
|----|----------|
| FG1 | Two grouped fields: ERP wins street, ERP also wins city (atomic — ERP wins group) |
| FG2 | Two grouped fields: CRM has higher priority → CRM wins both, even though ERP provided non-null for one |
| FG3 | `last_modified`: ERP's group-max-ts beats CRM's group-max-ts → ERP wins all group fields |
| FG4 | `last_modified`: ERP wins field A (newer), CRM wins field B (newer); same group → whichever source has higher max-ts wins the whole group |
| FG5 | Group field missing from incoming → incoming source still wins group for fields it does provide |
| FG6 | Ungrouped field alongside grouped fields → ungrouped field resolves independently |
| FG7 | Single-field group → resolves normally, identical to ungrouped behaviour |
| FG8 | New record (no shadow) → all fields accepted regardless of group (no election needed) |
