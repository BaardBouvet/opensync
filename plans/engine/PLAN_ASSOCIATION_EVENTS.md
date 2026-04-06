# Engine: Association Visibility in RecordSyncResult Payloads

**Status:** complete  
**Date:** 2026-04-06  
**Effort:** S  
**Domain:** Engine API, Observability  
**Scope:** `packages/engine/src/engine.ts`, `specs/sync-engine.md`, `playground/src/ui/devtools.ts`  
**Depends on:** `plans/engine/PLAN_ENGINE_SYNC_EVENTS.md` (complete)  

---

## § 1 Problem Statement

`RecordSyncResult.before` and `after` carry only canonical *field* data — the output of
`fieldDataToRecord()`, which deliberately strips `__`-prefixed keys (including `__assoc__`).
Similarly `sourceData` and `sourceShadow` strip associations.

This means a genuine association-only change — a contact changes company, but no field
value changes — produces an event where `before == after` (field-for-field identical) and
`sourceData == sourceShadow`, with associations entirely absent from all four payloads.

**Concrete symptom:** the playground event log shows "(no field changes)" for a record where
the *only* thing that changed was which company the contact is linked to.

### Why it wasn't caught before

The spurious empty-UPDATE events eliminated by the step 1 / step 1b fixes were caused by
a missing `__assoc__` *sentinel* in the seeded shadow (echo detection failure).  Once that
is fixed, those events disappear.  But the underlying observability gap remains: if a user
*actually* changes a contact's company in one system, the resulting UPDATE event in the other
systems will show "(no field changes)" — which is misleading.

---

## § 2 Root Cause

Three places reconstruct a `Record<string, unknown>` from internal state and omit associations:

| Payload field      | Assembled from                          | Omits |
|--------------------|----------------------------------------|-------|
| `sourceData`       | incoming `ReadRecord.data` (no assoc field) | associations in `ReadRecord.associations[]` |
| `sourceShadow`     | `fieldDataToRecord(existingShadow)`    | `existingShadow["__assoc__"]?.val` |
| `before`           | `fieldDataToRecord(targetShadow)`      | `targetShadow["__assoc__"]?.val` |
| `after`            | `resolvedCanonical` (field map only)   | `associations` arg passed to `_dispatchToTarget` |

The raw material is present at each site — it just isn't threaded into the result.

---

## § 3 Proposed Fix

### § 3.1 Extend `RecordSyncResult` with four optional association arrays

```typescript
export interface RecordSyncResult {
  // …existing fields…

  /** READ: associations on the incoming source record (from ReadRecord.associations). */
  sourceAssociations?: Association[];
  /** READ: associations stored in the source shadow before this ingest pass
   *  (parsed from shadow["__assoc__"]?.val JSON string). */
  sourceShadowAssociations?: Association[];
  /** UPDATE: associations stored in the target shadow before the write
   *  (parsed from targetShadow["__assoc__"]?.val JSON string). */
  beforeAssociations?: Association[];
  /** INSERT/UPDATE: remapped associations written to the target connector. */
  afterAssociations?: Association[];
}
```

Parallel to `before`/`after`/`sourceData`/`sourceShadow` — not embedded inside them.
Embedding would pollute `Record<string, unknown>` with internal metadata and require
callers to strip it out.

Updated action-semantics table:

| action   | Populated payload fields |
|----------|--------------------------|
| `"read"` | `sourceData`, `sourceShadow?`, `sourceAssociations?`, `sourceShadowAssociations?` |
| `"insert"` | `after`, `afterAssociations?` |
| `"update"` | `before`, `beforeAssociations?`, `after`, `afterAssociations?` |
| `"skip"` | — |
| `"defer"` | — |
| `"error"` | `error` |

All four fields are optional and absent (not `[]`) when associations are not present.

### § 3.2 Helper: parse `__assoc__` back to `Association[]`

```typescript
function parseSentinelAssociations(fd: FieldData): Association[] | undefined {
  const raw = fd["__assoc__"]?.val;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as Association[];
    return parsed.length ? parsed : undefined;
  } catch {
    return undefined;
  }
}
```

