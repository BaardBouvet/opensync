# Connector Isolation

Connectors are stateless by contract. This spec defines what that means, what the
SDK enforces today, and what the execution model looks like when connectors run in
isolated workers.

---

## Statelessness Contract

Module scope is not guaranteed to persist between connector method calls. The engine
may invoke connector methods in a fresh process, worker, or isolate at any time.

**Connectors must not use module-level mutable state.** Any data that must survive
across calls belongs in one of two places:

| Data type | Where it goes |
|-----------|--------------|
| Lightweight, JSON-serializable (subscription IDs, tokens, cursors) | `ctx.state` |
| Expensive live objects (connection pools, open sockets) | Created fresh per call and torn down in `finally` |

`ctx.state` is a `StateStore` backed by the engine's database — engine-owned, injected
per connector instance, and safe across workers. It cannot hold live objects; values
are serialized and deserialized on every access.

### Why Not Module-Level Caching?

- **Ephemeral workers**: Each sync invocation may run in a fresh isolate. The module
  is re-evaluated; any cached object is gone. Code that silently creates a new
  connection pool on every call will exhaust database connections under load.
- **Isolation between instances**: In a shared long-lived process, module-level Maps
  keyed by connection string can be accessed by multiple unrelated connector instances,
  leaking credentials or corrupting state.

---

## HTTP: Use `ctx.http`, Not Global `fetch`

All outbound HTTP calls must go through `ctx.http`, which is a `TrackedFetch`:

- Injects auth headers automatically.
- Logs every request to the request journal.
- Retries on 429/5xx with back-off.
- Masks sensitive headers in logs.
- Is the hook point for `allowedHosts` enforcement (see below).

Calling the global `fetch()` directly bypasses all of the above.

---

## `allowedHosts`

Every connector that makes outbound HTTP calls must declare the hostnames it is
allowed to contact in `ConnectorMetadata.allowedHosts`:

```typescript
metadata: {
  allowedHosts: ['api.hubspot.com', '*.hubapi.com'],
}
```

Rules:
- Exact hostnames or `'*.'` wildcard prefixes only.
- Omit the field for connectors that make no outbound HTTP calls (e.g. DB connectors
  that connect via a DSN rather than HTTP).
- `allowedHosts` is informational today. The engine logs but does not enforce it.
  Enforcement is wired in when the isolation layer is active.

Connectors that contact environment-specific hostnames must list all of them:

```typescript
// Tripletex: production and test environments use different domains
allowedHosts: ['tripletex.no', 'api.tripletex.io'],
```

---

## Node.js Built-ins

Connectors must not import Node.js built-in modules (`node:fs`, `node:child_process`,
`node:net`, etc.) directly. Use Web-standard APIs instead:

| Avoid | Use instead |
|-------|-------------|
| `node:fs` readFileSync | Not applicable in remote connectors. Use HTTP. |
| `process.env` | `ctx.config` (secrets are injected by the engine) |
| `node:child_process` | Not permitted. |
| `node:net` direct TCP | Driver library via npm dependency |

**Exception**: Connectors explicitly labeled `LOCAL-ONLY` (e.g. `jsonfiles`) may use
`node:fs` and similar because they are development fixtures, not remote connectors.

This constraint is what permits connectors to run in Deno, `vm.Context`, or V8
isolates. Violating it locks the connector to Node.js-only execution permanently.

---

## Bundling

Each connector ships a `bundle` script that compiles TypeScript and inlines all npm
dependencies into a single self-contained ESM file:

```bash
bun run bundle   # produces dist/bundle.js
```

Implemented via `esbuild`. HTTP-only connectors target `--platform=browser` (Web API
surface, compatible with Deno and workerd). Connectors that use Node.js libraries
(database drivers, Kafka clients) target `--platform=node`.

The bundle script serves two purposes today:
1. Validates that all dependencies can be inlined (no native addons).
2. Surfaces any `node:*` import violations at build time.

Native addons (`*.node` binaries) cannot be bundled and are disallowed in connectors.
If a library ships a native addon but also has a pure-JS fallback, use the fallback.

---

## Execution Isolation (Future)

The following describes the target execution model. It is not implemented today
but is the design that all current decisions are optimised for.

### Distribution

At registration time, the connector is compiled and bundled:

```
Connector TypeScript + package.json
         │
         ▼
Build step
  ├── npm install (isolated environment)
  ├── esbuild bundle → single ESM file
  ├── Static analysis: flag node:* imports, verify allowedHosts populated
  ├── License check on bundled deps
  └── Store signed bundle artifact
```

The stored artifact is what the engine executes. No `npm install` happens at runtime.

### Worker Model

```
Engine schedules sync invocation
         │
         ▼
Worker pool
  ├── One worker per connector invocation (short-lived)
  ├── Deno (--allow-net=<allowedHosts>) or vm.Context (Web API surface only)
  ├── ctx.http enforces allowedHosts — requests to undeclared hosts are rejected
  ├── No access to fs, child_process, process.env, or host globals
  ├── CPU time limit per invocation
  ├── Memory limit per worker
  └── ctx injected with instance credentials (never via environment variables)
         │
         ▼
Engine receives ReadBatch / InsertResult via postMessage
```

### Preferred Runtime: Deno

Deno's `--allow-net=` flag maps directly to `allowedHosts`. A connector for HubSpot
would run as:

```bash
deno run --allow-net=api.hubspot.com,*.hubapi.com dist/bundle.js
```

No filesystem, no environment, no other network access. This is why `allowedHosts`
is declared in metadata now even though it isn't enforced yet — at enforcement time,
the data is already there.

### Fallback: Node.js `vm.Context`

For connectors that require Node.js built-ins (database drivers, Kafka), the sandbox
is a `vm.Context` with a restricted global:

- Exposed: `fetch` (wrapped to enforce `allowedHosts`), `URL`, `TextEncoder`,
  `TextDecoder`, `crypto`, `setTimeout`, `clearTimeout`, `console`.
- Not exposed: `require`, `process`, `global`, `__dirname`, `Buffer` (unless needed).
- The bundled connector is loaded into the context via a `data:` URL. No `require()`
  means no escape via module resolution.

CPU and memory limits are enforced at the Worker level wrapping the `vm.Context`.
