# Field Mapping

This spec covers everything that happens between raw connector records and the canonical entity
model: forward transforms (source → canonical), reverse transforms (canonical → target), resolution
strategies, structural expansion, FK translation, routing, and change detection.

For channel-level configuration syntax (`openlink.json`, `channels.yaml`, `mappings/` structure)
see [config.md](config.md). For identity linking and entity UUID allocation see [identity.md](identity.md).
For echo prevention and the shadow-state diff model see [safety.md](safety.md).

> **OSI-mapping compatibility**: this spec tracks coverage of the
> [OSI-mapping primitive set](../plans/osi-mapping-primitives.md). Each section notes
> implementation status. The full coverage table is at the end of this file.

---

## The Mapping Pipeline

Every sync cycle runs two passes per update:

```
Forward pass (ingest)
  connector.read() → NormalizedRecord[]
      ↓  field whitelist + source → target rename
      ↓  field expressions (forward transform)
      ↓  canonical record
      ↓  resolution: merge with other sources (coalesce / lww / expression)
      ↓  resolved canonical entity
      ↓  diff against shadow_state → delta

Reverse pass (dispatch)
  resolved delta
      ↓  diff against per-target written_state (target-centric noop) [planned]
      ↓  field expressions (reverse transform)
      ↓  target → source rename
      ↓  FK translation (canonical UUID → source local ID)
      ↓  UpdateRecord → connector.update()
```

`NormalizedRecord` is a flat key-value map. All structural expansion (parent/array) is applied
during the forward pass before the record reaches the resolution layer.

---

## 1. Field-Level Primitives

### 1.1 Field rename and whitelist

```yaml
fields:
  - source: firstname   # field name on the connector record
    target: firstName   # canonical field name
  - source: email
    target: email       # same name — still required to opt-in
```

`fields` is a **whitelist**. Only listed fields are synced; unlisted fields are dropped. If `fields`
is omitted, all fields pass through verbatim (no rename, no filtering) — useful for connectors that
already speak the canonical schema.

On the reverse pass the rename is inverted: `firstName` → `firstname` when writing back to the
same connector.

**Status: implemented.**

---

### 1.2 Field direction

| `direction`       | Forward (source → canonical) | Reverse (canonical → source) |
|-------------------|------------------------------|------------------------------|
| `bidirectional`   | ✓ (default)                  | ✓                            |
| `reverse_only`    | ✓                            | ✗                            |
| `forward_only`    | ✗                            | ✓                            |

```yaml
fields:
  - source: internalNotes
    target: notes
    direction: reverse_only   # read from this source; never write back
  - source: syncedFrom
    target: _origin
    direction: forward_only   # injected when writing to this connector; ignored on read
```

`reverse_only` is used for read-only audit connectors. `forward_only` is used for constant
injections, computed fields the connector provides itself, or schema-asymmetric situations.

**Status: implemented (OSI-mapping §5).**

---

### 1.3 Field expressions

```yaml
fields:
  - source: firstName
    target: firstName
  - source: lastName
    target: lastName
  - target: fullName
    direction: forward_only
    expression: (record) => `${record.firstName} ${record.lastName}`
    reverseExpression: (record) => ({
      firstName: record.fullName.split(' ')[0],
      lastName:  record.fullName.split(' ').slice(1).join(' '),
    })
```

`expression` is a TypeScript arrow function applied during the forward pass. `reverseExpression`
is applied when writing back. Both have access to the full canonical record, not just one field.

A `reverseExpression` that returns an object can set multiple source fields at once (one-to-many
decomposition).

**Status: designed, not yet implemented (OSI-mapping §5 "Field expressions"). See `plans/engine/PLAN_FIELD_EXPRESSIONS.md`.**

---

### 1.4 Normalize (precision-loss noop)

Some connectors store values at lower fidelity than the canonical model: phone numbers with
different formatting, floats rounded to fewer decimal places, strings truncated by a VARCHAR limit,
dates without time components. Without normalization these apparent differences register as changes
every cycle, causing an infinite update loop.

`normalize` is a transform applied to **both the incoming value and the stored shadow value** before
the noop diff check. It does not alter the value written to the canonical model or to the target —
it is purely a diff-time comparator.

