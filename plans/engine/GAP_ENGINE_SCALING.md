# GAP: Engine Scaling Behaviour as Data Grows

**Status:** reference  
**Date:** 2026-04-05  
**Type:** gap report  
**Scope:** `packages/engine/src/` — ingest loop, diff phase, write path, shadow state queries  

---

## Context

The connectors expose incremental reads via a `since` watermark.
This report answers whether the engine processes only the incoming delta on each tick,
or whether it also scans total data, and identifies the specific operations that scale with
dataset size rather than delta size.

---

## What Is Genuinely Incremental

### Watermark / cursor system

The engine stores a `since` watermark per `(connectorId, entity)` pair in the `watermarks`
table and passes it to `connector.read(ctx, since)` on every tick
(`packages/engine/src/engine.ts`, `packages/engine/src/db/queries.ts`).

When `since` is provided the connector returns only records changed since that point.
When `since` is `undefined` (first run, or `fullSync: true` forced by the caller) the
connector performs a full pull. The watermark is advanced only after a fully-successful
batch — there is no intra-run checkpointing (see GAP-S4 below).

### Diff phase — PK lookup per incoming record

For each record in the incoming delta, `_processRecords` issues one keyed lookup against
shadow state:

```sql
SELECT canonical_data, deleted_at
FROM shadow_state
WHERE connector_id = ? AND entity_name = ? AND external_id = ?
```

The table primary key is `(connector_id, entity_name, external_id)`.
This is O(1) per record, O(delta) for the batch. No full-table scan occurs during normal ingest.

Deletes must be signalled explicitly by the connector via `ReadRecord.deleted = true`.
The engine does **not** scan shadow state to discover disappeared records.

### Write path — only changed records dispatched

Before calling `connector.insert()` / `connector.update()` on a target, three guards fire in
sequence, each O(fields per record):

1. **Echo detection** — skip if source shadow already matches incoming.
2. **Conflict resolution** — skip if resolved value is empty.
3. **Noop suppression** — skip if resolved value already matches target shadow
   (`PLAN_NOOP_UPDATE_SUPPRESSION.md`).

Records that did not change are never written to destination connectors.

---

## Gaps — Operations That Scale with Total Data, Not Delta

### GAP-S1: In-memory batch accumulation

**Engine behaviour (`packages/engine/src/engine.ts` ingest method):**
The engine collects all records from the connector's `AsyncIterable<ReadBatch>` into a single
`ReadRecord[]` array before calling `_processRecords`. There is no streaming per-record
dispatch and no configurable max batch size.

**Impact:** For a connector returning 100 K records on first run or after a forced `fullSync`,
the entire array lives in heap memory simultaneously. At sustained large scale this becomes a
memory ceiling, not a throughput ceiling.

**Possible fix:** Stream `_processRecords` dispatch record-by-record (or in fixed-size chunks)
rather than accumulating the full batch first.

---

### GAP-S2: Fan-out guard — full `identity_map` scan on every tick

**Engine behaviour (`packages/engine/src/engine.ts` `_processRecords`):**
The set of connectors sharing a canonical identity is recomputed on every call via:

```sql
SELECT DISTINCT connector_id FROM identity_map
WHERE canonical_id IN (
  SELECT canonical_id FROM identity_map
  GROUP BY canonical_id HAVING COUNT(DISTINCT connector_id) > 1
)
```

This `GROUP BY / HAVING` scan executes against the **entire** `identity_map` table — including
deferred-association retry calls. There is no cache and no supporting index.

**Impact:** O(total rows in identity_map) per tick. Negligible at small scale; becomes a
fixed per-tick cost at millions of linked records regardless of delta size.

**Possible fix:** Cache the derived set in memory (invalidate on identity map writes), or
materialise it in a summary table updated incrementally.

---

### GAP-S3: `JSON_EXTRACT` identity-field matching — linear scan

**Engine behaviour (`packages/engine/src/db/queries.ts` `dbFindCanonicalByField`):**
When `identityFields` is configured (used to match records by email, external key, etc.), the
engine runs:

```sql
SELECT canonical_id FROM shadow_state
WHERE entity_name = ? AND connector_id != ?
  AND JSON_EXTRACT(canonical_data, '$.fieldName.val') = ?
LIMIT 1
```

No index exists on the JSON field. Called once per incoming record that has not yet been
linked in `identity_map`.

