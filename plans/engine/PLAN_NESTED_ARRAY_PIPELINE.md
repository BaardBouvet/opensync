# Nested Array Pipeline

**Status:** draft  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** engine, field-mapping  
**Scope:** forward-pass array expansion in the ingest loop  
**Spec:** specs/field-mapping.md §3.2  
**Depends on:** nothing — existing ingest loop is the foundation  

---

## Problem

Source systems frequently store one-to-many relationships as embedded JSON arrays rather
than as normalised record sets. An ERP order record carries a `lines` column containing
`[{ product_id, quantity, unit_price }, …]`. Today the engine treats `ReadRecord.data`
as a flat key-value map; there is no mechanism to expand those array elements into
independent child entity records that can be diffed, resolved, and dispatched individually.

Without array expansion:

- Array updates are invisible to the diff engine — the whole `lines` blob is a single
  opaque value.
- Cross-connector sync of detail rows (order lines ↔ invoice items) is impossible
  without the connector pre-flattening the data.
- Resolution strategies (LWW, coalesce) cannot operate per-element.

---

## Spec changes planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §3.2 | Promote from "requires design work" to "designed". Specify `element_key`, exact identity derivation formula, `parent_fields` `ParentFieldRef` object syntax, dotted `array_path` support. Document that child mappings have no `entity` field and produce no source-side `shadow_state` or `identity_map` rows; canonical UUIDs are derived from the parent. |
| `specs/field-mapping.md` | §3.3, §3.4 | Update status lines to "planned follow-on — depends on §3.2 implementation". |
| `specs/config.md` | `mappings/*.yaml` section | Document `name` as an optional stable identifier (required only when referenced by a child via `parent:`). Document `parent`, `array_path`, `parent_fields`, `element_key` mapping keys with examples. Document that child mappings (those with `parent:`) omit `entity` and inherit the parent's connector and read source. |
| `specs/sync-engine.md` | Ingest Loop §step 4a | Add note: "If the source member declares `array_path`, the record is expanded into N child records by the array expander before the identity and diff steps. Child records skip the `linkExternalId` call; their canonical IDs are derived deterministically from the parent canonical ID." |

No connector-sdk changes are needed. Array expansion is purely engine-side; connectors
yield raw records with whatever structure the source API returns.

---

## Design

### 1. Config additions — mapping keys

Add four optional keys to a mapping entry (the per-connector-per-entity block in
`mappings/*.yaml`). `name` becomes **required** on every mapping entry (not scoped to
array expansion):

| Key | Type | Meaning |
|-----|------|---------|
| `name` | `string` | Optional stable identifier for this mapping entry. Used for observability: events, logs, and metrics reference it by name. Also the target of `parent:` on child mappings — required on any mapping that a child will reference. |
| `parent` | `string` | Name of the parent mapping entry (its `name:` value). The child inherits the parent's connector and read source. Required when `array_path` is set. Child mappings omit `entity`. |
| `array_path` | `string` | Dotted JSON path to the array column on the source record (`lines`, `order.lines`). |
| `parent_fields` | `Record<string, string \| ParentFieldRef>` | Parent source fields to bring into scope for element field mapping. Key = local alias used in `source:` on child field mappings. Value = parent field name (string shorthand) or a `{ path, field }` object for deep nesting (OSI-mapping `ParentFieldRef`). |
| `element_key` | `string` | Field name *within each array element* whose value is the stable element identity. Omit to use index-based identity. |

Example mapping entry:

```yaml
  - name: erp_orders              # named so the child can reference this mapping
    connector: erp
    channel: order-lines
    entity: orders
    fields:
      - source: order_id
        target: orderId

  - name: erp_order_lines
    channel: order-lines
    parent: erp_orders            # references the mapping name above; connector + read source are inherited; no entity field
    array_path: lines
    parent_fields:
      order_id: order_id           # alias: parent_field (same name)
      parentCustomerId: customer_id  # rename to avoid element field collision
    element_key: line_no           # stable per-element ID; falls back to index if absent
    fields:
      - source: line_no
        target: lineNumber
      - source: product_id
        target: productId
      - source: quantity
        target: qty
      - source: unit_price
        target: unitPrice
```

### 2. Resolved config types

Extend `ChannelMember` in `packages/engine/src/config/loader.ts`:

```typescript
export interface ChannelMember {
  name?: string;               // optional — stable label for observability (events, logs); required only when referenced by a child via parentMappingName
  connectorId: string;
  entity?: string;             // connector entity to call read() on; required on top-level mappings; absent on child mappings (parent: set)
  inbound?: FieldMappingList;
  outbound?: FieldMappingList;
  assocMappings?: AssocPredicateMapping[];
  // Nested array expansion (specs/field-mapping.md §3.2)
  arrayPath?: string;          // dotted path to the array column
  parentMappingName?: string;  // name of the parent mapping entry (resolved from `parent` key)
  parentFields?: Record<string, string | { path?: string; field: string }>;  // parent fields in scope: alias → source field (OSI-mapping ParentFieldRef)
  elementKey?: string;         // element field used as stable identity key
}
```

