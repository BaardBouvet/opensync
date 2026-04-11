# Triplestore-Based Sync Architecture: Design Plan

**Status:** backlog  
**Date:** 2026-04-11  
**Effort:** XL  
**Domain:** Architecture  

---

## Executive Summary

This plan explores a fundamental reimagining of OpenSync using RDF (Resource Description Framework) as the persistent data model instead of SQLite tables + JSON blobs. Rather than storing records with field-level metadata (`{ val, prev, ts, src }`), we store **facts as triples** `(subject, predicate, object)` in a queryable knowledge graph.

The core promise:
- **Simpler model**: All facts are triples. Provenance lives in named graphs. History is implicit in the graph structure.
- **Semantic power**: Associations, calculations, and reasoning are first-class — expressed via SPARQL queries, not imperative code.
- **Built-in lineage**: Data flows follow RDF predicates; lineage queries are standard SPARQL.
- **Flexible configuration**: Mappings, conflict rules, and workflows are declarative SPARQL queries or a YAML layer above them.
- **Better for reasoning**: AI agents can inspect and generate SPARQL directly; the graph structure is explicit and inspectable.

This is **not** a drop-in replacement for the current OpenSync. It is a **different architecture** with different tradeoffs. This plan outlines the redesign and identifies key decisions, unknowns, and iteration points.

---

## Section 1: Data Model

### § 1.1 From Records to Facts

**Current model:**
```json
{
  "id": "hs_conn_123",
  "email": { "val": "alice@acme.com", "prev": "alice@old.com", "ts": 1711993200, "src": "hubspot" },
  "name": { "val": "Alice A.", "prev": null, "ts": 1711993180, "src": "hubspot" }
}
```

Each field carries its entire history inline.

**Proposed triplestore model:**

Instead of records, we store **immutable triples**:

```
# Namespace: http://opensync.example.com/

# Current facts (latest graph for read purposes)
<hubspot:contact/hs_conn_123>  email                "alice@acme.com" .
<hubspot:contact/hs_conn_123>  name                 "Alice A." .
<hubspot:contact/hs_conn_123>  rdf:type             Contact .

# History (temporal triples—appended, never deleted)
<hubspot:contact/hs_conn_123>  email:version1       "alice@old.com" .
<hubspot:contact/hs_conn_123>  email:version2       "alice@acme.com" .

# Provenance (which connector synced this, when)
<hubspot:contact/hs_conn_123>  prov:wasSync'd       _:sync_batch_001 .
_:sync_batch_001                prov:connector       "hubspot" .
_:sync_batch_001                prov:timestamp       "2026-04-11T10:30:00Z" .
_:sync_batch_001                prov:watermark       "cursor:abc123" .
```

**Key properties:**
1. **Immutability**: Once written, a triple is never modified — only new triples are added.
2. **Versioning**: History is encoded via named versions (`email:version1`, `email:version2`) or separate temporal predicates.
3. **Provenance**: Every fact links to metadata about where it came from (connector, timestamp, batch).
4. **Subjects as identity**: External IDs map to subjects; the same real-world entity has one subject per source system and one canonical subject.

### § 1.2 Named Graphs for Connector-Specific Views

Each connector maintains its own **named graph**. When `hubspot.read()` pulls records, they populate the `hubspot` graph. When Salesforce is synced, records go into the `salesforce` graph. When we reconcile and write canonical facts, they go into the `canonical` graph.

```
# HubSpot's view of contacts (read from API, unmodified)
GRAPH <http://opensync.example.com/graphs/hubspot> {
  <hubspot:contact/hs_conn_123>  email  "alice@acme.com" .
  <hubspot:contact/hs_conn_123>  name   "Alice A." .
}

# Salesforce's view (potentially different field names, different ID scheme)
GRAPH <http://opensync.example.com/graphs/salesforce> {
  <salesforce:contact/sf_555>  email__c      "alice@acme.com" .
  <salesforce:contact/sf_555>  Name          "Alice A." .
}

# Canonical reconciled view (conflicts resolved, semantic transforms applied)
GRAPH <http://opensync.example.com/graphs/canonical> {
  <canonical:contact/id_uuid_123>  email  "alice@acme.com" .
  <canonical:contact/id_uuid_123>  name   "Alice A." .
}
```

**Benefits:**
- Diffs are graph comparisons: what triples exist in `salesforce` but not in `canonical`?
- Rollback is graph surgery: remove triples from a connector's graph.
- Connector independence: no need to agree on field names at storage time. Mapping happens at the SPARQL/config layer.
- Time travel: store temporal versions of each graph (similar to a ledger).

### § 1.3 Identity and Cross-System Linking

Instead of an `identity_map` table, we use **sameAs predicates**:

```
# Link all external IDs to one canonical subject
<canonical:contact/id_uuid_123>  owl:sameAs  <hubspot:contact/hs_conn_123> .
<canonical:contact/id_uuid_123>  owl:sameAs  <salesforce:contact/sf_555> .
<canonical:contact/id_uuid_123>  owl:sameAs  <slack:user/U999> .
```

**Matching logic** (identity resolution):
- **Explicit links**: User manually onboards a HubSpot contact and Salesforce contact as the same entity → writer creates `sameAs` triple.
- **Watermark-based**: New HubSpot contact with email  `alice@acme.com` arrives. Query asks: "Does any other system's contact have the same email?" If yes, apply `sameAs`.
- **Configurable matching** via SPARQL: Admins write queries that define equivalence rules (e.g., "contacts match if email + domain are the same" or "companies match if normalized name + country + employee count range").

