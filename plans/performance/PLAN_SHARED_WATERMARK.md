# PLAN_SHARED_WATERMARK — Shadow-derived watermark for connector reads

**Status:** draft  
**Date:** 2026-04-07  
**Effort:** S  
**Domain:** engine  
**Scope:** `packages/engine/src/engine.ts`, `packages/engine/src/db/queries.ts`, `packages/sdk/src/`  
**Spec:** `specs/sync-engine.md` § Watermark, `specs/connector-sdk.md` § Watermark Tracking  
**Depends on:** nothing — uses existing shadow_state infrastructure  

---

## Problem

The engine tracks two parallel but disconnected records of what a connector holds:

| Store | Key | What it says |
|-------|-----|-------------|
| `watermarks` table | `(connector_id, entity_name)` | "Ask the API for records changed since this cursor" |
| `shadow_state` table | `(connector_id, entity_name, external_id)` | "Here is every record this connector holds, with timestamps" |

These two stores can diverge:

- **Watermark loss** — if the `watermarks` table is cleared (schema migration, manual reset,
  disaster recovery from backup) but `shadow_state` is intact, the engine passes
  `since = undefined` on the next poll for each affected entity. The connector returns its
  entire dataset. The engine diffs every record against shadow → zero changes → skips all.
  The full re-fetch was completely wasteful; the engine already knew the answer before the
  first record arrived.

- **`collectOnly` with no `batch.since`** — some connectors (snapshot APIs, CSV exports, or
  APIs without a change-log endpoint) do not return a `batch.since`. After `collectOnly`,
  `shadow_state` may have thousands of rows but `watermarks` has no entry. The next normal
  ingest triggers a redundant full sync. `PLAN_FULL_SYNC_SIGNAL.md` addresses the
  "complete" signal for onboarding but does not address this read-efficiency gap.

- **Post-fan-out echo reads** — after the engine writes N records to connector B (fan-out
  from A), B's shadow state is updated. B is ingested next tick and returns those N records
  back; echo detection suppresses them all. The API round-trip and deserialization were
  entirely avoidable.

In all three cases, the shadow state already contains the answer. It is the _de facto_
watermark for the engine's own knowledge. The `watermarks` table should be the primary
cursor, but when it is absent the shadow state is a valid and safe fallback.

---

## Insight: shadow state _is_ a watermark

`shadow_state.updated_at` records when the engine last successfully processed each record —
either by reading it from the connector or by writing it during fan-out. For any
`(connector_id, entity_name)` pair:

```
MAX(shadow_state.updated_at)  WHERE connector_id = C AND entity_name = E
```

…is the latest engine-side timestamp at which ANY record for that entity was touched. If a
connector uses ISO timestamps as its `since` cursor format, a read using
`since = (shadow_max_updated_at − slack)` is guaranteed to include any externally-modified
records: those would have API modification times newer than the engine's last processing time.

The slack (default: **0 s**, configurable) exists only to absorb clock drift between the
engine host and the API server's modification timestamps. The correct default is 0 because
the engine should read records whose API timestamp is strictly greater than the point at which
the engine last processed them; any records the API recorded as modified _before_ that point
were either already captured or were never going to change. A non-zero slack causes some
duplicate reads but prevents misses under clock skew. Callers with known clock skew between
their engine host and the API server should tune this value.

---

## Design

### 1. New `EntityDefinition` capability flag

```typescript
interface EntityDefinition {
  // ... existing fields ...

  /**
   * Format of the `since` watermark cursor this entity accepts.
   *
   * - `"opaque"` (default) — the cursor is fully connector-owned;
   *   the engine never inspects or synthesises it.
   * - `"iso-timestamp"` — the cursor is an ISO 8601 timestamp string.
   *   The engine may derive a synthetic `since` from shadow state when
   *   no watermark entry exists, using MAX(shadow_state.updated_at) minus
   *   the configured slack window.
   *
   * Connectors must only declare `"iso-timestamp"` if their `read()` semantics
   * genuinely filter by a comparable wall-clock timestamp. Connectors with
   * sequence-number or opaque-token cursors must leave this at the default.
   */
  sinceFormat?: "opaque" | "iso-timestamp";
}
```

