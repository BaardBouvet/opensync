# Plan: SDK Helpers

**Status:** backlog  
**Date:** 2026-04-04  
**Spec:** [specs/sdk-helpers.md](../../specs/sdk-helpers.md)  

## Goal

Add a `helpers` export to `@opensync/sdk` that eliminates the boilerplate code that currently
appears in every example connector. Helpers are pure utilities — they do not change the connector
interface, engine behavior, or any existing contracts.

## Duplication Audit

Before designing the API, here is every concrete duplication found across the four example
connectors. Each item maps to one helper group below.

### 1. `chunk()` — async batching (hubspot, kafka)

`connectors/hubspot/src/index.ts` and `connectors/kafka/src/index.ts` both contain a
word-for-word identical copy of:

```typescript
async function* chunk<T>(source: AsyncIterable<T>, size: number): AsyncIterable<T[]> {
  let batch: T[] = [];
  for await (const item of source) {
    batch.push(item);
    if (batch.length === size) { yield batch; batch = []; }
  }
  if (batch.length > 0) yield batch;
}
```

Both connectors use it to batch write operations into fixed-size API calls (100 records at a time).

### 2. `throwForStatus()` — HTTP error mapping (hubspot, tripletex)

`hubspot/src/index.ts` and `tripletex/src/index.ts` each define a local `throwForStatus(res, context)`
that maps HTTP status codes to SDK error types. The logic is similar but not identical — HubSpot
parses `Retry-After`, Tripletex handles 401/403 as `AuthError`. The function cannot currently be
shared because it lives as a local closure.

### 3. Cursor-based pagination (hubspot)

`hubspot/src/index.ts` defines a local `paginate(ctx, path, since?)` generator that loops on
`body.paging?.next?.after`. The same loop structure will appear in any connector that uses
GitHub, Stripe, Notion, or any other `cursor`+`next_page` API. It is currently defined three
levels deep inside a module-level function, preventing reuse.

### 4. Offset-based pagination (tripletex, postgres)

`tripletex/src/index.ts` defines a local `paginate<T>(ctx, path, params)` generator using
Tripletex's `from`/`count`/`fullResultSize` pattern. `postgres/src/index.ts` implements the same
offset increment loop manually inside `read()`. Any SQL-backed or accounting-API connector will
duplicate this.

### 5. Watermark tracking — max over a page (hubspot, tripletex, postgres)

All three read-capable connectors manually fold a max watermark string over each page returned:

- **HubSpot**: `page.results.reduce((max, r) => { const u = r.properties["hs_lastmodifieddate"]; ... })`
- **Tripletex** (customer): `let maxChanged; for (item of page) { if changed > maxChanged maxChanged = changed }`
- **Tripletex** (invoice): duplicate of the above with `let maxDate`
- **Postgres**: `rows.reduce((max, r) => { const v = r[updCol]; ... })`

The pattern is always: iterate records, compare strings lexicographically, keep the latest.

### 6. Short-lived token caching (tripletex)

`tripletex/src/index.ts` uses `ctx.state.update("sessionToken", async (current) => { ... })`
to atomically fetch and cache a session token that expires in ~24 hours. This exact pattern
(exchange long-lived credentials for a short-lived token, cache with expiry check, refresh
atomically) will appear in any connector using Salesforce, SAP, Dynamics NAV, Oracle, or any
other platform with session-token auth.

### 7. Webhook subscription lifecycle (tripletex)

`tripletex/src/index.ts` defines `registerSubscription(entity, ctx)` and
`deregisterSubscription(entity, ctx)` that POST/DELETE to a REST subscription endpoint and
persist the subscription ID in `ctx.state`. The same pattern is needed by any connector with
a managed webhook registration API (Shopify, Stripe, GitHub).

### 8. Config field extraction + validation (postgres)

`postgres/src/index.ts` defines `tableName(ctx)`, `idColumn(ctx)`, and `updatedAtColumn(ctx)`,
each of which reads a config key, asserts it is a non-empty string, validates it against a
safe-identifier regex, and throws `ValidationError` on failure. The same idiom (read-validate-
return) will appear in every connector that has multiple typed config fields.

---

## Proposed API

Each namespace is a distinct module exported via `package.json` `exports`. No breaking changes;
all existing connectors continue to compile without modification.

### `@opensync/sdk/helpers/batching`