```yaml
fields:
  - source: phone
    target: phone
    normalize: (v) => String(v).replace(/\D/g, '')   # strip all non-digits before comparing
  - source: score
    target: score
    normalize: (v) => Number(v).toFixed(2)           # normalize float precision
```

If `normalize(incoming) === normalize(shadow)`, the field is classified as noop even if the raw
strings differ. The higher-fidelity value (the canonical one) is still preserved in the canonical
model — it is the lower-fidelity source that is prevented from overwriting it.

For resolution strategies other than passthrough: a lower-precision source whose `normalize()`
output matches the golden record is not eligible to win resolution, preventing it from degrading
a higher-fidelity value contributed by another source.

**Status: designed, not yet implemented (OSI-mapping §5 "Normalize").**

---

### 1.5 Default values

```yaml
fields:
  - source: status
    target: status
    default: "active"                        # static fallback
  - source: displayName
    target: displayName
    defaultExpression: (record) => record.email   # dynamic fallback
```

`default` or `defaultExpression` is used when the source field is absent or null. The fallback is
applied during the forward pass before resolution. `defaultExpression` receives the partially-built
canonical record and can reference other fields.

**Status: designed, not yet implemented (OSI-mapping §5 "Derived fields").**

---

### 1.6 Passthrough columns

```yaml
mappings:
  - connector: erp
    channel: contacts
    entity: customers
    passthrough: [raw_segment_code, internal_account_ref]
    fields:
      - source: name
        target: customerName
```

Fields listed under `passthrough` are forwarded to the delta output without mapping to any target
field. They are invisible to resolution and do not participate in conflict detection. Useful when
downstream consumers of the sync pipeline need the original source row's metadata columns.

Passthrough columns appear under a connector-namespaced key in the delta record to avoid collisions
with canonical fields:

```json
{ "customerName": "Acme Corp", "_passthrough.erp.raw_segment_code": "A142" }
```

**Status: designed, not yet implemented (OSI-mapping §3 "Passthrough columns").**

---

### 1.7 JSON sub-field extraction (`source_path`)

```yaml
fields:
  - source_path: address.street   # dotted JSON path within the source record
    target: street
  - source_path: metadata.tags[0]
    target: primaryTag
```

`source_path` extracts a value from a nested path within the source record rather than requiring
the connector to pre-extract it. The `source` field name is inferred from the leaf key unless
overridden.

This is equivalent to writing a connector transform that calls `record.address?.street`, but
declared inline in the mapping file.

**Status: designed, not yet implemented (OSI-mapping §3 "JSONB sub-field extraction").**

---

### 1.8 Field groups (atomic resolution)

```yaml
fields:
  - source: ship_street
    target: street
    group: shipping_address
  - source: ship_city
    target: city
    group: shipping_address
  - source: ship_zip
    target: zip
    group: shipping_address
```

Fields sharing the same `group` label are resolved atomically: the source that wins one field in
the group wins all of them. This prevents incoherent mixes where, for example, the ERP wins
`street` and the CRM wins `city`.

When the group uses `last_modified` resolution, the group's timestamp is the `MAX` of all field
timestamps within the group from the winning source. When using `coalesce`, the winning source
provides all non-null group fields together.

**Status: designed, not yet implemented (OSI-mapping §5 "Groups").**

---

### 1.9 Per-field timestamps

```yaml
fields:
  - source: email
    target: email
    lastModifiedField: email_updated_at   # column on the source record carrying timestamp for this field
```

Overrides the mapping-level `last_modified` timestamp for a specific field. Useful when different
fields in the same source record carry independent update timestamps (e.g. an audit log table that
records per-column change time).

The specified `lastModifiedField` is consumed by the `last_modified` resolution strategy for that
field only. It does not need to appear in the `fields` whitelist.

**Status: designed, not yet implemented (OSI-mapping §5 "Per-field timestamps").**

---

## 2. Resolution Strategies

Resolution determines how the canonical value for a field is chosen when multiple connectors in the
same channel contribute a value for it. Declared per-field (or mapping-wide as a default).

### 2.1 `coalesce`

Pick the first non-null value by source `priority` (lower number = higher priority). Per-field
priority overrides the mapping-level default.

```yaml
mappings:
  - connector: crm
    channel: contacts
    entity: contacts
    priority: 1           # mapping-level default
    fields:
      - source: email
        target: email
        priority: 0       # field-level override — CRM is authoritative for email
```

