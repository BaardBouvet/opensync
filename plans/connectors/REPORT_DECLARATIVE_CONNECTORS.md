# Declarative Connectors

> **Status:** aspirational — not designed or implemented. Documents a possible future extension.
> **Date:** 2026-04-03

For simple REST APIs, writing a full TypeScript connector may be overkill. A future extension could support YAML-only connector definitions.

## Proposed Shape

```yaml
name: simple-api
auth: bearer
resources:
  contacts:
    read:
      path: /v1/contacts
      params: { updated_since: "{{ since | iso8601 }}" }
      pagination: { strategy: cursor, cursor_path: "$.meta.next" }
      normalization:
        id: "$.id"
        email: "$.email_address"
    write:
      path: "/v1/contacts/{{ id }}"
      method: PATCH
```

The engine would interpret this YAML and execute the HTTP calls — no TypeScript needed.

## Why It's Deferred

TypeScript connectors are more flexible, easier for agents to generate, and cover 100% of use cases. Declarative connectors optimize for the 80% case at the cost of a rigid format that's harder to extend.

The SDK contract (`Connector`, `StreamDefinition`, etc.) is the canonical interface. Any declarative layer would compile down to it rather than replace it.

## Open Questions

- How to express auth strategies beyond bearer (OAuth PKCE, HMAC signing, custom headers)?
- How to handle multi-step pagination where the next cursor is nested in a non-standard path?
- How to express conditional field mappings or computed fields?
- Should it generate TypeScript from YAML (static) or interpret at runtime (dynamic)?
- Agent-generated connectors may be the real answer here — LLMs can write the TypeScript directly from an API spec, which is more flexible and auditable than a YAML DSL.
