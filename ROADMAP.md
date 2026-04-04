# OpenSync - ROADMAP

> The master tracker. Update this when a milestone's exit criteria is fully met.
> Status: done | not started | in progress | deferred

---

## Milestone 0 - POC Validation (v0-v9)

**Goal:** Validate all core engine design decisions before writing production code.
Every POC version answers a specific question. Lessons feed back into specs.

| Item | Plan | Status |
|------|------|--------|
| v0: minimal 2-system sync | [plans/poc/PLAN_POCS.md](plans/poc/PLAN_POCS.md) | done |
| v1: canonical UUID + N-way | [plans/poc/PLAN_POCS.md](plans/poc/PLAN_POCS.md) | done |
| v2: declarative field mapping | [plans/poc/PLAN_POCS.md](plans/poc/PLAN_POCS.md) | done |
| v3: content-based echo detection | [plans/poc/PLAN_POCS.md](plans/poc/PLAN_POCS.md) | done |
| v4: SQLite state + circuit breakers | [plans/poc/PLAN_POCS.md](plans/poc/PLAN_POCS.md) | done |
| v5: HTTP surface + webhooks | [plans/poc/PLAN_POCS.md](plans/poc/PLAN_POCS.md) | done |
| v6: OAuth2 + ETag threading | [plans/poc/PLAN_POCS.md](plans/poc/PLAN_POCS.md) | done |
| v7: discover + onboard | [plans/poc/PLAN_POCS.md](plans/poc/PLAN_POCS.md) | done |
| v8: addConnector to live channel | [plans/poc/PLAN_POCS.md](plans/poc/PLAN_POCS.md) | done |
| v9: ingest-first DB-backed identity | [plans/poc/PLAN_POCS.md](plans/poc/PLAN_POCS.md) | done |
| LESSONS.md for all completed POCs | poc/vN/LESSONS.md | done (v0–v9) |

**Exit criteria:**
- [x] All POC versions have a LESSONS.md
- [ ] Every validated pattern has a corresponding section in specs/

---

## Milestone 1 - Connector SDK

**Goal:** A stable, well-documented connector contract that external developers can build against.
Connectors are dumb pipes - the SDK defines what that means precisely.

Spec: [specs/connector-sdk.md](specs/connector-sdk.md) - [specs/sdk-helpers.md](specs/sdk-helpers.md) - [specs/connector-isolation.md](specs/connector-isolation.md)

| Item | Spec | Status |
|------|------|--------|
| Core connector interface (read, write, getEntities) | [specs/connector-sdk.md](specs/connector-sdk.md) | done |
| ConnectorContext (http, state, logger, auth) | [specs/connector-sdk.md](specs/connector-sdk.md) | done |
| Auth patterns (API key, OAuth2, prepareRequest) | [specs/auth.md](specs/auth.md) | done |
| Webhook hooks (handleWebhook, onEnable, onDisable) | [specs/connector-sdk.md](specs/connector-sdk.md) | done |
| Mock CRM server — standalone servers/mock-crm/ package + connector tests | [plans/connectors/PLAN_MOCK_SERVERS.md](plans/connectors/PLAN_MOCK_SERVERS.md) | not started |
| Mock ERP server — standalone servers/mock-erp/ package + connector tests | [plans/connectors/PLAN_MOCK_SERVERS.md](plans/connectors/PLAN_MOCK_SERVERS.md) | not started |
| SDK helpers (pagination, mapping, batching, state) | [plans/connectors/PLAN_SDK_HELPERS.md](plans/connectors/PLAN_SDK_HELPERS.md) | deferred to M3 |
| Connector cleanup - migrate all connectors to SDK helpers | [plans/connectors/PLAN_CONNECTOR_CLEANUP.md](plans/connectors/PLAN_CONNECTOR_CLEANUP.md) | deferred to M3 |
| Connector isolation contract | [specs/connector-isolation.md](specs/connector-isolation.md) | not started |
| Connector distribution (npm packaging) | [specs/connector-distribution.md](specs/connector-distribution.md) | not started |

**Exit criteria:**
- [ ] bun run tsc --noEmit passes across all packages
- [ ] bun test passes for all connector unit tests
- [ ] SDK helpers implemented and used by at least two connectors
- [ ] A new connector can be written from the spec alone with no engine knowledge

---

## Milestone 2 - Minimal Production Engine

**Goal:** A production-quality engine covering what the POCs validated - no more, no less.
Bi-directional sync between two real connectors, running unattended, with no data loss.

Spec: [specs/sync-engine.md](specs/sync-engine.md) - [specs/identity.md](specs/identity.md) - [specs/field-mapping.md](specs/field-mapping.md) - [specs/safety.md](specs/safety.md)
Plan: [plans/engine/PLAN_PRODUCTION_ENGINE_M2.md](plans/engine/PLAN_PRODUCTION_ENGINE_M2.md)

| Item | Spec | Status |
|------|------|--------|
| ingest() - read, diff against shadow state, dispatch | [specs/sync-engine.md](specs/sync-engine.md) | not started |
| Shadow state (val, prev, ts, src per field) | [specs/sync-engine.md](specs/sync-engine.md) | not started |
| Canonical identity map (hub UUID per logical record) | [specs/identity.md](specs/identity.md) | not started |
| Field mapping + rename maps | [specs/field-mapping.md](specs/field-mapping.md) | not started |
| Content-based echo detection | [specs/sync-engine.md](specs/sync-engine.md) | not started |
| Circuit breaker (trip / reset) | [specs/safety.md](specs/safety.md) | not started |
| Idempotent insert / update | [specs/safety.md](specs/safety.md) | not started |
| Request journal (all outbound HTTP logged) | [specs/observability.md](specs/observability.md) | not started |
| OAuth2 + API-key auth via ctx.http | [specs/auth.md](specs/auth.md) | not started |
| Discover + onboard (first-sync without duplicates) | [specs/discovery.md](specs/discovery.md) | not started |

**Exit criteria:**
- [ ] CRM contact created - appears in ERP with correct field mapping
- [ ] ERP contact updated - reflected in CRM
- [ ] No duplicates after 10 consecutive sync cycles
- [ ] Deleting 60% of source records trips the circuit breaker, does not propagate
- [ ] All outbound HTTP calls appear in request_journal

---

## Milestone 3 - Engine Expansion

**Goal:** Extend the production engine with the full feature set.
No detailed plan yet - to be broken down once Milestone 2 is stable.

Covers: rollback, webhooks, addConnector, actions, CLI, YAML config, distribution,
SDK helpers (pagination, mapping, batching, state), connector cleanup.

Spec references: [specs/rollback.md](specs/rollback.md) - [specs/webhooks.md](specs/webhooks.md) - [specs/discovery.md](specs/discovery.md) - [specs/actions.md](specs/actions.md) - [specs/cli.md](specs/cli.md) - [specs/config.md](specs/config.md)
