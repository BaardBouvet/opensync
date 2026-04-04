# Data Access

> **Status**: Early draft. This spec captures intent and known design decisions; implementation
> is not yet started. Expand as the feature is built.

The shadow state is more than an engine-internal cache — it is a queryable, unified data layer.
Once two or more connectors are onboarded into a channel, the engine holds a merged, field-level
view of every record across all connected systems. This spec describes how that data can be
read by applications and agents without going through the connectors.

---

## § 1 The Unified Data Layer

Every record the engine has seen is represented in `shadow_state` with its `canonical_data`
blob: a `FieldData` object that records the current value, previous value, timestamp, and
source connector for every field. The identity map joins these blobs across connectors using
a shared `canonical_id`.

The result is a queryable view equivalent to a merge of all synced records from all connectors
in a channel, updated in near-real-time.

---

## § 2 Use Cases

### § 2.1 Agent Query Patterns

An agent or LLM tool can query shadow state to:

- Find all contacts whose `email` changed in the last 24 hours across any connector
- Get the merged canonical fields for a specific canonical ID
- Enumerate all records in an entity across all connectors without calling each upstream API
- Detect which fields are owned by which connector (via `FieldEntry.src`)

### § 2.2 Reporting and Dashboards

Sync health dashboards can read `sync_runs` for per-batch metrics, `transaction_log` for
attribution, and `shadow_state` for the current merged record state.

### § 2.3 Reconciliation

Applications can compare an external record's current API state against the engine's
`shadow_state.canonical_data` to detect external drift — values changed outside the engine's
write path.

---

## § 3 Query Interface (Planned)

The engine will expose a read-only query API over shadow state. Design decisions to be made:

- **Transport**: HTTP REST vs. direct SQLite (library embed) vs. both
- **Query model**: SQL passthrough, GraphQL, or a structured filter API
- **Auth**: read tokens scoped to `channel_id` to avoid cross-channel leakage
- **Streaming**: Server-Sent Events or WebSocket for live record feeds

No implementation decisions are locked yet. The SQL schema in `specs/database.md` is the
authoritative data layout.

---

## § 4 Constraints

- **Read-only**: Data access does not write to shadow state. All writes go through the sync
  pipeline.
- **Field-level**: Queries should expose individual `FieldEntry` values (`val`, `prev`, `ts`,
  `src`), not just the merged current value. This lets applications understand ownership and
  history.
- **Cross-connector merge**: The merged canonical view should be computable from `shadow_state`
  using the query in `database.md § Key Queries — What is the current canonical value for a
  record?`.

---

## § 5 Open Questions

1. Should `data-access` be a separate server process, a library, or built into the engine HTTP
   server?
2. How does pagination work for large entity sets (thousands of records)?
3. What is the caching strategy — can queries be served from an in-memory read model?
4. How do we handle field values that are `unknown[]` arrays in the API response format?
