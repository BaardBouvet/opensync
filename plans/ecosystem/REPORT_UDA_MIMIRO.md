# REPORT: Mimiro Universal Data API (UDA) — Ecosystem Analysis

**Status:** draft  
**Date:** 2026-04-06  

Reference: https://open.mimiro.io/specifications/uda/latest.html (v0.7.0, Oct 2025)

---

## 1. What Is UDA?

The Universal Data API (UDA) is an open specification published by
[Mimiro](https://mimiro.io/) (Oslo, Norway). It defines a semantic graph data model, its
JSON serialisation, and a minimal REST API for publishing, incrementally synchronising,
and writing back to datasets. The spec is authored by Graham Moore (formerly of OpenLink
Software, one of the early Linked Data ecosystem contributors).

UDA is the wire protocol powering **Mimiro's data platform** — a data hub product used
primarily in regulated industries in Norway. It is a living standard (current version 0.7.0).
The spec is short (nine sections), self-contained, and explicitly designed for
developer consumption.

UDA shares design lineage with other Linked-Data-era streaming protocols (SDShare, RDF Net
API) and is the most recent and semantically complete member of that family.

---

## 2. Data Model

### 2.1 Entity

```
entity := { id, deleted, recorded, props, refs }
```

| Field | Type | Notes |
|-------|------|-------|
| `id` | URI (`xsd:uri`) | Global identity; always a URI |
| `deleted` | boolean | Soft-delete marker; in-band on the entity object |
| `recorded` | uint64 | Nanosecond-precision epoch; source-assigned version/ordering stamp |
| `props` | `{URI: value}` | Literal property values; string, int, double, datetime, or nested entity |
| `refs` | `{URI: URI \| URI[]}` | Typed references to other entities by URI |

The explicit separation of `props` (literals) from `refs` (links) is the most important
structural choice. It mirrors OpenSync's own field/association split almost exactly.

### 2.2 Context / Namespace Compression

An `id: "@context"` object may precede the entity array. It defines CURIE-style prefix
expansions so that `"people:bob"` expands to `"http://data.example.org/people/bob"`. This
keeps the wire format readable without embedding full URIs everywhere.

### 2.3 JSON-LD Binding

Via `Accept: application/ld+json` the same endpoints emit valid JSON-LD. The mapping is
mechanical: `id` → `@id`, `props` → literal statements, `refs` → `{"@id": "..."}` objects.
The built-in fields `recorded` and `deleted` map to a `core:` namespace
(`http://data.mimiro.io/core/uda/`). Continuation tokens map to `rdf:type core:continuation`.

---

## 3. API

```
GET  /datasets                                     dataset discovery
GET  /datasets/{name}                              dataset metadata (since-capable?, lastModified)
GET  /datasets/{name}/changes?since={token}        incremental change stream
GET  /datasets/{name}/entities?from={token}        full entity scan (paginated)
GET  /datasets/{name}/entities?id={uri}            single-entity lookup by URI
POST /datasets/{name}/entities                     write entities (incremental or full-sync)
```

### 3.1 Incremental Read (`/changes`)

The server returns a JSON array:
```
[ @context, ...entities, @continuation ]
```

The `@continuation` object carries an opaque base64 `token`. The client stores it and passes
it back as `?since=` on the next request. An absent `since` means "give me everything".

If the server needs the client to flush and re-bootstrap it returns the HTTP header
`universal-data-api-fullsync: true`.

### 3.2 Full-Sync Write Protocol

A multi-batch full reload over POST uses three coordinated HTTP headers:

| Header | Meaning |
|--------|---------|
| `universal-data-api-full-sync-id: <uuid>` | Shared session identifier across all batches |
| `universal-data-api-full-sync-start: true` | First batch; server opens a new full-sync window |
| `universal-data-api-full-sync-end: true` | Last batch; server closes and commits; absent entities are treated as deleted |

---

## 4. Alignment with OpenSync

### 4.1 Incremental read — complete overlap

| UDA concept | OpenSync equivalent | Notes |
|-------------|---------------------|-------|
| `GET /changes?since={token}` | `EntityDefinition.read(ctx, since?)` | Identical incremental pull semantics |
| `@continuation` token | `ReadBatch.since` watermark forwarding | Same opaque-token convention |
| `entity.deleted: true` | `ReadRecord.deleted?: boolean` | Same in-band soft-delete flag |
| `universal-data-api-fullsync: true` response header | `ReadBatch.complete` (planned in `PLAN_FULL_SYNC_SIGNAL.md`) | Semantics differ: UDA signals re-bootstrap from server side; OpenSync signals completion from connector side — but both address the "full dataset boundary" problem |

### 4.2 Write path — near-complete overlap

| UDA concept | OpenSync equivalent | Notes |
|-------------|---------------------|-------|
| `POST /datasets/{name}/entities` (incremental) | `insert()` / `update()` | Direct write to a dataset |
| `universal-data-api-full-sync-start/end/id` headers | No equivalent today | The gap tracked in `PLAN_FULL_SYNC_SIGNAL.md` also affects the write side |

### 4.3 `props` / `refs` split — confirms current direction

UDA's explicit separation of literal properties and typed entity references (`refs`) is
identical in principle to OpenSync's field/association split. The key difference is that UDA
uses URI-typed predicate names while OpenSync uses configured predicate strings. Both treat
references as first-class citizens distinct from scalars.

### 4.4 `recorded` timestamp — source-side version stamp for LWW

Every UDA entity carries a `recorded: uint64` (nanoseconds since epoch) representing when the
source data was last modified. This is a source-assigned version stamp — the entity publisher
sets it, not the hub. Both `recorded` and analogous source-assigned version stamps used in
related JSON pull/push protocols reflect the source's own change ordering and are the correct
primitive for Last-Write-Wins conflict resolution.

OpenSync currently uses engine-assigned wall-clock time for LWW, which means two independent
systems that both update a record produce a winner based on when OpenSync polled them, not on
when the upstream systems actually changed the data. `ReadRecord` has no standard field for
the source's own modification time. UDA's `recorded` is a concrete precedent for adding such
a field — an optional `sourceVersion?: number` on `ReadRecord` would let connectors forward
it and the engine could use it as the authoritative LWW key.

### 4.5 URI-based identity

UDA identities are always full URIs. This makes cross-dataset references unambiguous:
`refs["foaf:knows"] = "http://data.example.org/people/alice"` means the same thing
regardless of which dataset it appears in.

OpenSync's identity model uses connector-local string IDs resolved through an identity table.
The separation of concerns is similar (local ID → global canonical form) but OpenSync never
exposes or requires the URI form. For UDA interoperability a connector could emit the URI
as the record ID and configure the channel identity key accordingly.

### 4.6 Dataset discovery (`GET /datasets`)

UDA servers expose a live `GET /datasets` endpoint returning the list of available datasets
with metadata. This is the runtime-discoverable equivalent of OpenSync's statically declared
`EntityDefinition[]` array in a connector. A UDA connector could call this endpoint at
startup to auto-register entity definitions rather than requiring manual configuration.

---

## 5. Comparison with a related JSON Pull/Push protocol

UDA and an earlier JSON Pull/Push protocol from the same design tradition share many patterns.
The table below shows where they align and where UDA is more complete.

| Concern | Comparable JSON Pull/Push | UDA |
|---------|----------------------|-----|
| Incremental sync watermark | `?since=` cursor (opaque `_updated`-style value) | `?since=` (`@continuation` token) |
| Soft delete | `_deleted: true` in-band | `deleted: true` in-band |
| Primary key field | `_id` (underscore convention) | `id` (top-level, URI) |
| Full-sync coordination (client→server) | `is_full`, `is_first`, `is_last`, `sequence_id` query params or body fields | `universal-data-api-full-sync-start/end/id` HTTP headers |
| Full-sync signal (server→client) | `X-Dataset-Populated` response header | `universal-data-api-fullsync: true` response header |
| Source-side version stamp | `_updated` (monotonic integer, source-assigned) | `recorded` (uint64 nanoseconds, source-assigned) |
| Semantic typing of references | None; all fields are flat | Explicit `refs` object; predicates are URIs |
| Namespace compression | None | CURIE `@context` |
| JSON-LD output | Not defined | Native via `Accept: application/ld+json` |
| Dataset discovery | Not standardised | `GET /datasets` |

UDA is strictly more complete: it adds source-side versioning, URI identity, semantic
reference types, JSON-LD, namespace compression, and live dataset discovery on top of the
same incremental-sync core.

---

## 6. Useful Findings for OpenSync

### 6.1 UDA-compatible connector (new connector opportunity)

A `connectors/mimiro-uda/` connector would let OpenSync consume any UDA-compliant endpoint
as a source (via `GET /changes`) and write back as a target (via `POST /entities`). Because
UDA is an open standard and Mimiro publishes their platform commercially, this connector
would give OpenSync access to an existing customer base and a tested interoperability story.

The connector is straightforward: the UDA API is small (five endpoints), the incremental
pull maps directly to `read()`, and the `@continuation` token maps to the watermark pattern.

The main design decision is identity: UDA IDs are URIs. The connector should preserve the
full URI as the record ID and document that channel config should set the identity key to the
URI field.

### 6.2 Full-sync write-side protocol — informs `PLAN_FULL_SYNC_SIGNAL.md`

`PLAN_FULL_SYNC_SIGNAL.md` currently focuses on the *read* side (signaling completion when a
connector has emitted all records). UDA's `universal-data-api-full-sync-start/end/id` header
triplet addresses the *write* side: how the engine tells a target connector that it is sending
a complete dataset, allowing the target to purge absent records after the last batch.

The UDA approach (session UUID as the correlation key, HTTP headers as the signal mechanism)
is a clean reference design for OpenSync's write-side full-sync semantics.

### 6.3 Source-side version stamp — `recorded` informs an OpenSync gap

UDA's `recorded` (uint64 nanoseconds) is a source-assigned modification stamp — the entity
publisher sets it, not the hub. It represents the source's own change ordering and is the
correct basis for LWW conflict resolution.

OpenSync's `ReadRecord` has no standard field for a source-side version number. Adding an
optional `sourceVersion?: number` to `ReadRecord` would let connectors forward this value, and
the engine could prefer it over engine-assigned wall-clock time when resolving conflicts.
Without it, LWW winners are determined by poll timing rather than actual change ordering.

This is directly relevant to `plans/engine/PLAN_CHANNEL_CANONICAL_SCHEMA.md`.

### 6.4 Dataset-level metadata as a connector output

UDA's `GET /datasets/{name}` returns `{ name, since: bool, lastModified }`. The `since: bool`
flag indicates whether the dataset supports incremental reads at all — an explicit capability
declaration. OpenSync connectors currently declare capabilities via the presence or absence of
a `read()` with `since` parameter; there is no user-visible capability flag. UDA's model is
a more explicit, documentable contract and worth noting for future connector capability
metadata work.

### 6.5 JSON-LD interoperability

UDA's JSON-LD binding is a zero-configuration bridge to semantic web tooling (SPARQL
endpoints, linked data browsers, RDF triple stores). The SPARQL connector in
`connectors/sparql/` already operates in this space. Aligning the SPARQL connector's output
format with UDA's JSON-LD representation would make its entities directly compatible with
Mimiro's platform and other UDA consumers.

