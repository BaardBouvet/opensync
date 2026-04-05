# Plan: Close Open POC Gaps

> **Status:** backlog — to be scheduled against engine milestones
> **Date:** 2026-04-04
> **Source:** `plans/poc/GAP_POC_LESSONS.md`

Each item below identifies an open gap from the POC series, its origin version,
the spec section it belongs to, and the acceptance criterion for closure.

---

## Gap 1 — `snapshot_at` watermark anchor

**Origin:** v7, v8, v9 (persistently deferred)
**Severity:** correctness — records written during the collect→onboard window can be missed
**Spec:** `specs/sync-engine.md` (ingest loop, watermark advancement)

**Problem:** After `collectOnly` ingest, the watermark is advanced to `now` when `onboard()`
or `addConnector()` completes. Records written to the source between the start of the
`collectOnly` read and the commit are not covered by the new watermark and will only be
picked up at the next full sync.

**Fix:** Record the timestamp at which `collectOnly` begins reading (`snapshot_at`). Use
`snapshot_at` — not `now` — as the watermark after `onboard()` / `addConnector()`. This
closes the window to zero because the watermark covers exactly what was read.

**Acceptance criterion:** A test writes a record to the source after `collectOnly` starts
but before `onboard()` commits. After `onboard()`, a normal incremental `ingest()` must
pick up that record without requiring a full sync.

---

## Gap 2 — Circuit breaker trip state not persisted

**Origin:** v4
**Severity:** safety — a restart clears a tripped breaker, potentially allowing a bad batch to retry
**Spec:** `specs/safety.md` (circuit breakers)

**Problem:** Circuit breaker state lives in memory. A crash or restart while the breaker is
tripped means the engine starts clean and may re-attempt the bad batch before accumulating
enough failures to trip again.

**Fix:** Persist circuit breaker trip events to a `circuit_breaker_events` table. On
startup, load the current state by replaying recent events. The `reset()` operation
writes a reset event rather than clearing in-memory state.

**Acceptance criterion:** Engine trips, process restarts, new engine instance starts in
tripped state without re-processing the bad batch.

---

## Gap 3 — `onEnable` / `onDisable` contract underspecified

**Origin:** v5
**Severity:** correctness — hook errors are silently swallowed
**Spec:** `specs/connector-sdk.md` (lifecycle hooks)

**Problem:** `onEnable` and `onDisable` return `void`. If webhook subscription fails in
`onEnable`, there is no way to surface the error to the engine. The connector appears
enabled but webhooks do not work.

**Fix:** Both hooks must be `async`. Errors thrown from either hook must be caught by the
engine and surfaced as connector health events (not propagated to the ingest loop). Add
`healthCheck()` result annotation: `{ webhooksActive: boolean }`.

**Acceptance criterion:** `onEnable()` throwing an error marks the connector as degraded
in connector health status. `ingest()` still works for the poll-based path.

---

## Gap 4 — Webhook replay not triggered on startup

**Origin:** v5
**Severity:** correctness — unprocessed webhooks are silently skipped after restart
**Spec:** `specs/webhooks.md` (delivery guarantees)

**Problem:** `webhook_queue` rows from a previous run are never drained on engine startup.
Any webhooks received before a crash remain in the queue forever (or until manually
retried).

**Fix:** On engine startup, drain the `webhook_queue` for all enabled connectors before
beginning the first poll cycle. Add a `processedAt` / `status` column to distinguish
unprocessed, processing, and failed rows.

**Acceptance criterion:** Engine crashes mid-queue. On restart, all unprocessed rows
are replayed in FIFO order before the first poll.

---

## Gap 5 — Webhook processing has no retry or dead-letter path

**Origin:** v5
**Severity:** correctness — one bad webhook blocks all subsequent processing
**Spec:** `specs/webhooks.md` (retry, dead-letter)

**Problem:** If a connector's `handleWebhook()` throws, the row is left in
`webhook_queue` with no retry counter, no backoff, and no dead-letter destination.

**Fix:** Add `attempts`, `last_error`, and `status` columns to `webhook_queue`. On
failure: increment `attempts`, apply exponential backoff on next dequeue attempt.
After max attempts: move row to `dead_letter` table with `action = 'webhook'`.

**Acceptance criterion:** A webhook that fails three times is in `dead_letter`. The
queue continues processing subsequent webhook rows.

---

## Gap 6 — 412 Precondition Failed has no retry-after-re-read loop

**Origin:** v6
**Severity:** correctness — a 412 from optimistic locking causes the record to dead-letter unnecessarily
**Spec:** `specs/safety.md` (optimistic locking / ETag threading)

**Problem:** When a connector returns 412 (ETag mismatch), the engine has no mechanism to
re-read the record, update the shadow and version, and retry the dispatch. The error
propagates to the dead letter queue instead of being resolved automatically.

