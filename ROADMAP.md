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
- [x] Every validated pattern has a corresponding section in specs/

---

## Milestone 1 - Connector SDK

**Goal:** A stable, well-documented connector contract that external developers can build against.
Connectors are dumb pipes - the SDK defines what that means precisely.

Spec: [specs/connector-sdk.md](specs/connector-sdk.md) - [specs/connector-helpers.md](specs/connector-helpers.md) - [specs/connector-isolation.md](specs/connector-isolation.md)

| Item | Spec | Status |
|------|------|--------|
| Core connector interface (read, write, getEntities) | [specs/connector-sdk.md](specs/connector-sdk.md) | done |
| ConnectorContext (http, state, logger, auth) | [specs/connector-sdk.md](specs/connector-sdk.md) | done |
| Auth patterns (API key, OAuth2, prepareRequest) | [specs/auth.md](specs/auth.md) | done |
| Webhook hooks (handleWebhook, onEnable, onDisable) | [specs/connector-sdk.md](specs/connector-sdk.md) | done |
| Mock CRM server — standalone dev/servers/mock-crm/ package + connector tests | [plans/connectors/PLAN_MOCK_SERVERS.md](plans/connectors/PLAN_MOCK_SERVERS.md) | done |
| Mock ERP server — standalone dev/servers/mock-erp/ package + connector tests | [plans/connectors/PLAN_MOCK_SERVERS.md](plans/connectors/PLAN_MOCK_SERVERS.md) | done |
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
| ingest() - read, diff against shadow state, dispatch | [specs/sync-engine.md](specs/sync-engine.md) | done |
| Shadow state (val, prev, ts, src per field) | [specs/sync-engine.md](specs/sync-engine.md) | done |
| Canonical identity map (hub UUID per logical record) | [specs/identity.md](specs/identity.md) | done |
| Field mapping + rename maps | [specs/field-mapping.md](specs/field-mapping.md) | done |
| Content-based echo detection | [specs/sync-engine.md](specs/sync-engine.md) | done |
| Circuit breaker (trip / reset / persist to DB) | [specs/safety.md](specs/safety.md) | done |
| Idempotent insert / update | [specs/safety.md](specs/safety.md) | done |
| Request journal (all outbound HTTP logged) | [specs/observability.md](specs/observability.md) | done |
| OAuth2 + API-key auth via ctx.http | [specs/auth.md](specs/auth.md) | done |
| Discover + onboard (first-sync without duplicates) | [specs/discovery.md](specs/discovery.md) | done |

**Exit criteria:**
- [x] CRM contact created — appears in ERP with correct field mapping (T1)
- [x] ERP contact updated — reflected in CRM (T2)
- [x] No duplicates after 10 consecutive sync cycles (T3)
- [x] Circuit breaker trips after error batches; blocks further ingest (T4)
- [x] All outbound HTTP calls appear in request_journal (T5)
- [x] Record written mid-collect picked up on next incremental — Gap 1 fix (T6)
- [x] Tripped circuit breaker survives engine restart — Gap 2 fix (T7)
- [x] 412 Precondition Failed retried successfully — Gap 6 fix (T8)
- [x] onboard() blocked when circuit is OPEN — Gap 8 fix (T9)

---

## Milestone 3 - Engine Expansion

**Goal:** Extend the production engine with the full feature set.
No detailed plan yet - to be broken down once Milestone 2 is stable.

Covers: rollback, webhooks, addConnector, actions, CLI, YAML config, distribution,
SDK helpers (pagination, mapping, batching, state), connector cleanup.

Spec references: [specs/rollback.md](specs/rollback.md) - [specs/webhooks.md](specs/webhooks.md) - [specs/discovery.md](specs/discovery.md) - [specs/actions.md](specs/actions.md) - [specs/cli.md](specs/cli.md) - [specs/config.md](specs/config.md)

---

## Repository hygiene (ongoing)

Tracks structural and tooling improvements that are not milestone-gated.

| Item | Plan | Status |
|------|------|--------|
| Demo runner with -d flag and built-in examples | [plans/demo/PLAN_DEMO.md](plans/demo/PLAN_DEMO.md) | done |
| Move dev-only packages to dev/ | [plans/meta/PLAN_DEV_PACKAGES.md](plans/meta/PLAN_DEV_PACKAGES.md) | done |
| Spec-driven migration (plans/ reorganisation) | [plans/meta/PLAN_SPEC_DRIVEN_MIGRATION.md](plans/meta/PLAN_SPEC_DRIVEN_MIGRATION.md) | done |
| Remove poc/ directory | [plans/poc/PLAN_REMOVE_POC.md](plans/poc/PLAN_REMOVE_POC.md) | done |
| Browser playground (Vite + sql.js WASM + in-memory connectors) | [plans/playground/PLAN_BROWSER_DEMO.md](plans/playground/PLAN_BROWSER_DEMO.md) | done |
| Deploy playground to GitHub Pages | [plans/playground/PLAN_GITHUB_PAGES.md](plans/playground/PLAN_GITHUB_PAGES.md) | done |
| Reorganise plans/ into subsystem folders | [plans/meta/PLAN_PLANS_REORG.md](plans/meta/PLAN_PLANS_REORG.md) | done |
