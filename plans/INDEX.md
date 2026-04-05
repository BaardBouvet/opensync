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
| [engine/PLAN_CONFIG_VALIDATION.md](engine/PLAN_CONFIG_VALIDATION.md) | Config cross-reference validation (channels, connectors, auth) | backlog |
| [engine/PLAN_DB_MIGRATIONS.md](engine/PLAN_DB_MIGRATIONS.md) | Post-release database migration infrastructure plan | deferred — post-release |
| [engine/PLAN_FULL_SYNC_SIGNAL.md](engine/PLAN_FULL_SYNC_SIGNAL.md) | First-class full-sync tracking: ReadBatch.complete + fullSyncOnly + sync_state table | draft |

## connectors/ — Connector research and cleanup plans

| File | What it covers | Status |
|------|---------------|--------|
| [connectors/PLAN_CONNECTOR_CLEANUP.md](connectors/PLAN_CONNECTOR_CLEANUP.md) | Connector code cleanup and standardisation | backlog |
| [connectors/PLAN_MOCK_SERVERS.md](connectors/PLAN_MOCK_SERVERS.md) | Extract MockCrmServer + MockErpServer into standalone servers/ packages with connector tests | complete |
| [connectors/PLAN_SDK_HELPERS.md](connectors/PLAN_SDK_HELPERS.md) | SDK helpers implementation plan | backlog |
| [connectors/REPORT_SEMANTIC_SOURCES.md](connectors/REPORT_SEMANTIC_SOURCES.md) | Research: semantic source descriptions | exploration |
| [connectors/REPORT_DECLARATIVE_CONNECTORS.md](connectors/REPORT_DECLARATIVE_CONNECTORS.md) | Research: declarative connector format | exploration |
| [connectors/GAP_CONNECTOR_SDK_SPEC.md](connectors/GAP_CONNECTOR_SDK_SPEC.md) | Gap analysis: connector SDK spec completeness | reference |
| [connectors/PLAN_JSONFILES_LOG_FORMAT.md](connectors/PLAN_JSONFILES_LOG_FORMAT.md) | jsonfiles immutable log format: append-only writes, deduplicated reads | draft |
| [connectors/GAP_SESAM_JSON_PROTOCOLS.md](connectors/GAP_SESAM_JSON_PROTOCOLS.md) | Gap analysis: Sesam JSON Pull + Push protocol alignment with OpenSync connector SDK | draft |

## meta/ — Project meta documents

| File | What it covers | Status |
|------|---------------|--------|
| [meta/PLAN_SPEC_DRIVEN_MIGRATION.md](meta/PLAN_SPEC_DRIVEN_MIGRATION.md) | The spec-driven migration plan for this project | complete — historical |
| [meta/PLAN_DEMO.md](meta/PLAN_DEMO.md) | Plan: interactive demo runner with -d flag | complete |
| [meta/PLAN_DEV_PACKAGES.md](meta/PLAN_DEV_PACKAGES.md) | Plan: move dev-only packages to dev/ | complete |
| [meta/PLAN_DEMO_ENHANCEMENTS.md](meta/PLAN_DEMO_ENHANCEMENTS.md) | jsonfiles nested format + optional watermark, associations-demo example, table display | complete |
