# Plan: Minimal Production Engine (Milestone 2)

**Scope:** `packages/engine/` — the `@opensync/engine` npm package.
**Spec authority:** `specs/sync-engine.md`, `specs/database.md`, `specs/config.md`,
`specs/identity.md`, `specs/safety.md`, `specs/auth.md`, `specs/observability.md`,
`specs/discovery.md`, `specs/field-mapping.md`.
**POC gaps closed in M2:** Gap 1 (`snapshot_at`), Gap 2 (circuit breaker persistence),
Gap 6 (412 retry), Gap 8 (onboarding safety bypass).

---

## 1. Goal

Produce a standalone `packages/engine/` package that:

- Loads its configuration from disk (`opensync.json` + `mappings/`)
- Owns a persistent SQLite state file (the full schema from `specs/database.md`)
- Exposes a `SyncEngine` class whose public API matches `specs/sync-engine.md § Public API`
- Passes the M2 exit-criteria integration tests (see §10 below)

No more, no less. Rollback, webhooks, CLI, and the full SDK-helper suite are M3.

---

## 2. Package layout

```
packages/engine/
  src/
    index.ts            # public re-exports only
    engine.ts           # SyncEngine class
    config/
      loader.ts         # loadConfig(rootDir) → EngineConfig
      schema.ts         # Zod schemas for opensync.json + mappings
    db/
      index.ts          # openDb(path) → Drizzle instance
      schema.ts         # Drizzle table definitions (all tables in database.md)
      migrations.ts     # createSchema(db) — idempotent CREATE TABLE IF NOT EXISTS
    core/
      ingest.ts         # ingest() pipeline
      diff.ts           # diff() pure function
      conflict.ts       # resolveConflicts()
      dispatch.ts       # fan-out loop
      echo.ts           # shadow-state echo detection
      watermark.ts      # getWatermark / advanceWatermark
    identity/
      map.ts            # identity_map helpers (link, resolve, mergeCanonicals)
    auth/
      context.ts        # makeConnectorContext() — wires ctx.http, ctx.state
      http.ts           # tracked fetch (request journal + auth injection)
      oauth.ts          # OAuthTokenManager
    safety/
      circuit-breaker.ts  # CircuitBreaker (in-memory + DB persistence)
      idempotency.ts
    discovery/
      collect.ts        # collectOnly ingest
      discover.ts       # discover() — pure DB query
      onboard.ts        # onboard() + addConnector()
  package.json
  tsconfig.json
```

The top-level `index.ts` exports only `SyncEngine`, `loadConfig`, and public types.
Internal modules are not part of the public API.

---

## 3. Phase 1 — Database layer

**Spec:** `specs/database.md`

### 3.1 Table definitions

Define Drizzle table objects in `db/schema.ts` for every table in `specs/database.md`:

| Table | Key use |
|-------|---------|
| `identity_map` | canonical_id ↔ (connector_id, external_id) |
| `watermarks` | per-source read cursors |
| `shadow_state` | field-level last-known values per record per connector |
| `connector_state` | per-connector persistent KV (`ctx.state`) |
| `transaction_log` | append-only audit trail for rollback |
| `sync_runs` | per-batch summary metrics |
| `request_journal` | every outbound HTTP call |
| `circuit_breaker_events` | persisted trip/reset events (Gap 2) |

> `circuit_breaker_events` is the one table not yet in the spec. Add it to
> `specs/database.md` before merging. Schema:
> ```sql
> CREATE TABLE circuit_breaker_events (
>   id           TEXT PRIMARY KEY,
>   channel_id   TEXT NOT NULL,
>   event        TEXT NOT NULL,   -- 'trip' | 'reset' | 'half_open'
>   reason       TEXT,
>   occurred_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
> );
> ```

### 3.2 `openDb(path)`

`db/index.ts` exports a single function:

```ts
openDb(path: string): DrizzleSQLiteDatabase
```

