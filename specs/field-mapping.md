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
    direction: bidirectional
    expression: (record) => `${record.firstName} ${record.lastName}`
    reverseExpression: (record) => ({
      firstName: record.fullName.split(' ')[0],
      lastName:  record.fullName.split(' ').slice(1).join(' '),
    })
```

`expression` is a TypeScript arrow function applied during the **inbound** pass (source → canonical). `reverseExpression` is applied during the **outbound** pass (canonical → source). Both have access to the full record, not just one field.

A `reverseExpression` that returns a plain object decomposes into multiple source fields (one-to-many). Any other return type is assigned to `source ?? target`.

The `direction` guard applies before expressions: `forward_only` entries are skipped on inbound (expression never runs); `reverse_only` entries are skipped on outbound (reverseExpression never runs).

When `expression` is present, the `source` field is not used on the inbound pass — the expression synthesises the value from any fields in the record.

**`sources` — lineage hint for expressions.** When `expression` is present, the optional `sources` array names the connector-side fields that the expression reads. This is a declaration for tooling (lineage diagram, static analysis) and has no effect at runtime. When `sources` is absent and `expression` is present, the lineage diagram shows an `(expression)` placeholder instead of per-field fan-in arrows.

```ts
{ target: "fullName", sources: ["firstName", "lastName"],
  expression: (r) => `${r.firstName} ${r.lastName}` }
```

**Status: implemented (OSI-mapping §5 "Field expressions"). `sources` implemented.**

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

**Status: implemented. Tests: `packages/engine/src/core/diff.test.ts` (N1–N4), `packages/engine/src/core/conflict.test.ts` (N5–N6).**

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

**Status: implemented. Tests: `packages/engine/src/core/mapping.test.ts` (DF1–DF7).**

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

**Status: implemented. Tests: `packages/engine/src/core/conflict.test.ts` (FG1–FG8).**

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

Custom incremental aggregation function for computing a canonical field from multiple sources.
Called during conflict resolution instead of `fieldStrategies[field]` and the global LWW strategy.

```typescript
// TypeScript embedded API only — not serialisable to YAML
{
  target: "score",
  resolve: (incoming: unknown, existing: unknown | undefined) => {
    return Math.max(Number(incoming) || 0, Number(existing) || 0);
  }
}
```

The incremental reducer receives `(incoming, existing)` where `existing` is the prior canonical
value (or `undefined` on first ingest). It runs after the group pre-pass and normalize
precision-loss guard. Takes precedence over `fieldStrategies[field]` when both are declared.

This form covers the practical OSI-mapping expression cases (max, min, sum, concat) without
requiring a full multi-source snapshot. A multi-snapshot resolver (collecting all
`{ value, sourceId, timestamp }` items) is a future follow-on.

**Status: implemented (OSI-mapping §1 "Expression"). Tests: `packages/engine/src/core/conflict.test.ts` ER1–ER6.**

---

### 2.4 `collect`

Returns an array of all contributed values without resolving to one. Useful for tag lists or
multi-source enum aggregations. Each ingest appends the incoming value if not already present
(set semantics — deduplicates by value). The accumulated array is stored in the target shadow
and used as the accumulator for subsequent ingests.

```yaml
fields:
  - target: tags
    resolve: collect
```

In YAML config, set `strategy: collect` inside `fieldStrategies`. In the TypeScript embedded API,
use the `resolve` function (§2.3) for custom collection logic.

**Status: implemented (OSI-mapping §1 "Collect"). Tests: `packages/engine/src/core/conflict.test.ts` RS1–RS4.**

---

### 2.5 `bool_or`

Resolves to `true` if any contributing source contributes a truthy value. Intended for deletion
flags that should propagate if *any* upstream marks the record deleted.

Once `true`, the field never reverts to `false` via this strategy — a later source sending `false`
or `null` does not overwrite a prior `true`. Resetting the flag requires removing it from all
sources' shadow states (outside scope of this strategy).

```yaml
conflict_resolution:
  fieldStrategies:
    isDeleted:
      strategy: bool_or
