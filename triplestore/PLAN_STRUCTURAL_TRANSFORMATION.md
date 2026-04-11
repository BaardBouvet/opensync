# Structural Transformation in Triplestore Architecture

**Status:** backlog  
**Date:** 2026-04-11  
**Effort:** L  
**Domain:** Architecture, Configuration  
**Scope:** Nested objects, arrays, denormalization, structural mapping  
**Depends on:** PLAN_TRIPLESTORE_ARCHITECTURE.md  

---

## Executive Summary

The triplestore architecture must handle a fundamental mismatch: **some systems model data as flat objects, others as nested hierarchies, and still others as arrays of items**. RDF has a single canonical representation (triples), but we must map between arbitrary system-specific shapes.

**Challenge examples:**

1. **HubSpot (flat):** `contact.firstname`, `contact.lastname`, `contact.email`
2. **Salesforce (flat with nested field names):** `contact.account__r.account__c`, `contact.account__r.account__name`
3. **Stripe (nested objects):** `customer.shipping: { address_zip, address_city, address_country }`
4. **Shopify (arrays):** `customer.addresses: [{ zip, city, country }, { zip, city, country }]`

Syncing all four requires:
- Denormalizing flat structs into nested form (and vice versa)
- Expanding arrays into multiple facts or recursive structures
- Reconciling object identity when one system has an array and another a singleton
- Querying across these structural differences without data loss

This plan proposes **RDF Reification + Context-Aware Expansion** as the solution.

---

## Section 1: RDF Representation of Nested Data

### § 1.1 Basic Nesting via Blank Nodes

Instead of storing nested data as JSON, we represent it as **related triples** using blank nodes (anonymous resources):

```typescript
// System A (flat):
{
  id: "contact_123",
  firstName: "Alice",
  lastName: "Smith",
  billingAddressZip: "90210",
  billingAddressCity: "Los Angeles",
  shippingAddressZip: "60601",
  shippingAddressCity: "Chicago"
}

// Canonical triples (RDF representation):
GRAPH canonical {
  <canonical:contact/id_123>  rdf:type           canonical:Contact ;
                              canonical:firstName "Alice" ;
                              canonical:lastName "Smith" ;
                              canonical:billingAddress _:addr_1 ;
                              canonical:shippingAddress _:addr_2 .
  
  _:addr_1  rdf:type             canonical:Address ;
            canonical:zipCode    "90210" ;
            canonical:city       "Los Angeles" .
  
  _:addr_2  rdf:type             canonical:Address ;
            canonical:zipCode    "60601" ;
            canonical:city       "Chicago" .
}
```

**Key points:**
- **Blank nodes** (`_:addr_1`, `_:addr_2`) represent anonymous nested objects. They carry no external ID — their identity is structural.
- **Context predicates** (`canonical:billingAddress`, `canonical:shippingAddress`) indicate the role or context of the nested object.
- **Type triples** (`canonical:Address`) let us query "all addresses" without knowing their context.

### § 1.2 Arrays via Ordered Collections or Repeated Predicates

**Option A: RDF Collections (rdf:List)**

```sparql
GRAPH canonical {
  <canonical:customer/cust_456>  canonical:addresses  (
    [ canonical:zip "10001" ; canonical:city "New York" ]
    [ canonical:zip "90210" ; canonical:city "Los Angeles" ]
  ) .
}
```

Collections preserve order but add complexity to queries (must navigate `rdf:first`, `rdf:rest`).

**Option B: Repeated Predicates with Index** (simpler for queries)

```sparql
GRAPH canonical {
  <canonical:customer/cust_456>  canonical:addresses  _:addr_1 ;
                                 canonical:addresses  _:addr_2 ;
                                 canonical:addressCount  2 .
  
  _:addr_1  canonical:index  0 ;
            canonical:zip    "10001" ;
            canonical:city   "New York" .
  
  _:addr_2  canonical:index  1 ;
            canonical:zip    "90210" ;
            canonical:city   "Los Angeles" .
}
```

This representation allows simple SPARQL queries:
```sparql
SELECT ?index ?zip WHERE {
  <canonical:customer/cust_456> canonical:addresses ?addr .
  ?addr canonical:index ?index ;
        canonical:zip ?zip .
}
ORDER BY ?index
```

**Recommendation:** Use Option B (repeated predicates) for simplicity. Order is implicit in load order if immutable.

### § 1.3 Shared Entity References

When a nested object should be a **shared reference** (not a unique nested instance):

```sparql
# Flat system representation:
contact: {
  id: "contact_789",
  name: "Bob",
  accountId: "acct_001"  # Foreign key
}

# Canonical triples:
<canonical:contact/contact_789>  canonical:name     "Bob" ;
                                 canonical:account  <canonical:account/acct_001> .

# This is a direct reference predicate (not a blank node).
# The account is a first-class entity in the canonical graph.
```

**Decision rule:**
- **Blank node** (`_:addr`) if the nested object has no external ID and exists only in context of the parent.
- **Direct reference** (`canonical:account`) if the nested object is a top-level entity synced independently.

