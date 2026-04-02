# OpenSync: Phased Implementation Plan

All 8 phases must be complete before first release. See individual phase specs for details.

## Phase Dependency Graph

```
Phase 1 (Foundation)
  │
  v
Phase 2 (Core Pipeline) ──────┬──────────┐
  │                            │          │
  v                            v          v
Phase 3 (Reliability)    Phase 5      Phase 7
  │                      (Onboarding) (Actions)
  v                            │
Phase 4 (Webhooks/Auth)        │
  │                            │
  v                            v
Phase 6 (Undo/Rollback) ◄─────┘
  │
  v
Phase 8 (CLI & Polish)
```

## Phase Summary

| Phase | Name | Goal | Depends On |
|-------|------|------|------------|
| 1 | Foundation | Monorepo, SDK types, DB schema, mock connectors | — |
| 2 | Core Pipeline | Bi-directional sync between mock-crm and mock-erp | 1 |
| 3 | Reliability & Safety | Circuit breakers, idempotency, retry, job queue | 2 |
| 4 | Webhooks & Auth | Real-time sync, OAuth, bespoke auth | 3 |
| 5 | Onboarding & Discovery | Match existing records, link them, prevent echo storm | 2 |
| 6 | Undo & Rollback | Transaction log, single/batch/full rollback | 2 |
| 7 | Actions & Workflows | Event bus, push-only action connectors, triggers | 2 |
| 8 | CLI & Polish | CLI tool, YAML config, docs, npm packaging | All |

## Verification Scenario

After all phases, this end-to-end flow must work:

1. `opensync init` → creates DB
2. `opensync add-connector mock-crm` + `opensync add-connector mock-erp`
3. `opensync match crm erp --entity contact` → shows match report
4. `opensync sync --full` → initial sync, shadow state populated
5. Modify a contact in mock-crm → `opensync sync` → change appears in mock-erp
6. Modify same field in both → conflict resolved per rules
7. Delete 50% of records in source → circuit breaker trips
8. `opensync rollback <batch>` → changes reverted
9. Webhook arrives → queued → processed → propagated
10. Trigger fires → action connector executes

## Testing Strategy

- **Framework**: Vitest
- **Unit tests**: Pure functions (diff, transform, resolve) with table-driven tests
- **Integration tests**: Database-backed, in-memory SQLite (`:memory:`)
- **End-to-end tests**: Full pipeline with mock connectors in `tests/integration/`
- **Coverage target**: 80%+ core pipeline, 90%+ safety modules
