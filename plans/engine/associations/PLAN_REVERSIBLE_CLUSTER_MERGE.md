# Engine: Reversible Cluster Merges / Cluster Split

**Status:** backlog  
**Date:** 2026-04-09  
**Effort:** L  
**Domain:** Engine  
**Scope:** `packages/engine/src/db/queries.ts`, `packages/engine/src/db/migrations.ts`, `packages/engine/src/engine.ts`, `specs/identity.md`  
**Depends on:** none  
**See also:** `plans/engine/PLAN_TRANSITIVE_CLOSURE_IDENTITY.md`, `specs/rollback.md`  

---

## § 1 Problem Statement

`dbMergeCanonicals(db, keepId, dropId)` performs two destructive SQL mutations:

1. Deletes `identity_map` rows from `dropId` that would conflict with `keepId` (same
   connector).
2. `UPDATE identity_map SET canonical_id = keepId WHERE canonical_id = dropId`
3. `UPDATE shadow_state SET canonical_id = keepId WHERE canonical_id = dropId`

After these three statements, `dropId` is gone. There is no way to reconstruct which
rows belonged to which original cluster, so splits — manual or automatic — are
impossible without a full snapshot rollback that also reverts all field data written
since the merge.

This matters for two concrete cases:

- **False-positive identity match** — the engine incorrectly unified two different
  real-world entities (e.g. two contacts with the same email at a company). The user
  needs to split them apart.
- **Playground / API "break cluster" feature** — the split-cluster TODO item in the
  playground (`plans/internal/TODOS.md`) requires an engine API to split a linked
  cluster back into its constituent external IDs.

Three implementation options are described below. They are not mutually exclusive:
A and B are incremental steps toward C.

---

## § 2 Option A — Identity Merge Log

### § 2.1 What it is

Before executing a destructive merge, snapshot the full set of `identity_map` rows
belonging to `dropId` into a new `identity_merge_log` table. A `splitCluster(mergeId)`
function can then:

1. Re-read the log row for `mergeId`.
2. Reconstruct the original `dropId` as a fresh UUID (or the original if preserved).
3. Re-insert the logged `(connector_id, external_id)` pairs under the new canonical.
4. Repoint `shadow_state` rows that belong to those connectors back to the new canonical.
5. Copy the relevant fields from the merged canonical's shadow into the new shadow rows
   (best-effort; field provenance is not known once merged).

### § 2.2 Schema change

```sql
-- Spec: plans/engine/PLAN_REVERSIBLE_CLUSTER_MERGE.md §2.2
CREATE TABLE IF NOT EXISTS identity_merge_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  merged_at       INTEGER NOT NULL,          -- epoch ms
  keep_id         TEXT NOT NULL,             -- canonical that survived
  drop_id         TEXT NOT NULL,             -- canonical that was absorbed
  -- JSON array of { connector_id, external_id } objects that belonged to drop_id
  dropped_slots   TEXT NOT NULL
);
```

### § 2.3 `dbMergeCanonicals` change

Before the existing three statements, insert into `identity_merge_log`:

```ts
const droppedSlots = db
  .prepare<{ connector_id: string; external_id: string }>(
    "SELECT connector_id, external_id FROM identity_map WHERE canonical_id = ?",
  )
  .all(dropId);
db.prepare(
  "INSERT INTO identity_merge_log (merged_at, keep_id, drop_id, dropped_slots) VALUES (?, ?, ?, ?)",
).run(Date.now(), keepId, dropId, JSON.stringify(droppedSlots));
```

### § 2.4 New public method — `splitCluster`

```ts
splitCluster(keepId: string, dropId: string): void
```

- Reads the most recent `identity_merge_log` row where `keep_id = keepId AND drop_id = dropId`.
- Generates a new `canonicalId` for the split-off half (or reuses `dropId`).
- Re-inserts the logged `identity_map` rows under the new canonical.
- Copies shadow_state rows for those connector_ids from `keepId` shadow to new canonical.
- Deletes the consumed log row (or marks it `applied`).

### § 2.5 Limitations

- Field provenance is lost after merge. The split canonical inherits a copy of the merged
  shadow, not the original shadow from before the merge. Values written to the merged
  canonical after the merge are visible on both halves post-split.
- Chained merges (A←B←C) produce multiple log rows; split must be applied in reverse
  order of `merged_at`.

### § 2.6 Effort estimate

