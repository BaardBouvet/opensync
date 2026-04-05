# plans/INDEX.md — Document Inventory

Full inventory of all documents in `plans/`. Update when adding or removing files.
When a plan is completed, update its Status here and in the plan file itself.

## poc/ — POC design intent and research

| File | What it covers | Status |
|------|---------------|--------|
| [poc/PLAN_POCS.md](poc/PLAN_POCS.md) | All 10 POC phases (v0–v9) in one document | complete — historical |
| [poc/GAP_POC_LESSONS.md](poc/GAP_POC_LESSONS.md) | Combined lessons learned v0–v9, open gaps identified | reference |
| [poc/PLAN_CLOSE_POC_GAPS.md](poc/PLAN_CLOSE_POC_GAPS.md) | Plan to close 10 open gaps from the POC series | backlog |
| [poc/REPORT_JSONFILES_SYNC.md](poc/REPORT_JSONFILES_SYNC.md) | Research: jsonfiles connector as sync POC fixture | complete — historical |
| [poc/PLAN_REMOVE_POC.md](poc/PLAN_REMOVE_POC.md) | Plan to remove poc/ directory once lessons captured | complete |

## engine/ — Sync engine research and gap analyses

| File | What it covers | Status |
|------|---------------|--------|
| [engine/GAP_IN_VS_OUT.md](engine/GAP_IN_VS_OUT.md) | Gap analysis: inbound vs outbound field handling | reference |
| [engine/PLAN_IDEMPOTENCY_BATCH.md](engine/PLAN_IDEMPOTENCY_BATCH.md) | Idempotency and batch action design | review - may belong in specs/sync-engine.md |
| [engine/GAP_OSI_PRIMITIVES.md](engine/GAP_OSI_PRIMITIVES.md) | Gap analysis: OSI-mapping schema primitives vs OpenSync - mapping inspiration | reference |
| [engine/PLAN_LOOKUP_MERGE_ETAG.md](engine/PLAN_LOOKUP_MERGE_ETAG.md) | Engine-side lookup-merge and ETag threading | backlog |
| [engine/PLAN_TS_LINTING.md](engine/PLAN_TS_LINTING.md) | Code quality toolchain (linting, formatting, type hygiene) | backlog |
| [engine/GAP_ENGINE_DECISIONS.md](engine/GAP_ENGINE_DECISIONS.md) | Gap analysis: key engine design decisions and their rationale | reference |
| [engine/GAP_ENGINE_SCALING.md](engine/GAP_ENGINE_SCALING.md) | Gap analysis: engine scaling behaviour — which operations are O(delta) vs O(total data) | reference |
| [engine/PLAN_CONFIG_VALIDATION.md](engine/PLAN_CONFIG_VALIDATION.md) | Config cross-reference validation (channels, connectors, auth) | backlog |
| [engine/PLAN_DB_MIGRATIONS.md](engine/PLAN_DB_MIGRATIONS.md) | Post-release database migration infrastructure plan | deferred — post-release |
| [engine/PLAN_FULL_SYNC_SIGNAL.md](engine/PLAN_FULL_SYNC_SIGNAL.md) | First-class full-sync tracking: ReadBatch.complete + fullSyncOnly + sync_state table | draft |
| [engine/PLAN_NOOP_UPDATE_SUPPRESSION.md](engine/PLAN_NOOP_UPDATE_SUPPRESSION.md) | Suppress target dispatches when resolved values already match target shadow (LWW always-fires bug) — always on | complete |
| [engine/PLAN_SUPPRESS_NOOP_UPDATES_SWITCH.md](engine/PLAN_SUPPRESS_NOOP_UPDATES_SWITCH.md) | Per-channel opt-out for noop update suppression (for channels with external target writers) | backlog |
| [engine/PLAN_ECHO_DETECTION_SWITCH.md](engine/PLAN_ECHO_DETECTION_SWITCH.md) | Per-channel opt-out for echo detection (for channels needing unconditional target healing) | backlog |
| [engine/PLAN_DEFERRED_ASSOCIATIONS.md](engine/PLAN_DEFERRED_ASSOCIATIONS.md) | Track and retry associations that couldn't be remapped at fan-out time (missing identity link) | complete |
| [engine/PLAN_EAGER_ASSOCIATION_MODE.md](engine/PLAN_EAGER_ASSOCIATION_MODE.md) | Change default dispatch to eager: insert immediately without unresolvable associations, deferred retry adds them later; fixes latency and circular-ref stall | complete |
| [engine/PLAN_CIRCULAR_ASSOCIATION_DEADLOCK.md](engine/PLAN_CIRCULAR_ASSOCIATION_DEADLOCK.md) | Strict association mode (opt-in) + deadlock detection/breakDeadlock() — prerequisite: eager default must be in place first | backlog |
| [engine/REPORT_DB_ANALYSIS.md](engine/REPORT_DB_ANALYSIS.md) | Database usage analysis: schema, query inventory, hot paths, gaps, and storage-mechanism evaluation | reference |