---

## Section 2: Decomposition Rules — From Flat to Nested

### § 2.1 Prefix-Based Grouping

**Problem:** HubSpot sends flat fields with semantic prefixes.

```json
{
  "id": "hs_123",
  "firstname": "Alice",
  "lastname": "Smith",
  "hs_lead_status": "LEAD",
  "billing_street": "123 Main St",
  "billing_city": "Los Angeles",
  "billing_zip": "90210",
  "shipping_street": "456 Oak Ave",
  "shipping_city": "Chicago",
  "shipping_zip": "60601"
}
```

**Solution:** Configuration-driven decomposition rules.

```yaml
decomposition:
  - name: billing_address
    group_by_prefix: "billing_"
    canonical_predicate: canonical:billingAddress
    field_mappings:
      - source_field_suffix: street
        canonical_predicate: canonical:street
      - source_field_suffix: city
        canonical_predicate: canonical:city
      - source_field_suffix: zip
        canonical_predicate: canonical:zipCode
  
  - name: shipping_address
    group_by_prefix: "shipping_"
    canonical_predicate: canonical:shippingAddress
    field_mappings:
      - source_field_suffix: street
        canonical_predicate: canonical:street
      - source_field_suffix: city
        canonical_predicate: canonical:city
      - source_field_suffix: zip
        canonical_predicate: canonical:zipCode
```

**Engine behavior:**
1. Recognize all fields with prefix `billing_`.
2. Extract suffix (`street`, `city`, `zip`).
3. Create a blank node `_:billing_addr`.
4. Write triples for each suffix-mapped field.
5. Link parent to blank node via `canonical:billingAddress _:billing_addr`.

### § 2.2 JSON Path Extraction & Deep Nesting

**Problem:** Salesforce sends nested JSON.

```json
{
  "Id": "sf_555",
  "Name": "Alice Smith",
  "Account": {
    "Id": "acct_001",
    "Name": "Acme Inc"
  },
  "MailingAddress": {
    "Street": "123 Main St",
    "City": "Los Angeles",
    "PostalCode": "90210"
  }
}
```

**Solution:** JSON Path mappings in config.

```yaml
fieldMappings:
  - source: Name
    canonical_predicate: canonical:name
  
  - source_json_path: "Account.Id"
    canonical_predicate: canonical:account
    reference: true  # This is a foreign key reference, not a nested object
  
  - source_json_path: "MailingAddress"
    canonical_predicate: canonical:address
    nested_mappings:
      - source_json_path: "Street"
        canonical_predicate: canonical:street
      - source_json_path: "City"
        canonical_predicate: canonical:city
      - source_json_path: "PostalCode"
        canonical_predicate: canonical:zipCode
```

**Engine behavior:**
1. Parse `MailingAddress` as a nested object.
2. Create blank node `_:address`.
3. Extract `Street`, `City`, `PostalCode` via JSON path.
4. Write triples for each via `nested_mappings`.
5. Link parent to blank node.

### § 2.3 Array Expansion

**Problem:** Shopify sends an array of addresses.

```json
{
  "id": "gid://shopify/Customer/123",
  "email": "alice@acme.com",
  "addresses": [
    {
      "id": "gid://shopify/MailingAddress/1",
      "street1": "123 Main St",
      "city": "Los Angeles",
      "zip": "90210"
    },
    {
      "id": "gid://shopify/MailingAddress/2",
      "street1": "456 Oak Ave",
      "city": "Chicago",
      "zip": "60601"
    }
  ]
}
```

**Solution:** Array item expansion rules.

```yaml
fieldMappings:
  - source: email
    canonical_predicate: canonical:email
  
  - source_array_path: addresses
    canonical_predicate: canonical:addresses
    items:
      - source_json_path: street1
        canonical_predicate: canonical:street
      - source_json_path: city
        canonical_predicate: canonical:city
      - source_json_path: zip
        canonical_predicate: canonical:zipCode
      - source_json_path: id
        # If item has an external ID, use it to distinguish addresses across syncs
        external_id_field: true
```

**Engine behavior:**
1. Recognize `addresses` as an array.
2. For each item, create a blank node (or use external ID if present).
3. Apply `items` mappings to each element.
4. Write multiple `canonical:addresses` triples, one per item.
5. Include an index or order predicate for retrieval.

### § 2.4 Recomposition: Canonical → Flat

When writing a flat system back, we must reverse the process.

```sparql
# Query to extract flat fields from nested canonical representation
CONSTRUCT {
  ?contact_flat  hubspot:firstname  ?first ;
                 hubspot:lastname   ?last ;
                 hubspot:billing_street ?b_street ;
                 hubspot:billing_city ?b_city ;
                 hubspot:billing_zip ?b_zip .
}
WHERE {
  GRAPH canonical {
    ?contact  canonical:firstName  ?first ;
              canonical:lastName   ?last ;
              canonical:billingAddress  ?billing_addr .
    
    ?billing_addr  canonical:street     ?b_street ;
                   canonical:city       ?b_city ;
                   canonical:zipCode    ?b_zip .
  }
}
```