---

## Section 2: Connector Contract (Redux)

### § 2.1 What Connectors Produce

Rather than `ReadRecord[]` (free-form JSON with string IDs), connectors produce **normalized RDF triples**.

**Proposal:**

```typescript
interface Triple {
  subject: string;      // IRI (e.g., "hubspot:contact/hs_conn_123")
  predicate: string;    // IRI (e.g., "email", "name", "phone")
  object: string | number | boolean | null | { value: string; datatype: string };
  // optional provenance
  createdAt?: string;   // ISO 8601
  source?: string;      // connector ID
}

interface ReadTripleBatch {
  triples: Triple[];
  graph?: string;       // which named graph to write to; default = connector ID
  watermark?: string;   // engine stores for resumption
}

interface EntityDefinition {
  name: string;  // e.g., 'contact'
  
  // Returns triples instead of records
  read?(ctx: ConnectorContext, since?: string): AsyncIterable<ReadTripleBatch>;
  
  // Lookup by subject IRIs instead of IDs
  lookup?(subjects: string[], ctx: ConnectorContext): Promise<Triple[]>;
  
  // Insert/update/delete by subject
  insert?(triples: AsyncIterable<Triple>, ctx: ConnectorContext): AsyncIterable<InsertResult>;
  update?(triples: AsyncIterable<Triple>, ctx: ConnectorContext): AsyncIterable<UpdateResult>;
  delete?(subjects: AsyncIterable<string>, ctx: ConnectorContext): AsyncIterable<DeleteResult>;
  
  // ... rest as before
}
```

**Simplification achieved:**
- Connectors don't handle JSON-to-field mappings. They just produce triples with their native IDs.
- Field names in triples reflect the external system's semantics (e.g., `email__c` for Salesforce, `email` for HubSpot).
- The engine's mapping layer (next section) handles semantic translation.

**Complexity introduced:**
- Connector authors must understand RDF and IRIs.
- Mitigation: Provide helper libraries that hide this (`@opensync/sdk/rdf-helpers`).
  ```typescript
  // Helper: construct IRIs easily
  const subject = makeSubject('hubspot', 'contact', record.id);
  
  // Helper: record to triples
  const triples = recordToTriples(subject, record, {
    idField: 'id',
    fieldsToIgore: ['_internal'],
  });
  ```

---

## Section 3: Configuration: SPARQL + YAML Hybrid

### § 3.1 The Problem

Current OpenSync config:
```yaml
channels:
  - id: contacts
    members:
      - connectorId: hubspot
        entity: contact
        inbound:
          - source: firstname
            target: givenName
          - source: email
            target: email
        outbound:
          - source: givenName
            target: firstname
          - source: email
            target: email
```

This works for field renames. It breaks down for:
- Semantic merges ("first_name" + "last_name" → "full_name")
- Conditional logic ("use Salesforce's account if it exists; else use HubSpot's")
- Calculated fields ("company_size_range" inferred from employee_count)

**Proposal:**

A two-layer config:

**Layer 1: YAML (high-level, for humans and UI generators)**
```yaml
channels:
  - id: contacts
    members:
      - connectorId: hubspot
        entity: contact
        graphName: hubspot  # optional; default = connectorId
        fieldMappings:
          - source: firstname
            target: givenName
          - source: lastname
            target: familyName
          - source: email
            target: email
          - source: hs_lead_status
            predicate: true  # special case: maps to a predicate not a field
            target: hubspot:leadStatus
    
    identityMatcher:
      type: sparql
      query: |
        SELECT ?subject ?canonical WHERE {
          ?subject a Contact .
          ?canonical a CanonicalContact .
          ?subject email ?email .
          ?canonical email ?email .
          FILTER (?email != "")
        }
    
    conflictResolution:
      strategy: field_masters
      masters:
        email: salesforce  # SF owns the email
        phone: hubspot      # HubSpot owns the phone
        name: last_write    # last system to write this field wins
```

**Layer 2: SPARQL (for advanced logic)**

For complex transformations, admins write SPARQL INSERT/UPDATE queries that the engine runs after a read to derive new triples:

```sparql
# Merge first + last name into canonical form
INSERT {
  GRAPH canonical {
    ?contact email:fullName ?fullName .
  }
}
WHERE {
  GRAPH canonical {
    ?contact email:givenName ?first .
    ?contact email:familyName ?last .
    BIND(CONCAT(?first, " ", ?last) AS ?fullName)
  }
};
```

The engine runs these transformations **after** ingest but **before** fan-out.

### § 3.2 Mapping Pipeline (Revised)

```
Source Connector.read()
  ↓ [produces triples with native field names]
GRAPH hubspot populated
  ↓
[YAML field mappings applied via CONSTRUCT query]
GRAPH canonical_from_hubspot populated
  ↓
[SPARQL WHERE clauses: identity resolution, deduplication]
canonical_subjects resolved
  ↓
[Conflict resolution rules: which triples "win"?]
GRAPH canonical (merged)
  ↓
[Reverse YAML mappings: canonical → target field names]
Target Connector triples prepared
  ↓
Target Connector.update/insert()
```

**How YAML mappings become SPARQL:**

The engine compiles the `fieldMappings` array into a CONSTRUCT query:

