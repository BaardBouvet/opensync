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
| `reverse_only`    | ✗                            | ✓                            |
| `forward_only`    | ✓                            | ✗                            |

```yaml
fields:
  - source: internalNotes
    target: notes
    direction: forward_only   # read from this source; never written back to connector
  - source: syncedFrom
    target: _origin
    direction: reverse_only   # injected when writing to this connector; not read on ingest
```

`forward_only` is used for read-only audit connectors or any field the engine should never write back. `reverse_only` is used for constant
injections, computed fields that must appear in the outbound payload but are never read from the source.

**Status: implemented (OSI-mapping §5).**

---

### 1.3 Field expressions

`expression` and `reverse_expression` are JS expression strings compiled once at load time via
`new Function`. Both are available in YAML config files and in the TypeScript embedded API.

```yaml
fields:
  - source: firstName
    target: firstName
  - source: lastName
    target: lastName
  - target: fullName
    sources: [firstName, lastName]   # lineage hint (optional)
    expression: "`${record.firstName} ${record.lastName}`"
    reverse_expression: "({ firstName: record.fullName.split(' ')[0], lastName: record.fullName.split(' ').slice(1).join(' ') })"
```

The YAML key is **`expression`** (forward) and **`reverse_expression`** (reverse). Bindings:
- `expression`: `record` — the full incoming source record; return value assigned to `target`.
- `reverse_expression`: `record` — the full canonical record; return a plain object to decompose
  into multiple source fields, or any other value to assign to `source ?? target`.

In the TypeScript embedded API the same fields accept typed function values:

```ts
{ target: "fullName", sources: ["firstName", "lastName"],
  expression: (r) => `${r.firstName} ${r.lastName}`,
  reverseExpression: (r) => ({ firstName: r.fullName.split(' ')[0], lastName: r.fullName.split(' ').slice(1).join(' ') }) }
```

Note: the TypeScript API uses camelCase (`reverseExpression`); the YAML key uses snake_case
(`reverse_expression`). Both compile to the same `FieldMapping.reverseExpression` function.

The `direction` guard applies before expressions: `forward_only` entries are skipped on outbound
(reverseExpression never runs); `reverse_only` entries are skipped on inbound (expression never runs).

When `expression` is present, `source` is ignored on the inbound pass.

**`sources` — lineage hint.** Names the connector-side fields the expression reads. Declaration
only — no runtime effect. Without it, the lineage diagram shows an `(expression)` placeholder.

**Status: implemented (OSI-mapping §5 "Field expressions"). YAML `expression`/`reverse_expression` implemented. `sources` implemented.**

---

### 1.4 Normalize (precision-loss noop)

Some connectors store values at lower fidelity than the canonical model: phone numbers with
different formatting, floats rounded to fewer decimal places, strings truncated by a VARCHAR limit,
dates without time components. Without normalization these apparent differences register as changes
every cycle, causing an infinite update loop.

`normalize` is a transform applied to **both the incoming value and the stored shadow value** before
the noop diff check. It does not alter the value written to the canonical model or to the target —
it is purely a diff-time comparator.

`normalize` is a JS expression string compiled via `new Function`. Available in both YAML and
the TypeScript embedded API. Binding: `v` — the raw field value.

```yaml
fields:
  - source: phone
    target: phone
    normalize: "String(v).replace(/\\D/g, '')"   # strip all non-digits before comparing
  - source: score
    target: score
    normalize: "Number(v).toFixed(2)"           # normalize float precision
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
- connector: erp
  channel: contacts
  entity: customers
  passthrough: [raw_segment_code, internal_account_ref]
  fields:
    - source: name
      target: customerName
```

Fields listed under `passthrough` are **preserved for same-source roundtrip write-back only**.
They do not enter the canonical record, do not participate in resolution, and are never dispatched
to any other connector.

**Use case:** connectors that use a full-replace (PUT) write API require all fields to be present
in the update payload, even fields that are not part of the canonical schema. Without `passthrough`,
the engine's outbound payload only contains mapped fields — the connector would silently zero any
unmapped field on write-back.