**S** — new table, ~30 lines of logic, no engine pipeline changes. Enables the playground
"break cluster" feature.

---

## § 3 Option B — Full Shadow Snapshot in Merge Log

### § 3.1 What it is

Extension of Option A: the `identity_merge_log` table also captures the full
`shadow_state` rows belonging to `dropId` at merge time as a JSON blob. Split becomes
a pure restore: re-insert the logged shadow rows verbatim.

### § 3.2 Additional schema column

```sql
dropped_shadow  TEXT NOT NULL  -- JSON array of full shadow_state rows for drop_id
```

### § 3.3 Split fidelity

Unlike Option A, the restored canonical has the exact field values it had before the
merge, regardless of any writes that occurred to the merged canonical in the interim.
This is a faithful inversion of the merge.

### § 3.4 Limitations

- Storage: each merge log row holds an extra blob proportional to the number of
  shadow_state rows that were merged in.
- Only faithful for the merge event itself. If the same external records were also
  written to by subsequent syncs, those subsequent writes are not tracked and will
  still be visible on the restored canonical.
- Does not constitute full event sourcing — it is still a point-in-time snapshot of
  a single event type.

### § 3.5 Effort estimate

**S** (incremental over A) — the log row is wider, split logic is simpler (no field
attribution needed).

---

## § 4 Option C — Event-Sourced Identity Layer (preferred long-term)

### § 4.1 What it is

Replace `identity_map` as a mutable lookup table with an immutable
`identity_events` append-only log. The current `identity_map` table becomes a
**projection** re-derived from the log. Any point-in-time identity view is possible
by replaying the log up to a given `event_id` or timestamp.

Event types:

| Event | Payload |
|-------|---------|
| `record_linked` | `canonical_id`, `connector_id`, `external_id` |
| `canonical_created` | `canonical_id` |
| `cluster_merged` | `keep_id`, `drop_id`, `dropped_slots[]` |
| `cluster_split` | `new_id`, `source_id`, `restored_slots[]` |

### § 4.2 Schema

```sql
-- Spec: plans/engine/PLAN_REVERSIBLE_CLUSTER_MERGE.md §4.2
CREATE TABLE IF NOT EXISTS identity_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at  INTEGER NOT NULL,
  event_type   TEXT NOT NULL,
  payload      TEXT NOT NULL   -- JSON
);
```

`identity_map` is rebuilt deterministically from `identity_events` by
`rebuildIdentityMap(db)`. The engine calls this at startup (or keeps the projection
up to date incrementally by appending both to the event log and to identity_map in
the same transaction).

### § 4.3 Split implementation

```
splitCluster(keepId, splitSlots[]) → newCanonicalId
```

1. Emit `cluster_split` event.
2. Re-insert `splitSlots` into `identity_map` under `newCanonicalId`.
3. Remove those rows from `keepId`'s `identity_map` entries.
4. Optionally emit a companion `shadow_state` event log (separate concern — see
   shadow event sourcing, which is out of scope here).

### § 4.4 Why this is better

- **Full audit trail**: every identity decision is traceable.
- **Time travel**: replay to any prior state by re-projecting from events.
- **Split is a first-class operation**: no inference needed, no heuristics about
  field provenance.
- **Testable in isolation**: the projection function is a pure SQL replay.

### § 4.5 Migration path

Option A → Option C: the `identity_merge_log` from A can be migrated into
`identity_events` by a one-time replay script. Running A first does not foreclose C.

### § 4.6 Effort estimate

**L** — requires restructuring all `dbLinkIdentity`, `dbMergeCanonicals`, and
`dbGetCanonicalId` call sites to write events as well as (or instead of) mutating
`identity_map`. All engine tests must continue to pass.

---

## § 5 Recommendation

Implement **Option A** as an unblocking step (enables the playground split-cluster
feature and the API method). Implement **Option B** when storage cost is acceptable
and faithful split fidelity is needed. Migrate to **Option C** as a planned pre-v1
refactor — it is architecturally cleaner and removes the special-casing in A/B.

Option C is the preferred long-term model. Options A and B are stepping stones, not
permanent solutions.

---

## § 6 Spec changes planned

- `specs/identity.md` — new section "Cluster Splits" describing `splitCluster()` API
  and the merge log (for Option A/B), or the event-sourced model (for Option C).
- `specs/rollback.md` — note that cluster splits are an alternative to full
  pre-flight rollback for identity correction.
