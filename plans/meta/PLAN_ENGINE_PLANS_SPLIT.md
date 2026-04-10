# Plan: Split plans/engine/ into subsystem subfolders

**Status:** complete  
**Date:** 2026-04-10  
**Domain:** project structure  
**Scope:** `plans/engine/` — file moves + `plans/INDEX.md` + `plans/README.md` updates  
**Effort:** S  

---

## § 1 Problem

`plans/engine/` has grown from 22 files (at the time of `PLAN_PLANS_REORG.md`) to **72 files**
today.  Opening the folder in a file browser or IDE tree means scrolling through an undifferentiated
wall of `PLAN_*.md` names with no visual grouping by concern.

Unlike `plans/connectors/` (24 files, still manageable as-is), the engine plans cover at least
eight clearly distinct subsystems: array expansion, associations and identity, field transforms,
conflict resolution, the core sync loop, config and API surface, pending terminology renames, and
reference/research documents.  Those subsystems are invisible today.

---

## § 2 Proposed subfolders

Eight subfolders replace the flat `plans/engine/` list.  Target size is 6–15 files each.

| Subfolder | Domain | Files |
|-----------|--------|------:|
| `engine/arrays/` | Array expansion, element sets, scalar arrays, ordering, collapse | 12 |
| `engine/associations/` | Associations, identity matching, cluster merges, predicates | 9 |
| `engine/fields/` | Field transforms, expressions, defaults, value maps, embedded objects | 14 |
| `engine/conflict/` | Conflict resolution strategies, priority, concurrent-edit detection | 6 |
| `engine/sync-loop/` | Core ingest/dispatch loop, deletes, routing, written state | 12 |
| `engine/config-api/` | Config validation/hot-reload, API ergonomics, schema enforcement, health, testing | 10 |
| `engine/rename/` | Pending cross-cutting terminology renames | 3 |
| `engine/research/` | GAP analyses, REPORT documents, DB analysis, release/infra plans | 6 |

`plans/engine/` itself becomes a directory of directories — no `.md` files at its root.

---

## § 3 Complete file mapping

### § 3.1 engine/arrays/ (12 files)

| Current path | Rationale |
|---|---|
| `engine/PLAN_NESTED_ARRAY_PIPELINE.md` | Root of the array-expansion subsystem |
| `engine/PLAN_ARRAY_COLLAPSE.md` | Reverse pass: flat record → embedded array write-back |
| `engine/PLAN_ARRAY_ORDERING.md` | `order_by`, CRDT ordinal, linked-list ordering at collapse time |
| `engine/PLAN_ARRAY_ELEMENT_ASSOCIATIONS.md` | Per-element association SDK type |
| `engine/PLAN_MULTILEVEL_ARRAY_EXPANSION.md` | Multi-level nested array chains |
| `engine/PLAN_ELEMENT_FILTER.md` | Element-level filter expressions |
| `engine/PLAN_ELEMENT_SET_RESOLUTION.md` | Per-element conflict resolution across sources |
| `engine/PLAN_SCALAR_ARRAYS.md` | Bare-scalar array expansion via `scalar: true` |
| `engine/PLAN_SCALAR_ARRAY_COLLAPSE.md` | Scalar array reverse pass + multi-level scalar chains |
| `engine/PLAN_CROSS_CHANNEL_EXPANSION.md` | `source_entity` + `parent_channel` for cross-channel arrays |
| `engine/PLAN_ATOMIC_ARRAY.md` | Atomic array pattern; `normalize: stable_sort`; `element_fields` |
| `engine/REPORT_ARRAY_PATH_EXPRESSION.md` | Decision record: expression-based `array_path` rejected |

### § 3.2 engine/associations/ (9 files)

| Current path | Rationale |
|---|---|
| `engine/PLAN_ASSOCIATION_EVENTS.md` | Association arrays in `RecordSyncResult` |
| `engine/PLAN_DEFERRED_ASSOCIATIONS.md` | Retry associations unresolvable at fan-out time |
| `engine/PLAN_EAGER_ASSOCIATION_MODE.md` | Eager insert mode; deferred adds associations later |
| `engine/PLAN_CIRCULAR_ASSOCIATION_DEADLOCK.md` | Strict mode + deadlock detection |
| `engine/PLAN_TRANSITIVE_CLOSURE_IDENTITY.md` | Union-find per-field identity matching |
| `engine/PLAN_REVERSIBLE_CLUSTER_MERGE.md` | Reversible merges + cluster split API |
| `engine/PLAN_LINK_GROUP.md` | `link_group` ↔ `identityGroups` closure |
| `engine/PLAN_PREDICATE_MAPPING.md` | Association predicate translation through canonical names |
| `engine/PLAN_CONFIG_DECLARED_ASSOCIATIONS.md` | Config-declared `record_associations` / `element_associations` |

