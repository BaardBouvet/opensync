# PLAN: Entity Array Assembly (`assemble_into`)

**Status:** proposed  
**Date:** 2026-04-11  
**Effort:** L  
**Domain:** packages/engine, packages/sdk  
**Scope:** New `assemble_into` / `parent_key` / `target_field` mapping keys; engine forward-pass assembly; reverse-pass split  
**Spec:** specs/field-mapping.md, specs/config.md  
**Depends on:** PLAN_NESTED_ARRAY_PIPELINE.md (complete), PLAN_ARRAY_COLLAPSE.md (complete), PLAN_ATOMIC_ARRAY.md (complete)  

---

## 1. Problem

OpenSync already handles two directions of the array/entity duality:

| Source shape | Engine action | Target shape |
|---|---|---|
| Embedded array (`array_path`) | Expansion — one element per child record | Flat child entities |
| Flat child entities | Reverse collapse | Embedded array (write-back to array source) |
| Embedded array (atomic) | Pass-through as opaque blob | Embedded array |

**The missing case:**

| Source shape | Engine action | Target shape |
|---|---|---|
| **Two flat entities (FK-linked)** | **Assembly** ← not supported | **Single entity with embedded array** |

Concretely: the ERP exposes `orders` and `order_lines` as two independent entity streams,
connected by a FK (`order_lines.order_id → orders.id`). The CRM expects a single `orders`
entity whose data contains a `lines` array field (`orders.data.lines = [{...}, ...]`).

With the current config there is no way to express this. The closest workaround — mapping
each entity to a separate channel — produces two channels where only one is expected, and
fails entirely if the CRM has no flat `order_lines` entity at all.

### 1.1 Why this is distinct from all existing patterns

- **Not array expansion**: expansion requires the SOURCE to carry the embedded array. Here
  the source is flat.
- **Not atomic array**: atomic array (§3.5) maps a single array-valued field through as an
  opaque blob. Here the array is built from multiple separate entity reads.
- **Not `collect` resolution**: `collect` aggregates values from multiple connectors for the
  same canonical field. Here we aggregate records from multiple entity reads within a single
  connector.
- **Not embedded-objects (`parent:` without `array_path`)**: embedded objects split one
  source row into parent + child entities. Here we do the opposite: multiple child rows merge
  into a single parent record.

---

## 2. Proposed Design

### 2.1 Config syntax

Two entries work together. The **parent** entry is a normal mapping entry with a `name:`. The
**assembly child** entry references it via a new `assemble_into` key.

```yaml
# Parent — reads the primary entity; becomes a normal channel member
- name: erp_orders
  connector: erp
  channel: orders
  entity: orders
  fields:
    - source: order_date
      target: orderDate
    - source: status
      target: status

# Assembly child — reads a secondary FK-linked entity and folds into parent as an array field
- connector: erp
  channel: orders
  entity: order_lines
  assemble_into: erp_orders   # name: of the parent mapping entry
  parent_key: order_id        # FK field on the child entity that holds the parent's source ID
  target_field: lines         # canonical field on the parent record to embed the array into
  element_key: line_no        # stable identity key within each element
  fields:
    - source: line_no
      target: lineNumber
    - source: product_id
      target: productId
    - source: qty
      target: qty
    - source: unit_price
      target: unitPrice

# Target connector — receives the assembled record as if it had always had the embedded array
- connector: crm
  channel: orders
  entity: orders
  fields:
    - source: orderDate
      target: order_date
    - source: status
      target: status
    - source: lines
      target: lines
      sort_elements: true
      element_fields:
        - source: lineNumber
          target: line_no
        - source: productId
          target: item_id
        - source: qty
          target: quantity
        - source: unitPrice
          target: price
```

### 2.2 New mapping-entry keys