Detection order:
1. `process.versions.bun` present → `import('bun:sqlite')` dynamic import → Drizzle `BunSQLiteDatabase`
2. Otherwise → `require('better-sqlite3')` → Drizzle `BetterSQLite3Database`

Both are typed as `BaseSQLiteDatabase` in all call sites — the concrete type is an
implementation detail of `openDb`.

After opening, apply:
```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
```

### 3.3 `createSchema(db)`

`db/migrations.ts` exports `createSchema(db)`. Runs `CREATE TABLE IF NOT EXISTS` for every
table. Called once on `SyncEngine` construction, never in tests directly.

---

## 4. Phase 2 — Config loading

**Spec:** `specs/config.md`

### 4.1 `loadConfig(rootDir)`

```ts
loadConfig(rootDir: string): Promise<ResolvedConfig>
```

Steps:
1. Read `${rootDir}/opensync.json` (must exist; Zod-validate).
2. Glob `${rootDir}/mappings/**/*.{yaml,yml,json}`, sort alphabetically, merge into a
   single mapping set.
3. Resolve `${VAR}` interpolation in string-valued connector config fields to
   `process.env[VAR]`. Throw with a clear message if the variable is absent.
   Interpolation is **not** applied inside nested objects (spec rule).
4. Return `ResolvedConfig` — the same shape as `EngineConfig` in `specs/sync-engine.md`
   but with all plugins loaded as live connector instances.

### 4.2 Plugin loading

Each connector in `opensync.json` has a `plugin` key:

- npm package name → `import(plugin)` dynamic import
- relative path (starts with `./`) → `import(path.resolve(rootDir, plugin))`

The imported module must export a default `ConnectorDefinition`. Throw with the plugin
name if the import fails or the export shape is wrong.

### 4.3 Zod schemas

`config/schema.ts` defines Zod schemas for:
- `OpenSyncJson` (the `opensync.json` root)
- `ChannelsYaml` (the `channels.yaml` shape)
- `MappingEntry` (one entry in the `mappings:` array)

Validation runs after loading each file, before merging. Schema errors surface with the
file name and Zod path in the message.

---

## 5. Phase 3 — Connector context wiring

**Spec:** `specs/sync-engine.md § Context & Auth`, `specs/auth.md`

### 5.1 `makeConnectorContext(connectorId, config, db, opts)`

Returns a `ConnectorContext`. Wires:

- **`ctx.http`** — `auth/http.ts` tracked fetch. Logs every call to `request_journal`.
  Masks `Authorization` header and any header containing `key`, `secret`, or `token`
  (case-insensitive) with `[REDACTED]`. Response bodies capped at 65 536 bytes.
- **`ctx.state`** — thin wrapper around `SELECT/REPLACE INTO connector_state` for this
  `connector_id`.
- **`ctx.logger`** — a pino child logger tagged with `{ connector: connectorId }`.
- **`ctx.config`** — the raw config object from `opensync.json` for this connector.

### 5.2 Auth injection priority

Applied inside `ctx.http` before every request:

1. `connector.prepareRequest` defined → call it; skip 2–4.
2. `auth.type === "oauth2"` → `OAuthTokenManager.getToken()` → inject `Authorization: Bearer`.
3. `auth.type === "api-key"` → inject `Authorization: Bearer <key>` (or custom header if
   specified in connector metadata).
4. `auth.type === "none"` → no header.

### 5.3 `OAuthTokenManager`

Backed by a per-connector row in `connector_state` keyed `__oauth_token__`.
Handles:
- Token acquisition on first call
- `expires_at` check before each request; refresh if within 60 s of expiry
- Mutex (in-memory per-connector lock) to prevent concurrent refresh races

---

## 6. Phase 4 — Core engine

**Spec:** `specs/sync-engine.md § Ingest Loop`, `§ Diff Engine`, `§ Conflict Resolution`,
`§ Dispatch`, `§ Echo Prevention`

### 6.1 `diff(incoming, shadow)`

