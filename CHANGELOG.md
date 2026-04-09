# Changelog

All notable changes to OpenSync are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

During development: add bullets under `[Unreleased]` using `### Added` / `### Fixed` / `### Changed`.
At release: distill into a short intro paragraph + bold-label bullets, remove the working notes. See `[0.1.0]`.

---

## [Unreleased]

### Added
- **Browser Playground — version badge** — the playground topbar now shows the current version (e.g. `v0.1.0`) injected at build time via Vite `define`. When the GitHub Releases API reports a newer version, a dismissible update notification (`v0.2.0 available`) appears linking to the release notes. Spec: `specs/playground.md §2.5`.
- **Browser Playground — URL history** — the active scenario and channel tab are now reflected in the URL hash (`#scenario=<key>&tab=<id>`). Scenario switches push a history entry so Back/Forward work. Tab switches replace the entry. On load, the hash is restored. Shareable links and bookmarks work. Spec: `specs/playground.md §12`.
- **Browser Playground — lineage unmapped entity pool** — the lineage diagram now shows an `unassigned` row at the bottom listing every connector entity not yet covered by any channel mapping. When all entities are mapped the row is omitted. Spec: `specs/playground.md §11.14`.
- **Browser Playground — `empty` scenario** — new blank-canvas scenario with empty `channels: []` and `mappings: []`; every connector entity appears in the lineage unassigned pool.

### Fixed
- **Sync Engine — SQL syntax error on memberless channel** — `channelStatus()` and `onboardedConnectors()` built `WHERE ()` / `IN ()` clauses when a channel had zero members (e.g. the playground `empty` scenario or a manually-typed `channels: [{id: foo}]` with no mappings). Now both methods return early with `"uninitialized"` / `[]` respectively. Regression test T47 added.
- **Sync Engine — pre-flight FK warning** — the §8.2 warning now checks whether the target entity is registered for that connector in **any** channel, not just the same channel. Cross-channel FK targets (e.g. `contacts.companyId → companies`) are intentional and no longer produce a spurious warning.
- **WaveApps connector — stale `associations` field** — `invoiceToRecord()` was still returning an `associations: [...]` array on `ReadRecord` (removed from the SDK). Replaced with `entity: 'customer'` on the `customer.id` `FieldDescriptor` so the engine auto-synthesises the Ref from the plain string value.
- **Specs / docs / playground — stale association API references** — removed all remaining references to the old `ReadRecord.associations` / `InsertRecord.associations` / `UpdateRecord.associations` / `associationSchema` APIs across `specs/sync-engine.md`, `specs/connector-sdk.md`, `specs/playground.md`, `docs/connectors/guide.md`, `docs/connectors/advanced.md`, and the playground source. Dead `associations` parameter removed from `InMemoryConnector.insertRecord` / `updateRecord` and the `SystemsPaneCallbacks.onSave` signature. `RecordWithMeta` gains an explicit `associations?` field for UI badge display.