**Fix:** Implement the 412 retry loop: catch `ConflictError` from the dispatch step →
call `entity.lookup([id])` → update `shadow_state.version` → re-compute diff → retry
dispatch once. If the conflict persists after one retry, dead-letter with
`action = 'conflict'`.

**Acceptance criterion:** A connector that returns 412 on first write, then 200 on
second write (after re-read), produces exactly two HTTP calls and a final `update` action
in the ingest result — not a dead-letter entry.

---

## Gap 7 — OAuth2 scope union not computed per entity

**Origin:** v5, v9 (inherited from v5)
**Severity:** correctness — multi-entity connectors may fail silently on scope-protected endpoints
**Spec:** `specs/auth.md` (OAuth2)

**Problem:** The `OAuthTokenManager` uses only the base `scopes` from
`metadata.auth.oauth2`. If individual entities declare additional required scopes,
they are ignored. Token requests do not include those scopes, causing silent 403 failures.

**Fix:** At engine startup, collect `entity.requiredScopes` (new optional field) for all
entities in the connector. The token manager requests the union of base scopes and all
entity scopes.

**Acceptance criterion:** A connector with two entities needing different scopes receives
a token that covers both. A test mocks the token endpoint and asserts the `scope`
parameter includes all required scopes.

---

## Gap 8 — Onboarding inserts bypass the safety pipeline

**Origin:** v9
**Severity:** safety — onboard-time inserts skip circuit breaker and idempotency checks
**Spec:** `specs/sync-engine.md` (ingest loop), `specs/safety.md`

**Problem:** When `onboard()` or `addConnector()` propagates unique records to other
connectors, it calls `entity.insert()` directly rather than routing through
`_processRecords`. This means:
- Circuit breaker pre-flight is not checked
- Idempotency key is not written
- Request journal entry is tagged `action = undefined` instead of `action = 'insert'`

**Fix:** Route onboarding propagation through the same `_processRecords` path as normal
ingest inserts. Mark onboarding-originated inserts with a `source = 'onboard'` tag in
the request journal rather than skipping the pipeline.

**Acceptance criterion:** An `onboard()` insert on a tripped channel is blocked by the
circuit breaker. The insert appears in `request_journal` with `action = 'insert'` and
`batch_id = <onboard batch id>`.

---

## Gap 9 — Hot channel reconfiguration not supported

**Origin:** v9
**Severity:** operational — adding a connector requires an engine restart
**Spec:** `specs/config.md`

**Problem:** Channel membership is static at `SyncEngine` constructor time. Adding a new
connector to a live channel requires creating a new engine instance, which in practice
means a process restart. During restart, inbound webhooks for the existing channel members
may be dropped.

**Fix:** Add `engine.addChannelMember(channelId, connectorConfig)` as a runtime operation.
It registers the new connector instance, updates the channel config in-memory, and is safe
to call while a sync cycle is in progress (new member is only eligible as a target after
`addConnector()` completes).

**Acceptance criterion:** `addChannelMember()` followed by `addConnector()` succeeds
without restarting the engine process. Ingest for existing members continues during the
operation.

---

## Gap 10 — `prepareRequest` errors not attributed in request journal

**Origin:** v6
**Severity:** observability — auth failures in `prepareRequest` are hard to diagnose
**Spec:** `specs/observability.md`, `specs/auth.md`

**Problem:** If `prepareRequest` throws (e.g. HMAC signature generation fails), the error
propagates but the `request_journal` row does not indicate _which_ connector's
`prepareRequest` failed. The row shows a generic error, making debugging difficult.

**Fix:** Catch errors in the `prepareRequest` invocation separately. Write a
`request_journal` row with `status = 'prepare_error'`, `connector_id`, and the error
message before re-throwing.

**Acceptance criterion:** A failing `prepareRequest` produces a `request_journal` row
with `connector_id` set and `status = 'prepare_error'`. The connector health status
reflects the failure.

---

## Scheduling

Items should be addressed against milestones as follows:

| Gap | Milestone | Priority |
|-----|-----------|---------|
| Gap 1 — snapshot_at watermark | M2 | high — correctness |
| Gap 2 — circuit breaker persistence | M2 | high — safety |
| Gap 3 — onEnable/onDisable contract | M1 (SDK) | medium — connector contract |
| Gap 6 — 412 retry loop | M2 | high — correctness (spec already written) |
| Gap 8 — onboarding bypass safety | M2 | high — safety |
| Gap 4 — webhook replay on startup | M3 | medium — delivery guarantee |
| Gap 5 — webhook retry / dead-letter | M3 | medium — delivery guarantee |
| Gap 7 — OAuth2 scope union | M3 | medium — correctness |
| Gap 9 — hot reconfiguration | M3 | low — operational |
| Gap 10 — prepareRequest attribution | M3 | low — observability |
