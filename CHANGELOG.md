# Changelog

All notable changes to OpenSync are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

Agents: add an entry under `[Unreleased]` for every feature added or bug fixed.
Use `### Added`, `### Fixed`, or `### Changed` as appropriate.
Move `[Unreleased]` to a dated version heading when a release is cut.

---

## [Unreleased]

### Changed

- **`demo-browser/` renamed to `playground/`.** The browser playground package is now at
  `playground/` and published as `@opensync/playground`. Removes the false parent-child
  implication with `demo/`. Updated `package.json` workspaces, `AGENTS.md`, `specs/demo.md`,
  and all active plan Scope lines.

- **`demo-browser/` moved to workspace root.** The browser playground package was nested at
  `demo/demo-browser/`; it is now a first-class sibling at `demo-browser/`. Updated `package.json`
  workspaces, `vite.config.ts`, `tsconfig.json`, `AGENTS.md`, and `specs/demo.md` accordingly.

### Fixed

- **Playground devtools: shadow_state tab now shows actual field data.** The `shadow_state`
  table has always stored a `canonical_data` JSON column with the last-synced field values,
  but the tab was only displaying metadata columns. The tab is now a split view: the left
  side shows the metadata table (`connector_id`, `entity_name`, `external_id`, `canonical_id`,
  `deleted_at`); clicking a row selects it and the right side panel shows the parsed field
  values (`canonical_data` JSON) with key → value rows in monospace.

### Added

- **Playground devtools: `watermarks` tab.** Shows the `watermarks` table
  (`connector_id`, `entity_name`, `since`). The `since` cursor is the opaque timestamp
  passed to each connector's incremental read as the `after` parameter, so this tab makes
  it obvious exactly how far into each source the engine has read.

- **Playground devtools: `channels` tab.** Shows the `channel_onboarding_status` table
  (`channel_id`, `entity`, `marked_ready_at`). This makes it clear which channels have
  completed onboarding and when, which is relevant when using the manual sync button.

### Fixed

- **Playground object viewer: column header alignment.** The `cluster-header-row` was starting
  at x=0 while card columns were inset by `cluster-body` padding (6px) + `cluster-group` side
  padding (5px) = 11px; and no `column-gap` meant misalignment compounded for 2+ columns. Fixed
  by setting header `padding` and `column-gap` in the render functions (6px for the unmapped
  view, 11px for channel cluster view). The `border-right` separator on header cells was removed;
  the `column-gap` now provides visual column separation.

- **Playground object viewer: per-column accent stripe.** Added a coloured left border on each
  `cluster-col-head` (full intensity) and the corresponding `cluster-cell` nth-child position
  (30% opacity), cycling through four muted colours. This visually links a header cell to the
  card column directly below it, making column ownership unambiguous.

- **Playground object viewer: empty slot visibility.** `cluster-cell-empty` border colour
  changed from `#252525` (near-invisible) to `#2e2e3a` with a faint background, so empty
  "no record for this system" slots are clearly visible within a cluster group.

### Added

- **GitHub Actions workflow to deploy playground to GitHub Pages.** Added
  `.github/workflows/deploy-playground.yml`; triggers on push to `main` when files under
  `playground/`, `packages/engine/src/`, or `packages/sdk/src/` change, and on
  `workflow_dispatch`. Also added `build:playground` script to root `package.json`.

- **Playground: field lineage diagram moved to `lineage` pseudo-tab (right pane).**** The field
  lineage diagram is now accessible via a `lineage` pseudo-tab at the end of the channel tab bar
  in the right pane. A thin separator visually distinguishes the two view pseudo-tabs (`unmapped`,
  `lineage`) from the channel tabs; both are rendered in italic to reinforce that they are
  diagnostic views, not channels. The tab label was changed from the earlier `map` (too similar
  to a channel name) to `lineage`. Poll-tick refreshes no longer rebuild the diagram while the
  `lineage` tab is active, which fixes the collapse/focus-reset bug caused by `innerHTML = ""`
  being called on every 2-second poll tick. The unused `.editor-tab-strip` CSS has been removed.
  Specs §2.4 and §11 updated accordingly.

- **Browser playground: READ events in boot tick.** The boot tick now shows one READ event per
  record collected from each connector during the initial `collectOnly` pass.  These events have
  no `before` field and display all fields in green (new records).
