# PLAN: Passthrough Columns

**Status:** backlog  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** Engine — field mapping, shadow state, config  
**Scope:** `specs/field-mapping.md`, `specs/config.md`, `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/core/mapping.ts`, `packages/engine/src/engine.ts`  
**Depends on:** none  

---

## § 1 Problem

The field mapping is a strict whitelist: only fields declared in `fields` entries flow through
the pipeline. Any source column not listed is silently dropped.

This is correct for the canonical schema — it prevents accidental data leakage and keeps the
canonical entity clean. But it creates a problem for connectors that use a **full-replace (PUT)
write API**: when the engine writes back to the connector, it only includes mapped fields.
Unmapped fields that the connector stored on the original record are silently zeroed or dropped.

Example: an ERP's `contacts` record carries `raw_segment_code` and `internal_account_ref` that
are not part of the canonical `contacts` schema (they are ERP-internal metadata with no
equivalent in any other connected system). The operator does not want to model them canonically.
But when the engine calls `erp.update()` to write a changed `name` back, those fields must be
present in the payload or the ERP will overwrite them with nulls.

The `passthrough` config key solves this by preserving named source fields in shadow state and
re-injecting them into the outbound payload **only when writing back to the same connector that
provided them**. They never enter the canonical schema, never affect resolution, and are never
dispatched to any other connector.

If you want a field to reach a _different_ connector, declare it in the channel mapping
(`fields` with appropriate `direction`). Passthrough is strictly a same-source preservation
mechanism.

---

## § 2 Proposed Design

### § 2.1 Config syntax

A `passthrough` key on a **mapping entry** lists source field names to preserve:

```yaml
- connector: erp
  channel: contacts
  entity: customers
  passthrough: [raw_segment_code, internal_account_ref]
  fields:
    - source: name
      target: customerName
```

`passthrough` is a YAML sequence of source field names. The names come from `record.data`; a
field absent from the record is silently skipped.

Passthrough fields are **mutually exclusive with `fields` entries** for the same field name —
a config validation error is raised at load time if the same name appears in both.

### § 2.2 Forward pass — shadow storage only

On ingest, passthrough fields are read from `record.data` and stored directly in the source
connector's `shadow_state` row under a reserved prefix:

```
_pt.<fieldName>
```

They are **not** added to the canonical record and do not enter resolution. The canonical entity
remains clean. The `_pt.*` prefix is reserved and cannot appear in `fields` target names.

The shadow diff still applies: if `_pt.raw_segment_code` is unchanged from last cycle, no delta
is generated for it — the passthrough field contributes to noop detection the same as any mapped field.

### § 2.3 Reverse pass — re-injection to originating connector only

When the engine dispatches an update to the source connector (the same connector whose mapping
entry declared `passthrough`), the passthrough fields are re-read from that connector's shadow
row and merged into the outbound `UpdateRecord.data` **after** `applyReverseMapping`:

```
outbound.data = { ...reverseMapppedFields, _pt fields stripped to plain names }
```

The `_pt.` prefix is stripped before injection; the connector receives the field under its
original name. Passthrough fields are injected at the end — if a mapped field happens to share
the same name (should not happen — validated at load time), the mapped field wins.

Passthrough fields are **only injected for the originating connector**. When dispatching to any
other connector, they are invisible.

### § 2.4 No canonical exposure

Passthrough fields never appear in:
- The canonical record (`resolveConflicts` input/output)
- The `SyncEvent` / `onRecordSynced` payload
- The `written_state` table
- Any other connector's `UpdateRecord.data`

Their only home is the source connector's `shadow_state` row.

---

## § 3 Out of Scope

- **Downstream delta consumers** — if you want unmapped fields visible to downstream consumers
  (webhooks, observability), map them with `direction: forward_only` to a canonical field. That
  is the right primitive for cross-connector or consumer-visible data.
- **Passthrough in `element_fields`** — element-level passthrough is out of scope; the parent
  field's `passthrough` key applies to the array-element object as a whole if needed.
- **Cross-source passthrough roundtrip** — by definition passthrough is one connector's internal
  preservation. Two connectors cannot share a passthrough field.

---

## § 4 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §1.6 Passthrough columns | Rewrite semantics: same-source roundtrip preservation only; remove `_passthrough.*` namespaced canonical key from spec; update status to implemented |
| `specs/config.md` | `MappingEntry` key reference table | Add `passthrough` key row (string array); note same-source constraint |

---

## § 5 Implementation Checklist

