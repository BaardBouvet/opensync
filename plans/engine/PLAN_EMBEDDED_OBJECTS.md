# PLAN: Embedded Objects (Flat Parent Mapping)

**Status:** backlog  
**Date:** 2026-04-10  
**Effort:** M  
**Domain:** Engine — structural transforms, config, identity  
**Scope:** `specs/field-mapping.md`, `specs/config.md`, `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/engine.ts`  
**Depends on:** none  

---

## § 1 Problem

The current engine handles two structural relationships:

| Pattern | Config | Description |
|---------|--------|-------------|
| **Per-item array expansion** | `array_path` | Each element of an array column becomes its own child entity row |
| **Embedded object (flat parent)** | (not implemented) | Fields from a single source row produce both a parent entity and a child entity. No array — the child is a 1:1 sub-entity whose data lives in columns alongside the parent. |

The embedded-object pattern is common in real integrations:

- A CRM `contacts` table carries `ship_street`, `ship_city`, `ship_zip` columns. The canonical
  model has a separate `addresses` entity. The child entity's fields come from the same row — not
  from an array column.
- An ERP `invoices` table carries `billing_name`, `billing_street` columns. Canonical model splits
  these into a `billing_address` child entity.

Today the operator's only workarounds are:
1. Map shipping-address fields onto the canonical `contacts` entity directly (polluting the schema).
2. Write a connector adapter that pre-splits the record into two separate read operations — which
   pushes transformation logic into the connector (violating the "connectors are dumb pipes"
   principle).

The spec already documents this pattern (§3.1) with the `parent:` config syntax but marks it
"designed, not yet implemented." This plan implements it.

---

## § 2 Proposed Design

### § 2.1 Config syntax

A mapping entry with `parent: <name>` (no `array_path`) declares an embedded-object child.
`parent:` references the `name:` of another mapping entry — the same convention used by array
expansion. The child **inherits** the source connector and source entity from that named entry;
they are not repeated.

```yaml
- name: erp_contacts          # name: required so child can reference it
  connector: erp
  channel: contacts
  entity: contacts
  fields:
    - source: email
      target: email
    - source: name
      target: name

- connector: erp              # inherited from erp_contacts — could be omitted once §2.8 is decided
  channel: contacts
  entity: addresses           # child entity in the same channel
  parent: erp_contacts        # references name: above — no array_path → embedded, not array expansion
  fields:
    - source: ship_street
      target: street
    - source: ship_city
      target: city
    - source: ship_zip
      target: zip
```

The child entry inherits the source connector and source entity from the named parent. The connector
and entity on the child (if present) must match the inherited values — a mismatch is a config
validation error. For clarity the child may omit `connector:` entirely; the engine fills it from
the parent.

**Distinction from `array_path`:** `parent: <name>` alone (no `array_path`) means flat/embedded;
`parent: <name>` + `array_path` means array expansion. A config validation error is raised if
`parent` is set without `array_path` on an entry that also declares `element_key` or `scalar`.

**Chaining:** because `parent:` is a name reference, a child can itself be named and referenced
as the parent of a further embedded child:

```yaml
- name: erp_contacts
  connector: erp
  channel: contacts
  entity: contacts
  fields: [...]

- name: erp_contact_address   # this child is also named, enabling further chaining
  connector: erp
  channel: contacts
  entity: addresses
  parent: erp_contacts        # inherited source: erp/contacts
  fields:
    - source: ship_street
      target: street

- connector: erp
  channel: contacts
  entity: address_geo
  parent: erp_contact_address  # child of the child — same source row, same connector
  fields:
    - source: ship_lat
      target: lat
    - source: ship_lng
      target: lng
```

