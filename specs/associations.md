# Associations

> **See also**: `connector-sdk.md` — the `Ref` type and `ReadRecord` contract;
> `identity.md` — how the identity map resolves cross-connector references.

## What Are Associations?

Associations are FK fields in `ReadRecord.data` whose values are `Ref` objects rather than
plain strings. A `Ref` carries both the referenced record's ID and the entity it belongs to,
giving the engine a zero-ambiguity graph without scanning unknown field values.

```typescript
interface Ref {
  '@id': string;        // the referenced record's ID in this (source) system
  '@entity'?: string;   // the entity name — omit when inferable from schema (FieldDescriptor.entity)
}
```

```typescript
// ReadRecord from a CRM contact
{
  id: 'contact-42',
  data: {
    name: 'Alice',
    email: 'alice@example.com',
    companyId: { '@id': 'hs_456', '@entity': 'company' },  // Ref
  }
}
```

The engine extracts Ref values during ingest, resolves the identity map, and injects
remapped plain ID strings into `InsertRecord.data` / `UpdateRecord.data` at dispatch time.

## Entity Inference

The engine infers which entity a field references, in order of precedence:

1. **Schema auto-synthesis** — field value is a **plain string** and `entity: 'E'` is set on the
   `FieldDescriptor` in the entity's `schema`. The engine wraps the string as a Ref internally
   during ingest. Connector does not need to construct Ref objects — just declare `entity` in
   the schema and return raw API payloads. This is the recommended path for SaaS connectors.
2. `@entity` on an **explicit `Ref` object** in `data` — the Ref's own `@entity` value is used directly.
3. `entity` on the `FieldDescriptor` in `schema` — used when the field value is an explicit `Ref`
   object but `@entity` is absent from it.
4. None of the above → opaque; no association derived

## The Composite Key

`(targetEntity, targetId)` — derived from the Ref's `@entity` and `@id` fields — is the
composite key the identity map uses everywhere:

```
identity_map WHERE entity_name = targetEntity AND external_id = targetId
```

