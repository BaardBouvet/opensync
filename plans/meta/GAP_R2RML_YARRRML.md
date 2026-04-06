# GAP: OpenSync vs R2RML / YARRRML / RML

**Status:** reference  
**Date:** 2026-04-06  

---

## 1. What This Is

R2RML (W3C Recommendation, 2012), RML (extension of R2RML to non-relational sources),
and YARRRML (a YAML-serialised human-friendly skin over RML rules) are the main prior art
for declarative data-to-graph mapping. This document compares their design concepts with
OpenSync's, identifies where the problem spaces overlap and diverge, and records which
R2RML concepts are either already present in OpenSync, partially covered, or clearly
out-of-scope.

---

## 2. Problem Space Comparison

| Dimension | R2RML / RML / YARRRML | OpenSync |
|-----------|----------------------|----------|
| **Core job** | Lift relational or semi-structured data into RDF triples (one-way) | Bi-directional synchronisation between API-facing SaaS systems (live, incremental, reversible) |
| **Direction** | One-way: source DB → RDF graph | Both ways simultaneously: connector A ↔ shadow state ↔ connector B |
| **Data model** | RDF triples `(subject, predicate, object)` | Structured records `(id, data, associations)` |
| **Sources** | Databases, CSV, JSON, SPARQL endpoints | Any API-accessible SaaS service; connectors define the protocol |
| **Targets** | RDF triplestore or file dump | Another SaaS system's write API |
| **Conflict resolution** | Absent — single authoritative source | First-class: LWW timestamp, coalesce, custom expression |
| **Rollback** | Absent | First-class via transaction log |
| **Identity resolution** | IRI templates (`{column}`) construct stable IRIs; assume one DB namespace | Cross-system entity matching via `identityFields`; identity map tracks external ID → canonical UUID |
| **Incremental sync** | Absent — full re-materialisation or virtualisation on query | First-class polling + watermark + webhook; deferred associations for out-of-order arrival |
| **Value transforms** | R2RML: SQL view or `rr:template`; RML: FnO function; YARRRML: inline `function:` | Field `expression` / `reverseExpression` (arbitrary JS); a forward expression and a reverse expression can differ |
| **Writeback** | Not in scope — RDF output only | Mandatory for both directions |

**Summary verdict:** The problems overlap on the *lifting* (reading from source + transforming)
side. They diverge completely on writeback, conflict handling, incremental sync, and rollback.
R2RML is essentially the read half of the field mapping pipeline, applied to relational data
with an RDF output model rather than a canonical JSON record.

---

## 3. Concept Mapping

### 3.1 Triples Map ↔ Channel × Entity Mapping

| R2RML concept | OpenSync equivalent | Notes |
|--------------|---------------------|-------|
| `rr:TriplesMap` | One row in `mappings/*.yaml` (connector + channel + entity triple) | R2RML has one triples map per output class; OpenSync has one mapping entry per connector × channel × entity |
| `rr:logicalTable` / `rr:sqlQuery` | Connector `read()` method; the iterator is the async generator | OpenSync does not expose a query interface — connectors pull from APIs using their own protocol |
| `rr:subjectMap` with IRI template | Identity resolution: `identityFields` + `identity_map` | OpenSync generates an opaque canonical UUID, not a user-chosen IRI template. URI subjects are not a first-class config knob |

### 3.2 Predicate–Object Maps ↔ Field Mappings

| R2RML concept | OpenSync equivalent | Notes |
|--------------|---------------------|-------|
| `rr:predicateObjectMap` | One `source` / `target` field entry in `fields:` array | Multiple per mapping, same cardinality |
| `rr:column` | `source: fieldName` (identity mapping of one column) | Direct equivalence |
| `rr:template` | `expression: "${source.field1}-${source.field2}"` | OpenSync expressions can reference any field on the incoming record; templates in R2RML reference column names only |
| `rr:constant` | `default: "fixed value"` or hardcoded `expression` | R2RML constant term maps produce the same IRI/literal regardless of row; OpenSync `default` applies only when source field is absent/null |
| `rr:class` | No direct equivalent; `rdf:type` triples are an RDF concern | OpenSync records carry no class assertion |
| `rr:datatype` | `type` in `FieldDescriptor` (SDK schema hint, not transform) | R2RML produces typed XSD literals; OpenSync operates on JSON scalars (types are implicit) |
| `rr:language` | Not present | RDF language-tagged literals have no OpenSync equivalent |

### 3.3 Referencing Object Maps ↔ Associations

| R2RML concept | OpenSync equivalent | Notes |
|--------------|---------------------|-------|
| `rr:parentTriplesMap` + `rr:joinCondition` | `Association` + identity map cross-lookup | In R2RML a join is declared statically with column names; in OpenSync a connector emits `Association` objects and the engine resolves them dynamically against the identity map at dispatch time |
| `rr:child` / `rr:parent` (join columns) | `Association.predicate` (field carrying the FK value) | R2RML join is a SQL-level join; OpenSync join is an identity-map lookup keyed on `(connectorId, externalId)` |
| IRI generated from parent subject map | `targetId` remapped to target connector's local ID | R2RML generates an IRI that is globally unique by construction (namespace + column value); OpenSync has no global namespace — the engine translates local IDs across connector namespaces |

