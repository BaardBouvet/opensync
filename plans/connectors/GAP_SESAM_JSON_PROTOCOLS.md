# GAP_SESAM_JSON_PROTOCOLS — Sesam JSON Pull & Push Protocol Alignment

> **Status:** draft
> **Date:** 2026-04-05

Reference docs:
- https://docs.sesam.io/hub/json-pull.html
- https://docs.sesam.io/hub/json-push.html

---

## Summary

Sesam defines two lightweight HTTP protocols for streaming entities between their integration
platform and external services:

- **JSON Pull** — the caller GETs a stream of entities from a Sesam-published endpoint,
  optionally filtering by `since` (a sequence offset). Analogous to OpenSync's `read()`.
- **JSON Push** — the caller POSTs batches of entities to a Sesam HTTP receiver endpoint.
  Supports incremental and full-sync modes with ordered request chaining. Analogous to
  OpenSync's `insert()` / `update()` flow.

This document maps each protocol concept to OpenSync's connector SDK contract, flags gaps, and
notes what a Sesam-compatible connector pair would require.

---

## § 1  JSON Pull Protocol — Gap Analysis

### § 1.1  Full alignment

| Sesam concept | OpenSync equivalent | Notes |
|---------------|---------------------|-------|
| `GET /api/publishers/<id>/entities` | `EntityDefinition.read(ctx, since?)` | Both use a watermark parameter to continue where the previous request left off |
| `since` query param (opaque offset referencing `_updated`) | `read(ctx, since?)` parameter | Semantics are opaque in both: pass back what you got, the other side interprets it |
| `limit` query param — cap response batch size | Implicit in `ReadBatch` async iterable: connector yields one batch at a time, controls its own page size | OpenSync has no explicit `limit` parameter; the connector decides how to page internally |
| Empty array response when no new data | `ReadBatch.records = []` with a forwarded `since` | Both produce an empty set when the caller is already up to date |
| `_deleted: true` on soft-deleted entities | `ReadRecord` with an `_op: 'delete'` marker (engine convention) | Gap — see §1.2.1 |
| `_id` field as primary key | `ReadRecord.id` | The field name convention differs — see §1.2.2 |

### § 1.2  Gaps

#### § 1.2.1  Deletion representation

Sesam uses `_deleted: true` as an in-band field on the entity object itself. OpenSync has
`ReadRecord.deleted?: boolean` serving exactly the same purpose — a connector returning a
Sesam-pulled entity with `_deleted: true` simply maps it to `deleted: true` on the `ReadRecord`.

**No gap.** Full alignment; the naming convention differs but the semantics are identical.

#### § 1.2.2  Identity field naming convention

Sesam uses `_id` (underscore prefix). OpenSync `ReadRecord` does not enforce a field name for
the primary key — the `id` mapping is specified in the channel's field mapping config, not
inferred from the record shape.

**Gap:** No enforced primary-key field name in `ReadRecord`. For a Sesam Pull connector, the
connector should expose its records with `_id` preserved as a field and rely on the channel's
field mapping to resolve identity. The SDK could benefit from a documented convention here.

#### § 1.2.3  Full-sync completion signal

Sesam's `X-Dataset-Populated` response header indicates whether the dataset has ever had a
complete population pass. OpenSync has no equivalent concept today — this is exactly the gap
that `plans/engine/PLAN_FULL_SYNC_SIGNAL.md` addresses with `ReadBatch.complete` and
`EntityDefinition.fullSyncOnly`.

A Sesam Pull connector could translate `X-Dataset-Populated: true` (received on the last
paginated GET) into `ReadBatch.complete = true`, once that field exists in the SDK.

#### § 1.2.4  Response metadata headers

Sesam exposes dataset generation, restore UUID, completeness timestamp, and max-updated offset
via response headers (`X-Dataset-Generation`, `X-Dataset-Max-Updated`, `X-Dataset-Completeness`,
`X-Dataset-Restore-Uuid`, `X-Dataset-Restore-Offset`). These carry change-detection and
rewind signals that Sesam's own pipes use for automatic reprocessing.

**Gap:** OpenSync has no equivalent generation/restore concept. The `since` watermark is the
sole continuation mechanism. A Sesam Pull connector should forward the `X-Dataset-Max-Updated`
value as `ReadBatch.since`; the other headers could be logged but have no engine-level
counterpart today.

#### § 1.2.5  Subset / filtered streams

Sesam supports a URL-encoded `subset` query parameter expressing an equality filter
(`["eq", "_S.field", value]`). This lets a single endpoint expose multiple logical entity
subsets.