- **Browser playground: READ event diff.** Poll-tick READ events now include a `before` field
  populated from the shadow state snapshot taken immediately before `engine.ingest()` runs.
  The dev-tools expanded view shows only the changed fields (old → new diff) instead of the
  full record.  Boot-tick READs (no prior shadow) still show all fields in green.
- **Browser playground: `captureSourceShadow()`.** New helper in `engine-lifecycle.ts` that
  queries `shadow_state` before each ingest and returns a map of externalId → field values for
  use as READ event `before` data.

### Changed

- **Browser playground spec (`specs/playground.md`):** Updated §§ 4.2, 4.7, 7, 7.1, 8.1,
  8.2, 8.3, 8.4, 8.6, 10 to reflect current implementation: "auto" mode label, tick-viewer
  Log tab, `+ New` in column headers, boot-tick READ events, shadow diff for poll READs,
  `SyncEvent` interface, and `ActivityLogEntry` structure.


- **Plan: `plans/meta/PLAN_PLAYGROUND_TESTING.md`.** Playwright E2E test rig plan for the
  browser playground demo — setup, test scenarios (bootstrap, add/edit/delete/restore contacts,
  real-time toggle, devtools), and CI integration.
- **Plan: `plans/meta/PLAN_PLAYGROUND_MVU.md`.** Architecture migration plan to move the
  playground from imperative DOM mutation to Model–View–Update, enabling unit-testable
  `update()` and pure `render()` functions.
- **Browser demo: expandable syslog rows.** Each entry in the Logs tab can now be clicked
  to expand: inserts show the full JSON payload; updates show a colour-coded diff table
  (old value → new value). Timestamp is now always visible on the summary row.
- **Browser demo: event log tick ordering fixed.** The `── boot ──` separator now appears
  before the onboarding INSERT events, not after them.

### Fixed

- **Browser demo: real-time off, edits no longer propagate.** When real-time was disabled,
  saving or restoring a record still called `triggerPoll()`, causing immediate propagation.
  Callbacks now call `refreshUI()` (UI-only render) when `isRealtime` is false, and only call
  `triggerPoll()` when real-time is on.
- **`inmemory.insertRecord` uses `data.id` when provided.** Consistent with the engine-driven
  `entity.insert()` generator, `insertRecord` now uses `data["id"]` as the record's ID if no
  `explicitId` is passed. Fixes IM4/IM7/IM9 test cases.

- **Browser demo: onboarding events in the event log.** Boot-phase INSERT events (fanout
  inserts that `onboard()` performs silently) are now surfaced in the dev-tools event log.
  They appear dimmed/italic with a `[boot]` prefix to distinguish them from live-poll events.
  Source connector is inferred from `identity_map`. A warmup ingest pass also runs after all
  channels onboard, propagating associations and emitting the resulting UPDATE events, so the
  initial UI state is fully resolved before the poll interval starts.
- **Browser demo: Sync button + real-time toggle.** The topbar now has a "real-time" checkbox
  and a "Sync" button. When real-time is checked (default), the automatic 2-second poll runs
  as before and the Sync button is disabled. Unchecking real-time pauses the interval and
  enables the Sync button, which triggers one full poll cycle on demand.
- **`EngineState.pause()` / `EngineState.resume()`.** The engine lifecycle state object now
  exposes `pause()` and `resume()` to control the automatic poll interval at runtime, plus
  a read-only `isRealtime` getter.
- **`SyncEvent.phase` field.** Events now carry an optional `phase: "onboard" | "poll"` so
  consumers can distinguish boot-time events from live-poll events.
- **Plan: `plans/engine/PLAN_ENGINE_USABILITY.md`.** Gap analysis covering six engine API
  friction points: 3-step boot protocol, silent onboard events, step-1b associations gap,
  entity-scope bugs, global fan-out guard, and implicit channel ordering dependency.
  Includes proposed fixes and complexity estimates for each.

### Fixed

- **Browser demo: contacts associations on initial load.** After onboarding, fanned-out
  contacts (records inserted into a 3rd connector by `onboard()` step 1b) were inserted
  without association data. A warmup ingest pass now runs immediately after all channels
  onboard, propagating associations via UPDATE before the poll interval starts. Users no
  longer see a 2-second window where contacts exist but lack their company links.

### Changed

- **`AGENTS.md` — spec discipline clarification.** Spec files in `specs/` no longer carry
  `Status:` or `Date:` metadata headers; those are for plan files only. The rule is now
  explicit in the agents instructions.