### Changed
- **jsonfiles connector — `entities` dict config** — replaced `filePaths: string[]` + `schemas: Record<entityName, …>` with a single `entities: Record<entityName, { filePath: string; schema?: … }>` dict, co-locating each entity's file path and FK schema in one entry. All tests, demo configs, and specs updated.
- **Connector SDK — `associationSchema` removed** — `EntityDefinition.associationSchema` and `AssociationDescriptor` are removed. FK declarations now live exclusively on `FieldDescriptor.entity` in `EntityDefinition.schema`. The engine write-side filter and pre-flight warning now derive FK field set from `schema[field].entity`. SPARQL connector updated: `entity` is now included in the `FieldDescriptor` for `refEntity` props. Specs updated: `specs/connector-sdk.md §EntityDefinition`, `specs/associations.md §8`.
- **Connector SDK — `AssociationDescriptor` simplified** — `description`, `required`, and `multiple` removed; it now carries only `targetEntity: string`. Engine §8.3 required-association warning removed. Specs updated: `specs/connector-sdk.md §Association Schema`, `specs/associations.md §8.3`.
- **Connector SDK — `associations` removed from write records** — `InsertRecord.associations` and `UpdateRecord.associations` are removed. FK IDs are already present as plain strings in `data[predicate]` under the target-local predicate name; no connector needs the parallel metadata. Source-local FK values are stripped from `data` at dispatch time and replaced with remapped target-local IDs. If the association target is not yet cross-linked, the field is absent from `data` (a deferred row ensures the engine retries once the link is established). jsonfiles connector redesigned to use `config.schemas` for FK field declarations (e.g. `{ contacts: { companyId: { entity: "companies" } } }`) and stores plain string IDs in `data`. Tripletex connector updated to use `record.data["orgId"]` directly. Specs updated: `specs/connector-sdk.md §Write Records`, `specs/associations.md §7.2–7.3, §8.1`.
- **Connector SDK — Write payloads carry plain strings** — FK reference fields in `InsertRecord.data` and `UpdateRecord.data` are now plain remapped ID strings (not `Ref` objects). `readRefs()` and `makeRefs()` are removed from the SDK — they are no longer needed. Specs updated: `specs/connector-sdk.md §Write Records`, `specs/associations.md §7.2–7.3`. HubSpot, SPARQL, and jsonfiles connectors updated.
- **Connector SDK — Associations are now inline `Ref` values in `data`** — replaced the parallel `associations?: Association[]` field on `ReadRecord` with inline `Ref` objects (`{ '@id': string; '@entity'?: string }`) embedded directly in `data`. The engine extracts the association graph by scanning `data` for Ref-shaped values and uses `entity` on `FieldDescriptor`, `associationSchema`, or `@entity` on the Ref for entity inference. `FieldDescriptor` gains `entity?: string` for FK annotation; `EntityDefinition` gains optional `context?` for RDF connectors. HubSpot, SPARQL, and jsonfiles connectors updated. Specs updated: `specs/connector-sdk.md`, `specs/associations.md`.
- **Connector SDK — `FieldDescriptor.entity` for FK declarations** — declaring a field as an FK reference is `{ type: 'string', entity: 'company' }` on `FieldDescriptor`. Engine synthesizes Ref associations from plain strings automatically. `makeRefs()` updated to read `descriptor.entity`. The previous `{ type: 'ref' }` variant is removed from `FieldType`.
- **Connector SDK — `Association.metadata` removed** — unused edge-property field dropped from the `Association` interface and spec; no connector ever populated it.