**Gap:** OpenSync `EntityDefinition` has no subset/filter parameter in `read()`. A connector
targeting a Sesam endpoint with multiple subsets would need to model each subset as a separate
`EntityDefinition` (with `name: 'contact.active'`, etc.) or offer a connector config option to
specify the subset expression. This is a connector-design decision, not a missing SDK primitive —
but it should be noted in the connector guide.

---

## § 2  JSON Push Protocol — Gap Analysis

### § 2.1  Full alignment

| Sesam concept | OpenSync equivalent | Notes |
|---------------|---------------------|-------|
| POST to `/api/receivers/<id>/entities` | `EntityDefinition.insert()` / `update()` | Both write entity arrays to a remote receiver |
| Incremental sync (`is_full=false`, default) | Default `insert` / mixed `insert`+`update` calls | No mode flag needed in OpenSync — the engine determines insert vs update based on whether the record already exists in shadow state |
| Paginated delivery — multiple POSTs in one sequence | `insert()` / `update()` accept `AsyncIterable<…>` — streaming naturally supports multi-batch delivery | Full alignment in principle |
| `_id` on each entity | `InsertRecord.id` / `UpdateRecord.id` | Same identity-field naming gap as §1.2.2 |

### § 2.2  Gaps

#### § 2.2.1  Full-sync session protocol (`is_full`, `sequence_id`, `is_first`, `is_last`)

This is the largest structural gap. Sesam Push defines a stateful multi-request full-sync
session:

1. Caller opens a sequence with a unique `sequence_id` and `is_first=true`.
2. Batches are sent in order, each referencing `previous_request_id`.
3. The receiver detects deletions cross-batch: entities absent from the complete sequence are
   marked `_deleted: true` on completion.
4. The session closes with `is_last=true`.

OpenSync has no equivalent session layer. Write operations (`insert`, `update`, `delete`) are
discrete, unordered calls. Deletion detection in OpenSync is the engine's job: it diffs shadow
state after a `read()`, not the write side. There is no way for a Push-receiving connector to
know "this is a complete replacement set".

**Gap:** A connector implementing a Sesam Push receiver endpoint would need to manage session
state itself (using connector-level state or an external store) if it wants to support full-sync
deletion detection. The OpenSync `Connector.onEnable` / `onDisable` lifecycle could hold a pool
reference, but there is no engine-provided session abstraction.

**Possible future addition:** A `WriteSession` concept — an optional `openWriteSession()` call
that groups a sequence of `insert`/`update`/`delete` calls and triggers server-side deletion
detection on close. This is beyond the current scope but worth noting.

#### § 2.2.2  Ordered request chaining (`previous_request_id`)

Sesam Push requires each non-first request to reference the `request_id` of the previous one.
This is a delivery-ordering guarantee: if the previous request ID doesn't match, the server
returns 409 Conflict, and the sender restarts from the beginning.

**Gap:** OpenSync does not model write ordering at the protocol level. The engine fans out
change actions to connectors and expects each call to succeed or fail atomically. There is no
retry / resequence protocol. A Sesam Push connector operating in full-sync mode would need to
implement this ordering guarantee internally, outside the OpenSync write contract.

#### § 2.2.3  Conflict protocol (409 Conflict)

Sesam defines specific 409 cases: mismatched `previous_request_id`, inconsistent `is_full`, and
spurious `is_first`. The connector must abort and restart on 409.

**Gap:** OpenSync's `InsertResult` / `UpdateResult` carry per-record success/failure but have
no concept of "abort this session and restart". A Sesam Push connector in full-sync mode would
need to convert a 409 response into a thrown error that aborts the connector's current write run
and signals the engine to retry.

#### § 2.2.4  Soft deletion via omission (not explicit `_deleted`)

When Sesam Push receives a full-sync sequence (`is_full=true`), it marks as deleted any entity
that was present before but absent in the new sequence. This is deletion-by-omission.

**Gap:** OpenSync always performs explicit deletes — the engine diffs shadow state and issues
discrete `delete()` calls. A connector that implements a Sesam Push sink would see explicit
`delete()` calls from the engine (correct behaviour for OpenSync writes), but a connector that
bridges to an external Sesam Push receiver would need to decide whether to send explicit
`_deleted: true` entities or rely on a full-sync sequence with omission. The SDK and engine do
not currently help with this choice.

---

## § 3  Cross-cutting gaps

### § 3.1  Entity data model fields (`_updated`, `_ts`, `_hash`, `_previous`)

