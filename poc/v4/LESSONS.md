# v4 Lessons Learned

## What v4 was

Replaced the in-memory JSON state blob with a real SQLite database via a Drizzle adapter.
Established the minimal four-table schema: `identity_map`, `watermarks`, `shadow_state`,
`connector_state`. Introduced circuit breakers, conflict resolution, and an event bus.
Shifted the sync loop from directed-pair iteration to per-source fan-out (`ingest()`).

## What worked

### The `shadow_state` table is the right central abstraction

Storing every record's last-known canonical form in a SQLite table rather than a JSON
blob proved the hub-and-spoke architecture works in practice. Key benefits realised:

- **Queryable** — `SELECT * FROM shadow_state WHERE connector_id = ?` is instant
- **Fan-out becomes simple** — `ingest()` reads source, diffs against `shadow_state`,
  dispatches deltas to all other members
- **`lastWritten` replaced** — shadow state serves the same purpose as v3's `lastWritten`
  with the added property that it's persisted in a queryable form

### Per-source watermarks (`connectorId:entity`) replace directed-pair keys

Changing from `"A→B:customers"` to `"A:customers"` means a source connector is read
once per cycle regardless of how many targets it feeds. The old directed-pair key
caused redundant reads when multiple targets existed.

### Drizzle adapter pattern works

The engine types against Drizzle's `BaseSQLiteDatabase` interface. The concrete
driver (`better-sqlite3` vs `bun:sqlite`) is injected at startup via `openDb()`.
No engine code changed when switching drivers. This is the correct abstraction.

### Circuit breaker as a stateless wrapper

The circuit breaker wraps the dispatch loop, not the connector. It evaluates the
error rate across recent batches and trips before dispatching when the rate exceeds
the threshold. Stateless per-engine-instance design is correct for the POC; the
only known production gap is that trip events aren't persisted to the DB (so a
restart clears a tripped breaker).

## What broke down

### `conflict` module introduced complexity without production-ready resolution

v4 added a `resolveConflicts` function that applies per-field conflict rules (last-write-wins,
source-wins, merge). The interface was correct but the rules engine was thin — it couldn't
express "if both sides changed, prefer CRM" without hardcoded logic. The spec
(`specs/safety.md`) defines the full resolution model; v4 only validated the hookup points.

### Event bus is fire-and-forget

The event bus emitted field diff events but nothing consumed them in v4 beyond logging.
The production use case — triggering action connectors — was not validated until v7.

### No webhook receiver yet

v4's engine internals were ready to receive webhooks (the queue model was designed)
but there was no HTTP server to receive them. Validated in v5.

### Circuit breaker state lost on restart

As noted above, trip events live in memory. A crash during a tripped state means the
engine starts clean on restart and may re-attempt bad batches before accumulating
enough failures to trip again. Production fix: persist `circuit_breaker_events` to DB.
