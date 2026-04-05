# Gap Report: OpenSync vs grove/in-and-out

> **Status:** reference
> **Date:** 2026-04-03
> **Reviewed:** https://github.com/grove/in-and-out
> **Scope:** feature parity review — things in-and-out has that OpenSync is missing or underspecified

---

## Context

Both projects are bidirectional data synchronisation engines, but they take different approaches:

| Dimension | OpenSync | grove/in-and-out |
|-----------|----------|------------------|
| Language | TypeScript / Bun | Python |
| Config | Code-first (TypeScript connectors) | Declarative YAML connectors |
| State store | SQLite (shadow state) | PostgreSQL |
| Architecture | N-way hub-and-spoke (all systems equal) | Ingestion daemon → PostgreSQL → OSI-Mapping → Writeback daemon |
| Conflict model | Field-level LWW + master rules | 3-way comparison (base / current / desired) with tiered protection levels |
| Deployment | npm package / binary | Docker / Kubernetes first |

The comparison focuses on operationally significant features where in-and-out is ahead. OpenSync's unique strengths (N-way sync, TypeScript connectors, rollback, agent-generated connectors) are noted at the end.

---

## Gaps — Missing or Underspecified in OpenSync

### 1. Writeback Architecture (Desired-State Tables)

in-and-out has a formal writeback contract built on **desired-state tables** populated by an upstream MDM layer:

- `action` column: `insert | update | delete | archive | upsert | noop`
- `cluster_id`: upstream identity from OSI-Mapping
- `data` (JSONB): what to write
- `base` (JSONB, nullable): what the target system looked like *when the MDM computed the change* — the critical input for 3-way conflict detection

OpenSync dispatches changes reactively when a diff is detected, without a formal desired-state contract. There is no `base` snapshot, no `last-written-state` table, and no 3-way comparison.

**What to add:**
- A formal writeback queue / desired-state model (even lightweight)
- A `base` field on outbound change records for conflict detection
- A `last-written-state` store that is updated after every confirmed write (and after observing any external conflict)

---

### 2. Pre-Flight Read + 3-Way Conflict Detection

in-and-out mandates a **mandatory pre-flight read** before every write (update/delete/archive). It then does a 3-way comparison:

1. Current state (from pre-flight read) vs. `base` (MDM's snapshot) → no external change → safe to write
2. Current ≠ base but current = last-written state → own prior write caused the diff → safe to write
3. Current ≠ base and current ≠ last-written → external actor modified the record → **conflict**

Additionally, when the target supports ETags or `If-Match`, those are carried from the pre-flight read into the write request to close the TOCTOU window.

OpenSync detects *inbound* external changes via hash comparison against shadow state, but there is no equivalent mandatory pre-flight read for *outbound* writes.

**What to add:**
- Pre-flight read step in the dispatch/write path
- 3-way comparison logic
- ETag / `If-Match` conditional write support in connectors and engine

---

### 3. Write-Anomaly Protection Levels

in-and-out defines three explicit tiers per connector:

- **Level 1**: Target supports conditional writes (ETags/If-Match) → TOCTOU window fully closed
- **Level 2**: No conditional write support → pre-flight read + 3-way comparison only; residual TOCTOU window documented
- **Level 3**: Level 2 + post-write verification read to catch anything that slipped through

Connectors must declare which level they operate at. The validator checks this at validation mode.

OpenSync has no equivalent tiered safety guarantee or connector-level declaration.

---

### 4. Dead-Letter Queue

in-and-out routes permanently failed writes to per-datatype dead-letter tables after retries are exhausted. Each entry includes:
- Original desired-state record
- Full HTTP error response
- Timestamp of first failure, retry count, diagnostic context
- Replayable via the runtime control table

OpenSync has error logging but no formal dead-letter queue with replay capability.

**What to add:**
- `dead_letter` table (or equivalent) in the database schema
- CLI commands: inspect DLQ, replay specific entries, bulk replay
- Configurable max retries before routing to DLQ per connector/datatype

---

### 5. Runtime Control Table

in-and-out exposes a **PostgreSQL control table** that operators interact with without restarting the process:

| Command | Meaning |
|---------|---------|
| `resync` | Trigger re-sync for a specific connector/datatype (or single `external_id`) |
| `pause` | Halt processing for a connector |
| `resume` | Resume a paused connector |
| `reset-watermark` | Force full re-sync by resetting high-water mark |
| `reload-config` | Hot-reload connector config without restart |
| `reset-circuit-breaker` | Manually reset an open circuit breaker |
| `replay-dead-letter` | Replay specific DLQ entries |
| `validate` | Trigger non-destructive connector validation |
| `drain` | Graceful shutdown of a single connector |

The table schema includes `issued_by` for audit, acknowledged/completed timestamps, and status tracking.

OpenSync's circuit breakers are resetable, but there is no general-purpose runtime control plane. Operator interactions go through raw SQL or the CLI only.

**What to add:**
- `sync_control` table (analogous to `inout_ops_control`)
- Both daemons (if/when opensync becomes a long-lived daemon) poll it
- Targeted single-record resync command (useful when a writeback conflict triggers re-ingestion)

---

### 6. Intra-Sync Checkpointing

in-and-out checkpoints progress **within** a sync run, not only between runs. A full sync across millions of records resumes from the checkpoint on restart, not from scratch. Checkpoint granularity is configurable per datatype (`every_n_records`, `every_n_pages`).

The watermark is updated **atomically in the same database transaction** as the data write — so a crash can never produce a watermark ahead of the actually-written data.

OpenSync has a persistent watermark table but the atomicity guarantee and intra-run checkpointing are not specified.

**What to add:**
- Specify and enforce watermark-update atomicity (same transaction as data write)
- Add checkpoint granularity config (`every_n_records`)
- Track `last_checkpoint_external_id` per sync run for resumption

---

### 7. Persistent Daemon Architecture + Graceful Shutdown

in-and-out runs as two long-lived **daemon processes** (ingestion and writeback). On `SIGTERM`/`SIGINT`:
- Complete in-flight HTTP requests
- Commit the current page or batch before exiting
- Never drop a partially-fetched page
- Maximum drain time is configurable; after it elapses, exit with a warning

OpenSync is unspecified on this. It appears to run as short-lived tasks or on-demand rather than as a persistent daemon.

**What to add:**
- Daemon mode with an event loop
- Graceful shutdown signal handler
- Configurable `drain_timeout`

---

### 8. Multi-Instance High Availability

in-and-out is designed for concurrent instances. Cross-instance concurrency control uses **PostgreSQL advisory locks** — not in-process mutexes — so the guarantee holds across restarts and separate processes. At most one instance may hold the lock for a given connector/datatype pair.

OpenSync does not address multi-instance deployment.

**What to add:**
- Distributed lock strategy (advisory locks if PostgreSQL, or a lightweight equivalent for SQLite+litestream)
- Document that in-process locks are insufficient for HA deployments

---

### 9. Configuration Hot-Reloading

in-and-out picks up modified connector YAML at the start of the next sync cycle — no full process restart needed. Operators can also trigger an explicit reload via the control table. Schema-changing reloads require a migration step and are rejected if not migrated first.

OpenSync has no equivalent mechanism.

**What to add:**
- File-watcher or poll-on-cycle for `openlink.json` + mapping files
- Control table command: `reload-config`
- Guard against hot-reloads that require schema migrations

---

### 10. Health & Readiness Endpoints

in-and-out exposes two standard HTTP endpoints on a **separate internal port** (not the webhook receiver port):

- `GET /health` — liveness: responds 200 while the process can self-recover; must respond within 1s
- `GET /ready` — readiness: 200 when startup is complete, DB connected, replication slot attached; includes JSON with per-connector state

OpenSync's `WebhookServer` exposes `GET /health` on the webhook port (combined), with no readiness endpoint.

**What to add:**
- Separate health server port
- Readiness endpoint with per-connector status (active / paused / circuit-breaker-open)
- Liveness vs readiness semantics

---

### 11. Prometheus Metrics + OpenTelemetry Traces

in-and-out exports a Prometheus-compatible `/metrics` endpoint and emits OpenTelemetry trace spans per sync operation. Minimum required metrics include:

- Sync lag per datatype
- Records processed/skipped/errored per run
- HTTP error rates by status code, connector, datatype
- Queue depth / backlog
- Replication slot lag
- Circuit breaker state (open/closed/half-open) per connector
- Dead-letter queue depth

OpenSync has structured pino logging and a pipeline result struct, but no Prometheus endpoint and no OTEL traces.

**What to add:**
- Prometheus metrics via a `/metrics` endpoint (or push to a collector)
- OTEL span per sync cycle with `connector`, `datatype`, `mode` attributes
- `sync_run_id` on every log entry (already on the correlation ID concept, but make it explicit)

---

### 12. GDPR / PII Field Handling

in-and-out requires:

- **Field-level masking** in logs and audit tables (configurable per connector, declarative)
- **Targeted purge by `external_id`**: tombstone records, last-written-state entries, DLQ entries, and audit logs must all support deletion of a specific individual's data
- **PII field annotation** in connector schema so downstream governance tooling can classify sensitive fields

OpenSync mentions configurable retention and connector-level masking flags but does not define a purge-by-external-id pathway or a PII annotation mechanism.

**What to add:**
- PII flag on connector field declarations
- `opensync purge <external-id>` CLI command that cascades across all tables
- Ensure purge is compatible with retention policies (purge takes immediate precedence)

---

### 13. Retention Policies + Housekeeping

in-and-out has configurable retention for all operational tables:
- `sync_run_log`: default 90 days
- `dead_letter`: default 30 days
- `history_table` (append-mode): default 365 days
- `desired_state_processed`: default 30 days

A scheduled housekeeping job purges rows beyond the retention threshold without touching unprocessed rows or open sync-run records.

OpenSync mentions a 30-day retention for the request journal but has no general retention/housekeeping architecture.

**What to add:**
- Per-table retention config in `openlink.json` or global config
- Housekeeping background job (or cron command)
- Guard against deleting in-use rows

---

### 14. Connector Validation Mode (Dry-Run)

in-and-out has a non-destructive `validate-connector` command that:
1. Checks config syntax (structural validation with rule IDs like `CFG-001`)
2. Resolves credentials
3. Tests connectivity (lightweight request to base URL)
4. Dry-run single-page fetch (real HTTP request, no data persisted)
5. Checks conditional-write support for writeback
6. Validates field mappings
7. Outputs machine-readable JSON with `rule_id`, `severity`, `path`, `message`, `suggested_fix`

OpenSync has no equivalent. The CLI has a `validate` command mentioned in specs but not fleshed out with rule IDs, dry-run fetch, or machine-readable output.

**What to add:**
- `opensync validate <connector>` with staged checks
- Machine-readable JSON output format with stable rule IDs
- Dry-run fetch mode (real HTTP, no DB writes)
- Writeback dry-run mode (all logic executes, no HTTP writes sent)

---

### 15. Schema Versioning for Config Files

in-and-out requires `schema_version: 1` at the top of every connector YAML. The loader rejects incompatible versions with a clear error. This enables future automated migration tooling.

OpenSync's `openlink.json` has no version field.

**What to add:**
- `schemaVersion` field in `openlink.json`
- Version check at startup with a clear error message if incompatible
- Migrations must be explicit, never auto-applied at startup

---

### 16. Bulk Export API Support

in-and-out supports async bulk/batch export endpoints (e.g., Salesforce Bulk API, HubSpot batch read):
- Submit export job
- Poll for completion
- Download result set
- Route through the same deduplication/checkpointing/schema-tracking pipelines as incremental fetches

OpenSync has no equivalent. All fetching is record-by-record or page-by-page.

---

### 17. Delta-Only Sources

in-and-out handles sources that only provide a stream of changes with no full-snapshot endpoint. These are accumulated locally; the cursor is never reset (resetting would lose data permanently).

OpenSync does not address this source type explicitly.

---

### 18. Timestamp Normalisation

in-and-out normalises all ingested timestamps to UTC `timestamptz` before storage. The expected source format for each timestamp field is declaratively configurable per connector:
- `epoch_s`, `epoch_ms`, `iso8601`, `rfc2822`, `custom`

Normalisation failures are logged and never silently store an incorrect value.

OpenSync stores timestamps using connector-provided values with no normalisation layer.

---

### 19. Pagination Drift Protection

in-and-out addresses the classic page-drift problem (records added/deleted mid-paginated fetch corrupt the result set). Mitigations:
- Prefer server-side snapshot cursors when the API supports them
- Detect anomalies in record counts across pages and trigger the circuit breaker
- Post-fetch reconciliation pass after a complete paginated result set

OpenSync's pagination is handled per connector in TypeScript code; there is no engine-level drift detection.

---

### 20. Out-of-Order Event Handling

in-and-out specifies three configurable strategies for webhook events arriving out of order:
- `accept_latest_timestamp` (default)
- `accept_highest_sequence`
- `buffer_and_reorder` (with configurable buffer window)

OpenSync suppresses stale events via hash/shadow comparison but does not define explicit ordering strategies for out-of-order scenarios.

---

### 21. Webhook IP Allowlist

in-and-out supports per-connector IP allowlists for the inbound webhook receiver. Requests from unlisted IPs are rejected before payload processing.

OpenSync has signature verification but no IP allowlist.

---

### 22. Multi-Tenancy

in-and-out has a first-class `tenancy` config block per connector:
- `mode: single | multi`
- Declarative tenant scope injection: header, query param, or path segment

OpenSync assumes a single account per connector instance. Multi-tenancy would require multiple connector instances.

---

### 23. Write Ordering + Dependency Ordering

in-and-out specifies:
- **Write ordering per record**: multiple desired-state updates for the same record are processed strictly in order; older updates are demoted when a newer one is in flight.
- **Dependency ordering across records in a batch**: topological sort by declared dependencies (e.g., parent accounts before child contacts). Cyclic dependencies halt the entire dependency group and are reported as config errors — never resolved heuristically.

OpenSync dispatches in parallel; there is no topological sort or per-record ordering guarantee.

---

### 24. Partial-Success Batch Response Handling

in-and-out declaratively parses mixed success/failure batch responses (e.g., HTTP 207 with per-record outcomes). Only truly failed records are retried; confirmed successes are not re-sent.

OpenSync has no equivalent for batch writes.

---

### 25. Soft-Delete Resurrection

in-and-out: if a tombstoned record's `external_id` reappears (new object created with same ID), the ingestion tool detects this and transitions the record back to active state. The previous deletion metadata is preserved in history (append mode) for audit.

OpenSync has soft delete detection but no explicit resurrection handling.

---

### 26. API Version Management

in-and-out supports:
- `api_version` declared per connector (and overridable per datatype for transitions)
- `api_deprecation_deadline`: emit WARN-level logs on every sync cycle as the deadline approaches (within 90 days)

OpenSync has no API version tracking or deprecation warning mechanism.

---

### 27. Source Version / ETag Tracking per Record

in-and-out stores `source_version` (ETag or version field) per ingested record when the source API provides it. This is used as one leg of the 3-way conflict detection.

OpenSync tracks `{ val, prev, ts, src }` field-level metadata but does not store source ETags.

---

### 28. Operator Action Audit Trail

in-and-out requires that every operator-initiated action (control table command, CLI invocation, migration) produces a durable audit record with `issued_by`, timestamps, and outcome.

OpenSync has a transaction log for data changes but no equivalent operator audit trail.

---

### 29. Schema Migration Coordination

in-and-out uses **Alembic** for explicit schema migrations. Key rules:
- Migrations are **never** auto-applied at startup
- Both tools enforce a schema-version check at startup and refuse to start if the DB schema is incompatible
- Changes that alter table schemas require a separate migration step and cannot be hot-reloaded silently

OpenSync uses Drizzle ORM but the migration discipline (explicit-only, version-check at startup, coordination across tools) is not specified.

---

### 30. Connector Generation Profiles + Golden Fixtures

in-and-out defines four **generation profiles** for AI/agent-generated connectors:
- `ingestion_polling_readonly`
- `ingestion_webhook_incremental`
- `writeback_patch`
- `full_duplex`

Each profile has a required path list, canonical serialisation order, and a JSON Schema artifact in `schemas/`. Golden fixtures (`fixtures/connectors/valid/` and `fixtures/connectors/invalid/`) with expected error manifests ensure generated connectors are valid.

OpenSync's `agent-assistance.md` covers agent-generated TypeScript connectors but has no generation profiles, required path lists, or golden fixtures.

**What to add:**
- Generation profiles for connectors (even in YAML or TypeScript scaffold form)
- `fixtures/connectors/valid/` and `fixtures/connectors/invalid/` with `.errors.json` manifests
- JSON Schema (or Zod schema) for the connector config format, published in-repo

---

### 31. Containerised Deployment

in-and-out ships:
- `Dockerfile` per tool
- `docker-compose.yml` + `docker-compose.observability.yml`
- `k8s/` Kubernetes manifests
- CI/CD GitHub Actions workflow for automated builds and Docker image publishing to GHCR

OpenSync's distribution targets are an npm package and a compiled binary. There is no Docker or Kubernetes configuration.

---

### 32. Simulator Framework

in-and-out specifies a **simulator contract**: a configurable HTTP stub server interface that any connector can implement to provide a fake external system for testing without live credentials. Each connector's test suite ships with a reference simulator covering pagination, auth flows, webhooks, error conditions, and rate-limit responses.

OpenSync has mock connector implementations in `connectors/jsonfiles/` but no structured simulator interface contract, no per-connector simulator test suite structure, and no guidance on simulator-backed CI.

---

## OpenSync Strengths Not Present in in-and-out

For completeness, noteworthy features OpenSync has that in-and-out does not:

| Feature | Notes |
|---------|-------|
| **N-way hub-and-spoke sync** | Changes from any system propagate to all others through the hub. in-and-out is ingestion-to-PostgreSQL-to-writeback; N-way fan-out requires OSI-Mapping in between. |
| **Rollback / undo** | Single record, batch, or full rollback via the transaction log. in-and-out has no undo mechanism. |
| **TypeScript code connectors** | More expressive than YAML; AI can generate connector code naturally. |
| **Actions / event bus** | Workflow triggers, webhooks-out, event-driven automation — a superset of writeback. in-and-out is pure HTTP sync. |
| **Discovery / onboarding** | Fuzzy, exact, and composite matching to link incoming records to existing entities. |
| **Loop / oscillation detection** | DEGRADED state for per-record oscillations before tripping the whole channel. |
| **Field-level `{ val, prev, ts, src }` metadata** | Richer per-field provenance than in-and-out's JSONB columns. |
| **Graph / triple-store backend (planned)** | Pluggable backend architecture supports future RDF/SPARQL use cases. |
| **SQLite simplicity** | Zero-setup single-file database; in-and-out requires a running PostgreSQL instance. |

---

## Priority Recommendations

Items most worth addressing given OpenSync's current trajectory:

1. **Dead-letter queue + replay** (gap #4) — operational necessity for any production deployment
2. **Prometheus metrics + OTEL traces** (gap #11) — expected by any modern ops team
3. **Graceful shutdown + daemon mode** (gap #7) — prerequisite for reliable production operation
4. **Health & readiness endpoints on a separate port** (gap #10) — required for Kubernetes
5. **Pre-flight read + 3-way conflict for writeback** (gap #2) — the most significant safety gap vs in-and-out
6. **Connector validation mode with machine-readable output** (gap #14) — highly valuable for the agent-generated connector use case
7. **GDPR targeted purge by external_id** (gap #12) — compliance requirement for any MDM system handling PII
8. **Soft-delete resurrection** (gap #25) — correctness issue, not just an operational concern
9. **Write ordering + dependency ordering** (gap #23) — prevents data corruption in batch writes
10. **Runtime control table** (gap #5) — essential for ops without restarting the process