**Forward pass:** passthrough fields are read from `record.data` and stored in the source
connector's `shadow_state` row under a `_pt.<fieldName>` reserved key. They are not added to the
canonical record.

**Reverse pass:** when the engine dispatches an update back to **the same connector**, the `_pt.*`
shadow entries are merged into the outbound `UpdateRecord.data` after the reverse field mapping,
so the connector receives its own fields back unchanged. They are stripped from outbound payloads
to all other connectors.

**If you want a field to reach a different connector**, declare it in the channel mapping with
appropriate `direction`. Passthrough is a same-source preservation mechanism, not a routing tool.

**Status: designed, not yet implemented (OSI-mapping §3 "Passthrough columns"). See `plans/engine/PLAN_PASSTHROUGH_COLUMNS.md`.**

---

### 1.7 JSON sub-field extraction (`source_path`)

```yaml
fields:
  - source_path: address.street   # dotted JSON path within the source record
    target: street
  - source_path: address.city
    target: city
  - source_path: metadata.tags[0]   # array index — forward_only only (see below)
    target: primaryTag
    direction: forward_only
```

`source_path` extracts a value from a nested path within the source record without requiring
the connector to pre-extract it. Path syntax:

- `.` separates object keys (`address.street`).
- `[N]` (non-negative integer) indexes into an array (`lines[0].product_id`).
- Missing intermediates resolve to `undefined` (not an error); `undefined` falls through to
  `default` if configured.

Mutually exclusive with `source`. When only `source_path` is present, the leaf key of the path
is used as the effective source name for lineage display.

**Forward pass (source → canonical):** the path is walked on the raw source record; the extracted
value is then subjected to the same pipeline as a plain `source` field (`expression`, `normalize`,
`default`, `direction`).

**Reverse pass (canonical → source):** the outbound-mapped value is placed at the nested location
in the write payload by reconstructing the path. Multiple fields sharing the same path prefix are
merged into the same nested object (`address.street` + `address.city` → `{ address: { street, city } }`).

**Array-index write-back restriction:** `source_path` with an `[N]` token is only allowed on
`forward_only` fields (inbound only, no write-back). Using an array-index token on a
`bidirectional` or `reverse_only` field raises a config validation error at load time, since
writing to a positional index within an existing array is not supported. Use `array_path`
expansion or `reverse_expression` for that case.

`source_path` is valid inside `element_fields` entries; the path resolves relative to each
element object, not the parent record.

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

Connectors that expose per-field modification timestamps (e.g. Salesforce field history, HubSpot
property-level timestamps) surface them via `ReadRecord.fieldTimestamps`:

```typescript
{
  id: contact.id,
  updatedAt: contact.updatedAt,
  fieldTimestamps: {
    email: contact.properties.email_last_updated,   // ISO 8601
    phone: contact.properties.phone_last_updated,
  },
  data: {
    email: contact.properties.email,
    phone: contact.properties.phone,
  },
}
```

The connector excludes timestamp columns from `data` so they never pollute the canonical record.
The engine picks them up from `fieldTimestamps` automatically — no mapping configuration needed.

Priority chain used by the engine for each field:
1. `record.fieldTimestamps[field]` — connector-native per-field authority
2. Shadow derivation: unchanged field → `max(shadow.ts, ingestTs)`; changed field → `record.updatedAt ?? ingestTs`
3. `ingestTs` — new record with no shadow

**Status: implemented. See `specs/connector-sdk.md § ReadRecord` and
`packages/engine/src/core/mapping.ts` (`computeFieldTimestamps`).**

---

## 2. Resolution Strategies

Resolution determines how the canonical value for a field is chosen when multiple connectors in the
same channel contribute a value for it. Declared per-field (or mapping-wide as a default).