```typescript
/** Collect an async iterable into fixed-size arrays. */
export function fromAsync<T>(
  source: AsyncIterable<T>,
  size: number,
): AsyncIterable<T[]>;

/** Partition a plain array into fixed-size chunks. */
export function chunk<T>(items: T[], size: number): T[][];
```

Replaces the local `chunk()` in `hubspot` and `kafka`. The async version is the one both
connectors need; the sync version is a bonus for callers building batch payloads from arrays.

### `@opensync/sdk/helpers/http`

```typescript
export interface ThrowForStatusOptions {
  /** Connector name used in error messages, e.g. "HubSpot". */
  name?: string;
  /** Parse the Retry-After header (seconds) into RateLimitError.retryAfterMs. Default: true. */
  parseRetryAfter?: boolean;
  /** Treat 401/403 as AuthError instead of ConnectorError. Default: true. */
  authOnForbidden?: boolean;
}

/**
 * Throw the appropriate SDK error for a non-2xx response.
 * Never returns — return type is `never` so callers can `throwForStatus(res, ...)`.
 */
export function throwForStatus(
  res: Response,
  context: string,
  options?: ThrowForStatusOptions,
): never;
```

The `authOnForbidden` flag defaults to `true`, covering Tripletex. HubSpot does not need it
because HubSpot 401s are handled by the OAuth flow, but the flag is present for connectors
that do want it.

### `@opensync/sdk/helpers/pagination`

All pagination helpers are `AsyncIterable<TBatch>` — they can be `yield*`-ed directly inside
a connector's `read()` generator.

```typescript
/** Cursor / next-token pagination (GitHub, HubSpot, Stripe, Notion, ...) */
export function cursor<TPage, TItem, TBatch = TItem[]>(options: {
  fetchPage: (cursor: string | undefined) => Promise<TPage>;
  nextCursor: (page: TPage) => string | undefined;
  items: (page: TPage) => TItem[];
  toBatch?: (items: TItem[], page: TPage) => TBatch;
  state?: StateStore;
  stateKey?: string;
  initialCursor?: string;
}): AsyncIterable<TBatch>;

/** Numeric offset pagination (Tripletex, any SQL-style API) */
export function offset<TPage, TItem, TBatch = TItem[]>(options: {
  fetchPage: (offset: number, pageSize: number) => Promise<TPage>;
  items: (page: TPage) => TItem[];
  total: (page: TPage) => number;
  pageSize?: number;         // default: 100
  initialOffset?: number;   // default: 0
  toBatch?: (items: TItem[], page: TPage) => TBatch;
  state?: StateStore;
  stateKey?: string;
}): AsyncIterable<TBatch>;

/** Page-number pagination */
export function page<TPage, TItem, TBatch = TItem[]>(options: {
  fetchPage: (page: number, pageSize: number) => Promise<TPage>;
  hasNext: (page: TPage, currentPage: number) => boolean;
  items: (page: TPage) => TItem[];
  pageSize?: number;
  initialPage?: number;
  toBatch?: (items: TItem[], page: TPage) => TBatch;
  state?: StateStore;
  stateKey?: string;
}): AsyncIterable<TBatch>;

/** Next-URL / Link-header pagination (REST APIs that return the next page as a full URL) */
export function nextUrl<TPage, TItem, TBatch = TItem[]>(options: {
  fetchPage: (url: string | undefined) => Promise<TPage>;
  nextUrl: (page: TPage) => string | undefined;
  items: (page: TPage) => TItem[];
  toBatch?: (items: TItem[], page: TPage) => TBatch;
  state?: StateStore;
  stateKey?: string;
  initialUrl?: string;
}): AsyncIterable<TBatch>;
```

**Shared behavior across all strategies:**

- If `state` and `stateKey` are provided, each page persists the current cursor/offset/page
  to state before yielding. On the next call the helper resumes from the saved position,
  enabling crash-safe pagination for long syncs.
- State is cleared automatically when all pages are exhausted.
- On error, state is left in place so the next run resumes from the last committed position.
- `toBatch` receives both the mapped items and the raw page, so callers can extract per-page
  metadata (e.g. the `since` watermark) into the batch.

### `@opensync/sdk/helpers/watermark`

