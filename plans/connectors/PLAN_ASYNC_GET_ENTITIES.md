# PLAN: Async `getEntities`

**Status:** draft  
**Date:** 2026-04-09  
**Effort:** M  
**Domain:** Connector SDK + Engine  
**Scope:** `packages/sdk/src/types.ts`, `packages/engine/src/`, all connector implementations, test stubs  
**Spec changes planned:** `specs/connector-sdk.md` § 2 (Connector interface — `getEntities` signature), `specs/sync-engine.md` § 2 (engine construction — static async factory)

---

## § 1 Problem Statement

`getEntities` on the `Connector` interface is currently synchronous:

```ts
getEntities?(ctx: ConnectorContext): EntityDefinition[]
```

This prevents connectors from fetching schema metadata at startup. Any connector that
needs runtime introspection — database connectors enumerating tables and columns from
`information_schema`, REST APIs fetching custom-object definitions, or multi-tenant
systems discovering tenant-specific schemas — must either:

- Hardcode entity names and schema at build time (not feasible for generic database
  connectors), or
- Defer real schema introspection into the `read` call, mixing discovery with data
  ingestion.

The postgres connector is the primary driver: it currently exposes a single static
`tableEntity` driven by config key literals, rather than introspecting actual column
definitions from the database.

---

## § 2 Goal

Change `getEntities` to return `Promise<EntityDefinition[]>`, allowing connectors to
issue async calls (DB queries, HTTP requests) to discover their entity schema before
the first sync cycle begins.

The `entities` array stored in `WiredConnectorInstance` must still be a resolved
`EntityDefinition[]` — the rest of the engine (`engine.ts`, `auth/context.ts`) can
continue accessing entities synchronously once init is complete.

---

## § 3 Concrete Change Points

### § 3.1 SDK type (`packages/sdk/src/types.ts`)

```ts
// Before
getEntities?(ctx: ConnectorContext): EntityDefinition[];

// After
getEntities?(ctx: ConnectorContext): Promise<EntityDefinition[]>;
```

Every implementation adds `async` (a one-token change) or wraps its return in
`Promise.resolve(...)`. The call site is uniform; no normalisation needed in the engine.

### § 3.2 Engine helper (`packages/engine/src/config/loader.ts`)

```ts
// Before
export function getConnectorEntities(
  connector: Connector,
  ctx: ConnectorContext,
): EntityDefinition[] {
  return connector.getEntities ? connector.getEntities(ctx) : [];
}

// After
export async function getConnectorEntities(
  connector: Connector,
  ctx: ConnectorContext,
): Promise<EntityDefinition[]> {
  return connector.getEntities ? await connector.getEntities(ctx) : [];
}
```

### § 3.3 Wiring (`packages/engine/src/auth/context.ts`)

`makeWiredInstance` is currently synchronous and returns `WiredConnectorInstance`.
It must become async:

```ts
// Before
export function makeWiredInstance(
  instance: ConnectorInstance,
  db: Db,
  webhookBaseUrl: string,
): WiredConnectorInstance

// After
export async function makeWiredInstance(
  instance: ConnectorInstance,
  db: Db,
  webhookBaseUrl: string,
): Promise<WiredConnectorInstance>
```

The `entities:` field inside the returned object is populated by awaiting
`getConnectorEntities(connector, ctx)`.

### § 3.4 Engine construction (`packages/engine/src/engine.ts`)

JavaScript constructors cannot `await`. The `SyncEngine` constructor currently calls
`makeWiredInstance` synchronously for each connector. Since pre-release backward
compatibility is not required, we replace the public constructor with a **static async
factory**.

```ts
// Before (public constructor)
const engine = new SyncEngine(config, db);

// After (static async factory)
const engine = await SyncEngine.create(config, db);
```

Implementation sketch:

```ts
class SyncEngine {
  private constructor(
    config: ResolvedConfig,
    db: Db,
    wired: Map<string, WiredConnectorInstance>,
    breakers: Map<string, CircuitBreaker>,
  ) {
    this.config = config;
    this.db = db;
    this.wired = wired;
    this.breakers = breakers;
  }

  static async create(
    config: ResolvedConfig,
    db: Db,
    webhookBaseUrl = "",
  ): Promise<SyncEngine> {
    createSchema(db);
    const wired = new Map<string, WiredConnectorInstance>();
    for (const instance of config.connectors) {
      wired.set(instance.id, await makeWiredInstance(instance, db, webhookBaseUrl));
    }
    const breakers = new Map<string, CircuitBreaker>();
    for (const ch of config.channels) {
      breakers.set(ch.id, new CircuitBreaker(ch.id, db));
    }
    return new SyncEngine(config, db, wired, breakers);
  }
}
```

> Connectors are wired sequentially (not `Promise.all`) to preserve deterministic
> ordering and because DB schema setup (`createSchema`) must complete first. If
> parallel init becomes a future need, it can be added later without changing the
> external API.

### § 3.5 Second direct call site (`packages/engine/src/auth/context.ts` line 106)

There is a second direct inline call to `connector.getEntities` inside `makeWiredInstance`
itself (the `entities:` field). After the refactor in § 3.3, this becomes an `await` on
`getConnectorEntities(connector, ctx)`. No separate change needed beyond § 3.3.

---

## § 4 Call-Site Inventory

All places that must be updated:

| File | Change |
|------|--------|
| `packages/sdk/src/types.ts` | `getEntities` return type (§ 3.1) |
| `packages/engine/src/config/loader.ts` | `getConnectorEntities` → `async` (§ 3.2) |
| `packages/engine/src/auth/context.ts` | `makeWiredInstance` → `async`, await entities (§ 3.3) |
| `packages/engine/src/engine.ts` | Private constructor + `SyncEngine.create()` (§ 3.4) |
| `connectors/hubspot/src/index.ts` | Add `async` to `getEntities()` |
| `connectors/postgres/src/index.ts` | `getEntities` becomes `async`; can now query `information_schema` |
| `connectors/kafka/src/index.ts` | Add `async` to `getEntities()` |
| `connectors/sparql/src/index.ts` | Add `async` to `getEntities()` |
| `connectors/tripletex/src/index.ts` | Add `async` to `getEntities()` |
| `connectors/waveapps/src/index.ts` | Add `async` to `getEntities()` |
| `dev/connectors/mock-crm/src/index.ts` | Add `async` to `getEntities()` |
| `dev/connectors/mock-erp/src/index.ts` | Add `async` to `getEntities()` |
| `dev/connectors/jsonfiles/src/index.ts` | Add `async` to `getEntities()` |
| `playground/src/inmemory.ts` | Add `async` to `getEntities()` |

### § 4.1 Test stubs

Every test file that constructs a `Connector` inline and passes it to `new SyncEngine()`
must:
1. Change `new SyncEngine(config, db)` → `await SyncEngine.create(config, db)`.
2. Wrap the surrounding `it()`/`test()` function in `async` if not already.

The `getEntities` implementations in test stubs need `async` added (one token each) or
the return value wrapped in `Promise.resolve([...])`. Either form compiles cleanly.

Files affected:
- `packages/engine/src/multilevel-array.test.ts` (~7 `new SyncEngine` calls)
- `packages/engine/src/nested-array.test.ts` (~3 `new SyncEngine` calls)
- `packages/engine/src/association-schema.test.ts` (~4 `new SyncEngine` calls)
- `packages/engine/src/jsonld-contract.test.ts` (~14 `new SyncEngine` calls)
- `packages/engine/src/transitive-identity.test.ts` (~9 `new SyncEngine` calls)
- `packages/engine/src/split-canonical.test.ts` (~2 `new SyncEngine` calls)
- `packages/engine/src/written-state.test.ts` (~5 `new SyncEngine` calls)
- `demo/run.ts` (1 call)
- All other test files that call `new SyncEngine`

---

## § 5 Postgres Connector Enhancement

The primary motivator. After the type change, `postgres/src/index.ts` can implement
schema introspection:

```ts
async getEntities(ctx: ConnectorContext): Promise<EntityDefinition[]> {
  const pool = createPool(ctx);
  try {
    const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [ctx.config.schema ?? "public"],
    );
    // Group columns by table and return one EntityDefinition per table
    return buildEntitiesFromColumns(rows, ctx);
  } finally {
    await pool.end();
  }
}
```

The exact schema of `buildEntitiesFromColumns` is an implementation detail left for the
implementation phase; the key point is that the round-trip to `information_schema` happens
exactly once at engine init, not on every sync cycle.

---

## § 6 Spec Changes

### `specs/connector-sdk.md` § 2 (Connector interface)

Update the `getEntities` entry from:

> `getEntities?(ctx: ConnectorContext): EntityDefinition[]`  
> Called once at registration and again when config changes.

To:

> `getEntities?(ctx: ConnectorContext): Promise<EntityDefinition[]>`  
> Called once when the engine initialises the connector. May be async to support runtime
> schema introspection (e.g. querying `information_schema`, fetching custom-object metadata
> from a REST API). The engine awaits the result before any sync cycle begins.  
> Omit for pure action connectors.

### `specs/sync-engine.md` § 2 (construction)

Add a note after the `new SyncEngine(config, db)` example explaining:

> Construction is asynchronous. Use the static factory `await SyncEngine.create(config, db)`
> instead of `new SyncEngine(...)`. The constructor resolves entity definitions for all
> registered connectors before returning, so any async schema introspection in `getEntities`
> completes before the first sync cycle.

---

## § 7 Implementation Order

1. Update `specs/connector-sdk.md` and `specs/sync-engine.md` (spec-first).
2. Change the SDK type in `packages/sdk/src/types.ts`.
3. Change `getConnectorEntities` in `packages/engine/src/config/loader.ts`.
4. Change `makeWiredInstance` in `packages/engine/src/auth/context.ts`.
5. Refactor `SyncEngine` to private constructor + `SyncEngine.create()`.
6. Update `demo/run.ts`.
7. Mechanically update all `new SyncEngine(` → `await SyncEngine.create(` in test files.
8. Update `connectors/postgres/src/index.ts` to use async schema introspection.
9. Run `bun run tsc --noEmit && bun test` — fix any remaining type errors.

---

## § 8 Out of Scope

- **Re-resolution on config change**: `getEntities` is called once at init. Live
  reconfiguration (hot-reload) is a separate concern and not part of this plan.
- **Per-entity async schema refresh**: Refreshing entity definitions mid-run is out of
  scope. If needed later, it requires a separate API on `EntityDefinition`.
- **Parallel connector init**: The sequential `for...of await` in `SyncEngine.create()`
  is intentional. Parallelising it is a future performance optimisation.