**Engine behavior:**
1. Load recomposition rules for the target system (inverse of decomposition).
2. Execute SPARQL CONSTRUCT to flatten nested triples into the target shape.
3. Extract arrays from repeated predicates, reconstructing JSON arrays.
4. Pass result to connector's `insert()` or `update()`.

---

## Section 3: Configuration Format for Structural Mapping

### § 3.1 Enhanced YAML Schema

```yaml
channels:
  - id: hubspot_salesforce_contacts
    members:
      - connectorId: hubspot
        entity: contact
        structuralMappings:
          # Decomposition: HubSpot flat → canonical nested
          hubspot_canonical:
            - name: addresses
              decomposition:
                type: prefix
                prefixes:
                  billing: canonical:billingAddress
                  shipping: canonical:shippingAddress
              fields:
                - suffix: street
                  canonical: canonical:street
                - suffix: city
                  canonical: canonical:city
                - suffix: zip
                  canonical: canonical:zipCode
      
      - connectorId: salesforce
        entity: contact__c
        structuralMappings:
          # Decomposition: Salesforce nested JSON → canonical nested
          salesforce_canonical:
            - name: mailing_address
              decomposition:
                type: json_path
                source_path: MailingAddress
                canonical_predicate: canonical:address
              fields:
                - source: Street
                  canonical: canonical:street
                - source: City
                  canonical: canonical:city
                - source: PostalCode
                  canonical: canonical:zipCode
            
            - name: account_reference
              decomposition:
                type: json_path
                source_path: Account.Id
                canonical_predicate: canonical:account
                reference: true  # external entity reference
      
      - connectorId: shopify
        entity: customer
        structuralMappings:
          # Decomposition: Shopify array → canonical repeated predicates
          shopify_canonical:
            - name: addresses_array
              decomposition:
                type: array
                source_path: addresses
                canonical_predicate: canonical:addresses
              fields:
                - source: street1
                  canonical: canonical:street
                - source: city
                  canonical: canonical:city
                - source: zip
                  canonical: canonical:zipCode
              externalIdField: id  # use item's ID for distinct identity
    
    # Recomposition: canonical → system-specific shape
    recompositions:
      hubspot:
        type: flatten
        rules:
          - canonical_property: canonical:billingAddress
            flatten_prefix: billing_
            fields:
              - canonical: canonical:street
                target_suffix: street
              - canonical: canonical:city
                target_suffix: city
              - canonical: canonical:zipCode
                target_suffix: zip
      
      salesforce:
        type: nest
        rules:
          - canonical_property: canonical:address
            target_json_path: MailingAddress
            fields:
              - canonical: canonical:street
                target: Street
              - canonical: canonical:city
                target: City
              - canonical: canonical:zipCode
                target: PostalCode
      
      shopify:
        type: array
        rules:
          - canonical_property: canonical:addresses
            target_array_path: addresses
            fields:
              - canonical: canonical:street
                target: street1
              - canonical: canonical:city
                target: city
              - canonical: canonical:zipCode
                target: zip
```

### § 3.2 Advanced Scenarios via SPARQL

For complex transformations (e.g., merging multiple source arrays into one, or splitting one array into multiple contexts), use SPARQL directly:

```yaml
channels:
  - id: complex_mapping
    advancedStructuralTransforms:
      - name: normalize_phone_formats
        description: >
          Extract phone numbers from various nested contexts
          (office, mobile, fax) into a single array of typed phones
        query: |
          CONSTRUCT {
            GRAPH canonical {
              ?contact canonical:phones ?phone_record .
              ?phone_record rdf:type canonical:Phone ;
                            canonical:type ?type ;
                            canonical:number ?number .
            }
          }
          WHERE {
            GRAPH canonical {
              ?contact canonical:officePhone ?office .
              ?contact canonical:mobilePhone ?mobile .
              ?contact canonical:faxPhone ?fax .
            }
            BIND(
              CONCAT("phone:", UUID()) AS ?phone_id
            )
            VALUES (?type ?number) {
              ("office" ?office)
              ("mobile" ?mobile)
              ("fax" ?fax)
            }
            FILTER (BOUND(?number))
          }
```

---

## Section 4: Connector SDK for Structural Awareness

Connectors declare their structural shape via enhanced metadata:

```typescript
export const connector: Connector = {
  metadata: {
    name: "hubspot",
    version: "2.0.0",
  },
  
  getEntities(ctx) {
    return [
      {
        name: "contact",
        
        // Schema: flat structure with semantic prefixes
        schema: {
          firstname: { type: "string", description: "First name" },
          lastname: { type: "string", description: "Last name" },
          // ... flat fields
          billing_street: { type: "string" },
          billing_city: { type: "string" },
          billing_zip: { type: "string" },
          shipping_street: { type: "string" },
          // ... etc
        },
        
        // NEW: Structural hints for the engine
        structureHints: {
          addressPrefixes: [
            { prefix: "billing_", fieldsSuffixes: ["street", "city", "zip"] },
            { prefix: "shipping_", fieldsSuffixes: ["street", "city", "zip"] },
          ],
          // Tells the engine: "I have flat fields with these prefixes that represent addresses"
        },
      },
    ];
  },
};
```