```typescript
/** Clamp a string watermark: return the lexicographically greater of a and b. */
export function max(a: string | undefined, b: string | undefined): string | undefined;

/**
 * Fold a max watermark string over a list of records by extracting a field value.
 * Equivalent to the reduce at the end of every read() implementation.
 *
 * Example:
 *   const since = fromRecords(records, 'hs_lastmodifieddate', prev);
 */
export function fromRecords(
  records: ReadRecord[],
  field: string,
  current?: string,
): string | undefined;

/** Coerce a string watermark to a Date (ISO or epoch millis). */
export function toDate(value: string): Date;

/** Coerce a Date to an ISO 8601 string watermark. */
export function fromDate(date: Date): string;
```

### `@opensync/sdk/helpers/state`

```typescript
/** Build a namespaced state key from parts, joined with ':'. */
export function key(...parts: string[]): string;
// key('pagination', 'contact', 'cursor') => 'pagination:contact:cursor'

/** A typed wrapper around a single state key for cleaner read/write/clear patterns. */
export function checkpoint<T>(store: StateStore, stateKey: string): {
  get(): Promise<T | undefined>;
  set(value: T): Promise<void>;
  clear(): Promise<void>;
};

/**
 * Cache a short-lived credential in state, refreshing it atomically when expired.
 * Wraps ctx.state.update to prevent concurrent refresh races.
 *
 * @param store     ctx.state
 * @param stateKey  State key to store the cached value under
 * @param fetch     Called when the cached value is missing or expired
 * @param isExpired Returns true if the cached value should be refreshed
 * @param timeoutMs Forwarded to state.update (default: 15 000)
 */
export function cachedToken<T>(
  store: StateStore,
  stateKey: string,
  fetch: () => Promise<T>,
  isExpired: (value: T) => boolean,
  timeoutMs?: number,
): Promise<T>;
```

`cachedToken` directly replaces the `getSessionToken()` pattern in Tripletex,
which is boilerplate that will appear in every connector with session-based auth.

### `@opensync/sdk/helpers/webhooks`

```typescript
export interface WebhookSubscriptionOptions {
  /** Called to create a subscription. Must return the subscription ID to persist. */
  register: (ctx: ConnectorContext) => Promise<string | number>;
  /** Called to delete a subscription. Receives the previously stored ID.
   *  Should treat 404 as success (idempotent). */
  deregister: (ctx: ConnectorContext, id: string | number) => Promise<void>;
  /** State key to persist the subscription ID under. */
  stateKey: string;
}

/**
 * Register a webhook subscription and store its ID in state.
 * Idempotent — if the state key already has an ID, skips the registration call.
 */
export function register(
  ctx: ConnectorContext,
  options: WebhookSubscriptionOptions,
): Promise<void>;

/**
 * Deregister the subscription stored at options.stateKey.
 * No-ops if no ID is stored.
 */
export function deregister(
  ctx: ConnectorContext,
  options: WebhookSubscriptionOptions,
): Promise<void>;
```

### `@opensync/sdk/helpers/config`

```typescript
/**
 * Read a required string config field. Throws ValidationError if missing or not a string.
 */
export function requireString(ctx: ConnectorContext, key: string): string;

/**
 * Read an optional string config field. Returns undefined if absent.
 * Throws ValidationError if present but not a string.
 */
export function optionalString(ctx: ConnectorContext, key: string): string | undefined;

/**
 * Read a required string config field and validate it matches a regex.
 * Used for identifiers that will be interpolated into queries or paths.
 * Throws ValidationError with a helpful message on mismatch.
 *
 * Example: requirePattern(ctx, 'table', /^[a-zA-Z_][a-zA-Z0-9_.]*$/)
 */
export function requirePattern(
  ctx: ConnectorContext,
  key: string,
  pattern: RegExp,
  description?: string,
): string;
```

### `@opensync/sdk/helpers/mapping`

```typescript
/**
 * Construct a ReadRecord from an id and a data object.
 * Optional associations are passed as-is.
 */
export function record(
  id: string,
  data: Record<string, unknown>,
  associations?: Association[],
): ReadRecord;

/** Construct a single Association object. */
export function association(
  predicate: string,
  targetEntity: string,
  targetId: string,
  metadata?: Record<string, unknown>,
): Association;
```

---

## File Layout

