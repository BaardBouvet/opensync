# PLAN: Noop Update Suppression

**Status:** complete  
**Date:** 2026-04-05  
**Domain:** packages/engine  

**Observed via:** `demo/data/associations-demo/**/*.log.json` audit entries showing
`{ "op": "update", "id": "...", "updated": N }` with no `before`/`after` diff — meaning
the value written to the connector was identical to what was already there.

Related:
- `PLAN_SUPPRESS_NOOP_UPDATES_SWITCH.md` — per-channel opt-out for this guard (future)
- `PLAN_ECHO_DETECTION_SWITCH.md` — per-channel opt-out for echo detection (future)

---

## 1. Root cause

`_processRecords` dispatches a write to a target connector whenever `resolveConflicts`
returns a non-empty object.  `resolveConflicts` uses last-write-wins (LWW) with the
check `incomingTs >= existing.ts`, where `incomingTs` is `Date.now()` at the start of
each ingest cycle.  Because wall-clock time always advances, *every* field satisfies
the LWW condition on every poll — even when the field's value has not changed.

The result: on every incremental sync cycle, if a record is returned by the source
connector (because it is newer than `since`), the engine dispatches an update to every
target connector with the same content the target already holds.

**Example trace** (from `employees.log.json`, associations-demo):
```
{ "op": "update", "id": "354ec3df…", "updated": 5 }   ← no before/after
```
`updated: 5` is a second poll of a record whose associations were already propagated at
`updated: 4`.  The engine re-read it, resolved the same associations through LWW, and
wrote an identical payload to the target.

---

## 2. Where to fix

`packages/engine/src/engine.ts`, `_processRecords`, after the `resolveConflicts` call:

```ts
const resolved = resolveConflicts(canonical, targetShadow, …);
if (!Object.keys(resolved).length) { … skip … }
```

A second guard is needed: if every key in `resolved` has a value that is **already**
stored in `targetShadow` with the same JSON representation, skip the dispatch.

The same logic already exists for the *source* record (echo detection via
`_shadowMatchesIncoming`).  This plan extends it to the *target* direction.

---

## 3. Proposed fix

### 3.1 New helper: `resolvedMatchesTargetShadow`

```ts
private _resolvedMatchesTargetShadow(
  resolved: Record<string, unknown>,
  targetShadow: FieldData,
  remappedAssoc: Association[] | undefined,
  assocSentinel: string | undefined,
): boolean {
  for (const [k, v] of Object.entries(resolved)) {
    const e = targetShadow[k];
    if (!e) return false;
    if (JSON.stringify(e.val) !== JSON.stringify(v)) return false;
  }
  // Association sentinel check (mirrors _shadowMatchesIncoming)
  if (remappedAssoc !== undefined) {
    const newSentinel = JSON.stringify(
      [...remappedAssoc].sort((a, b) => a.predicate.localeCompare(b.predicate))
    );
    const existingSentinel = targetShadow["__assoc__"]?.val;
    if (newSentinel !== existingSentinel) return false;
  }
  return true;
}
```

### 3.2 Guard in `_processRecords`

After the existing empty-resolved guard, add:

```ts
if (
  targetShadow !== undefined &&
  this._resolvedMatchesTargetShadow(resolved, targetShadow, remap.length ? remap : undefined, undefined)
) {
  results.push({ …, action: "skip" });
  continue;
}
```

This is placed *before* the `_dispatchToTarget` call and *after* the associations remap,
so the sentinel is computed from the already-remapped target associations.

### 3.3 Scope

- Only suppresses updates where a target shadow already exists (`targetShadow !== undefined`).
- Does not affect inserts (no existing shadow).
- Does not affect the source shadow echo-detection path.
- Does not require changes outside `engine.ts`.

---

## 4. Association-only updates

The existing demo shows a two-step pattern:

1. An update that adds an association (`before: {}`, `after: { associations: [...] }`) — **correct**.
2. On the next poll, another update with no diff — **noop caused by this bug**.

Step 2 happens because the remapped association is re-resolved through LWW and dispatched
again.  The fix in §3.2 suppresses step 2 because the target shadow already holds the
remapped association sentinel from step 1.

---

## 5. Implementation tasks

1. `packages/engine/src/engine.ts`: add `_resolvedMatchesTargetShadow` private method.
2. Add the guard in `_processRecords` immediately after the empty-resolved skip.
3. Tests (TDD — write failing tests first):
   - Second poll of unchanged record → action `"skip"` (not `"update"`).
   - Poll after a real field change → action `"update"` (guard does not suppress).
   - Second poll of unchanged association → action `"skip"`.
   - First propagation of a new association → action `"update"` (not suppressed).

---

## 6. Risk

The guard relies on the target shadow being accurate. If an external system writes to the
target connector outside OpenSync, the shadow becomes stale and the guard would suppress a
write that should heal the target. This risk is accepted for now — the guard is always on,
and a per-channel opt-out is tracked in `PLAN_SUPPRESS_NOOP_UPDATES_SWITCH.md` for when it
becomes necessary.
