# PLAN: File-Based Ingest — CSV, XML, SFTP

**Status:** draft  
**Date:** 2026-04-06  
**Effort:** L  
**Domain:** connectors/  
**Spec changes planned:**  
- `specs/connector-sdk.md` — add §N "File-based connectors": `createFileConnector` pattern,
  non-HTTP auth convention, `file-per-entity` vs `row-per-entity` modes, watermark strategy.  
- `specs/connector-helpers.md` — add §N "File pipeline": `FileTransport` / `FileCodec` /
  `FileFormat` interfaces; `createFileConnector` factory; first-party table; `helpers.csv` and
  `helpers.xml` API reference.

---

## 1. Motivation

Several real-world systems have no REST API and can only exchange data as flat files:

- Legacy ERP and payroll exports (CSV, fixed-width, XML)
- Bank statement feeds (ISO 20022 XML, CSV)
- Norwegian accounting "SIE" export files (custom text format)
- EDI / EDIFACT payloads delivered via SFTP
- E-invoice archives (EHF / UBL XML)

The existing `dev/connectors/jsonfiles` fixture demonstrates local-file reads but uses
`node:fs` directly and is explicitly marked as a dev fixture only. A production file-ingest
connector must be network-transported to satisfy the connector isolation rule (connectors
connect to network services only).

---

## 2. Design Principles

1. **Transport is separate from format.** An SFTP connector exposes raw file bytes; a CSV or
   XML parser turns those bytes into `ReadRecord` streams. The two can be composed, replaced
   independently, or reused across connectors.
2. **Files are records, rows are not.** The unit of sync is the file (identity = filename or
   path). A connector that treats each CSV row as a `ReadRecord` is doing field mapping inside
   the connector — that belongs in the engine's channel config. However, a multi-row file needs
   an intra-file identity strategy (see §4.3).
3. **Write-back is optional.** Many file-source systems are read-only (exports). Write-back
   means producing a new file at a known location — useful for systems that poll a drop-zone.
4. **Watermark = file modification time or content hash.** Files have no API cursor. The
   connector tracks either the last-modified timestamp of the remote path or a SHA-256 of the
   file contents to detect changes. On SFTP, `MLST` or `STAT` provides the mtime reliably.

---

## 3. Composable Pipeline Architecture

The number of valid combinations grows multiplicatively:

```
transports  ×  codecs [stackable, optional]  ×  formats
(SFTP,          (gzip, charset,                 (CSV, XML,
 HTTP/S, S3, …)  zip member, …)                  JSON, SIE, custom, …)
```

Without a compositional model each new transport or format requires touching every other
module. With it, each layer is written once and wired together at connector-author time.

### 3.1  Layer interfaces

```typescript
// ── Transport ─────────────────────────────────────────────────────────────────
// Lists and transfers files at a remote location.
// Has no knowledge of formats or codecs.
interface FileTransport {
  list(since?: string): AsyncIterable<FileRef>;
  fetch(ref: FileRef): Promise<Buffer>;
  put(path: string, content: Buffer): Promise<void>; // write-back; may throw if unsupported
  watermark(refs: FileRef[]): string;                // derive watermark from files seen this cycle
}

interface FileRef {
  name:   string;   // filename only (no directory)
  path:   string;   // full remote path
  mtime?: Date;
  etag?:  string;
  size?:  number;
}

// ── Codec ─────────────────────────────────────────────────────────────────────
// Pure Buffer → Buffer transformation. Stateless and stackable.
// Applied in declaration order on decode (read); reversed on encode (write-back).
// Multi-member archives (one zip → many files) are NOT a codec concern —
// the transport yields one FileRef per member if archive expansion is needed.
interface FileCodec {
  name:   string;                                         // e.g. 'gzip', 'charset:windows-1252'
  decode(buf: Buffer, ref: FileRef): Promise<Buffer>;
  encode(buf: Buffer, ref: FileRef): Promise<Buffer>;
}

// ── Format ────────────────────────────────────────────────────────────────────
// Maps bytes ↔ records.
// Has no knowledge of how bytes were retrieved or what encoding they carry.
interface FileFormat {
  name: string;                                           // e.g. 'csv', 'xml'
  parse(buf: Buffer, ref: FileRef): Record<string, unknown>[];
  stringify(records: Record<string, unknown>[], hint?: Partial<FileRef>): Buffer;
}
```

