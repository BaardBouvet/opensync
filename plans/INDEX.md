# plans/INDEX.md — Document Inventory

Full inventory of all documents in `plans/`. Update when adding or removing files.

## poc/ — POC design intent and research

| File | What it covers | Status |
|------|---------------|--------|
| [poc/PLAN_POCS.md](poc/PLAN_POCS.md) | All 10 POC phases (v0–v9) in one document | complete — historical |
| [poc/GAP_POC_LESSONS.md](poc/GAP_POC_LESSONS.md) | Combined lessons learned v0–v9, open gaps identified | reference |
| [poc/PLAN_CLOSE_POC_GAPS.md](poc/PLAN_CLOSE_POC_GAPS.md) | Plan to close 10 open gaps from the POC series | backlog |
| [poc/REPORT_JSONFILES_SYNC.md](poc/REPORT_JSONFILES_SYNC.md) | Research: jsonfiles connector as sync POC fixture | reference |

## engine/ — Sync engine research and gap analyses

| File | What it covers | Status |
|------|---------------|--------|
| [engine/GAP_IN_VS_OUT.md](engine/GAP_IN_VS_OUT.md) | Gap analysis: inbound vs outbound field handling | reference |
| [engine/PLAN_IDEMPOTENCY_BATCH.md](engine/PLAN_IDEMPOTENCY_BATCH.md) | Idempotency and batch action design | review - may belong in specs/sync-engine.md |
| [engine/GAP_OSI_PRIMITIVES.md](engine/GAP_OSI_PRIMITIVES.md) | Gap analysis: OSI-mapping schema primitives vs OpenSync - mapping inspiration | reference |
| [engine/PLAN_LOOKUP_MERGE_ETAG.md](engine/PLAN_LOOKUP_MERGE_ETAG.md) | Engine-side lookup-merge and ETag threading | backlog |
| [engine/PLAN_TS_LINTING.md](engine/PLAN_TS_LINTING.md) | Code quality toolchain (linting, formatting, type hygiene) | backlog |

## connectors/ — Connector research and cleanup plans

| File | What it covers | Status |
|------|---------------|--------|
| [connectors/PLAN_CONNECTOR_CLEANUP.md](connectors/PLAN_CONNECTOR_CLEANUP.md) | Connector code cleanup and standardisation | backlog |
| [connectors/PLAN_MOCK_SERVERS.md](connectors/PLAN_MOCK_SERVERS.md) | Extract MockCrmServer + MockErpServer into standalone servers/ packages with connector tests | backlog |
| [connectors/PLAN_SDK_HELPERS.md](connectors/PLAN_SDK_HELPERS.md) | SDK helpers implementation plan | backlog |
| [connectors/REPORT_SEMANTIC_SOURCES.md](connectors/REPORT_SEMANTIC_SOURCES.md) | Research: semantic source descriptions | exploration |
| [connectors/REPORT_DECLARATIVE_CONNECTORS.md](connectors/REPORT_DECLARATIVE_CONNECTORS.md) | Research: declarative connector format | exploration |

## meta/ — Project meta documents

| File | What it covers | Status |
|------|---------------|--------|
| [meta/PLAN_SPEC_DRIVEN_MIGRATION.md](meta/PLAN_SPEC_DRIVEN_MIGRATION.md) | The spec-driven migration plan for this project | historical — keep permanently |