> The authoritative reference for all resolution strategies, connector priorities, field masters,
> and per-channel conflict config is `specs/channels.md`. The subsections below document the
> YAML/TypeScript config syntax at the field-mapping level.

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

The `last_modified` config key for pulling a timestamp column into the engine is superseded by
`ReadRecord.updatedAt` — the connector should populate that field directly. No config is needed.

Stable tie-breaking: when two fields have equal timestamps and both sources supply `createdAt`,
the source whose `createdAt` is **later** (younger) loses — the older source is treated as the
origin that should not be overwritten by a downstream copy with the same modification time.

**Status: implemented.**

---

### 2.3 Expression resolvers

Custom incremental aggregation function for computing a canonical field from multiple sources.
Called during conflict resolution instead of `fieldStrategies[field]` and the global LWW strategy.

`resolve` is a JS expression string compiled via `new Function`. Available in both YAML and the
TypeScript embedded API. Bindings: `incoming` (value from the current source), `existing` (prior
canonical value, `undefined` on first ingest).

```yaml
fields:
  - source: score
    target: score
    resolve: "Math.max(Number(incoming) || 0, Number(existing) || 0)"
```

TypeScript embedded API (same field, function value instead of string):

```ts
{
  target: "score",
  resolve: (incoming: unknown, existing: unknown | undefined) =>
    Math.max(Number(incoming) || 0, Number(existing) || 0)
}
```

The reducer runs after the group pre-pass and normalize precision-loss guard. Takes precedence
over `fieldStrategies[field]` when both are declared.

A multi-snapshot resolver (collecting all `{ value, sourceId, timestamp }` items) is a future
follow-on.

**Status: implemented (OSI-mapping §1 "Expression"). YAML `resolve` string form implemented. Tests: `packages/engine/src/core/conflict.test.ts` ER1–ER6.**

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

In YAML config, set `strategy: collect` as a direct field entry under `conflict:`. In the TypeScript embedded API,
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
channels:
  - id: my-channel
    fields:
      isDeleted:
        strategy: bool_or
```

**Status: implemented (OSI-mapping §1 "Bool_or"). Tests: `packages/engine/src/core/conflict.test.ts` BO1–BO6.**

---

## 3. Structural Transforms

### 3.1 Embedded objects (flat parent mapping)

One source record maps to a parent entity and one or more child entities whose fields are columns
on the **same source row** (no array — a 1:1 sub-entity).

```yaml
- name: erp_contacts           # name: required so child can reference it
  connector: erp
  channel: contacts
  entity: contacts
  fields:
    - source: email
      target: email

- channel: contacts
  entity: addresses             # child entity
  parent: erp_contacts          # references name: above — inherits connector=erp, entity=contacts
  fields:                       # fields from the SAME row as the parent record
    - source: ship_street
      target: street
    - source: ship_city
      target: city
    - source: ship_zip
      target: zip