### 3.2  `createFileConnector` factory

A generic factory in `@opensync/sdk/helpers/file` composes the three layers into a standard
`Connector`, handling watermarking, entity registration, `row-per-entity` / `file-per-entity`
mode, ID assignment, and write-back transparently:

```typescript
import { createFileConnector, transport, codec, format } from '@opensync/sdk/helpers/file';

export default createFileConnector({
  transport: transport.sftp({ host, username, privateKey, inbound: '/drop/*.csv' }),
  codecs:    [codec.charset('windows-1252')],  // zero or more; applied in order
  format:    format.csv({ delimiter: ';' }),
  mode:      'row-per-entity',   // 'file-per-entity' | 'row-per-entity'
  idField:   'invoice_number',   // for row-per-entity; falls back to content hash
  outbound:  '/accounting/drop', // enables write-back via transport.put()
});
```

The result is a fully compliant `Connector`. The engine sees nothing unusual.

### 3.3  First-party implementations

**Transports**

| Factory | Watermark basis | Notes |
|---------|----------------|-------|
| `transport.sftp(opts)` | `mtime` per file | `ssh2`-backed; archive-after-read option (§5.1) |
| `transport.http(opts)` | `ETag` / `Last-Modified` | uses global `fetch()`; no extra deps (§5.6) |
| `transport.s3(opts)` | `LastModified` via `ListObjectsV2` | post-MVP |

**Codecs**

| Factory | Decode | Encode |
|---------|--------|--------|
| `codec.gzip()` | inflate `.gz` | deflate |
| `codec.zip(member?)` | unpack named member (default: first) | repack |
| `codec.charset(from, to?)` | transcode to UTF-8 | transcode from UTF-8 |

`to` in `charset` defaults to `'utf-8'`. Common `from` values: `'windows-1252'`,
`'iso-8859-1'`, `'latin1'`.

**Formats**

| Factory | Notes |
|---------|-------|
| `format.csv(opts)` | wraps `helpers.csv`; see §5.5 |
| `format.xml(opts)` | wraps `helpers.xml`; see §5.5 |
| `format.json()` | JSON array or NDJSON (newline-delimited) |
| `format.custom(fn)` | `(buf, ref) => Record[]`; escape hatch for SIE, EDIFACT, fixed-width |

### 3.4  Composition examples

```typescript
// Norwegian SIE accounting file — custom parser
createFileConnector({
  transport: transport.sftp({ host, inbound: '/exports/*.se' }),
  format:    format.custom(parseSieFile),
  mode:      'row-per-entity',
  idField:   'ver_nr',
});

// Gzip-compressed ISO 20022 camt.053 XML bank statement
createFileConnector({
  transport: transport.sftp({ host, inbound: '/bank/*.xml.gz' }),
  codecs:    [codec.gzip()],
  format:    format.xml({ recordElement: 'Ntry' }),
  mode:      'row-per-entity',
  idField:   'NtryRef',
});

// Windows-1252 CSV from legacy POS, polled via HTTP
createFileConnector({
  transport: transport.http({ url: 'https://pos.internal/export/sales.csv' }),
  codecs:    [codec.charset('windows-1252')],
  format:    format.csv({ delimiter: ';' }),
  mode:      'row-per-entity',
  idField:   'transaction_id',
});

// Write CSV back to SFTP drop-zone for nightly accounting pickup
createFileConnector({
  transport: transport.sftp({ host, inbound: '/crm/*.csv', outbound: '/accounting/drop' }),
  format:    format.csv(),
  mode:      'row-per-entity',
  idField:   'customer_id',
});
```

### 3.5  Third-party extension

