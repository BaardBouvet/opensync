# GAP: Engine Decisions Missing from Specs

**Status:** Open — items listed below need spec coverage or explicit documentation  
**Date:** 2026-04-04  
**Type:** gap report  
**Scope:** `packages/engine/` (M2 implementation) vs. all `specs/`  

This report captures major architectural decisions made during the M2 engine implementation
that are not (or were not) reflected in any spec. The goal is to ensure the spec set fully
describes the current system.

---

## Database Schema Gaps

### GAP-E1: `circuit_breaker_events` table not in `database.md`

**Engine**: Creates and uses `circuit_breaker_events (id, channel_id, event, reason, occurred_at)`
in `packages/engine/src/db/migrations.ts`  
**Spec**: Table was absent from `database.md`

**Resolution**: Added to `specs/database.md`.

---

### GAP-E2: `channel_onboarding_status` table — spec said "not present", but engine creates it

**Engine**: Creates `channel_onboarding_status (channel_id, entity, marked_ready_at)` and uses
it in `packages/engine/src/db/queries.ts` to record when each channel/entity pair was first
onboarded  
**Spec**: `database.md` had a section titled "No `channel_onboarding_status` Table" stating it
was removed in favor of the identity_map cross-link query

**Resolution**: The table was reintroduced in a leaner form (no `ready` flag, just a timestamp).
The spec section has been replaced with the correct table definition in `specs/database.md`.

---

### GAP-E3: `webhook_queue` in spec, not in engine

**Spec**: `database.md` documents a `webhook_queue` table for queue-first webhook processing  
**Engine**: No such table created or used in M2 engine

**Resolution**: The table remains in the spec as a forward-looking design for the webhooks
feature (`specs/webhooks.md`). It is not yet implemented. A note should be added to the
webhook_queue entry in database.md when it is built.

---

### GAP-E4: `onboarding_log` in spec, not in engine

**Spec**: `database.md` documents an `onboarding_log` table for `discover/onboard/addConnector`
diagnostics  
**Engine**: No such table created or used in M2 engine

**Resolution**: Same as GAP-E3 — forward-looking design. No action needed until the
observability feature is built.

---

## SQLite Adapter Architecture

### GAP-E5: Drizzle ORM listed in `overview.md` and `database.md` — actually a hand-rolled adapter

**Pre-POC decision**: Use Drizzle ORM for type-safe queries  
**Actual implementation**: Custom `Db` interface with a single `exec(sql: string): void` method.
`openDb()` detects the runtime and returns either `bun:sqlite` or `better-sqlite3` wrapped in
a thin adapter. No Drizzle.

**Resolution**: Removed from `overview.md` tech stack. Old SQLite Adapter section in
`database.md` deleted.

---

## OAuth Token Storage

### GAP-E6: OAuth tokens stored in dedicated `oauth_tokens` table, not in `connector_state`

**Historical confusion**: A prior design note suggested OAuth tokens could be stored as a
`__oauth_token__` key in `connector_state`. This was never implemented.  
**Actual implementation**: `packages/engine/src/auth/http.ts` — `OAuthTokenManager` uses
`dbGetOAuthToken`, `dbUpsertOAuthToken`, `dbAcquireOAuthLock`, `dbReleaseOAuthLock`, all
operating directly on the `oauth_tokens` table.

**Why a dedicated table?** The `locked_at` column implements a SQLite-serialised mutex for
concurrent-safe token refresh (UPDATE + changes === 1 pattern). This pattern cannot be cleanly
implemented using a generic KV store like `connector_state`.

**Connectors cannot access `oauth_tokens`**: This table is engine-internal. Connectors never
receive tokens directly — they call `ctx.http()` and auth is injected automatically.

**Resolution**: Clarified in `specs/auth.md`. See the `oauth_tokens` table entry in
`specs/database.md` for the lock protocol.

---

## Snapshot Watermark (IngestResult)

### GAP-E7: `IngestResult.snapshotAt` not in any spec

**Engine**: `_ingestConnector` returns `{ inserted, updated, skipped, deferred, errors, snapshotAt }`
where `snapshotAt` is the batch's last-ingested watermark. Used by `processConnector` to advance
the stored watermark atomically with the shadow state write.  
**Spec**: `sync-engine.md` and `connector-sdk.md` describe watermark semantics (`since` on
`ReadBatch`) but don't mention `snapshotAt` on the internal result object.

**Recommendation**: Add `snapshotAt` to `sync-engine.md §` Ingest Loop or a new §  Internal
Result Types section. This is an engine-internal type, not visible to connector authors.

---

## 412 Conditional Write Retry

### GAP-E8: ETag / If-Match retry pattern documented in connector, not in spec

**Engine / connector**: `connectors/mock-erp` implements a full `If-Match` ETag round trip:
`lookup()` returns `version` (the ETag), `update()` sends `If-Match: <version>`, and the mock
ERP server returns 412 on mismatch. The connector retries with a fresh `lookup()`.  
**Spec**: `connector-sdk.md` mentions `version` on `UpdateRecord` (now fixed) but doesn't
describe the 412 retry pattern or the lookup → version → If-Match flow.

**Recommendation**: Add a subsection to `connector-sdk.md` "Conditional Writes (ETag / If-Match)"
explaining the pattern. Link from `sync-engine.md` conflict detection section.

---

## Circuit Breaker Persistence

### GAP-E9: Circuit breaker state persisted to `circuit_breaker_events` — spec says in-memory

**Engine**: Circuit breaker events are persisted to `circuit_breaker_events` table (GAP-E1).
Trip state is reconstructed at startup from the event log.  
**Spec**: `safety.md` describes the circuit breaker state machine but does not specify whether
state is in-memory or persistent.

**Recommendation**: Add a note to `specs/safety.md` clarifying that the trip event and reset
event are persisted, not held in memory, so restarts don't silently reset a tripped circuit.

---

## No Drizzle Migrations — Schema is Append-Only

### GAP-E10: `database.md` old section referenced Drizzle Kit migrations — no migration system exists

**Pre-POC decision**: Use Drizzle Kit to generate numbered migration files  
**Actual**: No migration system. `createSchema()` uses `CREATE TABLE IF NOT EXISTS` — fully
idempotent. All schema changes before first release are done by modifying `migrations.ts`
directly (dropping and recreating tables is acceptable pre-release).

**Resolution**: Old Drizzle migrations reference removed from `database.md`. See
`plans/PLAN_DB_MIGRATIONS.md` for the post-release migration strategy.