### § 3.3 engine/fields/ (14 files)

| Current path | Rationale |
|---|---|
| `engine/PLAN_FIELD_EXPRESSIONS.md` | `expression` / `reverseExpression` function fields |
| `engine/PLAN_FIELD_GROUPS.md` | Atomic group resolution |
| `engine/PLAN_FIELD_SOURCES_ENFORCEMENT.md` | Expression source scope enforcement at runtime |
| `engine/PLAN_FIELD_TIMESTAMPS.md` | Always-on shadow-derived per-field timestamps |
| `engine/PLAN_DEFAULT_VALUES.md` | `default` and `defaultExpression` fallbacks |
| `engine/PLAN_NORMALIZE_NOOP.md` | Per-field `normalize` function at diff time |
| `engine/PLAN_VALUE_MAP.md` | Declarative `value_map` / `reverse_value_map` |
| `engine/PLAN_REVERSE_DEFAULT_SOURCES.md` | `reverseSources` / `defaultSources` lineage declarations |
| `engine/PLAN_REVERSE_REQUIRED.md` | `reverseRequired`: suppress row when required field is null |
| `engine/PLAN_PK_AS_CHANNEL_FIELD.md` | `source: "id"` — map connector PK as a canonical data field |
| `engine/PLAN_SOURCE_PATH.md` | `source_path` dotted-path inline extraction |
| `engine/PLAN_PASSTHROUGH_COLUMNS.md` | Passthrough columns — rejected |
| `engine/PLAN_REQUIRE_EXPLICIT_FIELD_MAPPING.md` | `fields` absent → empty whitelist; `passthrough: true` opt-in |
| `engine/PLAN_EMBEDDED_OBJECTS.md` | Flat parent mapping: `parent:` without `array_path` |

### § 3.4 engine/conflict/ (6 files)

| Current path | Rationale |
|---|---|
| `engine/PLAN_RESOLUTION_STRATEGIES.md` | `collect`, `bool_or`, expression resolvers |
| `engine/PLAN_MAPPING_LEVEL_PRIORITY.md` | Mapping-level and field-level `priority:` |
| `engine/PLAN_PRIORITY_SEEDING.md` | Priority-aware initial field seeding |
| `engine/PLAN_CONCURRENT_EDIT_DETECTION.md` | `ConcurrentEditEvent` advisory detection |
| `engine/PLAN_CONFLICT_CONFIG_KEYS.md` | Config key design for conflict settings |
| `engine/PLAN_IDEMPOTENCY_BATCH.md` | Idempotency and batch action design |

### § 3.5 engine/sync-loop/ (12 files)

| Current path | Rationale |
|---|---|
| `engine/PLAN_NOOP_UPDATE_SUPPRESSION.md` | Suppress target dispatches when values already match shadow |
| `engine/PLAN_SUPPRESS_NOOP_UPDATES_SWITCH.md` | Per-channel opt-out for noop suppression |
| `engine/PLAN_ECHO_DETECTION_SWITCH.md` | Per-channel opt-out for echo detection |
| `engine/PLAN_LOOKUP_MERGE_ETAG.md` | Engine-side lookup-merge and ETag threading |
| `engine/PLAN_PENDING_WRITES.md` | `pending_writes` table + retry loop |
| `engine/PLAN_WRITTEN_STATE.md` | `written_state` table: last-written field values per target |
| `engine/PLAN_DELETE_PROPAGATION.md` | Opt-in delete propagation via `record.deleted = true` |
| `engine/PLAN_HARD_DELETE.md` | Full-snapshot entity-absence detection |
| `engine/PLAN_SOFT_DELETE_INSPECTION.md` | `soft_delete:` mapping config strategies |
| `engine/PLAN_DIRECTION_CONTROL.md` | `bidirectional` / `forward_only` / `reverse_only` |
| `engine/PLAN_RECORD_FILTER.md` | `record_filter` / `record_reverse_filter` on mapping entries |
| `engine/PLAN_ROUTE_COMBINED.md` | Route-combined validation and test suite |

### § 3.6 engine/config-api/ (10 files)