Pure function in `core/diff.ts`. Returns `"insert"`, `"update"`, or `"skip"`.

```
if shadow is null → "insert"
if every field in incoming matches shadow[field].val → "skip"
otherwise → "update"
```

Fields absent from `incoming` are not treated as deletions. Sparse updates are valid.

### 6.2 `resolveConflicts(fields, targetShadow, config)`

Pure function in `core/conflict.ts`. Applies per-field strategies from `ConflictConfig`:

- `lww` (default): accept field if `incoming.ts >= targetShadow[field].ts`
- `field_master`: the named connector always wins; other updates to mastered fields dropped
- Per-field overrides in `fieldStrategies` take precedence over the global strategy

Returns only the fields that survive resolution (may be empty set → no write to target).

### 6.3 `ingest(channelId, connectorId, opts?)`

Main pipeline in `core/ingest.ts`. Follows spec `§ Ingest Loop` exactly:

1. Resolve channel + source `ChannelMember`.
2. Get watermark `(connectorId, entity)` → `since`. Undefined on first sync.
3. Call `connector.read(ctx, since)` → `ReadBatch[]`.
4. For `collectOnly` mode: write provisional shadow + identity; no fan-out. Stop.
5. For each record:
   a. Strip `_`-prefixed fields; apply inbound mapping.
   b. Resolve canonical ID (identity_map lookup; field-value matching if `identityFields`
      configured).
   c. Diff against source shadow.
   d. Skip if no changes (echo prevention).
   e. Resolve conflicts per target.
   f. Fan-out to cross-linked targets only (skip provisional connectors — fan-out guard).
      For each eligible target:
        i.   Apply outbound mapping.
        ii.  Look up target's external ID in `identity_map`. New record if absent.
        iii. Call `entity.lookup([id])` if connector declares `lookup()` (ETag threading).
        iv.  Call `target.insert()` or `target.update()`.
        v.   On 412: enter **412 retry loop** (Gap 6 — see §9.1).
        vi.  On success: write target `shadow_state`.
6. Atomic commit: source shadow + all target shadows + identity links + `transaction_log`
   entries + watermark advance — all in one SQLite transaction.
7. Write `sync_runs` row.

Return `IngestResult` (spec shape).

### 6.4 Field mapping

Applied as pure transforms in `core/ingest.ts` before diff. Follows `specs/field-mapping.md`:

- **Inbound**: rename source fields to canonical field names; if `fields` whitelist declared,
  drop fields not in the list.
- **Outbound**: rename canonical fields back; if `fields` whitelist declared on the target
  member, drop fields not in the list.
- `direction` controls whether each individual field mapping applies inbound, outbound, or both.

---

## 7. Phase 5 — Circuit breaker

**Spec:** `specs/safety.md § Circuit Breakers`
**POC gap closed:** Gap 2 — circuit breaker trip state persisted to DB.

### 7.1 State machine

`safety/circuit-breaker.ts`. Three states: `CLOSED`, `OPEN`, `HALF_OPEN`.

Transitions:
- `CLOSED → OPEN`: error rate > threshold after `minSamples` batches.
- `OPEN → HALF_OPEN`: `resetAfterMs` elapsed.
- `HALF_OPEN → CLOSED`: next batch succeeds.
- `HALF_OPEN → OPEN`: next batch fails.

When `OPEN`: `ingest()` aborts before any connector I/O.

### 7.2 Persistence

On every state transition (trip, reset, half-open probe), write a row to
`circuit_breaker_events`. On `SyncEngine` construction, replay recent events for each
channel to restore current state. A restart no longer clears a tripped breaker.

---

## 8. Phase 6 — Discovery and onboarding

**Spec:** `specs/discovery.md`, `specs/sync-engine.md § collectOnly mode`
**POC gaps closed:** Gap 1 (`snapshot_at`), Gap 8 (onboarding safety bypass).

### 8.1 `collectOnly` ingest

