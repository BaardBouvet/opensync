# Changelog

All notable changes to OpenSync are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

Agents: add an entry under `[Unreleased]` for every feature added or bug fixed.
Use `### Added`, `### Fixed`, or `### Changed` as appropriate.
Move `[Unreleased]` to a dated version heading when a release is cut.

---

## [Unreleased]

### Fixed
- `onboard()` step 1b (matched records missing from a 3rd connector) now calls `lookup()` on the first available source side and includes remapped associations in the fanout INSERT, the same way step 2 already does. Previously these INSERTs landed without associations, and the warmup fullSync then dispatched "empty" UPDATE events (before == after, only the association changed) to add them. The fix eliminates those bogus warmup UPDATEs for the step 1b target connector. (T42 regression test covers this.)
- `onboard()` step 1 now pre-fetches each matched side's own associations via `lookup()` before seeding its shadow, storing the correct `__assoc__` sentinel. Previously the sentinel was always `undefined`, causing the warmup fullSync to fail echo detection for any record with associations and dispatch spurious empty-looking READ + UPDATE events. (T43 regression test covers this.)
- Removed warmup `{ fullSync: true }` ingest pass from `startEngine()`. The pass was a compensating mechanism for the missing-association bug in `onboard()` step 1b; now that step 1b includes associations in the fanout INSERT (and defers via `deferred_associations` when the target ID is not yet resolved), the warmup adds no value. Removed the corresponding step from the `playground.md § 8.2` boot-sequence spec.

### Added
- **Association predicates in mapping lineage diagram**: `assocMappings` entries now appear as extra rows inside each entity pill in the `Diagram` tab. They are visually distinct from regular field rows — amber colour scheme and a `⟶` prefix marker. The connector-local predicate name (`source`) appears in the entity column; the canonical name (`target`) appears in the centre column as an amber chip. SVG connection lines and focus/highlight behaviour work the same as for field rows.
- `RecordSyncResult` now carries four optional association payload fields: `sourceAssociations`, `sourceShadowAssociations`, `beforeAssociations`, `afterAssociations`. An association-only change (e.g. contact moves companies, field values unchanged) now produces a `"read"` result where the two source association arrays differ and an `"update"` result where the two target association arrays differ, making the actual change visible to callers. (T44 regression test covers this.)
- `OnboardResult.inserts` entries now carry `afterAssociations` (the remapped associations that were written to the target connector during onboarding). Previously these were missing from onboard INSERT events.
- Boot READ events in the playground now include `sourceAssociations` (associations on each record in the initial snapshot), making them visible in the event log detail.
- Playground event log (`devtools.ts`) now renders association changes as diff rows alongside field changes. A `buildAssocDiff` helper compares before/after association arrays by predicate and shows `entity/targetId → entity/newTargetId` for each changed link. The "(no field changes)" label is replaced by "(no changes)" and only appears when both field data and associations are identical.
- **Association predicate mapping** (`assocMappings` on `ChannelMember`): each connector may now declare an `associations` list in its channel mapping entry that maps local predicate names to a canonical name (e.g. CRM `companyId` and ERP `orgId` both map to canonical `companyRef`). The engine translates predicates at dispatch time — source-local → canonical → target-local — so each system receives its own predicate name. Absent `assocMappings` on a member means no associations are forwarded (strict by design). The canonical name is a routing key only; it is never stored in shadow state, so changing mappings never invalidates existing shadows. T45 regression test covers the cross-predicate rename path. (PLAN_PREDICATE_MAPPING.md)
- Playground event log INSERT events now render field data as a green table (same style as initial READ) instead of a raw JSON blob; association rows follow below the field table.
- Playground event log initial READ events (no prior shadow) now show associations below the field table.
- `RecordSyncResult` now carries structured payload fields: `sourceData` (source record after inbound mapping), `sourceShadow` (engine's prior shadow for diff display), `after` (canonical values written to the target), and `before` (target's pre-write shadow for UPDATE events).  All fields are optional — callers that don't use them are unaffected.
- New `action: "read"` variant on `SyncAction` / `RecordSyncResult`.  One READ result is prepended per non-echo-detected source record per ingest pass, before any dispatch results.
- `OnboardResult.inserts: RecordSyncResult[]` — individual fanout INSERT records from `onboard()`, eliminating the need for callers to back-query `transaction_log`.
- `demo/run.ts` now prints changed field keys alongside UPDATE log lines.

### Changed
- Browser playground: `emitEvents()` reads `before`/`after`/`sourceData`/`sourceShadow` directly from `RecordSyncResult` — no longer calls `captureSourceShadow()` or queries shadow_state before each ingest.
- Browser playground: onboard INSERT events now come from `onboardResult.inserts` instead of a `transaction_log` back-query.
- `InMemoryConnector` no longer implements an internal activity log (`ActivityLogEntry`, `getActivityLog()`, `clearActivityLog()` removed).
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