| Current path | Rationale |
|---|---|
| `engine/PLAN_CONFIG_VALIDATION.md` | Config cross-reference validation |
| `engine/PLAN_CONFIG_HOT_RELOAD.md` | Live config reload without restart |
| `engine/PLAN_ENGINE_API_ERGONOMICS.md` | Ergonomics improvements for embedded engine callers |
| `engine/PLAN_ENGINE_USABILITY.md` | Engine API friction gap analysis |
| `engine/PLAN_ENGINE_SYNC_EVENTS.md` | First-class `SyncEvent` emission; `RecordSyncResult` extension |
| `engine/PLAN_CHANNEL_CANONICAL_SCHEMA.md` | Canonical field + association schema on channel definitions |
| `engine/PLAN_SCHEMA_ENFORCEMENT.md` | `required` / `immutable` enforcement in `_dispatchToTarget` |
| `engine/PLAN_CONNECTOR_HEALTH_CHECK.md` | Engine-driven connector health checks |
| `engine/PLAN_CROSS_CHANNEL_DECLARATIVE_TESTS.md` | `channel_tests:` top-level key; `runChannelTests()` API |
| `engine/PLAN_INLINE_MAPPING_TESTS.md` | Inline mapping tests — rejected; superseded |

### § 3.7 engine/rename/ (3 files)

| Current path | Rationale |
|---|---|
| `engine/PLAN_ENTITY_TO_RESOURCE_RENAME.md` | Rename `entity` → `resource` throughout API |
| `engine/PLAN_INBOUND_OUTBOUND_RENAME.md` | Rename `forward`/`reverse` → `inbound`/`outbound` |
| `engine/PLAN_REFERENCES_FIELD_VOCAB.md` | Vocabulary targets; `references_field` deprecation path |

### § 3.8 engine/research/ (6 files)

| Current path | Rationale |
|---|---|
| `engine/GAP_ENGINE_DECISIONS.md` | Key engine design decisions and rationale |
| `engine/GAP_IN_VS_OUT.md` | Inbound vs outbound field handling gap analysis |
| `engine/GAP_OSI_PRIMITIVES.md` | OSI-mapping schema primitives gap analysis |
| `engine/REPORT_DB_ANALYSIS.md` | Database usage analysis: schema, query inventory, hot paths |
| `engine/PLAN_DB_MIGRATIONS.md` | Post-release database migration infrastructure (deferred) |
| `engine/PLAN_PRODUCTION_ENGINE_M2.md` | Production engine milestone plan |

---

## § 4 Before / after

| Folder | Files before | Files after |
|--------|:-----------:|:-----------:|
| `engine/` (flat) | 72 | 0 |
| `engine/arrays/` | — | 12 |
| `engine/associations/` | — | 9 |
| `engine/fields/` | — | 14 |
| `engine/conflict/` | — | 6 |
| `engine/sync-loop/` | — | 12 |
| `engine/config-api/` | — | 10 |
| `engine/rename/` | — | 3 |
| `engine/research/` | — | 6 |
| `engine/performance/` | moved from top-level `plans/performance/` | 4 |

---

## § 5 Implementation steps

### § 5.1 Shell commands

