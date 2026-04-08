# plans/INDEX.md — Document Inventory

Full inventory of all documents in `plans/`. Update when adding or removing files.
When a plan is completed, update its Status here and in the plan file itself.

## poc/ — POC design intent and research

| File | What it covers | Status | Effort |
|------|---------------|--------|--------|
| [poc/PLAN_POCS.md](poc/PLAN_POCS.md) | All 10 POC phases (v0–v9) in one document | complete — historical | — |
| [poc/GAP_POC_LESSONS.md](poc/GAP_POC_LESSONS.md) | Combined lessons learned v0–v9, open gaps identified | reference | — |
| [poc/PLAN_CLOSE_POC_GAPS.md](poc/PLAN_CLOSE_POC_GAPS.md) | Plan to close 10 open gaps from the POC series | backlog | — |
| [poc/REPORT_JSONFILES_SYNC.md](poc/REPORT_JSONFILES_SYNC.md) | Research: jsonfiles connector as sync POC fixture | complete — historical | — |
| [poc/PLAN_REMOVE_POC.md](poc/PLAN_REMOVE_POC.md) | Plan to remove poc/ directory once lessons captured | complete | — |

## engine/ — Sync engine research and gap analyses

| File | What it covers | Status | Effort |
|------|---------------|--------|--------|
| [engine/GAP_IN_VS_OUT.md](engine/GAP_IN_VS_OUT.md) | Gap analysis: inbound vs outbound field handling | reference | — |
| [engine/PLAN_IDEMPOTENCY_BATCH.md](engine/PLAN_IDEMPOTENCY_BATCH.md) | Idempotency and batch action design | review - may belong in specs/sync-engine.md | — |
| [engine/GAP_OSI_PRIMITIVES.md](engine/GAP_OSI_PRIMITIVES.md) | Gap analysis: OSI-mapping schema primitives vs OpenSync - mapping inspiration | reference | — |
| [engine/PLAN_LOOKUP_MERGE_ETAG.md](engine/PLAN_LOOKUP_MERGE_ETAG.md) | Engine-side lookup-merge and ETag threading | backlog | — |
| [engine/GAP_ENGINE_DECISIONS.md](engine/GAP_ENGINE_DECISIONS.md) | Gap analysis: key engine design decisions and their rationale | reference | — |
| [engine/PLAN_CONFIG_VALIDATION.md](engine/PLAN_CONFIG_VALIDATION.md) | Config cross-reference validation (channels, connectors, auth) | backlog | — |
| [engine/PLAN_DB_MIGRATIONS.md](engine/PLAN_DB_MIGRATIONS.md) | Post-release database migration infrastructure plan | deferred — post-release | — |
| [engine/PLAN_ENGINE_SYNC_EVENTS.md](engine/PLAN_ENGINE_SYNC_EVENTS.md) | First-class SyncEvent emission from engine: extend RecordSyncResult with sourceData/sourceShadow/before/after; OnboardResult.inserts; removes ActivityLogEntry workaround from playground | complete | — |
| [engine/PLAN_NOOP_UPDATE_SUPPRESSION.md](engine/PLAN_NOOP_UPDATE_SUPPRESSION.md) | Suppress target dispatches when resolved values already match target shadow (LWW always-fires bug) — always on | complete | — |
| [engine/PLAN_SUPPRESS_NOOP_UPDATES_SWITCH.md](engine/PLAN_SUPPRESS_NOOP_UPDATES_SWITCH.md) | Per-channel opt-out for noop update suppression (for channels with external target writers) | backlog | — |
| [engine/PLAN_ECHO_DETECTION_SWITCH.md](engine/PLAN_ECHO_DETECTION_SWITCH.md) | Per-channel opt-out for echo detection (for channels needing unconditional target healing) | backlog | — |
| [engine/PLAN_DEFERRED_ASSOCIATIONS.md](engine/PLAN_DEFERRED_ASSOCIATIONS.md) | Track and retry associations that couldn't be remapped at fan-out time (missing identity link) | complete | — |
| [engine/PLAN_EAGER_ASSOCIATION_MODE.md](engine/PLAN_EAGER_ASSOCIATION_MODE.md) | Change default dispatch to eager: insert immediately without unresolvable associations, deferred retry adds them later; fixes latency and circular-ref stall | complete | — |
| [engine/PLAN_CIRCULAR_ASSOCIATION_DEADLOCK.md](engine/PLAN_CIRCULAR_ASSOCIATION_DEADLOCK.md) | Strict association mode (opt-in) + deadlock detection/breakDeadlock() — prerequisite: eager default must be in place first | backlog | — |
| [engine/PLAN_ENGINE_USABILITY.md](engine/PLAN_ENGINE_USABILITY.md) | Gap analysis: engine API friction for callers — boot protocol, silent events, step-1b associations, fan-out guard scope | superseded | — |
| [engine/PLAN_ENGINE_API_ERGONOMICS.md](engine/PLAN_ENGINE_API_ERGONOMICS.md) | Ergonomics improvements for embedded engine use: optional `auth`/`batchIdRef`/`triggerRef`, per-channel conflict override, per-connector timeout, `bootChannel()`, `pollChannel()`, `start()`/`stop()`, `SyncEvent` export, global fan-out guard scope fix, implicit channel ordering | draft | M |
| [engine/PLAN_ASSOCIATION_EVENTS.md](engine/PLAN_ASSOCIATION_EVENTS.md) | Extend RecordSyncResult with association arrays (sourceAssociations, sourceShadowAssociations, beforeAssociations, afterAssociations) so association-only changes are visible in event payloads | complete | S |
| [engine/PLAN_PREDICATE_MAPPING.md](engine/PLAN_PREDICATE_MAPPING.md) | Map association predicates through a canonical name in channel config (companyId/orgId/orgRef → companyRef); translate inbound to canonical, outbound to connector-local | complete | M |
| [engine/PLAN_DELETE_PROPAGATION.md](engine/PLAN_DELETE_PROPAGATION.md) | Opt-in delete propagation: explicit signal (record.deleted = true) + mark-and-sweep; per-channel config, circuit breaker integration | draft | — |
| [engine/PLAN_CHANNEL_CANONICAL_SCHEMA.md](engine/PLAN_CHANNEL_CANONICAL_SCHEMA.md) | Declare canonical field and association schema on channel definitions; validation that mapping targets match declared canonicals | draft | M |
| [engine/PLAN_TRANSITIVE_CLOSURE_IDENTITY.md](engine/PLAN_TRANSITIVE_CLOSURE_IDENTITY.md) | Per-field union-find identity matching: replace composite-key discover/addConnector/resolveCanonical with connected-components algorithm so A=B via email + B=C via taxId → A=B=C | complete | M |
| [engine/PLAN_LINK_GROUP.md](engine/PLAN_LINK_GROUP.md) | Confirm `link_group` (OSI-mapping §2 composite identity keys) is covered by `identityGroups`; close stale 🔶 entries in GAP_OSI_PRIMITIVES.md and field-mapping.md §10 | complete | XS |
| [engine/REPORT_DB_ANALYSIS.md](engine/REPORT_DB_ANALYSIS.md) | Database usage analysis: schema, query inventory, hot paths, gaps, and storage-mechanism evaluation | reference | — |
| [engine/PLAN_FIELD_EXPRESSIONS.md](engine/PLAN_FIELD_EXPRESSIONS.md) | Field expressions: `expression` / `reverseExpression` function fields on `FieldMapping` for combine, normalize, and decompose transforms in the embedded API | complete | S |
| [engine/PLAN_NORMALIZE_NOOP.md](engine/PLAN_NORMALIZE_NOOP.md) | Per-field `normalize` function applied at diff time to both incoming and shadow values; prevents precision-loss connectors from triggering infinite update loops | complete | S |
| [engine/PLAN_RESOLUTION_STRATEGIES.md](engine/PLAN_RESOLUTION_STRATEGIES.md) | Resolve OSI-mapping 🔶-gaps for `collect` (tests + spec fix), `bool_or` (implement), and expression resolvers (incremental `resolve` function on `FieldMapping`) | complete | S |
| [engine/PLAN_REVERSE_REQUIRED.md](engine/PLAN_REVERSE_REQUIRED.md) | Per-field `reverseRequired` boolean: suppress entire dispatched row when a required field is null; prevents premature writes until critical fields are populated | complete | XS |
| [engine/PLAN_DIRECTION_CONTROL.md](engine/PLAN_DIRECTION_CONTROL.md) | Direction control (`bidirectional` / `forward_only` / `reverse_only`): already implemented; plan closes out the stale ❌ marker in GAP_OSI_PRIMITIVES.md | complete | — |
| [engine/PLAN_DEFAULT_VALUES.md](engine/PLAN_DEFAULT_VALUES.md) | Per-field `default` and `defaultExpression` fallbacks applied on the forward pass when the source field is absent or null | complete | XS |
| [engine/PLAN_FIELD_GROUPS.md](engine/PLAN_FIELD_GROUPS.md) | Per-field `group` label for atomic resolution: all fields sharing a group resolve from the same winning source; prevents incoherent field mixes | complete | M |
| [engine/PLAN_NESTED_ARRAY_PIPELINE.md](engine/PLAN_NESTED_ARRAY_PIPELINE.md) | Forward-pass array expansion: `array_path` mapping key expands embedded JSON arrays into individual child entity records for per-element diffing, resolution, and fan-out | complete | M |
| [engine/PLAN_MULTILEVEL_ARRAY_EXPANSION.md](engine/PLAN_MULTILEVEL_ARRAY_EXPANSION.md) | Multi-level nested array expansion (deep nesting §3.4): `expansionChain` loader field, transitive parent-chain walk, `expandArrayChain` cross-join, multi-hop `array_parent_map` writes | complete | M |
| [engine/PLAN_ARRAY_COLLAPSE.md](engine/PLAN_ARRAY_COLLAPSE.md) | Reverse array expansion (array collapse): flat record → embedded array element write-back; `array_parent_map` table, `collectOnly` expansion, `_dispatchToArrayTarget`, per-parent batching | complete | M |
| [engine/PLAN_ARRAY_ORDERING.md](engine/PLAN_ARRAY_ORDERING.md) | Nested array ordering: `order_by` (custom field sort), `order: true` (CRDT ordinal via `_ordinal` injection), `order_linked_list: true` (linked-list reconstruction via `_prev`/`_next`); all applied at collapse time | complete | M |
| [engine/PLAN_ELEMENT_FILTER.md](engine/PLAN_ELEMENT_FILTER.md) | Element-level filter expressions on array expansion members; enables split-routing of one `array_path` into disjoint channels; required for safe per-type array splits with collapse | complete | M |
| [engine/PLAN_RECORD_FILTER.md](engine/PLAN_RECORD_FILTER.md) | Record-level `record_filter` / `record_reverse_filter` on mapping entries: exclude source records from resolution and canonical entities from reverse dispatch; enables discriminator routing and route-combined patterns | complete | S |
| [engine/PLAN_WRITTEN_STATE.md](engine/PLAN_WRITTEN_STATE.md) | `written_state` table: records last-written field values per target connector per entity; enables target-centric noop suppression, nested-array element tombstoning, and derived timestamps | complete | M |
| [engine/PLAN_CROSS_CHANNEL_EXPANSION.md](engine/PLAN_CROSS_CHANNEL_EXPANSION.md) | Cross-channel array expansion: `source_entity` + `parent_channel` mapping keys allow a child entity to live in a different channel than its parent; engine reads the parent connector entity and fans out into the child channel | complete | M || [engine/PLAN_PENDING_WRITES.md](engine/PLAN_PENDING_WRITES.md) | `pending_writes` table + retry loop: recover silently-dropped fan-out writes when a target connector errors; mirrors `deferred_associations` pattern | draft | S |
| [engine/PLAN_PK_AS_CHANNEL_FIELD.md](engine/PLAN_PK_AS_CHANNEL_FIELD.md) | Map a connector's own PK (`record.id`) as a canonical data field via `source: "id"` in field mappings; enables cross-connector FK references by giving foreign PKs a shared canonical name | complete | XS |
| [engine/PLAN_SCALAR_ARRAYS.md](engine/PLAN_SCALAR_ARRAYS.md) | Scalar array expansion (`scalar: true`): expand bare-scalar JSON arrays into flat child records via `_value` field; forward pass only; reverse pass (collapse) deferred | complete | S |
| [engine/PLAN_ARRAY_ELEMENT_ASSOCIATIONS.md](engine/PLAN_ARRAY_ELEMENT_ASSOCIATIONS.md) | `ElementRecord` SDK type + `element()` factory: connector-supplied associations on array elements; Symbol-branded container lets engine extract per-element associations and optional element identity (`id`) without magic string keys | proposed | S |
| [engine/PLAN_CONFIG_DECLARED_ASSOCIATIONS.md](engine/PLAN_CONFIG_DECLARED_ASSOCIATIONS.md) | Config-declared association synthesis: `record_associations` (root records) and `element_associations` (array elements) config keys synthesize `Association` objects from FK field values; no connector change required; merges with connector-supplied associations | proposed | S |
| [engine/PLAN_HARD_DELETE.md](engine/PLAN_HARD_DELETE.md) | Hard delete detection: `full_snapshot: true` entity-absence detection (synthesize deleted records when IDs vanish from full-snapshot reads) + element-absence detection (clear stale child shadow rows after array expansion, force collapse write) | proposed | M |
| [engine/PLAN_SOFT_DELETE_INSPECTION.md](engine/PLAN_SOFT_DELETE_INSPECTION.md) | Soft delete field inspection: `soft_delete:` mapping config with `deleted_flag`, `timestamp`, `active_flag`, and `expression` strategies; compiled at load time; sets `record.deleted = true` before the standard `_processRecords` path | proposed | S |
| [engine/REPORT_ARRAY_PATH_EXPRESSION.md](engine/REPORT_ARRAY_PATH_EXPRESSION.md) | Decision record: expression-based `array_path` rejected — canonical ID stability, collapse reversibility, and static config guarantees require a dotted-path string; polymorphic cases solved by connector normalization or multiple expansion members with `record_filter` | reference | — |
| [engine/PLAN_FIELD_TIMESTAMPS.md](engine/PLAN_FIELD_TIMESTAMPS.md) | Per-field timestamps — always-on shadow derivation: compare incoming values against shadow to carry forward timestamps for unchanged fields; consumes `ReadRecord.fieldTimestamps` when present; no config required | complete | S |
| [engine/PLAN_REVERSE_DEFAULT_SOURCES.md](engine/PLAN_REVERSE_DEFAULT_SOURCES.md) | Add `reverseSources` and `defaultSources` lineage declarations to `FieldMapping` for `reverseExpression` and `defaultExpression`; prerequisite for full expression scope enforcement | proposed | XS |
| [engine/PLAN_FIELD_SOURCES_ENFORCEMENT.md](engine/PLAN_FIELD_SOURCES_ENFORCEMENT.md) | Enforce expression source scopes at runtime for all three expression types (`expression`/`sources`, `reverseExpression`/`reverseSources`, `defaultExpression`/`defaultSources`); `"id"` token injects connector record ID; opt-out when declaration absent | proposed | S |
| [engine/PLAN_VALUE_MAP.md](engine/PLAN_VALUE_MAP.md) | Declarative per-field value maps (`value_map` / `reverse_value_map` / `value_map_fallback`): translate source-local enum codes to canonical codes and back; auto-inverts bijective maps; mutual exclusion with `expression` | proposed | S |
## connectors/ — Connector research and cleanup plans

