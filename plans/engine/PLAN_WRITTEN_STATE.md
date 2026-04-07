# Written State Table

**Status:** draft  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** engine  
**Scope:** new `written_state` DB table; target-centric noop, element tombstoning, derive_timestamps  
**Spec:** specs/field-mapping.md §7.1, §7.2  
**Depends on:** nothing — uses existing fan-out infrastructure  

---

## Problem

The engine's current noop detection compares incoming source values against `shadow_state`
(what was last *read* from that source). This does not cover two important cases:

**Case 1 — Post-dispatch target divergence.** A target connector independently mutates a
field after the engine last wrote to it. On the next ingest cycle the resolved canonical
value matches the engine's shadow copy but no longer matches what the target actually holds.
The engine dispatches a noop-looking write when the target actually needs healing. Conversely,
if the resolved value hasn't changed but the target drifted, the engine has no record of what
it last wrote and cannot suppress the redundant write.

**Case 2 — Element tombstoning in nested arrays.** After the reverse pass reassembles a
`lines` array and writes it back to the ERP connector, future cycles need to compare the
current resolved set of child entities against the previously written set to detect removed
elements. `shadow_state` tracks what the last READ from the ERP contained; it cannot
reliably reflect what the engine last WROTE (because the engine transforms and re-assembles
before writing). Without a "last written" record, element removal cannot be detected.

**Case 3 — Derived timestamps.** Some source connectors (CSV files, legacy REST APIs)
provide no per-field update timestamps. `last_modified` resolution cannot be applied to
them. If we know what the engine last wrote to that source, we can derive timestamps by
comparing current incoming values against `written_state`: unchanged fields carry forward
their prior timestamp; changed fields get the current cycle time.

---

## Spec changes planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §7.1 | Promote from "designed, not yet implemented" to "designed". Add schema aligned with codebase conventions (`connector_id`, `canonical_id`). Describe write path and read path. |
| `specs/field-mapping.md` | §7.2 | Promote from "depends on written_state" to "designed, depends on §7.1 implementation". |
| `specs/database.md` | Schema | Add `written_state` table definition. |
| `specs/sync-engine.md` | Ingest Loop §step 4f-v | Note that after a successful write, the engine writes to `written_state`; and before dispatching, compares against `written_state` for the target-centric noop check. |

---

## Design

### 1. Schema

Add to `packages/engine/src/db/migrations.ts`:

```sql
CREATE TABLE IF NOT EXISTS written_state (
  connector_id  TEXT NOT NULL,   -- target connector that received the write
  entity_name   TEXT NOT NULL,   -- entity name as used in the channel member
  canonical_id  TEXT NOT NULL,   -- canonical UUID from identity_map
  data          TEXT NOT NULL,   -- JSON blob: { fieldName: value, … }
  written_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (connector_id, entity_name, canonical_id)
)
```

Keyed on `(connector_id, entity_name, canonical_id)`:
- `connector_id`: the target connector instance — one row per target per entity.
- `entity_name`: required because the same canonical_id may appear under different
  entity types within the same connector (e.g. both as an `orders` record and an
  identity-linked clone in another entity).
- `canonical_id`: the global UUID from `identity_map` — stable regardless of
  external ID changes.

`data` is the **post-outbound-mapping, pre-rename** field blob that was handed to the
connector's `insert()` or `update()`: the values as the connector received them. Storing
them at this level means `written_state` is directly comparable against future resolved
values after outbound mapping is applied.

### 2. Write path — after successful fan-out

Location: `packages/engine/src/engine.ts`, inside the fan-out loop, step `f-v`
(after the connector `insert()` / `update()` call succeeds and before the atomic commit).

After a successful write result (non-error `InsertResult` or `UpdateResult`), upsert:

```sql
INSERT INTO written_state (connector_id, entity_name, canonical_id, data)
VALUES (?, ?, ?, ?)
ON CONFLICT(connector_id, entity_name, canonical_id)
DO UPDATE SET data = excluded.data, written_at = excluded.written_at
```

This is included in the same SQLite transaction as the `shadow_state` write and watermark
advance (already atomic per the ingest loop spec). If the write fails (error result or
exception), no `written_state` row is written — correct behaviour, as no data reached
the target.

### 3. Read path — target-centric noop (§7.1)

Before dispatching to a target connector, compare the resolved outbound-mapped delta
against the target's `written_state` row (if any). If **all** fields in the delta match
`written_state.data`, skip the dispatch.

This is an additional guard on top of the existing source-shadow-based noop. The
existing guard (suppress if incoming value == shadow value for that source) stays.

```
existing guard:  resolved_delta == target_source_shadow?  → skip
NEW guard:       resolved_delta == written_state.data?    → skip
```

The new guard catches the case where the target drifted from what the engine last
wrote — in that scenario `resolved_delta != target_source_shadow` (existing guard
allows dispatch) but `resolved_delta == written_state.data` (new guard suppresses it).

Implementation: add a `getWrittenState(connectorId, entityName, canonicalId)` DB helper
and call it in the fan-out step before calling `connector.insert/update`.

### 4. Element tombstoning for nested arrays

