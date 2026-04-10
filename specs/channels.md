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

1. **Field master** — if `fieldMasters[field]` names a connector, only that connector's value
   is accepted for that field. All other sources are dropped.
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

Pick the first non-null value by source priority. Lower `connectorPriorities` number wins.
Per-field `priority` on a `FieldMapping` entry overrides the connector-level default. When all
sources for a field are null, the field is absent from the canonical record.

```yaml
# opensync.json
"conflict": {
  "connectorPriorities": { "crm": 1, "erp": 2 }
}
```

Declared in `fieldStrategies` to apply coalesce to a specific field only:

```yaml
"fieldStrategies": { "email": { "strategy": "coalesce" } }
```

**Status: implemented. Tests: `packages/engine/src/core/conflict.test.ts` CO1–CO8.**

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

A named connector always wins for declared fields. Patches from all other connectors for those
fields are dropped before resolution. Unmastered fields fall back to the global strategy.

```json
{
  "conflict": {
    "strategy": "field_master",
    "fieldMasters": { "price": "erp", "email": "crm" }
  }
}
```

Also applies inside element-set resolution — see § 4.

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

1. **`fieldMasters`** — only the declared master connector may contribute that field's value.
   Patches from non-master sources have the field stripped before application, even for
   single-patch batches.
2. **`connectorPriorities`** — source with the numerically lowest priority number wins.
3. **Per-field `last_modified` timestamps** — if both sources provide `record.fieldTimestamps`,
   the source with the more-recent timestamp for that field wins.

```yaml
channels:
  - name: order-lines
    conflict:
      connectorPriorities:
        erp: 1
        marketplace: 2
      fieldStrategies:
        qty:
          strategy: coalesce
      fieldMasters:
        price: erp
```

**Status: implemented. Tests: `packages/engine/src/scalar-route-element.test.ts` ES1–ES7.**

---

## § 6 Connector Priorities

`connectorPriorities` assigns a numeric rank to each connector. Lower = higher priority.
Used by `coalesce`, element-set resolution, and as a tiebreaker when field timestamps are
equal in `last_modified` resolution.

```json
{ "connectorPriorities": { "crm": 1, "erp": 2, "hr": 3 } }
```

Connectors not listed in `connectorPriorities` are treated as equal to each other and lower
priority than any listed connector.

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

## § 8 Per-Channel Conflict Config (Future)

As of 0.3.x, `ConflictConfig` is global — it applies to all channels. Per-channel conflict
overrides are planned but not yet implemented. The anticipated YAML form is a `conflict:` block
nested inside the channel definition, as shown in the element-set resolution example in § 5.
The TypeScript `ChannelConfig` type will gain an optional `conflict?: ConflictConfig` field.

See `plans/engine/` for the implementation plan when this is prioritised.