| File | What it covers | Status | Effort |
|------|---------------|--------|--------|
| [connectors/PLAN_CONNECTOR_CLEANUP.md](connectors/PLAN_CONNECTOR_CLEANUP.md) | Connector code cleanup and standardisation | backlog | — |
| [connectors/PLAN_FULL_SYNC_SIGNAL.md](connectors/PLAN_FULL_SYNC_SIGNAL.md) | First-class full-sync tracking: ReadBatch.complete + fullSyncOnly + sync_state table; extends ConnectorRecord to signal sync completion | draft | — |
| [connectors/PLAN_MOCK_SERVERS.md](connectors/PLAN_MOCK_SERVERS.md) | Extract MockCrmServer + MockErpServer into standalone servers/ packages with connector tests | complete | — |
| [connectors/PLAN_SDK_HELPERS.md](connectors/PLAN_SDK_HELPERS.md) | SDK helpers implementation plan | backlog | — |
| [connectors/REPORT_SEMANTIC_SOURCES.md](connectors/REPORT_SEMANTIC_SOURCES.md) | Research: semantic source descriptions | exploration | — |
| [connectors/REPORT_DECLARATIVE_CONNECTORS.md](connectors/REPORT_DECLARATIVE_CONNECTORS.md) | Research: declarative connector format | exploration | — |
| [connectors/GAP_CONNECTOR_SDK_SPEC.md](connectors/GAP_CONNECTOR_SDK_SPEC.md) | Gap analysis: connector SDK spec completeness | reference | — |
| [connectors/PLAN_JSONFILES_LOG_FORMAT.md](connectors/PLAN_JSONFILES_LOG_FORMAT.md) | jsonfiles immutable log format: append-only writes, deduplicated reads | complete | — |
| [connectors/PLAN_NON_LOCAL_ASSOCIATIONS.md](connectors/PLAN_NON_LOCAL_ASSOCIATIONS.md) | Association targets outside the source connector's own channel — semantic type URIs, cross-channel entity name translation, stable URI passthrough | draft | — |
| [connectors/PLAN_ASSOCIATION_SCHEMA.md](connectors/PLAN_ASSOCIATION_SCHEMA.md) | Declare supported predicates on EntityDefinition via `associationSchema`; engine pre-flight checks and write-side dispatch filtering | complete | M |
| [connectors/PLAN_JSONLD_CONNECTOR_CONTRACT.md](connectors/PLAN_JSONLD_CONNECTOR_CONTRACT.md) | Replace `associations` in write payloads with inline `Ref` values in `data`; `{ '@id', '@entity' }` as a first-class FieldType variant; engine injects remapped IDs directly into the write field; optional `@context` per entity for URI-predicate (RDF) connectors | complete | L |
| [connectors/PLAN_SCHEMA_REF_AUTOSYNTH.md](connectors/PLAN_SCHEMA_REF_AUTOSYNTH.md) | Schema-driven Ref auto-synthesis: engine synthesizes `Ref` objects from plain-string FK field values when `EntityDefinition.schema` declares `{ type: 'ref', entity }` — connector returns raw API payloads, no `makeRefs()` call needed | complete | XS |
| [connectors/PLAN_FIELD_READONLY.md](connectors/PLAN_FIELD_READONLY.md) | `readonly` flag on `FieldDescriptor` for server-computed fields; engine strips on insert+update paths, pre-flight warning on mappings that target readonly fields | backlog | S |
| [connectors/PLAN_FILE_INGEST.md](connectors/PLAN_FILE_INGEST.md) | File-based ingest via SFTP, CSV, and XML: transport+parser architecture, SFTP connector, SDK csv/xml helpers, watermark strategy (mtime/hash), row-per-entity mode, write-back, HTTP/S file polling | draft | L |
| [connectors/PLAN_ASYNC_EXPORT_TRANSPORT.md](connectors/PLAN_ASYNC_EXPORT_TRANSPORT.md) | Async export transport: POST job → poll status → download result file(s); AsyncExportTransport interface, transport.asyncExport() factory, backoff/timeout poll loop, Salesforce Bulk API and HubSpot examples | draft | M |
| [connectors/PLAN_FIELD_TIMESTAMPS.md](connectors/PLAN_FIELD_TIMESTAMPS.md) | Add `fieldTimestamps?: Record<string, string>` to `ReadRecord`; connectors supply per-field modification timestamps directly, without requiring config; engine consumes as highest-priority source in per-field timestamp chain | complete | XS |
| [connectors/PLAN_READ_RECORD_UPDATED_AT.md](connectors/PLAN_READ_RECORD_UPDATED_AT.md) | Add `updatedAt?: string` to `ReadRecord`; engine uses it as the per-record LWW timestamp instead of engine ingest time (`Date.now()`) | complete | S |
| [connectors/PLAN_READ_RECORD_CREATED_AT.md](connectors/PLAN_READ_RECORD_CREATED_AT.md) | Add `createdAt?: string` to `ReadRecord`; shadow stores immutable origin timestamp; new `origin_wins` mapping-level strategy + stable `last_modified` tie-breaking via source age | complete | M |

