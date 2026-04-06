# PLAN: Async Export Transport

**Status:** draft  
**Date:** 2026-04-06  
**Effort:** M  
**Domain:** connectors/  
**Depends on:** [connectors/PLAN_FILE_INGEST.md](PLAN_FILE_INGEST.md) (FileTransport interface, createFileConnector factory)  
**Spec changes planned:**  
- `specs/connector-helpers.md` — add §N "Async export transport": `AsyncExportTransport`
  interface, `transport.asyncExport()` factory, `createFileEntity()` factory,
  submit/poll/download lifecycle, watermark strategy, timeout and retry contract.  
- `specs/connector-sdk.md` — add cross-reference from §N "File-based connectors" noting
  that `createFileEntity` returns an `EntityDefinition` for use in mixed connectors, and
  that `createFileConnector` is the standalone-only shorthand.

---

## 1. Motivation

Several APIs cannot serve data via a simple paginated GET. Instead they expose an
asynchronous export workflow:

1. **POST** a job request (entity type, date range, filters, format)
2. Receive a job ID or result URI in the response
3. **Poll** the job status endpoint until the job reaches a terminal state
4. **Download** one or more result files from the provided download URL(s)

Real-world examples:

| System | Mechanism |
|--------|-----------|
| Salesforce Bulk API 2.0 | `POST /jobs/query` → poll `GET /jobs/query/{jobId}` → `GET /jobs/query/{jobId}/results` |
| HubSpot CRM Export | `POST /crm/v3/exports` → poll `GET /crm/v3/exports/{exportId}` → signed S3 download URL |
| Tripletex ledger export | `GET /ledger/exportLedger` (async variant) → `GET /report/{jobId}/download` |
| Visma eAccounting | `POST /v2/fiscal-years/{id}/export` → poll → download ZIP |

This pattern is fundamentally different from the static-file transports in
`PLAN_FILE_INGEST.md`. There is no remote directory to list — the files only exist after
being explicitly requested, and the request parameters decide *what* data they contain.

---

## 2. Design Principle

**The async lifecycle is an implementation detail of the transport layer.**

From the perspective of `createFileConnector`, a transport implements `list(since?)` and
`fetch(ref)`. An async export transport satisfies these by running the
submit/poll/download loop internally:

- `list(since?)` submits a job (passing `since` as the export cursor), polls to completion,
  and yields one or more `FileRef` objects — one per result chunk.
- `fetch(ref)` downloads the bytes at `ref.url` set during `list()`.

The codec and format layers above remain completely unaware. A connector author composes
`transport.asyncExport(...)` with any `codec.*` and `format.*` exactly as they would
`transport.sftp(...)`.

---

## 3. Interface

### § 3.1 `AsyncExportTransport`

`AsyncExportTransport` extends `FileTransport` (from `PLAN_FILE_INGEST.md §3.1`). It adds
the explicit submit/poll/download contracts; `list()` and `fetch()` are provided by the
base implementation in terms of these three methods.

```typescript
// Spec: specs/connector-helpers.md § "Async export transport"

interface AsyncExportTransport extends FileTransport {
  /** Submit an export job. `since` is the watermark cursor from the last cycle. */
  submit(since: string | undefined): Promise<JobRef>;

  /** Check job status. Called repeatedly until `status` is 'complete' or 'failed'. */
  poll(job: JobRef): Promise<JobStatus>;

  /**
   * Yield the download URL(s) once the job is complete.
   * Most APIs return one URL; bulk APIs (Salesforce) may chunk results into many.
   */
  download(job: JobRef): AsyncIterable<FileRef>;

  /**
   * Derive the next watermark from the FileRefs yielded this cycle.
   * Typically returns the export cursor sent in submit(), so the next call advances it.
   */
  watermark(refs: FileRef[]): string;
}

interface JobRef {
  id: string;
  /** Opaque provider-specific metadata (e.g. poll URL, headers). */
  meta?: Record<string, unknown>;
}

interface JobStatus {
  status: 'pending' | 'running' | 'complete' | 'failed';
  /** Provider error message, present when status = 'failed'. */
  error?: string;
  /** Provider progress hint (0–1), optional. */
  progress?: number;
}
```

The base class supplied by the SDK implements `FileTransport.list()` and `FileTransport.fetch()`
as:

```typescript
// list(): submit → poll loop → download
async *list(since?: string): AsyncIterable<FileRef> {
  const job = await this.submit(since);
  const status = await this._pollUntilDone(job);   // internal: loops poll() with backoff
  if (status.status === 'failed') throw new ConnectorError(status.error ?? 'export failed', 'EXPORT_FAILED', false);
  yield* this.download(job);
}

// fetch(): the FileRef.url set by download() is a direct download URL
async fetch(ref: FileRef): Promise<Buffer> {
  const res = await fetch(ref.url!);
  if (!res.ok) throw new ConnectorError(`download failed: ${res.status}`, 'DOWNLOAD_FAILED', res.status >= 500);
  return Buffer.from(await res.arrayBuffer());
}

// put(): async export transports are read-only by default; override to add write-back
async put(_path: string, _content: Buffer): Promise<void> {
  throw new ConnectorError('AsyncExportTransport does not support write-back', 'NOT_SUPPORTED', false);
}
```

### § 3.2 Poll loop behaviour

The internal `_pollUntilDone` method implements:

- **Backoff**: starts at 1 s, doubles each interval, caps at `pollIntervalCap` (default 30 s).
- **Timeout**: throws `ConnectorError` (retryable: `true`) after `jobTimeoutMs` (default 10 min).
- **Circuit breaker**: a `'failed'` status is treated as a non-retryable error; the engine's
  existing circuit breaker handles retryable errors.

```typescript
interface AsyncExportOptions {
  pollIntervalMs?: number;     // initial poll interval, default 1_000
  pollIntervalCap?: number;    // max poll interval ms, default 30_000
  jobTimeoutMs?: number;       // hard timeout, default 600_000 (10 min)
}
```

### § 3.3 The parameterisation problem

Static file transports (SFTP, HTTP) describe *where* to find data. Async export transports
describe *what* to request. The POST body often includes:

- Entity type / resource name (e.g. `"contacts"`, `"ledger"`)
- Date range or watermark cursor (e.g. `since` timestamp)
- Output format (`"csv"`, `"xlsx"`)
- Filters or field lists

This means a single `transport.asyncExport()` instance corresponds to one entity type, not
one API host. The async export lifecycle must be specified per entity.

### § 3.4 `createFileEntity` — the primary composition API

In practice, connectors that use async export for one entity almost always serve other
entities via normal paginated REST. Forcing those REST entities into `createFileConnector`
calls just to merge them is needlessly awkward.

`createFileEntity(opts)` solves this: same options as `createFileConnector`, but returns
an `EntityDefinition` instead of a full `Connector`. The connector author drops it directly
into `getEntities()` alongside REST-backed entities:

```typescript
// Spec: specs/connector-helpers.md § "Async export transport"
import { createFileEntity, transport, format } from '@opensync/sdk/helpers/file';

const contactsEntity = createFileEntity({
  name:    'contact',
  transport: transport.asyncExport({
    async submit(since) {
      const res = await fetch('https://api.example.com/exports', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ entity: 'contacts', since, format: 'csv' }),
      });
      const { jobId } = await res.json() as { jobId: string };
      return { id: jobId };
    },
    async poll({ id }) {
      const res = await fetch(`https://api.example.com/exports/${id}`);
      const { status } = await res.json() as { status: string };
      return { status: status as JobStatus['status'] };
    },
    async *download({ id }) {
      const res = await fetch(`https://api.example.com/exports/${id}/result`);
      const { url } = await res.json() as { url: string };
      yield { name: `${id}.csv`, path: id, url };
    },
  }),
  format:  format.csv({ delimiter: ',' }),
  mode:    'row-per-entity',
  idField: 'contact_id',
});