```
packages/sdk/src/
  helpers/
    batching.ts     # fromAsync, chunk
    config.ts       # requireString, optionalString, requirePattern
    http.ts         # throwForStatus
    mapping.ts      # record, association
    pagination.ts   # cursor, offset, page, nextUrl
    state.ts        # key, checkpoint, cachedToken
    watermark.ts    # max, fromRecords, toDate, fromDate
    webhooks.ts     # register, deregister
  index.ts          # unchanged — no helpers re-exported here; keeps engine imports lean
```

Each file in `helpers/` is its own subpath export. The top-level `index.ts` intentionally
does **not** re-export helpers — this preserves the engine's ability to import `@opensync/sdk`
without pulling in any helper code.

`package.json` gains one `exports` entry per helper module:

```json
"exports": {
  ".": {
    "import": "./dist/index.js",
    "types":  "./dist/index.d.ts"
  },
  "./helpers/batching": {
    "import": "./dist/helpers/batching.js",
    "types":  "./dist/helpers/batching.d.ts"
  },
  "./helpers/config": {
    "import": "./dist/helpers/config.js",
    "types":  "./dist/helpers/config.d.ts"
  },
  "./helpers/http": {
    "import": "./dist/helpers/http.js",
    "types":  "./dist/helpers/http.d.ts"
  },
  "./helpers/mapping": {
    "import": "./dist/helpers/mapping.js",
    "types":  "./dist/helpers/mapping.d.ts"
  },
  "./helpers/pagination": {
    "import": "./dist/helpers/pagination.js",
    "types":  "./dist/helpers/pagination.d.ts"
  },
  "./helpers/state": {
    "import": "./dist/helpers/state.js",
    "types":  "./dist/helpers/state.d.ts"
  },
  "./helpers/watermark": {
    "import": "./dist/helpers/watermark.js",
    "types":  "./dist/helpers/watermark.d.ts"
  },
  "./helpers/webhooks": {
    "import": "./dist/helpers/webhooks.js",
    "types":  "./dist/helpers/webhooks.d.ts"
  }
}
```

---

## Implementation Steps

### Step 1: `helpers.batching`

Implement `packages/sdk/src/helpers/batching.ts`. This is the simplest helper and the one
with the most direct duplication. Two connectors have identical code today.

Write a unit test (alongside `connectors/jsonfiles/src/index.test.ts` or a new
`packages/sdk/src/helpers/batching.test.ts`) that covers:
- Empty source
- Source length exactly equals size
- Source length not divisible by size
- Size of 1

### Step 2: `helpers.watermark`

Implement `packages/sdk/src/helpers/watermark.ts`. Unit test all four functions:
- `max` with both undefined, one undefined, a > b, a < b, equal strings
- `fromRecords` with empty array, missing field, populated field
- Round-trip `toDate` / `fromDate`

### Step 3: `helpers.http`

Implement `packages/sdk/src/helpers/http.ts`. The implementation constructs the correct SDK
error type based on status code and options. Unit test by passing mock `Response` objects
(available without a live HTTP server via `new Response(null, { status: 429, headers: { 'Retry-After': '5' } })`).

Cover:
- 429 with Retry-After → `RateLimitError` with `retryAfterMs = 5000`
- 429 without Retry-After → `RateLimitError` with no `retryAfterMs`
- 401 with `authOnForbidden: true` (default) → `AuthError`
- 401 with `authOnForbidden: false` → `ConnectorError`
- 503 → `ConnectorError` with `retryable: true`
- 400 → `ConnectorError` with `retryable: false`

### Step 4: `helpers.config`

Implement `packages/sdk/src/helpers/config.ts`. Unit test using constructed `ConnectorContext`
mocks (a plain object with a `config` property is sufficient since config is just a Record).

### Step 5: `helpers.state`

Implement `packages/sdk/src/helpers/state.ts`. The `cachedToken` function is the highest-value
item here. Unit test with an in-memory `StateStore` mock (a `Map`-backed implementation is
sufficient). Test the concurrent-refresh scenario: two simultaneous calls to `cachedToken` when
the token is expired should result in exactly one `fetch()` call.

### Step 6: `helpers.pagination`

Implement `packages/sdk/src/helpers/pagination.ts`. This is the most complex helper. Each
strategy is a separate async generator. Unit test each strategy with a mock `fetchPage`
function that returns a fixed sequence of pages, verifying:
- All items are yielded
- Iteration stops when `nextCursor` / `total` / `hasNext` signals end
- State is written after each page (if provided) and cleared on completion
- State is NOT cleared when `fetchPage` throws (resume support)

