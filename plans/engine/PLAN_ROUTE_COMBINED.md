# Route Combined (Routing + Merging)

**Status:** complete  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** Engine — identity, routing, config  
**Scope:** `packages/engine/src/engine.ts`, `specs/field-mapping.md`  
**Depends on:** `PLAN_RECORD_FILTER.md` (complete), `PLAN_TRANSITIVE_CLOSURE_IDENTITY.md` (complete)  

---

## § 1 Problem

The OSI-mapping "route combined" primitive covers a pattern where:

- One source connector supplies a **partial** view: only certain records (filtered by `filter`).
- A second source connector supplies an **unfiltered** view of the same entity type.
- Both contribute to the **same** canonical target via identity linking.

Example: an ERP connector yields all accounts; a CRM connector yields only accounts of
`type = 'customer'`. Both should merge into one canonical `contacts` entity when they share an
email. The CRM filter narrows what records are ingested from CRM but must not prevent merging
with ERP records that already exist for the same canonical entity.

The individual building blocks exist — `filter` on mapping entries, transitive closure identity
linking — but the combined pattern has not been validated or tested. The risk is:

1. **False echo**: source A ingests the record first and writes a shadow. Source B later ingests
   the same entity (via identity link). Shadow comparison on source B's pass could incorrectly
   mark it as a skip even when source B contributes different fields.
2. **Filter-cleared shadow interference**: when a record from source B falls out of filter on a
   later cycle, `dbDeleteShadow` clears source B's shadow row. This must not affect source A's
   contribution — they are separate `(connectorId, entity, externalId)` rows in `shadow_state`.
3. **Identity resolution ordering**: both sources must converge to the same `canonical_id`. If
   source A is ingested on one tick and source B on the next, the transitive closure must still
   link them when source B's identity fields are available.
4. **Reverse dispatch with partial source**: when writing back to source B, the reverse filter
   (`reverse_filter`) must suppress the write for entities where source B's own filter would
   exclude the record — i.e. source B only receives writes for records it originally contributed.

Scenarios 1, 3, and 4 appear mechanically correct today, but there are no tests confirming
they compose without edge cases in the combined pattern. Scenario 2 has a documented TODO in the
source (`_processRecords` record-filter path: "if this was the only source, the canonical goes
stale but no delete dispatch is issued").

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §5.3 Discriminator routing | Add a §5.4 "Route combined" subsection documenting the config pattern, the guarantee that shadow_state is per-source so filtered-out records from one source cannot affect another source's contribution, and the reverse_filter / reverse_required interaction for partial-source write-back. |
| `specs/field-mapping.md` | §10 coverage table | Update Route combined row from 🔶 to ✅ once validated. |
| `specs/field-mapping.md` | Open gaps list | Remove route-combined bullet once validated. |
| `plans/engine/GAP_OSI_PRIMITIVES.md` | §9 Route combined | Update from 🔶 to ✅. |

---

## § 3 Design

### § 3.1 Why it should already work

`shadow_state` is keyed on `(connector_id, entity_name, external_id)`. Two connectors that
happen to contribute to the same canonical entity each have their own independent shadow rows.
The filter on source B only affects source B's shadow; it cannot corrupt source A's shadow.

Identity linking: `_resolveCanonical` is called after inbound mapping runs. It consults
`identityGroups` (if configured) or falls through to get-or-create. If source A linked entity
with canonical ID `c1`, and source B's record matches on the same identity field, the transitive
closure links source B's record to `c1` as well. The linking is order-independent because
connected components handle multi-hop chains.

Record filter cleared shadow: when source B's `filter` rejects a record, `dbDeleteShadow` is
called for `(sourceB.connectorId, entity, record.id)`. Source A's shadow row at
`(sourceA.connectorId, entity, record.id)` is unaffected. ✅

Reverse dispatch: `_dispatchToTarget` iterates `regularTargets`. The target is only dispatched
if it has a `written_state` row or a known external ID. If source B's filter means it never
ingested a particular record, it will have no external ID for that canonical entity, and
`dbGetExternalId` returns undefined → the target is skipped. When source B uses `reverse_filter`
instead of `filter`, the mechanism is slightly different (the record was ingested but is suppressed
on reverse) — same result, write is suppressed. ✅

### § 3.2 The stale-canonical edge case

When source B's `filter` rejects a record that B previously ingested:
- Source B's shadow row is deleted (`dbDeleteShadow`).
- Source A's shadow row remains.
- No delete dispatch is issued for source B's targets.

This is the documented TODO in `_processRecords`. For the route-combined pattern this is
acceptable behaviour with a documented trade-off: the canonical entity continues to exist (source
A still contributes), and source B's target is not written again (no `written_state` row after
shadow deletion). The entity does not go stale from source A's perspective.