export default {
  metadata: { name: 'example', version: '1.0.0', auth: { type: 'none' } },

  getEntities(ctx): EntityDefinition[] {
    return [
      contactsEntity,             // async export → CSV → rows; engine can't tell the difference
      companiesRestEntity(ctx),   // normal paginated GET
      dealsRestEntity(ctx),       // normal paginated GET
    ];
  },
} satisfies Connector;
```

The engine calls `entity.read(ctx, since)` on every entity uniformly — it has no knowledge
of what happens inside. No engine changes are required.

`createFileConnector` remains as a convenience shorthand for a connector that is
*exclusively* file-based (e.g. a dedicated SFTP connector with no REST entities). It is
implemented as `createFileEntity` + a minimal `Connector` wrapper.

---

## 4. Watermark Strategy

The watermark for an async export transport is the cursor *sent in the last export job POST*,
not derived from the result files (which may arrive later and have no meaningful mtime).

Lifecycle:

1. Engine calls `transport.list(since)` with the stored `since` watermark (or `undefined`
   on first run).
2. `list()` passes `since` to `submit()` as the export cursor.
3. After `download()` yields all `FileRef` objects, `createFileConnector` calls
   `transport.watermark(refs)` to get the new watermark.
4. `watermark()` typically returns the ISO timestamp of `submit()` call (recorded at
   submit time), not any field from the result — because the result may lag by minutes.

```typescript
// Inside transport.asyncExport() factory:
let lastSubmitTime: string | undefined;

