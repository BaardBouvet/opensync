# OpenSync Specs

Complete specification for OpenSync — an open-source, developer-friendly, bi-directional sync engine.

The specs in this directory reflect the design proven across POC v0–v9. Where a spec conflicts
with a POC lesson, the POC wins and the spec should be updated.

## Architecture & Design
- [overview.md](overview.md) — Architecture, philosophy, tech stack, data flow

## Components
- [connector-sdk.md](connector-sdk.md) — Connector interfaces, capabilities, lifecycle, ConnectorContext, webhooks, isolation constraints, packaging, SDK helpers
- [associations.md](associations.md) — Cross-connector references: Association type, composite-key resolution, JSON-LD pattern, pending-edge handling
- [sync-engine.md](sync-engine.md) — Pipeline, shadow state, field tracking, diffing, conflict resolution, dispatch, echo prevention, association propagation, rollback
- [channels.md](channels.md) — Channel configuration, members, identity, resolution strategies (coalesce, LWW, collect, bool_or, expression, field_master, element-set)
- [identity.md](identity.md) — Hub-and-spoke identity map, canonical UUIDs, associations, anti-affinity (no_link)
- [safety.md](safety.md) — Circuit breakers (CLOSED/OPEN/HALF_OPEN), echo prevention, soft deletes, ETag/optimistic locking
- [auth.md](auth.md) — Centralized OAuth (client credentials), api-key, prepareRequest, token management
- [discovery.md](discovery.md) — Ingest-first onboarding, discover/onboard/addConnector, deduplication guarantee
- [actions.md](actions.md) — Action connector type (SDK side): ActionDefinition, ActionPayload, ActionResult
- [observability.md](observability.md) — Request journal, sync_runs, structured logging, introspection

## Mapping & Config
- [field-mapping.md](field-mapping.md) — Field mapping, canonical form, whitelist semantics, direction, array expansion
- [config.md](config.md) — `opensync.json` connector registry, `mappings/` YAML format, channel definitions

## Infrastructure
- [database.md](database.md) — SQLite schema, FieldData structure, key queries
- [cli.md](cli.md) — Commands, scaffolding, packaging, npm distribution, connector resolution
- [demo.md](demo.md) — Interactive demo runner: example folder convention, seed/, field-mapping showcase, path resolution
- [playground.md](playground.md) — Browser playground UI: layout, cluster view, record cards, modals, dev tools, scenario system

