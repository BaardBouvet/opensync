# Connector Isolation: Scalability and Security

**Status**: backlog

This document covers the open questions and design decisions around running connectors in isolated,
stateless execution environments. The goal is to identify what we need to do **now** — or at least
agree on clearly — so that we don't make choices that rule out safe, scalable execution later.

---

## The Problem

Right now, connectors run in the same process as the engine, with full access to the host OS. That
is fine for development and simple self-hosted deployments. It becomes a problem in two scenarios
that we want to support:

**Scalability**: Running connectors as isolated, short-lived workers — spawned on demand and
discarded after each sync invocation — is the natural model for horizontal scaling. Anything that
relies on persistent in-process state (connection pools, module-level caches) breaks silently when
the process doesn't survive between calls.

**Security**: Connectors can have arbitrary third-party npm dependencies. A connector that imports
a compromised or malicious package can read credentials from `process.env`, open outbound
connections to arbitrary hosts, or access the filesystem. The engine currently has no way to
constrain what a connector can do at runtime.

Neither scenario requires action today. But the decisions we make about the connector interface,
the packaging format, and the programming model will either keep both paths open or force a
painful breaking change later.

---

## What We've Already Got Right

The core `Connector` interface maps cleanly onto sandboxed execution:

- **Pure functions**: `fetch`, `insert`, `update`, `delete`, `lookup` are all context-in /
  records-out. No hidden dependencies.
- **`ConnectorContext` as the only wire**: All config, credentials, and the (future) HTTP helper
  flow through `ctx`. A sandbox can wrap `ctx` to intercept or restrict everything the connector
  touches.
- **No shared data model**: Connectors expose raw field values. There is nothing for them to
  "learn" about other instances' data from the SDK.
- **`onEnable` / `onDisable` lifecycle**: These hooks are the right place for any setup that
  would otherwise live in module scope.

---

## The Red Flag: Module-Level State

The current Postgres connector maintains a `Map<string, Pool>` at module scope:

```typescript
// connectors/postgres/src/index.ts
const pools = new Map<string, Pool>();
```

This is a pragmatic choice for a single-process deployment, but it is **incompatible with
stateless sandboxed execution** in several ways:

1. **New process per invocation**: If each sync call runs the connector in a fresh worker/isolate,
   the Map is gone. The connector silently creates a new pool on every call, defeating connection
   pooling and potentially exhausting database connections.
2. **Shared process across instances**: If multiple connector instances share a long-lived process,
   the Map can leak across instance boundaries — one instance's open connection potentially
   reused by another.
3. **No clean teardown**: The engine can call `onDisable`, but there is currently nothing in
   `onDisable` to drain the pool, because the pool isn't referenced from `ctx`.

**What needs to change**: Module-level mutable state must be explicitly prohibited in the connector
contract. Any connector lifecycle state (pools, sessions, stream handles) must be either:

- Created fresh on every call (acceptable if cheap), or
- Managed by the engine and injected via `ctx` (preferred for expensive resources like DB pools).

The simplest concrete fix is to add a `ctx.state` bag that the engine owns and injects per
connector instance, so the connector can cache across calls without owning module-level globals.
Alternatively, the engine can own the pool lifecycle entirely and pass a ready connection in `ctx`.
The exact solution is open, but the **current pattern must not become load-bearing**.

---

## The Three Layers of the Sandbox Problem

Running a user-supplied connector safely requires solving three independent problems.

### Layer 1 — Distribution Format

How does a user's connector get from their editor to the sandbox?

| Option | Pros | Cons |
|--------|------|------|
| **npm package (tarball)** | Familiar workflow, lockfile included | `node_modules` must be installed in the sandbox; slow cold starts |
| **Pre-bundled ESM file** | Single file, instant load, no install step | User must bundle before upload; source maps for debugging |
| **Raw TypeScript + manifest** | Edit-in-browser friendly | Requires a compilation + bundle step on our side at registration time |

