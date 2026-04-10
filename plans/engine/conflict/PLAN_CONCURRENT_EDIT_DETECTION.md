# PLAN: Concurrent Edit Detection

**Status:** backlog  
**Date:** 2026-04-10  
**Effort:** M  
**Domain:** Engine — change detection, observability, config  
**Scope:** `specs/field-mapping.md`, `specs/observability.md`, `packages/engine/src/engine.ts`, `packages/engine/src/core/diff.ts`, `packages/sdk/src/types.ts`  
**Depends on:** `PLAN_FIELD_TIMESTAMPS.md` (complete), `PLAN_WRITTEN_STATE.md` (complete)  

---

## § 1 Problem

A concurrent edit occurs when two sources both change the same field on the same canonical entity
between two sync cycles. The engine already stores per-field timestamps in `shadow_state` via the
always-on `computeFieldTimestamps` derivation — the data needed to detect this pattern is present.

What is missing is:

1. **A detection signal**: after resolution, the engine does not check whether multiple sources
   changed the same field concurrently (i.e. both diverged from their respective last-known
   baseline values for the same field).
2. **A notification path**: callers have no way to subscribe to concurrent-edit events or route
   them to a review workflow.
3. **A config key**: no per-channel or per-field declaration to opt into concurrent-edit detection
   (since the check is potentially expensive, defaulting to opt-out is correct).

Without this feature the engine's LWW / priority / expression resolution silently picks a winner.
That is appropriate for most fields, but some fields — particularly financial figures, status
transitions, or external IDs — should surface the conflict for human review.

---

## § 2 What "Concurrent Edit" Means Here

A concurrent edit on field `F` for canonical entity `E` is defined as:

> Two or more contributing sources both changed the value of `F` since the last sync cycle — meaning
> their current shadow baseline for `F` differs from the value they each contributed in the previous
> cycle.

More precisely: let `shadow[connectorId][field].value` be the last-known value stored in shadow
state for that source. If two (or more) sources provide a new value for `F` that differs from their
own stored shadow — **and** those new values differ from each other — that is a concurrent edit.

This is distinct from:
- **A normal update**: only one source changed `F`; the other sources' shadows still match.
- **A round-trip echo**: one source's new value equals another source's shadow (the change was
  already applied in the previous cycle and echoed).

---

## § 3 Proposed Design

### § 3.1 Config opt-in

Detection is disabled by default. Enable it at the channel level:

```yaml
channels:
  - id: contacts
    conflict:
      detect_concurrent_edits: true   # emit ConcurrentEditEvent when detected
```

Per-field granularity is handled by `fieldMasters` — if a field has a declared master, concurrent
detection for that field is automatically suppressed (the master always wins; no review needed).

`detect_concurrent_edits: true` applies to all fields without a declared master. Fields with
`group:` have group-level concurrent detection: if any field in the group is concurrently edited,
the whole group is flagged.

### § 3.2 Detection algorithm

After `resolveConflicts` returns but before writing `shadow_state` and dispatching updates,
the engine runs the concurrent-edit check for each field:

```
for each field F in the resolved canonical record:
  sources_that_changed = [
    connectorId
    for each source shadow in shadow_state for this entity
    if source shadow[F].value != incoming[connectorId][F].value
       AND incoming[connectorId][F] is present (source contributed F this cycle)
  ]
  if len(sources_that_changed) >= 2
     AND their incoming values for F differ from each other:
       emit ConcurrentEditEvent(canonicalId, field=F, sources=sources_that_changed, values={...})
```

The check runs only when `detect_concurrent_edits: true` is configured for the channel. It does
**not** block the resolution or the write — LWW / priority / expression still picks the canonical
winner. The event is a notification, not a veto.

### § 3.3 `ConcurrentEditEvent` type

A new event type added to the `SyncEvent` union and emitted via the existing `onRecordSynced`
callback (or a dedicated `onConcurrentEdit` subscriber — see §3.4):

```typescript
// packages/sdk/src/types.ts (or engine-local type)
interface ConcurrentEditEvent {
  type: "concurrent_edit";
  canonicalId: string;
  entityName: string;
  channelId: string;
  detectedAt: number;             // ingest timestamp
  conflicts: Array<{
    field: string;
    sources: Array<{
      connectorId: string;
      incoming: unknown;          // value this source contributed
      previousShadow: unknown;   // value stored in shadow before this cycle
    }>;
    resolvedValue: unknown;       // value the engine picked (resolution winner)
    resolvedBy: string;           // "priority" | "last_modified" | "expression" | "field_master"
  }>;
}
```

