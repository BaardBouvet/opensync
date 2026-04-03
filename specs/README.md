# OpenSync Specs

Complete specification for OpenSync — an open-source, developer-friendly, bi-directional sync engine.

## Architecture & Design
- [overview.md](overview.md) — Architecture, philosophy, tech stack, data flow

## Components
- [connector-sdk.md](connector-sdk.md) — Connector interfaces, capabilities, lifecycle, NormalizedRecord, SyncContext
- [connector-isolation.md](connector-isolation.md) — Statelessness contract, allowedHosts, bundling, execution isolation
- [connector-distribution.md](connector-distribution.md) — Packaging, publishing, npm/git/local distribution, engine resolution, security
- [sdk-helpers.md](sdk-helpers.md) — Optional SDK helper APIs for common REST connector patterns (pagination, mapping, state, batching)
- [sync-engine.md](sync-engine.md) — Pipeline, shadow state, field tracking, diffing, transforms, conflict resolution, dispatch
- [identity.md](identity.md) — Hub-and-spoke identity map, global IDs, associations, flat vs relational
- [safety.md](safety.md) — Circuit breakers, echo prevention, idempotency, soft deletes, retry, external change detection
- [webhooks.md](webhooks.md) — Queue-first design, thin/thick payloads, lifecycle, monitoring, offline replay
- [auth.md](auth.md) — Centralized OAuth, bespoke auth (prepareRequest), token management
- [discovery.md](discovery.md) — Onboarding, matching (exact/fuzzy/composite), linking, echo storm prevention
- [rollback.md](rollback.md) — Transaction log, undo (single/batch/full), capability-aware rollback, safe testing
- [actions.md](actions.md) — Event bus, action connectors, trigger rules, workflow idempotency
- [observability.md](observability.md) — Request journal, pipeline logs, structured logging, introspection

## Data & Intelligence
- [data-access.md](data-access.md) — Shadow state as unified data layer, agent query patterns, analytics, RAG/vector search
- [agent-assistance.md](agent-assistance.md) — Agent-generated connectors and mappings, why TypeScript over YAML, scaffold workflow

## Infrastructure
- [database.md](database.md) — Full SQLite schema, all 14 tables, JSONB structures, indexes
- [config.md](config.md) — YAML format, channels, mappings, triggers, validation
- [cli.md](cli.md) — Commands, scaffolding, packaging, npm distribution, connector resolution

## Implementation
- [plan.md](plan.md) — Phased implementation order with dependency graph
- [../plans/osi-mapping-primitives.md](../plans/osi-mapping-primitives.md) — Full catalog of OSI-mapping primitives with foundation assessment (50 primitives across 11 categories)
