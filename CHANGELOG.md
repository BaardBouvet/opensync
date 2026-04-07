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
- Engine: `normalize` per-field function on `FieldMapping` (specs/field-mapping.md §1.4).
  Applied to both sides before the noop diff check — if `normalize(incoming) ===
  normalize(shadow)`, the field is treated as unchanged and no write is triggered, preventing
  precision-loss connectors (phone formatting, float rounding, date truncation) from causing
  infinite update loops. Also blocks lower-fidelity sources from overwriting higher-fidelity
  canonical values during conflict resolution. `buildNormalizers()` helper in `core/diff.ts`
  extracts a `Map<field, fn>` from a `FieldMappingList`. Tests: `diff.test.ts` N1–N4,
  `conflict.test.ts` N5–N6.
- Engine: `reverseRequired` per-field boolean on `FieldMapping` (specs/field-mapping.md §1.6).
  When true, the entire dispatched row to a target connector is suppressed if that field is null
  or absent after outbound mapping. No `written_state` row is written. `isDispatchBlocked()`
  helper in `core/mapping.ts`; guard applied before every connector insert/update call.
  Tests: `mapping.test.ts` RR1–RR6.
- Engine: `default` and `defaultExpression` per-field fallbacks on `FieldMapping`
  (specs/field-mapping.md §1.5). Applied during the forward (inbound) pass when the source
  field is absent or null. `default` is a static value; `defaultExpression` is a function
  receiving the partially-built canonical record (can reference fields processed earlier in the
  same mapping list). Both are no-ops on the outbound pass. `default` is also available in
  YAML config files. Tests: `mapping.test.ts` DF1–DF7.
- Engine: `group` per-field label on `FieldMapping` for atomic conflict resolution
  (specs/field-mapping.md §1.8). All fields sharing the same label resolve from the same
  winning source, preventing incoherent mixes (e.g. ERP wins `street`, CRM wins `city`).
  Group winner is elected by LWW (max timestamp across all group fields from the shadow); if
  `connectorPriorities` are configured, priority takes precedence with timestamp as tiebreaker.
  Implemented as a group pre-pass in `resolveConflicts()`. Tests: `conflict.test.ts` FG1–FG8.
- Engine: field expressions on `FieldMapping` (`expression`, `reverseExpression`). When
  `expression` is set on a mapping entry, the inbound pass calls it with the full source record
  instead of looking up a single `source` key, enabling computed / combined canonical fields.
  When `reverseExpression` is set, the outbound pass calls it with the canonical record; an object
  return value is decomposed into multiple source fields, a scalar is assigned to `source ?? target`.
  Expressions fire after the `direction` guard, so `forward_only` entries skip on inbound even if
  `expression` is present; `reverse_only` entries skip on outbound.
  Spec: `specs/field-mapping.md §1.3`. Tests: `packages/engine/src/core/mapping.test.ts` (FE1–FE9).
- Engine: element filters on array expansion members (`filter`, `reverse_filter`). `filter` is a
  JS expression string compiled at load time (`new Function`) that gates the forward pass — only
  elements where the expression returns truthy are expanded and dispatched. `reverse_filter`
  similarly gates the reverse collapse pass. Bindings: `element`, `parent`, `index`.
  Compilation errors are reported at engine startup. For multi-level chains the filter applies at
  the leaf level only. Spec: `specs/field-mapping.md §3.2`. Tests: `packages/engine/src/multilevel-array.test.ts` (EF1–EF3).
- Engine: multi-level nested array expansion (`expansionChain`). Parent chains of depth ≥ 2 are
  now supported. The leaf channel member inherits the root ancestor's connector and source entity;
  `resolveExpansionChain` builds an ordered `ExpansionChainLevel[]` outermost-first. At ingest
  time, `expandArrayChain` performs a recursive cross-join across all levels, producing a flat set
  of leaf records with composite IDs (`parentId#lines[L01]#components[C01]`).
  Spec: `specs/field-mapping.md §3.4`.
- Engine: `array_parent_map` SQLite table. Records one row per expansion hop per child record
  (`child_canon_id → parent_canon_id + array_path + element_key`). Populated for every hop
  during both normal ingest and `collectOnly` passes. Spec: `specs/database.md`.
- Engine: reverse array collapse. When a flat connector writes a change back, the engine walks
  `array_parent_map` to find the root parent, batches all patches for the same parent root,
  deep-clones the parent's current data, applies `patchNestedElement` for each patch (only
  mapped fields overwritten; unmapped element fields preserved), and calls `connector.update`
  once per root. Multi-level chains (grandchild → child → root) are fully supported.
  Spec: `specs/field-mapping.md §3.2, §3.4`.
- Engine: `extractHopKeys`, `expandArrayChain`, `patchNestedElement` helpers in
  `packages/engine/src/core/array-expander.ts`.
- Engine: `dbUpsertArrayParentMap()` and `dbGetArrayParentMap()` query helpers.
- Config loader: cycle detection in `parent` chains — throws at load time if a cycle is found.

- Engine: nested array expansion (`array_path` + `parent` mapping keys). A source record whose
  field contains a JSON array can now be expanded into per-element child entity records before
  fan-out. Works for same-channel (parent source descriptor and child in the same channel) and
  cross-channel (parent in one channel, child referencing it by `name` across channels) patterns.
  Each element gets a deterministic canonical UUID derived from the parent canonical ID +
  array path + element key value. No source-side shadow state is written for expanded child
  records; unchanged elements are suppressed by the existing `written_state` mechanism.
  Spec: `specs/field-mapping.md §3.2`.