### Fixed
- **Sync Engine — Association cardinality mismatch on update** — when a source connector that only maps some association predicates (e.g. ERP with `orgId → primaryRef`) triggers an UPDATE to a target with more predicates (e.g. CRM with `primaryCompanyId + secondaryCompanyId`), the target's predicates that the source cannot express are now preserved rather than silently dropped. Also fixed: `collectOnly` ingest now stores the association sentinel in the source shadow so it survives the subsequent `onboard()` shadow rewrite when `lookup()` is unavailable. — `ScenarioDefinition` now holds a raw `yaml: string` instead of parsed `ChannelConfig[]`. The engine boots from the YAML string via `MappingsFileSchema` + `buildChannelsFromEntries`. The config editor pane displays the scenario's raw YAML directly (no lossy serialiser). Editing and saving validates with the engine's own parser — all config keys (`array_path`, `assoc`, `expression`, `reverse_expression`, `normalize`, `resolve`, `conflict`, etc.) now round-trip perfectly.
- **Sync Engine — `expression`, `reverse_expression`, `normalize`, `resolve` as YAML strings** — all four field-mapping function hooks are now expressible as inline JavaScript expression strings in YAML, compiled at parse time via `new Function()`. `defaultExpression` remains the only TypeScript-only function type (planned for a follow-up).
- **Sync Engine — `conflict:` block in `MappingsFileSchema`** — the top-level `conflict:` section is now part of the validated schema (`ConflictConfigSchema`), allowing conflict strategy to be specified in YAML config files and playground scenarios.
- **Connector SDK — `AssociationDescriptor` + `associationSchema`** — entities can now declare which association predicates they support via `associationSchema?: Record<string, AssociationDescriptor>` on `EntityDefinition`. The engine uses this for three things: (1) write-side filter — only declared predicates are included in `InsertRecord`/`UpdateRecord.associations` dispatched to the target; (2) pre-flight warnings at channel setup when a `targetEntity` is not a channel member; (3) advisory `missing_required_association` warnings in `RecordSyncResult` when a predicate marked `required: true` is absent. The SPARQL connector uses this automatically via its `makeRdfEntity` factory. Spec: `specs/associations.md § 8`.
- **Playground — `assoc-cardinality` scenario** — new scenario demonstrating the CRM many-to-many ↔ ERP single-FK association mismatch using predicate-as-type routing; CRM seed extended with `primaryCompanyId`/`secondaryCompanyId` distinct predicates; `associations-demo` updated to match.
- **HubSpot Connector — contact company associations** — `contact` entity now fetches company associations via the v4 Associations API on read (batch per page) and writes them back on insert/update. Typed edges use predicate-as-type: `typeId 1` → `primaryCompanyId`, `typeId 279` → `companyId`. Unknown typeIds are silently skipped.
- **Tripletex Connector — contact entity** — new `contact` entity backed by `/contact`; exposes the embedded `customer` FK as an `orgId` association on read; reconstructs `customer: { id }` from the `orgId` association on write. Webhook subscription registered on `onEnable`.
- **Connector SDK spec — write-side association guidance** — added note to `specs/connector-sdk.md §Write Records` describing how connectors should translate `InsertRecord.associations` / `UpdateRecord.associations` into target API primitives, and that unknown predicates must be silently skipped.
- **Connector SDK — `ReadRecord.updatedAt`** — connectors supply an ISO 8601 modification timestamp; engine uses it as the LWW basis for every field in the record, replacing ingest time.
- **Connector SDK — `ReadRecord.createdAt`** — connectors supply an ISO 8601 creation timestamp; stored once in `shadow_state` (immutable); enables `origin_wins` conflict resolution and stable LWW tie-breaking by source age.
- **Connector SDK — `ReadRecord.fieldTimestamps`** — connectors supply per-field modification timestamps; engine uses these as the highest-priority LWW source for named fields, ahead of shadow derivation.
- **Sync Engine — Per-field timestamp derivation (always-on)** — `computeFieldTimestamps` in `mapping.ts` computes a per-field timestamp map on every ingest using the priority chain: `fieldTimestamps` → shadow derivation (`max(shadow.ts, ingestTs)`) → `ingestTs`. No config required.
- **Sync Engine — `origin_wins` conflict strategy** — new global and per-field strategy; earlier `createdAt` wins; falls back to LWW when `createdAt` is absent.
- **Sync Engine — `created_at` column in `shadow_state`** — stores the source-reported creation time with set-if-NULL semantics; exposed via `dbGetSourceCreatedAts` for tie-breaking.

---

## [0.2.0] — 2026-04-07

The field-mapping pipeline release. The engine gains most of the OSI-mapping primitive set:
field expressions, normalize, defaults, atomic groups, array expansion/collapse, transitive
identity, and association predicate routing. A few primitives are still outstanding and will
land in a follow-up. A new `array-demo` playground scenario exercises the headline features
end-to-end — webshop purchases with nested line items syncing bidirectionally with a flat ERP.

### Added

- **Sync Engine — Array expansion and collapse** — JSON array fields expand into individual
  child entity records on ingest (`array_path`, `element_key`, `scalar: true`). Changes from
  flat connectors write back to the correct element via `array_parent_map`. Multi-level
  chains, element filters, and three ordering strategies (CRDT ordinal, CRDT linked-list,
  `order_by`) are all supported.
- **Sync Engine — Transitive identity closure** — `discover()` and `_resolveCanonical()` now
  use a union-find algorithm; records linked pairwise (A=B by email, B=C by taxId) collapse
  into one entity regardless of chain length.