**Impact:** O(shadow rows for that entity) per new or unlinked record. For high-volume first
runs or high-churn entities this scan dominates ingest time.

**Possible fix:** Add a generated/computed column, a secondary lookup table keyed on
`(entity_name, field_name, field_value)`, or a SQLite expression index
(`CREATE INDEX … ON shadow_state (entity_name, JSON_EXTRACT(canonical_data, '$.email.val'))`).

---

### GAP-S4: No intra-run checkpointing

**Engine behaviour:**
The watermark is advanced only after the entire batch completes. A crash or timeout mid-run
causes the next run to re-fetch the full batch from the last stored watermark.

**Impact:** A run processing 500 K records that crashes at record 490 K re-fetches all 500 K
on the next tick. This compounds GAP-S1 (memory) and connector API quota usage.
Documented as a gap in `plans/engine/GAP_IN_VS_OUT.md` (§ grove/in-and-out comparison).

**Possible fix:** Checkpoint the watermark every N records (configurable), or after each
`ReadBatch` rather than after all batches.

---

### GAP-S5: `discover()` / `addConnector()` load all shadow rows for entity

**Engine behaviour (`packages/engine/src/db/queries.ts` `dbGetAllShadowForEntity`):**

```sql
SELECT external_id, canonical_data FROM shadow_state
WHERE connector_id = ? AND entity_name = ? AND deleted_at IS NULL
```

Called during `discover()` and `addConnector()` onboarding operations. All matching rows are
loaded into memory for in-process identity matching (hash-join via `Map`).

**Impact:** These are onboarding operations, not per-tick, so they do not affect steady-state
throughput. However, for large datasets the in-memory load may be prohibitive or slow during
onboarding. The hash-join itself is O(n + m) given the `Map` keying, which is acceptable
provided memory is not the constraint.

**Possible fix:** Paginate `dbGetAllShadowForEntity` internally, or push the matching join
into SQL rather than loading all rows into the application layer.

---

### GAP-S6: SQLite single-writer constraint

All shadow state, identity map, watermark, and event log operations share a single SQLite
file (WAL mode enabled, `packages/engine/src/db/index.ts`). Concurrent multi-process ingest
against the same sync group is not supported.

**Impact:** Throughput is bounded by SQLite single-writer semantics. Acceptable for
single-process use; a hard ceiling for horizontal fan-out.

**Note:** This is a known, intentional constraint for the current milestone. See
`plans/engine/PLAN_DB_MIGRATIONS.md` for the post-release storage evolution plan.

---

## Scaling Summary Table

| Operation | Scales with | Notes |
|-----------|------------|-------|
| `connector.read(ctx, since)` | **Delta** | Watermark passed to connector |
| Shadow diff lookup | **Delta** | PK lookup per incoming record |
| Echo / noop suppression | **Delta** | O(fields) per record |
| Conflict resolution | **Delta** | O(fields) per record |
| Write dispatch | **Delta** | Only changed records |
| In-memory batch buffer (GAP-S1) | **Batch size** | Full batch in RAM before processing |
| Fan-out guard query (GAP-S2) | **Total `identity_map` rows** | Every tick, no cache |
| Identity-field JSON scan (GAP-S3) | **Total shadow rows (entity)** | First-seen records, no JSON index |
| Intra-run crash recovery (GAP-S4) | **Batch size** | Full re-fetch from last watermark |
| `discover()` / `addConnector()` (GAP-S5) | **Total shadow rows (entity)** | Onboarding only |
| SQLite write concurrency (GAP-S6) | **Process count** | Single-writer ceiling |

---

## Practical Thresholds (Rough Guidance)

- **< 50 K records per entity:** No scaling concern. PK lookups are fast; fan-out scan on
  a small identity map is negligible.
- **50 K – 500 K records:** GAP-S3 (JSON scan) and GAP-S1 (memory) become measurable.
  In-memory accumulation starts requiring care; `identityFields`-based matching slows first
  runs.
- **> 500 K records / high churn:** GAP-S2 (fan-out guard) becomes a fixed per-tick overhead;
  GAP-S4 crash recovery re-fetches large volumes; GAP-S1 memory pressure is significant.

None of these are blockers for current connectors and datasets. They are recorded here so
that fixes can be prioritised when the data scale warrants it.