The interfaces in §3.1 are plain TypeScript. A package targeting a proprietary protocol ships
its own `transport.myVendor()` factory and composes it with the standard helpers. No plugin
registration needed — duck typing is sufficient.

```typescript
import { createFileConnector, codec } from '@opensync/sdk/helpers/file';
import { edifact } from '@myorg/opensync-edifact';
import { sftpVendorX } from '@myorg/opensync-sftp-vendorx';

export default createFileConnector({
  transport: sftpVendorX({ host, certificate }),
  codecs:    [codec.charset('iso-8859-1')],
  format:    edifact({ message: 'INVOIC' }),
  mode:      'row-per-entity',
  idField:   'BGM.1',
});
```

---

## 4. Scope

This plan covers:

| Transport | Status |
|-----------|--------|
| SFTP | Primary target — new `connectors/sftp/` package |
| HTTP/S (poll a URL for a file) | Secondary — can reuse global `fetch()`, low effort |
| FTP (legacy) | Out of scope; SFTP supersedes it for new work |
| Local filesystem | Dev fixture only (`dev/connectors/jsonfiles`); not a production connector |

| Format | Status |
|--------|--------|
| CSV | SDK helper + SFTP connector integration |
| XML | SDK helper + SFTP connector integration |
| JSON (NDJSON) | Already handled by jsonfiles; wire into SFTP connector as a third format |
| Fixed-width / SIE / EDI | Future; caller provides a custom parser callback |

---

## 5. Detailed Design

### 5.1 SFTP Connector (`connectors/sftp/`)

```typescript
// config
{
  host:       string;           // required
  port:       number;           // default 22
  username:   string;           // required
  // auth: one of password, privateKey, or agent
  password?:  string;           // secret
  privateKey?: string;          // secret (PEM text or path within container)
  paths: {
    inbound:  string;           // remote directory or glob to poll, e.g. '/drop/invoices/*.csv'
    outbound?: string;          // remote directory to write produced files into
    archive?: string;           // if set, move processed files here after reading (prevents replay)
  };
  format:   'csv' | 'xml' | 'json';
  // format-specific options passed through to the parser
  csv?: CsvOptions;
  xml?: XmlOptions;
  // polling
  pollIntervalSeconds?: number; // default: driven by engine schedule
}
```

**`metadata.auth`**: `{ type: 'none' }` — credentials are declared in `configSchema` as
`secret: true` fields (password, privateKey). SFTP does not use HTTP auth; `prepareRequest`
is irrelevant. This is an established pattern for non-HTTP connectors.

Internally the SFTP connector is implemented as `transport.sftp()` wired into
`createFileConnector()` (§3.2). The `format` config field selects the `FileFormat` factory
at startup; codecs are derived from file extension heuristics or explicit `codecs` config.

**`getEntities()`** returns one `EntityDefinition` per configured path pattern. If
`paths.inbound` is `'/drop/*.csv'`, the connector resolves it at `onEnable` time and
registers one entity per matching file. If the glob pattern means "any future file that
appears here", the entity is named after the directory and each file becomes a record.

Two entity models are supported; the connector exposes both and the user picks via config:

| Mode | Entity = | Record = | Identity |
|------|----------|----------|----------|
| `file-per-entity` (default) | one entity per logical type (e.g. "invoice") | one record per file | filename (normalised) |
| `row-per-entity` | one entity per logical type | one record per CSV row / XML element | see §5.3 |

### 5.2 Watermark Strategy

SFTP directories provide `mtime` per file via `MLST`. The connector stores the latest observed
mtime as its `since` watermark. On the next poll it fetches only files whose mtime is newer.

For `row-per-entity` mode, where the whole file is re-read and row identity matters, the
connector stores a SHA-256 digest of the file as the watermark. When the digest is unchanged
the read emits an empty `ReadBatch`; when changed, the full file is re-parsed and each row is
compared against the `since` value encoded as `<digest>:<row_count>` so the engine can detect
additions vs replacements.