```

`parent:` references the `name:` of another mapping entry — the same convention as array
expansion. The child inherits the parent's source connector and source entity. `connector:` on
the child is optional and must match the inherited value if present.

The child entity's external ID is derived deterministically: `<parent_external_id>#<child_entity>`.
Multiple children may reference the same parent `name:`; each produces an independent canonical
entity. Children may themselves be named and referenced as the parent of further embedded children
(chaining is supported — all levels read from the root ancestor's source row).

On the reverse pass, child entity fields are written back alongside parent fields in the same
`UpdateRecord`.

**Status: implemented. Tests: `packages/engine/src/embedded-objects.test.ts` EO1–EO7. See `plans/engine/PLAN_EMBEDDED_OBJECTS.md`.**

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

**Reverse pass** (scalar collapse): `_scalarCollapseRebuild` reconstructs the full scalar array at
collapse time. It loads all canonical children via `dbGetArrayChildrenByParent`, skips any child
whose `dbGetCanonicalFields` returns `{}` (indicating a cascade-deleted element), and assembles the
bare scalar array from each surviving child's `_value` canonical field. Element absence triggers
cascade shadow deletion to all channel member connectors so deleted elements are reliably excluded
from the next rebuild. `reverse_filter` receives the raw scalar value as `element`; `order: true`
sorts by `_ordinal` ascending.

**Status: forward + reverse pass implemented (OSI-mapping §3 "Scalar arrays"). Tests: `array-expander.test.ts` SA1–SA9, `scalar-route-element.test.ts` SC1–SC8.**

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

### 3.5 Atomic arrays

An array-valued field that should be owned by one source and replaced in its entirety when it
changes — with no per-element tracking — can be mapped as a **plain field** without `array_path`.
The engine stores the JSON blob in shadow state; normal resolution strategies (coalesce,
last_modified, field_master) pick the winning source's entire array value; fan-out delivers the
full array to other connectors as a field value.

**When to use atomic vs `array_path`:**

| Need | Use |
|------|-----|
| One source owns the whole array; API is full-replace | Atomic (no `array_path`) |
| Items from multiple sources may coexist; per-element conflict resolution needed | `array_path` channel expansion |
| Targets need item-level `insert`/`update` rather than full-array replace | `array_path` channel expansion |

**Order-insensitive diff:** by default the diff is order-sensitive (`JSON.stringify` comparison).
Two independent mechanisms switch it to order-insensitive (OR'd together):

1. **Connector schema `unordered: true`** — on the array's `FieldType`:
   ```typescript
   // packages/sdk/src/types.ts
   { type: "array", items: "string", unordered: true }
   ```
   When the source connector's schema declares `unordered: true`, the engine sorts elements
   before comparing. Schema-guided recursion descends through `object` properties that
   themselves contain unordered arrays.

2. **Mapping `sort_elements: true`** — on a `FieldMappingEntry`:
   ```yaml
   fields:
     - source: tags
       target: tags
       sort_elements: true
   ```
   Useful when the connector schema is absent, omits `unordered`, or the operator knows this
   particular sync doesn't care about element order.

**`element_fields`** — per-element field mapping without expansion:

When multiple connectors represent the same logical array but with different element field
names, `element_fields` applies rename/expression/direction mappings to every element object
before the array is stored canonically — without expanding elements into separate child
entities and without any per-element canonical ID allocation.

```yaml
- connector: erp
  channel: orders
  entity: orders
  fields:
    - source: lines
      target: lines
      sort_elements: true
      element_fields:
        - source: line_no
          target: lineNumber
        - source: unit_price
          target: unitPrice

- connector: crm
  channel: orders
  entity: orders
  fields:
    - source: lines
      target: lines
      direction: reverse_only    # CRM receives the canonical array on write-back; not read from CRM on ingest
      sort_elements: true
      element_fields:
        - source: lineNum
          target: lineNumber
        - source: price
          target: unitPrice
```

`element_fields` is self-referential: a nested array field within an element can carry its own
`element_fields` and `sort_elements` at any depth. It supports the **transform** sub-set of
field-mapping primitives: `source`/`target` rename, `source_path`, `expression`/`reverse_expression`,
`default`, `direction`, and `sort_elements`. It does **not** support resolution primitives
(`group`, `resolve`, `priority`, `reverseRequired`) — cross-source arbitration applies at the
whole-array level, not per-element-field.

`element_fields` is **mutually exclusive** with `array_path` on the same field entry — a
config validation error is raised at load time. Both keys at every nesting level are validated.

**Status: implemented (OSI-mapping §3 "Atomic arrays"). `sort_elements` + `unordered` wired in `diff.ts` via schema-guided recursive normaliser; `element_fields` applied in `applyMapping` / `applyElementFields` in `core/mapping.ts`. Tests: `diff.test.ts` AA1–AA5, `mapping.test.ts` EF1–EF8.**

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
`direction: forward_only` on the mapping entry. `forward_only` reads the field into
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

### 5.4 Route combined

A filtered mapping entry and an unfiltered mapping entry from different sources merge into the
**same canonical entity** via identity linking. Example: ERP provides all contacts; CRM provides
only "customer"-type contacts with enriched billing data. Both contribute to the same `contacts`
channel.

```yaml
channels:
  - name: contacts
    members:

      - connector: erp
        entity: contacts
        fields: [id, name, email]
        # no filter — all ERP contacts flow through

      - connector: crm
        entity: crm_contacts
        filter: "record.type === 'customer'"
        reverse_filter: "record.status !== 'archived'"
        fields:
          - source: id
            target: id
          - source: name
            target: name
          - source: billingCode
            target: billingCode
```

Each source writes its own shadow row independently; the CRM shadow is only present for records
whose `filter` passes. Clearing the CRM shadow (when `filter` no longer matches) does not touch the
ERP shadow — the canonical entity survives with the ERP fields. Ingest order does not affect the
stable end-state. `reverse_filter` on the CRM member suppresses write-back for archived records
without affecting the ERP member's dispatch.

**Status: implemented and validated (OSI-mapping §9 "Route combined"). Tests: `scalar-route-element.test.ts` RC1–RC6.**

---

### 5.5 Element-set resolution

When multiple sources contribute elements to the same nested array, the engine applies an ES
resolution pre-step at collapse time before writing the merged array back to targets.

**Element grouping:** patches from all contributing sources are grouped by their leaf `elementKey`.
For each element key a winner is chosen:

1. **`connectorPriorities`** — source with the numerically **lowest** priority number wins.
2. **`last_modified` fieldStrategy** — if both sources provide per-field timestamps
   (`record.fieldTimestamps`), the source with the more-recent timestamp for that field wins.
3. **`fieldMasters`** — a per-field master declaration. For a given field, only patches from the
   declared master connector contribute that field's value. Patches from non-master sources have
   the field stripped before the element is applied. This applies even to single-patch batches
   (no merging required).

Config example:

```yaml
channels:
  - name: order-lines
    fields:
      connectorPriorities:
        erp: 1
        marketplace: 2
      qty:
        strategy: coalesce
      fieldMasters:
        price: erp          # only ERP may set price; marketplace patches have price stripped
    members:
      - connector: erp
        entity: orders
        array_path: lines
        element_key: lineNo
        ...
      - connector: marketplace
        entity: order_items
        array_path: items
        element_key: sku
        ...
```

**Status: implemented (OSI-mapping §9 "Element-set resolution"). ES pre-step in `_applyCollapseBatch`; `fieldMasters` single-patch filtering applied to all patch batches. Tests: `scalar-route-element.test.ts` ES1–ES7.**

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

### 7.2 Per-field timestamp derivation (always-on)

For every incoming record on every ingest cycle the engine computes a per-field timestamp map
rather than using a flat batch-wide `ingestTs`. No configuration is required.

Priority chain (highest to lowest):
1. `record.fieldTimestamps[field]` — connector-native (see §1.9)
2. `record.updatedAt` (parsed to epoch ms) — applies to all fields not in `fieldTimestamps`
3. Shadow derivation:
   - **Unchanged field** (`incoming[field] == shadow[field].val`): `max(shadow[field].ts, ingestTs)`
   - **Changed field** or new field: `record.updatedAt ?? ingestTs`
4. `ingestTs` — fallback for new records with no shadow

Baseline for shadow derivation is `shadow_state` (last value *read* from the connector), not
`written_state`. Rationale: `shadow_state` is always present for source connectors; `written_state`
is only populated for connectors the engine has written to. A read-only connector will never have
a `written_state` row. The `max(shadow.ts, ingestTs)` floor prevents a source-shadow timestamp
from a prior `collectOnly` pass from causing LWW to lose against a target shadow written at a
later `ingestTs`.

The computed map is passed to both `resolveConflicts` and `buildFieldData`, so shadow state stores
accurate per-field modification times even for connectors that report no timestamps at all.

**Status: implemented. See `packages/engine/src/core/mapping.ts` (`computeFieldTimestamps`,
`parseTs`) and `packages/engine/src/engine.ts` (`_processRecords`).**

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

All deletion primitives are opt-in at the channel level. Enable fan-out deletion via the
channel's `propagateDeletes` flag:

```yaml
channels:
  - name: contacts
    propagateDeletes: true   # engine calls entity.delete() on target connectors when a source record is deleted
```

Without `propagateDeletes: true`, deletions are still tombstoned in shadow state but are **not**
pushed to target connectors. The default is `false`.

---

### 8.1 Connector-reported deletion

Connectors signal deletion in two ways:

1. Emit a `ReadRecord` with `deleted: true` during `read()`.
2. Stop returning a previously-seen record (absence detection — only reliable in full-snapshot
   connectors, not watermark-based; see §8.3).

The engine processes the `deleted` flag in `_processRecords` before echo detection and field
mapping. When the flag is set (either directly by the connector or via soft-delete inspection §8.2):

1. The source shadow row is tombstoned: `deleted_at` is set to the current UTC timestamp.
2. A `SyncAction = "delete"` result is pushed.
3. If `propagateDeletes: true` on the channel (§8 intro), the engine calls `entity.delete()` on
   each target connector that has a mapped identity for this canonical entity.

A subsequent ingest of the same `externalId` without `deleted: true` is treated as a resurrection:
`dbSetShadow` resets `deleted_at` to NULL and resumes normal processing.

**Status: implemented.** Tests: `packages/engine/src/delete-propagation.test.ts` (T-DEL-01–T-DEL-08).

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
- `deleted_flag`: `record[field] !== false && record[field] != null` → row is deleted
- `timestamp`: `record[field] != null` → row is deleted
- `active_flag`: `record[field] !== true` → row is deleted (null counts as inactive)
- `expression`: arbitrary JS expression; binding is `record`

The engine evaluates the predicate on the raw stripped record before echo detection or field
mapping, then sets `record.deleted = true`. The deletion then follows the same path as §8.1.

**Status: implemented.** `soft_delete:` key in `MappingEntrySchema`; `compileSoftDeletePredicate`
in `config/loader.ts`; pre-drop check in `_processRecords`.
Tests: `packages/engine/src/delete-propagation.test.ts` (SD1–SD14).

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

When `full_snapshot: true`:
- The engine always calls `read()` with `since = undefined` (no watermark used).
- After reading, it compares the returned ID set against all non-deleted shadow rows for
  `(connectorId, entityName)`. Missing IDs are synthesised as `{ id, data: {}, deleted: true }`
  and appended to the batch before `_processRecords`.
- Safety guard: if more than 50% of known rows are absent, the circuit breaker trips instead
  of propagating mass deletes (guards against empty reads from connector errors).
- Empty batch guard: if the connector returns zero records but known rows exist, no deletions
  are synthesised for this cycle.

**Status: implemented.** `full_snapshot:` key in `MappingEntrySchema`; absence detection in
`ingest()` before `_processRecords`.
Tests: `packages/engine/src/delete-propagation.test.ts` (HD1–HD6).

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

### 8.5 Element hard delete (nested arrays)

When an array element was present in a previous read cycle but is absent from the current one,
the engine treats the element as deleted and removes it from the collapsed record:

1. After all child `ReadRecord`s have been processed for a given parent in the array expansion
   path, the engine queries `dbGetChildShadowsForParent` to retrieve all previously-known
   non-deleted child shadow rows for `(connectorId, entityName, parentCanonId, arrayPath)`.
2. Any child that was NOT present in the current batch is marked deleted
   (`dbMarkDeleted`) and a zero-patch collapse-rebuild is enqueued.
3. The collapse batch calls `dbGetArrayChildrenByParent` to reconstruct the remaining live
   elements, applies the outbound mapping for each, and writes the rebuilt array back to targets.

This mechanism requires a watermark-based or full-snapshot connector and does **not** require
`full_snapshot: true` on the member entry — array child absence is always detected once a parent
record is returned by the connector.

**Status: implemented.** Element absence detection in `_processRecords` array expansion path;
empty-patch rebuild in `_applyCollapseBatch`.
Tests: `packages/engine/src/delete-propagation.test.ts` (T-DEL-06, T-DEL-08).

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
| `expression` resolver | §1 | ✅ implemented — YAML `expression`/`reverse_expression` + TypeScript function form |
| `collect` resolver | §1 | ✅ implemented — `fieldName: { strategy: collect }` under `conflict:` |
| `bool_or` resolver | §1 | ✅ implemented — `fieldName: { strategy: bool_or }` under `conflict:` |
| Composite keys (`link_group`) | §2 | ✅ `identityGroups` (AND-within-group, OR-across-groups); tests T-LG-1–T-LG-4 |
| Transitive closure | §2 | ✅ union-find (connected-components) algorithm; see `specs/identity.md` |
| External link tables | §2 | ❌ no third-party linkage feed |
| Cluster members writeback | §2 | ❌ no feedback table after inserts |
| Cluster field on source record | §2 | ❌ no contract for this in connector SDK |
| Embedded objects (flat `parent`) | §3 | ✅ implemented — `parent:` without `array_path`; child external ID `<parentId>#<childEntity>`; reverse merge into parent `UpdateRecord`; parent-delete cascade. Tests: EO1–EO7 |
| Nested arrays (`array` / `array_path`) | §3 | ✅ implemented — forward expand + reverse collapse; same-channel + cross-channel |
| Deep nesting | §3 | ✅ implemented — `expansionChain`, multi-hop `array_parent_map`, cross-join |
| Scalar arrays (`scalar: true`) | §3.3 | ✅ forward + reverse collapse implemented; cascade element-absence deletion; `_value` preserved through pipeline. Tests: SA1–SA9, SC1–SC8 |
| `source_path` extraction | §1.7 | ✅ implemented — dotted path + `[N]` index; forward pass extraction; reverse pass nested-path reconstruction; array-index restricted to `forward_only`; `element_fields` support. Tests: SP1–SP10 |
| Passthrough columns | §3 | 🔶 shadow state preserves; delta pipeline needs `passthrough:` key |
| Atomic arrays (`sort_elements`, `element_fields`) | §3.5 | ✅ `sort_elements`/`unordered` schema-guided sort; `element_fields` per-element rename; Tests: AA1–AA5, EF1–EF8 |
| `references` (FK field) | §4 | ✅ `id_field` + plain field mapping (§4.1); UUID-translation approach deferred |
| FK reverse resolution | §4 | ✅ `direction: forward_only` excludes injected PK from outbound dispatch |
| Reference preservation after merge | §4 | ✅ identity_map preserves all connector IDs; association predicate remapping implemented |
| `references_field` | §4 | ❌ no alternate-representation FK |
| Vocabulary targets | §4 | ❌ no vocabulary entity concept |
| Field groups (`group`) | §5 | ✅ implemented — `group` key on field entries; atomic resolution |
| `filter` source filter | §5 | ✅ implemented — JS expression string, record or element binding by context |
| `reverse_filter` | §5 | ✅ implemented — JS expression string, record or element binding by context |
| `default` / `defaultExpression` | §5 | ✅ `default` implemented; `defaultExpression` TypeScript API only |
| Per-field `direction` | §5 | ✅ implemented |
| Field `expression` / `reverseExpression` | §5 | ✅ implemented — YAML string form + TypeScript function form |
| Enriched cross-entity expressions | §5 | ❌ no cross-entity reference in resolution pass |
| Per-field timestamps (`lastModifiedField`) | §5 | ✅ `record.fieldTimestamps` + per-field derivation; no config key needed |
| `normalize` (precision-loss noop) | §5 | ✅ implemented — YAML `normalize` string form + TypeScript function form |
| Soft-delete field inspection | §6 | ✅ implemented — `soft_delete:` config key; four strategies; pre-drop check in `_processRecords` |
| Hard delete / `derive_tombstones` | §6 | ✅ implemented — `full_snapshot: true`; entity-absence detection with 50% safety guard |
| Element hard delete (array) | §6 | ✅ implemented — element-absence detection after array expansion; empty-patch collapse rebuild |
| `reverse_required` | §6 | ✅ implemented — `reverseRequired: true` / `reverse_required: true` |
| Source-level noop (`_base` / shadow diff) | §7 | ✅ implemented — see [safety.md](safety.md) |
| Target-centric noop (`written_state`) | §7 | ✅ implemented — `written_state` table + `_dispatchToTarget` guard |
| `derive_timestamps` | §7 | ✅ per-field timestamp derivation always-on (§7.2); no config key needed |
| Concurrent edit detection | §7 | 🔶 data is in shadow state; detection signal not wired |
| Custom sort (array ordering) | §8 | ✅ implemented — `order_by` on mapping entries |
| CRDT ordinal ordering | §8 | ✅ implemented — `order: true` (`_ordinal` injection) |
| CRDT linked-list ordering | §8 | ✅ implemented — `order_linked_list: true` (`_prev`/`_next`) |
| Discriminator routing | §9 | ✅ implemented — per-member `filter` with distinct channel entries (§5.3) |
| Route combined (routing + merging) | §5.4 | ✅ validated; shadow independence confirmed; ingest-order invariance; `reverse_filter` suppression. Tests: RC1–RC6 |
| Element-set resolution | §5.5 | ✅ ES pre-step + `fieldMasters` single-patch filtering in `_applyCollapseBatch`. Tests: ES1–ES7 |
| Multi-entity mapping files | §10 | ✅ implemented |
| `sources:` / `primary_key` metadata | §10 | ✅ `sources:` in field entries (lineage hint); entity schema from `getEntities()` |
| Mapping-level priority / `last_modified` | §10 | 🔶 field-level works; mapping-level default not in config |
| `passthrough` config | §10 | ❌ not in config spec |
| Inline test cases | §11 | ❌ no inline testing infrastructure |
| `_cluster_id` seed format | §11 | ❌ depends on inline testing |

### Summary

| Category | Total | ✅ | 🔶 | ❌ |
|----------|-------|----|----|-----|
| Resolution strategies | 6 | 6 | 0 | 0 |
| Identity & linking | 5 | 2 | 0 | 3 |
| Nesting & structure | 7 | 4 | 3 | 0 |
| References & FKs | 5 | 3 | 0 | 2 |
| Field-level controls | 8 | 7 | 0 | 1 |
| Deletion & tombstones | 4 | 4 | 0 | 0 |
| Change detection & noop | 4 | 3 | 1 | 0 |
| Ordering | 3 | 3 | 0 | 0 |
| Routing & partitioning | 3 | 3 | 0 | 0 |
| Mapping config & metadata | 4 | 2 | 1 | 1 |
| Testing | 2 | 0 | 0 | 2 |
| **Total** | **51** | **37** | **5** | **9** |

### Open gaps (as of 2026-04-08)

Most OSI-mapping primitives are now implemented. Remaining gaps:

- **External link tables, cluster member writeback, cluster field on source** (§2) — no third-party
  linkage feed mechanism; not yet designed.
- **Embedded objects** (`parent:` flat syntax, §3.1) — child entity from columns on the same row;
  distinct from array expansion. Designed, not yet implemented.
- **`passthrough` config** (§3) — named passthrough columns forwarded to delta output.
- **`references_field`** (§4) — alternate-representation FK (e.g. ISO code instead of UUID).
- **Vocabulary targets** (§4) — read-only seeded lookup tables for FK translation.
- **`defaultExpression`** (§5) — dynamic fallback; TypeScript API only.
- **Enriched cross-entity expressions** (§5) — expressions that reference fields from a related
  entity during resolution.
- **Inline test cases** (§11).