For complex systems like Salesforce:

```typescript
getEntities(ctx) {
  return [
    {
      name: "contact__c",
      
      schema: {
        Name: { type: "string" },
        // Nested object represented as JSON path in schema
        Account: {
          type: "object",
          properties: {
            Id: { type: "string", entity: "account__c" },  // FK reference
            Name: { type: "string" },
          },
        },
        MailingAddress: {
          type: "object",
          properties: {
            Street: { type: "string" },
            City: { type: "string" },
            PostalCode: { type: "string" },
          },
        },
      },
      
      structureHints: {
        nestedObjects: ["Account", "MailingAddress"],
        references: ["Account"],  // FK pointing to another entity
      },
    },
  ];
}
```

---

## Section 5: Conflict Resolution Across Structures

**Challenge:** HubSpot sends `billing_zip: "90210"`. Salesforce sends `MailingAddress.PostalCode: "90210"`. They're the same but structurally different. Do we treat them as conflicts?

**Answer:** **No.** Recomposition normalizes both to canonical triples before comparison.

```sparql
# Both sources decomposed to same canonical structure:
GRAPH canonical {
  <canonical:contact/id_001>  canonical:billingAddress  _:addr .
  _:addr  canonical:zipCode  "90210" .
}

# When comparing: same subject, same predicate, same object → no conflict
```

**However,** if one system sends multiple addresses and another sends a singleton:

```sparql
# Shopify:
<canonical:customer/id>  canonical:addresses  _:addr_1 ;
                        canonical:addresses  _:addr_2 .

# Stripe:
<canonical:customer/id>  canonical:address   _:addr_3 .
```

