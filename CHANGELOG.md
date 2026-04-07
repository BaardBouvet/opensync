# Changelog

All notable changes to OpenSync are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

During development: add bullets under `[Unreleased]` using `### Added` / `### Fixed` / `### Changed`.
At release: distill into a short intro paragraph + bold-label bullets, remove the working notes. See `[0.1.0]`.

---

## [0.2.0] — 2026-04-07

The field-mapping pipeline release. The engine now has a complete, OSI-mapping-compatible
transformation layer between raw connector records and the canonical model. A new `array-demo`
playground scenario exercises the headline features — webshop purchases with nested line items
syncing bidirectionally with a flat ERP — and a clutch of engine correctness fixes make the
whole stack more reliable.

### Highlights

- **Array expansion and collapse** — source records with JSON array fields expand into
  individual child entity records on ingest (`array_path`, `element_key`, `scalar: true`).
  Changes from flat connectors write back to the correct element in the parent array via
  `array_parent_map`. Multi-level chains, element filters, and three ordering strategies
  (CRDT ordinal, CRDT linked-list, `order_by`) are all supported.
- **Transitive identity closure** — `discover()` and `_resolveCanonical()` now use a
  union-find algorithm. Records linked pairwise (A=B by email, B=C by taxId) are correctly
  collapsed into one entity regardless of chain length.
- **Association predicate mapping** — `assocMappings` on a channel member translates local
  predicate names to a canonical routing key (e.g. CRM `companyId` and ERP `orgId` both map
  to `companyRef`). Each target receives its own predicate name; the canonical key is never
  stored in shadow state.

### New Features

- **Field expressions** — `expression` and `reverseExpression` on a mapping entry compute or
  combine canonical fields from the raw source record (forward) and decompose canonical fields
  back into multiple connector fields (reverse).
- **Normalize** — a per-field `normalize` function applied to both sides of the noop diff
  prevents precision-loss connectors (phone formatting, float rounding, date truncation) from
  triggering infinite update loops.
- **Defaults** — `default` (static value) and `defaultExpression` (function of the partial
  canonical record) fill absent or null source fields during the forward pass.
- **Atomic field groups** — the `group` label on related mapping entries ensures they resolve
  from the same winning source, preventing incoherent mixes like ERP winning `street` while
  CRM wins `city`.
- **Reverse-required guard** — `reverseRequired: true` suppresses dispatch to a target
  connector when a named field is absent after outbound mapping.
- **Resolution strategies** — `bool_or` latches a field to `true` once any source sets it
  truthy (useful for deletion flags). `resolve` accepts an arbitrary per-field reducer function.
- **Compound identity groups** — `identityGroups` replaces `identityFields` for AND-within-
  group / OR-across-groups semantics; all fields in a group must match simultaneously.
- **Target-centric noop suppression** — a new `written_state` table records field values last
  written per target connector; outbound dispatches are suppressed when nothing has changed
  from the target's perspective, even if the canonical record changed.
- **`RecordSyncResult` payloads** — results now carry `sourceData`, `sourceShadow`, `before`,
  `after`, and association arrays. Association-only changes (contact moves company, fields
  unchanged) now produce a visible `"read"` result.

### Fixes

- `onboard()` step 1b now includes remapped associations in fanout INSERTs, eliminating bogus
  empty-looking UPDATE events during warmup.
- `onboard()` step 1 pre-fetches each side's associations before seeding shadow state, fixing
  spurious READ + UPDATE events for records with associations.
- Removed warmup `{ fullSync: true }` ingest pass from `startEngine()`; it was a compensating
  workaround for the onboard association bug and is no longer needed.
- Records with empty canonical data (`{}`) now fan out correctly to target connectors; the
  zero-key noop guard no longer fires for brand-new INSERTs.
- Engine child identity link — array-expanded children now have their source connector ID
  recorded in `identity_map` and a `shadow_state` row written.
- `_resolveCanonical` now searches shadow state across all entity names used by other channel
  members, fixing silent duplicate canonicals when connectors use different entity names.
- Playground Ctrl/Cmd+Enter to save was silently swallowed in both the YAML config editor and
  the JSON record editor; custom save bindings are now registered before `defaultKeymap`.

### Playground

- **`array-demo` scenario** — live end-to-end demo of array expansion/collapse; sub-object
  cards are read-only with a `⊂ entity.arrayPath` annotation and a `↑ parent: <id>` badge
  that scrolls to the parent record.
- **Notification poll** — record edits trigger a debounced 800 ms engine tick with a visible
  countdown bar and a two-phase flash (edited card instantly; synced copies ~800 ms later).
- **Lineage diagram** — array-source entity labels, parent-field pills, expression fan-in
  arrows, `(expression)` placeholder pills, and a resolver `ƒ` badge on canonical chips.
- **Association diffs in event log** — association changes render as diff rows; an
  association-only change is no longer shown as "(no field changes)".
- **UI polish** — tab activity dots, alphabetical column order, resizable shadow panel, flash
  fix for sub-object watermarks.

### Testing & Quality

- T42: regression guard for onboard step 1b missing-association fanout INSERT.
- T43: regression guard for onboard step 1 missing `__assoc__` sentinel in shadow seed.
- T44: association-only change produces separate before/after association arrays in result.
- T45: cross-predicate association rename path (CRM `companyId` → canonical → ERP `orgId`).
- T46: empty canonical data record fans out correctly on first INSERT.
- NA2 updated, NA11–NA12 added: source-child identity link and cross-entity-name canonical
  lookup in array channels.

---

## [Unreleased]

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