If the target is not yet in the identity map (i.e. the connector that owns `company` hasn't
been synced yet, or that company ID hasn't been seen), the edge is **left pending** — stored
but not resolved. The engine does not silently pick a closest match or drop the edge. Once the
target record arrives (on the next sync cycle or via webhook), pending edges are resolved.

## Relational Example

A contact references a company via schema auto-synthesis (Entity Inference, item 1):

```typescript
// Schema declaration (EntityDefinition)
schema: {
  companyId: { entity: 'company' },
}

// ReadRecord from a CRM contact — connector returns raw API payload unchanged
{
  id: 'contact-42',
  data: { name: 'Alice', companyId: 'hs_456', email: 'alice@example.com' },
}
```

Because the schema declares `entity: 'company'` on `companyId`, the engine auto-wraps the plain
string value as `{ '@id': 'hs_456', '@entity': 'company' }` during ingest. The connector returns
the raw API payload without constructing any `Ref` objects.

## JSON-LD Example

For SPARQL / RDF connectors, Ref values are built from `@id` IRI bindings in the source data.
The predicate is the property URI; `@id` is the referenced IRI:

```typescript
{
  id: 'https://example.com/person/alice',
  data: {
    'https://schema.org/worksFor': { '@id': 'https://example.com/org/acme', '@entity': 'organization' }
  }
}
```

This is structurally identical to the relational short-name form — only the naming convention
for predicate strings differs.

## Flat Systems

If `contact` and `company` fields all live in one source object, the connector returns one
record with all fields and no associations. The engine handles many-to-many field mapping.
No splitting required at the connector level.

## Storage in Shadow State

The engine extracts Ref values from `data` during ingest and serialises them into a special
`__assoc__` sentinel field in `shadow_state.canonical_data`. The diff engine detects
association changes using its standard field-delta algorithm — no special-cased diffing is
needed.

## § 5 Record Processing Order

The engine collects all records from the connector's async generator in **arrival order** —
the order the connector yields them across all batches. No sorting is applied by the engine.
Within a call to `_processRecords`, records are processed strictly sequentially in that
arrival order.

**Commit-before-continue**: each record's write to `identity_map` and `shadow_state` is
committed to SQLite before the next record is touched. A record processed later in the same
batch can therefore resolve identity links created by records processed earlier in the same
batch.

Connectors that need causal ordering (e.g. a parent record before its children) must yield
parent records in earlier batches or earlier within the same batch. The engine provides no
built-in topological sort of incoming records.

## § 6 Pending Edge Resolution

### § 6.1 Eager Dispatch (default)

When the engine processes a record whose associations reference targets not yet in the
identity map, it **still dispatches the record immediately** — it does not block or drop it.
The unresolvable association entries are silently omitted from the remapped payload sent
to the target connector. A `deferred_associations` row is written for every omitted edge
so the engine knows to retry.

On the next ingest cycle for the same source entity the engine calls `lookup()` for records
with pending deferred rows, re-runs the full remap, and issues an update with the now-
resolvable associations attached. Once all edges for a record are resolved its deferred rows
are deleted.

The source shadow for a record dispatched with a dropped edge is written **without** an
association sentinel. This prevents echo detection from suppressing the subsequent retry
update, which would otherwise appear as a no-op from the shadow's perspective.

### § 6.2 Circular References

When two records in the same ingest batch each reference the other (A → B, B → A), the
engine processes them in arrival order (§ 5). The first record (A) is inserted without an
association — B is not yet committed to `identity_map`. The second record (B) is processed
after A's row is committed; B's remap therefore succeeds and B is inserted with the full
association. A's deferred row is retried on the next ingest cycle and resolved at that point.
Two ingest passes are needed; no permanent stall occurs.

### § 6.3 Strict Mode (planned)

A future `associationMode: "strict"` channel option will block dispatch until all
associations are resolvable, matching the old default behaviour. Unresolvable strict records
will carry `action: "defer"` in the sync result. Deadlock detection for circular references
under strict mode is specified in `plans/engine/PLAN_CIRCULAR_ASSOCIATION_DEADLOCK.md`.

## § 7 Cross-System Association Remapping

When data flows from source system A to target system B, associations must be translated from
A's local ID namespace into B's. The engine does this through the identity map and channel
membership config — no extra declaration beyond the existing channel mapping is needed.

### § 7.1 Connector uses its own entity name

The `entity` value on a `FieldDescriptor` (or `@entity` on an explicit `Ref`) must be the
**connector's own entity name** — exactly as it is registered under `entity` in the channel
mapping config. The connector has no knowledge of the canonical data model or of other
connectors' entity names.

Example: the CRM connector registers entity `company`; the ERP connector registers entity
`accounts`. Both appear in the same channel (`companies`). The CRM contact schema declares:

```typescript
schema: {
  companyId: { entity: 'company' },  // 'company' = CRM's own entity name
}
```

The ERP contact schema would declare `entity: 'accounts'`. Neither connector knows the
other exists.

### § 7.2 Engine remap steps

For each resolved association the engine performs these steps at dispatch time:

1. **Inbound filtering**: keep only associations whose `predicate` is declared in the source
   connector's `assocMappings` list (see § 7.5). Missing declaration → drop all associations.
2. **Canonical UUID lookup**: look up `(sourceConnectorId, assoc.targetId)` in `identity_map`
   to get the canonical UUID for the referenced record.
3. **Target local ID lookup**: look up `(canonicalUUID, targetConnectorId)` in `identity_map`
   to get the target connector's local ID.
4. **Entity name translation**: call `_translateTargetEntity(assoc.targetEntity, fromConnectorId, toConnectorId)` —
   walk the channel config to find which channel has `fromConnector` with entity `assoc.targetEntity`,
   then return `toConnector`'s entity name in that same channel. This translates `company` → `accounts`
   without either connector knowing about the other.
5. **Predicate translation**: look up the predicate through the canonical name in `assocMappings`
   (local → canonical in source, canonical → local in target). Predicates with no mapping → dropped.
6. **Emit**: write `assoc.targetId` as a plain string to `data[<target-local predicate>]` in
   `InsertRecord.data` / `UpdateRecord.data` sent to the target connector. If the association
   target is not yet cross-linked the field is absent from `data` (a deferred row is written
   so the engine retries once the link is established).

### § 7.3 FK routing is the connector's responsibility

Remapped association IDs arrive in `InsertRecord.data` / `UpdateRecord.data` as **plain strings**
under the target-local predicate name. Connectors receive `record.data` directly and can pass
it to the API as-is. No `record.associations` field is provided — the engine handles all FK
routeing internally.

### § 7.4 Field mapping must not duplicate associations

Association predicates (e.g. `companyId`, `orgId`) must **not** appear in the `fields`
list of the channel mapping config. They are not plain data fields — the engine has no
canonical value for them in shadow state; the identity remapping in § 7.2 supersedes any
field-level mapping. Including them in `fields` would produce a stale unmapped local ID in
the canonical record, which is meaningless to any other system.

### § 7.5 Predicate mapping via `assocMappings`

Each connector member in a channel mapping may declare an optional `associations` list that
maps connector-local predicate names to a canonical (channel-internal) name:

```yaml
# mappings/contacts.yaml
- connector: crm
  channel: contacts
  entity: contacts
  associations:
    - source: companyId   # CRM-local predicate name
      target: companyRef  # canonical name (routing key only; never stored anywhere)

- connector: erp
  channel: contacts
  entity: employees
  associations:
    - source: orgId       # ERP-local predicate name
      target: companyRef  # same canonical → same conceptual edge

- connector: hr
  channel: contacts
  entity: people
  associations:
    - source: orgRef
      target: companyRef
```

**Rules:**
- Absent `associations` on a mapping entry → **no associations forwarded** from or to that
  connector. Omitting the list is safe and strict by design: a connector that has not declared
  its predicates cannot participate in association sync.
- Only predicates that appear in the `associations` list are forwarded. Unlisted predicates
  from a connector that has an `associations` list are silently dropped.
- The canonical name is a routing key only — it is **never stored** in shadow state. The
  shadow always stores the connector's own local predicate name.
- Changing or adding a predicate mapping never invalidates existing shadows. No migration
  is needed when mapping config is updated.

## § 8 FK Schema — Write-Side Filtering and Pre-Flight Warnings

Foreign-key declarations live on `FieldDescriptor.entity` in `EntityDefinition.schema`.
When a field carries `entity: 'company'`, the engine knows that field is an FK reference
to the `company` entity. No separate `associationSchema` is needed.

```typescript
// EntityDefinition.schema — FK field annotated with entity
schema: {
  companyId: { entity: 'company' },
}
```

### § 8.1 Write-Side Filtering

When the engine dispatches to a target entity that declares `schema` fields with `entity`,
association metadata is filtered internally: only FK predicates with `entity` set are tracked.
Predicates with no corresponding FK field in `schema` are dropped silently.

The write-side FK values in `data` always reflect this filter — the connector never receives
FK fields for predicates it did not declare in its schema.

### § 8.4 Source-Inexpressible Predicate Preservation

When a source connector triggers an UPDATE to a target connector, the source can only express
a subset of the target's association predicates — specifically, those reachable via the
source's `assocMappings` chain through a canonical predicate to a target-local predicate.

Predicates that the source **cannot** express (e.g. `secondaryCompanyId` on CRM when the
source is an ERP that only has `orgId → primaryCompanyRef`) must be **preserved** from the
target's current association state. The engine merges the remapped source Ref fields with
the existing target shadow Ref fields as follows:

1. Identify target predicates expressible by the source (via `fromMember → canonical → toMember` chain).
2. Start with the Ref values last written to the target (from its shadow).
3. Clear source-owned predicates (the source owns them — it may set or clear).
4. Apply the source’s remapped Ref values (from `remap`).

This ensures that, for example, a CRM contact's `secondaryCompanyId` is never dropped when
ERP (which has no `secondaryRef` mapping) updates the contact's `primaryCompanyId`.

This applies only to UPDATE dispatches. INSERT dispatches have no prior target state to preserve.

### § 8.2 Pre-Flight Warnings

At channel setup, if a field with `entity` set names an entity that is not registered for
that connector in **any** channel, the engine logs a `[WARN]` entry. Cross-channel FK
targets (§7) are intentional and do not trigger this warning — the entity is found in a
different channel and can be resolved once that channel has been synced.
Dispatch is not blocked — the warning is informational.

Format:
```
[WARN] <connectorId>:<entity>.schema['<predicate>'].entity targets entity '<targetEntity>'
       but no '<targetEntity>' entity is registered for connector '<connectorId>' in any channel.
       Associations with this predicate will have unresolvable targets.
```

### § 8.3 Required-Association Warnings

*Removed.* The `required` field has been dropped from `AssociationDescriptor`.
Use `FieldDescriptor.required` on the schema entry for the predicate field instead.

## Design Rationale

### Why Inline in `data`?

Associations are encoded as `Ref` values directly in `data[fieldName]` rather than in a
separate `associations` array. This aligns the connector contract with JSON-LD conventions
(`@id`, `@entity`) and makes the mapping layer simpler — one field in canonical state can
hold either a scalar or a Ref, and field-mapping config handles both uniformly.

The engine extracts the association graph by scanning `data` for Ref-shaped values, using
`entity` on the field's `FieldDescriptor` to resolve the entity name when `@entity` is absent.
This is unambiguous: a Ref is a typed object with a `'@id'` key, structurally distinct from
any plain string, number, or array, so the engine never confuses a plain value with a
reference.

### Why Not a Separate Array?

The previous design kept a parallel `associations?: Association[]` field on `ReadRecord`,
`InsertRecord`, and `UpdateRecord`. Separating the index from `data` meant connectors had
to maintain the two in sync and the engine had to join them at dispatch. Inline values in
`data` (plain strings declared via `schema[field].entity`) eliminate that duplication —
one field in `data` is both the value and the association declaration.