async submit(since) {
  lastSubmitTime = new Date().toISOString();
  // ... make the POST ...
},
watermark(_refs) {
  return lastSubmitTime!;
}
```

This ensures the next cycle requests only records newer than the *start* of the previous
job, not the *end* — preventing gaps when records are created during a long-running job.

---

## 5. First-Party Factory

`transport.asyncExport(opts)` is a helper in `@opensync/sdk/helpers/file` that accepts the
callbacks from §3.3 plus the tuning options from §3.2, constructs an `AsyncExportTransport`
concrete class, and returns it. The adapter pattern allows the callbacks to close over
auth state without exposing it in the interface.

```typescript
function asyncExport(opts: {
  submit:   (since: string | undefined) => Promise<JobRef>;
  poll:     (job: JobRef) => Promise<JobStatus>;
  download: (job: JobRef) => AsyncIterable<FileRef>;
  watermark?: (refs: FileRef[]) => string;
} & AsyncExportOptions): AsyncExportTransport
```

If `watermark` is omitted, the default uses the submit timestamp as described in §4.

---

## 6. Concrete Examples

### Salesforce Bulk API 2.0

```typescript
transport.asyncExport({
  async submit(since) {
    const res = await ctx.http('https://instance.salesforce.com/services/data/v59.0/jobs/query', {
      method: 'POST',
      body: JSON.stringify({
        operation: 'query',
        query: `SELECT Id, Name, Email FROM Contact WHERE LastModifiedDate >= ${since ?? '1970-01-01T00:00:00Z'}`,
      }),
    });
    const { id } = await res.json() as { id: string };
    return { id };
  },
  async poll({ id }) {
    const res = await ctx.http(`https://instance.salesforce.com/services/data/v59.0/jobs/query/${id}`);
    const body = await res.json() as { state: string; errorMessage?: string };
    const map: Record<string, JobStatus['status']> = {
      UploadComplete: 'running', InProgress: 'running',
      JobComplete: 'complete', Failed: 'failed', Aborted: 'failed',
    };
    return { status: map[body.state] ?? 'pending', error: body.errorMessage };
  },
  async *download({ id }) {
    // Salesforce may produce multiple result chunks
    let locator: string | undefined;
    do {
      const url = `https://instance.salesforce.com/services/data/v59.0/jobs/query/${id}/results`
        + (locator ? `?locator=${locator}` : '');
      const res = await ctx.http(url);
      locator = res.headers.get('Sforce-Locator') ?? undefined;
      const chunk = String(locator ?? id);
      yield { name: `${id}-${chunk}.csv`, path: chunk, url };
    } while (locator && locator !== 'null');
  },
})
```

### HubSpot CRM Export

```typescript
transport.asyncExport({
  async submit(since) {
    const res = await ctx.http('https://api.hubapi.com/crm/v3/exports', {
      method: 'POST',
      body: JSON.stringify({
        exportType: 'LIST', objectType: 'contacts', format: 'CSV',
        exportName: `contacts-since-${since ?? 'all'}`,
      }),
    });
    const { id } = await res.json() as { id: string };
    return { id };
  },
  async poll({ id }) {
    const res = await ctx.http(`https://api.hubapi.com/crm/v3/exports/${id}`);
    const body = await res.json() as { status: string; result?: string };
    return { status: body.status === 'COMPLETE' ? 'complete' : body.status === 'ERROR' ? 'failed' : 'running' };
  },
  async *download({ id }) {
    const res = await ctx.http(`https://api.hubapi.com/crm/v3/exports/${id}`);
    const { result } = await res.json() as { result: string };
    yield { name: `contacts-${id}.csv`, path: id, url: result };
  },
})
```

---

## 7. Scope

| Item | Status |
|------|--------|
| `AsyncExportTransport` interface | Primary target |
| `transport.asyncExport()` factory | Primary target |
| `createFileEntity()` factory | Primary target |
| Poll loop with backoff + timeout | Primary target |
| `createFileConnector` as shorthand wrapper | Secondary — trivial once `createFileEntity` exists |
| `ctx.http` inside transport callbacks | Out of scope — transport callbacks currently receive no `ctx`; see Open Question §8.1 |
| Write-back (PUT/POST result files) | Out of scope — async export sources are read-only in practice |

---

## 8. Open Questions

### § 8.1 Auth context inside transport callbacks

The callbacks (`submit`, `poll`, `download`) are plain functions. They currently have no
access to `ConnectorContext`. For HTTP calls with managed auth (OAuth, session tokens, etc.),
the connector author must close over their own token refresh logic.

Two options:

a. Pass a lightweight `ctx`-like object to each callback (just `http()`, no state access).
   This is the cleaner long-term interface but requires a design change in
   `createFileConnector`.
b. Connector author manages auth externally (e.g. a module-level token store). This is
   the pragmatic MVP approach — it's what multi-step connectors already do (see
   `connectors/tripletex/src/index.ts` session token pattern).

Recommended for MVP: option b. Option a can be added as a non-breaking addition later
(the `ctx` param would be optional).

### § 8.2 Per-entity `since` vs shared watermark

When using `mergeConnectors` with multiple entities, each entity has its own watermark
stored by `createFileConnector`. This is correct — entity A and B may export at different
cadences. The watermarks are independent.

### § 8.3 Resumability of multi-chunk downloads

Salesforce Bulk API returns a `Sforce-Locator` header for chunked results. If the connector
crashes mid-download, the job is gone and a new export must be submitted. The current
design accepts this: jobs are cheap, and the engine's circuit breaker prevents tight
retry storms.

A future enhancement could persist `JobRef` in `ctx.state` between invocations and resume
a still-active job. Deferred post-MVP.

---

## 9. Implementation Phases

### Phase 1 — Interface + base class (S)

- Add `AsyncExportTransport`, `JobRef`, `JobStatus`, `AsyncExportOptions` types to
  `packages/sdk/src/helpers/file/`
- Implement `AsyncExportTransportBase` abstract class with `list()`, `fetch()`, `put()`,
  and `_pollUntilDone()` (backoff + timeout)
- Unit tests: poll loop terminates on `'complete'`; throws on `'failed'`; throws on timeout

### Phase 2 — Factories + integration (S)

- Implement `transport.asyncExport(opts)` factory
- Implement `createFileEntity(opts)` — returns `EntityDefinition`; accepts
  `AsyncExportTransport | FileTransport`
- Reimplement `createFileConnector` as a thin wrapper around `createFileEntity` + a minimal
  `Connector` shell (no duplication of logic)
- Unit tests: `createFileEntity` with `asyncExport` + `format.csv` + `mode: 'row-per-entity'`;
  mock `submit/poll/download`; verify correct `FileRef` → rows pipeline;
  verify the result drops into a `getEntities()` array alongside a hand-written entity

### Phase 3 — Spec and examples (XS)

- Update `specs/connector-helpers.md` with interface, factory, and poll contract
- Update `specs/connector-sdk.md` with cross-reference
- Add Salesforce and HubSpot usage examples to `docs/connectors/advanced.md`

---

## 10. Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-helpers.md` | New §N "Async export transport" | `AsyncExportTransport` interface; `JobRef`; `JobStatus`; `AsyncExportOptions`; `transport.asyncExport()` factory; `createFileEntity()` factory signature and return type; `createFileConnector` as shorthand; poll loop contract (backoff, timeout, circuit-breaker integration); watermark strategy |
| `specs/connector-sdk.md` | §N "File-based connectors" (from PLAN_FILE_INGEST) | Add `createFileEntity` as the primary mixed-connector API; note `createFileConnector` is standalone-only shorthand; cross-reference to `connector-helpers.md` |
