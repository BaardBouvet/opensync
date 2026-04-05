# Associations

> **See also**: `connector-sdk.md` — the `ReadRecord.associations` field where this is
> declared; `identity.md` — how the identity map resolves cross-connector references.

## What Are Associations?

Associations are an explicit index of which fields in a `ReadRecord.data` blob are references
to other records, and in which entity they live. They let the engine build a relationship graph
without parsing every field value looking for IDs it might recognise.

```typescript
interface Association {
  predicate: string;                    // the field key in data that holds this reference
                                        // e.g. 'companyId', 'worksFor', 'https://schema.org/worksFor'
  targetEntity: string;                 // entity name the reference points to (e.g. 'company')
  targetId: string;                     // the referenced ID in the target entity's namespace
  metadata?: Record<string, unknown>;   // optional edge metadata (e.g. { since: '2020-01-01' })
}
```

## Why the Explicit Index?

The engine could scan every field in `data` looking for values that match a known external ID.
But that is fragile — ID formats differ across systems, and the same value could be a reference
or just a coincidentally matching string. The connector knows its own API: it knows that
`data.companyId` is always a reference to a `company` record, never plain text. Making that
explicit once in `associations` means the engine gets a reliable, zero-ambiguity graph.

## The Composite Key

`(targetEntity, targetId)` is the same composite key the identity map uses everywhere. The
engine resolves associations using this pair:

```
identity_map WHERE entity_name = targetEntity AND external_id = targetId
```

If the target is not yet in the identity map (i.e. the connector that owns `company` hasn't
been synced yet, or that company ID hasn't been seen), the edge is **left pending** — stored
but not resolved. The engine does not silently pick a closest match or drop the edge. Once the
target record arrives (on the next sync cycle or via webhook), pending edges are resolved.

## Relational Example

A contact references a company:

```typescript
// ReadRecord from a CRM contact
{
  id: 'contact-42',
  data: { name: 'Alice', companyId: 'hs_456', email: 'alice@example.com' },
  associations: [
    { predicate: 'companyId', targetEntity: 'company', targetId: 'hs_456' }
  ]
}
```

`predicate` is the field key in `data` whose value is the reference (`companyId`). `targetId`
is that value (`hs_456`). `targetEntity` tells the engine which entity's identity namespace
to look in (`company`).

## JSON-LD Example

For JSON-LD connectors (e.g. SPARQL endpoints), associations are built from `@id` references
in the source data. `predicate` becomes the property URI and `targetId` becomes the object's
`@id` value:

```typescript
associations: [
  {
    predicate: 'https://schema.org/worksFor',
    targetEntity: 'organization',
    targetId: 'https://example.com/org/acme'
  }
]
```

The two representations (relational short-name vs. URI predicate) are two views of the same
thing — `associations` is the pre-extracted, engine-readable form in both cases.

## Flat Systems

If `contact` and `company` fields all live in one source object, the connector returns one
record with all fields and no associations. The engine handles many-to-many field mapping.
No splitting required at the connector level.

## Edge Metadata

`metadata` on an association carries edge properties beyond the reference itself — things
that describe the relationship, not just its endpoint:

```typescript
associations: [
  {
    predicate: 'manages',
    targetEntity: 'employee',
    targetId: 'emp-77',
    metadata: { since: '2022-06-01', title: 'Direct report' }
  }
]
```

## Storage in Shadow State

Associations are stored as a special `__assoc__` field in `shadow_state.canonical_data`.
The value is a stable JSON-serialised sentinel of the sorted association list. This lets the
diff engine detect association changes using its standard field-delta algorithm — no special
association diffing logic in the engine is needed.

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

`targetEntity` must be the **connector's own entity name** — exactly as it is registered
under `entity` in the channel mapping config. The connector has no knowledge of the canonical
data model or of other connectors' entity names.

Example: the CRM connector registers entity `company`; the ERP connector registers entity
`accounts`. Both appear in the same channel (`companies`). A CRM contact association uses:

```typescript
{ predicate: 'companyId', targetEntity: 'company', targetId: 'hs_456' }
//                                       ^^^^^^^
//                         CRM's own entity name, matches the channel mapping
```

The ERP connector's equivalent would use `accounts`. Neither connector knows the other exists.

### § 7.2 Engine remap steps

For each resolved association the engine performs these steps at dispatch time:

1. **Canonical UUID lookup**: look up `(sourceConnectorId, assoc.targetId)` in `identity_map`
   to get the canonical UUID for the referenced record. No entity type is involved — the
   identity map is keyed by connector instance and external ID only.
2. **Target local ID lookup**: look up `(canonicalUUID, targetConnectorId)` in `identity_map`
   to get the target connector's local ID.
3. **Entity name translation**: call `_translateTargetEntity(assoc.targetEntity, fromConnectorId, toConnectorId)` —
   walk the channel config to find which channel has `fromConnector` with entity `assoc.targetEntity`,
   then return `toConnector`'s entity name in that same channel. This translates `company` → `accounts`
   without either connector knowing about the other.
4. **Emit**: pass `{ predicate, targetEntity: <translated name>, targetId: <target local ID> }` in
   `UpdateRecord.associations` to the target connector.

### § 7.3 FK injection is the connector's responsibility

The remapped `targetId` arrives in `UpdateRecord.associations`. It is the **target connector's
responsibility** to read it and write the value into whichever field its API expects (e.g.
inject `targetId` back into `data.companyId` before calling the API). The engine does not
auto-inject association values into `UpdateRecord.data`. This keeps the engine free of
connector-specific field naming knowledge and is consistent with the "connectors are dumb
pipes" invariant — the connector knows its own API shape.

### § 7.4 Field mapping must not duplicate associations

Association predicates (e.g. `companyId`, `orgId`) must **not** appear in the `fields`
list of the channel mapping config. They are not plain data fields — the engine has no
canonical value for them in shadow state; the identity remapping in § 7.2 supersedes any
field-level mapping. Including them in `fields` would produce a stale unmapped local ID in
the canonical record, which is meaningless to any other system.

## Design Rationale

### Why Not Embed in `data`?

Associations could be encoded in `data` using a convention (e.g. all fields ending in `Id` are
references). Rejected because:
1. The engine would need to know the ID-naming convention for every connector
2. Same-name fields in different APIs mean different things
3. Multi-valued associations (e.g. an order with multiple `lineItems`) would require extra
   conventions for arrays

An explicit declaration has zero ambiguity and zero convention.

### Why a Separate Array, Not Inline in `data`?

Keeping `associations` separate from `data` means connectors don't have to modify the raw
field values at all. The connector just adds the index alongside the unchanged `data`; the
engine reads both. This separation also allows `data` to remain a faithful copy of the source
API payload, which preserves the "raw data, no transformation" guarantee.