- Config: `name`, `parent`, `array_path`, `parent_fields`, `element_key` keys on mapping entries.
  `entity` is now optional for child mappings (same-channel parent must declare its own `connector`
  and `entity`; the child inherits the connector and uses the parent entity as the read source).
  Spec: `specs/config.md`.
- Engine: `expandArrayRecord()` and `deriveChildCanonicalId()` helpers in
  `packages/engine/src/core/array-expander.ts`.
- Engine: `written_state` table — records the post-outbound-mapping field values last written
  to each target connector per entity. Keyed on `(connector_id, entity_name, canonical_id)`.
  After every successful insert or update, the engine upserts a `written_state` row inside the
  same atomic transaction as `shadow_state`. Spec: `specs/field-mapping.md §7.1`.
- Engine: target-centric noop suppression using `written_state`. Before dispatching an update
  to a target connector, the engine compares the outbound-mapped delta against the previously
  written values. If all fields match, the dispatch is suppressed. First-time inserts are
  always dispatched regardless. Spec: `specs/field-mapping.md §7.1`.
- Engine: `dbUpsertWrittenState()` and `dbGetWrittenState()` query helpers.
- Engine: transitive closure identity matching. `discover()`, `addConnector()`, and `_resolveCanonical()` now use a union-find (connected-components) algorithm instead of a composite key. Records linked pairwise (A=B via email, B=C via taxId) are now correctly detected as one entity (A=B=C), regardless of chain length. Ambiguous components (two records from the same connector in the same group) are placed in `uniquePerSide` with a console warning.
- Engine: `identityGroups` channel config key. Compound AND-within-group, OR-across-groups identity semantics. `identityGroups: [{ fields: [firstName, lastName, dob] }]` requires all three fields to match. Internally `identityFields` is expanded to one single-field group per field. `identityGroups` takes precedence when both are present.
- Engine: `dbFindCanonicalByGroup()` query helper for compound identity group lookups (AND-chained `JSON_EXTRACT` conditions in one SQL query).
- Engine: `dbMergeCanonicals()` now deletes conflicting `identity_map` rows before updating, preventing `PRIMARY KEY (canonical_id, connector_id)` constraint violations when two canonicals both have entries for the same connector.
- `IdentityGroup` type exported from `@opensync/engine`.

### Changed
- Some ecosystem plan files moved to the private internal submodule.
  Public plan cross-references updated accordingly.
  `AGENTS.md` updated with rules prohibiting public references to internal files.

### Added
- Playground: Notification poll (debounced mutation trigger). Record mutations in auto mode now trigger a debounced `NOTIFY_MS = 800 ms` notification timer instead of an immediate poll, producing a visible two-phase flash effect: the edited card flashes green instantly, then synced copies flash ~800 ms later when the engine tick fires. Rapid edits within the window are coalesced into one poll. Background interval raised from 2 000 ms to 5 000 ms. A 3 px countdown bar below the topbar depletes over the pending delay, giving a live read of "time until next engine tick". On boot the same countdown fires so the initial sync is visually telegraphed to the user.

### Fixed
- Playground: Ctrl/Cmd+Enter to save was silently swallowed in both the YAML config editor and the JSON record editor modal because `defaultKeymap` binds `Mod-Enter` to `insertBlankLine` and was spread before the custom handlers. Custom save bindings are now registered first so they take priority. Hint text is now shown consistently in both editors ("Ctrl/Cmd + Enter to save"), and the hint colour was raised from `#3a3a3a` (invisible on dark background) to `#555`.
- `onboard()` step 1b (matched records missing from a 3rd connector) now calls `lookup()` on the first available source side and includes remapped associations in the fanout INSERT, the same way step 2 already does. Previously these INSERTs landed without associations, and the warmup fullSync then dispatched "empty" UPDATE events (before == after, only the association changed) to add them. The fix eliminates those bogus warmup UPDATEs for the step 1b target connector. (T42 regression test covers this.)
- `onboard()` step 1 now pre-fetches each matched side's own associations via `lookup()` before seeding its shadow, storing the correct `__assoc__` sentinel. Previously the sentinel was always `undefined`, causing the warmup fullSync to fail echo detection for any record with associations and dispatch spurious empty-looking READ + UPDATE events. (T43 regression test covers this.)
- Removed warmup `{ fullSync: true }` ingest pass from `startEngine()`. The pass was a compensating mechanism for the missing-association bug in `onboard()` step 1b; now that step 1b includes associations in the fanout INSERT (and defers via `deferred_associations` when the target ID is not yet resolved), the warmup adds no value. Removed the corresponding step from the `playground.md § 8.2` boot-sequence spec.
- Engine: records with empty canonical data (`{}`) now fan out correctly to target connectors. Previously the zero-key guard in `_processRecords` (designed to suppress no-op UPDATEs) was firing for brand-new INSERTs as well, because `resolveConflicts({}, undefined) = {}`. The guard now only suppresses dispatch when `existingTargetId !== undefined` (i.e. an UPDATE with nothing to change). Newly inserted records are always dispatched and linked in `identity_map`. (T46 regression test added.)

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
