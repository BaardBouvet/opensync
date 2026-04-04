# OpenSync

An open-source, hub-and-spoke bi-directional SaaS sync engine.

→ [What it is and why](./ESSENCE.md) · [Roadmap](./ROADMAP.md) · [Changelog](./CHANGELOG.md)

## What It Does

Connect N systems (HubSpot, Salesforce, your API, databases, knowledge graphs) without writing N² integrations.

- **Write one connector**, sync to everything
- **Field-level conflict resolution** — different systems master different fields
- **Full undo/rollback** — any sync can be reversed
- **Webhooks for real-time** — or poll on your schedule
- **Schema-agnostic** — works with REST, GraphQL, network-accessible databases, RDF, file systems
- **Safety first** — circuit breakers, echo prevention, idempotency built-in

## Getting Started

→ [Start here](./docs/getting-started.md)

## Architecture

- **Connectors**: Dumb pipes. They expose raw records. No field mapping, no business logic.
- **Engine**: The brain. Diffing, conflict resolution, field mapping, undo, safety.
- **CLI**: User interface. No web UI for MVP.

## Documentation

- **[docs/](./docs)** — User guides (getting started, building connectors, advanced patterns)
- **[specs/](./specs)** — Architecture & implementation specs
- **[.devcontainer/](/.devcontainer)** — Development environment setup

## Contributing

We're in early development. Issues and PRs welcome.

## License

Apache License 2.0 — See [LICENSE](./LICENSE)