- **`specs/playground.md` — removed Status/Date header.**


  header now shows a count badge with the number of active (non-soft-deleted) records. Both
  the channel cluster view and the unmapped view include these badges.
- **Browser demo: multi-record cluster cells.** Unlinked records from the same connector are
  now grouped into a single cluster group instead of appearing as separate single-card rows.
  Cells support stacking multiple cards vertically. Linked clusters remain one-to-one as
  enforced by the identity map schema.
- **Browser demo: optional ID in new-record dialog.** The "New" record dialog now includes an
  optional ID input field above the JSON editor. If filled, the value is used as the record's
  external ID; if left blank, a UUID is generated. The `InMemoryConnector.insertRecord()`
  signature adds an `explicitId?` parameter.
- **Browser demo: association target state badges.** Association badges now indicate the state
  of the target record: active targets show as a blue clickable badge (unchanged), soft-deleted
  targets show as an amber badge with ⊘ prefix, and missing targets (not found in the
  connector's store) show as a red badge with ⚠ prefix and are not clickable.
- **Spec: `specs/playground.md`.** New specification file documenting the browser playground
  UI: layout, cluster view, record cards, modals, dev tools, scenario system, engine
  integration, and resizing.

  YAML (via `@codemirror/lang-yaml`) instead of JSON. Comments in the YAML explain each
  field (`identityFields`, `inbound`/`outbound` mappings). Conflict strategy is no longer
  exposed in the editor — it inherits from the scenario.
- **Browser demo: "Unmapped" channel tab.** A new "unmapped" tab at the end of the channel
  list shows all connector entities not covered by any channel (with full edit/delete/new
  capability). Navigating to a record in an unmapped entity switches to this tab.
- **Browser demo: Dev tools panel.** Replaced the event log with a tabbed "Events / DB State"
  dev panel at the bottom. The DB State tab shows live row counts for `identity_map`,
  `shadow_state`, and `channel_onboarding_status`, auto-updating after each poll pass.
- **Browser demo: cluster group borders.** Each identity cluster group now has a visible
  border and background, making the grouping visually obvious.

### Fixed

- **Browser demo: "c1… syncing" phantom clusters.** `SyncEngine.getChannelIdentityMap()` now
  filters canonicals by entity name (via a new `dbGetCanonicalsByChannelMembers()` query that
  joins `identity_map` with `shadow_state`). Previously, the companies channel incorrectly
  showed contact/employee/people canonicals because all three connectors (crm/erp/hr) are
  shared across channel, and the old query returned all canonicals for those connectors
  regardless of entity. Fixes both the phantom "syncing" rows and contacts duplication.
- **Browser demo: "New" button label.** The per-connector "new record" button in the cluster
  footer now reads "+ New" instead of "+ New crm" (which was redundant with the column header).

- **Browser demo: fixed CRM/ERP/HR connector set.** All scenarios now share the same
  three systems (crm, erp, hr) with fixed seed data, moved to `demo/demo-browser/src/lib/systems.ts`.
  `ScenarioDefinition` no longer carries `systems` or `seed`; scenarios declare only
  `channels` and `conflict`. This makes the playground a pure channel-config experiment space.

- **Browser demo: "minimal" scenario.** A two-system (crm ↔ erp), single-channel (companies)
  scenario with simple field-rename mappings. Demonstrates the core sync loop without
  associations or three-way matching.

- **Browser demo: soft-delete.** Clicking Delete on a record marks it as soft-deleted
  (dashed border, faded text, hidden from the engine's read output) rather than permanently
  removing it. A Restore button re-presents the record to the engine, which picks it up on
  the next poll and re-syncs if needed.

- **Browser demo: association editing.** The Edit modal now shows `{ data, associations }`
  combined, allowing users to add, remove, or modify associations on any record.

- **Browser demo: association badge navigation.** Clicking an association badge on a record
  card navigates to the channel that owns the target entity and highlights the target card
  in purple for 2.5 seconds with auto-scroll.

- **Browser demo: richer event log.** `SyncEvent` now carries `sourceConnector`,
  `sourceEntity`, `targetConnector`, `targetEntity`, and `targetId`. Each log row shows
  `srcConnector→tgtConnector  ACTION  entity  srcId… → tgtId…`, matching the CLI demo format.

- **Browser demo: identity-cluster row layout.** Records are now grouped horizontally by
  canonical identity. Each row spans all channel members; empty cells show connectors that
  haven't received the record yet. `SyncEngine.getChannelIdentityMap()` exposes the
  identity map to the UI.

- **Browser demo: "New" buttons outside clusters.** Per-connector "+ New" buttons are in a
  dedicated footer row, separate from the cluster grid, since the engine controls which
  identity group a new record belongs to.

- **Browser demo: unsaved-changes confirmation.** Switching scenario, resetting, or
  reloading config while record edits are pending prompts the user before discarding changes.

### Fixed

- **Browser demo: event log source connector.** `sourceConnector` was incorrectly set to
  `r.entity` (the entity name) instead of the actual connector ID. Fixed in `emitEvents()`
  and `triggerPoll()`.

### Fixed

- **`discover()` partial N-way matching (`engine.ts`).** Previously, a record had to appear
  in *all* N connectors to be classified as `matched`. Any record present in only 2 of 3
  connectors was split into two separate `uniquePerSide` entries, causing `onboard()` to
  insert it into the missing connector *twice* (once from each side). Fixed by grouping all
  shadow records by identity key across every connector: any key in 2+ connectors is a match;
  only keys appearing in exactly one connector are unique. Regression test: T39.

- **`onboard()` entity name for heterogeneous channels (`engine.ts`).** `onboard()` was
  writing all `shadow_state` rows with `report.entity` (= `channel.members[0].entity`),
  even for connectors whose entity name differs (e.g. crm="contacts", erp="employees").
  This caused echo detection to fail on subsequent polls because the shadow_state row for
  erp was stored under "contacts" while ingest looked for "employees". Fixed by building a
  `memberByConnector` map and using each member's own entity name for shadow writes, source
  entity lookups, and deferred-association rows. Regression test: T40.

- **`onboard()` propagation of partial matches (`engine.ts`).** Matched records that appear
  in a subset of channel connectors (2 of N) were never inserted into the missing connectors.
  Fixed by adding a step 1b that iterates matched records and inserts them into any connector
  not already in `match.sides`. Covered by T39.

### Added

- **Browser demo playground (`demo/demo-browser`).** A fully static, browser-native demo
  that runs the full OpenSync engine in-memory via sql.js (SQLite compiled to WebAssembly).
  Hosted as a Vite-built single-page application deployable to GitHub Pages. Features a
  REPL-style split-pane layout: CodeMirror JSON editors (config + per-system data) on the
  left; live system columns with record cards + a timestamped engine event log on the right.
  Scenario dropdown with three built-in examples (`associations-demo`, `three-system`,
  `two-system`). Config changes trigger a full engine reload; data edits trigger an
  immediate poll. No server required. See `plans/meta/PLAN_BROWSER_DEMO.md`.

### Added

- **`specs/associations.md § 7` — Cross-System Association Remapping.** Documents how the
  engine translates association `targetId` values across systems via the identity map, the
  requirement that connectors use canonical entity type names in `targetEntity`, and why FK
  injection into `UpdateRecord.data` is the target connector's responsibility (not the engine's).

### Changed

- **`demo/examples/associations-demo/mappings/contacts.yaml`**: removed `companyId`/`orgId`/`orgRef`
  fields from all three connector mappings. These are association predicates and must not appear
  in the field mapping list (see `specs/associations.md § 7.4`).
- **Eager association dispatch (new default).** Records with unresolvable associations are
  no longer withheld entirely. The engine now inserts/updates the record immediately with
  only the associations that can be resolved, writes a `deferred_associations` row, and
  issues an update with the missing association once the identity link is established on a
  future ingest cycle. This eliminates both the latency issue (record visible before its
  referenced entity is synced) and the circular-dependency stall (two records referencing
  each other would previously block forever in strict mode). The `"defer"` action is no
  longer emitted as a `RecordSyncResult`; the first-pass dispatch now produces `"insert"`
  or `"update"`. Regression tests: T36–T38 in `packages/engine/src/onboarding.test.ts`.
  The `skipEchoFor` bypass (T34) is updated to reflect that echo detection must still be
  bypassed on retry since the source shadow was written without the association sentinel.

### Fixed

- **Noop update suppression.** The engine now skips dispatching to a target connector when
  the resolved canonical values (and remapped associations) already match the target shadow.
  Previously, `resolveConflicts` always returned all incoming fields (LWW `Date.now() >=`
  stored ts is always true), causing a target write on every poll cycle even when nothing
  had changed. The new `_resolvedMatchesTargetShadow` guard fires after conflict resolution
  but before `_dispatchToTarget`. Also fixes: the target shadow now stores the remapped
  association sentinel so the guard can correctly compare associations on subsequent polls.
  Regression tests: T27–T30 in `packages/engine/src/onboarding.test.ts`.

- **Deferred association retry.** Associations that could not be remapped at fan-out time
  (target entity not yet linked in the identity map) are now persisted in a new
  `deferred_associations` table and retried via `lookup()` on subsequent ingest calls.
  Previously the defer result was silently discarded, causing associations (e.g. a contact's
  company link) to be permanently lost once the watermark advanced past the record.
  Also fixes `_entityKnownInShadow`: it now accepts entities configured in any channel even
  if they have no shadow rows yet, so a valid-but-not-yet-synced target entity no longer
  triggers a spurious `{error}` response from `_remapAssociations`.
  Regression tests: T31–T33 in `packages/engine/src/onboarding.test.ts`.
- **Deferred retry blocked by echo detection.** When a record was first ingested with an
  unresolvable association, the engine wrote its source shadow (with association sentinel)
  even though no target received the data. On all subsequent retry attempts `_processRecords`
  saw the matching source shadow and short-circuited via echo detection — the record was
  permanently skipped and the deferred row never cleared. Fixed by passing a `skipEchoFor`
  set to `_processRecords` when calling it from the retry loop, bypassing the echo check
  for those specific record IDs only. Regression test: T34.

- **`targetEntity` not translated on association remap.** When propagating a record from
  one connector to another, `_remapAssociations` translated the association's `targetId` to
  the target connector's ID space but left `targetEntity` unchanged (e.g. `"companies"` was
  stored verbatim in ERP employee records instead of `"accounts"`). Fixed via a new
  `_translateTargetEntity` helper that looks up the corresponding entity name in the same
  channel. Regression test: T35.
