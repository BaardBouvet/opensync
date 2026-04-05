# Plan: Connector Cleanup

> **Status:** backlog
> **Date:** 2026-04-04
> **Depends on:** [connectors/PLAN_SDK_HELPERS.md](PLAN_SDK_HELPERS.md) (all helpers must be implemented and exported first)

## Goal

Migrate every example connector to use the SDK helpers, removing all locally-defined boilerplate
and leaving each connector file containing only the code that is specific to that system:
its auth approach, its entity schemas, its API shapes, and its field mapping logic.

The outcome is connectors that are half the length they are today, easier to read, and which serve
as accurate reference implementations for third-party connector authors.

---

## Connector-by-Connector Changes

### Wave (`connectors/waveapps/src/index.ts`)

Wave uses a GraphQL API and page-number pagination. It has its own local `maxOf()` watermark
helper and a repeated page-number pagination loop across three entities.

#### Remove local utilities

| Remove | Replace with |
|---|---|
| `function maxOf(dates)` | `helpers.watermark.max` (called once per edge node) |
| `let page = 1; while (true) { ... page++ }` loop in `customer.read` | `helpers.pagination.page` |
| `let page = 1; while (true) { ... page++ }` loop in `product.read` | `helpers.pagination.page` |
| `let page = 1; while (true) { ... page++ }` loop in `invoice.read` | `helpers.pagination.page` |
| `bizId()` auto-discovery with `ctx.state.update` | `helpers.state.cachedToken` (same atomic cache pattern) |

The `gql<T>()` helper is Wave-specific (GraphQL error handling, `didSucceed` checks) and should
stay — it is not generic boilerplate.

#### Simplify page pagination in `read()`

The same `while (true)` page loop appears three times (customer, product, invoice). All three
have the same shape: fetch a page, filter by watermark, yield, advance page.

**Before (customer.read — product and invoice are identical in structure):**
```typescript
let page = 1;
while (true) {
  const data = await gql<...>(ctx, Q, { bizId: await bizId(ctx), page, size: 100 });
  const { pageInfo, edges } = data.business.customers;
  const records = edges.map((e) => e.node).filter((c) => !since || c.modifiedAt > since).map(customerToRecord);
  yield {
    records,
    since: maxOf(edges.map((e) => e.node.modifiedAt)) ?? since,
  };
  if (page >= pageInfo.totalPages) break;
  page++;
}
```

**After:**
```typescript
yield* helpers.pagination.page({
  fetchPage: async (page, size) => {
    const data = await gql<...>(ctx, Q, { bizId: await bizId(ctx), page, size });
    return data.business.customers;
  },
  hasNext: (result, currentPage) => currentPage < result.pageInfo.totalPages,
  items:   (result) => result.edges.map((e) => e.node).filter((c) => !since || c.modifiedAt > since),
  pageSize: 100,
  toBatch: (nodes) => ({
    records: nodes.map(customerToRecord),
    since:   nodes.reduce<string | undefined>((m, n) => helpers.watermark.max(m, n.modifiedAt), since),
  }),
});
```

#### `bizId()` auto-discovery

The `bizId()` function uses `ctx.state.update` to cache the auto-discovered business ID — the
same atomic cache pattern as Tripletex's session token, just with no expiry (the ID never changes).

**Before:**
```typescript
async function bizId(ctx): Promise<string> {
  const configured = ctx.config['businessId'];
  if (typeof configured === 'string' && configured) return configured;
  return ctx.state.update<string>('autoBusinessId', async (cached) => {
    if (cached) return cached;
    // ... GQL query ...
    return businesses[0].id;
  });
}
```

**After:**
```typescript
async function bizId(ctx): Promise<string> {
  const configured = ctx.config['businessId'];
  if (typeof configured === 'string' && configured) return configured;
  return helpers.state.cachedToken(
    ctx.state,
    'autoBusinessId',
    async () => { /* ... GQL query, return id ... */ },
    () => false, // never expires
  );
}
```