```sparql
CONSTRUCT {
  GRAPH canonical {
    ?subject ?targetPred ?object .
  }
}
WHERE {
  GRAPH hubspot {
    ?subject ?sourcePred ?object .
  }
  VALUES (?sourcePred ?targetPred) {
    (email:firstname email:givenName)
    (email:lastname email:familyName)
    (email:email email:email)
  }
}
```

**Benefits:**
- Mappings are transparent and inspectable (SPARQL queries are data).
- Advanced users can extend or override with hand-written SPARQL.
- Lineage is a graph traversal: follow the predicate chain from raw → canonical → target.

---

## Section 4: Conflict Resolution in a Triple Store

### § 4.1 The Challenge

In the current model, conflict resolution is per-field, comparing `{ val, ts, src }` across systems.

In RDF, triples are facts. When two systems assert the same predicate on the same subject with different objects, we have a conflict.

```sparql
# HubSpot says:
canonical:contact/id_001  email  "alice@acme.com" .

# Salesforce says:
canonical:contact/id_001  email  "alice.a@work.com" .
```

### § 4.2 Conflict Resolution Strategies

**Strategy 1: Field Masters (declarative)**

```yaml
conflictResolution:
  strategy: field_masters
  masters:
    email: hubspot      # HubSpot's email always wins
    phone: salesforce   # Salesforce's phone always wins
```

The engine filters: keep only triples made by the master.

**Strategy 2: Last-Write-Wins**

```yaml
conflictResolution:
  strategy: last_write_wins
  checkTimestamps: true  # compare prov:timestamp triples
```

Keep the triple from the sync with the most recent timestamp.

**Strategy 3: Custom SPARQL Reasoner**

```yaml
conflictResolution:
  strategy: sparql_custom
  query: |
    # If email is in the form @acme.com, prefer HubSpot; else prefer Salesforce
    SELECT ?winner WHERE {
      {
        FILTER (STRSTARTS(?email, "@acme.com"))
        BIND("hubspot" AS ?winner)
      }
      UNION
      {
        FILTER (!STRSTARTS(?email, "@acme.com"))
        BIND("salesforce" AS ?winner)
      }
    }
```

### § 4.3 Implementation

When ingesting from a connector:

1. **Add triples** to that connector's named graph.
2. **Query to find conflicts**: "Are there different objects for the same predicate across graphs?"
3. **Apply conflict resolution rule**: decide which triple to promote to `canonical` graph.
4. **Log the decision** via provenance (why this one won).

---

## Section 5: Safety & Rollback

### § 5.1 Rolling Back via Graph Surgery

Current: Restore from a transaction log.

**Proposed**: Graph snapshots + triple-level deletion.

Each sync batch records:
- Which triples were added to which graphs (INSERT log)
- Which triples were removed (DELETE log, if used)

```sparql
DELETE {
  GRAPH canonical {
    ?subject ?predicate ?object .
  }
}
WHERE {
  # Delete all triples written in batch batch_id_789
  ?subject prov:addedInBatch "batch_id_789" .
  ?subject ?predicate ?object .
}
```

**Benefits:**
- Surgical rollback: revert one batch without touching others.
- Atomic: SQLite or ACID-compliant triplestore ensures consistency.
- Observable: inspect which triples belonged to which batch via provenance queries.

### § 5.2 Circuit Breakers

Same logic as current, but query-based:

```sparql
# Detect oscillation: did this predicate change more than N times in the last hour?
SELECT (COUNT(?version) AS ?changeCount) WHERE {
  ?subject email:version ?version .
  ?subject prov:wasModified [
    prov:timestamp ?ts ;
  ] .
  FILTER (?ts > NOW() - "PT1H"^^xsd:duration)
}
HAVING (?changeCount > 5)
```

---

## Section 6: Triplestore Backend Options

### § 6.1 Candidates

| Store | Upsides | Downsides |
|-------|---------|-----------|
| **RDF4J** (with SQLite backend) | Mature SPARQL, Java (JVM) | Heavyweight; not native TS/Node |
| **Oxigraph** (Rust, embedded) | Fast, embeddable, SPARQL 1.1 support | Smaller ecosystem; less proven in prod |
| **Postgres + RDF extension + IVM** ⭐ | ACID guarantees, native Postgres, incremental materialization for recomposition queries | SPARQL via extension (maturity varies); requires Postgres 14+ |
| **LDF (Linked Data Fragments)** | Fits hub-and-spoke model | Experimental for this use case |
| **Custom on SQLite + SPARQL engine** | Full TS control, simple deploy | Reinvent SPARQL parser and query planner |
| **Duckdb + RDF extension** | Very fast; good analytics | Early-stage RDF support |
| **Semantic databases (AllegroGraph, Virtuoso)** | Enterprise-grade | Expensive, requires hosted service |

**Recommended approach (updated)**: **Postgres + RDF extension + IVM** for production deployments where Postgres is already in use. **Oxigraph** for embedded/edge deployments or early prototypes. Both implement the same `TripleStore` interface (§ 6.2).

### § 6.2 API Layer

Provide a minimal `TripleStore` interface:

```typescript
interface TripleStore {
  // Execute a SPARQL query (SELECT, CONSTRUCT, ASK)
  query(sparql: string): Promise<QueryResult>;
  
  // Execute INSERT DATA or DELETE DATA
  mutate(sparql: string): Promise<void>;
  
  // Load from file or string (Turtle, RDF/XML, etc.)
  load(data: string, format: 'turtle' | 'jsonld' | 'rdfxml'): Promise<void>;
  
  // Export graph
  dump(graphName?: string, format?: 'turtle' | 'jsonld'): Promise<string>;
  
  // Transactions
  begin(): Transaction;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
```