### 2. Engine ingest step 2 — watermark resolution

Replace the current single-lookup with a two-stage resolution:

```
2. Resolve since for (connectorId, entity):
   a. Primary:  dbGetWatermark(connectorId, entity)
                → use stored cursor if present (no change from today)
   b. Fallback: IF no watermark AND entity.sinceFormat === "iso-timestamp"
                → query shadow_state for MAX(updated_at) WHERE
                  connector_id = connectorId AND entity_name = entity
                → if a row exists: since = iso(max_updated_at) − slack
                  log: "synthetic watermark from shadow state: <value>"
                → if no rows:       since = undefined  (full sync, first run)
   c. Default:  since = undefined  (existing behaviour for "opaque" or no shadow rows)
```

No change to step 5 (watermark advance from `batch.since`). The synthetic watermark is only
a read-side fallback; it is never written to the `watermarks` table directly. Once a real
`batch.since` is returned by the connector and stored, it takes over as the primary cursor.

### 3. Configuration (optional)

A global engine-level option:

```typescript
interface ResolvedConfig {
  // ... existing fields ...
  shadowWatermarkSlackMs?: number;   // default: 0
}
```

Callers with known clock skew between host and API may set this to a few seconds or minutes.
The default of 0 deliberately errs on the side of over-reading (benign echoes) rather than
under-reading (missed updates).

### 4. New DB query

Add to `packages/engine/src/db/queries.ts`:

```typescript
/** Return MAX(updated_at) from shadow_state for a given (connectorId, entity). */
export function dbGetShadowMaxUpdatedAt(
  db: Db,
  connectorId: string,
  entityName: string,
): string | undefined {
  const row = db
    .prepare<{ max_ts: string | null }>(
      `SELECT MAX(updated_at) AS max_ts
       FROM shadow_state
       WHERE connector_id = ? AND entity_name = ? AND deleted_at IS NULL`,
    )
    .get(connectorId, entityName);
  return row?.max_ts ?? undefined;
}
```

Uses the primary key prefix `(connector_id, entity_name)` — index coverage is excellent;
no additional index needed.

---

## Spec changes planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/sync-engine.md` | § Ingest Loop step 2 | Update pseudocode to show two-stage watermark resolution (primary `watermarks` table → shadow fallback for `iso-timestamp` entities) |
| `specs/sync-engine.md` | § Watermark atomicity | Add a paragraph: "Shadow-derived fallback since" — describes when and how the engine synthesises `since` from shadow state, the slack window semantics, and the safety guarantee |
| `specs/connector-sdk.md` | § Watermark Tracking | Document `sinceFormat` on `EntityDefinition`; contrast `"opaque"` (default) and `"iso-timestamp"`. Clarify when connectors should declare each. |
| `specs/connector-sdk.md` | § Entities (interface block) | Add `sinceFormat?: "opaque" \| "iso-timestamp"` to `EntityDefinition` block |

No schema changes to `specs/database.md` — `shadow_state.updated_at` already exists.

---

## Safety properties

| Concern | Verdict |
|---------|---------|
| Can this cause missed updates? | No — the synthetic `since` is at or before the engine last-processed time; externally-modified records will have API timestamps ≥ that point. Slack can be tuned upward if clock skew is observed. |
| Can this cause duplicate writes? | No — not for updates. Echo detection and noop suppression still run. Over-reading at most produces additional no-op diffs (benign, O(delta)). |
| Does this change watermark atomicity? | No — the synthetic `since` is read-time only; it is never committed to `watermarks`. The existing atomicity guarantee is unaffected. |
| What if shadow_state.updated_at drifts from the API's timestamps? | The slack covers this. If in doubt, set `shadowWatermarkSlackMs` to a conservatively large value; the cost is a slightly wider incremental read window. |
| Applies to opaque watermark connectors? | No — only `sinceFormat: "iso-timestamp"` entities participate. Default is `"opaque"`, preserving existing behaviour for all current connectors. |

