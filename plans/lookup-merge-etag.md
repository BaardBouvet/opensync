# Plan: Engine-Side Lookup-Merge and ETag Threading

**Status:** `backlog`

## Problem

The `update()` contract requires patch semantics — the engine sends only the fields that changed,
and the connector merges them into the existing record. For APIs with true PATCH endpoints this is
straightforward. For APIs that only support full-replace PUT, the connector must call `lookup()`
internally before every write to fetch the current record and merge locally.

This works, but it means every full-replace connector makes one extra API call per updated record,
and that extra call uses a fresh `ctx.http` (logged, retried), but the ETag or version token from
the lookup response is only visible inside the connector's own write method. The engine — which
already calls `lookup()` for conflict detection — cannot forward that token to the connector.

Two related problems stem from this:

1. **Duplicated lookups**: If the engine calls `lookup()` for conflict detection AND the connector
   calls it again for merge, the same record is fetched twice in the same dispatch pass.
2. **No conditional write support**: APIs that accept `If-Match` / `If-None-Match` headers
   (ETags) or `If-Unmodified-Since` can close the TOCTOU window on writes. But the connector
   has no way to receive the token the engine already obtained from its conflict-detection lookup.

---

## Background: Current Dispatch Flow

In the current engine (v4+):

```
ingest(source)
  → diff against shadow_state
  → resolve conflicts
  → [optionally] lookup(target, batch_of_ids)   ← conflict detection
  → compare live state against source snapshot
  → dispatch: connector.insert() / connector.update()
```

When conflict detection is enabled, `lookup()` is already called. The result is compared against
the source snapshot to detect external modifications, but the full live record is then discarded.
The `UpdateRecord` sent to `connector.update()` contains `{ id, data, associations }` only.

---

## Proposed Solution

### 1. Add `version` to `ReadRecord`

```typescript
interface ReadRecord {
  id: string;
  data: Record<string, unknown | unknown[]>;
  deleted?: boolean;
  associations?: Association[];
  version?: string;   // NEW — opaque optimistic-lock token (ETag, row version, etc.)
}
```

`version` is optional and connector-owned. Its meaning is entirely up to the connector:
- REST APIs: the value of the `ETag` or `Last-Modified` response header
- SQL DBs: a `row_version` or `updated_at` timestamp used as an optimistic lock
- Salesforce: `SystemModstamp`
- Any connector that doesn't support conditional writes: omit entirely

The engine stores `version` in its conflict-detection result but otherwise treats it as opaque.

### 2. Add `version` to `UpdateRecord`

```typescript
interface UpdateRecord {
  id: string;
  data: Record<string, unknown | unknown[]>;
  associations?: Association[];
  version?: string;   // NEW — forwarded from the conflict-detection lookup result
}
```

When the engine has performed a `lookup()` for this record in the current dispatch pass, it
copies the `version` from the lookup result into the `UpdateRecord`. The connector can use it
to set `If-Match: <version>` (or equivalent) on the write request.

If `lookup()` was not called (conflict detection disabled or `lookup` not implemented), `version`
is absent. Connectors must handle both cases.

### 3. Engine threads the lookup result

The engine no longer silently discards the live record from conflict detection:

```
lookup(target, batch_of_ids) → Map<id, ReadRecord>
  → compare each record.data against source snapshot        (conflict detection: unchanged)
  → also keep record.version per id                         (NEW: forwarded to UpdateRecord)
  → construct UpdateRecord: { id, data, associations, version: liveRecord.version }
  → connector.update(records)
```

---

## Eliminating the Duplicate Lookup

If the engine always calls `lookup()` before dispatching updates (not only when conflict
detection is enabled), connectors that currently call `lookup()` internally for merge purposes
can be simplified — they receive the full live snapshot in `UpdateRecord` and skip their own
lookup.

To support this, `UpdateRecord` could optionally carry the full live snapshot:

```typescript
interface UpdateRecord {
  id: string;
  data: Record<string, unknown | unknown[]>;
  associations?: Association[];
  version?: string;
  /** Full live record from the engine's pre-write lookup, if available.
   *  Connectors implementing full-replace PUT can merge against this instead
   *  of calling lookup() themselves. Absent if the engine did not call lookup. */
  snapshot?: Record<string, unknown | unknown[]>;
}
```

This is opt-in for the engine: `snapshot` is only populated if the engine already did the lookup.
The engine can decide per channel whether to always pre-fetch (lookup-before-write mode) or only
on conflict detection.

---

## Handling 412 Precondition Failed

When a connector forwards a `version` token as `If-Match` and the remote has been modified since
the lookup, the API returns `412 Precondition Failed`. This means the conflict window (lookup →
write) was non-zero and someone else wrote in between.

The connector should:
1. Yield a result with `error: "412 Precondition Failed — record modified concurrently"`.
2. **Not** throw — throwing would abort the entire write run.

The engine, on receiving the `error`, should:
1. Log it and mark the record for retry on the next cycle.
2. On retry, perform a fresh `lookup()` to get the updated `version`, then re-dispatch.

If the underlying conflict is genuine (the remote change was meaningful, not a round-trip echo),
the diff step on retry will detect it and the record may be held for conflict resolution rather
than being immediately re-dispatched.

---

## ETag in Bulk APIs