| Key | Type | Meaning |
|-----|------|---------|
| `assemble_into` | `string` | Name of the parent mapping entry whose canonical record will carry the assembled array. The current entry must share the same `connector` as the named parent entry. |
| `parent_key` | `string` | Field name on this entry's source entity whose value is the parent record's source ID (i.e. the FK). |
| `target_field` | `string` | Canonical field name on the parent entity into which the assembled array will be placed. Must not clash with a field already declared in the parent mapping entry's `fields`. |
| `element_key` | `string` | Field within each source record providing a stable element identity within the assembled array. Falls back to arrival-order index when absent. |

`assemble_into` is mutually exclusive with `parent` (array expansion) and `array_path`. A
config validation error is raised if more than one of these is present on the same entry.

The entry otherwise accepts the same `fields`, `filter`, `reverse_filter`, `element_fields`,
and `sort_elements` keys as any other flat mapping entry.

### 2.3 Forward-pass mechanics

When the engine ingests from an assembly child member:

1. Read source records for `entity` (e.g. `order_lines`) via `connector.read(entity, watermark)`.
2. For each incoming `order_line` record `r`:
   a. Apply `filter` (if declared) — skip records that do not match.
   b. Resolve `parentSourceId = r.data[parent_key]`.
   c. Look up the **parent canonical ID** via `identity_map` for
      `(connector, parentEntry.entity, parentSourceId)`. If not found, defer (see §2.6).
   d. Apply the child mapping's `fields` to produce canonical element fields
      `elementData`.
   e. Persist `elementData` in a new `assembly_element` table:
      `(parent_canon_id, target_field, element_key_value, element_data)`.
      This is an upsert; any prior value for the same `(parent_canon_id, target_field,
      element_key_value)` is replaced.
   f. Mark the parent canonical record as dirty for this cycle (in-memory set).
3. After all incoming records are processed, for each dirty parent canonical ID:
   a. Assemble a full array by loading all rows from `assembly_element` for
      `(parent_canon_id, target_field)`, ordered by `element_key_value` (or by insertion
      order when `element_key` is absent).
   b. Apply `sort_elements` / `order_by` if declared.
   c. Produce a synthetic inbound record for the parent's channel entry:
      `{ id: parentSourceId, data: { [target_field]: assembledArray } }`.
   d. Feed that synthetic record into the existing resolution pipeline under the parent
      connector and channel. The `target_field` value participates in conflict resolution
      and noop suppression exactly as any atomic array field from the parent entry would.
4. Advance the watermark for `(connector, entity)` (the child entity, not the parent).

**Shadow state:** the `assembly_element` rows are the engine's record of what has been
assembled. They survive between cycles. Deletions (§2.7) remove rows.

### 2.4 Parent ordering dependency

The assembly child's parent lookup (§2.3 step 2c) requires that the parent record has a
canonical ID. The engine must read and ingest the parent entity (`orders`) before it processes
the assembly child (`order_lines`) in the same cycle. This is expressed implicitly through
the existing channel member ordering rules (parent entries come before assembly children in
the config, analogous to how `name:`-referenced `parent:` entries must be declared before
their array expansion children).

At config load time, the engine validates that within a channel the `name:`-referenced parent
entry appears before any `assemble_into` children in the resolved member list. The error:

```
Config error: assemble_into "erp_orders" must appear before its assembly child in channel "orders"
```

When the parent canonical ID is not yet available (new parent that wasn't ingested in this
cycle), the engine defers the element via the deferred-associations mechanism (§2.6).

### 2.5 Assembled array on the canonical record

The assembled array is stored in the canonical shadow state on the **parent** entity's shadow
row, under the key `target_field`. Conflict resolution treats it as a single atomic value
(identical to an atomic array from §3.5). Multiple connectors could in theory each assemble
their own `target_field` value and the normal coalesce / LWW / field-master strategies apply.

**The assembled array is NOT per-element tracked for conflict resolution purposes.** If
two connectors both assemble into the same `target_field`, the entire array from the winning
source is used. Per-element resolution across assembly sources is not supported in this plan —
use the existing element-set resolution (§5.5) with `array_path` members if fine-grained
element-level conflict resolution is needed.

### 2.6 Deferred assembly elements

