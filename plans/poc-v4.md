# Plan: POC v4 — SQLite State Layer + Log Surfaces

**Status:** `planned`
**Depends on:** v3 POC (complete)

## Goal

Replace the in-memory JSON state blob with a real SQLite database. Validate the Drizzle adapter
pattern in practice, establish the minimal schema needed to run the engine, and investigate which
log surfaces are essential vs. deferred.

This is a foundations POC — not yet the full production engine. The goal is to answer concrete
questions about the data layer before building on top of it.

---

## What v3 Left Behind

v3 stores all state in a single `data/state.json` file:

```json
{
  "identityMap": { "<canonicalId>": { "<connectorId>": "<externalId>" } },
  "watermarks":  { "<connectorId>": { "<entityName>": "<since>" } },
  "lastWritten": { "<connectorId>": { "<entityName>": { "<externalId>": { ...canonical } } } }
}
```

This works for a single process with no concurrent access. It breaks when:
- Multiple processes need to read/write state (daemon + CLI commands like `status`, `inspect`)
- State becomes large enough that loading the whole blob on every poll is a problem
- We need queryable structure (e.g. "show me all records from connector A in channel X")

---

## The Minimal Runtime Schema

The v4 engine needs **four** tables. Three replace `state.json`; the fourth (`shadow_state`) is
the core architectural addition that enables hub-and-spoke.

### `identity_map`

```sql
CREATE TABLE identity_map (
  canonical_id    TEXT NOT NULL,
  connector_id    TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  PRIMARY KEY (canonical_id, connector_id),
  UNIQUE (connector_id, external_id)
);
```

Replaces: `state.identityMap`

### `watermarks`

Per source connector per entity — **no longer per directed pair**.

```sql
CREATE TABLE watermarks (
  connector_id  TEXT NOT NULL,
  entity_name   TEXT NOT NULL,
  since         TEXT NOT NULL,
  PRIMARY KEY (connector_id, entity_name)
);
```

Replaces: `state.watermarks` (v3 keyed by `"fromId→toId:entity"`, v4 by `"connectorId:entity"`)

### `shadow_state`

Local copy of every record as last seen from each source connector, in canonical form. This is
the central hub: all reads diff against it; all writes update it.

```sql
CREATE TABLE shadow_state (
  connector_id    TEXT NOT NULL,
  entity_name     TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  canonical_id    TEXT NOT NULL,
  canonical_data  TEXT NOT NULL,   -- JSON blob
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (connector_id, entity_name, external_id)
);
```

Replaces: `state.lastWritten`. Also makes it queryable — you can see the current state of every
record in every connector without reading from the live APIs.

### `connector_state`

Per-connector persistent key-value store. Powers `ctx.state`.

```sql
CREATE TABLE connector_state (
  connector_id  TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,   -- JSON
  PRIMARY KEY (connector_id, key)
);
```

---

## The Hub-and-Spoke Loop (architectural shift from v3)

v3 iterates **directed pairs** — each source is read once per target:

```
A→B  read A, write B   ← A read twice if there's also A→C
A→C  read A, write C
B→A  read B, write A
...
```

v4 iterates **sources** — each source is read once per cycle, changes fanned out to all targets:

```
ingest(channel, A)   read A once → Δ_A → write to B, write to C
ingest(channel, B)   read B once → Δ_B → write to A, write to C
ingest(channel, C)   read C once → Δ_C → write to A, write to B
```

Echo detection: after writing Δ_A to B, update `shadow_state[B]` with the canonical data.
When B is ingested next cycle, its records are diffed against `shadow_state[B]` — if the data
matches what was just written, it's an echo and is skipped. Same semantics as v3 `lastWritten`,
different structure.

The engine's public API changes from `sync(channelId, from, to)` to `ingest(channelId, connectorId)`.
`run.ts` iterates each channel member once rather than each directed pair.

---

## Log Surfaces to Investigate

Not all log surfaces have equal urgency. v4 should validate two and defer the rest.

### Surface 1: Transaction Log (validate in v4)

Every record written to a connector is logged. This is what enables rollback and `opensync inspect`.

