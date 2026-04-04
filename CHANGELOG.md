# Changelog

All notable changes to OpenSync are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

Agents: add an entry under `[Unreleased]` for every feature added or bug fixed.
Use `### Added`, `### Fixed`, or `### Changed` as appropriate.
Move `[Unreleased]` to a dated version heading when a release is cut.

---

## [Unreleased]

### Added

- `packages/engine/` (`@opensync/engine`): initial production engine package implementing `SyncEngine` class with:
  - `ingest(channelId, connectorId, opts?)` — full poll cycle with collectOnly fast path, timeout, and fan-out
  - `discover(channelId, snapshotAt?)` — pure DB-backed match report from shadow_state
  - `onboard(channelId, report, opts?)` — merge canonicals, propagate unique-per-side records, advance watermarks
  - `addConnector(channelId, connectorId, opts?)` — live join of a new connector to an existing channel
  - `channelStatus(channelId)` — returns `"uninitialized" | "collected" | "ready"`
  - **Gap 1 fix**: `snapshotAt` captured before the read phase starts; passed through `IngestResult` and used as the watermark anchor so records written mid-collect are not missed by the next incremental
  - **Gap 2 fix**: `CircuitBreaker` persists trip/reset events to `circuit_breaker_events` table; state restored from DB on engine construction so a tripped breaker survives restarts
  - **Gap 6 fix**: 412 Precondition Failed on dispatched update triggers a re-read (`entity.lookup`) to fetch the fresh ETag, then one retry; dead-letters with `action = "error"` if still conflicts
  - **Gap 8 fix**: `onboard()` checks circuit breaker before any writes and throws immediately if OPEN; unique-per-side propagation route writes `transaction_log` entries for auditability
  - `loadConfig(rootDir)` — loads `opensync.json` + `mappings/*.yaml` from disk, resolves `${ENV_VAR}` interpolation, dynamically imports connector plugins
  - `openDb(path)` — runtime-adaptive SQLite adapter: `bun:sqlite` under Bun, `better-sqlite3` under Node.js 18+
  - Full SQLite schema (9 tables) created idempotently on construction
  - Integration tests T1–T9 covering all M2 exit criteria scenarios
- `tsconfig.json` (root): added `packages/engine` project reference

- `servers/mock-crm/` (`@opensync/server-mock-crm`): standalone `MockCrmServer` package extracted from `poc/v5`; supports env-var config (`MOCK_CRM_PORT`, `MOCK_CRM_API_KEY`), `/__reset` test-helper endpoint, and a `src/main.ts` process entrypoint
- `servers/mock-erp/` (`@opensync/server-mock-erp`): standalone `MockErpServer` package extracted from `poc/v6`; supports env-var config (`MOCK_ERP_PORT`, `MOCK_ERP_CLIENT_ID`, `MOCK_ERP_CLIENT_SECRET`, `MOCK_ERP_HMAC_SECRET`), `/__reset` test-helper endpoint, and a `src/main.ts` process entrypoint
- `connectors/mock-crm/src/index.test.ts`: connector tests covering `read()`, `insert()`, `update()`, `onEnable()`/`onDisable()`, automatic webhook delivery on create/update, and `handleWebhook()` in both thick and thin modes
- `connectors/mock-erp/src/index.test.ts`: connector tests covering `read()`, `lookup()` (ETag as version), `insert()`, and `update()` with If-Match matching and stale-ETag error path
- `specs/connector-sdk.md`: added `The connectors/ folder` section documenting the three purposes of the folder (reference implementations, design validation, agent-writeable baseline); added `Mock servers (servers/)` section documenting design principles, mock CRM and ERP server contracts, and the automatic webhook delivery behaviour
- `ROADMAP.md` Milestone 1: added two new items tracking the mock server extraction and connector test coverage for mock-crm and mock-erp
- `AGENTS.md`: added doc-writing rules (informative not promotional; connectors expose raw records; only network-accessible databases are valid connector targets)
- `plans/engine/PLAN_PRODUCTION_ENGINE_M2.md`: implementation plan for Milestone 2 — minimal production engine; covers config loading, SQLite schema, core ingest pipeline, circuit breaker with persistence, discovery/onboarding, and closes POC gaps 1, 2, 6, and 8
- `specs/safety.md`: added Optimistic Locking / ETag threading section with `ConflictError`, 412 retry loop spec, and connector contract
- `poc/v7/LESSONS.md`, `poc/v8/LESSONS.md`, `poc/v9/LESSONS.md` — lessons derived from POC source code and tests
- `plans/poc/PLAN_CLOSE_POC_GAPS.md` — plan to close 10 open gaps identified across the POC series
- `AGENTS.md`: added spec numbering convention (`§N.M` notation) to Section 4
- `ESSENCE.md`: clarified engine ships as a TypeScript library and binary, not a generic hosted service
- `plans/poc/PLAN_POCS.md` — all 10 POC phases (v0–v9) combined into one document
- `plans/meta/PLAN_SPEC_DRIVEN_MIGRATION.md` — historical migration plan moved from root

### Changed

- `plans/poc/REPORT_POC_LESSONS.md` → renamed to `plans/poc/GAP_POC_LESSONS.md`; v7–v9 lessons appended; header updated to identify open gaps
- `ROADMAP.md`: M0 LESSONS.md exit criterion marked done; SDK helpers and connector cleanup moved from M1 to M3; all POC plan links updated to `PLAN_POCS.md`
- `plans/README.md`: added historical-plans retention policy
- `plans/INDEX.md`: updated to reflect all new and renamed files
- `README.md`: added links to ESSENCE/ROADMAP/CHANGELOG; fixed connector description; removed pluggable storage bullet; removed promotional language
- `docs/getting-started.md`: removed sales language; corrected field mapping attribution to engine
- `docs/connectors/advanced.md`: Database Connectors section clarified — SQLite/embedded databases not accessible from connectors; only network-accessible databases work