## demo/ — CLI demo runner plans

| File | What it covers | Status | Effort |
|------|---------------|--------|--------|
| [demo/PLAN_DEMO.md](demo/PLAN_DEMO.md) | Plan: interactive demo runner with -d flag | complete | — |
| [demo/PLAN_DEMO_ENHANCEMENTS.md](demo/PLAN_DEMO_ENHANCEMENTS.md) | jsonfiles nested format + optional watermark, associations-demo example, table display | complete | — |

## playground/ — Vite browser playground plans

| File | What it covers | Status | Effort |
|------|---------------|--------|--------|
| [playground/PLAN_BROWSER_DEMO.md](playground/PLAN_BROWSER_DEMO.md) | Run the demo in a browser — no install, no terminal, just a URL | complete | — |
| [playground/PLAN_GITHUB_PAGES.md](playground/PLAN_GITHUB_PAGES.md) | Deploy the browser playground to GitHub Pages via GitHub Actions | complete | — |
| [playground/PLAN_MOVE_DEMO_BROWSER.md](playground/PLAN_MOVE_DEMO_BROWSER.md) | Move demo-browser/ to workspace root as a sibling of demo/ | complete | — |
| [playground/PLAN_RENAME_PLAYGROUND.md](playground/PLAN_RENAME_PLAYGROUND.md) | Rename demo-browser/ to playground/ and @opensync/demo-browser to @opensync/playground | complete | — |
| [playground/PLAN_MAPPING_VISUALIZATION.md](playground/PLAN_MAPPING_VISUALIZATION.md) | Visual mapping diagram in the playground: channel/field-rename diagram as a Diagram tab alternative to the YAML editor | complete | — |
| [playground/PLAN_PLAYGROUND_TESTING.md](playground/PLAN_PLAYGROUND_TESTING.md) | Playwright E2E test rig for the browser playground demo | backlog | — |
| [playground/PLAN_PLAYGROUND_MVU.md](playground/PLAN_PLAYGROUND_MVU.md) | Migrate playground from imperative DOM mutation to MVU architecture | backlog | — |
| [playground/PLAN_PLAYGROUND_SMB_SEED.md](playground/PLAN_PLAYGROUND_SMB_SEED.md) | Expand playground seed to four systems (crm/erp/hr/webshop), six entity concepts, richer fields, intentionally unmapped fields, and a new smb-demo scenario | backlog | S |
| [playground/PLAN_ARRAY_DEMO_SCENARIO.md](playground/PLAN_ARRAY_DEMO_SCENARIO.md) | Playground array-demo scenario: extend ERP seed with embedded-lines orders, add webshop system, add order-lines array-expansion channel, fix lifecycle to skip onboard for array-expansion channels | complete | S |
| [playground/PLAN_LINEAGE_ARRAY_EXPRESSIONS.md](playground/PLAN_LINEAGE_ARRAY_EXPRESSIONS.md) | Lineage diagram: array-expansion entity labels and parentField annotation; expression fan-in via `sources[]` + static analysis fallback; `resolve` hook indicator on canonical pills | complete | M |
| [playground/PLAN_NOTIFICATION_POLL.md](playground/PLAN_NOTIFICATION_POLL.md) | Debounced notification poll: separate mutation flash from propagation flash to make async sync visible | complete | — |
| [playground/PLAN_AGENT_PANEL.md](playground/PLAN_AGENT_PANEL.md) | Agent chat sidebar in the playground: natural-language mapping generation, schema Q&A, Apply-to-editor button — VS Code chat–style right panel | draft | L |
| [playground/PLAN_URL_HISTORY.md](playground/PLAN_URL_HISTORY.md) | URL hash anchors + browser history: encode scenario + active tab in `#scenario=...&tab=...`; pushState on scenario change, replaceState on tab change, popstate restores view | backlog | S |
| [playground/PLAN_VERSION_BADGE.md](playground/PLAN_VERSION_BADGE.md) | Version badge in topbar + update notification when a newer GitHub Release is available, linking to release notes | backlog | S |
| [playground/PLAN_VISUAL_CONFIG_EDITOR.md](playground/PLAN_VISUAL_CONFIG_EDITOR.md) | Visual config editor: form-based tab alongside YAML editor; compares four approaches (form, editable lineage, node-graph, schema hints) | draft | L |
| [playground/PLAN_YAML_EDITOR_FIDELITY.md](playground/PLAN_YAML_EDITOR_FIDELITY.md) | Full-fidelity YAML editor round-trip: fix lossy serialiser/parser in editor-pane.ts to cover identityGroups, array expansion, assocMappings, and conflict; reuse engine's MappingsFileSchema + buildChannelsFromEntries | complete | M |
| [playground/PLAN_HUBSPOT_TRIPLETEX_ASSOC_DEMO.md](playground/PLAN_HUBSPOT_TRIPLETEX_ASSOC_DEMO.md) | Association cardinality mismatch demo: extend existing crm/erp scenario with predicate-as-type associations; CRM uses distinct predicates (`primaryCompanyId`, `secondaryCompanyId`), ERP uses a single FK (`orgId`); whitelist routing handles selectivity with no engine changes | complete | S |