```

**Status: implemented (OSI-mapping §1 "Bool_or"). Tests: `packages/engine/src/core/conflict.test.ts` BO1–BO6.**

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

### 3.2 Nested array expansion (`array_path`)

A source record contains a JSON array column. Each array element becomes its own child entity row.
Both same-channel (parent source descriptor and child expansion in the same channel) and
cross-channel (parent in one channel, child in another) are supported.

**Configuration keys (mapping-entry level):**

| Key | Type | Meaning |
|-----|------|---------|
| `name` | `string` | Optional stable identifier. Required on any mapping that is referenced as `parent` by a child. Must be unique across all mapping files. |
| `parent` | `string` | Name of the parent mapping entry (`name` value). Child inherits the parent's connector and read source entity. `array_path` must also be set. |
| `array_path` | `string` | Dotted path to the JSON array column on the source record (e.g. `lines`, `order.lines`). Required when `parent` is set. |
| `parent_fields` | `Record<string, string \| { path?: string; field: string }>` | Parent source fields to bring into scope for element field mapping. Key = alias used in child `source:` entries; value = parent field name (string shorthand) or `{ path, field }` object for deep nesting. |
| `element_key` | `string` | Field name within each array element providing a stable element identity. Falls back to element index (`0`, `1`, …) when absent or when the element does not carry the field. |

**Same-channel example** — parent source descriptor and child expansion both in `order-lines`:

```yaml
# parent — source descriptor only; not a fan-out target in this channel
- name: erp_orders
  connector: erp
  channel: order-lines
  entity: orders

# child — expands the parent's records into per-line entities
- channel: order-lines        # same channel as parent
  parent: erp_orders          # inherits connector=erp; reads erp entity=orders
  array_path: lines
  parent_fields:
    order_id: order_id        # alias: parent field brought into child scope
  element_key: line_no
  fields:
    - source: line_no
      target: lineNumber
    - source: product_id
      target: productId
    - source: order_id        # available via parent_fields
      target: orderRef

# flat target — receives one record per expanded line
- connector: crm
  channel: order-lines
  entity: order_lines
  fields:
    - source: lineNumber
      target: lineNum
    - source: productId
      target: item
    - source: orderRef
      target: parentOrderId
```

**Cross-channel example** — parent is a full member of the `orders` channel; child is in `order-lines`:

```yaml
# mappings/orders.yaml — parent is a regular member of 'orders'
- name: erp_orders
  connector: erp
  channel: orders
  entity: orders
  fields:
    - source: order_id
      target: orderId

# mappings/order-lines.yaml — child references parent in a different channel
- connector: erp
  channel: order-lines          # different channel from parent
  entity: order_lines           # logical entity name in this channel
  parent: erp_orders            # references parent in 'orders' channel
  array_path: lines
  parent_fields:
    order_id: order_id
  element_key: line_no
  fields:
    - source: line_no
      target: lineNumber
    - source: product_id
      target: productId
    - source: order_id
      target: orderRef
```

**Forward pass (per `ingest(channelId, connectorId)` call on a child member):**

1. Resolve the source entity to read: inherited from parent mapping (`parent.entity`).
2. Read parent records via `connector.read(sourceEntity, watermark)`.
3. For each parent record:
   a. Echo-check against stored parent `shadow_state` (keyed on source entity name). If unchanged, skip all child expansion.
   b. If changed: update parent `shadow_state`; proceed to child expansion.
   c. For each element at index `i`:
      - `elementKeyValue` = `element[element_key]` if set; otherwise `String(i)`.
      - `childExternalId` = `${parentExternalId}#${array_path}[${elementKeyValue}]`.
      - Merge `parent_fields` values into element (element fields win on collision).
      - Apply child member's inbound field mapping.
      - Derive `childCanonicalId` deterministically from parent canonical ID and element key. Formula: SHA-256 of `opensync:array:${parentCanonicalId}:${array_path}[${elementKeyValue}]`, formatted as a UUID.
   d. Fan-out each child record to non-source channel members. Written_state noop suppression applies per element — only changed elements are dispatched.
   e. Record the source connector's child external ID in `identity_map` (`childCanonicalId → sourceConnectorId → childExternalId`) and write a `shadow_state` row for it (entity = child member's logical entity name). This is idempotent (`INSERT OR IGNORE`) across poll passes and enables `getChannelIdentityMap` to return a non-null slot for the array-source member.