---

## 7. What OpenSync Does That UDA Does Not

UDA is a *data exposure and synchronisation protocol*, not a sync engine. It deliberately
specifies only the wire format and API semantics. The following concerns are out of scope for
UDA and are OpenSync's value-add:

- **Shadow state / deduplication** — UDA has no concept of a shadow. A client consuming UDA
  changes is responsible for its own dedup, conflict detection, and rollback.
- **Bi-directional conflict resolution** — UDA supports both reads and writes but does not
  define how conflicts between two independent writers are detected or resolved.
- **Identity resolution across systems** — UDA uses URIs for globally unique identity, which
  sidesteps the cross-system identity problem. OpenSync's identity table handles the case
  where two systems use incompatible local IDs for the same real-world entity.
- **Field mapping and transformation** — UDA carries raw semantic data; it has no mapping
  layer. This is by design (connectors are dumb pipes in UDA too).
- **Circuit breakers, rollback, audit log** — none of these are in scope for UDA.

---

## 8. Open Questions

1. Does Mimiro publish a reference server implementation of UDA? A docker-compose
   fixture would make connector development and testing straightforward.
2. Is the `recorded` timestamp (uint64 ns) comparable across different UDA servers, or is
   it server-relative? The spec does not clarify — this matters for cross-server LWW.
3. Are there UDA clients or SDKs in TypeScript? A TypeScript UDA client library would reduce
   the connector implementation to a thin adapter.
4. What is the relationship between the `GET /entities` (full scan) and `GET /changes`
   (incremental) endpoints in terms of data consistency? The spec implies they may return
   different subsets at any given moment — how should a connector handle this?