**Status: implemented.**

---

### 2.2 `last_modified` (last-write-wins)

The most recently changed value wins. Requires a timestamp column (mapping-level or per-field).
When timestamps are null, falls back to declaration order.

```yaml
  - connector: erp
    channel: contacts
    entity: customers
    last_modified: updated_at   # column on the source record carrying the timestamp
```

Shadow state stores per-source per-field timestamps. `last_modified` resolution is the natural
result of comparing those timestamps across contributing sources.

**Status: implemented in engine; config-level `last_modified` key not yet wired.**

---

### 2.3 Expression resolvers

Custom aggregation function computing the final canonical value from all contributing source values.

```yaml
fields:
  - target: score
    resolve: (values) => Math.max(...values.map(v => Number(v) || 0))
```

The resolver receives an array of `{ value, sourceId, timestamp }` items and returns the canonical
value. Unlike field expressions (§1.3 above, which transform one value), resolvers aggregate across
sources.

**Status: designed, not yet implemented (OSI-mapping §1 "Expression").**

---

### 2.4 `collect`

Returns an array of all contributed values without resolving to one. Useful for tag lists or
multi-source enum aggregations.

```yaml
fields:
  - target: tags
    resolve: collect
```

**Status: designed, not yet implemented (OSI-mapping §1 "Collect").**

---

### 2.5 `bool_or`

Resolves to `true` if any contributing source contributes a truthy value. Intended for deletion
flags that should propagate if *any* upstream marks the record deleted.

```yaml
fields:
  - target: isDeleted
    resolve: bool_or
```

**Status: designed, not yet implemented (OSI-mapping §1 "Bool_or").**

---

## 3. Structural Transforms

### 3.1 Embedded objects (flat parent mapping)

One source record maps to a parent entity and a child entity whose fields are columns on the same
row.

```yaml
mappings:
  - connector: erp
    channel: contacts
    entity: contacts
    fields:
      - source: email
        target: email

  - connector: erp
    channel: contacts
    entity: addresses         # child entity
    parent: contacts          # parent entity type
    fields:
      - source: ship_street
        target: street
      - source: ship_city
        target: city
      - source: ship_zip
        target: zip
```

When the engine processes the ERP `contacts` record it produces two entities: a `contacts` entity
and an `addresses` entity. The child entity's identity is derived from the parent's external ID with
a deterministic suffix (`<parent_external_id>#address`).

On the reverse pass, child entity fields are written back alongside parent fields in the same
`UpdateRecord`.

**Status: designed, not yet implemented (OSI-mapping §3 "Embedded objects").**

---

### 3.2 Nested array expansion (`array` / `array_path`)

A source record contains a JSON array column. Each array element becomes its own child entity row.

```yaml
  - connector: erp
    channel: order-lines
    entity: order_lines
    parent: orders
    array_path: lines          # JSONB array column on the source record
    parent_fields: [order_id]  # parent columns brought into scope per element
    fields:
      - source: product_id
        target: productId
      - source: quantity
        target: qty
      - source: unit_price
        target: unitPrice
```

The forward pass:
1. Reads `record.lines` as a JSON array.
2. For each element, emits a new `NormalizedRecord` with the element's fields merged with
   the `parent_fields` values from the containing row.
3. Element identity: `<parent_external_id>#lines[<element_index>]` (or by a per-element identity
   field if declared).

The reverse pass:
1. Collects all child `order_lines` entities whose parent association points to the same `orders`
   record.
2. Sorts by declared `order` config (see §6).
3. Re-assembles the array and writes it back as the `lines` column in the parent `UpdateRecord`.

Element deletion is detected by comparing the assembled set against the previously written state:
elements present in `written_state` but absent from the current resolved set are emitted as removed.
This depends on `written_state` (see §7.1).

**Status: requires design work. Architectural foundation does not preclude this.
(OSI-mapping §3 "Nested arrays").**

---

### 3.3 Scalar arrays

```yaml
    array_path: tags
    scalar: true           # elements are bare strings, not objects
```

When `scalar: true`, each element of the JSON array is a bare value (string, number). The element's
value doubles as its identity. Deduplicated via `collect` resolution across sources.