---

### SPARQL (`connectors/sparql/src/index.ts`)

The SPARQL connector has its own offset pagination loop and config-extraction functions, plus a
duplicated auth-error check that appears in both `sparqlSelect` and `sparqlUpdate`.

#### Remove local utilities

| Remove | Replace with |
|---|---|
| `function getQueryEndpoint(ctx)` | `helpers.config.requireString(ctx, 'queryEndpoint')` |
| `function getUpdateEndpoint(ctx)` | `helpers.config.requireString(ctx, 'updateEndpoint')` |
| Duplicate `if (res.status === 401 \|\| 403) throw new AuthError(...)` in `sparqlSelect` | `helpers.http.throwForStatus(res, '...', { authOnForbidden: true })` |
| Duplicate `if (res.status === 401 \|\| 403) throw new AuthError(...)` in `sparqlUpdate` | `helpers.http.throwForStatus(res, '...', { authOnForbidden: true })` |
| Manual `let offset = 0; while (true) { ... offset += PAGE_SIZE }` in `makeRdfEntity.read` | `helpers.pagination.offset` |
| Manual `let maxMod; for (row of rows) { ... }` watermark fold | `helpers.watermark.max` (inline in `toBatch`) |

#### Simplify `sparqlSelect` and `sparqlUpdate`

Both functions contain the same two-line pattern:
```typescript
if (res.status === 401 || res.status === 403) throw new AuthError('SPARQL: authentication failed');
if (!res.ok) throw new ConnectorError(`SPARQL ... ${res.status}`, 'QUERY_ERROR', res.status >= 500);
```

After the change:
```typescript
if (!res.ok) helpers.http.throwForStatus(res, 'SPARQL query', { name: 'SPARQL', authOnForbidden: true });
```

#### Simplify offset pagination in `makeRdfEntity.read`

**Before:**
```typescript
let offset = 0;
while (true) {
  const rows = await sparqlSelect(ctx, query(offset));
  if (rows.length === 0) break;
  let maxMod: string | undefined = since;
  for (const row of rows) {
    const rec = rowToRecord(row);
    if (!rec) continue;
    records.push(rec);
    const mod = row['_mod']?.value;
    if (mod && (!maxMod || mod > maxMod)) maxMod = mod;
  }
  yield { records, since: maxMod };
  if (rows.length < PAGE_SIZE) break;
  offset += PAGE_SIZE;
}
```

**After:**
```typescript
yield* helpers.pagination.offset({
  pageSize: PAGE_SIZE,
  fetchPage: (offset) => sparqlSelect(ctx, buildQuery(offset)),
  items:     (rows) => rows,
  hasNext:   (rows) => rows.length === PAGE_SIZE,
  total:     () => Infinity, // stop via hasNext
  toBatch:   (rows) => {
    const records = rows.flatMap((row) => { const r = rowToRecord(row); return r ? [r] : []; });
    const since   = rows.reduce<string | undefined>(
      (m, row) => helpers.watermark.max(m, row['_mod']?.value),
      initialSince,
    );
    return { records, since };
  },
});
```

#### Config extraction in `getQueryEndpoint` / `getUpdateEndpoint`

**Before:**
```typescript
function getQueryEndpoint(ctx): string {
  const ep = ctx.config['queryEndpoint'];
  if (typeof ep !== 'string' || !ep)
    throw new ValidationError('config.queryEndpoint must be a non-empty string');
  return ep;
}
```

**After — inline at call sites:**
```typescript
helpers.config.requireString(ctx, 'queryEndpoint')
helpers.config.requireString(ctx, 'updateEndpoint')
```

---

### HubSpot (`connectors/hubspot/src/index.ts`)

HubSpot benefits the most — it has a local `chunk()`, a local `throwForStatus()`, a local
`paginate()`, and a watermark reduce. It also has a hand-written `makeCrmEntity` factory with
all that duplication repeated per entity.

#### Remove local utilities