**Recommendation: compiled + bundled single ESM file at registration time.**

The connector author writes TypeScript. At registration time (CLI or API), we compile and bundle
with esbuild/rollup. All dependencies are inlined. What we store and execute is a single
self-contained `.js` file. This is how Cloudflare Workers, Deno Deploy, and Supabase Edge Functions
work. Benefits:

- Zero install step at runtime — cold starts are fast.
- The executed artifact is deterministic (no `npm install` surprises at runtime).
- We can run a security scan (static analysis, license check) on the bundle at registration time.
- Connector authors still have a normal development workflow.

**What we need to decide now:**
- The `ConnectorContext` type must remain the only import from `@opensync/sdk` that connectors
  need at runtime. Everything else can be inlined or dropped at bundle time.
- We should validate this by trying to `esbuild --bundle` an existing connector today and checking
  that nothing breaks.

### Layer 2 — Dependency Management

Because we bundle at registration time, **the user's npm dependencies become our problem at
build time, not at runtime**. That simplifies things enormously. But a few issues remain:

**Native addons (`*.node` files)**: Some npm packages ship prebuilt native binaries (e.g.
`better-sqlite3`, `bcrypt`, `sharp`). These cannot be bundled. A connector that depends on a
native addon cannot be bundled into a single JS file.

Decision: **Disallow native addons in user connectors.** This is not a significant restriction.
Almost every third-party API SDK is pure JavaScript. If a connector needs a database driver that
uses a native addon (e.g. `pg` uses libpq optionally but has a pure-JS fallback via `pg-js`), the
connector author can switch to the pure-JS variant. We should document this constraint early so
nobody is surprised.

**Node.js built-in access**: A bundled connector still executes in a JavaScript runtime. Even
after bundling, code can call `require('child_process')`, `require('fs')`, `process.env`, etc.
Bundling alone does not sandbox these.

**Side-channel attacks via dependencies**: A malicious connector could `import { exec } from
'child_process'` and exfiltrate secrets. We need to address this at the execution layer (Layer 3),
not the bundling layer. But we can add a static analysis step at registration time to flag or
reject connectors that import obviously dangerous modules.

### Layer 3 — Execution Isolation

This is where we contain the connector at runtime. We have several options, with very different
tradeoff profiles.

#### Option A: Node.js Worker Threads (`worker_threads`)

Each connector call runs in a `Worker`. Workers share the same process but have isolated JS heaps.
They can communicate only via `postMessage` (structured clone) and `SharedArrayBuffer`.

- **Isolation**: Moderate. Workers cannot directly reach into each other's memory. However, all
  workers share OS-level resources (file descriptors, network, CPU). A worker can still open TCP
  connections, read files, or spin up CPU if not restricted.
- **Cold start**: ~5–20ms.
- **Dependency resolution**: Bundled connector loaded via `data:` URL or temp file — no install.
- **Permission model**: None built-in. We would have to intercept dangerous APIs via custom `vm`
  module tricks or monkey-patching at worker startup. This is fragile.

Suitable for **low-trust but not zero-trust** execution — good enough for a controlled set of
first-party connectors, insufficient for running arbitrary third-party connector code.

#### Option B: Node.js `vm` Module

Execute connector code in a `vm.Context` with a custom global. We can selectively expose only the
globals we want (e.g. `fetch`, `console`, a restricted `setTimeout`) and omit `require`,
`process`, `fs`, etc.

- **Isolation**: Better for pure JS. The connector cannot access globals we don't give it.
- **Limitation**: Cannot prevent connectors from using Web APIs (e.g. `fetch` to any host) or
  from spinning synchronous infinite loops.
- **Practical problem**: Most npm libraries use `require()` internally. Bundled connectors
  eliminate this problem (everything is already inlined), but the sandbox still needs to provide
  `fetch`, `TextEncoder`, `URL`, etc. — basically a minimal Web API surface.

This is viable for bundled connectors with a careful global allowlist. It's the approach used by
some serverless platforms for "lightweight" functions.

