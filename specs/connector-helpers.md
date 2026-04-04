# SDK Helpers

Practical helper APIs in `@opensync/sdk` for common REST connector patterns.

This spec adds optional helper utilities for connector authors. These helpers are ergonomics only. They do not change the core connector contract.

## Goals

- Reduce boilerplate for common REST connector work.
- Keep helper APIs composable and code-first (not declarative YAML).
- Preserve connector control over HTTP calls, data mapping, and behavior.
- Fit the current stream-based connector model.

## Non-goals

- Replacing connector code with declarative resources.
- Hiding all HTTP details from connector authors.
- Changing engine behavior or core connector interfaces.

## Position in SDK

```typescript
import { helpers } from '@opensync/sdk';

helpers.pagination
helpers.state
helpers.watermark
helpers.mapping
helpers.batching
```

All helpers are optional. A connector can use none, some, or all.

## Pagination Helpers

Pagination is the largest repeated pattern in REST connectors. The SDK should provide a shared shape for popular strategies.

### Common Types

```typescript
type FetchPage<TPage> = (args: {
  cursor?: string;
  offset?: number;
  page?: number;
  pageSize?: number;
  since?: Date;
}) => Promise<TPage>;

interface PaginationRunOptions<TPage, TItem, TBatch = TItem[]> {
  fetchPage: FetchPage<TPage>;
  items: (page: TPage) => TItem[];
  toBatch?: (items: TItem[]) => TBatch;
  state?: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  stateKey?: string; // e.g. "cursor:contact"
  since?: Date;
}
```

### Strategies

```typescript
helpers.pagination.cursor<TPage, TItem, TBatch = TItem[]>(
  options: PaginationRunOptions<TPage, TItem, TBatch> & {
    nextCursor: (page: TPage) => string | undefined;
    initialCursor?: string;
  },
): AsyncIterable<TBatch>;

helpers.pagination.offset<TPage, TItem, TBatch = TItem[]>(
  options: PaginationRunOptions<TPage, TItem, TBatch> & {
    nextOffset: (page: TPage, currentOffset: number) => number | undefined;
    initialOffset?: number;
    pageSize: number;
  },
): AsyncIterable<TBatch>;

helpers.pagination.page<TPage, TItem, TBatch = TItem[]>(
  options: PaginationRunOptions<TPage, TItem, TBatch> & {
    hasNext: (page: TPage, currentPage: number) => boolean;
    initialPage?: number;
    pageSize?: number;
  },
): AsyncIterable<TBatch>;

helpers.pagination.nextUrl<TPage, TItem, TBatch = TItem[]>(
  options: {
    fetchPage: (url?: string) => Promise<TPage>;
    nextUrl: (page: TPage) => string | undefined;
    items: (page: TPage) => TItem[];
    toBatch?: (items: TItem[]) => TBatch;
    state?: PaginationRunOptions<TPage, TItem, TBatch>["state"];
    stateKey?: string;
    initialUrl?: string;
  },
): AsyncIterable<TBatch>;
```

### Behavior Rules

- Yields one batch per fetched page unless `toBatch` changes shape.
- Persists pagination cursor/page token when `state` and `stateKey` are provided.
- Clears saved pagination state when iteration finishes successfully.
- Leaves saved pagination state on failure so fetch can resume.
- Does not swallow HTTP or mapping errors.

### Example: Cursor Pagination in a Stream

```typescript
async function* fetchContacts(ctx: SyncContext, since?: Date) {
  yield* helpers.pagination.cursor({
    since,
    state: ctx.state,
    stateKey: 'cursor:contact',
    fetchPage: async ({ cursor, since }) => {
      const url = new URL('/crm/v3/objects/contacts', String(ctx.config.baseUrl));
      if (cursor) url.searchParams.set('after', cursor);
      if (since) url.searchParams.set('updatedAfter', helpers.watermark.toIso(since));

      const res = await ctx.http(url);
      if (!res.ok) throw new Error(`HubSpot error: ${res.status}`);
      return res.json();
    },
    items: (page) => page.results ?? [],
    nextCursor: (page) => page.paging?.next?.after,
    toBatch: (items) => items.map((item) => helpers.mapping.record(item.id, item.properties)),
  });
}
```

## State Helpers

Small helpers for safe state key namespacing and checkpoint storage.

```typescript
helpers.state.key(parts: string[]): string;
// Example: helpers.state.key(['pagination', 'contact', 'cursor'])
// => "pagination:contact:cursor"

helpers.state.checkpoint<T>(state: StateStore, key: string): {
  get(): Promise<T | undefined>;
  set(value: T): Promise<void>;
  clear(): Promise<void>;
};
```

## Watermark Helpers

Small utilities for consistent time handling across connectors.

```typescript
helpers.watermark.toIso(date: Date): string;
helpers.watermark.parse(value: string | number | Date): Date;
helpers.watermark.max(a?: Date, b?: Date): Date | undefined;
```

## Mapping Helpers

Small helpers for constructing normalized records and associations without repeated object boilerplate.

```typescript
helpers.mapping.record(
  id: string,
  data: Record<string, unknown>,
  options?: {
    associations?: Array<{ entity: string; externalId: string; role: string }>;
  },
): NormalizedRecord;

helpers.mapping.association(
  entity: string,
  externalId: string,
  role: string,
): { entity: string; externalId: string; role: string };
```

## Batching Helpers

Utilities for APIs that require chunked writes or for connectors that want controlled memory use.

```typescript
helpers.batching.chunk<T>(items: T[], size: number): T[][];

helpers.batching.fromAsync<T>(
  source: AsyncIterable<T>,
  size: number,
): AsyncIterable<T[]>;
```

## Error Handling Guidance

Helpers should not replace typed errors from the SDK. Connector code should still throw meaningful errors (`RateLimitError`, `AuthError`, `ValidationError`, etc.) so engine retry and safety behavior remains correct.

## Compatibility

- Helpers are additive and backward compatible.
- Existing connectors do not need migration.
- New connectors can adopt helpers incrementally.

## Open Questions

1. Should pagination helpers support adaptive page size under 429 pressure?
2. Should `helpers.pagination` expose hook callbacks (`onPage`, `onRetry`) for metrics?
3. Should there be an optional `helpers.http.json()` wrapper for strict JSON response parsing?
4. Should helper exports be tree-shakeable as subpaths (`@opensync/sdk/helpers/pagination`)?