### Step 7: `helpers.webhooks`

Implement `packages/sdk/src/helpers/webhooks.ts`. Unit test register idempotency (calling
register twice should only call `options.register` once) and deregister no-op when no state.

### Step 8: `helpers.mapping`

Implement `packages/sdk/src/helpers/mapping.ts`. Small and trivial; no complex logic. Unit
tests are decorative but should cover the `associations` field being omitted vs. present.

### Step 9: Wire up exports

Add the eight `./helpers/*` subpath entries to `packages/sdk/package.json` (see File Layout).
No changes to `packages/sdk/src/index.ts` — the helper modules stand alone.

### Step 10: Migrate HubSpot connector

Replace in `connectors/hubspot/src/index.ts`:
- Local `chunk()` → `fromAsync` from `@opensync/sdk/helpers/batching`
- Local `throwForStatus()` → `throwForStatus` from `@opensync/sdk/helpers/http`
- Local `paginate()` → `cursor` from `@opensync/sdk/helpers/pagination`
- Watermark reduce → `fromRecords` from `@opensync/sdk/helpers/watermark`

### Step 11: Migrate Tripletex connector

Replace in `connectors/tripletex/src/index.ts`:
- Local `throwForStatus()` → `throwForStatus` from `@opensync/sdk/helpers/http` (with `authOnForbidden: true`)
- Local `paginate<T>()` → `offset` from `@opensync/sdk/helpers/pagination`
- Watermark reduces → `fromRecords` from `@opensync/sdk/helpers/watermark`
- `getSessionToken()` → `cachedToken` from `@opensync/sdk/helpers/state`
- `registerSubscription()` / `deregisterSubscription()` → `register` / `deregister` from `@opensync/sdk/helpers/webhooks`
- `webhookSubscription_${entity}` state keys → `key` from `@opensync/sdk/helpers/state`

### Step 12: Migrate Postgres connector

Replace in `connectors/postgres/src/index.ts`:
- `tableName(ctx)` → `requirePattern` from `@opensync/sdk/helpers/config`
- `idColumn(ctx)` → `requirePattern` from `@opensync/sdk/helpers/config` with a default
- `updatedAtColumn(ctx)` → `optionalString` from `@opensync/sdk/helpers/config` + pattern check
- Manual offset pagination loop in `read()` → `offset` from `@opensync/sdk/helpers/pagination`
- Watermark reduce → `fromRecords` from `@opensync/sdk/helpers/watermark`

### Step 13: Migrate Kafka connector

Replace in `connectors/kafka/src/index.ts`:
- Local `chunk()` → `fromAsync` from `@opensync/sdk/helpers/batching`

---

## Before/After Examples

### Batching (hubspot, kafka)

**Before:**
```typescript
async function* chunk<T>(source: AsyncIterable<T>, size: number): AsyncIterable<T[]> {
  let batch: T[] = [];
  for await (const item of source) {
    batch.push(item);
    if (batch.length === size) { yield batch; batch = []; }
  }
  if (batch.length > 0) yield batch;
}

// ... later in insert()
for await (const batch of chunk(records, 100)) { ... }
```

**After:**
```typescript
import { fromAsync } from '@opensync/sdk/helpers/batching';

// ... in insert()
for await (const batch of fromAsync(records, 100)) { ... }
```

### Short-lived token caching (tripletex)

**Before:**
```typescript
async function getSessionToken(ctx: ConnectorContext): Promise<string> {
  const token = await ctx.state.update<SessionToken>(
    "sessionToken",
    async (current) => {
      if (current && !isExpired(current)) return current;
      return fetchSessionToken(ctx);
    },
    15_000,
  );
  return token.value;
}
```

**After:**
```typescript
import { cachedToken } from '@opensync/sdk/helpers/state';

async function getSessionToken(ctx: ConnectorContext): Promise<string> {
  const token = await cachedToken(
    ctx.state,
    'sessionToken',
    () => fetchSessionToken(ctx),
    isExpired,
    15_000,
  );
  return token.value;
}
```

### Offset pagination (tripletex)