Similar to the current `Db` adapter pattern, we define a `TripleStore` interface and swap implementations for different backends.

### § 6.3 Postgres + RDF Extension + IVM: A Production-Grade Approach

For organizations already running Postgres, a **Postgres-native RDF backend with Incremental View Maintenance (IVM)** offers significant advantages, especially for recomposition queries.

#### § 6.3.1 Architecture

```
OpenSync Engine (Node.js / TypeScript)
  ↓ (SPARQL via SQL wire protocol)
Postgres TripleStore Extension
  ├─ Triple storage (subject, predicate, object, graph)
  ├─ Named graphs (hubspot, salesforce, canonical)
  └─ Materialized views (IVM-maintained)
      ├─ hubspot_flat_contact_view (pre-computed recomposition)
      ├─ salesforce_nested_contact_view
      └─ shopify_array_contact_view
```

#### § 6.3.2 Storage Layout

The RDF extension stores triples as relational tables:

```sql
CREATE TABLE triples (
  subject IRI,
  predicate IRI,
  object TEXT,  -- or typed_value for Postgres types
  graph IRI,
  added_batch UUID,
  added_timestamp TIMESTAMPTZ,
  PRIMARY KEY (subject, predicate, object, graph)
);

CREATE INDEX idx_triples_subject ON triples(subject);
CREATE INDEX idx_triples_predicate ON triples(predicate);
CREATE INDEX idx_triples_object ON triples(object);
CREATE INDEX idx_triples_graph ON triples(graph);
```

#### § 6.3.3 IVM Materialization for Recomposition

The key advantage: **use IVM to pre-materialize expensive recomposition queries**. Instead of running the CONSTRUCT query on-demand (which traverses blank nodes, JOINs across graphs, etc.), the query runs once and subsequent changes are **incrementally** applied.

**Example: HubSpot recomposition view**

```sql
-- Instead of running the CONSTRUCT query every time,
-- create a materialized view that stays up-to-date automatically

CREATE MATERIALIZED VIEW hubspot_contact_export AS
CONSTRUCT {
  ?contact_out hubspot:firstname ?first ;
               hubspot:lastname ?last ;
               hubspot:billing_street ?b_street ;
               hubspot:billing_city ?b_city ;
               hubspot:billing_zip ?b_zip ;
               hubspot:shipping_street ?s_street ;
               hubspot:shipping_city ?s_city ;
               hubspot:shipping_zip ?s_zip .
}
WHERE {
  GRAPH canonical {
    ?contact_in rdf:type canonical:Contact ;
                canonical:firstName ?first ;
                canonical:lastName ?last .
    
    OPTIONAL {
      ?contact_in canonical:billingAddress ?billing_addr .
      OPTIONAL { ?billing_addr canonical:street ?b_street . }
      OPTIONAL { ?billing_addr canonical:city ?b_city . }
      OPTIONAL { ?billing_addr canonical:zipCode ?b_zip . }
    }
    
    OPTIONAL {
      ?contact_in canonical:shippingAddress ?shipping_addr .
      OPTIONAL { ?shipping_addr canonical:street ?s_street . }
      OPTIONAL { ?shipping_addr canonical:city ?s_city . }
      OPTIONAL { ?shipping_addr canonical:zipCode ?s_zip . }
    }
  }
};

-- Enable IVM on this view
ALTER MATERIALIZED VIEW hubspot_contact_export SET INCREMENTAL;
```

**What IVM does:**
1. When the `canonical` graph changes, the extension **calculates only the delta** (affected rows).
2. The materialized view is updated **incrementally**, not recomputed from scratch.
3. When the engine needs to write back to HubSpot, it queries the pre-materialized flat view — **instant access** to the correct structure.

**Performance impact:**
- First materialization: slow (but one-time)
- Recomposition on-write: O(1) lookup + incremental maintenance cost
- vs. on-demand CONSTRUCT: O(N) JOIN + blank node traversal every sync cycle

#### § 6.3.4 Materialized Views for Each Target System

Create one materialized view per target system's expected shape:

```sql
-- Salesforce (nested JSON)
CREATE MATERIALIZED VIEW salesforce_contact_export AS
CONSTRUCT {
  ?contact_out salesforce:Name ?name ;
               salesforce:MailingAddress [
                 salesforce:Street ?b_street ;
                 salesforce:City ?b_city ;
                 salesforce:PostalCode ?b_zip
               ] .
} WHERE { /* nested structure query */ };
ALTER MATERIALIZED VIEW salesforce_contact_export SET INCREMENTAL;

-- Shopify (array)
CREATE MATERIALIZED VIEW shopify_customer_export AS
CONSTRUCT {
  ?customer_out shopify:email ?email ;
                shopify:addresses [
                  rdf:type rdf:Seq ;
                  rdf:_1 [ shopify:street1 ?s1 ; shopify:city ?c1 ] ;
                  rdf:_2 [ shopify:street1 ?s2 ; shopify:city ?c2 ]
                ] .
} WHERE { /* array structure query */ };
ALTER MATERIALIZED VIEW shopify_customer_export SET INCREMENTAL;
```

#### § 6.3.5 TripleStore Interface Implementation for Postgres