| Remove | Replace with |
|---|---|
| `async function* chunk<T>(...)` | `helpers.batching.fromAsync` |
| `function throwForStatus(res, context)` | `helpers.http.throwForStatus(res, context, { name: 'HubSpot', parseRetryAfter: true, authOnForbidden: false })` |
| `async function* paginate(ctx, path, since?)` | `helpers.pagination.cursor` (inline inside `makeCrmEntity`) |
| Manual `reduce` over `page.results` for `maxUpdated` | `helpers.watermark.fromRecords(records, 'hs_lastmodifieddate', since)` |

#### Simplify `makeCrmEntity`

The factory function currently contains a full inline `paginate()` loop in `read()`, repeated
`chunk()` calls in `insert()` / `update()` / `delete()`, and the watermark reduce.
After the migration, `read()` becomes a `yield*` of `helpers.pagination.cursor`, and the write
methods become `for await ... of helpers.batching.fromAsync`. The factory shrinks from ~150 lines
to ~60 lines with the same behavior.

**Before (read with local paginate + reduce):**
```typescript
async *read(ctx, since) {
  for await (const page of paginate(ctx, path, since)) {
    const maxUpdated = page.results.reduce<string | undefined>(
      (max, r) => {
        const u = r.properties['hs_lastmodifieddate'] as string | undefined;
        return u && (!max || u > max) ? u : max;
      },
      undefined
    );
    yield {
      records: page.results.map((r) => ({ id: r.id, data: r.properties })),
      since: maxUpdated ?? since,
    };
  }
},
```

**After:**
```typescript
async *read(ctx, since) {
  yield* helpers.pagination.cursor({
    fetchPage: async (cursor) => {
      const params = new URLSearchParams({ limit: '100' });
      if (cursor) params.set('after', cursor);
      if (since) params.set('updatedAfter', since);
      const res = await ctx.http(`${BASE}${path}?${params}`);
      if (!res.ok) helpers.http.throwForStatus(res, `GET ${path}`, { name: 'HubSpot' });
      return res.json();
    },
    nextCursor: (page) => page.paging?.next?.after,
    items:      (page) => page.results ?? [],
    toBatch:    (items) => ({
      records: items.map((r) => helpers.mapping.record(r.id, r.properties)),
      since:   helpers.watermark.fromRecords(
                 items.map((r) => helpers.mapping.record(r.id, r.properties)),
                 'hs_lastmodifieddate',
                 since,
               ),
    }),
  });
},
```

**Before (insert with local chunk):**
```typescript
async *insert(records, ctx) {
  for await (const batch of chunk(records, 100)) { ... }
},
```

**After:**
```typescript
async *insert(records, ctx) {
  for await (const batch of helpers.batching.fromAsync(records, 100)) { ... }
},
```

#### Import changes

Remove all local function definitions. Add one import:
```typescript
import type { ... } from '@opensync/sdk';
import { ConnectorError, RateLimitError, helpers } from '@opensync/sdk';
// Remove: ConnectorError, RateLimitError — no longer referenced directly
// (throwForStatus now comes from helpers and throws them internally)
```

---

### Tripletex (`connectors/tripletex/src/index.ts`)

Tripletex is the most complex connector and will see the most structural change. The session-token
management, offset pagination, watermark tracking, and webhook lifecycle can all move to helpers.

#### Remove local utilities

| Remove | Replace with |
|---|---|
| `interface SessionToken { value, expiresAt }` | Keep — this is domain-specific data shape |
| `function isExpired(token)` | Keep — domain logic |
| `async function fetchSessionToken(ctx)` | Keep — the API call itself is system-specific |
| `async function getSessionToken(ctx)` | `helpers.state.cachedToken(ctx.state, 'sessionToken', () => fetchSessionToken(ctx), isExpired)` |
| `function throwForStatus(res, context)` | `helpers.http.throwForStatus(res, context, { name: 'Tripletex', authOnForbidden: true })` |
| `async function* paginate<T>(ctx, path, params)` | `helpers.pagination.offset` (inline) |
| Watermark reduce in `customerEntity.read` | `helpers.watermark.fromRecords(records, 'changedDate', since)` |
| Watermark reduce in `invoiceEntity.read` | `helpers.watermark.fromRecords(records, 'invoiceDate', since)` |
| `async function registerSubscription(entity, ctx)` | `helpers.webhooks.register(ctx, subscriptionFor(entity))` |
| `async function deregisterSubscription(entity, ctx)` | `helpers.webhooks.deregister(ctx, subscriptionFor(entity))` |
| `webhookSubscription_${entity}` literal key strings | `helpers.state.key('webhookSubscription', entity)` |