#### Option C: Deno

Deno has a first-class permission system: `--allow-net=api.hubspot.com`, `--allow-env=none`,
`--allow-read=none`, etc. A connector is executed as a Deno script, with only the domains it
declares in its manifest allowed.

- **Isolation**: Strong. Network, filesystem, env, FFI all require explicit grants.
- **Compatibility concern**: Deno uses URL-based imports and has slightly different built-ins.
  Bundled TypeScript targeting Deno differs from Node.js targets. We would need a separate
  Deno-targeted bundle. The connector programming model would need to remain runtime-agnostic.
- **Cold start**: Comparable to Node.js workers.

**This is the most compelling option long-term** if we decide to run connectors in a security-
sensitive way with per-connector network allowlists (which we should — a connector for HubSpot
has no business opening a connection to `169.254.169.254`).

Requires: keeping the connector code and context interface runtime-agnostic (no `Bun.*`,
no `node:*` built-ins used directly inside connector code).

#### Option D: V8 Isolates (Cloudflare Workers / workerd)

Cloudflare's `workerd` runtime runs each connector in a V8 isolate. Isolates are very lightweight
(~1ms cold start), share no heap, and have a strict Web API surface only (`fetch`, `crypto`,
`caches`, etc.). No Node.js APIs at all.

- **Isolation**: Excellent. True per-invocation isolation at the JS engine level.
- **Cold start**: Sub-millisecond for warm; low single-digit ms for cold.
- **Compatibility**: Requires connectors to use only Web APIs. No `node:pg`, no `node:fs`.
  Most HTTP-based API clients (HubSpot, Stripe, etc.) work fine. Database connectors that use
  native drivers do not.

This is the right target for connectors that only talk to external HTTP APIs. For connectors
that talk to databases (Postgres, MySQL), you would need the database driver to be rewritten
for the fetch API, or proxied through a gateway.

#### Option E: Firecracker / container-per-invocation

Each sync runs in a dedicated microVM (Firecracker) or container (Docker + gVisor). Full OS
isolation; connector can use any npm package.

- **Isolation**: Maximum.
- **Cold start**: 100ms–1s (Firecracker optimized), 1–5s (Docker cold).
- **Cost**: Significant infrastructure complexity. Overkill for most connector workloads.

Reasonable for a future "bring your own runtime" tier but not the default model.

---

## What We Need to Decide Before We're Locked In

The following decisions are **low-cost to make now** but expensive to reverse after the ecosystem
grows:

### 1. Prohibit module-level mutable state in the connector contract

Add an explicit rule to the connector SDK docs: module scope is not guaranteed to persist between
calls. Connectors that need per-instance lifecycle state must use `onEnable` / `onDisable` and
receive a state bag via `ctx` (or equivalent).

**Action**: Document this constraint. Refactor `connectors/postgres` to either (a) create a pool
per call and close it immediately (fine for low-frequency syncs), or (b) use `ctx`-injected
pooling once an engine-side resource management API exists.

### 2. Prohibit Node.js built-in imports directly in connector code

Connectors should use only:
- `@opensync/sdk` types and helpers
- Web-standard APIs (`fetch`, `URL`, `TextEncoder`, `crypto.subtle`, etc.)
- Third-party npm packages (at bundle time)

They should not directly call `readFileSync`, `exec`, `net.createConnection`, `process.env`, etc.
This is what allows us to run connectors in Deno, workerd, or a vm.Context sandbox later.

The one current violation is `connectors/jsonfile`, which directly uses `node:fs`. That connector
is explicitly a local-machine test fixture, and we should label it as such — it will never run in
a cloud sandbox. That is fine. Other connectors must not follow the same pattern.

**Action**: Add a lint rule (or at minimum a documented convention) that connector source files
may not `import from 'node:*'` except inside a clearly labeled "local-only" connector.

### 3. Connector manifests must declare network egress allowlist

