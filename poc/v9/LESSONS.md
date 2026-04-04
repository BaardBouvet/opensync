# v9 Lessons Learned

## What v9 was

Resolved the live-I/O coupling that plagued v7 and v8's discover and addConnector
operations. The central insight: separate data collection (ingest into shadow_state) from
identity resolution (discover/onboard/addConnector). After v9, discover() and addConnector()
are pure DB queries — no live connector calls after the initial collectOnly ingest. This
makes the inspect-before-commit workflow repeatable and deterministic.

## What worked

### `collectOnly` ingest as a first-class operation

Making data collection an explicit named mode (`{ collectOnly: true }`) rather than an
implicit first phase of onboarding makes the full flow legible: ingest (collect) → discover
(match report) → onboard (commit links) → ingest (normal sync). Each step has a clear
input and output. Operators understand what to run and in what order. The engine enforces
the order with useful error messages at each step.

### Provisional canonicals make `dbMergeCanonicals` the clean abstraction

Rather than creating fresh UUIDs during onboarding (as v7 and v8 did), v9 writes a
provisional self-only canonical for each record during `collectOnly`. When `onboard()` runs,
it merges the matched provisional canonicals — one side's UUID is kept, the other is
redirected. `dbMergeCanonicals` is a single atomic operation that updates both
`identity_map` and `shadow_state.canonical_id`. The merge-not-create pattern avoids a
whole class of ID proliferation bugs.

### Collected-but-not-linked connectors are invisible to channel status and fan-out

A connector that has been collected but not yet linked via `addConnector` does not
downgrade the channel from `"ready"` — it is simply not a member yet. This allows A and B
to continue syncing normally while C is being onboarded. The fan-out guard
(`crossLinkedConnectors`) skips C on every A and B ingest until `addConnector` commits the
links. This is the correct invisible-until-linked semantics and proved clean to implement.

### `addConnector` catches C up from canonical state — not from re-reading A or B

After `addConnector` commits C's links, it compares C's collected snapshot against the
current canonical field values in shadow_state. Where they diverge (because A or B changed
during the collection window), it calls `C.update()` immediately. C is fully current before
`addConnector` returns; the first normal ingest is a no-op. This catch-up-on-link design
is better than deferring to the next ingest cycle because it makes the committed state
consistent at a single point in time.

### `discover()` is now free to call multiple times with identical results

Because it reads only from `shadow_state`, calling `discover()` twice returns the same
report (until the next `collectOnly` ingest re-runs). This makes dry-run usage safe:
operators can call `onboard(…, { dryRun: true })` repeatedly and the report is always a
snapshot of the collected state, not of live data that may have changed between calls.

## What broke down

### Two engine instances needed for the partial-onboarding scenario

The tests show a pattern where `engineAB` (two-member channel) is used for the initial
onboard, then `engineABC` (three-member channel) is created for the `addConnector` phase.
This is an artefact of the test setup, but it exposes a real concern: the engine's channel
membership is currently baked into its constructor config. In production, adding a connector
to a live channel requires hot-reconfiguring the engine without restarting it. The current
design does not support this — the channel config is static at engine creation time.

### `snapshot_at` anchor is still not implemented — watermark gap persists

v9 acknowledges the watermark timing gap (any records written to the source after the
`collectOnly` ingest but before `onboard()` commits are missed until the next full sync)
but does not fully solve it. The correct fix is to record the exact timestamp at which
`collectOnly` started reading and use that as the new watermark — not `now`. The current
code still advances to `now` on completion, which carries the same gap risk as v7 and v8.
This is the most concrete open production gap from the POC series.

### Unique-per-side propagation bypasses the normal diff pipeline

When `onboard()` propagates a record unique to one side to the other, it calls
`entity.insert()` directly rather than going through `_processRecords`. This means the
normal pipeline (conflict check, idempotency guard, circuit breaker pre-flight) is not
applied to onboarding inserts. For the POC scale this is fine. For production, onboarding
inserts should pass through the same safety checks as normal ingest inserts.

### Entity-level scope union for OAuth2 is deferred

The `OAuthTokenManager` in v9 (inherited from v5/v6) comments that entity-level scope
union is deferred. In practice this means that if one entity in a connector requires
`scope: ["read:contacts"]` and another requires `scope: ["read:orders"]`, all token
requests use only the base scopes declared in the connector's `metadata.auth.oauth2`
config. This can cause silent permission failures for multi-entity connectors. The
union of all entity-required scopes should be used when requesting tokens.