**Status: depends on §3.2 being designed first (OSI-mapping §3 "Scalar arrays").**

---

### 3.4 Deep nesting

```yaml
  - entity: sub_lines
    parent: order_lines   # grandchild of orders
    array_path: components
    fields: [...]
```

Multi-level parent chains. Supports arbitrary depth. Each level is a separate mapping block
referencing the previous level as `parent`.

**Status: depends on §3.2 (OSI-mapping §3 "Deep nesting").**

---

## 4. Foreign Key References

### 4.1 Declaring a reference field

```yaml
fields:
  - source: account_id      # local source ID for the referenced account
    target: accountId
    references: accounts    # canonical entity type being referenced
```

`references` declares a foreign-key relationship. The engine uses this declaration to:

1. **Forward pass**: translate `account_id` from the source's local ID namespace to the canonical
   UUID for the referenced `accounts` entity. If the canonical entity is not yet known, the
   reference is deferred (see [identity.md](identity.md) §Deferred Associations).

2. **Reverse pass**: translate the canonical `accountId` UUID back to the target connector's local
   ID for the `accounts` entity before writing.

This is distinct from the automatic association syncing described in [identity.md](identity.md) —
`references` is for FK fields the connector explicitly stores on the record (e.g. a `contact`
that stores `account_id`), while associations are implicit structural links.

**Status: designed, not yet implemented (OSI-mapping §4 "Cross-entity references").**

---

### 4.2 Alternative representation (`references_field`)

```yaml
fields:
  - source: country_code   # stores "NO" (ISO alpha-2)
    target: countryId
    references: countries
    references_field: isoCode   # field in the canonical countries entity to match against
```