All levels read from the same source row (the root ancestor's connector + entity); the chain
simply declares progressively narrower field projections mapped to different canonical entities.

### § 2.2 Identity

The child entity's external ID is derived deterministically from the parent record's external ID
plus the child mapping entry's `entity` value:

```
child_external_id = "<parent_external_id>#<child_entity_name>"
```

Example: parent record `id = "C-001"`, child `entity: addresses` →
`external_id = "C-001#addresses"`.

Because the parent is identified by its `name:`, the engine looks up the parent mapping entry by
name to find the source entity and connector — not by scanning connector+entity pairs.

This determinism means:
- The same parent record always produces the same child ID across cycles — no phantom duplicates.
- The child's canonical UUID is looked up or allocated via the normal `identity_map` path, the
  same as any other entity.
- If the parent is deleted, the child should also be cleaned up (see §2.5).

### § 2.3 Forward pass

When `_processRecords` encounters an embedded-object member (member with `parent:` set and no
`array_path`), it defers processing that member until after the named parent mapping entry's
records have been processed in the same cycle. The deferred processing:

1. Resolves the parent mapping entry by `name:` to find the source connector + entity.
2. Uses the parent's raw `record.data` as the data source (same row).
3. Derives `child_external_id` as `<parentRecord.id>#<childMember.entity>`.
4. Calls `applyMapping(record.data, childMember.inbound, "inbound")` to produce the child's
   canonical fields — only the `fields` entries on the child member are applied.
5. Follows the normal identity-resolution and shadow-diff pipeline for the child entity.

The child's `record.updatedAt` and `record.fieldTimestamps` are inherited from the parent record
(same row — same timestamp).

For chained embedded objects (child of child), each level derives its external ID from the
**immediate** parent's external ID, and all levels read from the **root** ancestor's raw
`record.data`.

### § 2.4 Reverse pass

When the engine needs to write a change to the child entity back to the source connector, it must
merge the child's outbound-mapped fields into the same `UpdateRecord` as the parent entity:

1. The collapse target for the child is the same source connector + source entity as the parent.
2. The outbound mapping produces a partial record containing only the child's field entries
   (e.g. `{ ship_street: "…", ship_city: "…", ship_zip: "…" }`).
3. This partial record is **merged** into the parent's `UpdateRecord.data` before the
   `connector.update()` call — shallow-merge at the field level, child fields overwrite only
   their own keys.
4. If the parent record also has pending changes in the same cycle, parent and child changes are
   combined into one `update()` call to avoid two writes to the same row.

### § 2.5 Parent deletion cascades to child

When the parent entity's record is deleted (hard or soft), the child entity's shadow row is also
tombstoned. The canonical child entity falls back to other contributing sources, or becomes
deleted if no other source contributes it. This mirrors the element-absence cascade already
implemented for array children.

### § 2.6 Multiple children from the same parent row

A named parent entry can have more than one embedded-object child, each with a different `entity`
value and each referencing the same `name:`:

```yaml
- name: erp_contacts
  connector: erp
  channel: contacts
  entity: contacts
  fields: [...]

- channel: contacts
  entity: billing_addresses
  parent: erp_contacts       # inherits connector=erp, source entity=contacts
  fields:
    - source: bill_street
      target: street

- channel: contacts
  entity: shipping_addresses
  parent: erp_contacts       # same parent, different child entity
  fields:
    - source: ship_street
      target: street
```

Each produces an independent child canonical entity with its own UUID and shadow row. Child
`entity` values must be unique within the channel.

### § 2.7 Cross-channel embedded objects

`parent:` for embedded objects uses the same name-reference lookup as array expansion: the named
parent entry may be declared in a different channel. The child still reads from the same source
connector + entity inherited from the named parent — the channel boundary only determines which
fan-out targets receive the child canonical entity.

---

## § 3 What Is Not Changing

- **Array expansion** (`parent` + `array_path`) is not affected. The distinction is purely
  whether `array_path` is present.
- **Per-array-element vs flat** — a child member with `parent` but no `array_path` is always
  processed as an embedded object. There is no fallback to array-expansion behaviour.

---

## § 4 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §3.1 Embedded objects | Update status, add identity derivation formula, reverse-pass merge semantics, parent-deletion cascade, and multi-child example |
| `specs/config.md` | `MappingEntry` key reference table | Clarify that `parent` without `array_path` = embedded object; distinguish from array-expansion case |

---

## § 5 Implementation Checklist

- [ ] Config validation: detect `parent` + no `array_path` → mark `channelMember.embeddedChild = true`; validate `parent` references a known `name:` entry; raise error if `element_key` or `scalar` also set; raise error if `connector:` is present on child but differs from the parent's inherited connector
- [ ] `_processRecords`: after processing parent entity records, iterate embedded-child members and process them using the same raw records; derive child external IDs as `<parentId>#<childEntity>`; run normal identity + shadow-diff pipeline
- [ ] Reverse pass: when a child entity delta must be written, merge child outbound fields into the parent connector's `UpdateRecord.data`; combine with any pending parent changes in the same cycle
- [ ] Parent-deletion cascade: tombstone all embedded-child shadow rows when parent is deleted or soft-deleted
- [ ] Add tests: single embedded child — child fields land in separate entity; multi-child — two child entities from same row; reverse merge — child change merged into parent `UpdateRecord`; parent delete cascades child tombstone; different source field sets — child only maps its own fields from the row; unchanged child row → noop
- [ ] Update `specs/field-mapping.md §3.1` status
- [ ] Update `specs/config.md` MappingEntry key table
- [ ] Update `plans/engine/GAP_OSI_PRIMITIVES.md` — embedded objects entry from 🔶 to ✅
- [ ] Update `specs/field-mapping.md` coverage table — embedded objects row from 🔶 to ✅
- [ ] Run `bun run tsc --noEmit`
- [ ] Run `bun test`
- [ ] Update `CHANGELOG.md` under `[Unreleased]`