## connectors/ — Connector research and cleanup plans

| File | What it covers | Status |
|------|---------------|--------|
| [connectors/PLAN_CONNECTOR_CLEANUP.md](connectors/PLAN_CONNECTOR_CLEANUP.md) | Connector code cleanup and standardisation | backlog |
| [connectors/PLAN_MOCK_SERVERS.md](connectors/PLAN_MOCK_SERVERS.md) | Extract MockCrmServer + MockErpServer into standalone servers/ packages with connector tests | complete |
| [connectors/PLAN_SDK_HELPERS.md](connectors/PLAN_SDK_HELPERS.md) | SDK helpers implementation plan | backlog |
| [connectors/REPORT_SEMANTIC_SOURCES.md](connectors/REPORT_SEMANTIC_SOURCES.md) | Research: semantic source descriptions | exploration |
| [connectors/REPORT_DECLARATIVE_CONNECTORS.md](connectors/REPORT_DECLARATIVE_CONNECTORS.md) | Research: declarative connector format | exploration |
| [connectors/GAP_CONNECTOR_SDK_SPEC.md](connectors/GAP_CONNECTOR_SDK_SPEC.md) | Gap analysis: connector SDK spec completeness | reference |
| [connectors/PLAN_JSONFILES_LOG_FORMAT.md](connectors/PLAN_JSONFILES_LOG_FORMAT.md) | jsonfiles immutable log format: append-only writes, deduplicated reads | complete |
| [connectors/GAP_SESAM_JSON_PROTOCOLS.md](connectors/GAP_SESAM_JSON_PROTOCOLS.md) | Gap analysis: Sesam JSON Pull + Push protocol alignment with OpenSync connector SDK | draft |
| [connectors/PLAN_NON_LOCAL_ASSOCIATIONS.md](connectors/PLAN_NON_LOCAL_ASSOCIATIONS.md) | Association targets outside the source connector's own channel — semantic type URIs, cross-channel entity name translation, stable URI passthrough | draft |

## meta/ — Project meta documents

| File | What it covers | Status |
|------|---------------|--------|
| [meta/PLAN_SPEC_DRIVEN_MIGRATION.md](meta/PLAN_SPEC_DRIVEN_MIGRATION.md) | The spec-driven migration plan for this project | complete — historical |
| [meta/PLAN_DEMO.md](meta/PLAN_DEMO.md) | Plan: interactive demo runner with -d flag | complete |
| [meta/PLAN_DEV_PACKAGES.md](meta/PLAN_DEV_PACKAGES.md) | Plan: move dev-only packages to dev/ | complete |
| [meta/PLAN_DEMO_ENHANCEMENTS.md](meta/PLAN_DEMO_ENHANCEMENTS.md) | jsonfiles nested format + optional watermark, associations-demo example, table display | complete |
| [meta/PLAN_BROWSER_DEMO.md](meta/PLAN_BROWSER_DEMO.md) | Run the demo in a browser — no install, no terminal, just a URL | draft |