Document this in the spec as: *"When a source record falls out of filter, the canonical entity
continues to exist as long as at least one other source contributes. The filtered-out source
no longer participates in resolution or reverse dispatch. No explicit delete signal is issued
to target connectors — use `propagateDeletes: true` on the channel and an explicit `deleted: true`
signal from the connector if write-back deletion is needed."*

### § 3.3 Config pattern

```yaml
channels:
  - name: contacts

mappings:
  # Source A: full view of all accounts from ERP
  - connector: erp
    channel: contacts
    entity: contacts
    identity:
      - field: email
    fields:
      - source: email
        target: email
      - source: erp_id
        target: erpRef

  # Source B: filtered view from CRM — only customer-type accounts
  - connector: crm
    channel: contacts
    entity: contacts
    filter: "record.type === 'customer'"
    identity:
      - field: email          # same identity field → merges with ERP record via transitive closure
    fields:
      - source: email
        target: email
      - source: phone
        target: phone
    # reverse_filter ensures CRM only receives write-backs for customer-type records
    reverse_filter: "record.type === 'customer'"

  # Target: warehouse receives the merged canonical entity
  - connector: warehouse
    channel: contacts
    entity: contacts
    fields:
      - source: email
        target: email
      - source: phone
        target: phone
      - source: erpRef
        target: erp_account_id
```

### § 3.4 Acceptance criteria

The acceptance criteria are all test-based. No engine code changes are expected — the goal is to
confirm correct behaviour with a test suite, then promote from 🔶 to ✅ in the GAP report.

---

## § 4 Test Cases

| ID | Scenario | Expected |
|----|----------|----------|
| RC1 | ERP ingests record; CRM ingests same record (matching email) with filter; warehouse receives merged fields from both | One canonical entity; warehouse updated with fields from both sources |
| RC2 | ERP and CRM both present; CRM record later falls out of filter; canonical entity survives; warehouse not re-updated unless ERP also changes | No stale-canonical; written_state suppresses no-op |
| RC3 | CRM record with `reverse_filter`; warehouse update dispatched; CRM not written back (reverse_filter rejects) | No write to CRM |
| RC4 | CRM ingested first; ERP ingested second; same result as RC1 — ordering must not matter | Canonical merges regardless of ingest order |
| RC5 | Two identity fields; source A has `{email, taxId}`, source B has `{email}` only; transitive closure via email links them | One canonical; source B's shadow does not include taxId but resolution picks it from source A |
| RC6 | Source B filter rejects record; source B's shadow cleared; source A's shadow unchanged; next cycle source A changes; correct update dispatched | Shadow independence confirmed |

---

## § 5 Implementation Steps

1. Write the six test cases above in `packages/engine/src/engine.test.ts` or a new file
   `packages/engine/src/route-combined.test.ts`.
2. Run tests. If any fail, diagnose and fix the engine behaviour — do not paper over failures.
3. Update `specs/field-mapping.md` §5.4 with the confirmed behaviour.
4. Update the GAP report and coverage table.
