# Record-Level Filter and Routing

**Status:** backlog  
**Date:** 2026-04-07  
**Effort:** S  
**Domain:** engine  
**Scope:** config/schema, config/loader, engine (ingest + _processRecords + _dispatchToTarget)  
**Spec:** specs/field-mapping.md §5  
**Depends on:** nothing — independent of array expansion  

---

## Problem

`filter` / `reverse_filter` on a mapping entry are currently only wired up for array element
expansion (`elementFilter` / `elementReverseFilter` on `ChannelMember`, applied in
`array-expander.ts`). They operate on individual array elements, not on top-level source records.

There is no way to express "only ERP records where `type = 'customer'` should contribute to this
canonical entity" — which is what `specs/field-mapping.md §5.1` calls a *source filter* and what
OSI-mapping §9 uses for *discriminator routing*.

Note: `elementFilter` / `elementReverseFilter` are not touched by this plan. They remain
array-element-only. Two separate mechanisms with similar names but different scopes.

---

## What this plan covers

### § 1 Source record filter (`record_filter`)

A JS expression applied to each raw source record on the **forward pass**, before the record
reaches the resolution layer.

- Records that fail the filter are **excluded** from resolution for this mapping entry. They
  contribute nothing to the canonical entity.
- Records that previously matched but no longer do: their shadow state for this
  `(connector, entity)` pair is **cleared** (treated as a soft-delete contribution — all fields
  set to null, which causes the canonical to fall back to other contributing sources or be
  deleted if no sources remain). See § 5 for the clearing behaviour.
- Bindings available in the expression: `record` — the raw source record after `_`-prefix
  stripping, before `inbound` field mapping.

**Config syntax:**

```yaml
- connector: erp
  channel: contacts
  entity: contacts
  record_filter: "record.type === 'customer'"
```

### § 2 Reverse record filter (`record_reverse_filter`)

A JS expression applied to each resolved canonical entity on the **reverse pass**, before the
engine decides whether to write back to this connector.

- Canonical entities that fail the filter are skipped for this connector's write. No
  insert/update is issued. No `written_state` row is written (so the filter result is
  re-evaluated on the next cycle rather than being permanently suppressed).
- Bindings available in the expression: `record` — the outbound-mapped record (after
  `targetMember.outbound` mapping is applied). This is consistent with OSI-mapping's
  `reverse_filter` semantics: filtering is on what would be written, not the canonical.

**Config syntax:**

```yaml
- connector: crm
  channel: contacts
  entity: contacts
  record_reverse_filter: "record.status !== 'archived'"
```

### § 3 Discriminator routing (derived from §1)

Discriminator routing is **not a new engine primitive** — it falls out of record filters applied
across multiple channels:

```yaml
# mappings/customers.yaml
- connector: erp
  channel: customers
  entity: contacts
  record_filter: "record.role === 'customer'"

- connector: crm
  channel: customers
  entity: contacts
```

```yaml
# mappings/staff.yaml
- connector: erp
  channel: staff
  entity: people
  record_filter: "record.role === 'employee'"

- connector: hr
  channel: staff
  entity: people
```

Each channel is processed independently. The ERP connector appears in both channels but with
different filters and different canonical entity targets. No engine changes beyond §1 are needed
to support this pattern.

**Within-channel discriminator routing** (same ERP source → different canonical entity names in
the same channel, based on field value) is **not in scope** for this plan. It would require
multiple members per connector per channel, which currently causes undefined behaviour in
`_processRecords` and `ingest`. That is a separate design concern.

### § 4 Route combined (derived from §1 + identity linking)

Route-combined is the pattern where a filtered source and an unfiltered source both contribute
to the same canonical entity type, merged by identity fields. It falls out of §1 + the existing
identity linking foundation:

```yaml
- connector: erp
  channel: contacts
  entity: contacts
  record_filter: "record.type === 'customer'"  # only B2B customers from ERP

- connector: crm
  channel: contacts
  entity: contacts
  # no filter — all CRM contacts
```

Identity linking (via `identityFields` / `identityGroups`) handles the merge once filters are
applied. No additional engine changes needed.

---

## Spec changes planned

**`specs/field-mapping.md §5.1`** — update status from "designed, not yet implemented" to
"implemented". Clarify that `record_filter` is the config key (not `filter`, which is reserved for
element-level array filtering to avoid ambiguity). Document the shadow-clearing soft-delete
behaviour.

**`specs/field-mapping.md §5.2`** — update status to "implemented". Clarify that
`record_reverse_filter` is the config key (not `reverse_filter`).

**`specs/field-mapping.md §5.3`** — update status to "implemented". Note the within-channel
multi-member limitation.

**`plans/engine/GAP_OSI_PRIMITIVES.md §5 (Filters)`** — update from ❌ to ✅. Update §9
(Discriminator routing and Route combined) from ❌ to ✅ / 🔶 as appropriate.

---

## Implementation steps

### Step 1 — Schema (`config/schema.ts`)

Add two new optional fields to `MappingEntrySchema`:

```ts
record_filter: z.string().optional(),         // JS expression — forward pass record filter
record_reverse_filter: z.string().optional(), // JS expression — reverse pass record filter
```

These are **separate keys** from `filter` / `reverse_filter` (which are element-level) to
avoid any ambiguity at the schema and documentation level.