#### Introduce `subscriptionFor(entity)` factory

The webhook helpers accept an options object. A small local factory replaces the two subscription
functions without adding any abstraction overhead:

```typescript
function subscriptionFor(entity: string) {
  const event = ENTITY_SUBSCRIPTION_EVENT[entity];
  return {
    stateKey: helpers.state.key('webhookSubscription', entity),
    register: async (ctx: ConnectorContext) => {
      const res = await ctx.http(`${ctx.config['baseUrl'] as string}/event/subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, targetUrl: `${ctx.webhookUrl}?entity=${entity}` }),
      });
      if (!res.ok) helpers.http.throwForStatus(res, `POST /event/subscription (${event})`, { name: 'Tripletex' });
      return ((await res.json()) as { value: { id: number } }).value.id;
    },
    deregister: async (ctx: ConnectorContext, id: string | number) => {
      const res = await ctx.http(`${ctx.config['baseUrl'] as string}/event/subscription/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404)
        helpers.http.throwForStatus(res, `DELETE /event/subscription/${id}`, { name: 'Tripletex' });
    },
  };
}
```

Entity `onEnable` / `onDisable` become single-liners:
```typescript
async onEnable(ctx)  { await helpers.webhooks.register(ctx, subscriptionFor('customer')); },
async onDisable(ctx) { await helpers.webhooks.deregister(ctx, subscriptionFor('customer')); },
```

#### Simplify pagination in read()

**Before:**
```typescript
async *read(ctx, since) {
  const params: Record<string, string> = {};
  if (since) params['changedSince'] = since;

  let maxChanged: string | undefined;
  for await (const page of paginate<Record<string, unknown>>(ctx, '/customer', params)) {
    for (const item of page) {
      const changed = item['changedDate'] as string | undefined;
      if (changed && (!maxChanged || changed > maxChanged)) maxChanged = changed;
    }
    yield {
      records: page.map((item) => ({ id: String(item['id']), data: item })),
      since: maxChanged ?? since,
    };
  }
},
```

**After:**
```typescript
async *read(ctx, since) {
  yield* helpers.pagination.offset({
    fetchPage: async (offset, pageSize) => {
      const p = new URLSearchParams({ from: String(offset), count: String(pageSize) });
      if (since) p.set('changedSince', since);
      const res = await ctx.http(`${ctx.config['baseUrl'] as string}/customer?${p}`);
      if (!res.ok) helpers.http.throwForStatus(res, 'GET /customer', { name: 'Tripletex' });
      return res.json() as Promise<{ values: Record<string, unknown>[]; fullResultSize: number }>;
    },
    items: (page) => page.values,
    total: (page) => page.fullResultSize,
    toBatch: (items) => ({
      records: items.map((item) => helpers.mapping.record(String(item['id']), item)),
      since:   helpers.watermark.fromRecords(
                 items.map((item) => helpers.mapping.record(String(item['id']), item)),
                 'changedDate',
                 since,
               ),
    }),
  });
},
```

#### `healthCheck` subscription key cleanup

The `healthCheck` currently hardcodes:
```typescript
const subscriptionKeys: Record<string, string> = {
  customer: 'webhookSubscription_customer',
  invoice:  'webhookSubscription_invoice',
};
```
Replace with `helpers.state.key('webhookSubscription', entity)` at the usage site.

---

### Postgres (`connectors/postgres/src/index.ts`)

Postgres has the most distinct form of duplication: per-method boilerplate that cannot be
extracted to shared utilities at present. The column-name validation regex is repeated three times;
`pool` setup/teardown wraps every method the same way.

#### Replace config extraction functions

| Remove | Replace with |
|---|---|
| `function tableName(ctx)` | `helpers.config.requirePattern(ctx, 'table', SAFE_IDENTIFIER)` |
| `function idColumn(ctx)` | `helpers.config.requirePattern(ctx, 'idColumn', SAFE_IDENTIFIER, { default: 'id' })` |
| `function updatedAtColumn(ctx)` | `helpers.config.optionalString(ctx, 'updatedAtColumn')` + pattern guard |

Extract the regex as a named constant at the top of the file:
```typescript
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;
```

#### Replace offset pagination in `read()`

The manual `while (true)` loop with `offset += rows.length` / `break` is exactly what
`helpers.pagination.offset` is for. The watermark reduce also goes away.

**Before (abbreviated):**
```typescript
async *read(ctx, since) {
  const pool = createPool(ctx); const table = tableName(ctx); ...
  let offset = 0;
  try {
    while (true) {
      // ... build query ...
      const rows = result.rows;
      if (rows.length === 0) break;
      const maxUpdated = updCol ? rows.reduce(...) : undefined;
      yield { records: rows.map(...), since: maxUpdated ?? since };
      if (rows.length < pageSize) break;
      offset += rows.length;
    }
  } finally { await pool.end(); }
},
```

**After:**
```typescript
async *read(ctx, since) {
  const pool  = createPool(ctx);
  const table = helpers.config.requirePattern(ctx, 'table', SAFE_IDENTIFIER);
  const idCol = helpers.config.requirePattern(ctx, 'idColumn', SAFE_IDENTIFIER, { default: 'id' });
  const updCol = helpers.config.optionalString(ctx, 'updatedAtColumn');

  try {
    yield* helpers.pagination.offset({
      pageSize: 500,
      fetchPage: async (offset, pageSize) => {
        let query: string; const params: unknown[] = [];
        if (updCol && since) {
          query = `SELECT * FROM ${table} WHERE ${updCol} > $1 ORDER BY ${updCol}, ${idCol} LIMIT ${pageSize} OFFSET $2`;
          params.push(since, offset);
        } else {
          query = `SELECT * FROM ${table} ORDER BY ${idCol} LIMIT ${pageSize} OFFSET $1`;
          params.push(offset);
        }
        const result = await pool.query(query, params);
        return result.rows as Record<string, unknown>[];
      },
      items:  (rows) => rows,
      total:  () => Infinity, // stop via hasNext: rows.length < pageSize
      hasNext: (rows) => rows.length === 500,
      toBatch: (rows) => ({
        records: rows.map((r) => rowToRecord(r, idCol)),
        since: updCol ? helpers.watermark.fromRecords(rows.map((r) => rowToRecord(r, idCol)), updCol, since) : since,
      }),
    });
  } finally {
    await pool.end();
  }
},
```

> Note: if `helpers.pagination.offset` does not support a `hasNext` override (preferring `total`),
> a small adapter using `helpers.pagination.page` or plain cursor with `undefined` as the
> termination signal is equally valid. Resolve during implementation.

#### Inline repeated column validation in write methods

`insert()` and `update()` each contain the same loop:
```typescript
for (const col of cols) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
    yield { id: ..., error: `Invalid column name: '${col}'` };
    continue;
  }
}
```

Extract to a local (file-level) helper — this is too small to belong in the SDK (it yields
per-record errors, not throws), but it is internal duplication worth fixing:
```typescript
function validateColumns(cols: string[]): string | undefined {
  for (const col of cols) {
    if (!SAFE_IDENTIFIER.test(col)) return `Invalid column name: '${col}'`;
  }
}
```

Then in `insert()` and `update()`:
```typescript
const colError = validateColumns(cols);
if (colError) { yield { id: ..., error: colError }; continue; }
```

---

### Kafka (`connectors/kafka/src/index.ts`)

Kafka is the simplest migration — one local `chunk()` function.

#### Replace local chunk

```typescript
// Remove: the entire local chunk() definition (~11 lines)
// In insert(), update(), delete():
for await (const batch of helpers.batching.fromAsync(records, 100)) { ... }
for await (const batch of helpers.batching.fromAsync(ids, 100)) { ... }
```

---

## Structural Goals After Migration

Once changes are applied, each connector file should read as:

1. **File-level comment** — what system this is, auth model, doc link.
2. **Imports** — SDK types/errors/helpers only; no local utility imports.
3. **Constants** — BASE URL, regex, config defaults.
4. **Auth / session logic** — only if the system has non-standard auth (Tripletex session tokens).
5. **Entity definitions** — schemas and CRUD methods containing only system-specific mapping.
6. **Connector export** — metadata, `getEntities`, lifecycle hooks.

There should be no local `chunk`, `paginate`, `throwForStatus`, or watermark fold after this work.
Any function that remains is either a domain-specific API wrapper (e.g. `fetchSessionToken`) or a
per-connector structural helper (e.g. `makeCrmEntity`, `subscriptionFor`).

---

## Line Count Targets (approximate)

| Connector | Current | Expected after cleanup |
|---|---|---|
| `hubspot/src/index.ts` | ~390 lines | ~230 lines |
| `tripletex/src/index.ts` | ~510 lines | ~310 lines |
| `postgres/src/index.ts` | ~380 lines | ~260 lines |
| `kafka/src/index.ts` | ~230 lines | ~210 lines |
| `waveapps/src/index.ts` | ~700 lines | ~560 lines |
| `sparql/src/index.ts` | ~600 lines | ~490 lines |
| `jsonfiles/src/index.ts` | ~280 lines | ~280 lines (no helpers apply — file I/O connector) |

---

## Test Coverage

No new tests are required for the connector source files — the behavior does not change,
only the implementation. Correctness is guaranteed by the helper tests written in
`plans/sdk-helpers.md`. However, the existing test suite (`bun run test`) must remain green
after each connector is migrated.

Suggested order of migration: **Kafka** (smallest change, fast confidence-check) →
**HubSpot** → **SPARQL** → **Wave** → **Postgres** → **Tripletex** (most structural change, do last).

The `jsonfiles` connector has no applicable helpers — it uses node:fs directly and has no HTTP
calls, pagination, or session tokens. It is intentionally excluded from this cleanup.

---

## Open Questions

1. The Wave `bizId()` function is semantically different from Tripletex's `cachedToken` — it
   caches permanently (no expiry), whereas session tokens expire. Should `helpers.state.cachedToken`
   accept `isExpired: () => false` as a valid call, or should there be a separate
   `helpers.state.cached(store, key, fetch)` variant for values that never expire?

2. The SPARQL `toBatch` watermark fold operates on raw `BindingRow[]` (not `ReadRecord[]`),
   so `helpers.watermark.fromRecords` does not apply directly. `helpers.watermark.max` in a
   `reduce` is the right tool here. Is the plan's usage of `max` vs `fromRecords` distinction
   clear enough for implementors?

4. Does `helpers.pagination.offset` need a `hasNext` override for cases (like Postgres and
   SPARQL) where the total row count is not known ahead of time, or should those connectors
   use a different strategy (e.g. detect stop by `rows.length < pageSize`)?

5. Should `rowToRecord` in the Postgres connector be replaced by `helpers.mapping.record`?
   It is small but currently file-local; if `helpers.mapping.record` supports the same call
   signature it is a direct substitution.

6. The `makeCrmEntity` factory in HubSpot is a legitimate connector-layer abstraction (not
   generic boilerplate). It should remain. Should it move to a separate `factories.ts` file
   within the connector to keep `index.ts` focused on exports?