```sql
CREATE TABLE transaction_log (
  id            TEXT PRIMARY KEY,          -- uuid
  batch_id      TEXT NOT NULL,             -- groups all writes in one sync cycle
  connector_id  TEXT NOT NULL,
  entity_name   TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  canonical_id  TEXT NOT NULL,
  action        TEXT NOT NULL,             -- 'insert' | 'update' | 'delete'
  data_before   TEXT,                      -- JSON, null for inserts
  data_after    TEXT,                      -- JSON, null for deletes
  synced_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

**Why validate now:** The engine already produces this data as `RecordSyncResult` — we just need
to persist it. Adding it in v4 proves the write path and gives us something to query immediately.
The `batch_id` concept (grouping a full cycle's writes) is essential for rollback and should be
validated early.

### Surface 2: Sync Run Log (validate in v4)

One row per poll cycle. Lightweight — just totals and timing.

```sql
CREATE TABLE sync_runs (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT NOT NULL,              -- same batch_id as transaction_log entries
  channel_id    TEXT NOT NULL,
  from_connector TEXT NOT NULL,
  to_connector  TEXT NOT NULL,
  inserted      INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  deferred      INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL
);
```

**Why validate now:** This is what `opensync status` reads. Without it, the CLI has no history.
It's trivially cheap to write (one INSERT per directed pair per cycle) but answers the most
immediately useful question: "is this working?"

### Surface 3: Request Journal (defer to future POC)

Logs every outbound HTTP call. Not relevant yet — the jsonfiles connector makes no HTTP calls.
Schema is already specified in `specs/observability.md`. Validate when building a real HTTP
connector (HubSpot, Fiken).

### Surface 4: `ctx.state` (validate in v4)

Per-connector persistent key-value store. Currently a stub `{}` in the POC. Real connectors need
it for OAuth tokens, resumable cursors, and pagination state.

```sql
CREATE TABLE connector_state (
  connector_id  TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,   -- JSON
  PRIMARY KEY (connector_id, key)
);
```

**Why validate now:** Any real connector will use this. If it doesn't work cleanly in the engine's
`ConnectorContext`, we'll find out before we've built connectors that depend on it.

---

## Other Surfaces to Investigate in v4

These aren't SQLite tables but are open questions that v4 should resolve or at least touch:

### Deletion handling

v3 has no concept of a record being deleted at the source. The `read()` interface returns changed
records since a watermark — it doesn't signal removals. Options:
- Periodic full-scan diff against `identity_map` (expensive but simple)
- Connector-side tombstone: a record with `_deleted: true` in the batch
- Soft-delete flag in `identity_map` itself

This needs a decision before the transaction log can be considered complete (deletes need `data_before`).

### Error recovery per record

v3 crashes the cycle if any connector call throws. Real behaviour should be:
- Connector-level errors: log to `sync_runs.errors`, skip that record, continue the cycle
- This is the v3 `"error"` action extended to include persistence

### Config validation (Zod)

`openlink.json` and mappings are currently loaded and cast with `as`. Zod schemas should be
validated at startup so the engine refuses to start on bad config with a clear message. v4 is the
right place to establish this pattern.

### Full sync mode

Ignoring watermarks and re-processing everything. Needed for onboarding (first run against an
existing dataset) and for recovery. Simple to implement: pass `undefined` as `since` to all
`read()` calls, don't update watermarks until the full scan completes successfully.

---

## The Drizzle Adapter Question

v4 will validate whether `openDb()` (the dual-driver adapter from `specs/database.md`) works in
practice. Specifically:

- Does Drizzle's `BaseSQLiteDatabase` type actually serve as a clean seam between `bun:sqlite` and
  `better-sqlite3`?
- Are there API differences in transaction semantics, WAL mode configuration, or RETURNING clause
  support that the adapter needs to paper over?
- Is Drizzle's overhead worth it vs. raw SQL for the POC? (Hypothesis: yes for the identity map
  queries; possibly no for the bulk `last_written` upserts.)

---

## What v4 Is NOT

- Not a full production schema — `connector_instances`, `sync_channels`, `oauth_tokens` etc. are
  in the spec but out of scope here. v4 uses connector IDs as plain strings (same as v3) rather
  than FK-linked rows.
- Not a job queue — `sync_jobs` is deferred. v4 still runs the poll loop inline.
- Not a webhook handler.
- Not the CLI binary — v4 is still a `bun run poc/v4/run.ts` script.

---

## Work Items

1. `openDb()` implementation — dual-driver adapter, `bun:sqlite` + `better-sqlite3` paths
2. Schema bootstrap — `CREATE TABLE IF NOT EXISTS` for all 6 tables on startup
3. Port identity map reads/writes to SQLite (`identity_map` table)
4. Port watermarks to SQLite — key changes from `"from→to:entity"` to `"connectorId:entity"`
5. Replace `lastWritten` with `shadow_state` table
6. Rewrite engine core: `sync(channelId, from, to)` → `ingest(channelId, connectorId)`
   - Read source once; diff each record against `shadow_state[source]`
   - Fan out Δ to all other channel members
   - Update `shadow_state[target]` after each write (echo prevention)
7. Remove `toJSON()` / `fromJSON()` / `data/state.json` serialisation (replaced by DB)
8. Add `batch_id` generation per cycle (UUID); pass through to log writes
9. Transaction log writes after each insert/update (action, data_before, data_after, batch_id)
10. Sync run log writes — one row per `ingest()` call (inserted, updated, skipped, errors)
11. Implement `ctx.state` via `connector_state` table
12. Zod validation for `openlink.json` and mapping files at load time
13. Per-record error recovery — catch connector throws, log, continue cycle
14. Full sync mode — `--full` flag, bypass watermarks, re-ingest everything
15. Update engine tests — use in-memory SQLite (`:memory:`), cover new ingest() API
16. Copy v3 config files (`openlink.json`, `mappings/`) into `poc/v4/`

---

## Open Questions

- **Drizzle vs raw SQL for v4?** Raw SQL keeps the POC lean; Drizzle matches the target
  architecture. Lean towards Drizzle with raw fallback for bulk upserts if needed.
- **`better-sqlite3` vs `bun:sqlite` as the dev default?** `bun:sqlite` works immediately in the
  POC (no native install). Switch to `better-sqlite3` when testing the Node path.

---

## v4 Expansion: Hardening the Foundation for Actions, Safety, Rollback, and Data Access

The POC trajectory (v1–v6) is solid for auth and HTTP. However, there are four structural
decisions that need to be validated *before* building actions, discovery, safety, and rollback —
changes to any of these after the fact would require redoing the foundation.

---

### Critical Gap: Field-Level Shadow State

v4's `shadow_state` stores `canonical_data` as a flat JSON blob. The spec defines field entries as:

```typescript
interface FieldEntry { val: unknown; prev: unknown; ts: number; src: string; }
type FieldData = Record<string, FieldEntry>;
```

Almost nothing else works without this structure:

| Feature | Why it needs `{ val, prev, ts, src }` |
|---|---|
| Rollback | `prev` to revert a field; `src` to identify who wrote it |
| Conflict resolution (field_master / LWW) | `src` per field (who owns it); `ts` per field (what's newer) |
| Data access queries | "Who last changed email?" needs `.src` and `.ts` per field |
| Actions `FieldDiff[]` | The changes array in emitted events carries per-field `oldValue`/`newValue` |
| External change detection | "I didn't write this" requires comparing `src` against the outbound log |

**If the shadow_state schema stays as a flat blob past v4, migrating it will break everything
built on top.** This must be resolved before v5.

**Questions to answer:**
- Does `{ val, prev, ts, src }` per field fit cleanly in SQLite as a JSONB blob, or does each
  field need its own row? (Hypothesis: blob is fine; per-row is more queryable but overkill for now.)
- Do the diff and echo-detection algorithms still read naturally with the new shape?
- Does the `data_before` / `data_after` in `transaction_log` change shape when shadow_state is field-level?

---

### Structural Pipeline Hook 1: Event Emission (Actions)

Actions require `eventBus.emit()` to fire after every successful dispatch. The correct position
in the ingest loop is:

```
read → diff → resolve → dispatch → emit('record.created' | 'record.updated') → update shadow
```

The hook is cheap to add, but it must emit with the correct shape:
- `entityId` (canonical UUID)
- `sourceInstanceId`
- `changes: FieldDiff[]` — which fields changed and their old/new values (only possible with field-level shadow)
- `data` — full canonical record at the time of emission

**Validate in v4 expansion:** stub an `EventBus` that collects emitted events; write a test that
asserts a 3-connector sync emits the right events with the right `FieldDiff[]` payload. Nothing
should subscribe yet — just verify the emission contract is correct.

---

### Structural Pipeline Hook 2: Conflict Resolution

v4 currently applies implicit LWW — last ingest wins. The spec places an explicit resolution step
between diff and dispatch:

```
diff → resolveConflicts(changes, shadow, config) → dispatch
```

With field-level shadow state in place this slot is straightforward to fill: `src` and `ts` per
field give LWW all it needs, and `field_master` is a simple config lookup. Without field-level
shadow, conflict resolution has nowhere to get per-field provenance from.

**Validate in v4 expansion:** a test with two connectors that both update the same field in the
same cycle. Verify that LWW picks the higher timestamp and that a `field_master` rule can override
it regardless of timestamp.

---

### Structural Pipeline Hook 3: Circuit Breaker Pre/Post-Flight

The circuit breaker must wrap the dispatch loop, not individual calls:

```typescript
// before processing a batch:
const state = await breaker.evaluate(batchSize, errorCount);
if (state === 'TRIPPED') return; // or throw, depending on strategy