```typescript
class PostgresTripleStore implements TripleStore {
  private pg: Pool;
  
  async query(sparql: string): Promise<QueryResult> {
    // Convert SPARQL to SQL (or use extension's SPARQL-to-SQL translator)
    const sql = this.sparqlToSql(sparql);
    const result = await this.pg.query(sql);
    return this.formatResult(result);
  }
  
  async mutate(sparql: string): Promise<void> {
    const sql = this.sparqlToSql(sparql);
    await this.pg.query(sql);
  }
  
  // For recomposition: fetch from materialized view
  async getMaterializdView(viewName: string): Promise<any[]> {
    const result = await this.pg.query(
      `SELECT * FROM ${viewName}`
    );
    return result.rows;
  }
  
  async begin(): Promise<Transaction> {
    const client = await this.pg.connect();
    await client.query("BEGIN");
    return new PostgresTransaction(client);
  }
}
```

#### § 6.3.6 Hybrid Approach: On-Demand + Materialized

For maximum flexibility:

- **Materialized views**: For predictable, high-frequency recomposition queries (the 80% case)
- **On-demand SPARQL**: For ad-hoc, custom, or rarely-used queries (the 20% case)

Configuration:

```yaml
channels:
  - id: contacts_sync
    members:
      - connectorId: hubspot
        entity: contact
        recomposition:
          strategy: materialized_view
          view_name: hubspot_contact_export
          refresh_policy: incremental
      
      - connectorId: salesforce
        entity: contact__c
        recomposition:
          strategy: materialized_view
          view_name: salesforce_contact_export
          refresh_policy: incremental
      
      - connectorId: custom_analytics
        entity: contact_stats
        recomposition:
          strategy: on_demand_sparql
          query: |
            CONSTRUCT { ... } WHERE { ... }
```

#### § 6.3.7 Circuit Breakers & Safety with IVM

Circuit breaker thresholds can query the materialized views for real-time dashboards:

```sql
-- Real-time sync health view
CREATE MATERIALIZED VIEW sync_health AS
SELECT
  connector_id,
  COUNT(*) as total_contacts,
  COUNT(*) FILTER (WHERE added_timestamp > NOW() - INTERVAL '1 hour') as recent,
  (COUNT(*) FILTER (WHERE added_timestamp > NOW() - INTERVAL '1 hour')::float /
   NULLIF(COUNT(*), 0)) as hourly_change_rate
FROM triples
WHERE graph = 'canonical' AND predicate = 'rdf:type'
GROUP BY connector_id;

ALTER MATERIALIZED VIEW sync_health SET INCREMENTAL;
```

Then the engine queries this view to decide whether to DEGRADE or TRIP the circuit breaker.

#### § 6.3.8 Tradeoffs: Postgres+IVM vs. Oxigraph

| Aspect | Postgres+IVM | Oxigraph |
|--------|-------------|---------|
| **Deployment** | Requires Postgres 14+ | Embed in Node process |
| **SPARQL maturity** | Via extension (varies) | Native, SPARQL 1.1 certified |
| **Recomposition perf** | Fast (materialized) | Medium (on-demand queries) |
| **Incremental updates** | Fast (IVM delta) | Medium (full recompute) |
| **Debuggability** | SQL tools, psql | SPARQL debuggers |
| **Scaling** | Scales with Postgres infra | Scales with Node memory |
| **Ecosystem** | Mature Postgres tools | Growing Rust ecosystem |
| **Cost** | OSS or managed Postgres | OSS |
| **ACID guarantees** | ✓ (Postgres) | ✓ (if backend supports it) |

#### § 6.3.9 Recommended: Dual Support

Implement both backends behind the same `TripleStore` interface:

1. **Postgres+IVM** for production deployments (org already runs Postgres, needs performance)
2. **Oxigraph** for embedded/edge deployments, prototypes, or organizations without Postgres

Both pass the same test suite. Configuration selects which backend at startup:

```yaml
settings:
  tripleStoreBackend: postgres+ivm  # or "oxigraph"
  postgres:
    host: localhost
    port: 5432
    database: opensync_triples
    extensions:
      - rdf_extension_name
      - ivm_extension_name
```

---

## Section 7: Configuration & Tooling

### § 7.1 Declarative Configuration Format

```yaml
# opensync-triples.yaml

# Define namespace prefixes
namespaces:
  canonical: http://opensync.example.com/canonical/
  hubspot: http://hubspot.example.com/
  salesforce: http://salesforce.example.com/
  rdf: http://www.w3.org/1999/02/22-rdf-syntax-ns#
  prov: http://www.w3.org/ns/prov#

connectors:
  - id: hubspot
    type: hubspot
    config:
      accessToken: ${HUBSPOT_TOKEN}
    graphName: hubspot

  - id: salesforce
    type: salesforce
    config:
      instanceUrl: https://acme.salesforce.com
      clientId: ${SF_CLIENT_ID}
    graphName: salesforce

channels:
  - id: contacts_sync
    entities:
      - connector: hubspot
        entity: contact
        classUri: canonical:Contact
      - connector: salesforce
        entity: contact__c
        classUri: canonical:Contact
    
    # Identity resolution: which triples define "same entity"?
    identityMatching:
      type: "sparql"
      rule: |
        # Contacts with the same email are the same person
        ?hs_contact rdf:type canonical:Contact .
        ?sf_contact rdf:type canonical:Contact .
        ?hs_contact email:email ?email .
        ?sf_contact email:email ?email .
        FILTER (?email != "")
      canonical_subject_template: "canonical:contact/{emailHash}"
    
    # Field mapping: which HubSpot fields map to which Salesforce fields?
    fieldMappings:
      - connectorId: hubspot
        mappings:
          - hubspot_field: firstname
            canonical_predicate: canonical:givenName
          - hubspot_field: lastname
            canonical_predicate: canonical:familyName
          - hubspot_field: email
            canonical_predicate: canonical:email
      
      - connectorId: salesforce
        mappings:
          - salesforce_field: FirstName
            canonical_predicate: canonical:givenName
          - salesforce_field: LastName
            canonical_predicate: canonical:familyName
          - salesforce_field: Email
            canonical_predicate: canonical:email
    
    # Conflict resolution: when systems disagree, who wins?
    conflictResolution:
      strategy: field_masters
      masters:
        canonical:email: hubspot      # HubSpot owns email truth
        canonical:phone: salesforce    # Salesforce owns phone
        "**": last_write_wins          # Everything else: last write wins
    
    # Post-sync transformations
    derivations:
      - name: compute_fullname
        query: |
          INSERT {
            GRAPH canonical {
              ?contact canonical:fullName ?fullName .
            }
          }
          WHERE {
            GRAPH canonical {
              ?contact canonical:givenName ?given .
              ?contact canonical:familyName ?family .
              BIND(CONCAT(?given, " ", ?family) AS ?fullName)
            }
          }

# Global settings
settings:
  readTimeoutMs: 30000
  batchSize: 100
  tripleStoreBackend: "oxigraph"
  tripleStoreDbPath: "./sync-state.rdf"
```