`ingest(channelId, connectorId, { collectOnly: true })`. Reads all records; writes
provisional self-only `identity_map` rows and source `shadow_state`. No fan-out.

**Gap 1 fix:** Record `snapshot_at = Date.now()` at the start of the read phase. Pass
`snapshot_at` to `onboard()` / `addConnector()` as the watermark anchor — not `Date.now()`
at commit time. This closes the window where records written after collect-start but before
commit would be missed on the next incremental sync.

### 8.2 `discover(channelId)`

Pure DB query against `shadow_state`. Returns a `DiscoveryReport` with:
- Records present in all connectors → `matched`
- Records unique to one connector → `uniquePerConnector`

No live connector calls after the initial `collectOnly`. Calling `discover()` twice returns
the same result until the next `collectOnly` re-runs.

### 8.3 `onboard(channelId, report, opts?)`

Takes the `DiscoveryReport` produced by `discover()`. Writes:
1. Merge matched provisional canonicals via `dbMergeCanonicals(keepId, dropId)` for each
   matched pair.
2. Route unique-per-side records through `_processRecords` for propagation (not direct
   `entity.insert()`) — **Gap 8 fix**. Onboarding inserts respect the circuit breaker
   pre-flight and write `transaction_log` entries.
3. Advance watermarks using `snapshot_at` from the `collectOnly` call — **Gap 1 fix**.

`dryRun: true` option: run all matching logic, return the report, make no DB writes.

### 8.4 `addConnector(channelId, connectorId, opts?)`

Matches the joining connector's collected snapshot against the existing canonical layer
in `shadow_state`. Returns an `AddConnectorReport`:
- `linked` — matched and committed canonical links
- `newFromJoiner` — records only the joiner has; propagated to all existing members
- `missingInJoiner` — canonicals the joiner does not have; propagated into the joiner

Same `dryRun` and `snapshot_at` semantics as `onboard()`.

---

## 9. Phase 7 — Remaining gap closures

### 9.1 Gap 6 — 412 retry loop

**Spec:** `specs/safety.md § Optimistic Locking`

Inside the dispatch step:

```
call target.update(record)
  → if connector throws ConflictError (412):
      1. Call entity.lookup([externalId]) → fresh record + new version
      2. Update shadow_state with fresh version
      3. Re-compute diff + conflict resolution
      4. Retry target.update() once
      → if still 412: dead-letter with action = 'conflict'
      → if succeeds: continue normally
```

Max one retry per dispatch attempt. Two 412s in a row → dead-letter.

---

## 10. Phase 8 — Integration tests

These tests are the M2 exit criteria from `ROADMAP.md`. They live in
`packages/engine/src/engine.test.ts` (or possibly `tests/integration/`).

Each test:
1. Starts both `mock-crm` and `mock-erp` connectors in-process (no network).
2. Constructs a `SyncEngine` with a fresh in-memory SQLite db.
3. Loads config from a fixture directory under `tests/fixtures/`.

### Test scenarios

| # | Scenario | Exit criterion |
|---|----------|---------------|
| T1 | CRM contact created | Appears in ERP with correct field mapping |
| T2 | ERP contact updated | Reflected in CRM |
| T3 | 10 consecutive sync cycles | Zero duplicates; skipped records on `sync_runs` |
| T4 | 60% of source records deleted | Circuit breaker trips; no propagation |
| T5 | All outbound HTTP observed | Every insert/update has a `request_journal` row |
| T6 | Gap 1: record written mid-collect | Picked up on first incremental after onboard |
| T7 | Gap 2: engine restarted tripped | New instance starts in tripped state |
| T8 | Gap 6: first write returns 412 | Succeeds on retry; one `request_journal` row per attempt |
| T9 | Gap 8: onboard insert blocked | `onboard()` into tripped channel is blocked |

---

## 11. How users run the onboarding flow (no CLI in M2)