```sh
cd /workspaces/opensync/plans/engine

# Create subfolders
mkdir arrays associations fields conflict sync-loop config-api rename research

# arrays/
mv PLAN_NESTED_ARRAY_PIPELINE.md PLAN_ARRAY_COLLAPSE.md PLAN_ARRAY_ORDERING.md \
   PLAN_ARRAY_ELEMENT_ASSOCIATIONS.md PLAN_MULTILEVEL_ARRAY_EXPANSION.md \
   PLAN_ELEMENT_FILTER.md PLAN_ELEMENT_SET_RESOLUTION.md \
   PLAN_SCALAR_ARRAYS.md PLAN_SCALAR_ARRAY_COLLAPSE.md \
   PLAN_CROSS_CHANNEL_EXPANSION.md PLAN_ATOMIC_ARRAY.md \
   REPORT_ARRAY_PATH_EXPRESSION.md   arrays/

# associations/
mv PLAN_ASSOCIATION_EVENTS.md PLAN_DEFERRED_ASSOCIATIONS.md \
   PLAN_EAGER_ASSOCIATION_MODE.md PLAN_CIRCULAR_ASSOCIATION_DEADLOCK.md \
   PLAN_TRANSITIVE_CLOSURE_IDENTITY.md PLAN_REVERSIBLE_CLUSTER_MERGE.md \
   PLAN_LINK_GROUP.md PLAN_PREDICATE_MAPPING.md \
   PLAN_CONFIG_DECLARED_ASSOCIATIONS.md  associations/

# fields/
mv PLAN_FIELD_EXPRESSIONS.md PLAN_FIELD_GROUPS.md PLAN_FIELD_SOURCES_ENFORCEMENT.md \
   PLAN_FIELD_TIMESTAMPS.md PLAN_DEFAULT_VALUES.md PLAN_NORMALIZE_NOOP.md \
   PLAN_VALUE_MAP.md PLAN_REVERSE_DEFAULT_SOURCES.md PLAN_REVERSE_REQUIRED.md \
   PLAN_PK_AS_CHANNEL_FIELD.md PLAN_SOURCE_PATH.md PLAN_PASSTHROUGH_COLUMNS.md \
   PLAN_REQUIRE_EXPLICIT_FIELD_MAPPING.md PLAN_EMBEDDED_OBJECTS.md  fields/

# conflict/
mv PLAN_RESOLUTION_STRATEGIES.md PLAN_MAPPING_LEVEL_PRIORITY.md \
   PLAN_PRIORITY_SEEDING.md PLAN_CONCURRENT_EDIT_DETECTION.md \
   PLAN_CONFLICT_CONFIG_KEYS.md PLAN_IDEMPOTENCY_BATCH.md  conflict/

# sync-loop/
mv PLAN_NOOP_UPDATE_SUPPRESSION.md PLAN_SUPPRESS_NOOP_UPDATES_SWITCH.md \
   PLAN_ECHO_DETECTION_SWITCH.md PLAN_LOOKUP_MERGE_ETAG.md \
   PLAN_PENDING_WRITES.md PLAN_WRITTEN_STATE.md PLAN_DELETE_PROPAGATION.md \
   PLAN_HARD_DELETE.md PLAN_SOFT_DELETE_INSPECTION.md PLAN_DIRECTION_CONTROL.md \
   PLAN_RECORD_FILTER.md PLAN_ROUTE_COMBINED.md  sync-loop/

# config-api/
mv PLAN_CONFIG_VALIDATION.md PLAN_CONFIG_HOT_RELOAD.md \
   PLAN_ENGINE_API_ERGONOMICS.md PLAN_ENGINE_USABILITY.md \
   PLAN_ENGINE_SYNC_EVENTS.md PLAN_CHANNEL_CANONICAL_SCHEMA.md \
   PLAN_SCHEMA_ENFORCEMENT.md PLAN_CONNECTOR_HEALTH_CHECK.md \
   PLAN_CROSS_CHANNEL_DECLARATIVE_TESTS.md PLAN_INLINE_MAPPING_TESTS.md  config-api/

# rename/
mv PLAN_ENTITY_TO_RESOURCE_RENAME.md PLAN_INBOUND_OUTBOUND_RENAME.md \
   PLAN_REFERENCES_FIELD_VOCAB.md  rename/

# research/
mv GAP_ENGINE_DECISIONS.md GAP_IN_VS_OUT.md GAP_OSI_PRIMITIVES.md \
   REPORT_DB_ANALYSIS.md PLAN_DB_MIGRATIONS.md PLAN_PRODUCTION_ENGINE_M2.md  research/
```

### § 5.2 plans/INDEX.md

Replace the single flat `## engine/` section with eight sections:
`## engine/arrays/`, `## engine/associations/`, `## engine/fields/`, `## engine/conflict/`,
`## engine/sync-loop/`, `## engine/config-api/`, `## engine/rename/`, `## engine/research/`.

Update every link in those sections from `engine/PLAN_*.md` → `engine/<subfolder>/PLAN_*.md`.

### § 5.3 plans/README.md

Update the "Subdirectory structure" table to list the new `engine/` subfolders.

### § 5.4 AGENTS.md

`AGENTS.md` currently lists `plans/engine/` as an example path.  Update the example list
to show the nested form (`plans/engine/arrays/`, …) so contributors know flat files at
`plans/engine/*.md` are no longer accepted.

---

## § 6 Spec changes planned

None. This is a file-organisation change only. No spec content is added, removed, or modified.

---

## § 7 Not in scope

- `plans/connectors/` — 24 files, borderline but manageable. Deferred.
- Any content edits to the moved plan files.
- Updating internal cross-references between plan files (these are advisory links, not load-bearing).
