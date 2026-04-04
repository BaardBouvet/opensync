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

- `specs/demo.md`: spec for the demo/ directory — example folder convention, `-d` flag,
  seed/ format, field-mapping showcase plan, runner architecture, path resolution.

### Changed

- `demo/run.ts`: rewritten as generic runner using `-d <example-dir>` flag; available
  examples discovered via `readdirSync` — no hardcoded list.
- `ConnectorInstance.auth`: auth credentials separated from `config` throughout the engine
  (`loader.ts`, `context.ts`, `http.ts`). Credentials in `opensync.json` go under an `auth:`
  key; connectors never receive them directly.

### Removed

- `poc/` directory (v0–v9): all lessons captured in specs, plans, and engine tests.
  272 → 77 tests (POC tests removed; engine parity confirmed by T1–T25).


  both directions; edit JSON files under `demo/data/` to see live sync. Uses the packaged
  `@opensync/engine` and `@opensync/connector-jsonfiles` (not the POC engine).
- `plans/meta/PLAN_DEV_PACKAGES.md`: plan to consolidate dev-only packages
  (connector-jsonfiles, connector-mock-crm, connector-mock-erp, server-mock-crm,
  server-mock-erp) under a `dev/` top-level directory, separate from distributable
  connectors.

- `specs/associations.md`: new spec extracted from `connector-sdk.md` — Association type,
  composite-key resolution, pending-edge handling, JSON-LD pattern, storage as `__assoc__`
  shadow-state field, and design rationale
- `specs/data-access.md`: early draft spec for shadow state as a queryable unified data layer
- `specs/agent-assistance.md`: early draft spec for agent-assisted connector generation and
  field mapping
- `plans/PLAN_DB_MIGRATIONS.md`: plan for post-release migration system using SQLite
  `PRAGMA user_version`; rule: no migration infrastructure before first public release
- `plans/PLAN_REMOVE_POC.md`: gate criteria and procedure for removing `poc/` once the engine
  and connectors provide equivalent coverage
- `plans/connectors/GAP_CONNECTOR_SDK_SPEC.md`: gap report for `connector-sdk.md` vs.
  `packages/sdk/src/types.ts`
- `plans/engine/GAP_ENGINE_DECISIONS.md`: gap report for M2 engine decisions not yet in specs
- `AGENTS.md` rule: no database migration infrastructure before the first public release

### Changed

- `specs/connector-sdk.md`: removed HubSpot example code block (use `connectors/` for
  reference implementations); removed "Design Alternative: Engine-Driven Entity Dispatch"
  section; replaced in-line Associations section with a summary linking to
  `specs/associations.md`; fixed `ReadRecord` and `UpdateRecord` to include `version` and
  `snapshot` fields matching `packages/sdk/src/types.ts`; fixed `ctx.state` backing table
  name (`connector_state`, not `instance_meta`)
- `specs/database.md`: removed obsolete pre-POC schema section (old `entities`,
  `entity_links`, `connector_instances`, `sync_channels`, `sync_jobs`, `instance_meta`,
  `stream_state`, and related Drizzle ORM content); corrected `channel_onboarding_status`
  table definition; added `circuit_breaker_events` table
- `specs/overview.md`: removed Drizzle ORM and pino from tech stack table; updated SQLite
  adapter description to match actual custom `Db` interface; updated monorepo structure to
  include `servers/` and `poc/`; updated Key Concepts to use current table names
- `specs/README.md`: updated link from `sdk-helpers.md` to `connector-helpers.md`; added
  `associations.md` entry; added `connector-helpers.md` entry
- `specs/sdk-helpers.md` → `specs/connector-helpers.md`: renamed for logical grouping


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