When the source stores a different representation of the FK (ISO code instead of the entity's PK),
`references_field` names the canonical field to use as the match key during forward resolution. The
engine finds the `countries` entity whose `isoCode` equals `"NO"` and substitutes its canonical UUID.

On the reverse pass, instead of writing the UUID, the engine writes the `isoCode` value for the
target connector's matching entity record.

**Status: requires design work (OSI-mapping §4 "references_field").**

---

### 4.3 Vocabulary targets

A canonical entity used as a shared lookup table (e.g. `country`, `currency`, `industry`).
Vocabulary entities use `references` + `references_field` for all FK resolution. They are not
synced bidirectionally — they are seeded once and used only for translation.

Declare a mapping as vocabulary-only:

```yaml
  - connector: static
    channel: countries
    entity: countries
    vocabulary: true    # never dispatched as an update target; used only for FK translation
    fields:
      - source: name
        target: name
      - source: iso_code
        target: isoCode
```

**Status: requires design work (OSI-mapping §4 "Vocabulary targets").**

---

## 5. Filters and Routing

### 5.1 Source filter (`filter`)

Include only source records that match a condition in the forward pipeline:

```yaml
  - connector: erp
    channel: contacts
    entity: customers
    filter: (record) => record.type === 'customer'
```

Records that do not match the filter are excluded from resolution and produce no canonical delta. If
a record previously matched but no longer does, it contributes a soft-delete signal (null for all
fields, or omission, causing the canonical entity to fall back to other sources).

**Status: designed, not yet implemented (OSI-mapping §5 "Filters").**

---

### 5.2 Reverse filter (`reverse_filter`)

Exclude canonical entities from being written back to a specific connector:

```yaml
    reverse_filter: (entity) => entity.status !== 'archived'
```

Archived entities are not pushed to the connector even if they changed. If an entity transitions
to archived, the connector may be instructed to delete or deactivate the corresponding record
(depending on deletion configuration).

**Status: designed, not yet implemented (OSI-mapping §5 "Filters").**

---

### 5.3 Discriminator routing

A single source entity type fans out to different canonical targets based on a field value. Use a
separate mapping for each target with a `filter`:

```yaml
  - connector: erp
    channel: contacts
    entity: people         # all ERP people
    filter: (r) => r.role === 'customer'

  - connector: erp
    channel: employees
    entity: staff          # same source type, different canonical target
    filter: (r) => r.role === 'employee'
```

The same source record can match at most one filter per canonical entity type. For merge patterns
(different sources → same canonical target with different filters) identity linking handles the
merge once filters are applied.

**Status: depends on §5.1 (OSI-mapping §9 "Discriminator routing").**

---

## 6. Ordering (Nested Arrays)

The following ordering primitives all depend on nested array expansion (§3.2) being designed first.
They are documented here for completeness.

### 6.1 Custom sort

When reassembling a nested array on the reverse pass, control the element order:

```yaml
    order_by:
      - field: lineNumber
        direction: asc
```

### 6.2 CRDT ordinal

Generate a deterministic per-element ordinal from source array position, enabling stable ordering
across merges from multiple sources without a dedicated ordering column:

```yaml
    order: true    # auto-assign ordinal from source position
```

### 6.3 Linked-list ordering

Store adjacency pointers (`order_prev`, `order_next`) for graph-style linked-list ordering:

```yaml
    order_linked_list: true
```

**Status of all ordering primitives: aspirational, depends on §3.2 (OSI-mapping §8).**

---

## 7. Change Detection Extras

### 7.1 Target-centric noop (`written_state`)

The standard shadow-state diff (see [safety.md](safety.md)) detects whether a source value changed
since it was last *read*. This does not catch the case where the resolved canonical value is
identical to what was *last written* to the target — a difference that arises when conflict
resolution or a transform changes the value before dispatch. It also cannot detect whether a
target connector independently mutated a field after the engine last wrote to it.

`written_state` is a per-target-per-entity table maintained after each successful write:

```sql
CREATE TABLE IF NOT EXISTS written_state (
  connector_id  TEXT NOT NULL,   -- target connector that received the write
  entity_name   TEXT NOT NULL,   -- entity name as in the channel member
  canonical_id  TEXT NOT NULL,   -- canonical UUID from identity_map
  data          TEXT NOT NULL,   -- JSON blob: { fieldName: value, … }
  written_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (connector_id, entity_name, canonical_id)
)
```

`data` stores the **post-outbound-mapping** field values handed to the connector's `insert()`
or `update()` call. This makes the stored values directly comparable against future outbound
deltas after mapping has been applied.

Before dispatching an **update** to a connector, the engine compares the post-outbound-mapped
delta against `written_state.data`. If all fields in the delta match **and** the association
sentinel (serialised and stored as the `__assoc__` key inside `data`) matches, the write is
classified as a target-centric noop and skipped. First-time inserts are always dispatched
regardless. Association-only changes (e.g. deferred-retry association updates) are also
correctly dispatched because the stored `__assoc__` sentinel differs.

After each successful write (insert or update), the engine upserts the `written_state` row
within the same atomic transaction that updates `shadow_state` and `identity_map`. If the write
fails, no `written_state` row is written or modified.

**Status: implemented. See `packages/engine/src/db/migrations.ts` (schema) and
`packages/engine/src/engine.ts` (`_dispatchToTarget` — noop check and upsert).**

---

### 7.2 Derived timestamps (`derive_timestamps`)

For sources that do not provide per-field update timestamps (CSV files, legacy systems), derive
timestamps by comparing current source values against previously written values:

- Changed fields get the current cycle timestamp.
- Unchanged fields carry forward their prior timestamp from `written_state`.

This enables `last_modified` resolution for sources that lack native change timestamps.

**Status: not yet implemented. Depends on §7.1 (`written_state`) being available at the source
connector level. See `plans/engine/PLAN_WRITTEN_STATE.md §5` for the design.**

---

### 7.3 Concurrent edit detection

When two sources both changed the same field since the last sync, both differ from the baseline
captured at the previous forward pass. This signals a conflict that may warrant review rather than
silent last-write-wins.

The engine has the necessary data in shadow state to detect this pattern — both source values differ
from the stored shadow. An explicit concurrent-edit event, routing to a conflict review workflow,
is not yet designed.

See [plans/lookup-merge-etag.md](../plans/lookup-merge-etag.md) for the related ETag / version
threading design that addresses the write-side of concurrent edits.

**Status: data is available; detection signal and workflow not yet designed
(OSI-mapping §7 "Concurrent detection").**

---

## 8. Deletion Primitives

### 8.1 Connector-reported deletion

Connectors signal deletion in two ways:

1. Emit a `NormalizedRecord` with `_deleted: true` during `read()`.
2. Stop returning a previously-seen record (absence detection — only reliable in full-snapshot
   connectors, not watermark-based).

The engine propagates deletion signals through the canonical layer: if all sources delete an entity,
the entity is tombstoned; if only one source deletes, force resolution falls back to remaining
sources.

**Status: implemented.**

---

### 8.2 Soft-delete field inspection

The connector yields a record with a soft-delete indicator field. The engine interprets the field
value as a deletion signal rather than requiring the connector to translate it:

```yaml
  - connector: crm
    channel: contacts
    entity: contacts
    soft_delete:
      field: is_deleted
      strategy: deleted_flag    # alternatives: timestamp (deleted_at IS NOT NULL), active_flag
```

Strategies:
- `deleted_flag`: `is_deleted IS NOT FALSE` → row is deleted
- `timestamp`: `deleted_at IS NOT NULL` → row is deleted
- `active_flag`: `is_active IS NOT TRUE` → row is deleted
- `expression`: `(record) => !record.is_active || !!record.archived_at` → custom condition

**Status: designed, not yet implemented (OSI-mapping §6 "Soft delete").**

---

### 8.3 Hard delete via entity absence

For full-snapshot connectors, compare the current read set against the previously written state.
Entities that were present in the previous full snapshot but absent from the current one are treated
as deleted.

```yaml
  - connector: jsonfiles
    channel: contacts
    entity: contacts
    full_snapshot: true   # enables entity-absence deletion detection
```

**Status: requires design work; depends on `written_state` (§7.1)
(OSI-mapping §6 "Hard delete / derive_tombstones").**

---

### 8.4 `reverse_required`

When `reverse_required: true` on a field, the entire record is excluded from a reverse write if the
canonical value for that field is null. Effectively turns null into a delete signal for that target.

```yaml
fields:
  - target: externalAccountRef
    reverse_required: true   # if canonical entity has no external ref, skip write to this connector
```

**Status: designed, not yet implemented (OSI-mapping §6 "reverse_required").**

---

## 9. Inline Test Cases (Aspirational)

Mapping files can embed test cases that run the full pipeline in a sandboxed environment with no
external I/O:

```yaml
tests:
  - name: "contact merge: crm wins email, erp wins phone"
    input:
      crm:
        - id: "c1"
          email: "alice@example.com"
          phone: "+1-555-0100"
      erp:
        - id: "e42"
          email: "alice@example.com"
          phone: "+15550100"
          normalize: phone
    expected_output:
      canonical:
        - email: "alice@example.com"
          phone: "+1-555-0100"    # crm wins (priority: 1)
      crm:
        updates: []               # no write-back (no change from source)
      erp:
        updates:
          - id: "e42"
            phone: "+1-555-0100"  # erp phone updated to canonical value
```

Each test block specifies input records per source, expected canonical resolution, and expected
writes per target. The harness runs without mocks; the pipeline itself is the implementation under
test.

**Status: aspirational, requires inline testing infrastructure
(OSI-mapping §11 "Inline test cases").**

---

## 10. OSI-Mapping Primitive Coverage

Full catalog of all OSI-mapping primitives against current OpenSync status.

| Primitive | OSI-mapping section | Status |
|-----------|---------------------|--------|
| `identity` (field-value matching) | §1 | ✅ implemented — see [identity.md](identity.md) |
| `coalesce` resolution | §1 | ✅ implemented |
| `last_modified` resolution | §1 | ✅ implemented (config key not yet wired) |
| `expression` resolver | §1 | 🔶 TypeScript resolvers designed, not wired to config |
| `collect` resolver | §1 | 🔶 data available in shadow state; resolver not built |
| `bool_or` resolver | §1 | 🔶 implementable as collect variant; not built |
| Composite keys (`link_group`) | §2 | 🔶 single-field identity only; composite needs schema change |
| Transitive closure | §2 | ❌ pairwise only; union-find layer not designed |
| External link tables | §2 | ❌ no third-party linkage feed |
| Cluster members writeback | §2 | ❌ no feedback table after inserts |
| Cluster field on source record | §2 | ❌ no contract for this in connector SDK |
| Embedded objects (flat `parent`) | §3 | 🔶 conceptually supported; `parent:` syntax not implemented |
| Nested arrays (`array` / `array_path`) | §3 | ❌ requires forward-expand + reverse-aggregate pipeline |
| Deep nesting | §3 | ❌ depends on nested arrays |
| Scalar arrays (`scalar: true`) | §3 | ❌ depends on nested arrays |
| `source_path` extraction | §3 | 🔶 doable as expression; inline syntax not implemented |
| Passthrough columns | §3 | 🔶 shadow state preserves; delta pipeline needs `passthrough:` key |
| `references` (FK field) | §4 | 🔶 deferred associations exist; explicit FK declaration not wired |
| FK reverse resolution | §4 | 🔶 `getExternalId` exists; not auto-wired into reverse mapping |
| Reference preservation after merge | §4 | 🔶 entity_links preserve original IDs; pipeline not wired |
| `references_field` | §4 | ❌ no alternate-representation FK |
| Vocabulary targets | §4 | ❌ no vocabulary entity concept |
| Field groups (`group`) | §5 | ❌ per-field independent resolution only |
| `filter` source filter | §5 | ❌ not in config or pipeline |
| `reverse_filter` | §5 | ❌ not in config or pipeline |
| `default` / `defaultExpression` | §5 | 🔶 doable as expression; dedicated key not implemented |
| Per-field `direction` | §5 | ✅ implemented |
| Field `expression` / `reverseExpression` | §5 | ✅ implemented |
| Enriched cross-entity expressions | §5 | ❌ no cross-entity reference in resolution pass |
| Per-field timestamps (`lastModifiedField`) | §5 | 🔶 shadow state has per-field data; config key not implemented |
| `normalize` (precision-loss noop) | §5 | ❌ raw value diff only; normalization layer not designed |
| Soft-delete field inspection | §6 | 🔶 connector handles; engine-level `soft_delete:` config not built |
| Hard delete / `derive_tombstones` | §6 | ❌ entity-absence detection not designed |
| Element hard delete (array) | §6 | ❌ depends on nested arrays + `written_state` |
| `reverse_required` | §6 | ❌ no per-field exclude-if-null in dispatch |
| Source-level noop (`_base` / shadow diff) | §7 | ✅ implemented — see [safety.md](safety.md) |
| Target-centric noop (`written_state`) | §7 | ✅ implemented — `written_state` table + `_dispatchToTarget` guard |
| `derive_timestamps` | §7 | ❌ depends on `written_state` at source level (§7.2 design) |
| Concurrent edit detection | §7 | 🔶 data is in shadow state; detection signal not wired |
| Custom sort (array ordering) | §8 | ❌ depends on nested arrays |
| CRDT ordinal ordering | §8 | ❌ depends on nested arrays |
| CRDT linked-list ordering | §8 | ❌ depends on nested arrays |
| Discriminator routing | §9 | ❌ depends on `filter` |
| Route combined (routing + merging) | §9 | ❌ depends on `filter` + transitive closure |
| Element-set resolution | §9 | ❌ depends on nested arrays |
| Multi-entity mapping files | §10 | ✅ implemented |
| `sources:` / `primary_key` metadata | §10 | 🔶 connectors declare entity schema; explicit `sources:` not in config |
| Mapping-level priority / `last_modified` | §10 | 🔶 field-level works; mapping-level default not in config |
| `passthrough` config | §10 | ❌ not in config spec |
| Inline test cases | §11 | ❌ no inline testing infrastructure |
| `_cluster_id` seed format | §11 | ❌ depends on inline testing |

### Summary

| Category | Total | ✅ | 🔶 | ❌ |
|----------|-------|----|----|-----|
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

### Highest-priority foundation work

The gaps cluster into three interconnected areas; unblocking them unlocks the most other primitives:

1. **Transitive closure identity** — union-find layer for `identityFields` / `identityGroups`. ✅ Implemented.
   Unblocks composite keys, external-link tables, FK resolution, multi-source merge, and N-way sync correctness.

2. **Nested array pipeline** — forward expand + reverse aggregate. Unblocks embedded-object nesting,
   scalar arrays, element-level deletion, CRDT ordering, and element routing.

3. **Filter and routing** — engine-level `filter` / `reverse_filter`. Unblocks discriminator
   routing, route-combined, `reverse_required`, and soft-delete propagation control.

4. **`written_state` table** — last-written snapshot per target. ✅ Implemented (§7.1).
   Foundation for derived timestamps (§7.2) and element tombstoning in nested array reassembly.
