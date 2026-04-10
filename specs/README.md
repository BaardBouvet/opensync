# OpenSync Specs

Complete specification for OpenSync — an open-source, developer-friendly, bi-directional sync engine.

The specs in this directory reflect the design proven across POC v0–v9. Where a spec conflicts
with a POC lesson, the POC wins and the spec should be updated.

## Architecture & Design
- [overview.md](overview.md) — Architecture, philosophy, tech stack, data flow

## Components
- [connector-sdk.md](connector-sdk.md) — Connector interfaces, capabilities, lifecycle, ConnectorContext
- [connector-isolation.md](connector-isolation.md) — Statelessness contract, allowedHosts, bundling, execution isolation
- [connector-distribution.md](connector-distribution.md) — Packaging, publishing, npm/git/local distribution, engine resolution, security
- [connector-helpers.md](connector-helpers.md) — Optional SDK helper APIs for common REST connector patterns (pagination, mapping, state, batching)
- [associations.md](associations.md) — Cross-connector references: Association type, composite-key resolution, JSON-LD pattern, pending-edge handling
- [sync-engine.md](sync-engine.md) — Pipeline, shadow state, field tracking, diffing, conflict resolution, dispatch, echo prevention, circuit breaker, webhooks
- [channels.md](channels.md) — Channel configuration, members, identity, resolution strategies (coalesce, LWW, collect, bool_or, expression, field_master, element-set)
- [identity.md](identity.md) — Hub-and-spoke identity map, canonical UUIDs, associations, flat vs relational
- [safety.md](safety.md) — Circuit breakers, echo prevention, idempotency, soft deletes, retry, external change detection
- [webhooks.md](webhooks.md) — Queue-first design, thin/thick payloads, lifecycle, monitoring, offline replay
- [auth.md](auth.md) — Centralized OAuth (client credentials), api-key, prepareRequest, token management
- [discovery.md](discovery.md) — Ingest-first onboarding, discover/onboard/addConnector, deduplication guarantee
- [rollback.md](rollback.md) — Transaction log, undo (single/batch/full), capability-aware rollback
- [actions.md](actions.md) — Event bus, action connectors, trigger rules, workflow idempotency
- [observability.md](observability.md) — Request journal, sync_runs, structured logging, introspection
- [field-mapping.md](field-mapping.md) — Field mapping, canonical form, whitelist semantics, direction

## Data & Intelligence
- [data-access.md](data-access.md) — Shadow state as unified data layer, agent query patterns
- [agent-assistance.md](agent-assistance.md) — Agent-generated connectors and mappings

## Infrastructure
- [database.md](database.md) — SQLite schema, FieldData structure, key queries
- [config.md](config.md) — `opensync.json` connector registry, `mappings/` YAML format, channel definitions
- [cli.md](cli.md) — Commands, scaffolding, packaging, npm distribution, connector resolution
- [demo.md](demo.md) — Interactive demo runner: example folder convention, seed/, field-mapping showcase, path resolution
- [playground.md](playground.md) — Browser playground UI: layout, cluster view, record cards, modals, dev tools, scenario system

