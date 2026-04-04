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