Sesam's entity data model attaches system metadata to every entity:

| Sesam field | Meaning |
|-------------|---------|
| `_updated` | Monotonically increasing sequence number (the watermark) |
| `_ts` | Microsecond timestamp of when the entity was written |
| `_hash` | Content hash for change detection |
| `_previous` | `_updated` value of the record this replaced |

**Gap:** OpenSync has no normalised system-metadata fields in `ReadRecord`. The engine hashes
records internally for shadow-state diffing, but it does not expose `_hash`, `_ts`, or
`_previous` to connectors or persist them alongside records. The `_updated` concept maps to
OpenSync's `since` watermark, but the field is not part of the record shape returned from
connectors.

For a Sesam Pull connector, `_updated` should be forwarded as `ReadBatch.since` so the engine
can use it as the incremental offset on the next poll. The remaining fields can be stored in the
raw record payload and treated as opaque data through the shadow state.

### § 3.2  Authentication model

Sesam uses JWT bearer tokens (`Authorization: Bearer <jwt>`). OpenSync has `auth.type: 'api-key'`
with an optional `header` field, which covers this: `header: "Authorization"`, and the token
is stored as the API key secret. No gap — straight forward to map.

### § 3.3  Pagination model asymmetry

Sesam Pull uses `limit` to cap pages; the next page starts from the `_updated` value of the
last received entity (passed back as `since`). Sesam Push uses `previous_request_id` chaining.
OpenSync uses:
- Reads: `ReadBatch` async iterable — the connector controls its own paging and emits batches
- Writes: `AsyncIterable<InsertRecord>` — the engine streams records to the connector

The structural models are compatible but not equivalent. The main asymmetry is on the write
side: OpenSync gives one record stream without session semantics; Sesam Push expects sessions
with ordering guarantees.

---

## § 4  Implementation notes for a Sesam connector pair

If OpenSync were to ship a `sesam` connector, it would consist of:

### Read side (JSON Pull consumer)
- `read(ctx, since?)`: GET `/api/publishers/<pipe_id>/entities?since=<watermark>&limit=<pageSize>`
- Forward `X-Dataset-Populated: true` → `ReadBatch.complete = true` (once the SDK supports it)
- Forward `X-Dataset-Max-Updated` value as `ReadBatch.since` per batch
- Map `_deleted: true` entities to a deletion signal in `ReadRecord` (once the SDK defines one)
- `lookup(ids, ctx)`: not directly supported by JSON Pull — Sesam has no single-entity fetch in
  this protocol; the connector could do a full scan and filter, or use the dataset API directly

### Write side (JSON Push sender)
- For incremental writes: POST each record individually as `[{...entity}]` without `is_full`
- For full-sync replacement (if needed): open a sequence with `sequence_id = uuid()`,
  stream all records with `is_first=true` on first, `previous_request_id` chaining on each,
  `is_last=true` on last — all within a single connector write run
- A 409 response must abort the run and signal the engine to retry

### Read side (JSON Push receiver)
- Expose an HTTP endpoint accepting POST with the Sesam Push protocol
- Map `is_first` / `is_last` to connector-level session state
- On `is_last=true`: perform deletion detection against locally tracked IDs from this sequence
- This is a `handleWebhook(req, ctx)` candidate — the push endpoint is effectively a webhook

### Write side (JSON Pull producer)
- Expose a GET endpoint that the Sesam instance can poll
- Return entities ordered by `_updated`, supporting `since` and `limit` parameters
- This is a `getEntities` / `read` pattern that could be exposed as an HTTP endpoint via the
  existing `connector-distribution` mechanism in `specs/connector-distribution.md`

---

## § 5  Prioritisation

| Gap | Severity | Blocking? |
|-----|----------|-----------|
| §1.2.3 — No `ReadBatch.complete` | Medium | Yes, for onboarding correctness (tracked in PLAN_FULL_SYNC_SIGNAL) |
| §2.2.1 — No write-session concept for full-sync push | High | Yes, for Sesam Push full-sync support |
| §1.2.2 / §2.1 — No primary-key field naming convention | Medium | No — connectors map via field config |
| §3.1 — No system metadata fields on `ReadRecord` | Low | No — fields pass through as opaque data |
| §1.2.4 — No dataset generation / restore headers | Low | No — useful for advanced reprocessing only |
| §2.2.2 / §2.2.3 — Write ordering / 409 protocol | Medium | Only for full-sync push sequences |
| §1.2.5 — No `read()` subset parameter | Low | No — workaround: separate EntityDefinitions |
