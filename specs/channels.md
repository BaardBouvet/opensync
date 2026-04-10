# Channels

A **channel** is a named group of connector–entity pairs that share a single canonical record
space. Records ingested from any member of a channel are merged into the same canonical entity
via identity linking and conflict resolution, and accepted changes are fanned out to all other
members.

This spec covers channel structure and the full resolution pipeline. Field-level transform
primitives (`expression`, `normalize`, `default`, `source_path`, …) are in
`specs/field-mapping.md`. Identity matching (how records are linked across connectors) is in
`specs/identity.md`. The ingest loop that drives the pipeline is in `specs/sync-engine.md`.

---

## § 1 Channel Configuration

### § 1.1 TypeScript types

```typescript
interface ChannelConfig {
  id:                 string;
  members:            ChannelMember[];
  identityFields?:    string[];         // canonical fields used for record matching (OR'd with identityGroups)
  identityGroups?:    IdentityGroup[];  // compound-key groups; takes precedence over identityFields
  propagateDeletes?:  boolean;          // fan out entity.delete() to target connectors on source deletion
}

interface ChannelMember {
  connectorId:         string;
  entity:              string;          // logical entity name; keys watermarks + shadow_state
  sourceEntity?:       string;          // connector entity to call read() on; absent → use entity
  name?:               string;          // stable identifier for parent/child references
  inbound?:            FieldMappingList; // connector → canonical field transforms
  outbound?:           FieldMappingList; // canonical → connector field transforms
  assocMappings?:      AssocPredicateMapping[];
  // Array expansion
  arrayPath?:          string;
  parentMappingName?:  string;
  elementKey?:         string;
  expansionChain?:     ExpansionChainLevel[];
  // Embedded objects
  embeddedChild?:      boolean;
  embeddedParentEntity?: string;
  // Filters
  recordFilter?:       (record: Record<string, unknown>, ctx: Record<string, unknown>) => boolean;
  recordReverseFilter?: (record: Record<string, unknown>, ctx: Record<string, unknown>) => boolean;
  elementFilter?:      (element: unknown, record: Record<string, unknown>, index: number) => boolean;
  elementReverseFilter?: (element: unknown, record: Record<string, unknown>, index: number) => boolean;
  softDeletePredicate?: (record: Record<string, unknown>) => boolean;
  // Misc
  idField?:            string;
  fullSnapshot?:       boolean;
}
```

### § 1.2 YAML channel definition

Channels are declared inline in mapping files — a `channel:` key on a mapping entry implicitly
creates the channel if it does not already exist. An explicit top-level `channels:` block is
required only to declare `identity` or `propagate_deletes`:

```yaml
channels:
  - name: contacts
    identity:
      - email
    propagate_deletes: true

mappings:
  - connector: crm
    channel: contacts
    entity: contacts
    fields:
      - source: emailAddress
        target: email
  - connector: erp
    channel: contacts
    entity: customers
    fields:
      - source: contactEmail
        target: email
```

### § 1.3 Identity

Identity fields declare which canonical fields are used to link records from different connectors
into the same canonical entity. A record from connector A whose `email` matches a record from
connector B is merged into a single canonical entity — they receive the same `canonical_id`.

- `identity:` — list of canonical field names; a match on **any** field links the records.
- `identity:` with multiple entries per group — AND semantics within one group, OR across groups.
  See `specs/identity.md § Compound Identity Groups` for full `IdentityGroup` syntax.

---

## § 2 Conflict Resolution

When multiple connectors in the same channel contribute a value for the same canonical field,
resolution determines which value wins. Resolution runs per-target before dispatch.

The resolution pipeline evaluates strategies in this priority order:

1. **Field master** — if `fieldMasters[field]` names a connector (built from `master: true` on a mapping field entry), only that connector's value is accepted. All other sources are dropped.
2. **Per-field strategy** — a field entry under `fields:` on the channel (e.g. `phone: { strategy: last_modified }`) selects `coalesce`, `last_modified`, `collect`, or `bool_or`.
3. **Field-level `resolve` expression** — a `resolve:` key on the `FieldMapping` entry
   provides a custom incremental reducer.
4. **Global strategy** — `strategy: field_master` or `strategy: origin_wins` as the fallback.
5. **Last-write-wins (LWW)** — the implicit default when no strategy is declared. Incoming
   value accepted if `incoming.ts >= shadow[field].ts`.

### § 2.1 Channel `fields:` and global `conflict:`

Canonical fields are declared under a `fields:` key on the channel. Each field name maps to a
field config entry that carries (at minimum) a `strategy:` for conflict resolution. This is
also the natural place to add `description:`, `type:`, and other field-level metadata in
future versions.