### § 7.2 Connector Definition with Semantic Hints

Connectors can declare which RDF types and predicates they produce:

```typescript
export const connector: Connector = {
  metadata: {
    name: 'hubspot',
    version: '2.0.0',
    auth: { type: 'api-key' },
  },
  
  getEntities(ctx) {
    return [
      {
        name: 'contact',
        
        // RDF semantic hints
        classUri: 'hubspot:Contact',
        typeUri: 'rdf:Class',
        
        // Ontology: which predicates does this entity produce?
        predicates: {
          'hubspot:firstname': { type: 'xsd:string', description: 'First name' },
          'hubspot:lastname': { type: 'xsd:string', description: 'Last name' },
          'hubspot:email': { type: 'xsd:string', description: 'Email address' },
          'hubspot:hs_lead_status': { type: 'xsd:string', enum: ['LEAD', 'PROSPECT', ...] },
        },
        
        async *read(ctx, since) {
          // ... fetch from HubSpot API ...
          yield {
            triples: [
              {
                subject: 'hubspot:contact/hs_123',
                predicate: 'hubspot:firstname',
                object: 'Alice',
              },
              // ...
            ],
            watermark: cursor,
          };
        },
      },
    ];
  },
};
```

---

## Section 8: Comparison: Current vs. Proposed

| Aspect | Current OpenSync | Proposed Triplestore |
|--------|------------------|----------------------|
| **Core data model** | Records + field metadata | Immutable triples in named graphs |
| **Identity** | identity_map table + UUID | owl:sameAs predicates |
| **History** | Embedded in `prev` field | Separate versioned triples or temporal graph |
| **Provenance** | Separate prov fields | Named graphs + prov: predicates |
| **Configuration** | YAML field mappings | YAML + SPARQL hybrid |
| **Conflict resolution** | Imperative: per-field rules | Declarative: SPARQL or simple masters config |
| **Lineage** | Requires custom queries | Built-in: follow predicate chains |
| **Reasoning** | No native support | SPARQL inference rules |
| **Associaations** | Special assocMappings config | Just triples + SPARQL (rdfs:seeAlso, etc.) |
| **Rollback** | Transaction log replay | Graph snapshot + targeted triple deletion |
| **Connector contract** | Records (JSON) → Records | Raw triples → Triples |
| **Complexity for authors** | Simple (JSON in/out) | Moderate (IRI + RDF basics) |
| **Queryability** | SQL on shadow state | Full SPARQL on triple store |

---

## Section 9: Development Roadmap (High-Level Phases)

### Phase 1: Foundation (Weeks 1–2)
- [ ] Choose triplestore backend (likely Oxigraph).
- [ ] Implement `TripleStore` interface wrapping the backend.
- [ ] Adapt one existing connector (e.g., mock-crm) to produce triples.
- [ ] Write basic tests: connector → triples → query results.
- [ ] Spec out the YAML configuration format.

### Phase 2: Ingest & Identity (Weeks 3–4)
- [ ] Implement `ingestTriples()` pipeline: connector read → named graph population.
- [ ] Implement identity resolution: SPARQL-based matching.
- [ ] Test onboarding: mark two system records as "same entity."
- [ ] Implement `owl:sameAs` linking.

### Phase 3: Mapping & Conflict (Weeks 5–6)
- [ ] Compile YAML fieldMappings → SPARQL CONSTRUCT queries.
- [ ] Implement conflict resolution: fields masters + last-write-wins.
- [ ] Test fan-out: canonical → target system mappings.
- [ ] Add derivations: post-sync SPARQL transforms.

### Phase 4: Connectors & Safety (Weeks 7–8)
- [ ] Adapt 2–3 more connectors (Salesforce, Postgres).
- [ ] Implement rollback: batch triples deletion.
- [ ] Implement circuit breakers: oscillation detection via SPARQL.
- [ ] Add observability: query the graph for lineage, audit trails.

### Phase 5: UI & Agent Helpers (Weeks 9+)
- [ ] Update browser playground to visualize triplestore graphs.
- [ ] Write `@opensync/sdk/rdf-helpers`: utilities for connector authors.
- [ ] Document the new config format.
- [ ] Build agent prompt for triplestore nav & reasoning.

