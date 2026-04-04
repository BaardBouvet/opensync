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