### Step 2 — Loader (`config/loader.ts`)

Add two new optional fields to `ChannelMember`:

```ts
/** Spec: specs/field-mapping.md §5.1 — forward record filter.
 *  When set, only source records for which this returns true contribute to resolution.
 *  Records that previously matched but now fail are treated as soft-delete contributions. */
recordFilter?: (record: Record<string, unknown>) => boolean;
/** Spec: specs/field-mapping.md §5.2 — reverse record filter.
 *  When set, canonical entities for which this returns false are skipped for this connector. */
recordReverseFilter?: (record: Record<string, unknown>) => boolean;
```

In the mapping entry resolution loop, compile `record_filter` and `record_reverse_filter` using
the same `new Function` approach as `compileElementFilter`, but with a single `record` binding
rather than `(element, parent, index)`. Extracted into a shared `compileRecordFilter` function:

```ts
function compileRecordFilter(expr: string, channel: string): (record: Record<string, unknown>) => boolean {
  try {
    return new Function("record", `"use strict"; return (${expr});`) as (r: Record<string, unknown>) => boolean;
  } catch (e) {
    throw new Error(`record_filter compilation error in channel "${channel}": ${String(e)}`);
  }
}
```

Validation: compilation failure is a fatal config load error (same as element filters).

### Step 3 — Forward pass: `_processRecords`

After `applyMapping(stripped, sourceMember.inbound, "inbound")` where `stripped` is the raw
record (pre-mapping), apply `sourceMember.recordFilter`:

```ts
if (sourceMember.recordFilter && !sourceMember.recordFilter(stripped)) {
  // Record does not match filter. If it previously had a shadow (i.e. it matched on a prior
  // cycle), clear the shadow so it no longer contributes to resolution.
  const existingShadow = dbGetShadow(this.db, connectorId, sourceMember.entity, record.id);
  if (existingShadow) {
    dbDeleteShadow(this.db, connectorId, sourceMember.entity, record.id);
    // Trigger resolution for this canonical ID so the canonical falls back to other sources.
    // ... (proceed with triggering fan-out for the removed contribution)
  }
  continue; // skip this record
}
```

The shadow clearing + residual fan-out is the subtle part — see § 5.

### Step 4 — `collectOnly` path

Apply `recordFilter` in the `collectOnly` loop in the same position as step 3 (before storing
the shadow). Records that fail the filter are skipped entirely in collectOnly — no shadow is
written. If they had a shadow from a previous run, clear it.

### Step 5 — Reverse pass: `_dispatchToTarget`

Apply `recordReverseFilter` in `_dispatchToTarget` before the noop check. The binding is the
**outbound-mapped record** (after `applyMapping(resolvedCanonical, targetMember.outbound, "outbound")`):

```ts
if (targetMember.recordReverseFilter && !targetMember.recordReverseFilter(localData)) {
  return { type: "skip" };
}
```

Skip before the written_state noop check so a filtered-out canonical does not write a
`written_state` row. This ensures the filter is re-evaluated on the next cycle.

---

## § 5 Soft-delete signal when filter stops matching

When `recordFilter` returns false for a record that **previously contributed** shadow state, the
engine must propagate the removal to other channel members. The shadow row is deleted and a
resolution pass is triggered for that canonical ID.

**Mechanism for v1 (simple approach):** add a `dbDeleteShadow` helper that removes the row.
After deletion, if there are other contributing sources for the same canonical ID, the next
normal resolution pass (triggered by any ingest on the same channel) will re-resolve from the
remaining sources. If this was the only contributing source, the canonical entity will have an
empty resolution — the fan-out should produce no update (all nulls are equivalent to a
soft-delete, but actual delete dispatch is out of scope for this plan; see
`plans/engine/PLAN_DELETE_PROPAGATION.md`).

For now: record that this edge case produces no dispatch to targets (the canonical goes stale
but no delete is issued). A follow-up comment in code points at `PLAN_DELETE_PROPAGATION.md`.

---

## § 6 Security note

`new Function` executes arbitrary JS. Same mitigation as `PLAN_ELEMENT_FILTER.md §4`: in
untrusted multi-tenant deployments, disable record filters at engine level or isolate in a
worker. This is noted in the spec.

---

## Tests

| ID | Scenario |
|----|---------|
| RF1 | `record_filter`: records matching filter are processed normally |
| RF2 | `record_filter`: records not matching filter are excluded from resolution |
| RF3 | `record_filter`: record that matched on previous cycle but fails on current cycle has shadow cleared; canonical falls back to other sources |
| RF4 | `record_filter`: compilation failure at `loadConfig` time throws a descriptive error |
| RF5 | `record_reverse_filter`: canonical entities matching filter are dispatched |
| RF6 | `record_reverse_filter`: canonical entities not matching filter are skipped (no write, no written_state row) |
| RF7 | `record_reverse_filter`: compilation failure at `loadConfig` time throws a descriptive error |
| RF8 | Discriminator routing: ERP connector in two channels with different filters; ingest on each channel produces correct canonical separation |
| RF9 | Route combined: ERP (filtered) + CRM (unfiltered) in same channel, records merged by identity field |
| RF10 | `loadConfig` compiles `record_filter` from YAML into a function that evaluates correctly |