Each connector's `metadata` should declare the domains it is allowed to contact:

```typescript
metadata: {
  ...
  allowedHosts: ['api.hubspot.com', '*.hubapi.com'],
}
```

This is not enforced today and doesn't need to be enforced today. But if connectors declare it
now, we can enforce it for free once we wrap `fetch` in `ConnectorContext`. If they don't declare
it, we have no data to build the allowlist from and will have to ask every connector author to
retrofit this later.

**Action**: Add `allowedHosts?: string[]` to `ConnectorMetadata` now. Make it optional.
Start populating it in existing connectors. Treat it as informational until we have a sandbox.

### 4. `ctx.http` (or `ctx.fetch`) rather than raw `fetch`

Connectors should make HTTP calls through a context-provided helper rather than calling the global
`fetch` directly. The helper gives the engine a hook to:
- Enforce the `allowedHosts` allowlist
- Log all outbound requests (request journal)
- Inject auth headers (already relevant for `prepareRequest`)
- Apply rate limiting / retry policy

This is partially addressed by `prepareRequest`, but `prepareRequest` only transforms the request
— it doesn't intercept raw `fetch` calls the connector makes directly.

**Action**: Expose a `ctx.fetch(url, init?)` method in `ConnectorContext`. It wraps the global
`fetch` with logging and (eventually) allowlist enforcement. Deprecate direct `fetch` usage in
connector guides. This is a non-breaking additive change.

### 5. Registration-time bundling as a first-class step

Right now there is no build step for connectors beyond `tsc`. We need an `esbuild`-based bundle
step that:
- Compiles TypeScript
- Inlines all npm dependencies
- Outputs a single `.js` ESM file
- Reports the list of imported Node.js built-ins (so we can catch `node:fs` violations)
- Rejects native addon dependencies

This does not need to be the "production" path today, but the connector workspace setup should
make it easy to try:

```bash
bun run bundle   # produces dist/bundle.js — a self-contained connector
```

**Action**: Add an esbuild bundle script to each connector's `package.json`. Validate that the
existing connectors bundle cleanly. Note any failures (native addons, `node:fs` usage) — those
are things we know need to change.

---

## Summary Table

| Decision | Cost to make now | Cost to retrofit later | Action |
|----------|-----------------|----------------------|--------|
| Prohibit module-level mutable state | Low | High (all connectors rewrite) | Document + refactor postgres |
| Prohibit `node:*` imports in connectors | Low | Medium | Lint rule + label jsonfile |
| Add `allowedHosts` to metadata | Very low | Medium (need to survey all connectors) | Add field, populate it |
| Add `ctx.fetch` | Low | Medium (guides, examples all need updating) | Add to `ConnectorContext` |
| Bundle script per connector | Low | — (purely additive) | Add esbuild script |
| Choose sandbox execution model | Can defer | High if interface assumptions lock us in | Agree on Deno/vm target |

We don't need a production sandbox today. We need to not do anything today that makes Deno or
`vm.Context` isolation impossible six months from now. The five actions above are the minimum
required to keep that door open.

---

## Recommended Target Architecture (when we get there)

```
Connector TypeScript + package.json
         │
         ▼
Registration / build step
  ├── npm install (in isolated environment)
  ├── esbuild bundle → single ESM file
  ├── Static analysis: flag node:* imports, verify allowedHosts
  ├── License check on bundled deps
  └── Store signed bundle artifact
         │
         ▼
Worker pool (one worker per connector invocation)
  ├── Deno or vm.Context with Web API surface only
  ├── fetch() → wrapped, enforces allowedHosts
  ├── No fs, no child_process, no process.env
  ├── CPU time limit (e.g. 30s per sync call)
  ├── Memory limit
  └── ctx injected with instance credentials (never in env or global scope)
         │
         ▼
Engine receives FetchBatch / InsertResult via postMessage
```

This is not a short-term deliverable. It is the design we should keep in mind while making
day-to-day decisions so we don't have to undo them.