---

## What this is NOT

- **Not a replacement for `batch.since`** — connector-owned cursors remain the primary
  mechanism whenever they exist.
- **Not a solution to GAP-S4** (no intra-run checkpointing — see `GAP_ENGINE_SCALING.md §S4`).
  That gap is about mid-run crash recovery; this plan addresses the no-watermark
  (inter-run) case only.
- **Not write-side watermark injection** — the engine does not set B's watermark after
  writing to B via fan-out. That would require knowing B's cursor format and would risk
  missing externally-modified records that happened to share a timestamp window with the
  fan-out. This stricter form is deferred.

---

## Example: watermark recovery after migration

```
Before:
  watermarks  → (empty — table was cleared during migration)
  shadow_state → 12 000 rows for (crm, contacts) with max updated_at = 2026-03-01T12:00:00Z

Ingest step 2 without this plan:
  since = undefined  →  CRM API returns 12 000 records
  engine diffs all 12 000 → skip (no changes)
  12 000 API records downloaded and discarded

Ingest step 2 WITH this plan (CRM entity declares sinceFormat: "iso-timestamp"):
  since = "2026-03-01T12:00:00Z"  →  CRM API returns 0 records (nothing changed)
  ingest completes in milliseconds
```

---

## Implementation phases

### Phase 1 — SDK type (XS)
- Add `sinceFormat?: "opaque" | "iso-timestamp"` to `EntityDefinition` in
  `packages/sdk/src/types.ts`
- Spec: update `specs/connector-sdk.md`

### Phase 2 — Engine fallback logic (S)
- Add `dbGetShadowMaxUpdatedAt` to `packages/engine/src/db/queries.ts`
- Update ingest step 2 in `packages/engine/src/engine.ts` to use two-stage resolution
- Add `shadowWatermarkSlackMs` to `ResolvedConfig` (default 0)
- Spec: update `specs/sync-engine.md` § Ingest Loop step 2 and § Watermark atomicity

### Phase 3 — Tests (S)
- `engine.test.ts`: synthetic watermark is used when watermarks table is empty but shadow
  has rows, for an entity with `sinceFormat: "iso-timestamp"`
- `engine.test.ts`: synthetic watermark is NOT used for an entity with `sinceFormat: "opaque"`
  or default — falls through to full sync
- `engine.test.ts`: `shadowWatermarkSlackMs` subtracts the configured gap from shadow max
- `engine.test.ts`: once a real `batch.since` is stored, that cursor takes over on the next
  ingest (synthetic path is not hit a second time)

---

## Extension: per-target fan-out watermarks

> **Status:** design notes — not part of the implementation phases above. Captured here
> because it is the write-side complement of the read-side shadow derivation above.

### Two watermark questions

| Question | Current answer | Proposed addition |
|----------|---------------|-------------------|
| "How far have we read from source A?" | `watermarks(connector_id, entity_name)` — connector-owned opaque cursor | no change |
| "How far has mapping A→B fully processed?" | **nothing** — restart re-diffs everything from `watermarks` cursor | `fanout_watermarks(source_connector_id, entity_name, target_connector_id)` |

The read cursor says "ask the API from here". The fan-out watermark says "records whose
engine-side processing timestamp is ≤ T have already been committed to target B; skip them
on restart".

### Problem the second watermark solves

Today, if the engine reads 40 K records from CRM, fans 30 K out to ERP (committing each to
`shadow_state`), then crashes, the next ingest re-reads from CRM's cursor and diffs all
records that were already processed against shadow → all produce no-ops and are suppressed by
echo detection / noop suppression. Safe, but wasteful: 30 K records re-read from the API,
re-deserialized, re-diffed, and individually suppressed.