### Added

- **`jsonfiles` connector: immutable log format.** New `logFormat: true` config option
  switches the connector to append-only mode. Inserts and updates append new versions;
  deletes append tombstones (`_deleted: true`). Reads deduplicate by id, emitting only the
  latest version of each record (tombstoned records are omitted). Incremental `since`
  filtering continues to work correctly over the deduplicated view. The new `deletedField`
  config option (default `"_deleted"`) controls the tombstone field name. Default is
  `false`; all existing fixtures and tests are unaffected.

### Fixed

- **Integer watermarks never picked up after onboarding.** `collectOnly` and `onboard` both
  advanced watermarks, but both always wrote ISO timestamps regardless of watermark type.
  `collectOnly` now stores the connector's own integer `batch.since` for integer-mode connectors.
  `onboard` now preserves any integer watermark already stored by `collectOnly` and only falls
  back to ISO snapshotAt for ISO-mode connectors. Without this fix, `isNewerThan(2, "2026-04-05T…")`
  resolved to `NaN > 1` → `false`, causing every subsequent poll to return nothing.
  Regression test: T26 in `packages/engine/src/onboarding.test.ts`.

### Added

- `dev/` directory: dev-only packages consolidated under `dev/connectors/` and `dev/servers/`.
  Moved from `connectors/` (jsonfiles, mock-crm, mock-erp) and `servers/` (mock-crm, mock-erp).
  Distributable connectors in `connectors/` now contain only publishable packages.
- `connector-jsonfiles` nested record format: records now use `{ id, data, updatedAt?, associations? }`
  envelope instead of flat underscore-prefixed fields (`_id`, `_updatedAt`, `_associations`).
  `updatedAt` is optional — records without it are always included in every read.
  Integer sequence watermarks (e.g. `1`, `2`, `3`) are supported alongside ISO 8601 timestamps.
- `demo/examples/associations-demo`: three-system demo (`crm`, `erp`, `hr`) with two channels
  (`companies`, `contacts`), field renames across all three connectors, and associations linking
  contacts to their company. Demonstrates the full mapping pipeline.
- `demo/inspect.ts`: on-demand engine state inspector. Prints `identity_map`, `shadow_state`,
  `watermarks`, and `transaction_log` from `demo/data/<name>/state.db` as ASCII tables.
  Usage: `bun run demo/inspect.ts -d <example-name> [identity|shadow|watermarks|log]`.
  `dev/connectors/jsonfiles/package.json` gains `"private": true`.
- `ROADMAP.md`: new "Repository hygiene" section tracking meta/infra work.
- `AGENTS.md`: "Plans discipline" rule — when a plan is completed, update its Status line,
  `plans/INDEX.md`, and `ROADMAP.md`.

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