// dispatch each record...

// after dispatch:
await breaker.recordOscillations(changedFields);
```

If the ingest loop isn't designed with this wrapping point, the circuit breaker has to reach into
the loop internals to intercept it.

**Validate in v4 expansion:** a simple in-memory `CircuitBreaker` stub (no DB yet); a test that
trips the breaker on a volume threshold mid-batch and asserts that the batch stops cleanly and
that shadow state is consistent (no partial writes for the tripped records).

---

### What Doesn't Threaten the Foundation

These can be added later without structural pipeline changes, as long as the above three are solid:

- **Idempotency** — a hash check inserted at the start of `ingest()` before the read loop;
  no loop changes required.
- **Soft delete detection** — mark-and-sweep runs after the full-sync read; entirely outside
  the main dispatch loop.
- **Discovery / matching** — a pre-sync step that populates `identity_map` before any ingest
  runs; no pipeline changes.
- **Rollback** — reads `transaction_log` and calls `connector.upsert` / `connector.delete` in
  reverse; no changes to the ingest path itself.
- **Data access** — direct SQLite queries against `shadow_state`; zero pipeline changes.
- **Full transform engine** — inbound rename maps already exist as a slot; expanding to arbitrary
  `TransformFn` is purely additive.

---

### Additional Work Items (v4 Expansion)

17. Migrate `shadow_state.canonical_data` from flat JSON blob to field-level `{ val, prev, ts, src }` per field; update diff, echo detection, and transaction log accordingly
18. Stub `EventBus` with `emit()` + `on()`; wire emission after each successful dispatch
19. Add `resolveConflicts()` between diff and dispatch; test LWW and `field_master` strategies
20. Add `CircuitBreaker` stub with volume threshold; wire pre/post-flight around the dispatch loop; test tripping stops the batch cleanly
- **`batch_id` granularity** — one per full poll cycle or one per directed pair? One per pair
  makes rollback more surgical but creates more rows. One per cycle is simpler. Start with one per
  cycle.
- **`last_written` upsert performance** — each sync cycle updates one row per synced record. With
  large datasets this is the hot path. Worth benchmarking raw `INSERT OR REPLACE` vs Drizzle's
  `onConflictDoUpdate`.

---

## v4 Validation: OSI-Mapping Primitive Foundation Probes

See [specs/osi-mapping-primitives.md](../specs/osi-mapping-primitives.md) for the full catalog of
50 primitives from OSI-mapping and their current foundation status in OpenSync.

Of the 28 gaps identified, most are **additive** — nested arrays, filters, routing, vocabulary
targets, inline tests, tombstones, normalize — none require structural changes to v4's pipeline,
schema, or conflict model.

Three gaps are **structural risks**: if left unproven now, implementing them later would require
rearchitecting components that other features will already be built on top of.

---

### Probe 1: Field-Value Identity Matching

**Risk:** `_getOrCreateCanonical()` always allocates a new UUID for an unknown `(connectorId, externalId)` pair. OSI-mapping's `identity` strategy links records when they *share a field value* (`email` matches across two sources → same entity), not when the connector reports an explicit association. If `shadow_state` can't be efficiently queried for canonicalId-by-field-value, or if merging two canonical IDs into one (repointing all rows) requires restructuring the identity schema, that is a fundamental blocker.

**What to validate:** Add `identityFields: string[]` to `ChannelConfig`. During ingest, before
`_getOrCreateCanonical()`, query `shadow_state` for any row in *another* connector with matching identity field values. If found, link the incoming `(connectorId, externalId)` to the *existing* canonical UUID rather than allocating a new one.

The probe must also cover the **merge case**: two canonical UUIDs are discovered to represent the same entity (because their identity fields match). Repoint all `identity_map` rows from one UUID to the other and verify no shadow_state rows are orphaned.

**SQL query at the core:**
```sql
SELECT canonical_id
FROM shadow_state
WHERE entity_name = ?
  AND connector_id != ?
  AND JSON_EXTRACT(canonical_data, '$.' || ?) = ?
