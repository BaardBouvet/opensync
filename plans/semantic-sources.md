# Semantic & Graph-Structured Sources

> **Status: aspirational** — the connector SDK and shadow state are designed to accommodate this, but the graph/triple backend is not implemented.

## The Challenge

The current connector model assumes **well-defined entity types with structured records**: a contact has `id`, `name`, `email`. But real-world sources are messier:

- **RDF graphs** (FOAF, schema.org, knowledge graphs) have no fixed schema — predicates are discovered at runtime
- **JSON-LD** APIs return nested, hierarchical data with semantic URIs
- **Knowledge bases** have entities with variable properties per instance
- **Semantic triple stores** make relationships first-class, not embedded

These violate three core assumptions:

1. **Entity types are pre-declared** ← RDF types are URIs; any subject can have any predicate
2. **Properties are single-valued** ← RDF allows `foaf:email` for both "alice@work" AND "alice@home"
3. **Structure is relational** ← Graph sources are fundamentally relationship-centric, not entity-centric

## Design Goals

We want to:

✅ **Support graph/semantic sources without breaking existing connectors**  
✅ **Keep simple connectors idiomatically simple**  
✅ **Enable future graph-first engine variants without rewriting all connectors**  
✅ **Avoid premature complexity in the relational engine**

## Solution: Backwards-Compatible NormalizedRecord

Extend `NormalizedRecord` and the connector interface minimally, with opt-in complexity.

### Core Changes to SDK

```typescript
interface NormalizedRecord {
  id: string;
  data: Record<string, unknown | unknown[]>;    // properties can be single or multi-valued
  associations?: Association[];                   // explicit relationships
  // ...existing fields
}

interface Association {
  predicate: string;           // e.g. "knows", "worksAt", "manager", "isAuthorOf"
  targetId: string;            // external ID in source
  targetEntity?: string;       // optional: entity type hint (e.g. "person", "company")
  metadata?: Record<string, unknown>; // relationship properties (e.g. { since: "2020-01-01", role: "CEO" })
}

interface ConnectorMetadata {
  // ...existing fields
  graphAware?: boolean;        // connector can return multi-valued properties and rich associations
}

interface StreamDefinition {
  // ...existing fields
  graphAware?: boolean;        // override per-stream; null = inherit from metadata
}
```

### Relational Connectors (Unchanged)

For 99% of connectors (HubSpot, Fiken, Tripletex), nothing changes:

```typescript
// Connector author writes exactly what they write today
getStreams(ctx) {
  return [{
    entity: 'contact',
    async *read(ctx, since) {
      const records = await ctx.api.get('/contacts');
      yield records.map(r => ({
        id: r.id,
        data: {
          firstName: r.first_name,
          lastName: r.last_name,
          email: r.email,
          phone: r.phone
        }
        // no associations needed; no multi-valued properties
      }));
    }
  }];
}
```

The engine validates that `data` has only single-valued primitives. Passes validation. Done.

### Graph-Aware Connectors (Opt-In)

For RDF, Solid pods, knowledge graphs:

```typescript
const metadata = {
  name: 'foaf-graph',
  graphAware: true,  // signal: we emit multi-valued properties
  // ...
};

getStreams(ctx) {
  return [{
    entity: 'person',
    graphAware: true,  // inherited from metadata but can override
    async *read(ctx, since) {
      const graph = await ctx.api.get('/graph.jsonld');
      
      yield graph['@graph'].map(node => ({
        id: node['@id'],
        data: {
          name: node['http://xmlns.com/foaf/0.1/name'],
          email: node['http://xmlns.com/foaf/0.1/mbox'],     // could be string or array
          phone: node['http://xmlns.com/foaf/0.1/phone'],    // could be string or array
        },
        associations: (node['http://xmlns.com/foaf/0.1/knows'] || [])
          .flat()
          .map(ref => ({
            predicate: 'knows',
            targetId: ref['@id'],
            targetEntity: 'person'
          }))
      }));
    }
  }];
}
```

The engine validates: if `graphAware: true`, multi-valued properties are OK. Otherwise, they're errors.

### JSON-LD: A Native Format

JSON-LD is RDF as JSON. Connectors that consume JSON-LD APIs can emit it with minimal transformation:

```typescript
getStreams(ctx) {
  return [{
    entity: 'resource',
    graphAware: true,
    async *read(ctx, since) {
      const jsonld = await ctx.api.get('/ld');  // returns @context + @graph
      
      yield jsonld['@graph'].map(doc => ({
        id: doc['@id'],
        data: doc,  // keep entire JSON-LD object; @context tells the story
        associations: extractJsonLdReferences(doc)  // infer @id links as edges
      }));
    }
  }];
}

function extractJsonLdReferences(doc) {
  const refs = [];
  function walk(obj, key) {
    if (obj && obj['@id']) refs.push({ predicate: key, targetId: obj['@id'] });
    else if (Array.isArray(obj)) obj.forEach(item => walk(item, key));
  }
  for (const [key, val] of Object.entries(doc)) {
    if (key !== '@context' && key !== '@id') walk(val, key);
  }
  return refs;
}
```

## Engine Behavior

### Relational Engine (Current)

**For `graphAware: false` (default)**:
- Validates that all properties are single-valued (strings, numbers, booleans, objects, but not arrays)
- Throws error if multi-valued or if `targetEntity` doesn't match a known stream
- Stores in shadow state as today: JSONB field-level tracking

**For `graphAware: true`**:
- Accepts multi-valued properties (arrays)
- De-duplicates / flattens as needed for storage
- Stores associations in the `associations` table with predicate + targetId
- Stores in shadow state: still field-level, but handles array serialization

