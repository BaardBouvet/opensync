# Engine: First-class SyncEvent Emission

**Status:** draft  
**Date:** 2026-04-06  
**Domain:** Engine API, Observability  
**Scope:** `packages/engine/src/`, `packages/sdk/src/`, `demo/demo-browser/src/`, `demo/run.ts`  
**Depends on:** `plans/engine/PLAN_ENGINE_USABILITY.md` (§ 2 — Silent Onboarding Events)  

---

## § 1 Problem Statement

Every client of the engine (browser playground, CLI runner, future server daemon) wants to
observe the same logical events:

- **READ** — a record was read from a source connector; here is what changed compared to the
  engine's last known state for that record (the shadow state diff)
- **INSERT** — a record was written to a target connector for the first time
- **UPDATE** — a record was written to a target connector with a set of field changes

Today none of these events carry payload data from the engine itself.  `IngestResult.records`
is a list of `RecordSyncResult` objects that contain only IDs and an action string.  Callers
have no canonical way to derive:

- What fields were in the source record that caused the READ to be non-skip
- What fields the engine actually wrote to the target (the resolved canonical data)
- What the target's state was before the write

As a result, each client has built its own fragile workaround:

| Client | Workaround |
|--------|-----------|
| Browser playground | `ActivityLogEntry` array on `InMemoryConnector`; `captureSourceShadow()` queries `shadow_state` before each ingest; `emitEvents()` correlates the two after the fact |
| CLI runner (`demo/run.ts`) | Prints only IDs — no field data at all |

The workaround in the browser playground is brittle because:

1. `captureSourceShadow()` must run *before* `engine.ingest()` — a timing dependency that is easy to miss or break.  There is no engine API that signals "I am about to ingest; capture shadows now."
2. `ActivityLogEntry` correlation depends on matching `(entity, id, op)` after the fact,
   which breaks if the same record is written twice in one poll cycle.
3. `emitEvents()` re-derives source connector info from channel config that the engine
   already resolved internally.
4. The code is ~120 lines of non-trivial glue that every future client must replicate or
   copy.

---

## § 2 Proposed Solution

Move event construction into the engine.  The engine already has all the information needed
at the exact moment each event occurs:

- At the end of the read phase for each record, it knows: source connector, entity, record ID,
  current record data, and the shadow state that existed before this ingest started.
- At write time, it knows: target connector, entity, target ID, `before` (target shadow before
  write), `after` (the resolved canonical data written).

The change is: extend `RecordSyncResult` to carry field payloads, and rename/retire the
internal `captureSourceShadow` + `ActivityLogEntry` workarounds.

---

## § 3 Spec Changes Planned

The following spec files will be updated as part of implementing this plan:

| Spec file | Section(s) to add or modify |
|-----------|---------------------------|
| `specs/sync-engine.md` | Add §§ covering `RecordSyncResult` payload extension (`data`, `before`, `after`); update the Ingest Loop section to name the point at which field data is attached to results |
| `specs/observability.md` | Add a section on structured `SyncEvent` payloads — what each action type carries and why; cross-reference to `RecordSyncResult` |
| `specs/playground.md` | Update § 8.1, § 8.2, § 8.3 to remove references to `ActivityLogEntry` correlation and `captureSourceShadow`; simplify boot and poll descriptions |

No new spec files are needed.

---

## § 4 Design

### § 4.1 Extend `RecordSyncResult`

```typescript
export interface RecordSyncResult {
  entity: string;
  action: SyncAction;
  sourceId: string;
  targetConnectorId: string;
  targetId: string;
  error?: string;

  // ── New payload fields ───────────────────────────────────────────
  /**
   * READ: the source record's field values as read from the connector.
   * Populated for every non-skip result (one READ per unique sourceId per ingest pass).
   * Not populated for skip results.
   */
  sourceData?: Record<string, unknown>;

  /**
   * READ: the source record's field values as last seen by the engine
   * (from shadow_state at the start of this ingest pass), keyed by canonical
   * field name.  Undefined for records the engine has never seen before.
   * Present alongside `sourceData` so callers can compute the diff.
   */
  sourceShadow?: Record<string, unknown>;

  /**
   * INSERT / UPDATE: the resolved canonical field values that were sent
   * to the target connector.  Keyed by canonical field name (pre-outbound-mapping).
   */
  after?: Record<string, unknown>;

  /**
   * UPDATE: the target's previous field values from its shadow_state, keyed by
   * canonical field name.  Undefined for INSERT (no prior target state).
   */
  before?: Record<string, unknown>;
}
```

### § 4.2 Where the engine populates each field

| Field | Populated in | How |
|-------|-------------|-----|
| `sourceData` | `_processRecords()`, after stripping `_`-prefixed meta fields and applying inbound mapping | `canonical` (already computed) |
| `sourceShadow` | `_processRecords()`, immediately after reading `existingShadow` | Materialise FieldData → flat `Record<string, unknown>` by extracting `.val` from each entry; strip `__assoc__` |
| `after` | `_dispatchToTarget()`, return value | `resolvedCanonical` (already computed; same value stored in shadow) |
| `before` | `_processRecords()`, at the point `targetShadow` is looked up | Same materialise helper as `sourceShadow` |

The materialise helper:

```typescript
function fieldDataToRecord(fd: FieldData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fd)) {
    if (!k.startsWith("__")) out[k] = v.val;
  }
  return out;
}
```

This helper already exists implicitly in `captureSourceShadow()` in the browser playground;
it moves to the engine.

### § 4.3 One READ result per unique sourceId