Three keys are reserved inside `fields:` and cannot be used as field names: `strategy`,
`fieldMasters`, `connectorPriorities`.

```typescript
// YAML surface — parsed flat, then normalised
interface ChannelFieldsYaml {
  // reserved cross-field settings:
  strategy?:             "field_master" | "origin_wins";
  fieldMasters?:         Record<string, string>;          // canonical field → connectorId
  connectorPriorities?:  Record<string, number>;          // connectorId → priority (lower wins)
  // per-field entries (any other key):
  [fieldName: string]: { strategy: "coalesce" | "last_modified" | "collect" | "bool_or" };
}
```

Field config declared under `fields:` applies only to that channel and takes precedence over
the global `conflict:` block for any matching field. Entries are merged field-by-field
(channel wins on overlap); `strategy`, `fieldMasters`, and `connectorPriorities` are replaced
wholesale when present on the channel.

Declaring field config per-channel is the recommended practice because field names are scoped
to a channel’s canonical schema — the same name (e.g. `phone`) can have different resolution
semantics in different channels.

```yaml
channels:
  - id: persons
    identity: [email]
    fields:
      phone:     { strategy: last_modified }
      firstName: { strategy: coalesce }
  - id: orgs
    identity: [domain]
    fields:
      categories: { strategy: collect }
      isPremium:  { strategy: bool_or }
```

A global `conflict:` block is still useful for cross-cutting settings that apply to all
channels, such as `connectorPriorities` or a fallback `strategy`:

```yaml
conflict:
  connectorPriorities: { crm: 1, erp: 2 }
```

---

## § 3 Resolution Strategies

### § 3.1 Last-write-wins (LWW) — default

The implicit strategy when nothing else is configured. The engine compares the incoming field
timestamp (`record.fieldTimestamps[field]`, or the record-level `updatedAt`, or the ingest
timestamp) against the stored shadow timestamp. If `incoming.ts >= shadow.ts`, the incoming
value wins and the shadow is updated.

Stable tie-breaking: when two sources have equal timestamps and both supply `createdAt`, the
source with the **later** `createdAt` loses — the older source is treated as the origin.

### § 3.2 `coalesce`

Pick the first non-null value by source priority. Lower priority number wins. When all
sources for a field are null, the field is absent from the canonical record.

Priority is declared on the mapping entry — never on the channel (channels are
connector-agnostic):

- **Mapping-level `priority:`** — sets the default coalesce priority for all fields from this
  connector in this channel. Promoted into `ChannelConfig.conflict.connectorPriorities` at
  load time (channel-scoped; does not affect other channels).
- **Field-level `priority:`** on a `FieldMappingEntry` — overrides the mapping-level default
  for a single canonical field.

```yaml
mappings:
  - connector: crm
    channel: persons
    entity: contacts
    priority: 1           # mapping-level: CRM is default authority for all coalesce fields
  - connector: erp
    channel: persons
    entity: employees
    priority: 2           # mapping-level: ERP is secondary by default…
    fields:
      - source: firstName
        target: firstName
        priority: 0       # …except name fields where ERP is authoritative
```

Declared via `fields:` on the channel to apply coalesce to a specific field:

```yaml
channels:
  - id: persons
    fields:
      email: { strategy: coalesce }
```

**Status: implemented. Tests: `packages/engine/src/core/conflict.test.ts` CO1–CO8, PR1–PR4.**

### § 3.3 `last_modified`

Most recently changed value wins. Functionally equivalent to LWW but declared explicitly in
`fieldStrategies` to signal intent. The engine uses `record.fieldTimestamps[field]` when
available; otherwise falls back to `record.updatedAt`; otherwise to ingest timestamp.

**Status: implemented.**

### § 3.4 `collect`

Accumulate all contributed values into an array without resolving to one winner. Duplicate
values are excluded (set semantics). Subsequent ingests append new values; no value is ever
removed by collect — removal requires the source record to stop contributing it.

```yaml
"fieldStrategies": { "tags": { "strategy": "collect" } }
```

**Status: implemented. Tests: `packages/engine/src/core/conflict.test.ts` RS1–RS4.**

### § 3.5 `bool_or`

Resolves to `true` if any contributing source has a truthy value. Sticky: once `true`, a
subsequent `false` or `null` from another source does not revert it.

```yaml
"fieldStrategies": { "isActive": { "strategy": "bool_or" } }
```

Use case: deletion flags or premium-tier markers that should propagate if *any* upstream
asserts them.

**Status: implemented. Tests: `packages/engine/src/core/conflict.test.ts` BO1–BO6.**

### § 3.6 Expression resolver (`resolve`)