Extend the Zod/raw `MappingEntry` schema in
`packages/engine/src/config/schema.ts` with the same four optional fields.

The loader must populate `arrayPath`, `parentMappingName`, `parentFields`, `elementKey`
on the resolved `ChannelMember` when present in the YAML mapping entry, and `name` when
present. The loader validates that any mapping referencing a `parent:` resolves to an
existing mapping entry that carries a matching `name:`.

Validation rules (enforced at config load time):

- If `array_path` is set then `parent` must also be set — reject otherwise.
- The `parent` value must match the `name` field of another mapping entry for the
  same connector in the same channel (same-channel case) or in any channel
  (cross-channel case, see PLAN_CROSS_CHANNEL_EXPANSION.md) — reject otherwise
  (prevents dangling parent references at startup).

### 3. Array expander module

New file: `packages/engine/src/core/array-expander.ts`

```typescript
// Spec: specs/field-mapping.md §3.2 — nested array expansion forward pass
import type { ReadRecord } from "@opensync/sdk";
import type { ChannelMember } from "../config/loader.js";

/**
 * If `member` declares an `arrayPath`, expand `record` into one `ReadRecord`
 * per array element.  Returns `[record]` unchanged when no expansion is needed.
 *
 * Identity: `<parent_id>#<arrayPath>[<elementKey_value | index>]`
 * Parent fields listed in `member.parentFields` are merged into each element.
 */
export function expandArrayRecord(
  record: ReadRecord,
  member: ChannelMember,
): ReadRecord[] { … }
```

**Algorithm (forward pass):**

1. If `member.arrayPath` is undefined → return `[record]`.
2. Resolve the array from the source record using the dotted `arrayPath`:
   - Split on `.`, traverse `record.data` depth-first.
   - If the resolved value is a JSON string, `JSON.parse` it.
   - If the result is not an array, log a warning and return `[record]` unchanged
     (graceful degradation — treat the containing record as a flat record).
3. Build `parent_scope`: a `Record<string, unknown>` from `member.parentFields` and
   `record.data`. For each entry `(alias, ref)`:
   - String ref: `parent_scope[alias] = record.data[ref]`.
   - Object ref `{ field }` (flat): `parent_scope[alias] = record.data[field]`.
   - Object ref `{ path, field }` (deep): traverse `record.data` by `path` then read `field`.
4. Compute `parentId`: `record.id` (the external ID on the `ReadRecord`).
5. For each element at index `i`:
   a. `elementKeyValue`: if `member.elementKey` and the element has that field,
      use `String(element[member.elementKey])`; otherwise use `String(i)`.
   b. `childId = `${parentId}#${member.arrayPath}[${elementKeyValue}]``
   c. Merge `parent_scope` into the element object (element fields win on collision;
      the caller resolves any remaining ambiguity by using `{ source, as }` rename).
   d. Emit a `ReadRecord { id: childId, data: mergedData }`.
6. Return the array of child `ReadRecord`s.

### 4. Ingest loop integration

Location: `packages/engine/src/engine.ts`, inside the per-record loop of `ingest()`.

Current step 4a (paraphrased):

```
Strip _-prefixed meta fields; apply inbound field mapping
```

New step 4a:

```
Strip _-prefixed meta fields
↓  expandArrayRecord(record, sourceMember)   ← NEW
↓  For each expanded child record:
     apply inbound field mapping
     resolve canonical ID
     diff → delta
     fan-out
```

When a connector member has no `arrayPath` (the common case), `expandArrayRecord`
returns a single-element list containing the original record. There is no overhead and
no code-path change for existing connectors.

When a member has `arrayPath`, the loop body runs once per produced child record. Each
child record is processed as follows — **no `shadow_state` rows are written for the
source side of child members**:

- **Canonical ID**: derived deterministically as
  `uuid5(parentCanonicalId + "#" + arrayPath + "[" + elementKeyValue + "]")` — no
  `linkExternalId` DB call.
- **Diff**: the engine extracts the stored array from the parent's existing
  `shadow_state` row and compares the element at the matching key in memory.
- **Fan-out**: unchanged. Each element is diffed and dispatched to target connectors
  individually. On the **target side**, `identity_map` rows are still created for flat
  target connectors (e.g. `warehouse.line_items`) so their local record IDs link to
  the derived canonical UUID.

### 5. Element identity and parent association

The parent-child relationship is encoded in the derived child external ID
(`<parent_id>#<arrayPath>[<key_or_index>]`). This makes every child record
unambiguously traceable to its parent without any extra fields.

`parent_fields` is purely a field-scoping mechanism following OSI-mapping's
`ParentFieldRef` syntax. Keys are the local aliases used as `source:` values in the
child's `fields` list; values are the parent field names (or `{ path, field }` for
deep ancestors). Aliasing is how collision with a same-named element field is avoided.
`parent_fields` has no identity or association semantics beyond field scoping.

For the MVP, `references` FK translation is not required for array expansion to work —
the raw parent ID value passes through and is stored in `shadow_state` as-is.

### 6. Reverse pass (deferred)

