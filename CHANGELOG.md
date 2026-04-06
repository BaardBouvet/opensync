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
- `RecordSyncResult` now carries structured payload fields: `sourceData` (source record after inbound mapping), `sourceShadow` (engine's prior shadow for diff display), `after` (canonical values written to the target), and `before` (target's pre-write shadow for UPDATE events).  All fields are optional — callers that don't use them are unaffected.
- New `action: "read"` variant on `SyncAction` / `RecordSyncResult`.  One READ result is prepended per non-echo-detected source record per ingest pass, before any dispatch results.
- `OnboardResult.inserts: RecordSyncResult[]` — individual fanout INSERT records from `onboard()`, eliminating the need for callers to back-query `transaction_log`.
- `demo/run.ts` now prints changed field keys alongside UPDATE log lines.

### Changed
- Browser playground: `emitEvents()` reads `before`/`after`/`sourceData`/`sourceShadow` directly from `RecordSyncResult` — no longer calls `captureSourceShadow()` or queries shadow_state before each ingest.
- Browser playground: onboard INSERT events now come from `onboardResult.inserts` instead of a `transaction_log` back-query.
- `InMemoryConnector` no longer implements an internal activity log (`ActivityLogEntry`, `getActivityLog()`, `clearActivityLog()` removed).

### Changed
- `plans/` reorganised into subsystem folders: `plans/demo/` for CLI demo runner plans, `plans/playground/` (new) for browser playground plans, `plans/meta/` trimmed to genuinely cross-cutting concerns only.

---

## [0.1.0] — 2026-04-06

First public release. The browser playground is live on GitHub Pages — no install, no
server, just a URL. The sync engine is pre-release; APIs and config shapes may still change.

OpenSync is a hub-and-spoke bi-directional sync engine. Data flows through a central shadow
state (SQLite), never directly between systems. This release ships:

- **Browser playground** — runs the full sync engine in the browser via WebAssembly SQLite.
  Visualises identity clusters across all connected systems, lets you edit records and channel
  config live, and shows the sync event log with before/after diffs. Three built-in scenarios
  (`two-system`, `three-system`, `associations-demo`).

- **Sync engine** (`@opensync/engine`) — bi-directional sync with canonical identity map,
  field mapping, echo detection, noop suppression, circuit breakers, OAuth2/API-key auth,
  eager association dispatch with deferred retry, and 412 ETag retry.

- **Connector SDK** (`@opensync/sdk`) — typed interface for building connectors (read, write,
  discover, webhook hooks). Reference connectors: HubSpot, Kafka, PostgreSQL, SPARQL,
  Tripletex, WaveApps.

- **Release infrastructure** — tag-triggered GitHub Actions (`release.yml`,
  `deploy-playground.yml`); pushes to `main` do not rebuild the live site.
