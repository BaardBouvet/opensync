# Database Usage Analysis

**Status:** reference  
**Date:** 2026-04-05  
**Domain:** Engine — storage layer  
**Scope:** `packages/engine/src/db/` + all SQL in the codebase  

Analysis of how SQLite is used, what query patterns exist, what the hot paths are, and
whether a different storage mechanism should be considered.

---

## Schema

Ten tables. Three are core operational; the rest are support and observability.

| Table | Role | Size characteristic |
|---|---|---|
| `identity_map` | External ID ↔ canonical UUID mapping | Grows with `N_records × N_connectors` |
| `shadow_state` | Last-known field values per `(connector, entity, record)` | Same; soft-delete only (`deleted_at`) |
| `watermarks` | Per-connector, per-entity read cursors | Tiny and stable |
| `transaction_log` | Append-only audit trail | Unbounded growth |
| `request_journal` | Every outbound HTTP call | Unbounded growth |
| `deferred_associations` | Association fan-outs that couldn't be remapped yet | Small, transient |
| `connector_state` | Per-connector KV store (`ctx.state`) | Small |
| `oauth_tokens` | Access/refresh tokens + advisory refresh lock | One row per connector |
| `circuit_breaker_events` | CB state change history | Small |
| `channel_onboarding_status` | Ready flags | One row per channel |

`webhook_queue` and `onboarding_log` appear in `specs/database.md` but are not yet created
in `migrations.ts` — spec-only / planned.

---

## Access Layer

All SQL is raw, using prepared statements. No ORM or query builder.

```
packages/engine/src/db/
├── index.ts       — Db adapter interface + openDb() (WAL mode + FK PRAGMAs)
├── migrations.ts  — createSchema() — all CREATE TABLE IF NOT EXISTS
├── schema.ts      — TypeScript row type interfaces (no SQL)
└── queries.ts     — ALL engine SQL (~30 named functions, one file)
```

The `Db` interface wraps either `bun:sqlite` or `better-sqlite3` depending on runtime
(detected via `globalThis.Bun`). Engine code calls named functions from `queries.ts`
and never writes raw SQL directly — with two minor exceptions in `engine.ts` (the
cross-link aggregate queries; candidates for promotion into `queries.ts`).

---

## Query Inventory

### Point lookups by primary key — dominant pattern

```sql
-- identity resolution (both directions), issued per record × per target connector
SELECT canonical_id FROM identity_map WHERE connector_id = ? AND external_id = ?
SELECT external_id FROM identity_map WHERE canonical_id = ? AND connector_id = ?

-- shadow read
SELECT canonical_data, deleted_at FROM shadow_state
  WHERE connector_id = ? AND entity_name = ? AND external_id = ?
```

### Upserts — used everywhere state must be idempotent

`INSERT … ON CONFLICT … DO UPDATE` on: `identity_map`, `shadow_state`, `watermarks`,
`connector_state`, `oauth_tokens`, `channel_onboarding_status`.

### `INSERT OR IGNORE`

`deferred_associations` — silently skips duplicate rows via its `UNIQUE` constraint.

### Append-only inserts (no conflict handling)

`transaction_log`, `request_journal`, `circuit_breaker_events`, `sync_runs`.

### JSON_EXTRACT — identity-field matching

```sql
SELECT canonical_id FROM shadow_state
  WHERE entity_name = ?
    AND connector_id != ?
    AND JSON_EXTRACT(canonical_data, '$.' || ? || '.val') = ?
  LIMIT 1
```

Walks into the JSON blob in `shadow_state.canonical_data` to match a new record against an
existing canonical by a configured field value (e.g. email). No index backs this — it is a
full scan filtered by `entity_name` and `connector_id`.

### One JOIN — canonical field merge

```sql
SELECT ss.canonical_data
FROM shadow_state ss
JOIN identity_map im
  ON im.connector_id = ss.connector_id AND im.external_id = ss.external_id
WHERE im.canonical_id = ? AND ss.deleted_at IS NULL
```

Used in `dbGetCanonicalFields` to reconstruct the merged view across all connectors linked
to a canonical. This is the only join in the codebase.

### Correlated subquery — cross-link detection

```sql
SELECT canonical_id FROM identity_map
GROUP BY canonical_id HAVING COUNT(DISTINCT connector_id) > 1
```

Appears in three places in `engine.ts`: `channelStatus()`, `onboardedConnectors()`, and the
fan-out guard in `_processRecords()`. It is re-materialized on every call. Results are not
cached.

### Advisory lock via conditional UPDATE

```sql
UPDATE oauth_tokens SET locked_at = ?
  WHERE connector_id = ? AND (locked_at IS NULL OR locked_at < ?)
```

SQLite's serialized writes make `.changes === 1` a reliable lock-acquire signal.

### Bulk reads

```sql
SELECT external_id, canonical_data FROM shadow_state
  WHERE connector_id = ? AND entity_name = ? AND deleted_at IS NULL
```

Used in `onboard()` to load all live records for a connector+entity in one pass.

### Dynamic `IN (?, ?, …)` placeholders

`dbGetAllCanonicals`, `channelStatus`, `onboardedConnectors`, fan-out guard — placeholder
count built at runtime from the connector list.