---

## Section 10: Key Decisions to Iterate

### § 10.1 Versioning Strategy

**Option A: Separate version triples**
```sparql
subject  predicate:v1  "value1" .
subject  predicate:v2  "value2" .
```
Simple but clutters the graph.

**Option B: Temporal named graphs**
```sparql
GRAPH <g/hubspot/timestamp_t1> { subject predicate value . }
GRAPH <g/hubspot/timestamp_t2> { subject predicate value . }
```
Cleaner but requires graph proliferation.

**Option C: Hybrid (current best guess)**
Keep only latest triples in `canonical`; archive old triples in a `history` graph. Query either.

### § 10.2 Provenance Granularity

Should provenance triples be stored:
- Per batch? (lightweight aggregation)
- Per triple? (heavyweight but queryable)
- Per transaction? (between the two)

### § 10.3 Watermark Storage

Where should watermarks live?
- **In the triplestore**: Makes them part of the queryable state (clean).
- **In a separate KV store** (similar to current): Simple, doesn't pollute the graph.
- **Hybrid**: Write to both for failover.

### § 10.4 External ID Mapping

Do we need a secondary index like `identity_map`, or is `owl:sameAs` sufficient?
- Performance implications for large graphs.
- Materialized view (eager) vs. query-time (lazy).

---

## Section 11: Open Questions & Risks

### § 11.1 Performance

- **How fast is SPARQL on a million-triple graph?** Benchmark Oxigraph.
- **Indexing strategy**: Full-text search, property indexes, others?
- **Fan-out performance**: Is a SPARQL JOIN query fast enough to replace the current imperative fan-out loop?

### § 11.2 Learning Curve

- Connector authors need to learn RDF + IRIs. Mitigation: SDK helpers + templates.
- Config authors need to learn SPARQL for advanced cases. Mitigation: YAML layer + examples.
- Is the YAML abstraction sufficient for the 80% case?

### § 11.3 Debugging & Observability

- How do we make SPARQL errors user-friendly?
- How do we visualize a 1M-triple graph for debugging?
- Can we generate lineage diagrams automatically from the graph?

### § 11.4 Ecosystem

- Are there mature SPARQL engines in Node / Bun? (Check Oxigraph, RDF4J JS, others.)
- What about migration path from current SQLite model to RDF? (Research tools like RML, R2RML.)

### § 11.5 Backend Selection: Postgres+IVM vs. Oxigraph

**Which backend to recommend as the primary?**

- **Postgres+IVM**: Best for production (incremental materialization speeds up recomposition, ACID at DB level, existing Postgres deployments). Requires RDF extension availability + Postgres 14+.
- **Oxigraph**: Best for embedded/edge (single Node process, no external deps, SPARQL 1.1 certified). Smaller ecosystem; performance under 1M triples unproven.

**Recommendation**: Support both behind the same `TripleStore` interface. Default to Postgres+IVM for new deployments; Oxigraph for embedded/prototype use.

**Open questions**:
- Which Postgres RDF extension to standardize on? (Consider Liquibase-RDF, Semantic Web extensions, etc.)
- IVM refresh cadence: immediate, batched, or on-demand?
- Fallback strategy if Postgres extension not available?

---

## Section 12: Spec Changes Planned

- **New**: `specs/triplestore-model.md` — RDF data model for OpenSync.
- **New**: `specs/triplestore-connector-sdk.md` — Connector contract for triple production.
- **New**: `specs/triplestore-config.md` — YAML + SPARQL configuration format.
- **New**: `specs/triplestore-pipeline.md` — Ingest, mapping, conflict resolution.
- **New**: `specs/triplestore-rollback.md` — Graph surgery semantics.

---

## Section 13: Next Steps for Iteration

1. **Prototype phase 1**: Stand up Oxigraph, write a trivial connector → triple flow.
2. **Stakeholder feedback**: Show the data model to early users/contributors. Identify pain points.
3. **Benchmark**: Measure SPARQL query performance at scale.
4. **Parallel track**: Keep current OpenSync maintained. Don't break existing pipelines.
5. **Experimental branch**: Work in `/triplestore` folder; don't merge to main until MVP is stable.
6. **Documentation first**: Spec out the YAML format before code; iterate on examples.

---

## Section 14: Success Criteria

A triplestore-based OpenSync is ready when:

- [ ] ≥1 connector can read records and produce triples.
- [ ] Identity resolution works: same-system records can be linked via SPARQL queries.
- [ ] YAML config compiles to SPARQL; no advanced hand-written queries needed for 80% of use cases.
- [ ] Conflict resolution handles ≥3 strategies (field masters, LWW, custom SPARQL).
- [ ] Rollback is implemented and tested: deleted triples restore to prior state.
- [ ] Performance: ingesting 10K records and fanning out takes <5s on commodity hardware.
- [ ] Documentation: connector template, config guide, SPARQL recipe book.
- [ ] Agent-friendly: AI can generate valid SPARQL queries to extract lineage, detect conflicts, etc.

---

## Appendix A: Example: HubSpot → Salesforce Contact Sync

### Initial state (empty)
```sparql
# No triples yet
```

### HubSpot connector reads contacts

