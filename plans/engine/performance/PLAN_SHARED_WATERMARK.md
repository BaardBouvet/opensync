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

> **Status:** design notes — not part of the implementation phases above.

### Two watermark questions

| Question | Current answer | Proposed addition |
|----------|---------------|-------------------|
| "How far have we read from source A?" | `watermarks(connector_id, entity_name)` — connector-owned opaque cursor | no change |
| "How far along the source change stream has mapping A→B been committed?" | **nothing** | see analysis below |

### What does "fan-out watermark" mean, precisely?

A watermark is a **positional cursor**: "everything before position T in the stream has been
committed to target B; skip it." It operates on the *ordering* of records in the change
stream, not on the values of individual records.

`written_state` is NOT a watermark by this definition. It is **per-record state**: it records
what values were last written to a target connector for a specific canonical record.
Two things it does:

1. **Data comparison** — for an incoming change to record X, compare `localData` against
   `written_state.data` for `(B, entity, X.canonicalId)`. If they match, the target already
   has these exact values; skip dispatch. If they differ, dispatch.

2. **First-time insert signal** — no row → B has never received this record; always insert.

Critically: `written_state` correctness for **future changes** does not depend on row
presence. When record X changes from V1 to V2, `localData = V2` and `written_state.data = V1`
don't match → dispatch proceeds correctly. Row presence only matters for the first write.

### Why this is not the same as a positional watermark

A positional fan-out watermark would let the engine say: "records 1–30,000 in this batch
are all committed to B; skip them entirely without even looking them up." This is a range
skip — O(1) cost for the committed prefix of any restart batch.

`written_state` can't do this. It requires a per-record lookup: for each record that comes
back on restart, check if `localData` matches `written_state.data`. That is O(delta) lookups
each O(1), not a single range skip.

Whether the O(delta) per-record cost matters depends entirely on how records re-enter the
pipeline after a crash:

- **With per-ReadBatch commit (Step A from GAP_INCREMENTAL_ENGINE.md)**: the source
  watermark advances to `batch.since` after each committed ReadBatch. On restart, the
  source connector returns only records from the uncommitted tail (at most one batch). The
  committed prefix never re-enters — `written_state` for those records is never consulted.

- **Without per-ReadBatch commit (current model)**: the source watermark advances only at
  end of run. A crash forces re-reading the entire uncommitted run from the last stored
  watermark. For each of those records, `written_state` data comparison eliminates
  redundant dispatches — but the API round-trip to the source still happened, and the
  per-record lookup cost is O(all records in the run).

So `written_state` data comparison is **correct** in both models, but **efficient** only
when combined with per-ReadBatch commit (which shrinks the restart window to one batch).

### What value would a true positional fan-out watermark hold?

For completeness — the candidates available to the engine:

**Option 1 — Connector-owned `batch.since` cursor**  
Opaque. The engine can store it but cannot use it as a per-record comparator. Knowing
"A→B committed up to cursor T" is useless without a way to ask "is record R before T?" —
which the SDK contract doesn't provide.

**Option 2 — Engine-set ISO timestamp (`shadow_state.updated_at`)**  
`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` is SQLite-level and millisecond-precision. Within
one transaction, multiple rows may share the same timestamp. You cannot reliably use
`updated_at < T` as a range boundary — records at exactly `T` are ambiguously inside or
outside the range.

**Option 3 — Monotonic integer sequence**  
Would work cleanly: "all records with sequence ≤ N are committed to B". But the engine has
no such counter today (`batch_id` is an unordered UUID). Adding one requires a schema change.

### Recommendation

`fanout_watermarks` is not worth implementing now. The combination of:
1. **Per-ReadBatch commit** (Step A) — shrinks the restart window to one batch's worth of records
2. **`written_state` data comparison** — suppresses redundant dispatches for the few
   records that DO come back after a partial-batch crash

...covers all correctness and efficiency cases without a new table or the O(1) range-skip
that a positional watermark would provide.

If a monotonic batch sequence is introduced in the future, a `fanout_watermarks` table keyed
on sequence becomes viable and would eliminate the per-record `written_state` lookup on
restart entirely. Defer until then.

The watermark resolution tiers for Phase 2 above remain two-tier (no fan-out watermarks
needed as a fallback):

```
Watermark resolution for (A, entity):
  1. watermarks[A, entity]                    → connector-owned cursor (always preferred)
  2. MAX(shadow_state.updated_at[A, entity])  → shadow frontier fallback (iso-timestamp only)
  3. undefined                                → full sync
```