## performance/ — Performance and throughput optimisations

| File | What it covers | Status | Effort |
|------|---------------|--------|--------|
| [performance/GAP_ENGINE_SCALING.md](performance/GAP_ENGINE_SCALING.md) | Gap analysis: engine scaling behaviour — which operations are O(delta) vs O(total data) | reference | — |
| [performance/GAP_INCREMENTAL_ENGINE.md](performance/GAP_INCREMENTAL_ENGINE.md) | Gap analysis: incremental pipeline model — maps each stage to its state table, identifies where batch-at-a-time breaks true incrementality (GAP-I1–I4), and proposes per-ReadBatch commit, scoped deferred retry, and fan-out watermarks | reference | — |
| [performance/PLAN_SHARED_WATERMARK.md](performance/PLAN_SHARED_WATERMARK.md) | Shadow-derived read cursor fallback (`sinceFormat: "iso-timestamp"`) + analysis of why a `fanout_watermarks` table is not needed (`written_state` + per-ReadBatch commit suffices) | draft | S |
| [performance/PLAN_IDENTITY_SCALE.md](performance/PLAN_IDENTITY_SCALE.md) | Incremental transitive identity: replace in-memory union-find in `discover()`/`addConnector()` with SQL label propagation + expression indexes; `_resolveCanonical` ingest path unchanged | draft | L |