### § 3.4 Subscription API

Two emission paths:

1. **`onConcurrentEdit` callback** — a dedicated subscriber on `SyncEngine`, separate from
   `onRecordSynced`. Callers can register a handler that receives `ConcurrentEditEvent` objects
   and routes them to a review queue, webhook, or log:

   ```typescript
   engine.onConcurrentEdit((event) => {
     reviewQueue.enqueue(event);
   });
   ```

2. **`SyncEvent` union inclusion** — `ConcurrentEditEvent` is also included in the `SyncEvent`
   union so callers using the generic event stream receive it alongside the usual `record_synced`
   events.

### § 3.5 No blocking / veto

This plan does not introduce a mechanism for the review workflow to block or roll back the engine's
write. The engine always resolves and writes. The event is purely informational — a hook for
callers to implement their own review, alerting, or hold logic outside the critical sync path.

A future plan could introduce a `hold` mode where the engine parks the canonical entity in a
`pending_review` state pending confirmation, but that requires significant additional design
(ordering guarantees, re-trigger logic, UI contract) and is explicitly out of scope here.

### § 3.6 Interaction with `fieldMasters`

If `fieldMasters: { price: erp }` is declared for a field, the master connector always wins and
the non-master value is stripped before resolution. No concurrent-edit event is emitted for that
field — the master declaration is itself the conflict resolution policy, and emitting a spurious
event for it would be noise.

### § 3.7 Interaction with `group:`

When multiple fields share the same `group:` label, the group-level winner is chosen atomically. A
concurrent edit on any field in the group triggers one `ConcurrentEditEvent` for the whole group
(not one event per field) — `conflicts` contains entries for every concurrently-edited field in
the group.

---

## § 4 Out of Scope

- **Blocking concurrent writes** — the engine still resolves and writes; detection is advisory.
- **Per-field `detect_concurrent_edits`** — channel-level opt-in covers all unmastered fields;
  per-field granularity is handled by `fieldMasters` suppression.
- **Cross-cycle detection** — detection fires within the same ingest batch. Cross-cycle timing
  (editing window broader than one poll interval) is not addressed; this requires a time-windowed
  buffer which is a distinct design problem.

---

## § 5 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §7.3 Concurrent edit detection | Update status; add detection algorithm, config key, and `resolvedBy` semantics |
| `specs/observability.md` | Events | Add `ConcurrentEditEvent` type description |
| `specs/config.md` | Channel-level keys | Add `detect_concurrent_edits` under `conflict` block |

---

## § 6 Implementation Checklist

- [ ] Add `detect_concurrent_edits?: boolean` to the channel `ConflictConfig` Zod schema and TypeScript type in `packages/engine/src/config/schema.ts` / `loader.ts`
- [ ] Add `ConcurrentEditEvent` type to `packages/sdk/src/types.ts` (or engine-internal types if it never crosses the connector boundary — confirm)
- [ ] Add `onConcurrentEdit(handler)` subscriber method to `SyncEngine`; include `ConcurrentEditEvent` in the `SyncEvent` union
- [ ] In `_processRecords` (standard path), after `resolveConflicts`: if `channel.conflict.detectConcurrentEdits` is true, run the concurrent-edit check — compare each source's incoming value against its own stored shadow for each field; collect sources that changed; if ≥ 2 sources changed the same field with different values, emit `ConcurrentEditEvent`
- [ ] Suppress event for fields covered by `fieldMasters`; emit single group-level event for `group:` fields
- [ ] Add tests: single source changes field → no event; two sources change same field to same value → no event; two sources change same field to different values → event emitted with correct `conflicts` payload; `fieldMasters` field → no event even when two sources change it; `group:` field → single group event; `detect_concurrent_edits: false` (default) → never emits
- [ ] Update `specs/field-mapping.md §7.3` status
- [ ] Update `specs/observability.md`
- [ ] Update `specs/config.md` conflict block
- [ ] Update `plans/engine/GAP_OSI_PRIMITIVES.md` — concurrent detection entry from 🔶 to ✅
- [ ] Update `specs/field-mapping.md` coverage table — concurrent edit detection row from 🔶 to ✅
- [ ] Run `bun run tsc --noEmit`
- [ ] Run `bun test`
- [ ] Update `CHANGELOG.md` under `[Unreleased]`