When source A feeds two targets B and C:
- B processed 30 K records before crash
- C processed 10 K records before crash

Today there is no way to skip the already-processed portion for B independently of C.
Everything re-runs from the shared read cursor.

A `fanout_watermarks` row per `(source, entity, target)` lets the engine skip the fan-out
leg for records already committed to that specific target.

### Proposed schema

```sql
CREATE TABLE fanout_watermarks (
  source_connector_id  TEXT NOT NULL,
  entity_name          TEXT NOT NULL,
  target_connector_id  TEXT NOT NULL,
  since                TEXT NOT NULL,    -- ISO 8601; engine-owned, not connector-owned
  PRIMARY KEY (source_connector_id, entity_name, target_connector_id)
);
```

Key is `(source, entity, target)`. The `since` value is the engine's own ISO timestamp —
specifically the `shadow_state.updated_at` of the last source record that was fully committed
to this target. Unlike `watermarks`, this is always ISO 8601 (the engine sets it from
`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`) and is independent of the connector's cursor format.

### Engine integration point

In the fan-out loop (ingest step 4f), before dispatching to target B:

```
1. Load fanout_watermarks[(source, entity, B)]  → T_fanout
2. Load source shadow row for this record       → shadow.updated_at

if shadow.updated_at <= T_fanout:
  skip dispatch to B entirely (already committed in an earlier run)
else:
  proceed with existing noop-suppression → dispatch → shadow write
  (after atomic commit, advance fanout_watermarks row to shadow.updated_at)
```

The advance must be atomic with the target shadow write — same transaction — otherwise a
crash between the write and the watermark advance causes the next run to re-process (safe
due to noop suppression, same as today).

### Subtlety: the low-water-mark problem

Records within a batch are not guaranteed to arrive in strict `shadow.updated_at` order. The
engine writes them in processing order and each gets `strftime('now')` — within a single
batch they may get near-identical timestamps. The fan-out watermark for a batch can only
safely advance to `MAX(shadow.updated_at)` of **all** records that were successfully
committed to that target in that batch. Any record whose `shadow.updated_at` falls inside a
gap (failed mid-batch) must cause the watermark to stop advancing.

Simplest safe implementation: **advance per completed batch, not per record**. At the end
of a successful ingest batch committed to target B, set:

```
fanout_watermarks[(source, entity, B)] = batch_commit_time
                                       = MAX(shadow.updated_at committed in this batch)
```

On restart, all records with `shadow.updated_at > batch_commit_time` are candidates for
re-dispatch; noop suppression handles any that were actually written. This is conservative
(may re-process some records already sent in the crashed batch) but correct and simple.

### Interaction with the shadow-derived read cursor (this plan, Phase 2)

If `fanout_watermarks` exists for all targets of a source, the minimum of all fan-out
watermarks is a safe upper-bound hint for the read cursor:

```
synthetic_since = MIN(fanout_watermarks[(A, entity, B)], fanout_watermarks[(A, entity, C)]) − slack
```

This is strictly tighter than the `MAX(shadow.updated_at)` used in Phase 2, because it
reflects not just "what was read" but "what was fully dispatched". Phase 2 can incorporate
this as a third fallback tier:

```
Watermark resolution for (A, entity):
  1. watermarks[A, entity]                    → connector-owned cursor (always preferred)
  2. MIN(fanout_watermarks[(A, entity, *)])   → fully-dispatched frontier (iso-timestamp only)
  3. MAX(shadow_state.updated_at[A, entity])  → read-only shadow frontier (iso-timestamp only)
  4. undefined                                → full sync
```

### When to implement

After Phase 3 of this plan is complete and validated. The fan-out watermark does not change
correctness — noop suppression remains the safety net. It is a throughput optimisation for
connectors with expensive reads or large steady-state deltas. Track as a separate plan once
Phase 3 shakes out the schema conventions.