When reverse-pass array reassembly is implemented (see
[PLAN_NESTED_ARRAY_PIPELINE.md](PLAN_NESTED_ARRAY_PIPELINE.md) reverse-pass section),
the reassembly step reads `written_state` to determine what elements were last written:

```
query: SELECT data FROM written_state
       WHERE connector_id = ? AND entity_name = 'orders' AND canonical_id = ?
```

The `data` blob contains the last-written `lines` array. Elements present in the stored
array but absent from the current resolved set are emitted as tombstones
(`{ …element_fields, _removed: true }`). This drives either a delete call or a targeted
array-without-that-element write depending on the target connector's write contract.

No additional schema changes are needed for tombstoning — it reads from the same
`written_state` table.

### 5. Derived timestamps (`derive_timestamps` — §7.2)

For a source mapping that declares `derive_timestamps: true`, the engine processes
each incoming source record as follows during the forward pass:

1. Fetch the source's own `written_state` row (what the engine last wrote to this
   source connector for this entity).
2. For each source field:
   - If `incoming_value == written_state.data[field]`: field is unchanged — carry
     forward the timestamp stored in `shadow_state` for that field.
   - If `incoming_value != written_state.data[field]` (or field is new): field changed
     — assign `now()` as the timestamp.
3. Proceed with `last_modified` resolution using the derived timestamps.

This enables sources without native timestamps to participate in LWW conflict resolution.

Config:
```yaml
  - connector: legacy_csv
    channel: contacts
    entity: contacts
    derive_timestamps: true
    last_modified: true   # use derived timestamps for LWW resolution
```

`derive_timestamps` is only meaningful when `last_modified` resolution is active.
Warn and ignore if `last_modified` is not set.

---

## Implementation steps

### Step 1 — Spec updates

1. Update `specs/field-mapping.md §7.1`: replace "not yet implemented" with "designed";
   add the schema from §1 above with rationale for the chosen key.
2. Update `specs/field-mapping.md §7.2`: update status to "designed, depends on §7.1".
3. Update `specs/database.md`: add `written_state` table definition.
4. Update `specs/sync-engine.md` ingest loop: note `written_state` write after fan-out
   and the target-centric noop check before dispatch.

### Step 2 — DB schema

- Add `CREATE TABLE IF NOT EXISTS written_state …` to
  `packages/engine/src/db/migrations.ts`.
- Add a `writtenState` helper module (or extend the existing DB helpers) with:
  - `upsertWrittenState(db, connectorId, entityName, canonicalId, data)`
  - `getWrittenState(db, connectorId, entityName, canonicalId): Record<string, unknown> | undefined`

### Step 3 — Fan-out write path

- Modify `packages/engine/src/engine.ts`: after a successful `InsertResult` /
  `UpdateResult` in the fan-out step, call `upsertWrittenState` within the existing
  atomic transaction.

### Step 4 — Target-centric noop check

- In the fan-out step, before calling `connector.insert/update`, call
  `getWrittenState` and compare field-by-field against the resolved outbound delta.
  If all fields match, skip the dispatch (same mechanics as the existing noop guard).
- Apply the check only to `update` dispatches, not `insert` dispatches (on first
  insert there is no prior written state to compare against).

### Step 5 — Tests

Unit tests in `packages/engine/src/engine.test.ts` (or a dedicated
`written-state.test.ts`):

- After a successful write, `written_state` row is present with correct data.
- Target-centric noop: if `written_state` matches resolved delta, no dispatch occurs
  even if `shadow_state` differs from the incoming value.
- Target-centric noop does NOT suppress first-time inserts.
- After a failed write (connector returns error), `written_state` is not updated.
- `written_state` is updated on subsequent writes (upsert, not just insert).

### Step 6 — CHANGELOG

```
### Added
- `written_state` table: the engine now records the field values last written to each
  target connector per entity. Used for target-centric noop suppression
  (specs/field-mapping.md §7.1) and as the foundation for element tombstoning in
  nested array reassembly.
```

---

## Out of scope (follow-on, enabled by this plan)

| Feature | Depends on |
|---------|-----------|
| `derive_timestamps` (§7.2) | Step 3 of this plan (written_state written) |
| Element tombstoning | Reverse-pass nested array reassembly (PLAN_NESTED_ARRAY_PIPELINE.md reverse-pass) |
| `written_state` per-field timestamps | Future: store per-field written_at alongside data for finer-grained derive_timestamps |

---

## Open questions

1. **First-insert written_state**: should `written_state` be seeded at insert time
   with the data the engine sent to the connector? Yes — this plan proposes that. But
   if the connector transforms the data on receipt (e.g. sets a server-generated
   field), the stored `written_state` will not match what the connector actually holds.
   This is acceptable for the target-centric noop use case (we are comparing against
   what we sent, not what the connector stored). Revisit if true round-trip fidelity
   is needed.

2. **Delete operations**: when the engine dispatches a delete to a target connector,
   should the `written_state` row be removed or tombstoned? Removing it is simplest —
   a subsequent insert would create a fresh row. This plan proposes deletion of the
   `written_state` row on a successful delete dispatch.
