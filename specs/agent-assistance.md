# Agent Assistance

> **Status**: Early draft. This spec captures intent and known design decisions; implementation
> is not yet started. Expand as the feature is built.

OpenSync is designed to be agent-friendly from the ground up: clear contracts, predictable
structure, and self-describing schemas. This spec describes how AI agents and code-generation
tools interact with OpnSync — writing connectors, generating mappings, and assisting users
with setup.

---

## § 1 Agent-Assisted Connector Generation

### § 1.1 The Goal

An agent should be able to write a correct, production-quality connector from:
1. The `connector-sdk.md` spec (typed contract)
2. The target API's documentation (endpoints, authentication, pagination)
3. The connectors in `connectors/` as ground-truth examples

The output should be indistinguishable from a human-authored connector in the same folder.

### § 1.2 Generation Contract

For a connector to be agent-writable without clarification:

- The SDK types precisely define every method signature
- `ConnectorContext` provides everything needed (`ctx.http`, `ctx.state`, `ctx.config`,
  `ctx.logger`, `ctx.webhookUrl`) — no imports from outside the SDK
- Entity `schema` with `description` fields makes field semantics clear without disambiguation
- Error types (`ConnectorError`, `RateLimitError`, `AuthError`, `ValidationError`) cover all
  error branches without connector-specific logic

### § 1.3 Evaluation Baseline

`connectors/mock-crm` and `connectors/mock-erp` are the evaluation baseline: a generated
connector for the same API (given only the mock server's source as documentation) should pass
the same test suite as the hand-written connector.

---

## § 2 Agent-Assisted Field Mapping

### § 2.1 The Problem

When connecting two systems, a user must map source fields to target fields. For non-obvious
field names (Norwegian fields, abbreviated CRM names, custom ERP codes) a user without domain
knowledge cannot complete the mapping.

### § 2.2 What the Engine Provides

- `EntityDefinition.schema` — `FieldDescriptor.description` for every field in every entity
- Both source and target schemas are available at channel setup time
- The engine can emit the two schemas as structured JSON for an agent to process

### § 2.3 Agent Role

An agent with access to both schemas can:
1. Propose a field mapping based on descriptions and semantic similarity
2. Flag type incompatibilities (`number` → `string`, or missing required fields)
3. Prompt the user only for fields where semantic similarity is low

---

## § 3 Discovery Assistance

### § 3.1 Adding a New Connector

When a user adds a new connector (`opensync add-connector <name>`), the CLI reads
`metadata.configSchema` and prompts for each field. An agent can answer config prompts
automatically when the source (environment variables, user context, prior conversation) is
known.

### § 3.2 Channel Onboarding

`discover()` and `onboard()` are documented in `specs/discovery.md`. An agent can:
- Run `discover()` to inspect what data is available
- Evaluate which fields align with the target connector's schema
- Propose or execute `addConnector()` automatically

---

## § 4 Constraint: No Engine or Database Imports in Agents

Agents that write connectors must only import from `@opensync/sdk`. They must not:
- Import from `@opensync/engine` — that is an engine-internal package
- Query `shadow_state` directly — use the data-access API when it is available
- Write a mapping file manually — the CLI generates the YAML scaffold

---

## § 5 Open Questions

1. Should there be a structured agent-facing API for schema introspection (vs. reading spec
   files as text)?
2. How does an agent verify its generated connector is correct before the user deploys it?
   (Running the connector test suite via CI is the intended path.)
3. Should generated connectors be tagged in any way to distinguish them from hand-written ones?
4. Is there a role for a "connector validator" tool — an agent that reviews a connector for
   correctness against the SDK spec?