Simpler alternative (preferred for MVP): store `<mtime>:<filename>` for `file-per-entity`
mode and `<mtime>:<sha256>` for `row-per-entity`. No intra-file diffing — rely on the engine's
shadow state to detect field-level changes.

### 5.3 Intra-File Row Identity (`row-per-entity` mode)

The CSV or XML record must carry a field the connector can use as `ReadRecord.id`. Resolution
order:

1. `idField` config value (e.g. `"invoice_number"` or `"@id"` for XML attribute).
2. If absent, generate a deterministic ID from a hash of the row's content. This makes every
   distinct row globally stable but means a row with changed content gets a new ID (treated as
   a delete + insert pair by the engine's shadow diff). **This is acceptable for append-only
   export files.** For update-capable files it requires an explicit `idField`.

### 5.4 Write-Back (outbound files)

When `paths.outbound` is configured, `insert()` and `update()` serialise the incoming records
back into the configured format and upload the resulting file to `paths.outbound/<entity>/<timestamp>.<ext>`.

This covers use cases like "produce a CSV that the accounting system picks up from its
watch folder overnight".

For XML write-back, the connector requires a `templatePath` config or an `xmlTemplate`
string that defines the envelope structure; rows are injected into the template.

### 5.5 Format Parsers (SDK Helpers)

Two new helpers in `@opensync/sdk/helpers`:

#### `helpers.csv`

```typescript
helpers.csv.parse(input: string | Buffer, options?: CsvOptions): Record<string, unknown>[];
helpers.csv.stringify(records: Record<string, unknown>[], options?: CsvOptions): string;

interface CsvOptions {
  delimiter?: string;       // default ','
  quote?: string;           // default '"'
  header?: boolean;         // default true — first row = field names
  fieldNames?: string[];    // override header; required when header: false
  encoding?: BufferEncoding; // default 'utf-8'
  skipEmptyLines?: boolean; // default true
  trimValues?: boolean;     // default false
}
```

#### `helpers.xml`

```typescript
helpers.xml.parse(input: string | Buffer, options?: XmlOptions): Record<string, unknown>[];
helpers.xml.stringify(records: Record<string, unknown>[], options?: XmlOptions): string;

interface XmlOptions {
  recordElement: string;     // XPath or element name that identifies one record, e.g. 'Invoice'
  arrayElements?: string[];  // elements that should always be arrays even when single child
  attributePrefix?: string;  // prefix for attribute keys, default '@'
  textKey?: string;          // key for text node content, default '#text'
  encoding?: string;         // default 'utf-8'
}
```

Both helpers are thin wrappers — CSV over a well-maintained zero-dependency parser (e.g.
`csv-parse` or a Bun-native equivalent); XML over a minimal streaming SAX/DOM parser. No
business logic.

### 5.6 HTTP/S File Connector

Implemented as `transport.http()` composed with any format via `createFileConnector`. Uses
global `fetch()`; detects changes via `ETag` / `Last-Modified` response headers, which become
the watermark. No extra dependencies. Delivered as a second distributable connector
(`connectors/httpfile/`) that re-exports `createFileConnector` pre-wired with
`transport.http()`. Scope: post-MVP.

---

## 6. Implementation Phases

### Phase 1 — Pipeline interfaces + SDK helpers (M)

- Define `FileTransport`, `FileCodec`, `FileFormat` interfaces in `packages/sdk/src/helpers/file/`
- Implement `createFileConnector` factory
- Implement `transport.sftp()` stub (list + fetch, no write-back yet)
- Implement `codec.gzip()`, `codec.zip()`, `codec.charset()`
- Implement `format.csv()` (wraps `helpers.csv`), `format.xml()` (wraps `helpers.xml`),
  `format.json()`
- Add `helpers.csv.parse` / `helpers.csv.stringify` and `helpers.xml.parse` / `helpers.xml.stringify`
- Unit tests: each factory in isolation; compose two codecs and verify order reversal on encode;
  delimiter variants, charset round-trips, empty files, malformed input
- Update `specs/connector-helpers.md` with factory interfaces and first-party implementation table

### Phase 2 — SFTP connector scaffold (M)

- Create `connectors/sftp/` package with `package.json`, `tsconfig.json`
- Wire `transport.sftp()` + `createFileConnector` into a user-configurable connector
  (`format` as a config field that selects `format.csv()` / `format.xml()` / `format.json()` at
  startup; `codecs` as optional config)
- `file-per-entity` mode, `mtime`-based watermark; archive-after-read option
- Bun compatibility check for `ssh2` (see §7 Q1); decide on `ssh2` vs `Bun.spawn` shim
- Unit tests with a mock SFTP server (same pattern as `dev/servers/mock-crm`)
- Integration test: CSV on SFTP → engine → jsonfiles target

### Phase 3 — Row-per-entity mode (S)

- Extend `createFileConnector` with `mode: 'row-per-entity'`
- Content-hash watermark (`mtime:sha256`)
- `idField` resolution + deterministic hash-based fallback ID
- Tests: added rows detected; changed row without `idField` → delete + insert pair

### Phase 4 — Write-back (M)

- Complete `transport.sftp().put()` and `codec` encode paths
- `createFileConnector` routes `insert()` / `update()` through `format.stringify()`
  → codec chain (reversed) → `transport.put()`
- Timestamped filename generation for outbound files
- Tests: round-trip CSV and XML write and read back

### Phase 5 — HTTP/S file connector (S, post-MVP)

- `connectors/httpfile/` — `transport.http()` + `createFileConnector`; `ETag` / `Last-Modified`
  watermark; no extra deps

---

## 7. Open Questions

1. **Bun compatibility of `ssh2`**: `ssh2` uses Node crypto modules; verify it works under Bun
   without polyfills before committing to it. Alternative: shell out to `sftp` CLI via
   `Bun.spawn` (less clean but zero-dependency).
2. **Archive vs leave-in-place**: Moving processed files prevents replay but requires write
   permission to a second path. Some customers can only read, not rename/move. Both modes must
   be supported; "leave in place + mtime watermark" is the safe default.
3. **Large files**: A 50 MB CSV should stream, not load fully into memory. The helpers as
   drafted return arrays; a streaming variant (`helpers.csv.stream()` returning
   `AsyncIterable<Record>`) would be needed for large-file support. Defer to post-MVP. The
   `FileFormat.parse()` interface should be extended to `parse(buf | ReadableStream, ref)`
   before that to avoid a breaking change later.
4. **SIE / EDIFACT / fixed-width**: Covered by `format.custom(fn)` (§3.3) — callers supply
   a `(buf, ref) => Record[]` function without forking any connector. What is not yet defined
   is a reusable community-contributed format package convention (naming, exports). Consider a
   `@opensync/format-*` namespace.
5. **Multi-member zip archives**: The current `codec.zip(member?)` only unpacks a single
   member. If a zip contains multiple CSVs (e.g. one per month), the right model is for the
   transport to yield one `FileRef` per member after expansion, not for the codec to split.
   Needs a `FileTransport.expand?: (ref: FileRef) => AsyncIterable<FileRef>` extension point,
   or a wrapper transport factory `transport.zipExpand(inner)`.
6. **Delete signal from file disappearance**: If a file is removed from the SFTP path, should
   the records it contained become soft-deleted in the engine? Requires cross-referencing the
   previously-seen file list against the current directory listing. Depends on
   `plans/engine/PLAN_DELETE_PROPAGATION.md`. Defer until that plan is active.

---

## 8. Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-sdk.md` | New §N "File-based connectors" | Document `createFileConnector` pattern, non-HTTP auth convention, `file-per-entity` vs `row-per-entity` modes, watermark strategy (mtime / content hash) |
| `specs/connector-helpers.md` | New §N "File pipeline" | `FileTransport`, `FileCodec`, `FileFormat` interfaces; `createFileConnector` factory signature; first-party transport/codec/format table; `helpers.csv` and `helpers.xml` API reference |
