# OSI-Mapping Primitive Coverage

**Status:** reference  
**Date:** 2026-04-03  

This spec catalogs every primitive from the [OSI-mapping schema](https://github.com/BaardBouvet/OSI-mapping) and assesses whether OpenSync has the architectural foundation to support it. The goal is not to implement them today, but to validate that nothing in the current design forecloses any primitive, and to record where gaps exist.

OSI-mapping is a declarative schema for defining how fields from multiple source systems map to a shared target model, including conflict resolution, entity linking, FK resolution, nested structures, and change detection. OpenSync wants to support all of these primitives.

---

## Foundation Status Legend

| Status | Meaning |
|--------|---------|
| ✅ Foundation exists | Core architecture already supports or directly maps to this |
| 🔶 Partial | Related concept exists but the primitive is not fully addressable yet |
| ❌ Gap | No current foundation — requires design work before implementation |

---

## 1. Resolution Strategies

Per-field strategies that determine how conflicts between sources are resolved. Declared on target fields; the resolution pipeline applies them when multiple sources contribute to the same entity.

### `identity`
Match records across sources — records with the same identity field value(s) are merged into one unified entity via transitive closure. Every target needs at least one identity field.

**Foundation: ✅** OpenSync's `IdentityMap` (see [identity.md](identity.md)) provides hub-and-spoke identity with global UUIDs and `entity_links`. The concept of a field acting as a match key is present. Transitive closure is a gap (see §2).

---

### `coalesce`
Pick the best non-null value by source priority. Lower `priority` number wins. Per-field overrides override mapping-level priority.

**Foundation: ✅** The sync engine's conflict resolution layer supports priority-based resolution. The current implementation is field-level, matching the coalesce model. Per-field and per-mapping priorities need to be wired through config (see §10 on mapping config).

---

### `last_modified`
Most recently changed value wins. Requires a timestamp field on the mapping or per-field override. When timestamps are null, falls back to declaration order.

**Foundation: ✅** Shadow state stores per-source timestamps. The field-level backend (described in [sync-engine.md](sync-engine.md)) tracks when each source last provided a value. `last_modified` resolution is the natural outcome of comparing those timestamps.

---

### `expression`
Custom aggregation expression computing the final value. In OSI-mapping this is SQL (`max(score)`, `count(*)`, etc.) run inside the resolution view over all contributed values.

**Foundation: 🔶** OpenSync uses TypeScript transform functions, not SQL aggregations. The concept of a user-defined resolver is present (conflict resolution is pluggable per the backend interface), but the SQL aggregation model is different. Supporting this either requires a query-engine backend (Postgres-based, as OSI-mapping's reference engine uses) or a TypeScript equivalent where the user provides a reducer function. Architecture does not foreclose this — it is a resolver strategy variant.

---

### `collect`
Gather all contributed values without resolution. Returns an array of all source values for the field.

**Foundation: 🔶** No explicit `collect` strategy exists. The shadow state tracks per-source values, so the raw material is there. Needs a resolver that returns a list rather than selecting one winner.

---

### `bool_or`
Resolves to `true` if any contributing source has a truthy value. Used for deletion flags or any boolean that propagates across sources.

**Foundation: 🔶** No explicit `bool_or` strategy. Equivalent to a `collect` followed by `Array.some(Boolean)`. Implementable as a named resolver variant. The deletion-flag use case overlaps with [safety.md](safety.md) soft-delete handling.

---

## 2. Identity & Linking

### Composite keys (`link_group`)
Multiple `identity` fields form a compound match key. Records link only when **all** fields in the group match as a tuple. Multiple `link_group` values on the same target act as OR (match on any group links the records).

**Foundation: 🔶** Current identity linking uses a single external ID per connector instance. Compound keys (e.g. first_name + last_name + dob) are not addressable. The entity_links table uses a single `external_id` column. Supporting composite keys requires either serializing a composite key into `external_id` or extending the schema to support multi-field identity tuples.

---

### Transitive closure
Entity linking is computed via connected-components: if A matches B (shared email) and B matches C (shared tax ID), then A=B=C even though A and C share no field directly. This is a graph algorithm, not a pairwise lookup.

**Foundation: ❌** Current `IdentityMap.linkExternalId` creates direct entity_links without building a graph. Pairwise matching is used during discovery (see [discovery.md](discovery.md)) but transitive closure across more than two systems is not guaranteed. A graph-based identity layer (e.g. union-find / connected components) needs to be designed.

---

### External link tables (`links` / `link_key`)
A separate linking table (e.g. from an MDM system) provides pairwise edges (`crm_id`, `erp_id`). The engine feeds these into the identity algorithm. `link_key` provides a pre-computed cluster ID for IVM-safe operation.

**Foundation: ❌** No concept of a third-party linkage table feeding into identity resolution. The current model only links via connector-reported external IDs. This is a distinct source of identity edges that would need to be plumbed into the identity layer.

---

### Cluster members
An ETL feedback table where the engine writes back generated cluster IDs after inserts. Enables the system to recognize on the next run that a newly inserted record already belongs to a known entity.

**Foundation: ❌** OpenSync detects inserts by checking entity_links — if there is no link for an incoming external ID, the entity is new. But after an insert, the new target ID is not written back to a feedback table that future runs consult. This is analogous to the "deferred associations" pattern in [identity.md](identity.md) but more structured. A writeback mechanism after inserts would close this gap.

---

### Cluster field
A source column that holds a pre-populated cluster ID from a previous ETL run. The connector stores this field on the source record itself, eliminating the need for a separate feedback table.

**Foundation: ❌** No such contract in the current connector SDK. Connectors could theoretically return this as a field, but the engine has no mechanism to treat a specific field as a cluster-ID override during identity resolution.

---

## 3. Nesting & Structure

### Embedded objects (flat parent mapping)
A sub-entity whose fields come from the same source row as the parent. Declared with `parent:` and no `array:` — the child reads columns directly from the parent's row (e.g. `ship_street`, `ship_city` → a `shipping_address` entity).

**Foundation: 🔶** The current mapping config ([config.md](config.md)) handles field-level mappings but does not have a first-class `parent:` concept for splitting one source row into multiple target entities. The identity spec mentions that a flat connector record can map to multiple entity types via mapping config, which is the conceptual equivalent. Needs `parent:` syntax in mapping config.

---

### Nested arrays (`parent` + `array` / `array_path`)
A source record contains a JSONB array column (e.g. `order.lines`). The child mapping expands each array element into its own target entity row. `array_path` supports a dotted nested JSON path. `parent_fields` brings parent-row values into scope for each child element.

**Foundation: ❌** No JSONB array expansion in the current pipeline. Connectors are expected to yield flat `NormalizedRecord` objects. Array-of-objects nesting is a structural transformation that needs to be designed into the forward pipeline.

---

### Deep nesting (multi-level `parent`)
Each nesting level references the previous as parent. Supports arbitrary depth: order → lines → sub-lines.

**Foundation: ❌** Depends on nested arrays (above). Deep nesting compounds the gap.

---

### Scalar arrays (`scalar: true`)
A JSONB array of bare scalar values (e.g. `["vip", "churned"]`) rather than objects. The scalar value doubles as the element identity.

**Foundation: ❌** Depends on nested arrays. Scalar extraction is a variant of the array expansion path.

---

### JSONB sub-field extraction (`source_path`)
Extract a value from a nested JSON path within a source column rather than a top-level field.

**Foundation: 🔶** NormalizedRecord is a flat key-value map. A connector can pre-extract nested fields before yielding records, but there is no engine-level `source_path` that does JSON path extraction inline during the forward transform. This is implementable as a field expression variant.

---

### Passthrough columns
Source columns that are not mapped to any target field but should still appear in the delta output (e.g. for downstream consumers that need the original row).

**Foundation: 🔶** NormalizedRecord carries arbitrary fields and shadow state preserves them. But the delta/dispatch pipeline does not have an explicit `passthrough` concept for forwarding unmapped columns to reverse output. Needs a config/spec design.

---

## 4. References & Foreign Keys

### Cross-entity references (`references` on TargetFieldDef)
Declares that a target field is a foreign key to another target entity. When entities merge during identity linking, local IDs in referencing records are automatically preserved — each source keeps its own FK value pointing to the correct local record.

**Foundation: 🔶** The identity spec mentions "associations" where a contact references a company, and deferred associations handle the case where the company hasn't synced yet. However, explicit `references:` declarations on fields and the automatic FK translation during entity merges are not designed. The deferred-associations mechanism is the closest foundation.

---

### FK reverse resolution
When syncing back to a source, translate the global resolved FK field back to the source's local ID namespace. Requires tracing through the identity graph: find which source record in the referenced entity is part of the same cluster, return its local PK.

**Foundation: 🔶** `IdentityMap.getExternalId(entityId, connectorInstanceId)` provides the basic lookup needed. The challenge is wiring this into the reverse-mapping path so that FK fields are automatically translated per source. Architecture supports it; the pipeline plumbing is missing.

---

### Reference preservation after merge
When two entities merge (e.g. two company records with the same domain), referencing contacts preserve their original FK values in each source — because the original FK is still a valid local ID.

**Foundation: 🔶** The identity map keeps all `entity_links` for a merged entity (they all point to the same UUID), so original external IDs are preserved. Preservation of FK values in referencing records during reverse-mapping needs to be explicitly designed.

---

### `references_field`
When a source stores a different representation of the FK (e.g. ISO code `"NO"` instead of the vocabulary entity's PK `"Norway"`), `references_field` tells the engine which field of the referenced entity to return during reverse mapping.

**Foundation: ❌** No equivalent in the current design. Needs to be added alongside the FK resolution pipeline.

---

### Vocabulary targets
A regular target entity used as a lookup table (e.g. `country` with `name` and `iso_code`). Sources map to vocabulary fields using `references` + `references_field` to translate between representations.

**Foundation: ❌** No vocabulary/lookup entity concept. A vocabulary entity is structurally a normal entity with identity fields, so the entity model can accommodate it. The `references_field` gap applies.

---

## 5. Field-Level Controls

### Groups (atomic resolution)
All fields sharing the same `group` resolve from the same winning source. Prevents mixing (e.g. address parts from different sources — if ERP wins `street`, it also wins `city` and `zip`).

**Foundation: ❌** Conflict resolution is per-field independently in the current design. Atomic groups are not modeled. Requires grouping semantics in the resolution layer.

---

### Filters (`filter` / `reverse_filter`)
- `filter`: SQL WHERE condition — only source rows matching the condition contribute to the target.
- `reverse_filter`: only resolved rows matching the condition are written back to this source.

Used for routing (discriminator-based: `type = 'customer'` → CRM, `type = 'employee'` → HR), selective sync, and delete propagation control.

**Foundation: ❌** No filter concept in the mapping config or pipeline. Connectors currently control what they return (partial equivalent), but engine-level filtering based on field values is not designed. This is needed for routing patterns.

---

### Derived fields (`default` / `default_expression`)
Fallback values when no source provides data. `default` is a static value; `default_expression` is a SQL expression (e.g. `first_name || ' ' || last_name`).

**Foundation: 🔶** TypeScript transforms can inject constants during forward processing. An explicit `default` /`default_expression` at the mapping layer is not in the config schema yet.

---

### Direction control (`bidirectional` / `forward_only` / `reverse_only`)
Per-field direction. `forward_only` fields (e.g. constant injections) only flow source → target. `reverse_only` fields only flow in the reverse ETL direction.

**Foundation: ❌** All mapping fields are implicitly bidirectional today. No per-field direction flag. Required for constant injection, one-way computed fields, and asymmetric schema mappings.

---

### Field expressions (`expression` / `reverse_expression`)
Forward transform: SQL (or function) applied to the source value before contributing to resolution. Reverse transform: applied when writing back to the source.

**Foundation: ✅** TypeScript transform functions in the mapping config serve this role. The current design uses `map` functions rather than inline SQL expressions, but the concept is fully present.

---

### Enriched expressions (cross-entity correlated subqueries)
An `expression` field that references other target entities (via `FROM`/`JOIN`). Run as a `LEFT JOIN LATERAL` after resolution, not inline. Enables computing `order_count` on a `customer` entity by counting from the `order` entity.

**Foundation: ❌** No cross-entity reference in computed fields. The current pipeline resolves each entity independently. A post-resolution enrichment pass that can query other resolved entities needs to be designed.

---

### Per-field timestamps
Override the mapping-level `last_modified` timestamp for a specific field. Useful when different fields in the same source have independent update timestamps.

**Foundation: 🔶** Shadow state tracks per-field provenance. Whether the mapping config can specify a different timestamp column per field is not currently designed.

---

### Normalize (precision-loss noop)
A SQL expression with a `%s` placeholder applied to both the source snapshot and the resolved value before comparing for noop. Handles cases where a target system has lower fidelity (integer rounding, VARCHAR truncation, case folding) — differences within the expected precision loss are classified as noops.

Also used for echo-aware resolution: a lower-precision source whose normalized value matches the golden record is not allowed to win resolution and degrade it.

**Foundation: ❌** Noop detection (shadow state diff) compares raw values. Precision-loss tolerance is not modeled. Needs a per-field normalization transform applied at diff time.

---

## 6. Deletion & Tombstones

### Soft delete
Detect source-side deletion signals without requiring a hard DELETE:
- `timestamp` strategy: `deleted_at IS NOT NULL` → row is deleted
- `deleted_flag` strategy: `is_deleted IS NOT FALSE` → row is deleted
- `active_flag` strategy: `is_active IS NOT TRUE` → row is deleted

Can suppress the row locally (default) or route the detection into a named target field for propagation.

**Foundation: 🔶** [safety.md](safety.md) discusses soft deletes. The connector SDK allows connectors to signal deletion by omitting records from subsequent reads or via explicit delete events. Engine-level soft-delete field inspection (treating a field value as a deletion signal) is not designed — currently the connector must handle this interpretation itself.

---

### Hard delete / `derive_tombstones`
Detect entity absence: entities present in the `cluster_members` feedback table (i.e. previously inserted) but missing from the current source snapshot are treated as deleted. A synthetic row with `is_deleted = true` is contributed to resolution.

**Foundation: ❌** No entity-absence detection pipeline. The engine does not currently compare previous-run entity sets against current-run entity sets to detect disappearances. This requires either full-snapshot comparison or the cluster_members writeback mechanism.

---

### Element hard delete (child-level tombstones)
Detect absence of nested array elements that were previously written. Elements present in `written_state` but absent in the current source contribute a synthetic `is_removed = true` row.

**Foundation: ❌** Depends on nested arrays and written_state, both of which are gaps.

---

### `reverse_required`
When true on a field mapping, the entire row is excluded from reverse output if the resolved value for this field is null. Used for insert/delete propagation — rows without a required field become deletes.

**Foundation: ❌** No per-field "exclude row from reverse if null" concept in the dispatch pipeline.

---

## 7. Change Detection & Noop

### Source-level noop (`_base` capture)
At forward time, the original source values are captured in `_base`. After resolution, the delta compares resolved values against `_base`. If they match, the row is classified as noop — no write needed. This suppresses round-trip echoes without external state.

**Foundation: ✅** Shadow state stores previous values per source (the "shadow" is the _base equivalent). The diff step in the pipeline computes changes against prior state. Echo prevention is explicitly designed in [safety.md](safety.md).

---

### Target-centric noop (`derive_noop` / `written_state`)
After source-level change detection flags a change, a second comparison checks whether the resolved values actually differ from what was **last written to the target**. If not, classify as noop. Requires a `written_state` table maintained by the ETL after each sync.

**Foundation: ❌** No `written_state` table concept. The current shadow state stores what was received from sources, not what was last written to targets. These are different when conflict resolution or transformation changes the value before writing.

---

### `derive_timestamps`
When source data lacks per-field timestamps (e.g. CSV imports), derive them by comparing current source values against previously written values. Changed fields get the current write timestamp; unchanged fields carry forward their prior timestamp.

**Foundation: ❌** Depends on `written_state`. Shadow state tracks when values were received, not derived from write comparisons.

---

### Concurrent detection (`include_base`)
Detect concurrent edits — when two sources both changed a field since the last sync, the current value in one source differs from the `_base` captured at the last forward pass. Used to trigger conflict review rather than silent last-write-wins.

**Foundation: 🔶** The engine tracks prior values in shadow state, which enables detecting that both sources diverged from a known baseline. An explicit concurrent-edit detection signal and workflow is not designed but the data is available.

---

## 8. Ordering

### Custom sort (nested array reconstruction)
When writing a nested array back to a source, control the ORDER BY inside the array aggregation. Declared as a list of target field names with direction (asc/desc).

**Foundation: ❌** Nested arrays are not yet designed. Ordering is a sub-feature of that gap.

---

### CRDT ordering (`order: true`)
Generate a deterministic per-element ordinal from source array position. Enables stable ordering across merges from multiple sources without an explicit ordering column.

**Foundation: ❌** Depends on nested arrays.

---

### CRDT linked-list (`order_prev` / `order_next`)
Adjacency pointer metadata for graph-like ordering: each element knows its previous and next sibling. Useful when the source stores linked-list-style ordering.

**Foundation: ❌** Depends on nested arrays and CRDT ordering.

---

## 9. Routing & Partitioning

### Discriminator routing (`filter`)
Multiple mappings from one source to different targets (or multiple sources to one target) with `filter` conditions acting as discriminators. E.g. `type = 'customer'` rows go to CRM; `type = 'employee'` rows go to HR.

**Foundation: ❌** The engine currently maps an entity type one-to-one to a target entity. Filter-based routing — where the same source entity type fans out to different targets based on field values — is not in the current design.

---

### Route combined (routing + merging)
A routing mapping handles a subset of records via `filter`; a separate plain mapping handles all records from another source. The two mappings merge into the same target entity via identity linking.

**Foundation: ❌** Depends on filters. The identity linking foundation (once transitive closure is in place) supports merging from multiple mappings.

---

### Element-set resolution (`elements: coalesce` / `elements: last_modified`)
When multiple sources contribute elements to a nested array, resolve element-level conflicts — pick the winning source's version of each element by priority or timestamp.

**Foundation: ❌** Depends on nested arrays.

---

## 10. Mapping Config & Metadata

### Multi-entity files
All related entities (company, contact, country) belong in the same mapping file. Cross-entity references and FK resolution require all entities to be co-located.

**Foundation: ✅** [config.md](config.md) already supports multiple entity mappings across multiple files (merged alphabetically). The constraint to co-locate related entities is a design convention that the config system can enforce.

---

### Source metadata (`sources:` / `primary_key`)
Declares physical table/view names and primary keys per source dataset. Composite PKs (array of columns) supported.

**Foundation: 🔶** OpenSync connectors declare their own entity schema and return an `id` field as the external ID. A separate `sources:` section with explicit PK declarations is not in the current config. For a SQL-backend variant (OSI-mapping style), this would be needed.

---

### Mapping-level priority and `last_modified`
A single `priority` or `last_modified` timestamp column applied to all fields in a mapping, overridable per field.

**Foundation: 🔶** The current conflict resolution in the engine is field-level. Mapping-level priority as a default for all fields in that mapping is not in the config spec yet.

---

### `passthrough` columns (config)
Explicit list of source columns to carry through to delta output without mapping them to target fields.

**Foundation: ❌** Not in the current mapping config.

---

## 11. Testing

### Inline test cases
Test cases embedded directly in the mapping file: `input` rows per source → `expected` output per source (with explicit `updates`, `inserts`, `deletes` categories). Runs the full pipeline in a test container — no mocks.

**Foundation: ❌** No inline testing concept in the current mapping config. Tests for individual connectors exist as unit tests, but full end-to-end pipeline tests declared inline in the mapping file are not designed. This is one of the most valuable primitives for validating mapping correctness.

---

### `_cluster_id` seed format for expected inserts
Expected insert rows must include a `_cluster_id` seed (`"mapping:src_id"`) that the test harness resolves to the actual computed entity ID. Supports nested array disambiguation via `?field=value` query filters.

**Foundation: ❌** Depends on inline testing infrastructure.

---

## Summary

| Category | Total Primitives | ✅ Found | 🔶 Partial | ❌ Gap |
|----------|-----------------|---------|-----------|-------|
| Resolution strategies | 6 | 3 | 3 | 0 |
| Identity & linking | 5 | 0 | 1 | 4 |
| Nesting & structure | 6 | 0 | 2 | 4 |
| References & FKs | 5 | 0 | 3 | 2 |
| Field-level controls | 8 | 1 | 3 | 4 |
| Deletion & tombstones | 4 | 0 | 1 | 3 |
| Change detection & noop | 4 | 1 | 1 | 2 |
| Ordering | 3 | 0 | 0 | 3 |
| Routing & partitioning | 3 | 0 | 0 | 3 |
| Mapping config & metadata | 4 | 1 | 2 | 1 |
| Testing | 2 | 0 | 0 | 2 |
| **Total** | **50** | **6** | **16** | **28** |

---

## Highest-Priority Foundation Work

The gaps cluster into a few interconnected areas. Unblocking these unlocks the most primitives:

1. **Transitive closure identity** — needed by composite keys, external links, FK resolution, multi-source merge, N-way sync. A union-find / connected-components layer over `entity_links`.

2. **Nested array pipeline** — unlocks embedded objects, nested arrays, scalar arrays, element-level deletion, element ordering, dynamic resolution. Requires designing a forward expand + reverse aggregate path.

3. **Filter/routing** — unlocks `filter`, `reverse_filter`, routing, route-combined, `reverse_required`. Needed for any discriminator-based partitioning.

4. **FK resolution pipeline** — unlocks `references`, `references_field`, vocabulary targets, reference preservation. Builds on transitive closure + identity map's `getExternalId`.

5. **`written_state` / target-centric noop** — unlocks `derive_noop`, `derive_timestamps`, element hard-delete. Requires storing what was last written (not just what was last received).

6. **Inline test framework** — unlocks the full testing primitive. High value for mapping validation independent of the above gaps.

---

## Relationship to Existing Specs

- [sync-engine.md](sync-engine.md) — covers the pipeline where resolution strategies run; expression, collect, bool_or, groups, and normalize extend the conflict resolution layer
- [identity.md](identity.md) — hub-and-spoke model is the right foundation; needs transitive closure and composite key support
- [safety.md](safety.md) — echo prevention, soft deletes, idempotency map to OSI-mapping's noop detection and soft_delete primitives
- [config.md](config.md) — mapping config needs filter, direction, group, default, passthrough, and inline tests
- [connector-sdk.md](connector-sdk.md) — NormalizedRecord and entity schema declarations are the source metadata layer; composite PKs and source_path extraction extend it