LIMIT 1
```

**Acceptance:** A test with two connectors where neither reports an association — they share an `email` field value. After ingesting both, they must resolve to the same canonical ID. The transaction log must show one entity, not two.

---

### Probe 2: Per-Field Resolution Strategies

**Risk:** `ConflictConfig` is a single global strategy for the entire channel. `FieldData` already stores `{ val, src, ts }` per field — the raw material for `coalesce` (compare priority) and `last_modified` (compare ts). The question is whether `resolveConflicts()` can be extended with per-field strategy declarations without restructuring its signature or the shadow schema. If `FieldData` is missing information that a strategy needs (e.g. `priority` is nowhere in shadow state), or if the resolver's interface can't be extended without breaking callers, the design is wrong.

**What to validate:** Extend `ConflictConfig` with:
```typescript
fieldStrategies?: Record<string, 
  | { strategy: "coalesce"; priority: number }
  | { strategy: "last_modified" }
  | { strategy: "collect" }
>
```
Wire through `resolveConflicts()`. Implement `coalesce` (lower `priority` number wins, with `last_modified` as tiebreaker) and `last_modified` (higher `ts` wins). `collect` can return an array of all source values — just proves the resolver can return something other than a scalar.

**Acceptance:** A test with three connectors, two conflicting on a `coalesce` field (different priorities) and two conflicting on a `last_modified` field (different timestamps). Correct winner chosen for each. A `collect` field accumulates all three values. The rest of the engine (shadow update, transaction log, dispatch) handles the collected array without changes.

---

### Probe 3: Field-Level Direction Control

**Risk:** `ChannelMember.inbound` and `outbound` are `Record<string, string>` (whitelist rename maps). OSI-mapping requires each field to declare `direction: "forward_only" | "reverse_only" | "bidirectional"` — critical for constant injections (fields with no source, contributed only during the forward pass) and reverse-only fields (written to a target but never read back). If the config type stays as `RenameMap`, adding direction later forces a breaking rename of the config shape and changes to every caller of `applyRename`.

**What to validate:** Replace `RenameMap = Record<string, string>` with:
```typescript
interface FieldMapping {
  source?: string;           // source field name (omit for constants)
  target: string;            // target field name
  direction?: "bidirectional" | "forward_only" | "reverse_only";  // default: bidirectional
  expression?: string;       // constant or transform expression (placeholder — not evaluated yet)
}
type FieldMappingList = FieldMapping[];
```
Update `applyRename` to accept `FieldMappingList` and respect direction. During forward dispatch (source → target), skip `reverse_only` fields. In any future reverse path (target → source), skip `forward_only` fields. The `expression` field on a `forward_only` mapping with no `source` is not evaluated yet — just assert it is preserved in the config and ignored at runtime.

**Acceptance:** A test where a `forward_only` constant field (`type: "customer"`) appears in the target's received record but is *not* echoed back when the target connector is later ingested. A `reverse_only` field moves in the opposite direction only. A `bidirectional` field moves both ways as before. `applyRename` existing tests must still pass after the type change.

---

### Additional Work Items (v4 OSI Probes)

21. Probe 1 — field-value identity: add `identityFields` to `ChannelConfig`; query `shadow_state` for match before allocating canonical UUID; test merge of two canonical IDs
22. Probe 2 — per-field strategies: extend `ConflictConfig` with `fieldStrategies`; implement `coalesce`, `last_modified`, `collect` in `resolveConflicts()`; test all three in one cycle
23. Probe 3 — field direction: replace `RenameMap` with `FieldMapping[]`; update `applyRename`; test forward_only/reverse_only/bidirectional separation

---

## Foundation Must-Fixes

Three issues identified during the gap analysis against grove/in-and-out that need to be addressed
in v4, not deferred. All other gaps from that analysis are additive and can be bolted on later.

### Fix 1: Watermark atomicity

**Problem:** In `engine.ts`, `dbSetWatermark` is called at the end of `ingest()` *after* the
dispatch loop completes — in a separate statement from the `dbSetShadow` / `dbLogTransaction`
calls inside the loop. A crash between the last `dbSetShadow` and `dbSetWatermark` advances the
watermark past data that was never committed to shadow state, causing those records to be silently
skipped on the next run (permanent data loss).

**Fix:** Wrap the entire per-source write block — from the first `dbSetShadow` call through to
`dbSetWatermark` — in a single `db.transaction(...)`. Shadow updates, transaction log entries,
and the watermark advance must all commit together or not at all.

**Why now:** The scheduler, daemon mode, and concurrency control will all be built on top of the
current call sequence. Retrofitting atomicity once those layers exist is significantly more
disruptive than fixing it now.

### Fix 2: `deleted_at` missing from `shadow_state` schema

**Problem:** `specs/database.md` specifies `deleted_at TEXT` on `shadow_state`. The POC schema
in `poc/v4/db.ts` omits it. Without this column the reconcile step cannot distinguish between
"record not returned this cycle → candidate for deletion" and "record that was previously
tombstoned and has now reappeared with the same `external_id`" (soft-delete resurrection). The
diff logic will treat a returning record as a second insert rather than a resurrection.

**Fix:** Add `deleted_at TEXT` (nullable) to the `shadow_state` bootstrap DDL. Update
`dbSetShadow` to accept and persist the value. Add a corresponding resurrection check in the
ingest reconcile path: if `shadow.deleted_at IS NOT NULL` and the record appears again, treat
it as an update (clear `deleted_at`, apply new data) rather than a duplicate insert.

**Why now:** This is a schema change. Adding a column to a live schema requires a migration;
in the POC, `bootstrap()` runs `CREATE TABLE IF NOT EXISTS` so the column will only be added
to fresh databases. Fixing it now avoids having to write and test a migration in a later POC
phase.

### Fix 3: Extract `dispatchWrite` as a named seam

**Problem:** The write path in `ingest()` is inline — conflict resolution, shadow state update,
transaction log, and the connector `.upsert()` call are woven together in the same function
body. Two upcoming foundation requirements (pre-flight read for write-anomaly protection, and
per-record write ordering) both need to wrap the connector write call. If the dispatch step
sits inside a loop with no clean boundary, adding those wrappers requires surgery on the
engine's hottest path.

**Fix:** Extract the block that calls `connector.upsert()` / `connector.delete()`, updates
shadow state, and writes the transaction log entry into a standalone `dispatchWrite(db, target,
record, canonId, ...)` function. The loop calls this function; the function has a clear
before/after boundary where a pre-flight read hook and an ordering guard can slot in without
touching loop logic.

**Why now:** This is pure refactoring with no behaviour change — the correct time to do it is
before adding any logic that depends on the seam existing.