Currently `_processRecords()` produces one `RecordSyncResult` per *dispatch* (one per
target connector per source record).  A record synced to two targets produces two results
with the same `sourceId` but different `targetConnectorId`.

READ metadata (`sourceData`, `sourceShadow`) is per-source-record, not per-dispatch.
Two approaches:

**Option A — Separate READ result** (preferred): Prepend one synthetic result with
`action: "read"`, `targetConnectorId: ""` (same connector), `sourceData`, `sourceShadow`
before the dispatch results for that sourceId.  Callers that only care about dispatches
filter on `r.action !== "read"`.

**Option B — Attach to first dispatch**: Populate `sourceData`/`sourceShadow` only on the
first dispatch result per sourceId.  Simpler but asymmetric — callers must handle
`sourceData` appearing on an INSERT result.

Option A is cleaner and matches the mental model ("the engine read this record, then wrote
to targets").  The `action: "read"` result type is additive — existing callers that switch
on `r.action` and default to nothing will silently skip it, which is backwards compatible.

### § 4.4 What callers do instead

**Browser playground `emitEvents()`:**

```typescript
function emitEvents(records: RecordSyncResult[], ch, sourceConnectorId, onEvent, phase?) {
  for (const r of records) {
    if (r.action === "read") {
      onEvent({ action: "READ", data: r.sourceData, before: r.sourceShadow, ... });
    } else if (r.action !== "skip") {
      onEvent({ action: r.action.toUpperCase(), before: r.before, after: r.after, ... });
    }
  }
}
```

`captureSourceShadow()` is deleted.  `ActivityLogEntry` / `getActivityLog()` are deleted
from `InMemoryConnector`.

**CLI runner (`demo/run.ts`):**

```typescript
for (const r of result.records) {
  if (r.action === "skip" || r.action === "read") continue;
  const changedKeys = r.before && r.after
    ? Object.keys(r.after).filter(k => JSON.stringify(r.before![k]) !== JSON.stringify(r.after[k]))
    : undefined;
  console.log(`[${ts()}] ${dir}  ${tag}  ${r.entity}  ${src}… → ${tgt}… ${changedKeys?.join(", ") ?? ""}`);
}
```

The CLI now gets field-change data without any extra wiring.

---

## § 5 Onboarding Events

`onboard()` currently returns only aggregate counters.  Its internal fanout inserts are
invisible to callers.  This is the "silent onboarding events" problem catalogued in
`PLAN_ENGINE_USABILITY.md § 2`.

As part of this plan, extend `OnboardResult` to include the fanout records:

```typescript
export interface OnboardResult {
  linked: number;
  shadowsSeeded: number;
  uniqueQueued: number;
  /** Individual fanout INSERT records produced during onboarding. */
  inserts: RecordSyncResult[];
}
```

Each `insert` entry in `OnboardResult.inserts` carries:
- `action: "insert"`
- `sourceId`: the external ID in the source connector (from `identity_map`)
- `targetConnectorId`: the target connector
- `targetId`: the new external ID assigned by the target connector
- `after`: the canonical data written (from the fanout write)

This eliminates the `transaction_log` back-query in the browser playground's boot sequence.

---

## § 6 Implementation Steps

1. **Add `SyncAction = "read"` variant** and `fieldDataToRecord` helper to
   `packages/engine/src/engine.ts`.

2. **Populate `sourceData` / `sourceShadow`** in `_processRecords()`: after stripping meta
   fields and applying inbound mapping, prepend one `{ action: "read", sourceData: canonical,
   sourceShadow: fieldDataToRecord(existingShadow) }` result per unique `record.id`.

3. **Populate `before` / `after`** in `_processRecords()` / `_dispatchToTarget()`: capture
   `targetShadow` as `before` and `resolvedCanonical` as `after` on each dispatch `Outcome`.

4. **Extend `OnboardResult.inserts`**: accumulate `RecordSyncResult` entries inside
   `onboard()` for each fanout write.

5. **Update `packages/engine/src/index.ts`** to export the updated types.

6. **Update browser playground**:
   - Simplify `emitEvents()` to consume `r.sourceData` / `r.sourceShadow` / `r.before` /
     `r.after` directly.
   - Delete `captureSourceShadow()`.
   - Delete `ActivityLogEntry`, `getActivityLog()`, `clearActivityLog()` from `inmemory.ts`.
   - Replace boot-tick INSERT back-query with `onboardResult.inserts`.

7. **Update CLI runner** (`demo/run.ts`): print changed field keys for UPDATE events.

8. **Update specs** per §3.

9. **Tests**: extend engine unit tests to assert `sourceData`, `sourceShadow`, `before`,
   `after` on result records; assert `OnboardResult.inserts` entries.

---

## § 7 What is NOT in scope

- No changes to the connector SDK (`packages/sdk/`) — connectors are not affected.
- No changes to the DB schema — all data already exists in-engine at write time.
- No streaming / subscription API — `RecordSyncResult` remains a synchronous return value.
- No payload size limits — the engine is in-process; payloads are not serialised over a
  network boundary in current use cases.

---

## § 8 Migration / Backwards Compatibility Note

Pre-release — no backwards compatibility constraints apply (per AGENTS.md).

The `action: "read"` type is additive; existing callers that don't handle it will silently
skip it (typical switch/filter patterns).  Fields `sourceData`, `sourceShadow`, `before`,
`after` are all optional — callers that don't use them are unaffected.

`OnboardResult.inserts` is a new required field.  Callers that destructure only `linked /
shadowsSeeded / uniqueQueued` are unaffected.

`ActivityLogEntry` and `captureSourceShadow()` live only in the browser playground; their
removal is purely internal to `demo/demo-browser/`.