M2 ships no CLI. Users write a short project-specific script (similar to the POC
`run.ts` files) that calls `SyncEngine` directly. The sequence below is the canonical
pattern documented for M2 users.

### First-time setup

```ts
import { loadConfig, SyncEngine } from "@opensync/engine";

// 1. Load config from the project root (opensync.json + mappings/)
const config = await loadConfig("./my-sync-project");
const engine = new SyncEngine(config, "./my-sync-project/data/state.db");

// 2. Collect both sides into shadow_state — no fan-out, no writes to connectors
await engine.ingest("contacts", "crm", { collectOnly: true });
await engine.ingest("contacts", "erp", { collectOnly: true });

// 3. Inspect the match report — pure DB read, safe to call repeatedly
const report = await engine.discover("contacts");
console.log(report);
// { matched: [...], uniquePerConnector: { crm: [...], erp: [...] } }

// 4. Dry-run to confirm before committing (optional but recommended)
await engine.onboard("contacts", report, { dryRun: true });

// 5. Commit — merges canonicals, propagates unique records, advances watermarks
await engine.onboard("contacts", report);

// 6. Normal sync loop — ingest each source on a schedule
setInterval(async () => {
  await engine.ingest("contacts", "crm");
  await engine.ingest("contacts", "erp");
}, 30_000);
```

### Adding a third connector to a live channel

```ts
// Collect the new connector into shadow_state — existing channel keeps syncing normally
await engine.ingest("contacts", "newSystem", { collectOnly: true });

// Inspect the join report: linked, newFromJoiner, missingInJoiner counts
const joinReport = await engine.addConnector("contacts", "newSystem", { dryRun: true });
console.log(joinReport);

// Commit — cross-links canonicals, propagates records in both directions
await engine.addConnector("contacts", "newSystem");
// newSystem is now included in every subsequent ingest fan-out automatically
```

**Key properties of this flow:**

- `collectOnly` is always safe — it never fans out and can be re-run without side effects.
- `discover()` reads only from `shadow_state` — it is free to call multiple times and
  returns the same result until the next `collectOnly` re-runs.
- `dryRun: true` is available on both `onboard()` and `addConnector()` — lets the user
  audit matched/unmatched counts before committing any DB writes.
- After `onboard()` the `setInterval` (or any scheduler) is all that is needed; there is
  no further setup step.

The CLI (`opensync collect`, `opensync match`, `opensync link`, `opensync run`) in M3
will wrap exactly this sequence. The underlying API does not change.

---

## 12. What is explicitly out of scope for M2

The following features are deferred to Milestone 3. Do not add them while building M2:

- Rollback (`transaction_log` written but not consumed)
- Webhooks and `processWebhookQueue`
- CLI (`opensync run`, `opensync match`, etc.)
- SDK helpers (pagination, batching, state helpers in `packages/sdk/`)
- Connector cleanup (migrating existing connectors to SDK helpers)
- Connector isolation / distribution packaging
- Hot channel reconfiguration (Gap 9)
- Webhook retry / dead-letter (Gaps 4, 5)
- OAuth2 scope union per entity (Gap 7)
- `prepareRequest` attribution in request journal (Gap 10)

---

## 12. Implementation order

Build bottom-up. Each phase must have passing tests before the next starts.

```
Phase 1  →  DB schema + openDb
Phase 2  →  Config loader + Zod schemas
Phase 3  →  ConnectorContext + tracked fetch + OAuthTokenManager
Phase 4a →  diff() + resolveConflicts() (unit tests, no DB)
Phase 4b →  ingest() wired to real DB (T1, T2, T3)
Phase 5  →  CircuitBreaker + persistence (T4, T7)
Phase 6  →  collectOnly + discover + onboard + addConnector (T6, T8, T9)
Phase 7  →  412 retry loop (T8 companion)
Phase 8  →  Full integration test pass + CHANGELOG + ROADMAP update
```

Run after every phase:

```sh
bun run tsc --noEmit
bun test packages/engine/
```
