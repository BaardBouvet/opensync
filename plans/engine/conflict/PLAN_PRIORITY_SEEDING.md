# Priority-Aware Initial Seeding

**Status:** proposed  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** Engine — conflict resolution  
**Scope:** `packages/engine/src/core/conflict.ts`, `packages/engine/src/core/conflict.test.ts`, `specs/sync-engine.md`, `specs/field-mapping.md`  
**Depends on:** `PLAN_RESOLUTION_STRATEGIES.md` (complete), `PLAN_FIELD_TIMESTAMPS.md` (complete)  

---

## § 1 Problem Statement

`resolveConflicts` has two unconditional fast-paths that bypass all conflict configuration:

```ts
// New record in target — accept everything
if (!targetShadow) return incoming;

// …and later, per-field:
if (!existing) {
  resolved[field] = incomingVal;   // no strategy check
  continue;
}
```

The first fires when a target has no shadow at all (true first write — correct).  
The second fires when this specific field has no prior shadow entry, which happens whenever two
or more non-master connectors are collected before any fan-out begins:

1. Connector A runs `collectOnly` → A's shadow seeded with `email = "a@example.com"`.
2. Connector B runs `collectOnly` → B's shadow seeded with `email = "b@example.com"`.
3. Onboard / fan-out begins. A fans out to B.
4. B's shadow **already has** `email` → `!existing` is false → `fieldMasters` applies →
   A is not the declared master → A's value is dropped. B keeps `"b@example.com"`.
5. B fans out to A. Same result in reverse. A keeps `"a@example.com"`.
6. The master connector eventually runs and corrects both — but only after a window of
   divergence, and only if the master connector syncs at all.

The deeper issue: `fieldMasters` was designed to answer "who owns ongoing updates?" It has no
opinion on "who seeds the canonical at onboarding time?" The `!existing` fast-path reflects this
— it was written to mean "no shadow yet, so any source can provide a value." That is correct for
LWW channels but wrong for channels with declared source priorities or master connectors.

### § 1.1 Observed consequence

When a master-owned field originates in a non-master system (the common case for existing data),
the canonical value handed to the master connector on its first insert is whatever whichever
non-master ran `collectOnly` first happened to hold. Collection order is not guaranteed to be
stable across onboarding runs.

### § 1.2 The two-tool problem

`fieldMasters` (hard veto) and `coalesce` (priority-ordered preference) solve overlapping but
distinct problems:

| | `fieldMasters` | `coalesce` |
|---|---|---|
| Ongoing updates | Blocks non-master writes absolutely | Prefers lower-priority number, timestamp tiebreaker |
| Initial seeding | **No opinion — unconditional accept** | **No opinion — unconditional accept** |
| Config granularity | Per-field | Per-field (via `fieldStrategies`) |

Neither participates in `!existing` seeding today.

---

## § 2 Proposed Fix

Make the `!existing` (new-field) branch respect the same priority ordering that `coalesce` and
`fieldMasters` apply to updates. The logic is:

1. **`fieldMasters[field]` declared →** only the declared master's value seeds the field. If the
   incoming source is not the master, **skip** (leave the field absent in the canonical shadow
   until the master syncs). This extends the hard-veto semantics to seeding time.

2. **`coalesce` fieldStrategy declared for `field` →** apply priority ordering: if the field
   already has a shadow entry from a **higher-priority** (lower number) source that arrived
   during a prior `collectOnly` pass, keep it. Only allow a lower-priority source to seed the
   field if no higher-priority source has provided it yet.

3. **All other strategies (LWW, `collect`, `bool_or`, expression) →** preserve current
   unconditional-accept behaviour. These strategies either commute (order doesn't matter) or
   accumulate (all values wanted).

### § 2.1 `fieldMasters` seeding change

```ts
if (!existing) {
  // NEW: fieldMasters hard-veto applies at seeding time too
  if (config.fieldMasters?.[field] && config.fieldMasters[field] !== incomingSrc) {
    continue;  // non-master cannot seed this field
  }
  resolved[field] = incomingVal;
  continue;
}
```

Effect: the field stays absent in the canonical shadow until the declared master connector
contributes it. When the master's first record arrives (its own `collectOnly` pass or its
first poll), the `!existing` branch fires and the master's value seeds the canonical. From
that point normal `fieldMasters` update blocking applies.

