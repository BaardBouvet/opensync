# Cross-Channel Array Expansion

**Status:** draft  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** engine, field-mapping  
**Scope:** allow a nested array child entity to belong to a different channel than its parent  
**Spec:** specs/field-mapping.md §3.2, specs/sync-engine.md § Ingest Loop  
**Depends on:** PLAN_NESTED_ARRAY_PIPELINE.md (same-channel expansion must be live first)  

---

## Problem

The same-channel array expansion implemented by `PLAN_NESTED_ARRAY_PIPELINE.md` requires
the child entity to belong to the **same channel** as its parent. For example, `order_lines`
must be a member of the same channel as `orders`.

This restriction is frequently too tight. Real-world setups split parent and child into
separate channels for independent fan-out control:

```
channel: orders      — members: erp.orders, crm.sales_orders
channel: order-lines — members: erp.order_lines, warehouse.line_items
```

The ERP returns orders with embedded `lines` arrays. The engine should expand those arrays
into `order_lines` child records that belong to the `order-lines` channel — but today the
ingest call is scoped to one channel, and the same-channel expander only looks for child
mappings within that channel.

---

## Spec changes planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §3.2 | Add `name` key on mapping entries; clarify that `parent` references a mapping name, not an entity name; remove the same-channel restriction; describe cross-channel ingest sub-flow. |
| `specs/config.md` | `mappings/*.yaml` | Document optional `name` key on mapping entries with cross-channel `parent` example. |
| `specs/sync-engine.md` | Ingest Loop | Add: when a member’s parent mapping lives in a different channel, the engine reads records using the parent’s connector entity and drives expansion into the child channel. |

---

## Design

### 1. The core challenge

`engine.ingest(channelId, connectorId)` reads records for the entities that `connectorId`
contributes to `channelId`. The fan-out uses *that channel's* membership list.

A cross-channel child entity lives in a **different** channel — it has a different set of
fan-out targets, different identity configuration, and different field mappings. Expanding
into it during a parent-channel ingest requires driving a sub-ingest scoped to the child
channel but consuming records already in hand (no second HTTP call).
In OSI-mapping this is handled purely by the `parent` key: a child mapping names its
parent mapping; the child *inherits its source* from the parent and never needs to redeclare
it. OpenSync adopts the same mechanic by adding an optional `name` field to mapping entries
so that cross-channel children can reference parents by name.
### 2. Config changes: `name` on mapping entries + cross-channel `parent`

In OSI-mapping every mapping has an optional `name` that children reference via `parent`.
A child with `parent` **must not** declare its own `source`; it inherits the source entity
from the named parent.

OpenSync adopts the same contract with one adaptation: because OpenSync splits a mapping
across `channel` + `entity` + `connectorId` rather than a single `source`, the child
inherits the parent’s `connectorId` and `entity` (the connector read source).

```yaml
# mappings/orders.yaml
mappings:
  - name: erp_orders           # ← named so children can reference it
    connector: erp
    channel: orders
    entity: orders
    fields:
      - source: order_id
        target: orderId
      - source: customer_id
        target: customerId

# mappings/order-lines.yaml
mappings:
  - connector: erp
    channel: order-lines          # ← different channel from the parent
    entity: order_lines           # logical name in this channel
    parent: erp_orders            # ← name of parent mapping (not entity name)
    array: lines                  # OSI-mapping uses `array` (or `array_path` for dotted)
    parent_fields:
      orderId: order_id           # alias: parent_field (OSI-mapping ParentFieldRef syntax)
    element_key: line_no
    fields:
      - source: line_no
        target: lineNumber
      - source: product_id
        target: productId
      - source: quantity
        target: qty
      - source: orderId           # brought in from parent via parent_fields
        target: orderRef
```

#### New key

| Key | Type | Meaning |
|-----|------|---------|
| `name` | `string` | Optional stable identifier for a mapping entry. Required when another mapping will reference this entry as its `parent`. Must be unique across all mapping files in the project. |

No `source_entity` or `parent_channel` keys are introduced. The parent’s channel,
`connectorId`, and source entity are all resolved by following the `parent` name.

### 3. Ingest flow for cross-channel expansion

When `engine.ingest(channelId='order-lines', connectorId='erp')` is called:

1. Resolve channel membership: ERP is a member of `order-lines` with
   `entity=order_lines, parent=erp_orders`.
2. Resolve parent: look up the mapping named `erp_orders` — it has `connector=erp,
   entity=orders`. The child inherits `connectorId=erp` and `sourceEntity=orders`.
3. Fetch records: call `erp.read('orders', watermark)` — the inherited source entity.
4. For each record, run `expandArrayRecord(record, member)` to produce child records
   (same expander as the same-channel case).
5. For each child record, run the standard ingest loop steps:
   - Apply inbound field mapping for the `order-lines` channel.
   - Resolve canonical ID in the `identity_map` under entity type `order_lines`.
   - Diff against `shadow_state`.
   - Fan-out to the other members of the `order-lines` channel
     (`warehouse.line_items`, etc.).
6. Watermark is stored for `(erp, order_lines)` — the child's logical entity name.
   This keeps `orders` and `order_lines` watermarks independent.

### 4. Watermark independence

Two ingest calls may now both call `erp.read('orders', since)`:

- `ingest('orders', 'erp')` — reads orders for the orders channel.
- `ingest('order-lines', 'erp')` — inherits parent `erp_orders`, reads orders to expand lines
  for the order-lines channel.

Each call stores a watermark under its own logical `(connectorId, entityName)` key:
- `(erp, orders)` for the orders channel.
- `(erp, order_lines)` for the order-lines channel.

They advance independently. This means the ERP is called twice per cycle when both
channels are active. This is acceptable for the MVP; a shared-watermark optimisation
(read orders once, feed both channels) is a follow-on.

### 5. Validation rules (config load time)

- If `parent` names a mapping not in the same channel:
  - The named parent mapping must exist in some channel — reject otherwise.
  - The parent mapping must belong to the same connector instance — reject otherwise
    (the child inherits the connector; cross-connector inheritance is not supported).
  - `array` or `array_path` must be set — reject a cross-channel parent without
    array expansion (no use-case for flat embedded objects across channels).
  - The inherited source entity must be declared in the connector’s `getEntities()` —
    reject otherwise.
- If `parent` names a mapping in the *same* channel: existing same-channel rules apply
  unchanged (no name required, entity name may be used directly).

### 6. Connector contract — no change

Connectors are unaffected. The engine calls `read('orders', ...)` whether the caller
is the `orders` channel or the `order-lines` channel; the connector never knows the
difference. No new connector API surface is required.

---

## Implementation steps

### Step 1 — Spec updates

1. `specs/field-mapping.md §3.2`: add optional `name` key on mapping entries; describe
   cross-channel `parent` resolution (child inherits connector + source entity); remove
   the same-channel restriction.
2. `specs/config.md` (field mappings section): add `name` key documentation with the
   cross-channel `parent` example from §2 above.
3. `specs/sync-engine.md` ingest loop §4: add cross-channel parent resolution note.

### Step 2 — Config schema and loader

- Add optional `name?: string` to `MappingEntrySchema` in
  `packages/engine/src/config/schema.ts`. No rename of existing fields.
- In `packages/engine/src/config/loader.ts`:
  - Build a `mappingsByName: Map<string, ResolvedMappingEntry>` index after parsing.
  - When resolving a `ChannelMember` that has `parent` set to a name not in the same
    channel, look up the parent in `mappingsByName` and inherit its `connectorId` and
    `entity` (as the read source).
  - Store the inherited source entity on `ChannelMember` as `sourceEntity` (internal
    resolved field, not a user-facing config key).
  - Add the validation rules from §5.

### Step 3 — Ingest loop

- Modify `packages/engine/src/engine.ts`:
  - When resolving which connector entity to read from, use `member.sourceEntity`
    (the inherited source, resolved by the loader) if set; otherwise fall back to
    `member.entity` (existing behaviour unchanged for same-channel and no-parent cases).
  - The watermark key continues to use `member.entity` regardless.

### Step 4 — Tests

Integration test:

- Two channels: `orders` (erp.orders, crm.sales_orders), `order-lines`
  (erp.order_lines via cross-channel parent `erp_orders`, warehouse.line_items).
- ERP returns orders with embedded `lines` arrays.
- `ingest('orders', 'erp')` syncs order-level fields to `crm.sales_orders`.
- `ingest('order-lines', 'erp')` resolves the `erp_orders` parent, calls
  `erp.read('orders', ...)`, expands lines, syncs each to `warehouse.line_items`.
- Assert canonical IDs for lines are scoped to `order_lines` entity type.
- Assert watermarks for `(erp, orders)` and `(erp, order_lines)` advance independently.
- Assert config validation rejects a cross-channel `parent` referencing a mapping
  that belongs to a different connector.
- Assert config validation rejects a cross-channel `parent` without `array`/`array_path`.

### Step 5 — CHANGELOG

```
### Added
- Cross-channel array expansion: a nested array child mapping may now reference a
  parent mapping in a different channel via `parent: <mapping_name>`. The child
  inherits the parent’s connector and source entity; no `source_entity` or
  `parent_channel` keys are needed. The connector is unaffected
  (specs/field-mapping.md §3.2).
```

---

## Open questions

1. **Double-read optimisation**: when `ingest('orders', 'erp')` and
   `ingest('order-lines', 'erp')` are called in the same cycle, the ERP `orders`
   entity is read twice. A shared-read cache keyed on `(connectorId, sourceEntity,
   watermark)` within a single cycle would halve the HTTP calls. Deferred to a
   performance plan.

2. **Reverse-pass cross-channel reassembly**: writing the reassembled `lines` array
   back to ERP requires knowing which `order_lines` entities belong to which `orders`
   canonical record. The child records carry the parent canonical ID implicitly via
   their external ID prefix (`<parent_id>#lines[…]`). The reverse-pass reassembly
   logic (see PLAN_NESTED_ARRAY_PIPELINE.md) would need to resolve the parent
   canonical ID from the external ID prefix and route writes to the parent’s channel
   member. No new identity infrastructure needed, but the reverse-pass code must be
   aware of the cross-channel entity type distinction.

3. **Deletes from cross-channel parent**: if an `orders` record is deleted, the engine
   should cascade-delete the corresponding `order_lines` child records from
   `identity_map`, `shadow_state`, and the target connectors. Separate concern
   addressed by [PLAN_DELETE_PROPAGATION.md](PLAN_DELETE_PROPAGATION.md).