A custom incremental reducer declared as a JS expression string on a `FieldMapping` entry.
Available bindings: `incoming` (value from the current source), `existing` (current canonical
value, `undefined` on first ingest).

```yaml
fields:
  - source: score
    target: score
    resolve: "Math.max(Number(incoming) || 0, Number(existing) || 0)"
```

TypeScript embedded API accepts a function value for the same key. Takes precedence over
`fieldStrategies[field]` when both are declared for the same field.

**Status: implemented. Tests: `packages/engine/src/core/conflict.test.ts` ER1–ER6.**

### § 3.7 `field_master`

A named connector is the sole authority for a canonical field. Patches from all other
connectors for that field are dropped before resolution. Unmastered fields fall back to the
channel strategy.

Declared on the mapping entry via `master: true` on a field entry. At load time the loader
promotes these into `ChannelConfig.conflict.fieldMasters` (channel-scoped).

```yaml
mappings:
  - connector: crm
    channel: persons
    entity: contacts
    fields:
      - source: email
        target: email
        master: true    # CRM is the sole authority for email in this channel
      - source: phone
        target: phone
```

Validation: declaring two connectors as master for the same canonical field in the same
channel is a config error.

Also applies inside element-set resolution — see § 5.

**Status: implemented.**

### § 3.8 `origin_wins`

The first connector to write a value for a field keeps it. Subsequent sources for the same
field are dropped unless the field is cleared by the originating source.

```json
{ "conflict": { "strategy": "origin_wins" } }
```

**Status: implemented.**

---

## § 4 Field Groups (Atomic Resolution)

Fields sharing the same `group` label are resolved atomically. The source that wins one field
in the group wins all of them, preventing incoherent splits (e.g. ERP wins `city` while CRM
wins `street` for the same address).

```yaml
fields:
  - source: ship_street
    target: street
    group: shipping_address
  - source: ship_city
    target: city
    group: shipping_address
```

When `last_modified` is the resolution strategy for the group, the group timestamp is the
`MAX` of all field timestamps within the group from the winning source. For `coalesce`, the
winning source provides all non-null group fields together.

**Status: implemented. Tests: `packages/engine/src/core/conflict.test.ts` FG1–FG8.**

---

## § 5 Element-Set Resolution

When multiple sources contribute elements to the same nested array (via array expansion), the
engine applies an ES resolution pre-step at collapse time before writing the merged array back
to targets.

Element patches from all sources are grouped by leaf `elementKey`. For each element key a
winner is chosen field-by-field using this priority chain:

1. **`master: true`** (field entry on a mapping) — only the declared master connector may
   contribute that field's value. Patches from non-master sources have the field stripped
   before application, even for single-patch batches.
2. **Mapping-level `priority:`** — source with the numerically lowest priority number wins.
3. **Per-field `last_modified` timestamps** — if both sources provide `record.fieldTimestamps`,
   the source with the more-recent timestamp for that field wins.

```yaml
mappings:
  - connector: erp
    channel: order-lines
    parent: erp_orders
    array_path: lines
    priority: 1
    fields:
      - source: price
        target: price
        master: true    # ERP always owns price
      - source: qty
        target: qty
```

**Status: implemented. Tests: `packages/engine/src/scalar-route-element.test.ts` ES1–ES7.**

---

## § 6 Connector Priorities

Connector priority is declared on the mapping entry, not on the channel. Two levels:

- **Mapping-level `priority:`** on a `mappings[]` entry — sets the default coalesce priority
  for all fields from this connector in this channel. Lower number = higher priority.
  Promoted into `ChannelConfig.conflict.connectorPriorities` at load time (channel-scoped).
- **Field-level `priority:`** on a `FieldMappingEntry` — overrides the mapping-level default
  for a single canonical field.

Connectors without a declared `priority:` are treated as equal to each other and as lower
priority than any connector with a declared value.

See `specs/field-mapping.md §2.1` for examples.

---

## § 7 propagate_deletes

When `propagate_deletes: true` is set on a channel, deleting a record from one connector fans
out an `entity.delete()` call to all other channel members and tombstones their shadow rows
with `deleted_at`.

Without this flag, deletion is local: the source shadow row is tombstoned but target connector
records are not touched.

```yaml
channels:
  - name: contacts
    propagate_deletes: true
```

**Status: implemented. Tests: `packages/engine/src/delete-propagation.test.ts` DP1–DP6.**

---

## § 8 Per-Channel Conflict Config

Per-channel field strategies are declared under `channels[].fields:`. The internal
`ConflictConfig` type has `fieldMasters` and `connectorPriorities` properties that are
populated at load time from mapping entries (`master: true` and `priority:` respectively)
and are never written directly in YAML.