The consequence for the master-insert scenario: every non-master connector gets an `insert`
that omits master-owned fields the master hasn't provided yet, rather than getting them
pre-populated with data from a random non-master source. This is safer — the master system
never receives an incorrect pre-existing value it must correct.

### § 2.2 `coalesce` seeding change

For the `!existing` + `coalesce` case we need the priority of the source that **already**
seeded this field in another connector's shadow, compared against the incoming source's
priority. However, the `!existing` path fires when the **target's** shadow has no entry for
the field. At this moment the field may or may not be in the **source's** shadow.

The practical approach: extend the `!existing` branch to check `connectorPriorities` when
`fieldStrategies[field].strategy === "coalesce"`:

```ts
if (!existing) {
  const fStrat = config.fieldStrategies?.[field];
  if (fStrat?.strategy === "coalesce") {
    // Only seed if incoming has equal or higher priority than whatever already
    // seeded canonical. We use the source shadow's `src` field to look up the
    // priority of the connector that originally wrote the canonical value.
    // If no canonical entry exists yet, any source can seed (current behaviour).
    // If canonical already has a value from a higher-priority source, skip.
    //
    // Note: in the first-write path (no canonical shadow anywhere), `existing`
    // will be undefined for all sources — this is fine, first writer wins for
    // equal-priority sources (same as before, determinism via ingest order).
    const inPri = config.connectorPriorities?.[incomingSrc] ?? Number.MAX_SAFE_INTEGER;
    // canonicalSrc is the connector that seeded the canonical for this field
    // (available as the `src` field on the TARGET shadow entry when it exists).
    // Since `!existing` means the target has no entry, we fall through to
    // check `seedingPriority`: the minimum priority already committed in any
    // other connected shadow for this canonical entity field.
    // This requires passing `seedingPriorities` into resolveConflicts — see §3.
    const seedPri = seedingPriorities?.[field] ?? Number.MAX_SAFE_INTEGER;
    if (inPri > seedPri) continue;  // better source already seeded — don't overwrite
  }
  resolved[field] = incomingVal;
  continue;
}
```

### § 2.3 `seedingPriorities` parameter

The `!existing` coalesce check needs to know what priority has already been committed to the
canonical for this field across all collected shadows. The engine already has all per-connector
shadows when it calls `resolveConflicts` per-target, so the caller can compute this cheaply:

```ts
// At call site in engine._processRecords, before calling resolveConflicts per target:
const seedingPriorities: Record<string, number> = {};
for (const [connId, shadow] of allShadowsByConnector) {
  const pri = conflictConfig.connectorPriorities?.[connId] ?? Number.MAX_SAFE_INTEGER;
  for (const field of Object.keys(shadow)) {
    if ((seedingPriorities[field] ?? Number.MAX_SAFE_INTEGER) > pri) {
      seedingPriorities[field] = pri;
    }
  }
}
```