No CTEs, window functions, or aggregation functions beyond `COUNT(*)` are used anywhere.

---

## Hot Paths

### `_processRecords()` — inner loop (per record × per target connector)

```
dbGetShadowRow(source)                        1 point read
dbGetCanonicalId → dbGetExternalId            1–2 point reads
  or dbLinkIdentity                           1 upsert
dbGetShadow(target)                           1 point read
dbFindCanonicalByField × identity fields      1 JSON_EXTRACT scan per field (optional)
--- single db.transaction() per record ---
dbSetShadow(source) + dbSetShadow × targets   N+1 upserts
dbLinkIdentity                                1 upsert
dbLogTransaction                              1 insert
dbRemoveDeferred or dbInsertDeferred          1 conditional delete/insert
```

Worst case: `N_records × N_targets × ~6–8 prepared-statement executions`. All statements
are pre-compiled via `db.prepare()` (no per-call parsing). Each record is committed in its
own transaction — safe for partial-batch recovery, but more fsyncs than a single batch
transaction.

### `onboard()` — per matched pair

One outer `db.transaction()` over all `report.matched`: `dbGetCanonicalId` + `dbMergeCanonicals`
(two UPDATEs) + `dbLinkIdentity` + `dbSetShadow` per match, then individual transactions per
unique-per-side record.

### `request_journal` write on every HTTP call

Every outbound HTTP request (potentially many per ingest batch) writes one row outside the
main record transaction. For chatty connectors this adds up.

### `CircuitBreaker._restoreFromDb()` — once per engine construction

One `dbGetRecentCircuitBreakerEvents` per channel on startup. Cheap, but happens at
construction time for every channel.

---

## Gaps and Risks

### 1. No indexes beyond PKs and UNIQUE constraints

The `JSON_EXTRACT` identity-field query has no supporting index — it performs a full scan of
`shadow_state` filtered by `entity_name` and `connector_id`. Acceptable at thousands of
records; will degrade noticeably at tens of thousands.

**Mitigations (in order of invasiveness):**
- Add a composite index `(entity_name, connector_id)` on `shadow_state`.
- Add a generated column for commonly-matched identity fields and index that.
- Extract identity fields into a dedicated `identity_fields` table (sidesteps JSON blob
  entirely; more invasive).

### 2. Unbounded `transaction_log` and `request_journal`

Both tables grow indefinitely. They will eventually dominate file size and slow down SQLite's
auto-vacuum. No TTL, archiving, or rotation policy exists.

**Mitigation:** TTL-based delete or row-count-based rolling window (e.g. keep last 30 days or
last 100k rows). Could be a background task triggered after each ingest pass.

### 3. Cross-link subquery re-materialized on every call

The `GROUP BY canonical_id HAVING COUNT(DISTINCT connector_id) > 1` subquery runs on every
`_processRecords()` call with no caching. For large `identity_map` tables this will become
the dominant query cost.

**Mitigation:** Compute once per `_processRecords()` call (already done for the fan-out guard)
and pass the result through — currently, `channelStatus()` and `onboardedConnectors()` also
re-run independently. A materialized in-memory cache with invalidation on `dbLinkIdentity`
would eliminate the redundancy.

### 4. Per-record transactions rather than per-batch

Each record is committed in its own transaction. This is correct and safe (watermark advance
requires only that the batch boundary was flushed), but it costs proportionally more fsyncs
than a single batch transaction.

**Mitigation:** Wrap the entire `_processRecords()` loop in a single `db.transaction()`.
Failure mid-batch replays from the watermark — acceptable, since connectors re-deliver the
full batch on retry. This is the highest-leverage performance change available without
touching the data model.

---

## Should We Consider a Different Storage Mechanism?

### IVM engines (Materialize, Feldera, RisingWave, DuckDB with incremental refresh)

IVM would be warranted if the system needed live aggregate queries over the shadow state —
e.g. "all canonicals where field X changed in the last N syncs", or event-triggered
downstream views. That use case doesn't exist today. The cross-link subquery is the only
aggregate, and it is cheap at current scale.

IVM becomes relevant when:
- User-facing conflict reports or diff views are needed over the full corpus.
- The `GROUP BY … HAVING` cross-link query starts appearing in profiling.
- Event-driven downstream views (e.g. materialized conflict dashboards) are added.

### PostgreSQL

A network database makes sense only when multiple writer processes need concurrent access to
the same shadow state — i.e., a distributed deployment model. That is architecturally out of
scope. SQLite's serialized writes are a feature here: they make the advisory OAuth lock, the
upsert idempotency, and the per-record transactions trivially correct without any application-
level concurrency management.

### Verdict

SQLite is the right choice for the current model. The workload is write-heavy but sequential
(single engine process, serialized writes), the dataset is per-deployment, and virtually all
queries are point lookups. The gaps above are tractable within SQLite without changing the
storage layer.

Priority order for remediation:
1. Batch `_processRecords()` into a single transaction (performance, low risk).
2. Index `shadow_state (entity_name, connector_id)` (cheap, immediate win for identity-field scans).
3. TTL policy on `transaction_log` and `request_journal` (operational hygiene).
4. Consolidate the cross-link subquery behind a cached in-memory result (correctness is fine; this is a latency concern).