### 3.4 Transform Expressiveness

This is the most important gap between the two worlds.

**R2RML** offers three term flavours and defers all non-trivial transforms to SQL views:
- `rr:column` — direct column reference (identity)
- `rr:template` — string interpolation of one or more columns → IRI or literal
- `rr:constant` — fixed value
- Anything beyond these: write a `rr:sqlQuery` R2RML view with a `CASE`/`COUNT`/UDF in SQL

**RML** adds FnO (Function Ontology): functions are defined as RDF resources referencing
external implementations (`grel:toUpperCase`, `idlab:trueCondition`, etc.). YARRRML
surfaces this as inline `function:` blocks with named parameters. This allows arbitrary
programmatic transforms expressed declaratively.

**OpenSync** uses a single string expression evaluated as a JS template literal (or
planned: a mini-expression language). Key differences:

| Feature | R2RML | RML + FnO | YARRRML | OpenSync |
|---------|-------|-----------|---------|----------|
| Identity copy | ✓ `rr:column` | ✓ | ✓ | ✓ `source: x, target: y` |
| String template | ✓ `rr:template` | ✓ | ✓ `$(x)` | ✓ `expression` |
| Arithmetic / aggregate | ✗ (SQL view workaround) | ✓ via FnO | ✓ via FnO | ✓ full JS expression |
| Conditional values | ✗ (SQL `CASE`) | ✓ `idlab:if` | ✓ condition block | ✓ `expression: src.x ? src.x : src.y` |
| Multi-step composition | ✗ | ✓ nested functions | ✓ nested functions | ✓ (single expression, arbitrary) |
| Reverse transform | ✗ (one-way) | ✗ | ✗ | ✓ `reverseExpression` |
| Access to whole record | ✗ (columns of current row; limited SQL joins) | ✗ (parameters from same record row only) | ✗ | ✓ `expression` receives full source record |
| Output type coercion | ✓ `rr:datatype`, `rr:language` | ✓ | ✓ | ✗ (implicit JSON scalar types; no casting language) |
| Named/reusable functions | ✗ | ✓ FnO function definitions | ✓ | ✗ (each expression is inline; no shared library yet) |

**OpenSync's practical advantage:** A single `expression` can do anything JavaScript can
do: date arithmetic, currency scaling, enum translation, conditional concatenation. R2RML
requires embedding SQL `CASE` statements in view queries; YARRRML requires composing
named FnO functions which must be resolvable at execution time.

**OpenSync's gap:** No named/reusable function definitions. If ten mappings all convert
timestamps from ISO 8601 to Unix ms, each repeats the same expression inline. YARRRML
allows defining `ex:toUnix` once and referencing it everywhere.

### 3.5 Direction

R2RML and YARRRML are strictly one-directional (lift to RDF). The concept of a
*reverse expression* or a writeback pass does not exist in their design.

OpenSync's `direction: bidirectional | forward_only | reverse_only` and paired
`expression` / `reverseExpression` have no analogue in the RDF mapping stack. This is
the sharpest architectural difference: OpenSync's mapping is a *protocol*, not a
*projection*.

### 3.6 Identity Resolution

| Dimension | R2RML | OpenSync |
|-----------|-------|----------|
| IRI construction | Explicit template: `http://data.example.com/employee/{EMPNO}` — IRI is chosen by the mapping author, stable by convention | Opaque canonical UUID generated internally; external IDs are connector-local |
| Cross-source joining | FK join via `rr:joinCondition` (static column names) | Dynamic identity-map lookup at dispatch; entities matched by shared field values (`identityFields`) |
| Global uniqueness | Built in: namespace prefix + PK value → globally unique IRI | Not built in: OpenSync canonical IDs are internal UUIDs; semantic stability requires `semanticType` URI (planned, `PLAN_NON_LOCAL_ASSOCIATIONS.md`) |
| Record arrival order | Not applicable — full DB scan | First-class: deferred associations, retry on next cycle |

### 3.7 Conflict Resolution and Writeback

R2RML has no equivalent for:
- Last-Write-Wins timestamp resolution
- `coalesce` (priority-ranked first-non-null)
- Custom resolution expressions
- Circuit breakers, rollback, transaction log
- Echo detection (suppress re-propagating a change that came from the target itself)

These are the operational sync concerns that R2RML treats as entirely out-of-scope.

### 3.8 Serialisation Syntax

YARRRML is a YAML-over-RML shorthand. OpenSync's mapping config is also YAML. A surface
comparison:

```yaml
# YARRRML: map firstName column to foaf:firstName predicate
mappings:
  person:
    sources: [data/people.json~jsonpath, $]
    subjects: http://example.org/person/$(id)
    predicateobjects:
      - [foaf:firstName, $(firstName)]
      - [foaf:knows, $(colleagueId)~iri]
```

```yaml
# OpenSync: map firstName field, sync with HubSpot contact entity
mappings:
  - connector: hubspot
    channel: contacts
    entity: contacts
    fields:
      - source: firstName
        target: firstName
      - source: colleagueId
        target: colleagueId   # FK — engine resolves via associations, not listed here
```

Key syntactic differences:
- YARRRML subjects require an IRI template (global identifier design); OpenSync has no
  subject IRI concept — the key is the connector's `id` field.
- YARRRML `predicateobjects` list predicate as an IRI; OpenSync `fields` list the
  connector-local field name and its canonical alias.
- YARRRML FKs are expressed as `~iri` objects referring to another mapping; OpenSync FKs
  are `associations` returned by the connector and do not appear in `fields` at all.

---

## 4. What OpenSync Could Learn from R2RML / YARRRML

### 4.1 Named/reusable transform functions

YARRRML's FnO function references allow a shared function library (`ex:toUpperCase`,
`ex:parseDate`, etc.) referenced by URI from any mapping. OpenSync currently requires
inline expression repetition. A lightweight function registry (defined in config or
in a `functions.ts` file per mapping set) would eliminate duplication.

### 4.2 Explicit datatype coercion

R2RML's `rr:datatype` allows the mapping author to assert the XSD type of a generated
literal. OpenSync passes JSON scalars through without a type annotation layer. For the
field-mapping spec (`specs/field-mapping.md`), a `type` hint in the field entry (beyond
the schema `FieldDescriptor`) would enable validated coercions (e.g., always produce an
ISO 8601 string from whatever the source sends).

### 4.3 Iterable / multi-valued property handling

R2RML many-to-many tables (§2.6) and RML's multi-valued reference formulations map
naturally to OpenSync's planned `array_path` nested-array expansion
(`specs/field-mapping.md` — currently ❌ not implemented). R2RML's treatment of
many-to-many tables as independent triples maps with join conditions is a useful
reference model for the `array_path` feature design.

### 4.4 CURIE / namespace prefixes in config

YARRRML's `prefixes:` block allows abbreviated URIs throughout the mapping file
(`foaf:firstName` instead of `http://xmlns.com/foaf/0.1/firstName`). If OpenSync adopts
URI predicates by convention (see `REPORT_ASSOCIATION_NAMING.md §3`), a `prefixes:` block
in its YAML config would keep the files readable.

---

## 5. What R2RML / YARRRML Could Not Do (OpenSync-Only Territory)

These features have no R2RML analogue and are not addressable by extending YARRRML:

1. **Reverse transforms** — R2RML is one-way by definition.
2. **Conflict resolution** — R2RML assumes one authoritative source.
3. **Incremental sync** — R2RML materialises or virtualises; it does not poll, watermark, or retry.
4. **Deferred associations** — R2RML join conditions require both sides available at runtime.
5. **Echo detection** — R2RML has no concept of re-propagation.
6. **Circuit breakers / rollback** — O11y concerns are entirely outside the spec.
7. **Multi-connector fan-out** — R2RML maps one DB to one RDF graph; OpenSync fans out
   one ingest event to $n$ target connectors with per-connector predicate translation.

---

## 6. Relationship to the `owl:sameAs` Discussion (Cross-Reference)

This analysis reinforces §3.6 of `REPORT_ASSOCIATION_NAMING.md`: field mappings are
*not* `owl:equivalentProperty` because the value transformation semantics are richer.
R2RML itself acknowledges the gap: its only non-trivial transform mechanism for values
is embedding SQL in the mapping (relational) or delegating to FnO (graph). OpenSync
inlines arbitrary JS expressions, explicitly decoupling the canonical field name from
the value mapping. Similarly, identity resolution in R2RML is IRI-template–based
(namespace + PK column), while OpenSync's is field-value–matching (any shared field)
followed by opaque UUID generation — a weaker but more practical assumption for
SaaS systems that do not share a global namespace.

---

## 7. References

- R2RML: W3C Recommendation — https://www.w3.org/TR/r2rml/
- RML: https://rml.io/specs/rml/
- YARRRML: https://w3id.org/yarrrml/spec/
- FnO (Function Ontology): https://fno.io/spec/
- OpenSync specs: `specs/field-mapping.md`, `specs/associations.md`, `specs/connector-sdk.md`
- Related plans: `plans/meta/REPORT_ASSOCIATION_NAMING.md §3.6`,
  `plans/connectors/REPORT_SEMANTIC_SOURCES.md`,
  `plans/connectors/PLAN_NON_LOCAL_ASSOCIATIONS.md`