- **Sync Engine — Compound identity groups** — `identityGroups` replaces `identityFields` for
  AND-within-group / OR-across-groups semantics; all fields in a group must match
  simultaneously.
- **Sync Engine — Association predicate mapping** — `assocMappings` translates local predicate
  names to a canonical routing key so each system receives its own name (e.g. CRM `companyId`
  and ERP `orgId` both map to `companyRef`).
- **Sync Engine — Field expressions** — `expression` / `reverseExpression` compute or combine
  canonical fields from raw source records (forward) and decompose them back into connector
  fields (reverse).
- **Sync Engine — Normalize** — a per-field `normalize` function on both sides of the noop
  diff prevents precision-loss connectors (phone formatting, float rounding) from causing
  infinite update loops.
- **Sync Engine — Defaults** — `default` (static) and `defaultExpression` (function of
  partial canonical) fill absent or null source fields during the forward pass.
- **Sync Engine — Atomic field groups** — the `group` label ensures related fields (e.g. an
  address block) all resolve from the same winning source.
- **Sync Engine — Reverse-required guard** — `reverseRequired: true` suppresses dispatch when
  a named field is absent after outbound mapping.
- **Sync Engine — Resolution strategies** — `bool_or` latches a field to `true` once any
  source sets it truthy; `resolve` accepts an arbitrary per-field reducer function.
- **Sync Engine — Target-centric noop suppression** — `written_state` records values last
  written per target connector; dispatches are suppressed when nothing has changed from the
  target's perspective.
- **Sync Engine — `RecordSyncResult` payloads** — results carry `sourceData`, `sourceShadow`,
  `before`, `after`, and association arrays; association-only changes now produce a visible
  `"read"` result.
- **Playground — `array-demo` scenario** — live end-to-end demo of array expansion/collapse;
  sub-object cards are read-only with a `⊂ entity.arrayPath` annotation and a
  `↑ parent: <id>` badge that scrolls to the parent record.
- **Playground — Notification poll** — record edits trigger a debounced 800 ms engine tick
  with a visible countdown bar and a two-phase flash (edited card instantly; synced copies
  ~800 ms later).
- **Playground — Lineage diagram** — array-source entity labels, parent-field pills,
  expression fan-in arrows, `(expression)` placeholder pills, and a resolver `ƒ` badge on
  canonical chips.
- **Playground — Association diffs in event log** — association changes render as diff rows;
  association-only changes are no longer shown as "(no field changes)".
- **Playground — UI polish** — tab activity dots, alphabetical column order, resizable shadow
  panel, flash fix for sub-object watermarks.

### Fixed

- **Sync Engine** — `onboard()` step 1b now includes remapped associations in fanout INSERTs,
  eliminating bogus empty-looking UPDATE events during warmup.
- **Sync Engine** — `onboard()` step 1 pre-fetches each side's associations before seeding
  shadow state, fixing spurious READ + UPDATE events for records with associations.
- **Sync Engine** — Removed the warmup `{ fullSync: true }` ingest pass; it was a compensating
  workaround for the onboard association bug and is no longer needed.
- **Sync Engine** — Records with empty canonical data (`{}`) now fan out correctly; the
  zero-key noop guard no longer fires for brand-new INSERTs.
- **Sync Engine** — Array-expanded children now have their source connector ID recorded in
  `identity_map` and a `shadow_state` row written, fixing empty order-line cards in the
  playground.
- **Sync Engine** — `_resolveCanonical` now searches across all entity names used by other
  channel members, fixing silent duplicate canonicals when connectors use different entity
  names.
- **Playground** — Ctrl/Cmd+Enter to save was silently swallowed in the YAML config editor
  and JSON record editor; custom bindings are now registered before `defaultKeymap`.

### Testing & Quality

- T42–T46: regression guards for onboard association bugs and empty canonical fanout.
- NA2 updated, NA11–NA12 added: source-child identity link and cross-entity-name lookup.

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
