# OpenSync

An open-source, hub-and-spoke bi-directional SaaS sync engine.

Stop writing point-to-point integrations. Build a connector once, sync to any system.

## What It Does

Connect N systems (HubSpot, Salesforce, your API, databases, knowledge graphs) without writing N² integrations.

- **Write one connector**, sync to everything
- **Field-level conflict resolution** — different systems master different fields
- **Full undo/rollback** — any sync can be reversed
- **Webhooks for real-time** — or poll on your schedule
- **Schema-agnostic** — works with REST, GraphQL, databases, RDF, file systems
- **Safety first** — circuit breakers, echo prevention, idempotency built-in

## Getting Started

→ [Start here](./docs/getting-started.md)

## Architecture

- **Connectors**: Dumb pipes. You map data. That's it.
- **Engine**: The brain. Diffing, conflict resolution, undo, safety.
- **Backends**: Pluggable storage (relational now, graph later).
- **CLI**: User interface. No web UI for MVP.

## Documentation

- **[docs/](./docs)** — User guides (getting started, building connectors, advanced patterns)
- **[specs/](./specs)** — Architecture & implementation specs
- **[.devcontainer/](/.devcontainer)** — Development environment setup

## Contributing

We're in early development. Issues and PRs welcome.

## License

Apache License 2.0 — See [LICENSE](./LICENSE)