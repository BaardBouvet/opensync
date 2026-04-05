# PLAN: Noop Update Suppression

**Status:** draft  
**Domain:** packages/engine  
**Observed via:** `demo/data/associations-demo/**/*.log.json` audit entries showing
`{ "op": "update", "id": "...", "updated": N }` with no `before`/`after` diff — meaning
the value written to the connector was identical to what was already there.

---

## Summary

Two guards are proposed, each opt-in/out per channel in `opensync.json`:

| Guard | Config flag | Default | Direction | What it suppresses |
|-------|------------|---------|-----------|-------------------|
| Noop update suppression | `suppressNoopUpdates: true` | **off** | target-side | dispatch when resolved values match target shadow |
| Echo detection | `echoDetection: false` | **on** | source-side | fan-out when incoming record matches source shadow |

Echo detection is already implemented and on by default; this plan adds the ability to
disable it per channel. Noop update suppression is new and opt-in.

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

## 5. Per-channel opt-in/out

Both guards are controlled per channel via `ChannelConfig` in `opensync.json`.

### 5.1 Config shape

Add two optional boolean fields to `ChannelConfig` (`packages/engine/src/config/loader.ts`):

```ts
export interface ChannelConfig {
  id: string;
  members: ChannelMember[];
  identityFields?: string[];
  suppressNoopUpdates?: boolean;   // default false — opt-in; see §5.3
  echoDetection?: boolean;         // default true  — opt-out; see §5.4
}
```

In `opensync.json`:
```json
{
  "channels": [
    {
      "id": "contacts",
      "members": [...],
      "suppressNoopUpdates": true,
      "echoDetection": false
    }
  ]
}
```

### 5.2 Why flags on `ChannelConfig`, not `ChannelMember`

Both guards apply to the whole record-level flow through a channel, not to an individual
connector's mapping. Putting them on `ChannelConfig` keeps the config flat and avoids
having to repeat the same flag on every member.

### 5.3 `suppressNoopUpdates` — opt-in (default false)

Default is `false` because the bug is new (no production users rely on the current
noop behaviour), and enabling the guard introduces a risk (§6) that the user should
consciously accept. Channels that tolerate external writes to a target connector
should leave this `false`.

The guard in `_processRecords` is wrapped:

```ts
if (
  channel.suppressNoopUpdates &&
  targetShadow !== undefined &&
  this._resolvedMatchesTargetShadow(resolved, targetShadow, remap.length ? remap : undefined)
) {
  results.push({ …, action: "skip" });
  continue;
}
```

### 5.4 `echoDetection` — opt-out (default true)

Echo detection is already implemented (`_shadowMatchesIncoming`) and works well.
The only reason to disable it is when a connector has **external writers** that may
update records in-place — i.e. the source record could legitimately return the same
value twice in sequence, between which an external system already applied a change that
wasn't visible to OpenSync. Disabling means every inbound record always fans out,
regardless of whether the source shadow matches.

The existing guard becomes:

```ts
if (channel.echoDetection !== false && !isResurrection && existingShadow !== undefined) {
  const same = this._shadowMatchesIncoming(existingShadow, canonical, assocSentinel);
  if (same) { …skip… }
}
```

---

## 7. Implementation tasks

1. `packages/engine/src/config/loader.ts`: add `suppressNoopUpdates?: boolean` and
   `echoDetection?: boolean` to `ChannelConfig`.
2. `packages/engine/src/config/schema.ts` (or equivalent validation): accept the new
   keys on channel objects.
3. `packages/engine/src/engine.ts`:
   a. Add `_resolvedMatchesTargetShadow` private method.
   b. Wrap noop-suppression guard with `channel.suppressNoopUpdates`.
   c. Wrap echo-detection guard with `channel.echoDetection !== false`.
4. Tests (`packages/engine/src/engine.test.ts`):
   - `suppressNoopUpdates: true` — second poll of unchanged record → `"skip"`.
   - `suppressNoopUpdates: true` — poll after real change → `"update"`.
   - `suppressNoopUpdates: true` — second poll of same association → `"skip"`.
   - `suppressNoopUpdates: false` (default) — second poll → `"update"` (noop not suppressed).
   - `echoDetection: false` — incoming record matching source shadow still fans out.

---

## 6. Risks

### 6.1 False suppression (`suppressNoopUpdates`)

If `targetShadow` is stale — e.g. someone directly wrote to the target connector outside
OpenSync — the guard would see "already matches" and skip a write that should have healed
the drift. The shadow is the only source of truth OpenSync has about what it last wrote;
it has no way to distinguish "same as shadow" from "actually current on the target".

**Mitigation options (not in scope for this plan):**
- Plumb the live ETag / live-snapshot from `_dispatchToTarget` into this check.
- Add a periodic "reconcile" mode that reads the target and compares.

Users with connectors that may be written by external systems should leave
`suppressNoopUpdates: false` (the default).

### 6.2 False positive echo suppression (`echoDetection: true`, the default)

Same structural risk as §6.1 but on the source side: if the source shadow is stale, the
engine skips fan-out for a record that actually changed. In practice this risk is lower
because the source shadow is updated every time the engine successfully processes a
record — there is no path where it can drift unless the database is externally modified.

The risk of disabling echo detection (`echoDetection: false`) is the opposite: every
source record fans out unconditionally, generating more writes and, paradoxically,
more noop log entries if `suppressNoopUpdates` is also `false`.

### 6.3 LWW semantics unchanged

Neither guard changes *when* a field value is accepted during conflict resolution — only
whether the accepted payload is dispatched. Conflict metadata in the shadow is unaffected.