4. Watermark stored for `(connectorId, entity)` where `entity` = child member's logical entity name (not the inherited source entity).

**Source shadow semantics:**

- **Parent records**: `shadow_state` **is** written (entity = inherited source entity, e.g. `orders`). Echo detection operates at the parent level.
- **Child records**: `shadow_state` **is** written for the source side (entity = child member's logical entity name, e.g. `order_lines`). This shadow row exists solely to enable `getChannelIdentityMap` to join `identity_map` with `shadow_state` and return a non-null slot for the array-source member. Per-element change detection still relies on the written_state mechanism (§7.1) — unchanged elements are suppressed by written_state, not by source shadow comparison.

**Same-channel source descriptors:**

A mapping entry with `name:` that is referenced as `parent` by another entry **in the same channel** is a source descriptor. It is retained in the global named-mapping index but is **not** added to the channel's member list and is never itself a fan-out target in that channel. The child member (with `parent:`) is the real channel member, inheriting the connector and source entity.

In the **cross-channel** case, the parent entry is a full member of its own channel and participates in that channel's fan-out independently.

**Validation rules (config load time):**

- `parent` must name a mapping that has a matching `name:` field — reject if not found.
- `array_path` is required when `parent` is set — reject if absent.
- The child inherits the parent's `connector`. Cross-connector parent references are rejected.
- Cross-channel: the inherited source entity must be declared in the connector's `getEntities()`.
- Same-channel source descriptor entries must not declare `array_path` themselves.

**Watermark independence (cross-channel):**

`ingest('orders', 'erp')` and `ingest('order-lines', 'erp')` both call `erp.read('orders', ...)` but advance independent watermarks: `(erp, orders)` and `(erp, order_lines)`. This means the ERP orders entity is read twice per cycle when both channels are active. A shared-read cache within a cycle is a planned optimisation.

**Reverse pass:** Re-assembling expanded elements back into an embedded array for write-back to the source is implemented via the collapse mechanism (§3.4).

**Element filters (`filter` / `reverse_filter`):**

Two optional config keys may be added to any array expansion member (source descriptor entries do not use them). The same `filter` / `reverse_filter` keys are also used on flat (non-array) members as record-level filters — see §5. The compilation path and **bindings differ by context**:

- **Array expansion member** (has `array_path` or `parent`): bindings are `element`, `parent`, `index`.
- **Flat member** (no `array_path`): binding is `record`. See §5.1 / §5.2.

| Key | Pass | Effect (array expansion members) |
|-----|------|----------------------------------|
| `filter` | Forward (inbound) | Only elements for which the expression returns truthy are expanded, canonicalised, and dispatched. Elements that fail the filter are ignored entirely for that pass. |
| `reverse_filter` | Reverse (outbound) | Only elements for which the expression returns truthy receive collapse patches. Elements that fail are left unchanged in the source array. |

Both values are JS expression strings compiled once at engine startup via `new Function`. A compilation failure is detected immediately at load time. Bindings for array expansion: `element` (the current array element object, after `parent_fields` merge), `parent` (the parent source record's raw data), `index` (zero-based element position).

```yaml
- connector: erp
  channel: order-lines
  parent: erp_orders
  array_path: lines
  filter: "element.type === 'product'"
  reverse_filter: "element.status !== 'locked'"
  element_key: line_no
  fields:
    - source: line_no
      target: lineNumber
```

For multi-level chains the filter applies at the **leaf level only** — intermediate expansion levels are unaffected.

Security note: `new Function` executes arbitrary JS. Use a dedicated per-connector worker (or disable this feature at the engine level) in untrusted multi-tenant deployments. See `plans/engine/PLAN_ELEMENT_FILTER.md §4`.

**Status: implemented. (OSI-mapping §3 "Nested arrays").**

---

### 3.3 Scalar arrays

```yaml
    array_path: tags
    scalar: true           # elements are bare strings, not objects
```

When `scalar: true`, each bare-scalar element is wrapped as `{ _value: element }` before inbound
mapping. The element identity is `String(element)` (set semantics — duplicate values share the
same canonical ID). `element_key` is mutually exclusive with `scalar: true`.

In `filter` expressions, `element` is the **raw scalar value** (not the wrapped object).

Reverse pass (collapse) is not yet implemented for scalar arrays.

**Status: forward pass implemented (OSI-mapping §3 "Scalar arrays"). Reverse pass planned follow-on. Tests: `array-expander.test.ts` SA1–SA9.**

---

### 3.4 Deep nesting

```yaml
  - name: erp_orders
    connector: erp
    channel: orders
    entity: orders

  - name: erp_lines
    connector: erp
    channel: line-components
    parent: erp_orders
    array_path: lines
    element_key: lineNo

  - name: erp_components          # grandchild of orders
    connector: erp
    channel: line-components
    parent: erp_lines
    array_path: components
    element_key: compNo

  - connector: warehouse
    channel: line-components
    entity: components
    fields: [...]
```

Multi-level parent chains (`parent:` chains of depth ≥ 2). The leaf member (the entry without
`name:` that is added to the channel's member list) inherits the root-most ancestor connector and
source entity. Intermediate named entries are source descriptors in their own channels.

**Expansion chain (`expansionChain`):**

At config load time, `resolveExpansionChain` walks the `parent` chain of the leaf member upward
and builds an ordered list of `ExpansionChainLevel` values, outermost first:

```
[{ arrayPath: "lines", elementKey: "lineNo" },
 { arrayPath: "components", elementKey: "compNo" }]
```

The leaf member's `sourceEntity` is set to the root ancestor's `entity` name (e.g. `"orders"`).

`expandArrayChain(record, chain)` performs a recursive cross-join: each level of the chain
expands all records from the previous level, producing a flat set of leaf records. A two-level
chain over 1 order with 2 lines each having 2 components produces 4 leaf records.<br>
Leaf external IDs use a composite formula:
`${parentId}#${arrayPath1}[${key1}]#${arrayPath2}[${key2}]`.

**Canonical IDs for intermediate and leaf nodes:**

Each hop derives its canonical ID deterministically:
- Level 1 (line): `deriveChildCanonicalId(parentCanonicalId, "lines", lineNo)`
- Level 2 (component): `deriveChildCanonicalId(lineCanonicalId, "components", compNo)`

**`array_parent_map` table:**

Every hop writes one row to `array_parent_map`:

| column | value |
|--------|-------|
| `child_canon_id` | canonical ID of the child node |
| `parent_canon_id` | canonical ID of its direct parent |
| `array_path` | the array path used at this hop |
| `element_key` | the element key value at this hop |

For a two-level chain, each leaf records two rows (leaf→line, line→root).

**Reverse collapse (write-back):**

When a flat target connector writes a change back to the system, the engine must reassemble that
change into the correct slot of the original embedded-array structure and call `update` on the
root source connector.

1. **Identify collapse targets**: channel members with `sourceEntity` set (i.e. array-source
   members) are collapse targets for the other members in the channel.
2. **Walk `array_parent_map`**: starting from the flat record's canonical ID,
   `_walkCollapseChain` follows `parent_canon_id` pointers upward until it reaches a canonical ID
   whose `identity_map` entry for the source connector is present. That is the root parent.
3. **Batch per root**: all flat-record changes targeting the same root parent are collected into
   a `CollapsePatch` list.
4. **`_applyCollapseBatch`**: for each root, (a) load the current parent record via
   `connector.lookup` (falls back to shadow state), (b) deep-clone the data, (c) apply each
   patch with `patchNestedElement` — which navigates the chain's `arrayPath` list, finds the
   matching element by key value, and merges only the patch fields (preserving unmapped fields),
   (d) call `connector.update` with the patched record, (e) update shadow state.
5. **Partial patch semantics**: only fields present in the outbound mapping are overwritten.
   Other element fields are preserved exactly as they exist in the current parent record.

**Validation rules:**

- All entries in a `parent` chain must belong to the same connector — cross-connector chains are rejected at config load time.
- Cycles in `parent` chains are detected at config load time and cause a fatal error.

**Status: implemented. (OSI-mapping §3 "Deep nesting").**

---

## 4. Foreign Key References

### 4.1 PK as a canonical field (`id_field`)

Some connectors include their primary key in `record.data` alongside other fields.
A field mapping with `source: "<fieldName>"` captures it directly — no engine change
is needed.

Other connectors treat the PK as a transport-layer identifier and deliberately omit it
from `record.data`. In those cases the optional `id_field` property on a channel member
tells the engine to inject `record.id` into the stripped data map under the given name
before running `applyMapping`:

```yaml
- connector: erp
  channel: accounts
  entity: accounts
  id_field: erpId          # inject record.id as "erpId" before mapping
  fields:
    - source: erpId
      target: erpId        # erpId now appears in canonical
    - source: name
      target: name
```

The full cross-connector FK pattern then requires no special engine mechanism beyond
this:

1. ERP declares `id_field: erpId` so `record.id = "ACC-001"` becomes available as
   `erpId` in the mapping scope.
2. HubSpot maps `source: erp_account_id, target: erpId` — pointing its custom
   property at the same canonical field.
3. Both sides carry the stable string `"ACC-001"`. No UUID translation; no special
   engine path.

**Precedence:** if the connector also provides the field in `record.data`, the
connector value wins (`{ ...idBase, ...raw }` — data overwrites the injection).

**Direction:** to prevent the injected PK from being written back as a data field
when the engine dispatches updates to the same connector, add
`direction: reverse_only` on the mapping entry. `reverse_only` reads the field into
canonical on the forward pass but excludes it from the outbound payload.

**Status: implemented (specs/field-mapping.md §4.1).**

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

`filter` and `reverse_filter` are unified config keys. The **bindings** differ by context:

| Mapping entry type | `filter` bindings | `reverse_filter` bindings |
|--------------------|-------------------|---------------------------|
| Flat (no `array_path`) | `record` — raw source record | `record` — outbound-mapped record |
| Array expansion (has `array_path`) | `element`, `parent`, `index` | `element`, `parent`, `index` |

Both are plain JS expressions (not arrow functions). Compiled once at load time via `new Function`.

### 5.1 Source filter (`filter`)

Include only source records that match a condition in the forward pipeline:

```yaml
  - connector: erp
    channel: contacts
    entity: customers
    filter: "record.type === 'customer'"
```

Records that do not match the filter are excluded from resolution and produce no canonical delta. If
a record previously matched but no longer does, its shadow state is cleared (soft-delete signal:
the canonical entity falls back to other contributing sources, or becomes empty).

**Status: implemented (OSI-mapping §5 "Filters"). Tests: `packages/engine/src/engine.ts` record filter path (RF1–RF4).**

---

### 5.2 Reverse filter (`reverse_filter`)

Exclude canonical entities from being written back to a specific connector:

```yaml
  - connector: crm
    channel: contacts
    entity: contacts
    reverse_filter: "record.status !== 'archived'"
```

The binding `record` is the **outbound-mapped** record (after applying the member's `outbound`
field mapping). Entities that fail the filter are silently skipped for this connector; no
`written_state` row is written, so the filter is re-evaluated on the next cycle.

**Status: implemented (OSI-mapping §5 "Filters").**

---

### 5.3 Discriminator routing

A single source entity type fans out to different canonical targets based on a field value. Use a
separate mapping entry per channel with a `filter`:

```yaml
  - connector: erp
    channel: customers
    entity: contacts
    filter: "record.role === 'customer'"

  - connector: erp
    channel: staff
    entity: people
    filter: "record.role === 'employee'"
```

Each channel is processed independently. The ERP connector appears in both but with different
filters and different canonical targets. For merge patterns (different sources → same canonical
target with different filters) identity linking handles the merge once filters are applied.

**Status: implemented via §5.1 record filters (OSI-mapping §9 "Discriminator routing"). Within-channel variant not supported.**

---

## 6. Ordering (Nested Arrays)

All three ordering strategies depend on nested array expansion (§3.2). They are applied during
the reverse collapse pass, after all element patches are merged and before `connector.update`.
Only one strategy may be declared per mapping entry (mutual exclusion enforced at load time).

### 6.1 Custom sort

When reassembling a nested array on the reverse pass, sort by one or more declared field names:

```yaml
    order_by:
      - field: lineNumber
        direction: asc   # default
      - field: productCode
        direction: desc  # optional secondary key
```

Multi-key comparison: fields are compared in order; numeric values are compared numerically
(both sides parse as finite number); otherwise compared as locale-insensitive strings.
Applied immediately after all element patches are applied, before write-back.

**Status: implemented (OSI-mapping §8). Tests: `array-expander.test.ts` OR1–OR5.**

### 6.2 CRDT ordinal

Inject a synthetic `_ordinal` field from source array position on the forward pass, enabling
stable ordering across merges from multiple sources:

```yaml
    order: true    # auto-assign ordinal from source position
```

`_ordinal` (0-based source index) is stored in the child shadow and participates in LWW
resolution across sources. During collapse, elements are sorted by `_ordinal` ascending;
elements without `_ordinal` sort last. The field is stripped before write-back unless mapped
explicitly in `outbound`.

**Status: implemented (OSI-mapping §8). Tests: `array-expander.test.ts` OR6–OR9.**

### 6.3 Linked-list ordering

Store adjacency pointers (`_prev`, `_next`) for linked-list ordering:

```yaml
    order_linked_list: true
```

`_prev` is the element key of the preceding sibling (`null` for the head); `_next` is the key
of the following sibling (`null` for the tail). Both enter shadow state and participate in LWW.
During collapse, the head is found (element whose `_prev` is null or absent from the map),
then the chain is walked via `_next`. Remaining elements (broken chain or cycle) are appended
in their current order. A cycle guard (max iterations = array length) prevents infinite loops.
Both fields are stripped before write-back unless mapped explicitly.

**Status: implemented (OSI-mapping §8). Tests: `array-expander.test.ts` LL1–LL4.**

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

**Status: implemented. `isDispatchBlocked()` in `core/mapping.ts`; guard in `engine.ts` fan-out loop. Tests: `packages/engine/src/core/mapping.test.ts` (RR1–RR6).**

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
| Composite keys (`link_group`) | §2 | ✅ `identityGroups` (AND-within-group, OR-across-groups); tests T-LG-1–T-LG-4 |
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
| `references` (FK field) | §4 | ✅ `id_field` + plain field mapping (§4.1); UUID-translation approach deferred |
| FK reverse resolution | §4 | ✅ `direction: reverse_only` excludes injected PK from outbound dispatch |
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
| References & FKs | 5 | 2 | 1 | 2 |
| Field-level controls | 8 | 1 | 3 | 4 |
| Deletion & tombstones | 4 | 0 | 1 | 3 |
| Change detection & noop | 4 | 1 | 1 | 2 |
| Ordering | 3 | 0 | 0 | 3 |
| Routing & partitioning | 3 | 0 | 0 | 3 |
| Mapping config & metadata | 4 | 1 | 2 | 1 |
| Testing | 2 | 0 | 0 | 2 |
| **Total** | **50** | **8** | **14** | **28** |

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