## meta/ — Cross-cutting project plans

| File | What it covers | Status | Effort |
|------|---------------|--------|--------|
| [meta/PLAN_SPEC_DRIVEN_MIGRATION.md](meta/PLAN_SPEC_DRIVEN_MIGRATION.md) | The spec-driven migration plan for this project | complete — historical | — |
| [meta/PLAN_DEV_PACKAGES.md](meta/PLAN_DEV_PACKAGES.md) | Plan: move dev-only packages to dev/ | complete | — |
| [meta/PLAN_PLANS_REORG.md](meta/PLAN_PLANS_REORG.md) | Reorganise plans/ into subsystem folders (demo/, playground/, meta/) | complete | XS |
| [meta/PLAN_RELEASE_PROCEDURE.md](meta/PLAN_RELEASE_PROCEDURE.md) | Release procedure: tag-triggered GitHub Pages deploy, GitHub Release creation, human checklist; npm publish deferred to M1 | backlog | S |
| [meta/PLAN_DOCS_SITE.md](meta/PLAN_DOCS_SITE.md) | Host a VitePress documentation site at `/docs/` alongside the playground on GitHub Pages — analysis of mdBook, VitePress, Docusaurus, MDX-in-Vite; recommendation and CI plan | draft | M |
| [meta/PLAN_REMOVE_WASM_FROM_HISTORY.md](meta/PLAN_REMOVE_WASM_FROM_HISTORY.md) | Expunge sql.js WASM binaries from git history; add gitignore rule; use git filter-repo | complete | XS |
| [meta/PLAN_TS_LINTING.md](meta/PLAN_TS_LINTING.md) | Code quality toolchain (linting, formatting, type hygiene) | backlog | — |
| [meta/REPORT_ASSOCIATION_NAMING.md](meta/REPORT_ASSOCIATION_NAMING.md) | Naming analysis for the `Association` concept — candidates (link, edge, ref, rel, assoc), collision map, migration scope, recommendation | draft | — |

## ecosystem/ — Related tools, frameworks, and standards in the broader integration space

| File | What it covers | Status | Effort |
|------|---------------|--------|--------|
| [ecosystem/REPORT_ECOSYSTEM_SCOUT.md](ecosystem/REPORT_ECOSYSTEM_SCOUT.md) | Scout report: landscape of adjacent tools (Airbyte, Fivetran, Meltano/Singer, n8n, Debezium, Kafka Connect, Estuary, Electric SQL, Nango, Camel, R2RML, YARRRML, and more) — category map, differentiation analysis, open questions | draft | — |
| [ecosystem/GAP_R2RML_YARRRML.md](ecosystem/GAP_R2RML_YARRRML.md) | Gap analysis: OpenSync vs R2RML / YARRRML / RML — concept mapping, transform expressiveness, identity resolution, what OpenSync can learn, what only OpenSync does | reference | — |