The sentinel is a sorted JSON string (e.g. `[{"predicate":"companyId","targetEntity":"companies","targetId":"org1"}]`).
`JSON.parse` recovers the array; no additional transformation is needed.

### § 3.3 Populate at each assembly site

**Site A — READ result** (in `_processRecords`, ~line 1255–1264):
```typescript
// Before:
results.push({
  action: "read", …,
  sourceData: recordToCanonical,
  sourceShadow: existingShadow ? fieldDataToRecord(existingShadow) : undefined,
});

// After:
results.push({
  action: "read", …,
  sourceData: recordToCanonical,
  sourceShadow: existingShadow ? fieldDataToRecord(existingShadow) : undefined,
  sourceAssociations: record.associations?.length ? record.associations : undefined,
  sourceShadowAssociations: existingShadow ? parseSentinelAssociations(existingShadow) : undefined,
});
```

**Site B — dispatch outcome** (in `_processRecords`, ~line 1335–1338):
```typescript
// Before:
const beforeData = targetShadow ? fieldDataToRecord(targetShadow) : undefined;
{ …, before: beforeData, after: dispatchResult.after }

// After:
const beforeData = targetShadow ? fieldDataToRecord(targetShadow) : undefined;
const beforeAssoc = targetShadow ? parseSentinelAssociations(targetShadow) : undefined;
{ …, before: beforeData, beforeAssociations: beforeAssoc,
       after: dispatchResult.after, afterAssociations: dispatchResult.afterAssociations }
```

**Site C — `_dispatchToTarget` return value** (~line 1111 and 1198):
```typescript
// Extend the ok return type:
| { type: "ok"; …; after: Record<string, unknown>; afterAssociations?: Association[] }

// At the return site, the `associations` param is already in scope:
return { type: "ok", …, after: resolvedCanonical,
         afterAssociations: associations?.length ? associations : undefined };
```

### § 3.4 Playground rendering (`devtools.ts`)

The diff table for UPDATE events already handles `(no field changes)` when
`changed.length === 0`. Add a second diff check for associations:

```typescript
const assocBefore = ev.beforeAssociations ?? [];
const assocAfter  = ev.afterAssociations  ?? [];
const assocChanged = JSON.stringify(assocBefore) !== JSON.stringify(assocAfter);
```

If `assocChanged` and `changed.length === 0`, render "association change only" instead of
"(no field changes)" and show an association-diff row (predicate → before targetId /
after targetId).

For READ events, do the same comparison using `ev.sourceShadowAssociations` vs
`ev.sourceAssociations`.

---

## § 4 Spec Changes Planned

| Spec file | Section(s) to modify |
|-----------|----------------------|
| `specs/sync-engine.md` | `§ RecordSyncResult` — add four new optional fields; update `§ RecordSyncResult.action semantics` table |
| `specs/observability.md` | Mention that association changes are now visible in payloads |

No new spec files needed.

---

## § 5 Implementation Steps

1. Add `parseSentinelAssociations()` helper near `fieldDataToRecord` in `engine.ts`
2. Extend `RecordSyncResult` interface with four new optional fields
3. Extend `_dispatchToTarget` ok return type; populate `afterAssociations` at the return site
4. Populate `sourceAssociations` / `sourceShadowAssociations` in READ result assembly
5. Populate `beforeAssociations` / `afterAssociations` in dispatch outcome assembly
6. Update `specs/sync-engine.md` § RecordSyncResult and the action-semantics table
7. Update `playground/src/ui/devtools.ts` to render association diffs
8. Add a regression test (T44): contact changes company → UPDATE event carries non-equal
   `beforeAssociations` and `afterAssociations`; `before == after` (fields unchanged)

---

## § 6 Out of Scope

- Exposing associations in the CLI demo runner `demo/run.ts` — easy follow-up after § 5
- Cross-channel / non-local associations (`PLAN_NON_LOCAL_ASSOCIATIONS.md`) — separate concern
- Changing the `__assoc__` sentinel storage format — this plan only reads it, does not change it