HubSpot batch-update and similar bulk APIs do not support per-record `If-Match` headers — the
entire batch either succeeds or fails atomically (or per-item errors are returned). For these
connectors `version` is irrelevant; connectors simply omit it from their `lookup()` results and
ignore it in `update()`.

The `version` field has no effect on correctness for connectors that don't use it. It is purely
additive.

---

## Connector Implementation Pattern

### Simple ETag connector (single-record REST)

```typescript
async lookup(ids, ctx) {
  return Promise.all(ids.map(async (id) => {
    const res = await ctx.http(`${base}/contacts/${id}`);
    if (!res.ok) throw new ConnectorError(`lookup failed: ${res.status}`);
    const data = await res.json();
    return {
      id,
      data,
      version: res.headers.get('ETag') ?? undefined,   // capture ETag
    };
  }));
},

async *update(records, ctx) {
  for await (const record of records) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (record.version) {
      headers['If-Match'] = record.version;            // use ETag for conditional write
    }
    const res = await ctx.http(`${base}/contacts/${record.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(record.data),
    });
    if (res.status === 412) {
      yield { id: record.id, error: '412 Precondition Failed — record modified concurrently' };
      continue;
    }
    if (!res.ok) throw new ConnectorError(`update failed: ${res.status}`);
    yield { id: record.id };
  }
},
```

### Connector that needs merge (full-replace PUT, uses snapshot)

```typescript
async *update(records, ctx) {
  for await (const record of records) {
    // Use pre-fetched snapshot if available; fall back to own lookup
    const current = record.snapshot ?? (await this.fetchOne(record.id, ctx));
    const merged  = { ...current, ...record.data };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (record.version) headers['If-Match'] = record.version;
    const res = await ctx.http(`${base}/contacts/${record.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(merged),
    });
    if (res.status === 412) {
      yield { id: record.id, error: '412 Precondition Failed — record modified concurrently' };
      continue;
    }
    if (!res.ok) throw new ConnectorError(`update failed: ${res.status}`);
    yield { id: record.id };
  }
},
```

---

## SDK Changes Required

| Item | Type | Risk |
|------|------|------|
| Add `version?: string` to `ReadRecord` | Additive | None — existing connectors unaffected |
| Add `version?: string` to `UpdateRecord` | Additive | None — existing connectors unaffected |
| Add `snapshot?: Record<string, unknown>` to `UpdateRecord` | Additive | None |
| Engine: thread `version` from lookup result to UpdateRecord | Engine internals | Low |
| Engine: optionally populate `snapshot` | Engine internals | Low |
| Connector: handle `version` in `update()` | Connector opt-in | None — connectors that ignore it continue to work |
| Handle 412 in engine retry logic | Engine internals | Medium |

All SDK changes are purely additive. No existing connector needs modification to maintain current
behaviour. Connectors that want conditional writes opt in by returning `version` from `lookup()`.

---

## Open Questions

1. **Always pre-fetch or only on conflict detection?** Pre-fetching unconditionally costs one
   `lookup()` call per updated record per cycle. For connectors on rate-limited APIs this may be
   expensive. Proposed default: only pre-fetch when conflict detection is enabled for the channel;
   expose a per-channel `prefetchBeforeWrite: true` option for connectors that need `snapshot` for
   merge but whose channel doesn't otherwise need conflict detection.

2. **Should `version` be stored in `shadow_state`?** Storing it allows the engine to re-use it
   across cycles without a fresh lookup on every write. But it may be stale after the last read —
   the point of ETag is to get the version for the record *as it is right now*. Shadow state
   version is useful for detecting staleness (if incoming ETag ≠ shadow ETag, the record was
   modified externally since the engine last synced) but not a replacement for a pre-write lookup.
   Tentative: yes, store it alongside `canonical_data` in `shadow_state`, but still do a lookup
   before write when `prefetchBeforeWrite` is enabled.

3. **`If-Unmodified-Since` as a fallback?** For APIs without ETag but with `updatedAt`, the
   connector could use `updatedAt` from the lookup as `If-Unmodified-Since`. This is weaker
   (1-second granularity in most APIs) but still provides optimistic locking. Should the engine
   support this automatically, or leave it entirely to the connector?

4. **Batch API ETags?** Some APIs return per-item versions inside a batch response body (not in
   headers). The connector can still capture these and return them from `lookup()`. No special
   engine behaviour is needed.

---

## Work Items

| # | Task | Touches |
|---|------|---------|
| 1 | Add `version?: string` to `ReadRecord` and `UpdateRecord` in `types.ts` | `packages/sdk/src/types.ts` |
| 2 | Add `snapshot?: Record<string, unknown>` to `UpdateRecord` | `packages/sdk/src/types.ts` |
| 3 | Engine: copy `version` from lookup result into UpdateRecord during dispatch | engine internals |
| 4 | Engine: populate `snapshot` on UpdateRecord when `prefetchBeforeWrite` is enabled | engine internals |
| 5 | Engine: retry 412 results on next cycle (fresh lookup → re-dispatch) | engine internals |
| 6 | Document `version` and conditional writes in `specs/connector-sdk.md` | specs |
| 7 | Add `prefetchBeforeWrite` option to channel config and document in `specs/config.md` | specs |
| 8 | Migrate one example connector (e.g. tripletex) to demonstrate the pattern | connectors/ |