- [ ] Add `passthrough?: z.array(z.string())` to `MappingEntrySchema`; validate no overlap with `fields[].source` names at load time; validate that `_pt.*` names are not used as `fields` targets anywhere
- [ ] Add `passthrough?: string[]` to the `ChannelMember` TypeScript type; wire through from parsed config
- [ ] In `_processRecords` (after `applyMapping` / before canonical resolution): for each `sourceMember.passthrough` field, read `record.data[field]`; include as `_pt.<fieldName>` in the shadow write alongside mapped fields (but NOT in the canonical record passed to `resolveConflicts`)
- [ ] In `_dispatchToTarget`: when writing to the **same** connector (`dispatchTarget.connectorId === sourceMember.connectorId`), read the `_pt.*` fields from that connector's shadow row and merge them (prefix-stripped) into the outbound payload after `applyReverseMapping`; skip this step for all other connectors
- [ ] Shadow diff: `_pt.*` shadow entries participate in noop detection — if the passthrough value is unchanged, it does not trigger a new delta
- [ ] Add tests: passthrough field stored in shadow but not in canonical record; on write-back to same connector, field re-injected under original name; on write-back to different connector, passthrough field absent; unchanged passthrough → noop (no spurious dispatch); changed passthrough → dispatch triggered to originating connector; field absent from source record → silently skipped; overlap with `fields[].source` → config load error; `_pt.*` name used as `fields[].target` → config load error
- [ ] Rewrite `specs/field-mapping.md §1.6` to correct semantics
- [ ] Add `passthrough` to `specs/config.md` `MappingEntry` key table
- [ ] Update `plans/engine/GAP_OSI_PRIMITIVES.md` — passthrough entry from 🔶 to ✅
- [ ] Update `specs/field-mapping.md` coverage table — passthrough row from 🔶 to ✅
- [ ] Run `bun run tsc --noEmit`
- [ ] Run `bun test`
- [ ] Update `CHANGELOG.md` under `[Unreleased]`


---

## § 2 Proposed Design

### § 2.1 Config syntax

A top-level `passthrough` key on a **mapping entry** names source columns to carry through:

```yaml
- connector: erp
  channel: contacts
  entity: customers
  passthrough: [raw_segment_code, internal_account_ref]
  fields:
    - source: name
      target: customerName
```

`passthrough` is a YAML sequence of source field names. The names must be present in the
connector's source record; absent fields are silently skipped (same behaviour as `source` on a
missing field).

Passthrough fields are **mutually exclusive with `fields` entries** for the same field name —
a config validation error is raised if the same name appears in both `passthrough` and `fields`.

### § 2.2 Forward pass — namespaced key injection

After `applyMapping` completes, the engine reads each passthrough field directly from
`record.data` and injects it into the canonical record under a namespaced key:

```
_passthrough.<connectorId>.<fieldName>
```

Example: ERP connector ID `erp`, field `raw_segment_code` → key
`_passthrough.erp.raw_segment_code`.

The `_passthrough.*` namespace is reserved in the canonical schema. Resolution strategies
(coalesce, LWW, etc.) are never applied to passthrough keys — they are always last-write-wins
per source, isolated by namespace.

### § 2.3 Shadow state treatment

Passthrough keys are stored in `shadow_state` alongside canonical fields. They participate in
the shadow diff so that an unchanged passthrough value does not generate a spurious update. A
changed passthrough value triggers a new delta with the updated namespaced key present.

### § 2.4 Reverse pass — passthrough fields are never dispatched

`_passthrough.*` keys are stripped from the outbound payload before any `applyReverseMapping`
call. They are never written to any target connector. The namespace prefix ensures accidental
round-tripping is structurally impossible.

### § 2.5 Observability / delta consumers

Downstream delta consumers (e.g. the `SyncEvent` emitted via `onRecordSynced`) receive the
full canonical record including `_passthrough.*` keys. This is the primary intended use.

---

## § 3 Out of Scope

- **Passthrough arrays / nested objects** — each passthrough entry is a scalar or JSON value
  stored as-is. No element-level tracking.
- **Cross-source passthrough merge** — each connector has its own namespace; two connectors
  with the same field name under the same namespace is impossible by construction. No merging.
- **Passthrough in `element_fields`** — per-element passthrough is out of scope; use connector
  pre-extraction or an `expression` referencing the parent element for this case.

---

## § 4 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §1.6 Passthrough columns | Update status from "designed, not yet implemented" to "implemented" |
| `specs/config.md` | `MappingEntry` key reference table | Add `passthrough` key row (string array) |

---

## § 5 Implementation Checklist

- [ ] Add `passthrough?: z.array(z.string())` to `MappingEntrySchema` in `packages/engine/src/config/schema.ts`; validate no overlap with `fields[].source` names at load time
- [ ] Add `passthrough?: string[]` to the `ChannelMember` type in `packages/engine/src/config/loader.ts`; wire through from parsed config
- [ ] In `_processRecords` (after `applyMapping`): for each `sourceMember.passthrough` field, read `record.data[field]` and set `canonical["_passthrough.<connectorId>.<field>"] = value` (skip if field absent from data)
- [ ] In `_dispatchToTarget`: strip all keys matching `/^_passthrough\./` from the outbound record before passing to `applyReverseMapping`
- [ ] Shadow diff: `_passthrough.*` keys participate as normal — changed value → delta; unchanged → noop (no special handling needed beyond the existing diff path)
- [ ] Add tests: passthrough field forwarded to canonical record under namespaced key; unchanged passthrough → noop; changed passthrough → delta contains new value; passthrough key absent from source → silently skipped; passthrough key never present in outbound dispatch payload; two connectors with same passthrough field name → separate `_passthrough.<id>.*` keys; overlap with `fields` entry → config load error
- [ ] Update `specs/field-mapping.md §1.6` status
- [ ] Update `specs/config.md` `MappingEntry` key table
- [ ] Update `plans/engine/GAP_OSI_PRIMITIVES.md` — passthrough entry from 🔶 to ✅
- [ ] Update `specs/field-mapping.md` coverage table — passthrough row from 🔶 to ✅
- [ ] Run `bun run tsc --noEmit`
- [ ] Run `bun test`
- [ ] Update `CHANGELOG.md` under `[Unreleased]`
