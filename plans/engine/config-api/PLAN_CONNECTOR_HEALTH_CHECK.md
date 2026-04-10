# PLAN_CONNECTOR_HEALTH_CHECK — Engine-driven connector health checks

**Status:** draft  
**Date:** 2026-04-09  
**Effort:** S  
**Domain:** Engine API  
**Scope:** `packages/engine/src/`, `specs/sync-engine.md`, `specs/connector-sdk.md`, `specs/observability.md`, `specs/database.md`  
**Spec changes planned:**  
- `specs/sync-engine.md` — new `§ Health Checks`: `checkHealth()`, polling, `ConnectorHealthResult`, timeout semantics  
- `specs/connector-sdk.md` — expand the one-liner `## Health Checks` section: `HealthStatus` field semantics, intent, and error handling expectations  
- `specs/observability.md` — reference `connector_health` table as part of the observability picture  
- `specs/database.md` — new `### connector_health` sub-section with full table schema and upsert semantics  

---

## § 1 Problem Statement

The `Connector` interface already declares:

```typescript
healthCheck?(ctx: ConnectorContext): Promise<HealthStatus>;
```

Every distributed connector in the repo implements it (HubSpot, Postgres, Kafka, SPARQL,
Tripletex, WaveApps). `specs/connector-sdk.md` says it is "called periodically by the
engine" — but the engine never calls it.

Consequences:
- No way to probe whether a connector can reach its backing service without running a full
  `ingest()` cycle, which reads potentially large volumes of records.
- Misconfigured connectors (bad API key, unreachable endpoint) are only discovered when
  the first sync attempt fails and surfaces as a batch error rather than a clear
  connectivity signal.
- `opensync status` has nowhere to read connector health from.
- The spec makes a promise the implementation does not keep.

---

## § 2 Design

### § 2.1 `ConnectorHealthResult` (engine public type)

A richer wrapper around `HealthStatus` that adds engine-level metadata:

```typescript
export interface ConnectorHealthResult {
  instanceId:  string;
  healthy:     boolean;
  message?:    string;
  details?:    Record<string, unknown>;
  checkedAt:   string;   // ISO 8601
  durationMs:  number;
}
```

This is an engine output type analogous to `RecordSyncResult` — it lives in
`packages/engine/src/engine.ts` and is re-exported from `packages/engine/src/index.ts`.
The `HealthStatus` type on the SDK side is unchanged.

### § 2.2 `SyncEngine.checkHealth(instanceId?: string): Promise<ConnectorHealthResult[]>`

On-demand probe:

- Called with no argument → probe all registered connector instances in parallel.
- Called with a specific `instanceId` → probe that instance only (throws if unknown).
- Each call is wrapped in `Promise.race` against a configurable timeout (see § 2.3).
- If the connector does not implement `healthCheck`, the engine synthesises:
  `{ healthy: true, message: "no health check implemented" }`. Absence is not failure.
- An exception thrown by `healthCheck()` is caught; the engine synthesises:
  `{ healthy: false, message: err.message }`.
- Each result is upserted into `connector_health` (§ 2.4) and returned.

### § 2.3 Timeout

Health checks run against the same `readTimeoutMs` value already present on
`ResolvedConfig`. No new config field is added now — the check is lightweight by design
(one HTTP call or one `SELECT 1`). If callers need a different budget, that can be added
as `healthCheckTimeoutMs` in a follow-on.

On timeout the engine synthesises:
```
{ healthy: false, message: "health check timed out" }
```

### § 2.4 Periodic polling

```typescript
class SyncEngine {
  startHealthPolling(intervalMs: number): void;
  stopHealthPolling(): void;
}
```

Starts a repeating timer that calls `checkHealth()` every `intervalMs` milliseconds.
No automatic start — callers opt in explicitly.

The timer is stored on the engine instance and cleared by `stopHealthPolling()`. If the
caller never calls `stopHealthPolling()`, the reference is released when the engine
instance is garbage collected (the timer holds no strong reference back).

### § 2.5 `connector_health` table

One row per connector instance, upserted on every check. No history retention at this
stage — history is derivable from the request journal when `healthCheck` uses `ctx.http`.

```sql
CREATE TABLE IF NOT EXISTS connector_health (
  connector_instance_id  TEXT PRIMARY KEY,
  healthy                INTEGER NOT NULL,   -- 1 = healthy, 0 = unhealthy
  message                TEXT,
  details                TEXT,               -- JSON blob or NULL
  checked_at             TEXT NOT NULL,      -- ISO 8601
  duration_ms            INTEGER NOT NULL
);
```

---

## § 3 Implementation Steps

1. **DB**: Add the `connector_health` table to
   `packages/engine/src/db/migrations.ts` (`CREATE TABLE IF NOT EXISTS`).

2. **Queries**: Add `dbUpsertConnectorHealth` and `dbGetConnectorHealth` to
   `packages/engine/src/db/queries.ts`.

3. **Engine**: Implement `checkHealth(instanceId?)` and
   `startHealthPolling` / `stopHealthPolling` on `SyncEngine` in
   `packages/engine/src/engine.ts`.

4. **Exports**: Export `ConnectorHealthResult` from `packages/engine/src/index.ts`.

5. **Tests** in `packages/engine/src/engine.test.ts`:
   - Returns `healthy: true` when connector `healthCheck` resolves OK.
   - Returns `healthy: false` and captures `message` when connector throws.
   - Returns timed-out result when `healthCheck` hangs past `readTimeoutMs`.
   - Persists the result to the `connector_health` table after each call.
   - Connector with no `healthCheck` returns synthetic `healthy: true`.
   - `checkHealth(instanceId)` probes only the named instance.
   - `startHealthPolling` fires `checkHealth` at the specified interval.

6. **Spec updates**: Update the four spec files listed in the header (§ 4 below).

---

## § 4 Spec Changes Planned

| Spec | Change |
|------|--------|
| `specs/sync-engine.md` | New `## § Health Checks` section: `checkHealth()` signature, polling API, `ConnectorHealthResult` type, timeout, fallback for connectors without `healthCheck` |
| `specs/connector-sdk.md` | Expand the one-liner under `## Health Checks` into a full section: what `HealthStatus.healthy: false` means vs. a thrown exception, what the check should probe (lowest-cost reachability test), and what to avoid (full reads, mutations) |
| `specs/observability.md` | New sub-section referencing `connector_health` as the source of per-connector reachability state; note that request journal rows from `ctx.http` inside `healthCheck` are tagged normally |
| `specs/database.md` | New `### connector_health` sub-section with full DDL and upsert semantics |

---

## § 5 Open Questions

- **`healthCheckTimeoutMs` config field** — re-using `readTimeoutMs` is correct for now.
  Add a separate field only when callers have demonstrated they need a different budget for
  health checks vs. reads.

- **SyncEvent integration** — health state changes could emit a structured event, but
  `SyncEvent` covers record-level data flow and mixing health signals in would muddy that
  contract. Revisit when `PLAN_ENGINE_API_ERGONOMICS.md` tackles the event callback shape.

- **`opensync status` CLI** — reading from `connector_health` to display reachability in
  `opensync status` is a natural follow-on captured in `specs/cli.md`. Not in scope here.
