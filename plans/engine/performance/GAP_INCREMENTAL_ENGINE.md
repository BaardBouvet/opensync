# GAP: Incremental Engine Architecture

**Status:** reference  
**Date:** 2026-04-07  
**Type:** gap analysis  
**Scope:** `packages/engine/src/engine.ts` — ingest loop execution model  
**Related:** `performance/GAP_ENGINE_SCALING.md`, `performance/PLAN_SHARED_WATERMARK.md`  

---

## Core question

The engine already thinks incrementally about *data* (watermarks mean "ask the API from
here"), but does it think incrementally about *processing*? If the answer is "no — processing
is still batch-at-a-time", then watermarks exist only at the edges of the pipeline, not
inside it. This document maps the pipeline stages, identifies where state is already tracked
incrementally, and identifies the gaps where batch-at-a-time processing remains.

---

## The pipeline model

Every ingest run is a seven-stage pipeline. Each stage transforms its input and produces
durable state that the next stage depends on.

```
Stage 1: READ
  Connector API  ──[read cursor]──►  ReadRecord stream

Stage 2: INBOUND MAPPING + IDENTITY
  ReadRecord  →  canonical form  →  canonical_id
  Durable state: identity_map, shadow_state (source row)

Stage 3: DIFF
  canonical form vs source shadow_state  →  DiffResult (insert/update/skip)

Stage 4: CONFLICT RESOLUTION
  DiffResult vs each target's shadow_state  →  resolved delta per target

Stage 5: OUTBOUND MAPPING
  resolved delta  →  target-local field values (localData)

Stage 6: WRITE
  localData  →  connector.insert() / connector.update()

Stage 7: COMMIT
  Write source shadow_state + all target shadow_states +
  identity links + written_state + watermark advance
```

Each `──[cursor]──►` is a natural watermark boundary. Right now only Stage 1 has an
explicit, persisted cursor. The others are either implicit (encoded in state tables) or
absent entirely.

---

## What the current architecture actually does

```typescript
// packages/engine/src/engine.ts — ingest(), lines ~349–365
const allRecords: ReadRecord[] = [];
let newWatermark: string | undefined;

for await (const batch of sourceRead(source.ctx, since)) {
  allRecords.push(...batch.records);   // ← accumulate ALL batches first
  if (batch.since) newWatermark = batch.since;
}

const results = await this._processRecords(   // ← then process the entire set
  channelId, sourceMember, allRecords, batchId, ingestTs,
);

// ... deferred association retry ...

if (newWatermark) dbSetWatermark(this.db, connectorId, entity, newWatermark);  // ← advance once, at end
```

The execution model is **accumulate-then-process**: all records from all batches land in
`allRecords[]` before any record touches Stages 2–7. The watermark advances once at the
very end, after all processing and all writes are committed.

This is a "wide transaction" model. The unit of atomicity is the entire ingest run, not the
individual record or even the individual `ReadBatch`.

---

## Mapping state tables to pipeline stages

Every stage's progress is either already recorded in a durable table or is implicitly
derivable from one. The table below maps them:

| Stage | Progress recorded in | Format | Who sets it |
|-------|---------------------|--------|-------------|
| 1 — Read | `watermarks(connector_id, entity_name)` | Connector-owned opaque cursor | Connector via `batch.since`; engine stores |
| 2 — Identity | `identity_map(canonical_id, connector_id, external_id)` | Row presence | Engine after identity resolution |
| 3 — Diff | `shadow_state(connector_id, entity_name, external_id)` | Row presence + `updated_at` | Engine after diff commit |
| 4–5 — Resolved delta | *(no cursor)* — conflict resolution is stateless | n/a | n/a (pure function, no durable output) |
| 6 — Write | `written_state(connector_id, entity_name, canonical_id)` | Last-written field values | Engine after successful write |
| 7 — Commit | `watermarks` advance (Stage 1 cursor) + `shadow_state.updated_at` | ISO timestamp | Engine at end of batch |

Stages 2–3 and Stage 6 already have the right tables. The **missing cursor** is between
Stage 1 and Stage 6: there is no record of "how far has the fan-out for a specific target
processed?" That is the `fanout_watermarks` proposal in `PLAN_SHARED_WATERMARK.md §
Extension`.

Stage 4–5 (conflict resolution + outbound mapping) are pure functions — no state, nothing
to resume. They are by definition incremental: re-running them on the same input always
produces the same output.

---

## The gap: batch accumulation breaks per-record incrementality

### GAP-I1: The `allRecords` buffer (re-states GAP-S1 from a different angle)

`GAP_ENGINE_SCALING.md §S1` identifies the in-memory accumulation as a memory problem.
Here the concern is about *incrementality*, not just memory.

Because all records are accumulated before any are processed, a crash at record N causes
the next run to re-read from the last committed watermark — which is the watermark *before*
this entire run began. All N records need to be re-fetched from the connector, re-diffed
against shadow state, and individually suppressed by echo detection. Shadow comparison
makes this *safe* (no duplicate writes), but it is not *incremental*: the engine re-does
work proportional to the entire un-checkpointed batch, not just the uncommitted tail.

**Root cause:** the watermark advances only after `_processRecords` completes and all writes
are committed. There is no intermediate checkpoint.

### GAP-I2: The ReadBatch boundary is the natural incremental unit

The connector's `AsyncIterable<ReadBatch>` already partitions its output into batches, each
with its own `batch.since` cursor. This is the granularity at which the connector can
resume: "give me everything after this `since`". The engine currently ignores this
intermediate structure by flattening all batches into one array.

The incremental fix for GAP-I1 does not require per-record commits — it requires
**per-ReadBatch commits**. After each `ReadBatch` (not each record, not each all-batches):

1. Process all records in the batch through Stages 2–7
2. Commit all their shadow writes and fan-out writes atomically
3. Advance the watermark to `batch.since` in the same transaction

This preserves the existing atomicity contract (watermark never ahead of its shadow) while
reducing the re-work window from "entire run" to "one connector batch".

### GAP-I3: No positional fan-out cursor — resolved by `written_state` data comparison + per-ReadBatch commit

After examining what a fan-out watermark value would actually hold (see
`PLAN_SHARED_WATERMARK.md § Extension`), the idea has two problems:

**`written_state` is not a watermark.** It is per-record state: it stores the field VALUES
last written to a target per canonical record. This is different from a positional cursor.
Row presence only tells you "was this record ever written to B?". For future changes to the
same record, it is the DATA comparison that matters: `localData ≠ written_state.data` →
dispatch proceeds. Row presence alone does not "watermark" future changes.

**No viable positional cursor value exists today.** `shadow_state.updated_at` and
`written_state.written_at` use SQLite `strftime('now')` — multiple rows within one
transaction share the same millisecond timestamp and cannot be used as a reliable range
boundary. The engine's `batch_id` is an unordered UUID. A monotonic integer sequence
doesn't exist.

**What is needed instead** is two mechanisms working together:

| Mechanism | What it provides |
|-----------|-----------------|
| Per-ReadBatch commit (Step A) | Source watermark advances per batch; committed records never re-enter the pipeline on restart |
| `written_state` data comparison | For records that DO re-enter (partial-batch crash), suppresses dispatches where the target already holds the same values |

The combination eliminates all restart-redundancy without a new table:
- Records from committed batches: filtered out by the source connector's watermark
- Records from the crashed batch where the write reached the target: `localData == written_state.data` → skipped
- Records from the crashed batch where the write did not reach the target: `localData ≠ written_state.data` → correctly dispatched

`written_state` is therefore not a positional watermark and should not be described as one.
It is a per-record "last known dispatch state" that enables correct dispatch decisions for
both normal processing and crash recovery.

### GAP-I4: Deferred association retry is an unconditional full scan

```typescript
// packages/engine/src/engine.ts — after _processRecords
const deferred = dbGetDeferred(this.db, connectorId, sourceMember.entity);
if (deferred.length > 0) {
  // ... lookup() and retry each deferred record
}
```

`dbGetDeferred` returns all deferred rows for `(connector_id, entity)` — every ingest run,
regardless of whether any new identity links were established in this run. The set of
deferred records grows until the link is resolved, but the retry scan happens on every tick.
There is no cursor on the deferred queue itself.

An incremental fix: only retry deferred records whose `target_canonical_id` was written to
`identity_map` in *this* ingest run (i.e. was first linked in this batch). New links can be
tracked as an in-memory set during `_processRecords` and used to filter `dbGetDeferred`
rather than scanning all deferred rows unconditionally.

---

## What full incrementality would look like

A truly incremental engine processes each `ReadBatch` as a self-contained unit:

```
for await (const batch of sourceRead(ctx, since)) {
  // Process this batch through Stages 2–7
  const batchResults = await _processBatch(channelId, sourceMember, batch.records, ...);

  // Atomic commit: source shadow + target shadows + identity links + written_state
  db.transaction(() => {
    commitBatchWrites(batchResults);
    if (batch.since) dbSetWatermark(db, connectorId, entity, batch.since);
    // optionally: advance fanout_watermarks per target
  })();

  yield batchResults;  // surface events as they complete
}
```

Key properties of this model:

| Property | Current model | Incremental model |
|----------|--------------|-------------------|
| Crash recovery granularity | Re-read entire run from last watermark | Re-read from last committed ReadBatch |
| Memory footprint | All records in one array | One ReadBatch at a time |
| Watermark advance | Once, at end of run | Once per ReadBatch |
| Events surfaced | After entire run | After each ReadBatch |
| Correctness on restart | Shadow comparison (safe always) | Same + reduced re-work |
| API quota on restart | Re-fetches uncommitted batch | Re-fetches only tail of last ReadBatch |

---

## How the state tables compose into a resumability protocol

The tables together form a complete resumability protocol. At any crash point, the next
run can determine exactly what happened:

```
1. Read watermarks[(A, contacts)]                → "read up to T₁, start from here"
2. For each canonical_id in identity_map          → "these records have been identity-resolved"
3. For each row in shadow_state[(A, contacts)]    → "these source records have been diffed"
4. For each row in written_state[(B, contacts)]   → "these canonical records were last written to B as these values"
```

All four steps are already implemented. The combination of the source watermark (step 1) and
`written_state` (step 4) is sufficient for correct and efficient restart recovery:

- Source watermark prevents re-reading records from committed batches (in the per-ReadBatch
  commit model).
- `written_state` row presence suppresses redundant target writes for any record that
  re-enters the pipeline (e.g. from a partial batch crash).

A fifth step — a fan-out cursor per `(source, entity, target)` — was originally proposed
but is not needed. See GAP-I3 analysis above.

---

## Relationship to other plans

| Plan | Relationship |
|------|-------------|
| `GAP_ENGINE_SCALING.md §S1` | GAP-I1 is the same gap seen from incrementality rather than memory |
| `GAP_ENGINE_SCALING.md §S4` | GAP-I2 resolves S4: per-ReadBatch commit = intra-run checkpointing |
| `PLAN_SHARED_WATERMARK.md` | Shadow-derived read cursor is the Stage 1 fallback; fan-out watermarks extension is the Stage 6 cursor described as GAP-I3 |
| `PLAN_WRITTEN_STATE.md` | `written_state` is Stage 6 state; already implemented; provides per-field noop; `fanout_watermarks` adds per-record skip |

---

## Recommended sequencing

These changes are independent and can be delivered separately:

### Step A — Per-ReadBatch commit (resolves GAP-I1 + GAP-I2)

Modify `ingest()` to process and commit each `ReadBatch` inline rather than accumulating all
batches first. Advance the watermark to `batch.since` inside the commit transaction for that
batch. `_processRecords` contract is unchanged; only the calling loop changes.

This is a **pure win with no correctness risk** — the existing shadow comparison already
makes restarts safe. Per-batch commit only reduces redundant work. It also unlocks event
streaming: `IngestResult.records` can be yielded progressively. Restart recovery after a
crash within one ReadBatch uses `written_state` row presence to suppress redundant target
writes for records that reached their targets before the crash.

Effort: **S** (loop change + watermark advance moved up + test for mid-batch crash recovery).

### Step B — Deferred retry scoped to new links (resolves GAP-I4)

Pass the set of `canonical_id` values that were newly linked in this batch into
`dbGetDeferred`. Only retry deferred rows whose `target_canonical_id` appears in that set.

Effort: **XS** (filter parameter on `dbGetDeferred` + corresponding test).