**Before:**
```typescript
async function* paginate<T>(ctx, path, params = {}) {
  const base = ctx.config['baseUrl'] as string;
  let from = 0;
  const count = 100;
  while (true) {
    const p = new URLSearchParams({ ...params, from: String(from), count: String(count) });
    const res = await ctx.http(`${base}${path}?${p}`);
    if (!res.ok) throwForStatus(res, `GET ${path}`);
    const body = await res.json() as { values: T[]; fullResultSize: number };
    yield body.values;
    from += body.values.length;
    if (from >= body.fullResultSize || body.values.length === 0) break;
  }
}
```

**After:**
```typescript
import { offset }         from '@opensync/sdk/helpers/pagination';
import { throwForStatus } from '@opensync/sdk/helpers/http';

yield* offset({
  pageSize: 100,
  fetchPage: async (off, pageSize) => {
    const p = new URLSearchParams({ ...params, from: String(off), count: String(pageSize) });
    const res = await ctx.http(`${base}${path}?${p}`);
    if (!res.ok) throwForStatus(res, `GET ${path}`);
    return res.json();
  },
  items: (page) => page.values,
  total: (page) => page.fullResultSize,
});
```

### Webhook lifecycle (tripletex)

**Before:**
```typescript
async function registerSubscription(entity: string, ctx: ConnectorContext): Promise<void> {
  const base = ctx.config['baseUrl'] as string;
  const targetUrl = `${ctx.webhookUrl}?entity=${entity}`;
  const res = await ctx.http(`${base}/event/subscription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: ENTITY_SUBSCRIPTION_EVENT[entity], targetUrl }),
  });
  if (!res.ok) throwForStatus(res, `POST /event/subscription`);
  const body = await res.json() as { value: { id: number } };
  await ctx.state.set(`webhookSubscription_${entity}`, body.value.id);
}
// + symmetric deregisterSubscription()
```

**After:**
```typescript
import { key }                             from '@opensync/sdk/helpers/state';
import { register, deregister }            from '@opensync/sdk/helpers/webhooks';
import { throwForStatus }                  from '@opensync/sdk/helpers/http';
import type { WebhookSubscriptionOptions } from '@opensync/sdk/helpers/webhooks';

const subscriptionFor = (entity: string): WebhookSubscriptionOptions => ({
  stateKey: key('webhookSubscription', entity),
  register: async (ctx) => {
    const res = await ctx.http(`${ctx.config['baseUrl']}/event/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: ENTITY_SUBSCRIPTION_EVENT[entity],
        targetUrl: `${ctx.webhookUrl}?entity=${entity}`,
      }),
    });
    if (!res.ok) throwForStatus(res, `POST /event/subscription`);
    const body = await res.json() as { value: { id: number } };
    return body.value.id;
  },
  deregister: async (ctx, id) => {
    const res = await ctx.http(`${ctx.config['baseUrl']}/event/subscription/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throwForStatus(res, `DELETE /event/subscription/${id}`);
  },
});

// In entity definition:
async onEnable(ctx)  { await register(ctx, subscriptionFor('customer')); },
async onDisable(ctx) { await deregister(ctx, subscriptionFor('customer')); },
```

---

## Open Questions

1. Should `@opensync/sdk/helpers/pagination` accept a `signal: AbortSignal` to support
   cooperative cancellation mid-page? The engine may want to cancel a long-running read
   without waiting for it to exhaust all pages.

2. Should `throwForStatus` in `@opensync/sdk/helpers/http` also handle `502`/`503`/`504` as
   `ServiceUnavailableError` (a new distinct error type) so the engine can apply a longer
   backoff than for 5xx generally?

3. The `toBatch` callback in the pagination helpers accepts `(items, page)`. Is the raw
   `page` argument necessary in practice, or does passing only `items` keep the API cleaner?
   HubSpot needs the page only for extracting `paging.next.after` — but that is already
   handled internally by `nextCursor`. No current connector needs `page` in `toBatch`.

4. Should `requirePattern` in `@opensync/sdk/helpers/config` accept a `default` value to
   allow optional-but-validated config fields? Postgres's `idColumn` defaults to `'id'`,
   which would be cleaner as
   `requirePattern(ctx, 'idColumn', SAFE_IDENTIFIER, { default: 'id' })`.

5. ~~Should helpers be tree-shakeable via subpath exports?~~ **Resolved: yes, subpath exports.**
   Each helper is a separate `@opensync/sdk/helpers/*` module. The engine imports only
   `@opensync/sdk` (core types/errors) and never pays the cost of helper code.