When `parent_canon_id` is not found (e.g. a child arrives in a cycle before its parent):
- Store the child element in the `assembly_element` table with a `pending` flag.
- On each subsequent cycle when the parent entity ingests, re-attempt pending lookups.
- This mirrors the deferred-associations mechanism.

### 2.7 Deletion handling

When an `order_line` record is deleted (via `record.deleted = true` or hard-delete
mark-and-sweep):
- Remove the corresponding row from `assembly_element`.
- Mark the parent canonical record dirty.
- Reassemble the array (now without the deleted element) and propagate the updated version
  of the parent's `target_field` to all target connectors.

### 2.8 Reverse-pass split (`assemble_into` reverse)

When a target connector (e.g. the CRM) writes back an `orders` record that contains a
modified `lines` array:

1. The engine receives the canonical delta; `target_field` (`lines`) contains an updated array.
2. For each element in the updated array, the engine identifies the corresponding source
   record in the assembly child's source entity by matching `element_key_value` against the
   stored `(parent_canon_id, target_field, element_key_value)` rows.
3. Apply the reverse field mapping (child entry's `fields` reverse direction).
4. Issue an `update` call on the assembly child's source entity for each changed element.
5. For elements present in the updated array but absent from `assembly_element`: issue an
   `insert` call (new child records).
6. For elements absent from the updated array but present in `assembly_element`: issue a
   delete signal (set `record.deleted = true` or the configured soft-delete field).
7. Apply `reverse_filter` per element: skip elements for which the expression returns falsy.

This is the reverse-direction analogue of the current array expansion reverse-collapse
(§3.4 in the spec). The terminology: "assembly reverse split".

**Important:** the reverse split writes to the **child** source entity (`order_lines`), NOT
to the parent entity. The parent (`orders`) reverse pass is handled separately by the
parent mapping entry's own reverse logic.

---

## 3. `assembly_element` Table

New SQLite table to store per-element state:

```sql
CREATE TABLE IF NOT EXISTS assembly_element (
  parent_canon_id  TEXT NOT NULL,
  target_field     TEXT NOT NULL,
  element_key      TEXT NOT NULL,   -- element_key_value; "" when element_key absent (uses index)
  connector_id     TEXT NOT NULL,   -- which connector built this element
  element_data     TEXT NOT NULL,   -- JSON object of canonical element fields
  pending          INTEGER NOT NULL DEFAULT 0,  -- 1 = parent not yet resolved
  PRIMARY KEY (parent_canon_id, target_field, element_key, connector_id)
);
```

The `pending` column mirrors the `deferred_associations` pattern. A background sweep on each
cycle processes pending rows the same way deferred associations are retried.

---

## 4. Validation Rules (Config Load Time)

- `assemble_into` must name a mapping entry that has a matching `name:` field — error if not found.
- The `assemble_into` child must share the same `connector` as the named parent entry.
- `parent_key` is required when `assemble_into` is set.
- `target_field` is required when `assemble_into` is set.
- `target_field` must not collide with any `target:` field name in the parent entry's `fields`.
- `assemble_into` is mutually exclusive with `parent` (array expansion) and `array_path`.
- Within a channel, the referenced parent entry must be ordered before all assembly children
  that reference it.
- Cross-connector `assemble_into` references are rejected (same `connector` required).

---

## 5. Symmetry with Existing Array Patterns

The new feature is the fourth quadrant of a 2×2 matrix:

|  | Source: **embedded** array | Source: **flat** entities |
|--|--|--|
| **Target: flat** | `array_path` expansion (§3.2) | _N/A_ (flat → flat, standard field mapping) |
| **Target: embedded** | Atomic array (§3.5) / reverse collapse | **`assemble_into` (this plan)** |

The config keys are designed to mirror the existing `parent:` / `array_path:` pattern:

| Array expansion child | Assembly child |
|---|---|
| `parent: erp_orders` | `assemble_into: erp_orders` |
| `array_path: lines` | `target_field: lines` |
| `element_key: line_no` | `element_key: line_no` |
| Reads parent entity, expands elements outward | Reads child entity, folds elements inward |

---

## 6. What Does Not Change

- `connector.read()` contract — connectors return flat records as always; no connector change.
- Array expansion (`array_path` / `parent`) path — unchanged.
- Atomic array handling (§3.5, `element_fields`, `sort_elements`) — unchanged; `target_field`
  produces an atomic-style value that enters this path on the target connector.
- Conflict resolution, noop suppression, echo prevention — unchanged; the assembled array is
  treated as a plain field value by all downstream resolution code.
- Associations on child record fields — `entity` / FK annotations in `fields` of the assembly
  child entry still work; association extraction runs at the element level as usual.

---

## 7. Open Questions (to resolve during implementation)

### 7.1 Multi-element ordering

When `element_key` is absent, element index (0, 1, 2, …) is used as the key and also sets
insertion order. Is this sufficient, or should the assembly child also support `order_by`,
`order: true`, and `order_linked_list: true`? Likely yes — these are the same ordering
strategies as array collapse (§6). Include in this plan's scope.

### 7.2 Multiple assembly children into the same parent

Can two different assembly child entries in the same channel both write into the same parent
`target_field`? This would require merging the elements — effectively element-set resolution.
This plan defers that case and raises a config validation error if two assembly children
declare the same `(assemble_into, target_field)` pair within one channel. Element-set
resolution across assembly children can be a follow-on plan.

### 7.3 Deep assembly

Can an assembly child itself be a parent for another assembly child (assembling a three-level
tree)? Deferred. A validation error is raised if an assembly child entry is also referenced
as `assemble_into` by another entry. Deep assembly can be a follow-on plan.

### 7.4 Cross-channel assembly

Can `assemble_into` reference a parent mapping entry in a different channel (analogous to
cross-channel expansion, PLAN_CROSS_CHANNEL_EXPANSION.md)? Deferred. In-scope here: same
channel only.

---

## 8. Spec Changes Planned

| Spec file | Section | Change |
|---|---|---|
| `specs/field-mapping.md` | New §3.6 "Entity array assembly (`assemble_into`)" | Full forward-pass and reverse-split spec; symmetry table; config keys |
| `specs/config.md` | Array expansion keys table | Add `assemble_into`, `parent_key`, `target_field` rows |
| `specs/config.md` | Same-channel example | Add a worked example for entity array assembly |
| `specs/database.md` | Tables section | Add `assembly_element` table definition |

---

## 9. Test Plan

| ID | Scenario |
|----|----------|
| EA1 | Single parent, single child: two ERP entities (`orders`, `order_lines`) assembled into CRM `orders.lines`; verify dispatched CRM record contains correct array |
| EA2 | Multiple children for same parent: three `order_lines` records → `lines` array of length 3 |
| EA3 | Child arrives before parent (deferred): element enters `pending` state; resolved on next cycle |
| EA4 | Child update: modified `order_line` updates only its slot; array reassembled with new value |
| EA5 | Child deletion: removing `order_line` removes element from assembled array; CRM receives updated shorter array |
| EA6 | Parent deletion: parent deleted → cascade-clears all `assembly_element` rows for that parent; CRM receives empty/deleted record |
| EA7 | Reverse split: CRM updates `orders.lines` array → engine splits into individual `order_lines` update calls on ERP |
| EA8 | Reverse split insert: new element in CRM `orders.lines` → engine calls ERP `insert` for new `order_line` |
| EA9 | Reverse split delete: element removed from CRM `orders.lines` → engine sends delete signal to ERP `order_line` |
| EA10 | `element_key` absent: order-index fallback; ordering is preserved across cycles |
| EA11 | `filter` on assembly child: only matching `order_lines` elements appear in assembled array |
| EA12 | `reverse_filter` on assembly child: filtered elements skipped on reverse split |
| EA13 | Noop suppression: second cycle with no changes → no fan-out to CRM |
| EA14 | Config validation: `target_field` collision with parent `fields` → load-time error |
| EA15 | Config validation: `assemble_into` + `array_path` on same entry → load-time error |