`resolveConflicts` receives `seedingPriorities` as a new optional parameter. When absent,
`coalesce` seeding falls back to the current unconditional-accept behaviour (no regression for
callers that don't pass it).

---

## § 3 Interface Changes

`resolveConflicts` signature gains one optional parameter:

```ts
export function resolveConflicts(
  incoming: Record<string, unknown>,
  targetShadow: FieldData | undefined,
  incomingSrc: string,
  incomingTs: number,
  config: ConflictConfig,
  fieldMappings?: FieldMappingList,
  incomingFieldTimestamps?: Record<string, number>,
  incomingCreatedAt?: number,
  createdAtBySrc?: Record<string, number>,
  seedingPriorities?: Record<string, number>,   // NEW: minimum priority already seeded per field
): Record<string, unknown>
```

The engine's `_processRecords` call site is updated to compute and pass `seedingPriorities`
when `fieldMasters` or any `coalesce` field strategy is configured.

---

## § 4 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/sync-engine.md` | Conflict Resolution — Global strategies | Add paragraph: "`fieldMasters` seeding behaviour — the hard veto extends to initial field seeding. A non-master source cannot seed a master-owned field; the field remains absent in the canonical until the declared master provides it." |
| `specs/sync-engine.md` | Conflict Resolution — Per-field strategies | Add note under `coalesce`: "At seeding time (no prior shadow entry), the lower-priority-number source wins, consistent with update behaviour. Equal-priority sources fall back to arrival order." |
| `specs/field-mapping.md` | §2.1 `field_master` / `fieldMasters` | Add paragraph documenting seeding veto. |
| `specs/field-mapping.md` | §2.2 `last_modified` | No change — unconditional seeding preserved. |
| `docs/faq.md` | "What if two non-master systems both have an initial value?" | Update to reflect that, after this plan is implemented, `fieldMasters` prevents non-master seeding entirely, and `coalesce` respects priority ordering at seeding time. |

---

## § 5 Test Plan

All new tests go in `packages/engine/src/core/conflict.test.ts` (unit) and
`packages/engine/src/engine.test.ts` or an existing integration test file (integration).

### § 5.1 `fieldMasters` seeding veto (unit)

| ID | Scenario | Expected |
|----|----------|---------|
| PS1 | `!existing`, incoming is non-master for field | Field absent from resolved |
| PS2 | `!existing`, incoming is the declared master | Field present in resolved |
| PS3 | `!existing`, field has no `fieldMasters` entry | Field present in resolved (no regression) |
| PS4 | `existing` present, non-master incoming | Field absent (existing `fieldMasters` behaviour unchanged) |

### § 5.2 `coalesce` seeding priority (unit)

| ID | Scenario | Expected |
|----|----------|---------|
| PS5 | `!existing`, `seeding­Priorities[field]` = 1, incoming priority = 2 | Field absent (better source already seeded) |
| PS6 | `!existing`, `seeding­Priorities[field]` = 2, incoming priority = 1 | Field present (incoming is better) |
| PS7 | `!existing`, no `seeding­Priorities` passed | Field present (no regression) |
| PS8 | `!existing`, equal priority, no `seeding­Priorities` | Field present (arrival-order tiebreak, no regression) |

### § 5.3 Integration — `fieldMasters` seeding through full `collectOnly` + onboard cycle

| ID | Scenario | Expected |
|----|----------|---------|
| PS9 | Two non-master connectors collected; `fieldMasters: { email: "crm" }`; fan-out runs | Neither non-master seeds `email` in canonical; `email` absent from inserts until CRM is collected |
| PS10 | As PS9, then CRM collected; fan-out runs | CRM's `email` value appears in inserts to all non-master connectors |

### § 5.4 Integration — `coalesce` seeding priority through `collectOnly` + onboard

| ID | Scenario | Expected |
|----|----------|---------|
| PS11 | Two non-master connectors, `connectorPriorities: { erp: 1, crm: 2 }`, `fieldStrategies: { email: { strategy: "coalesce" } }`, ERP collected first | ERP's `email` seeds canonical |
| PS12 | As PS11, but CRM collected first, ERP collected second | ERP's `email` still seeds canonical (lower number = higher priority) |

---

## § 6 Rollout Considerations

- **Behaviour change for `fieldMasters` users.** Before this plan: non-master systems could
  seed master-owned fields freely; the master would correct them on its first sync. After:
  master-owned fields are absent from inserts to non-master connectors until the master syncs.
  Target connectors that require the field for a successful insert will receive a dispatch
  **without** that field. If such connectors have `output_required: true` on the field, the
  insert will be suppressed entirely (`PLAN_REVERSE_REQUIRED.md` / `outbound_required`).
  Users with `fieldMasters` and no `outbound_required` should be aware of this change.
- **`coalesce` seeding change is additive.** The `seedingPriorities` parameter is optional;
  callers that don't pass it get current behaviour. Existing tests are unaffected.
- **No migration needed.** Shadow state format is unchanged; only the seeding logic changes.
