# PLAN: File-Based Ingest — CSV and XML SDK Helpers

**Status:** draft  
**Date:** 2026-04-06  
**Effort:** S  
**Domain:** connectors/  
**Spec changes planned:**  
- `specs/connector-helpers.md` — add §N "File helpers": `helpers.csv` and `helpers.xml` API
  reference; watermark convention for file-based connectors (`mtime:sha256`).

---

## 1. Motivation

Several real-world systems have no REST API and can only exchange data as flat files:

- Legacy ERP and payroll exports (CSV, fixed-width, XML)
- Bank statement feeds (ISO 20022 XML, CSV)
- Norwegian accounting "SIE" export files (custom text format)
- EDI / EDIFACT payloads delivered via SFTP
- E-invoice archives (EHF / UBL XML)

Connector authors writing an SFTP or HTTP file connector need to parse these formats into
`Record<string, unknown>[]` rows. That boilerplate — header parsing, delimiter handling,
XML element extraction, encoding — is the same every time. `helpers.csv` and `helpers.xml`
eliminate it.

A broader composable pipeline framework (`createFileConnector`, `FileTransport`, `FileCodec`,
etc.) was considered and dropped: it overlaps significantly with the declarative connectors
direction and is better deferred until that design is settled. Connector authors write their
own `ssh2` / `fetch` transport code; the helpers only handle parsing.

---

## 2. Design Principles

1. **Rows are records.** Each CSV row or XML element is one `ReadRecord`. The unit of sync
   is the business entity the row represents — invoice, transaction, employee. OpenSync adds
   value at the row level where field mapping, diffing, and conflict resolution apply.
2. **Helpers parse; connectors transport.** `helpers.csv` and `helpers.xml` turn `Buffer`
   into `Record<string, unknown>[]`. How that buffer was fetched (SFTP, HTTP, S3) is the
   connector's concern — no abstraction is provided here.
3. **Watermark = `mtime:sha256`.** Files have no API cursor. A connector stores the file's
   last-modified time and a SHA-256 of its content. If both are unchanged, the read emits an
   empty batch. When content changes, the full file is re-parsed and every row is re-emitted;
   the engine's shadow state handles field-level diffing.

---

## 3. SDK Helpers

Two new helpers added to `packages/sdk/src/helpers/`:

### 3.1 `helpers.csv`

```typescript
helpers.csv.parse(input: string | Buffer, options?: CsvOptions): Record<string, unknown>[];
helpers.csv.stringify(records: Record<string, unknown>[], options?: CsvOptions): string;

interface CsvOptions {
  delimiter?:      string;          // default ','
  quote?:          string;          // default '"'
  header?:         boolean;         // default true — first row = field names
  fieldNames?:     string[];        // override header; required when header: false
  encoding?:       BufferEncoding;  // default 'utf-8'
  skipEmptyLines?: boolean;         // default true
  trimValues?:     boolean;         // default false
}
```

Thin wrapper over a zero-dependency CSV parser (e.g. `csv-parse`). No business logic.

### 3.2 `helpers.xml`

```typescript
helpers.xml.parse(input: string | Buffer, options?: XmlOptions): Record<string, unknown>[];
helpers.xml.stringify(records: Record<string, unknown>[], options?: XmlOptions): string;

interface XmlOptions {
  recordElement:   string;    // element name that identifies one record, e.g. 'Invoice'
  arrayElements?:  string[];  // elements that should always be arrays even when single child
  attributePrefix?: string;   // prefix for attribute keys, default '@'
  textKey?:        string;    // key for text node content, default '#text'
  encoding?:       string;    // default 'utf-8'
}
```

Thin wrapper over a minimal SAX/DOM parser. No business logic.

### 3.3 Usage pattern in a connector

```typescript
import { helpers } from '@opensync/sdk';
import { Client } from 'ssh2';

// inside read():
const buf = await fetchViaSftp(config);
const rows = helpers.csv.parse(buf, { delimiter: ';' });
return rows.map(row => ({ id: String(row[config.idField]), fields: row }));
```

Row identity: use `config.idField` if provided; otherwise fall back to a SHA-256 of the
serialised row (stable for append-only files; new ID on content change = delete + insert,
acceptable for export files).

---

## 4. Scope

| Format | Status |
|--------|--------|
| CSV | `helpers.csv` — this plan |
| XML | `helpers.xml` — this plan |
| JSON / NDJSON | Built into standard `JSON.parse`; no helper needed |
| Fixed-width / SIE / EDI | Caller supplies a custom parse function; no helper planned |

Transport (SFTP, HTTP, S3) and a composable pipeline framework are **out of scope** — deferred
until the declarative connectors direction is settled.

---

## 5. Implementation

- Add `packages/sdk/src/helpers/csv.ts` — `parse` / `stringify`, `CsvOptions`
- Add `packages/sdk/src/helpers/xml.ts` — `parse` / `stringify`, `XmlOptions`
- Export both from `packages/sdk/src/helpers/index.ts` as `helpers.csv` and `helpers.xml`
- Unit tests:
  - CSV: delimiter variants, quoted fields, header override, `trimValues`, empty file, malformed input
  - XML: single record, multiple records, attribute prefix, `arrayElements`, encoding, malformed input
  - Both: `stringify(parse(x)) ≈ x` round-trip
- Update `specs/connector-helpers.md` with `helpers.csv` and `helpers.xml` API reference and
  the `mtime:sha256` watermark convention

---

## 6. Open Questions

1. **CSV parser dependency**: `csv-parse` is battle-tested but adds a dependency. Evaluate
   whether Bun's built-in capabilities or a smaller zero-dependency alternative (e.g.
   hand-rolled state machine for the simple case) is preferable.
2. **Large files**: The helpers return full arrays. A streaming variant
   (`helpers.csv.stream()` → `AsyncIterable<Record>`) would be needed for files > a few MB.
   Defer; the interface can be extended to `parse(buf | ReadableStream, opts)` later without
   a breaking change if the streaming overload is added.
3. **`helpers.xml` stringify for enveloped formats**: The `stringify` direction requires an
   XML envelope template for formats like ISO 20022 or UBL. Consider accepting an optional
   `envelope` string with a `{{records}}` placeholder, or dropping `stringify` from §3.2 and
   noting it as out of scope for the initial version.

---

## 7. Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-helpers.md` | New §N "File helpers" | `helpers.csv` and `helpers.xml` API reference; `mtime:sha256` watermark convention for file-based connectors |