**Result**: Same engine logic; just more lenient on input shape.

### Conflict Resolution

**Field-level** still applies:
```yaml
conflictRules:
  field:
    email:
      master: "hubspot"  # for field 'email', always prefer hubspot
```

For multi-valued fields, the master wins the entire property (all values), not individual elements.

### Shadow State Schema (Flexible)

Current schema is:
```json
{
  "email": {
    "val": "alice@example.com",
    "prev": "old@example.com",
    "ts": 1711993200,
    "src": "hubspot"
  }
}
```

For multi-valued properties:
```json
{
  "email": {
    "val": ["alice@work.com", "alice@home.com"],
    "prev": ["alice@old.com"],
    "ts": 1711993200,
    "src": "hubspot"
  }
}
```

Same structure; just arrays instead of scalars.

## Future: Graph Engine Compatibility

If we later build a **graph-first engine** (property graph or triple-store backend):

**Reusable components**:
- Same connector interface, same output
- Same identity map (entity UUID → external ID links)
- Same association table (now directly queryable as edges)
- Same conflict resolution logic (now at triple level instead of field level)

**What changes**:
- Shadow state tracks **predicates**, not **fields** (triple-level metadata)
- Diffing is **triple-level** instead of field-level
- Rollback is **triple-scoped** instead of record-scoped (even more precise)
- Transactions log individual triples, not record deltas

**Example**: Same FOAF connector, new backend

```
Relational engine runs it:
  - Flattens properties into record fields
  - Tracks which system owns "email" field
  - Conflicts resolved field-by-field

Graph engine runs it:
  - Stores triples for each (subject, predicate, object)
  - Tracks which system asserted each triple
  - Conflicts resolved triple-by-triple
  - Can answer: "all graphs that mention alice@example.com"
```

Both engines ingest the same connector output; storage + diffing differ.

## Avoiding Over-Design

**We are NOT**:
- Changing the relational engine's core logic
- Adding graph query support to the relational engine
- Requiring connectors to think about graphs
- Adding RDF parsing to the SDK

**We ARE**:
- Allowing multi-valued properties if declared
- Storing associations in a queryable table
- Documenting the path for future graph engines
- Making it idiomatically simple to write both relational and graph connectors

## Example: Three Connector Styles

### 1. Relational (No Change)

```typescript
// HubSpot connector
getStreams(ctx) {
  return [{
    entity: 'contact',
    async *read(ctx, since) {
      yield [{
        id: '123',
        data: { name: 'Alice', email: 'alice@hubspot.com' }
      }];
    }
  }];
}
```

### 2. Relational with Foreign Keys

```typescript
// HubSpot with nested companies
getStreams(ctx) {
  return [{
    entity: 'contact',
    async *read(ctx, since) {
      yield [{
        id: '123',
        data: { name: 'Alice', email: 'alice@hubspot.com' },
        associations: [
          { predicate: 'worksAt', targetId: 'company-456', targetEntity: 'company' }
        ]
      }];
    }
  }];
}
```

### 3. Graph-Aware

```typescript
// Solid / FOAF
const metadata = { name: 'foaf', graphAware: true };

getStreams(ctx) {
  return [{
    entity: 'person',
    graphAware: true,
    async *read(ctx, since) {
      yield [{
        id: 'alice@example.com',
        data: {
          name: 'Alice Chen',
          email: ['alice@work.com', 'alice@home.com'],  // multi-valued
        },
        associations: [
          { predicate: 'knows', targetId: 'bob@example.com', targetEntity: 'person' },
          { predicate: 'worksAt', targetId: 'acme-corp', targetEntity: 'company' }
        ]
      }];
    }
  }];
}
```

All three work in the relational engine. All three remain simple for the connector author.

## Decisions

- **Multi-valued properties**: Array support in `data`, opt-in via `graphAware: true`
- **Associations**: Explicit relationships; engine infers from or validates against `dependsOn`
- **Schema flexibility**: No schema inference in the relational engine; graph-aware connectors just emit what they find
- **JSON-LD**: Treat as valid connector output; @context describes semantics, engine stays neutral
- **Engine changes**: Minimal — accept multi-valued properties in shadow state; store associations table as today

## Decisions

- **Multi-valued properties**: Array support in `data`, opt-in via `graphAware: true`
- **Associations**: Explicit relationships; engine infers from or validates against `dependsOn`
- **Schema flexibility**: No schema inference in the relational engine; graph-aware connectors just emit what they find
- **JSON-LD**: Treat as valid connector output; @context describes semantics, engine stays neutral
- **Engine changes**: Minimal — accept multi-valued properties in shadow state; store associations table as today
- **Transaction log format**: Backend-specific. Relational backend stores field-level mutations; graph backend would store triple-level assertions/retractions.
- **Query layer**: Out of scope. See [data-access.md](data-access.md) for how the relational backend exposes shadow state as a queryable data layer. Graph backends would define their own query interfaces.

## Open Questions

1. Should we provide helper functions for extracting JSON-LD references? (e.g., `extractJsonLdReferences()`)
   - **Decided: Yes.** Provide SDK utilities for common JSON-LD patterns to reduce connector boilerplate.

2. Should `Association.metadata` have a schema, or is it free-form?
   - **Decided: Free-form (backend-agnostic).** `Association.metadata` is `Record<string, unknown>`. Specific backends can document what metadata fields they recognize, but the SDK doesn't enforce a schema.

3. When a relational engine encounters a multi-valued property from a `graphAware: false` connector, should it error or warn?
   - **Decided: Neither.** Treat arrays as atomic values. The relational engine doesn't special-case them — `email: ["a", "b"]` just stores as a JSON array in shadow state's `data` field. The connector author made the choice; we respect it.