**Resolution strategy:** Conflict resolution rule decides:
- Is "primary address" (Stripe's singleton) the first address in Shopify's array?
- Or do we record both as equivalent but note that the second Shopify address is external?

```yaml
conflictResolution:
  singletonVsArray:
    strategy: merge_singleton_into_array
    treatSingletonAs: primary  # Mark Stripe's address as canonical:primary true
```

---

## Section 6: Querying Across Structural Boundaries

One design goal: **users can query canonical facts without knowing the underlying structure.**

```sparql
# User query: "Find all ZIP codes for all contacts"
SELECT ?contact ?zip WHERE {
  GRAPH canonical {
    ?contact rdf:type canonical:Contact ;
             semantic:address ?addr .  # could be blank node or reference
    ?addr canonical:zipCode ?zip .
  }
}

# This single query works for:
# - Contacts with nested Address objects
# - Contacts with arrays of addresses
# - Contacts with singleton addresses
# The structure is transparent to the query.
```

**Important:** Use SPARQL property paths to abstract structure:

```sparql
# Predicate: "get me to an address" (handles nesting)
semantic:address rdfs:subPropertyOf canonical:billingAddress,
                                      canonical:shippingAddress,
                                      canonical:addresses,
                                      canonical:address .

# Now: ?contact semantic:address ?addr matches all patterns
```

---

## Section 7: Implementation Strategy

### § 7.1 Decomposition Engine (Read Path)

```
connector.read()
  ↓ (produces flat or nested JSON records)
[Structural Analyzer]
  - Inspect record against connector's schema + structureHints
  - Identify arrays, nested objects, typed fields
  ↓
[Decomposition Mapper]
  - Apply decomposition rules (prefix-grouping, JSON-path extraction)
  - Generate blank nodes for nested structures
  - Generate triples for each extracted field
  ↓
[Named Graph Population]
  - Write all decomposed triples to connector's named graph
  ↓
[Identity Resolution]
  - Match canonical subjects using fields from nested structures
  ↓
[Canonical Graph Merge]
  - Promote to canonical (apply conflict resolution across structures)
```

### § 7.2 Recomposition Engine (Write Path)

```
Resolved canonical facts
  ↓
[Recomposition Mapper]
  - Load recomposition rules for target system
  - Query canonical graph to extract nested structures
  - Reconstruct nested JSON / flatten arrays as needed
  ↓
[Record Reconstruction]
  - Assemble final JSON/flat record to send to connector
  ↓
connector.insert() / connector.update()
```

### § 7.3 Materialized Views (Optimization)

For frequently accessed structures, pre-compute materialized views:

```sparql
# Create a view: "contacts with all contact info flattened"
CREATE VIEW hubspot_flat AS
CONSTRUCT {
  ?contact  hubspot:firstname ?first ;
            hubspot:lastname ?last ;
            hubspot:billing_street ?b_street ;
            hubspot:billing_city ?b_city ;
            hubspot:billing_zip ?b_zip .
}
WHERE {
  # [decomposition query]
}
```

---

## Section 7.4 Recomposition Query Patterns: Reconstructing Full Subjects

**Problem:** When recomposing a contact back to HubSpot, we need to fetch **all triples related to that contact** — both direct triples AND all triples on nested blank nodes. The plan mentions this but doesn't specify the SPARQL patterns.

### § 7.4.1 Pattern 1: Fetch Subject + Direct Predicates

```sparql
# Fetch all direct triples for a contact
SELECT ?predicate ?object WHERE {
  GRAPH canonical {
    <canonical:contact/id_123> ?predicate ?object .
  }
}
```

Result:
```
canonical:firstName → "Alice"
canonical:lastName → "Smith"
canonical:billingAddress → _:addr_1
canonical:shippingAddress → _:addr_2
```

### § 7.4.2 Pattern 2: Recursive Blank Node Traversal

But we also need all triples on `_:addr_1` and `_:addr_2`. This requires **recursive traversal**:

```sparql
# Fetch all triples reachable from a subject, including nested blank nodes
# Step 1: Collect all blank nodes transitively reachable from root subject
SELECT ?s ?predicate ?object WHERE {
  GRAPH canonical {
    # Start from root subject
    <canonical:contact/id_123> ?p1 ?s .
    
    # Recursively follow to blank nodes
    FILTER (ISBLANK(?s))
    
    # Now get all triples with this blank node as subject
    ?s ?predicate ?object .
  }
}
```

**Problem with this query:** It doesn't handle **multiple levels of nesting** or **arrays with multiple items**. 

**Better approach:** Use SPARQL 1.1 property paths or OPTIONAL:

```sparql
# Fetch all triples for a contact and all its nested blank nodes
# This works for arbitrary nesting depth
CONSTRUCT {
  <canonical:contact/id_123> ?p1 ?o1 .
  ?bn ?p2 ?o2 .
}
WHERE {
  GRAPH canonical {
    # Get direct triples
    <canonical:contact/id_123> ?p1 ?o1 .
    
    # For each object that is a blank node, get its triples
    {
      <canonical:contact/id_123> ?p1_x ?bn .
      FILTER (ISBLANK(?bn))
      ?bn ?p2 ?o2 .
    }
    UNION
    # Deeper nesting: blank nodes that are objects of blank nodes
    {
      <canonical:contact/id_123> ?p1_x ?bn1 .
      FILTER (ISBLANK(?bn1))
      ?bn1 ?p2_x ?bn2 .
      FILTER (ISBLANK(?bn2))
      ?bn2 ?p2 ?o2 .
    }
  }
}
```

**This still doesn't scale for arbitrary depth.** Better solution:

### § 7.4.3 Pattern 3: SPARQL 1.1 Property Paths (Recursive Closure)

Use `*` (zero or more) to follow chains transitively:

```sparql
# Fetch all facts reachable from a root subject via any path
CONSTRUCT {
  ?s ?p ?o .
}
WHERE {
  GRAPH canonical {
    # Root subject or any subject reachable via blank nodes
    {
      BIND(<canonical:contact/id_123> AS ?s)
    }
    UNION
    {
      <canonical:contact/id_123> (^[^a]*/[^a]*)* ?s .
      FILTER (ISBLANK(?s))
    }
    
    # Get all triples from that subject
    ?s ?p ?o .
  }
}
```

**This still has issues with XSD regex.** Cleaner approach:

### § 7.4.4 Pattern 4: Engine-Side Graph Traversal (Recommended)

Rather than complex SPARQL, the **recomposition engine does graph traversal in code**:

```typescript
async function fetchSubjectGraph(tripleStore: TripleStore, subjectIri: string): Promise<Triple[]> {
  const triples: Triple[] = [];
  const visited = new Set<string>();
  const queue = [subjectIri];
  
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    
    // Fetch all triples with this subject
    const directTriples = await tripleStore.query(`
      SELECT ?p ?o WHERE {
        <${current}> ?p ?o .
      }
    `);
    
    triples.push(...directTriples);
    
    // For each object that is a blank node, add to queue
    for (const t of directTriples) {
      if (isBlankNode(t.object)) {
        queue.push(t.object);
      }
    }
  }
  
  return triples;
}
```

**Advantages:**
- Clear logic, easy to debug
- Handles arbitrary nesting depth
- Can apply filtering/sorting in code
- Works with any triplestore that supports SPARQL SELECT

### § 7.4.5 Pattern 5: Grouped Reconstruction from Fetched Triples

Once we have all triples, we must **group them by context** for reconstruction:

```typescript
// Step 1: Fetch complete graph
const allTriples = await fetchSubjectGraph(tripleStore, contactIri);

// Step 2: Group by nested context
const result = {
  id: extractValue(allTriples, contactIri, "schema:id"),
  firstname: extractValue(allTriples, contactIri, "canonical:firstName"),
  lastname: extractValue(allTriples, contactIri, "canonical:lastName"),
  
  // Group triples for billing address
  billing_street: extractValue(
    allTriples, 
    getBillingAddressBlankNode(allTriples, contactIri), 
    "canonical:street"
  ),
  billing_city: extractValue(
    allTriples,
    getBillingAddressBlankNode(allTriples, contactIri),
    "canonical:city"
  ),
  // ... etc
};

function extractValue(
  triples: Triple[], 
  subject: string, 
  predicate: string
): string | undefined {
  const triple = triples.find(
    t => t.subject === subject && t.predicate === predicate
  );
  return triple?.object as string;
}

function getBillingAddressBlankNode(triples: Triple[], contactIri: string): string {
  // Find the blank node linked via canonical:billingAddress
  const triple = triples.find(
    t => t.subject === contactIri && 
         t.predicate === "canonical:billingAddress" &&
         isBlankNode(t.object)
  );
  return triple?.object as string;
}
```

### § 7.4.6 Pattern 6: Context-Free Reconstruction via SPARQL

Alternatively, use a **CONSTRUCT query tailored per recomposition rule**:

```sparql
# For HubSpot: flatten all nested addresses into prefix-style fields
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
    # Root
    ?contact_in rdf:type canonical:Contact ;
                canonical:firstName ?first ;
                canonical:lastName ?last .
    
    # Billing address (optional nested object)
    OPTIONAL {
      ?contact_in canonical:billingAddress ?billing_addr .
      OPTIONAL { ?billing_addr canonical:street ?b_street . }
      OPTIONAL { ?billing_addr canonical:city ?b_city . }
      OPTIONAL { ?billing_addr canonical:zipCode ?b_zip . }
    }
    
    # Shipping address (optional nested object)
    OPTIONAL {
      ?contact_in canonical:shippingAddress ?shipping_addr .
      OPTIONAL { ?shipping_addr canonical:street ?s_street . }
      OPTIONAL { ?shipping_addr canonical:city ?s_city . }
      OPTIONAL { ?shipping_addr canonical:zipCode ?s_zip . }
    }
  }
  
  # Generate output subject for HubSpot
  BIND(URI(CONCAT("hubspot:contact/", MD5(?contact_in))) AS ?contact_out)
}
```

**Result:** A single HubSpot contact record (flat) with all fields populated from canonical nested structure.

### § 7.4.7 Pattern 7: Arrays → Repeated Subjects

For Shopify arrays, we need to reconstruct multiple items:

```sparql
# Reconstruct array of addresses
CONSTRUCT {
  ?contact_out shopify:addresses_item ?item_out .
  ?item_out shopify:street1 ?street ;
            shopify:city ?city ;
            shopify:zip ?zip ;
            shopify:address_type ?type .
}
WHERE {
  GRAPH canonical {
    ?contact_in rdf:type canonical:Contact ;
                canonical:addresses ?addr .
    
    # Optional: infer type from context (billing vs shipping)
    OPTIONAL {
      ?contact_in canonical:billingAddress ?addr .
      BIND("billing" AS ?type)
    }
    OPTIONAL {
      ?contact_in canonical:shippingAddress ?addr .
      BIND("shipping" AS ?type)
    }
    
    ?addr canonical:street ?street ;
          canonical:city ?city ;
          canonical:zipCode ?zip .
  }
  
  # Generate stable IRI for each array item
  BIND(URI(CONCAT("shopify:address/", MD5(CONCAT(?street, ?city, ?zip)))) AS ?item_out)
}
```

**Result:** Multiple `shopify:addresses_item` objects, each flattened.

### § 7.4.8 Decision: Which Pattern to Use?

| Pattern | Use When | Pros | Cons |
|---------|----------|------|------|
| **1: Direct SELECT** | Simple flat mapping | Fast, simple | Doesn't handle nesting |
| **2–3: SPARQL recursion** | Academic / showing off | Pure SPARQL | Complex, hard to debug |
| **4: Engine traversal** | Production code | Clear, debuggable | Requires application logic |
| **6: Context-specific CONSTRUCT** | Mapping known structures | Fast, type-safe | Must write per-system query |
| **7: Array generation** | Multi-item reconstruction | Handles batching | Requires stable item identity |

**Recommendation for MVP:** 
- Keep recomposition rules **declarative in YAML** (which rules apply)
- Store **per-system CONSTRUCT queries** (the actual SPARQL template)
- Let the engine **template-substitute the root subject** and execute
- Fall back to **Pattern 4 (engine traversal)** only for custom SPARQL

### § 7.4.9 Advanced: IVM Materialization (Postgres Backend)

If using **Postgres + RDF extension + Incremental View Maintenance** (see PLAN_TRIPLESTORE_ARCHITECTURE § 6.3), recomposition queries can be **pre-materialized** as views, avoiding the traversal overhead altogether.

**How it works:**

1. **Define recomposition as a materialized view:**
   ```sql
   CREATE MATERIALIZED VIEW hubspot_contact_export AS
   CONSTRUCT { ... } WHERE { ... };
   ALTER MATERIALIZED VIEW hubspot_contact_export SET INCREMENTAL;
   ```

2. **IVM maintains the view automatically:**
   - When canonical graph changes, IVM calculates only the **delta** (affected rows)
   - View is updated **incrementally**, not recomputed from scratch

3. **Recomposition is O(1) lookup:**
   ```typescript
   const flatContacts = await store.getMaterializdView('hubspot_contact_export');
   // Instant access to pre-flattened contacts; no traversal
   ```

**Performance comparison:**
- **Without IVM** (Patterns 4–7): O(N) per contact (traverse blank nodes, JOINs)
- **With IVM** (materialized view): O(1) per contact + incremental maintenance cost

For production deployments with Postgres, IVM materialization is **strongly recommended** over on-demand queries for frequently-recomposed systems.

---

## Section 8: Examples

### § 8.1 HubSpot (Flat) ↔ Salesforce (Nested) ↔ Shopify (Array)

**Initial state:**

```
HubSpot: {
  id: "hs_123",
  firstname: "Alice",
  lastname: "Smith",
  billing_street: "123 Main",
  billing_city: "LA",
  billing_zip: "90210",
  shipping_street: "456 Oak",
  shipping_city: "Chicago",
  shipping_zip: "60601"
}

Salesforce: {} (empty)

Shopify: {} (empty)
```

**After first read (HubSpot → canonical):**

```sparql
GRAPH canonical {
  <canonical:contact/uuid_abc>  rdf:type             canonical:Contact ;
                                canonical:firstName  "Alice" ;
                                canonical:lastName   "Smith" ;
                                canonical:billingAddress  _:billing ;
                                canonical:shippingAddress _:shipping .
  
  _:billing  canonical:street    "123 Main" ;
             canonical:city      "LA" ;
             canonical:zipCode   "90210" .
  
  _:shipping  canonical:street   "456 Oak" ;
              canonical:city     "Chicago" ;
              canonical:zipCode  "60601" .
}
```

**Recompose to Salesforce (canonical → nested):**

```json
{
  "Name": "Alice Smith",
  "MailingAddress": {
    "Street": "123 Main",
    "City": "LA",
    "PostalCode": "90210"
  },
  "ShippingAddress": {
    "Street": "456 Oak",
    "City": "Chicago",
    "PostalCode": "60601"
  }
}
```

Salesforce inserts contact `sf_555`.

**Recompose to Shopify (canonical → array):**

```json
{
  "email": "alice@example.com",
  "addresses": [
    {
      "street1": "123 Main",
      "city": "LA",
      "zip": "90210",
      "address_type": "billing"
    },
    {
      "street1": "456 Oak",
      "city": "Chicago",
      "zip": "60601",
      "address_type": "shipping"
    }
  ]
}
```

Shopify inserts customer `gid://shopify/Customer/789`.

**Later: Salesforce updates address city to "Los Angeles"**

```
Salesforce.update(sf_555, { MailingAddress: { City: "Los Angeles" } })
```

Decomposition extracts and updates canonical:

```sparql
# Update canonical billing address
DELETE {
  GRAPH canonical {
    _:billing canonical:city "LA" .
  }
}
INSERT {
  GRAPH canonical {
    _:billing canonical:city "Los Angeles" .
  }
}
WHERE {
  # [context query identifying _:billing]
}
```

**Recompose back to HubSpot (canonical → flat):**

```json
{
  "billing_city": "Los Angeles"
}
```

HubSpot updates contact `hs_123`.

**Recompose back to Shopify (canonical → array):**

```json
{
  "addresses": [
    {
      "street1": "123 Main",
      "city": "Los Angeles",  // ← updated
      "zip": "90210",
      "address_type": "billing"
    },
    { ... }
  ]
}
```

---

## Section 9: Type Checking and Validation

The decomposition/recomposition engine must validate type compatibility:

```sparql
# Check: is ?value compatible with canonical:zipCode (expects xsd:string)?
SELECT ?error WHERE {
  ?contact canonical:billingAddress ?addr .
  ?addr canonical:zipCode ?zip .
  
  FILTER (NOT (isLiteral(?zip) && datatype(?zip) = xsd:string))
  
  BIND(CONCAT("ZIP code not a string: ", STR(?zip)) AS ?error)
}
```

Validation happens:
1. **At decomposition time:** Reject incompatible types early.
2. **At recomposition time:** Cast or coerce values to target system's expectations.

---

## Section 10: Performance Considerations

### § 10.1 Blank Node Identity Stability

**Problem:** Blank nodes without external IDs are not stable across syncs. If HubSpot sends `{ address: "123 Main St", city: "LA" }`, we create `_:addr_1`. On the next sync, the same address should map to `_:addr_1`, not create `_:addr_2`.

**Solution:** Deterministic blank node naming.

```sparql
# Instead of random blank nodes, use content hashing
BIND(
  CONCAT("_:addr_", SHA256(CONCAT(?street, ?city, ?zip))) AS ?stable_id
)
```

This ensures idempotent decomposition.

### § 10.2 Index Materialization

For arrays with many items, materializing an index is expensive:

```yaml
optimization:
  arrayIndexing:
    strategy: lazy  # compute indices only when queried
    # OR
    strategy: eager  # pre-compute all indices on write (slower write, faster read)
```

---

## Section 11: Edge Cases & Decisions

### § 11.1 Recursive Nesting Depth

What if a system has `data.nested.deeply.in.structures`? How deep can decomposition go?

**Decision:** Support arbitrary depth. SPARQL queries naturally handle it:

```sparql
?s canonical:parent ?parent .
?parent canonical:child ?child .
?child canonical:grandchild ?grandchild .
```

### § 11.2 Null / Missing Values

HubSpot omits `billing_street` if it's null. Salesforce explicitly sends `null`. Shopify sends `""` (empty string).

**Canonical representation:** Only write non-`null`, non-empty values to the graph. Absence means unknown/not set.

```sparql
# Omit nulls
FILTER (BOUND(?value) && ?value != "" && ?value != null)
```

### § 11.3 Ordering in Arrays

One system preserves address order (first = primary). Another treats them as an unordered set.

**Solution:** Always include an explicit `:index` or `:order` predicate. When recomposing to a system that doesn't care, drop it.

### § 11.4 Synthetic Field Generation

Sometimes a connector needs a computed field that doesn't exist in sources (e.g., `fullAddress` = concatenation of street, city, zip).

**Solution:** Use derivation SPARQL queries (already in main plan).

```sparql
INSERT {
  GRAPH canonical {
    ?addr canonical:fullAddress ?fullAddr .
  }
}
WHERE {
  GRAPH canonical {
    ?addr canonical:street ?street ;
          canonical:city ?city ;
          canonical:zipCode ?zip .
    BIND(CONCAT(?street, ", ", ?city, " ", ?zip) AS ?fullAddr)
  }
}
```

---

## Section 12: Spec Changes Planned

These new specs would supersede/extend the main triplestore plan:

- **New**: `specs/triplestore-structural-mapping.md` — Decomposition/recomposition semantics, blank node identity, array handling, **SPARQL query patterns for reconstructing full subjects** (§7.4), **IVM materialization for production Postgres deployments** (§7.4.9).
- **Updated**: `specs/triplestore-config.md` — Extend with `decomposition`, `recomposition`, `structuralMappings` config sections, materialize view strategy selection.
- **New**: `specs/triplestore-sdk-structural-hints.md` — Connector metadata for declaring structure (address prefixes, JSON paths, arrays).
- **Update**: `specs/triplestore-pipeline.md` — Add structural transformation stages to ingest/dispatch pipeline.

---

## Section 13: Testing Strategy

### § 13.1 Decomposition Round-Trip

```typescript
// Test: flat → nested → flat
const flatInput = {
  billing_street: "123 Main",
  billing_city: "LA",
  billing_zip: "90210",
};

const canonical = decompose(flatInput, hubspotRules);
const flatOutput = recompose(canonical, hubspotRules);

expect(flatOutput).toEqual(flatInput);
```

### § 13.2 Cross-System Structural Compatibility

```typescript
// Test: HubSpot (flat) → Salesforce (nested)
const hubspotRecord = { /* ... */ };
const canonical = decompose(hubspotRecord, hubspotRules);
const salesforceRecord = recompose(canonical, salesforceRules);

expect(salesforceRecord.MailingAddress).toBeDefined();
expect(salesforceRecord.MailingAddress.Street).toBe(hubspotRecord.billing_street);
```

### § 13.3 Array Handling

```typescript
// Test: Shopify (array with 2 items) synced everywhere
const shopifyRecord = {
  addresses: [
    { street1: "123 Main", city: "LA" },
    { street1: "456 Oak", city: "Chicago" },
  ],
};

const canonical = decompose(shopifyRecord, shopifyRules);

// Count addresses in canonical representation
const addrCount = countTriples(
  canonical,
  (t) => t.predicate === "canonical:addresses"
);

expect(addrCount).toBe(2);

// Recompose back to Shopify
const shopifyOutput = recompose(canonical, shopifyRules);
expect(shopifyOutput.addresses.length).toBe(2);
```

---

## Section 14: Success Criteria

A robust structural mapping implementation is ready when:

- [ ] Decompose flat → nested and nested → flat without data loss.
- [ ] Arrays with 0–N items round-trip correctly.
- [ ] Blank node identity is stable (same content = same blank node ID).
- [ ] SPARQL queries work transparently across structural boundaries.
- [ ] Recomposition respects per-system target shapes.
- [ ] Conflict resolution applies correctly despite structural differences.
- [ ] Performance: decompose/recompose a 10K-record batch in <5s.
- [ ] Documentation: examples for common patterns (flat↔nested, array handling, FK refs).
- [ ] SDK helpers: `@opensync/sdk/structural-hints` for connector authors.

---

## Appendix: Configuration Examples Repository

Example configs for common scenarios:

1. **HubSpot-style flat → canonical nested**
2. **Salesforce-style nested JSON → canonical nested**
3. **Shopify-style arrays → canonical repeated predicates**
4. **Postgres JSON columns → canonical nested**
5. **Custom SPARQL for domain-specific transforms**

Each example includes:
- Source connector schema
- Decomposition rules
- Recomposition rules
- Test cases (round-trip validation)

---

End of plan. Ready for feedback and integration into main triplestore architecture.