The reverse pass — collecting child entities and re-assembling them into a `lines`
array column for write-back to the source connector — is **not implemented in this
plan**. It is the dominant open question for the overall bidirectional nested-array
use-case and requires the `written_state` table (specs/field-mapping.md §7.1) for
element tombstoning.

Consequence: source connectors that store lines as embedded arrays can be **read from**
bidirectionally (lines are individually diffed and synced to flat targets), but
**writing back** an assembled array to that same connector is deferred. The connector
can pre-flatten lines in its own write path in the interim.

---

## Implementation steps

### Step 1 — Spec updates (specs first)

1. Update `specs/field-mapping.md §3.2`: replace the "requires design work" status line
   with "designed" and augment with the identity formula and `element_key` semantics
   documented in §3.3 of this plan above.
2. Update `specs/field-mapping.md §3.3` and `§3.4`: status → "planned follow-on,
   depends on §3.2 implementation".
3. Update `specs/config.md` (field mappings section): add `parent`, `array_path`,
   `parent_fields`, `element_key` to the documented mapping keys with the example
   from §2 above.
4. Update `specs/sync-engine.md` (Ingest Loop): insert the array-expansion note at
   step 4a.

### Step 2 — Config schema + loader

- Extend `packages/engine/src/config/schema.ts`: add optional `name` and the four
  array-expansion optional fields to `MappingEntrySchema` (Zod).
- Extend `packages/engine/src/config/loader.ts`: populate the new fields on
  `ChannelMember`; enforce `name` required; add the two validation rules from §2.

### Step 3 — `array-expander.ts`

- Create `packages/engine/src/core/array-expander.ts` with `expandArrayRecord`.
- Write unit tests in `packages/engine/src/core/array-expander.test.ts` covering:
  - No `arrayPath` → passthrough.
  - Simple top-level array → N child records with index-based IDs.
  - `element_key` present → stable ID from key value.
  - `parent_fields` object form `{ alias: source_field }` → parent values available under alias in child scope.
  - Dotted `array_path` (e.g. `order.lines`) → nested array resolved.
  - Non-array value at path → warning, passthrough.
  - JSON-string array (stored as a string in source) → parsed.
  - Empty array → returns `[]`.

### Step 4 — Ingest loop

- Modify `packages/engine/src/engine.ts`: import `expandArrayRecord`, call it after
  `stripMetaFields` and before the identity/diff steps.
- Wrap the existing per-record processing block in a small inner loop over the
  expanded child records.

### Step 5 — Integration test

Add an integration test in `packages/engine/src/engine.test.ts` (or a new
`nested-array.test.ts`):

- Set up two connectors: one ERP-like source whose `orders` entity returns records
  with a `lines` array, one flat CRM-like target whose `order_lines` entity has
  individual records.
- Configure the mapping with `name: erp_orders` on the parent, `array_path: lines`, `parent: erp_orders`, `element_key: sku`.
- Run `engine.ingest(…)` on the source.
- Assert that:
  - The parent `orders` shadow row contains the full record including the `lines` array.
  - No per-element source-side shadow rows are written.
  - Each child line is dispatched to the flat target as a separate `InsertRecord` with a derived canonical UUID.
  - Re-ingesting the same source with one changed line only dispatches the changed
    element, not all.
  - Re-ingesting with identical data dispatches nothing (echo prevention).

### Step 6 — CHANGELOG

Add entry under `## [Unreleased] ### Added`:

```
### Added
- Nested array expansion in the engine forward pass: mapping entries with `array_path`
  expand embedded JSON arrays into individual child entity records, enabling per-element
  diffing, conflict resolution, and fan-out (`specs/field-mapping.md §3.2`).
```

---

## Out of scope (follow-on work)

All of the items below are planned. The two rows marked "prerequisite plan" have
dedicated implementation plans that must land first.

| Feature | Prerequisite | Plan |
|---------|-------------|------|
| Reverse-pass array reassembly | `written_state` table | [PLAN_WRITTEN_STATE.md](PLAN_WRITTEN_STATE.md) |
| Element tombstoning (detect removed elements) | `written_state` table | [PLAN_WRITTEN_STATE.md](PLAN_WRITTEN_STATE.md) |
| Ordering primitives (`order_by`, CRDT ordinal, linked-list) | reverse-pass reassembly | depends on written_state |
| Scalar arrays (`scalar: true`) | §3.2 forward pass (this plan) | straightforward extension |
| Deep nesting (multi-level `parent`) | §3.2 forward pass (this plan) | recursive application |
| Cross-channel `parent` (parent entity in a different channel) | cross-channel expansion design | [PLAN_CROSS_CHANNEL_EXPANSION.md](PLAN_CROSS_CHANNEL_EXPANSION.md) |

---

## Open questions

1. **Race between parent and child ingests**: if the parent record (order) and the
   child mapping (order_lines) are members of different channels, they will be ingested
   in separate calls. Is it permissible to expand arrays from one channel during an
   ingest call for a different channel? — Current answer: `array_path` applies within
   a single ingest call on the member that declares it; no cross-channel expansion.
   See [PLAN_CROSS_CHANNEL_EXPANSION.md](PLAN_CROSS_CHANNEL_EXPANSION.md).