```sparql
# After ingest, hubspot graph has:
GRAPH <http://opensync.example.com/graphs/hubspot> {
  <hubspot:contact/hs_123>  rdf:type                hubspot:Contact ;
                            hubspot:firstname       "Alice" ;
                            hubspot:lastname        "Smith" ;
                            hubspot:email           "alice@acme.com" ;
                            hubspot:hs_lead_status  "LEAD" ;
                            hubspot:phone           "+1 555 0100" .
}
```

### Identity resolution

Query: "Does any Salesforce contact have the same email?"

Result: No Salesforce contacts yet. Create a new canonical subject.

```sparql
# Create canonical entry
GRAPH <http://opensync.example.com/graphs/canonical> {
  <canonical:contact/uuid_abc>  rdf:type             canonical:Contact ;
                                canonical:givenName  "Alice" ;
                                canonical:familyName "Smith" ;
                                canonical:email      "alice@acme.com" ;
                                canonical:phone      "+1 555 0100" .
  
  <canonical:contact/uuid_abc>  owl:sameAs           <hubspot:contact/hs_123> .
}
```

### Fan-out to Salesforce

Reverse map canonical → Salesforce field names:

```sparql
GRAPH <http://opensync.example.com/graphs/salesforce_staged> {
  <salesforce:contact/sf_new>  rdf:type       salesforce:Contact ;
                               salesforce:FirstName   "Alice" ;
                               salesforce:LastName    "Smith" ;
                               salesforce:Email       "alice@acme.com" ;
                               salesforce:Phone       "+1 555 0100" .
}
```

Call `salesforce.insert()` with these triples.

### Salesforce connector returns with generated IDs

Salesforce API returns: created contact `sf_555`.

```sparql
# Link new Salesforce ID
GRAPH <http://opensync.example.com/graphs/canonical> {
  <canonical:contact/uuid_abc>  owl:sameAs  <salesforce:contact/sf_555> .
}

# Write to Salesforce graph (what we currently hold)
GRAPH <http://opensync.example.com/graphs/salesforce> {
  <salesforce:contact/sf_555>  rdf:type             salesforce:Contact ;
                               salesforce:FirstName "Alice" ;
                               salesforce:LastName  "Smith" ;
                               salesforce:Email     "alice@acme.com" ;
                               salesforce:Phone     "+1 555 0100" .
}
```

### Later: HubSpot reports a phone change

HubSpot read sees phone is now `"+1 555 0101"`.

Identity resolution confirms: same email → same canonical subject.

Conflict resolution rule: **Salesforce owns phone**. Ignore the change.

```sparql
# hubspot graph updated:
<hubspot:contact/hs_123>  hubspot:phone  "+1 555 0101" .

# canonical graph unchanged (Salesforce wins):
<canonical:contact/uuid_abc>  canonical:phone  "+1 555 0100" .

# Log the conflict:
_:conflict_log  rdf:type               prov:Conflict ;
                prov:subject           <canonical:contact/uuid_abc> ;
                prov:predicate         canonical:phone ;
                prov:incomingValue     "+1 555 0101" ;
                prov:winningValue      "+1 555 0100" ;
                prov:reason            "Field master: salesforce" .
```

---

## Appendix B: Comparative Complexity Analysis

### Field Merge Example (current → proposed)

**Current**: SQL + imperative + config

```yaml
# Config
mappings:
  - name: full_name
    expression: |
      CONCAT(record.first_name, ' ', record.last_name)
    target: name
```

```typescript
// Code
function mergeNames(record: Record): string {
  return `${record.first_name} ${record.last_name}`;
}
```

**Proposed**: One SPARQL query (no code needed)

```sparql
INSERT {
  GRAPH canonical {
    ?contact canonical:fullName ?fullName .
  }
}
WHERE {
  GRAPH canonical {
    ?contact canonical:givenName ?given .
    ?contact canonical:familyName ?family .
    BIND(CONCAT(?given, " ", ?family) AS ?fullName)
  }
}
```

**Assessment**: SPARQL is more declarative but requires learning a new language.

---

## Appendix C: RDF Ontology Sketch for OpenSync

```turtle
@prefix canonical: <http://opensync.example.com/canonical/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

# Core classes
canonical:Contact a rdfs:Class ;
  rdfs:label "A person or entity contact" .

canonical:Company a rdfs:Class ;
  rdfs:label "An organization or company" .

canonical:Sync a rdfs:Class ;
  rdfs:label "A sync run/batch" .

# Properties (predicates)
canonical:givenName a rdf:Property ;
  rdfs:domain canonical:Contact ;
  rdfs:range xsd:string ;
  rdfs:label "First name" .

canonical:familyName a rdf:Property ;
  rdfs:domain canonical:Contact ;
  rdfs:range xsd:string ;
  rdfs:label "Last name" .

canonical:email a rdf:Property ;
  rdfs:domain canonical:Contact ;
  rdfs:range xsd:string ;
  rdfs:label "Email address" .

canonical:phone a rdf:Property ;
  rdfs:domain canonical:Contact ;
  rdfs:range xsd:string ;
  rdfs:label "Phone number" .

canonical:employer a rdf:Property ;
  rdfs:domain canonical:Contact ;
  rdfs:range canonical:Company ;
  rdfs:label "Organization this contact works for" .

# Provenance extensions
prov:addedInBatch a rdf:Property ;
  rdfs:comment "The sync batch that introduced this triple" .

prov:connector a rdf:Property ;
  rdfs:comment "Which connector synced this triple" .

prov:timestamp a rdf:Property ;
  rdfs:range xsd:dateTime ;
  rdfs:comment "When this triple was written" .
```

---

End of plan. Ready for feedback and iteration.
