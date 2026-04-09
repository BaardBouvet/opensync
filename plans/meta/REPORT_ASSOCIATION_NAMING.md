# REPORT: Association Naming + Semantic Identifier Design

**Status:** draft  
**Date:** 2026-04-06  

---

## 1. Background

This report covers two related questions that surfaced together:

1. **Short-name problem.** The term *association* is the canonical word for "a pre-extracted
   FK-style pointer from one record to another", but it is among the longest first-class names
   in the codebase. Should it be shortened, and if so, to what?

2. **Semantic naming question.** Should OpenSync's identifiers — connector IDs, entity types,
   field names, association predicates — be designed as URI namespaces so they are globally
   unambiguous and interoperable with linked-data ecosystems?

Both questions interact: a URI-first design makes `sourceAssociations` vs `sourceLinks` vs
`sourceRefs` less important (the predicate is a URI anyway), but it also has significant
architectural implications for the identity model and connector API surface.

---

## 2. Association Identifier Inventory

The term *association* appears as a TypeScript type name (`Association`), a field name
(`associations`, `sourceAssociations`, `sourceShadowAssociations`, `deferred_associations`,
…), and in three spec files, all plan files, all connectors, and the playground UI.

The longest offenders:

| Identifier | Length |
|-----------|--------|
| `sourceShadowAssociations` | 24 |
| `_remapAssociationsPartial` | 25 |
| `deferred_associations` | 21 |
| `associationsField` | 17 |
| `sourceAssociations` / `beforeAssociations` / `afterAssociations` | 18–19 |

---

## 2. Current Inventory (summary)

| Layer | Identifiers |
|-------|-------------|
| SDK type | `Association`, `Ref` (`{ '@id', '@entity'? }` inline in `ReadRecord.data`); `FieldDescriptor.entity` for FK declarations |
| Engine fields | `sourceAssociations`, `sourceShadowAssociations`, `beforeAssociations`, `afterAssociations` |
| Engine methods | `_remapAssociations`, `_remapAssociationsPartial`, `parseSentinelAssociations`, `matchSideAssoc`, `matchAssocCache` |
| DB table | `deferred_associations` |
| DB sentinel | `__assoc__` (embedded in `canonical_data` JSON) |
| Config param | `associationsField` (jsonfiles connector) |
| Spec files | `specs/associations.md`, §§ of `connector-sdk.md`, `sync-engine.md`, `config.md`, `identity.md` |
| Plans | 6 plan files with "association" in the filename |
| Demo / playground | `associations-demo` example, `associationsField` seed data |

The name appears in approximately **220 source locations** across the workspace.

---

## 3. Semantic Identifier Design (Bigger Picture)

Before choosing a short name, it is worth asking whether identifiers in OpenSync should be
URI namespaces rather than ad-hoc strings. This section evaluates the idea and maps it
against existing plans.

### 3.1 The proposal in brief

If connector instance IDs, entity type names, and field names were URIs, each identifier
would be globally unambiguous and namespaced by authority:

| Concept | Current | URI form |
|---------|---------|----------|
| Connector instance ID | `"hubspot-acme"` | `https://acme.example.com/sync/hubspot` |
| Entity type | `"contact"` | `https://acme.example.com/sync/hubspot/contact` or `https://schema.org/Person` |
| Field name | `"companyId"` | `https://acme.example.com/sync/hubspot/contact/companyId` |
| Association predicate | `"companyId"` | `https://schema.org/worksFor` |

The connector instance namespace (`hubspot/`) would contain all entity namespaces
(`hubspot/contact/`), which would contain all field URIs. This mirrors the RDF/JSON-LD model
exactly.

### 3.2 What already exists

This territory has been partially explored:

- **`REPORT_SEMANTIC_SOURCES.md`** (`plans/connectors/`) — full opt-in design for graph/semantic
  connectors. Defines `graphAware: true` on `ConnectorMetadata` and `EntityDefinition`;
  allows connectors to emit `@context` + `@graph` JSON-LD directly. The `Association.predicate`
  field is already documented as accepting full URI strings (e.g., `https://schema.org/worksFor`).

- **`PLAN_NON_LOCAL_ASSOCIATIONS.md`** (`plans/connectors/`) — proposes `semanticType?: string`
  on `EntityDefinition` (a URI, e.g. `https://schema.org/Organization`) for cross-channel
  entity resolution. When two connectors in different channels declare the same `semanticType`,
  the engine can route associations between them without explicit channel membership.

- **SPARQL connector** (`connectors/sparql/`) — already lives fully in URI space: record IDs
  are IRIs, `Association.predicate` values are full predicate URIs, namespace constants
  (`SCHEMA`, `DCTERMS`, `XSD`) are first-class.

- **`PLAN_PREDICATE_MAPPING.md`** (`plans/engine/`) — treats association predicates as opaque
  strings (short or URI) and adds a canonical routing key per channel; the canonical key is
  an internal name, not required to be a URI.

What does **not** exist:
- Any proposal to use URIs as connector instance IDs.
- Any proposal to use URIs as entity type names in the engine's identity model.
- Any design for CURIE prefix expansion (noted as follow-on in `PLAN_NON_LOCAL_ASSOCIATIONS.md`).

### 3.3 How far does the idea scale?

#### Strong case: predicates and semantic entity types

The architecture already supports URI predicates (SPARQL connector, `specs/associations.md`
example). Making them the *default* for all connectors is a natural extension. Similarly,
`semanticType` on entities (`PLAN_NON_LOCAL_ASSOCIATIONS.md`) is a clean, opt-in URI handle
that does not force relational connectors to change anything.

These are **already planned and low-risk**.

#### Weak case: connector instance IDs and entity type names

Making connector instance IDs URIs would mean every config file, log message, and SDK call
carries `https://acme.example.com/sync/hubspot-acme` instead of `"hubspot-acme"`. In
practice:

- The engine's identity model uses `(connectorInstanceId, externalId)` as a composite key
  in the `identity_map` table. There is no semantic interpretation of the connector ID — it
  is a discriminator, not a namespace.
- Channel and entity names in config are primarily short labels for human authoring and log
  readability. URI syntax in YAML config would be verbose and error-prone without tooling.
- RDF connectors (SPARQL) already use URI *record IDs* — the connector instance ID remains
  a short discriminator on top.

The benefit (global uniqueness of connector-instance namespace) applies mostly to
multi-tenant or federated deployments — a scope well beyond the current roadmap. The cost
is significant ergonomic friction in config and logs for all users.

**Conclusion for connector instance IDs:** not worth adopting as the general default. A
future `semanticId?: string` field on connector config (analogous to `semanticType` on
entities) could opt in to URI-based identification without forcing it everywhere.

#### Middle ground: entity type URIs

Entity type names in connections (`"contact"`, `"company"`) are currently unqualified strings
scoped implicitly to the connector. `semanticType` from `PLAN_NON_LOCAL_ASSOCIATIONS.md`
already adds a URI handle as an *alias* — the short name remains the routing key and the URI
is used for cross-channel semantic resolution. This is the right balance: no churn on the
common case, URI semantics available when needed.

### 3.4 Interaction with the short-name question

If predicates become URIs by convention (not requirement), the name of the TypeScript field
that holds them (`associations`, `links`, `refs`) matters less for discoverability — a
developer reading the type sees `https://schema.org/worksFor`, not the container field name.
However, short names still matter for:

- Engine-internal identifiers (`sourceAssociations`, `deferred_associations`)
- Config map keys (`associationsField`)
- Log output and devtools UI

So the short-name question remains relevant regardless of whether a semantic naming layer
is added on top.

### 3.5 Recommendation on semantic naming

| Area | Recommendation |
|------|--------------|
| `Association.predicate` | Already URI-capable. No change needed. |
| `EntityDefinition.semanticType` | Adopt from `PLAN_NON_LOCAL_ASSOCIATIONS.md`. Low-risk opt-in. |
| Connector instance URI | Defer. Add `semanticId?` field on connector config post-release only. |
| Entity type URIs as primary keys | Do not adopt. Keep short names; `semanticType` is the alias. |
| Field name URIs | Not planned. Fields are connector-local strings; predicates (associations) carry the URI. |

A standalone plan for the semantic layer already exists across
`REPORT_SEMANTIC_SOURCES.md` and `PLAN_NON_LOCAL_ASSOCIATIONS.md`. No new plan is needed
here — the short-name decision (§§ 4–10 below) is orthogonal.

### 3.6 Are channels and field mappings equivalent to `owl:sameAs`?

In OWL, `owl:sameAs` asserts strict logical identity between two URIs:
everything that is true of individual X is true of individual Y, and vice versa.
Applied to OpenSync's concepts:

| OpenSync concept | Closest OWL/semantic-web analogue | Where it diverges |
|-----------------|----------------------------------|-------------------|
| Channel + identity resolution: "this CRM contact and this ERP person are the same real-world entity" | `owl:sameAs` at the individual level | OpenSync asserts *representational* co-reference, not full logical equivalence — the two records can have different fields, different field values, and different association sets. They are projections of the same entity, not interchangeable descriptions. |
| Field mapping: "CRM `firstName` ↔ ERP `first_name`" | `owl:equivalentProperty` | `owl:equivalentProperty` is purely structural (same extension). Field mappings add a *transform layer*: value coercions, format conversions, computed expressions. No OWL primitive covers that. |
| Association predicate mapping: `companyId` ↔ `orgRef` ↔ `https://schema.org/worksFor` | Property alignment in ontology matching; also `skos:exactMatch` for concept alignment | Same transform gap: OpenSync may rewrite `targetId` during dispatch; OWL alignment is static. |
| Channel declaration as a whole: "connector A's `contact` entity aligns with connector B's `person` entity" | An *ontology alignment* in the sense of the Ontology Alignment Evaluation Initiative (OAEI), or `skos:exactMatch` at the class level | OWL alignment says nothing about sync direction, conflict resolution, or rate limiting — all engine concerns. |

**`owl:sameAs` is too strong.** It implies that any statement derivable from the CRM record
is derivable from the ERP record. That would mean identical field values, identical
associations, identical provenance — none of which is guaranteed or desired. OpenSync
records are *co-referent projections* of the same real-world entity through different
connector lenses. The correct semantic-web framing is closer to SKOS `skos:exactMatch`
(same concept, different vocabulary, no inference requirements) or the `owl:sameAs`
weakening used in Linked Data practice ("probably the same thing, use with care").

**The transform layer is the key differentiator.** Semantic alignment standards (OWL,
SKOS, OAEI, YARRRML, R2RML) all assume that matching fields contain *the same values* in
different syntactic clothing. OpenSync explicitly supports fields whose values differ
across connectors after intentional transformation (currency scaling, date format
normalisation, enum remapping). This is a richer contract than any OWL primitive
expresses and is the reason a bespoke field-mapping language (`specs/field-mapping.md`)
is necessary rather than a standard ontology alignment format.

**Practical implication for the semantic URI question:** If field mappings were expressed
as `owl:equivalentProperty` triples, the transform expressions would still need a
non-standard extension — precisely the problem that R2RML and YARRRML solve for
database-to-RDF lifting. A future "export mapping as RDF alignment" feature could emit
`owl:equivalentProperty` for lossless string-to-string mappings and a custom predicate
(e.g., `opensync:transformedEquivalentProperty`) for mappings with transforms, but that
is purely a serialisation concern and does not change the internal model.

---

## 4. Short-Name Candidates

### 4.1 `link` / `links`


*"Contact links to Company"*

**Pros**
- Very short (4/5 chars).
- Reads naturally as a verb and noun (link a record, a link between records).
- Common in hypermedia APIs (HAL `_links`, HTML `<link rel>`).

**Cons**
- **Hard collision.** The engine already uses "link" to mean "identity-map binding":
  an identity link is what maps an external ID to a canonical UUID. Confusion between
  "identity link" and "record link" would be constant and hard to resolve in prose.
- `deferred_links` would be ambiguous — does it mean deferred identity binding or a
  deferred FK pointer?

**Verdict:** ruled out due to collision.

---

### 4.2 `edge` / `edges`

*"Contact edge to Company"*

**Pros**
- Standard in graph databases (Neo4j, Dgraph) and RDF.
- Short (4/5 chars).

**Cons**
- **Soft collision.** Multiple connectors already use `edges` as a GraphQL pagination
  cursor field (`{ edges: { node: T }[] }`). The two usages are syntactically identical,
  making search and documentation confusing.
- "Edge" carries graph-model connotations. OpenSync associations are ordered, named,
  one-directional FK-style pointers — not symmetric graph edges. The semantic fit is
  imprecise.

**Verdict:** ruled out due to collision and semantic mismatch.

---

### 4.3 `reference` / `references`

*"Contact references Company"*

**Pros**
- Semantically precise — specs already use it in prose ("pre-extracted reference fields").
- No collision.

**Cons**
- Longer than `association` in plural form (`references` = 10; `associations` = 12 —
  only 2 chars shorter). Compound names are barely improved:
  `sourceReferences` saves only 2 chars over `sourceAssociations`.

**Verdict:** not worth the churn for marginal gain.

---

### 4.4 `rel` / `rels`

*"Contact rel to Company"*

**Pros**
- Very short (3/4 chars).
- Used in HTML `rel` attribute, HTTP `Link: rel=`, and OpenAPI `externalDocs.x-rel`.
- No collision in the current codebase.

**Cons**
- `rel` is often understood as *relation type* (the predicate), not as the whole
  association object. The SDK's `Association` carries three fields: `predicate`,
  `targetEntity`, `targetId`. Calling the whole object a `rel` is ambiguous.
- Less discoverable for developers unfamiliar with HTML link semantics.

**Verdict:** viable but semantically imprecise.

---

### 4.5 `ref` / `refs`

*"Contact ref to Company"*

**Pros**
- Short (3/4 chars). Compound names shrink significantly:
  | Current | Renamed |
  |---------|---------|
  | `sourceAssociations` (19) | `sourceRefs` (11) |
  | `sourceShadowAssociations` (25) | `sourceShadowRefs` (17) |
  | `beforeAssociations` (18) | `beforeRefs` (10) |
  | `afterAssociations` (18) | `afterRefs` (9) |
  | `_remapAssociationsPartial` (25) | `_remapRefsPartial` (17) |
  | `deferred_associations` (21) | `deferred_refs` (13) |
  | `associationsField` (17) | `refsField` (9) |
  | `__assoc__` (8) | `__ref__` (7) |
- `ref` is ubiquitous in developer tooling (git refs, React refs, TypeScript project
  references, JSON `$ref`, GraphQL fragment refs). Developers read it instinctively.
- No collision in the current codebase — the word does not appear as a term of art
  anywhere in the engine or SDK.
- Works well as a noun (*this record has three refs*), a verb (*ref the target record*),
  and an adjective (*ref field*).

**Cons**
- `Ref` is less self-documenting than `Association` — a reader encountering `Ref` cold
  must look it up rather than inferring from English.
- TypeScript/React developers associate `ref` specifically with mutable object references.
  Some cognitive retraining required for newcomers.

**Verdict:** best balance of concision and collusion-avoidance.

---

### 4.6 `assoc` / `assocs` (abbreviation, not renaming)

Keep the concept name but shorten the identifier to its established abbreviation.
The DB sentinel already uses `__assoc__`, giving a precedent.

**Pros**
- Unambiguous — anyone who knows "association" immediately reads "assoc".
- Smaller diff than a full rename; spec prose stays unchanged.
- Type name `Assoc` (5 chars) vs `Association` (11).

**Cons**
- Still longer than `ref`/`link`/`edge`.
- Mixing full-word (`Association`) in prose and abbreviated (`assoc`) in code is
  inconsistent unless the full word is dropped everywhere.

**Verdict:** acceptable fallback if `ref` is rejected for cultural reasons.

---

## 5. Alternative Strategy: Rename the Identity Concept Instead

Rather than avoiding `link` as a replacement for `Association`, we could rename the
*identity-map binding* concept so that `link` becomes free.

### 5.1 What does the identity concept actually mean?

The engine maintains an `identity_map` table where each row records that *connector C
knows this canonical UUID as external ID X*. The operation is:

> "Given an external ID in connector C, find (or create) the canonical UUID that
> represents the same real-world entity across all connectors."

This is a lookup-and-bind operation; the row it creates is not a pointer between two
data records — it is an ID registration entry.

### 5.2 Current identity-link identifiers

| Identifier | Type | File |
|-----------|------|------|
| `dbLinkIdentity(db, canonicalId, connId, externalId)` | function | `db/queries.ts` |
| `dbGetLinkedConnectors(canonicalId)` | function | `db/queries.ts` |
| `linked: number` | field on `OnboardResult` | `engine.ts` |
| `linked: Array<{ canonicalId, externalId, matchedOn }>` | field on `AddConnectorReport` | `engine.ts` |
| `crossLinked` | local variable (query result) | `engine.ts` |
| `"identity link"` / `"identity links"` | prose | specs, plans |
| `"cross-linked"` | adjective | specs, plans, engine |

There is **no named interface or type** called `IdentityLink`. The term lives primarily
in function names, two result-object fields, one local variable, and prose.
Total occurrences: ~40 code identifiers + prose.

### 5.3 Candidate replacements for the identity concept

#### `binding` / `bindings`

*"Bind this external ID to a canonical UUID."*

- Semantically precise: a binding is a registered association between an ID in one
  namespace and an ID in another.
- No collision anywhere in the codebase.
- Reads as both verb and noun: *bind an external ID*, *one binding per external ID*.
- Compound names work naturally:
  | Current | Renamed |
  |---------|---------|
  | `dbLinkIdentity` | `dbBindIdentity` |
  | `dbGetLinkedConnectors` | `dbGetBoundConnectors` |
  | `linked: number` | `bound: number` |
  | `linked: Array<...>` | `bindings: Array<...>` |
  | `crossLinked` | `crossBound` |
  | `"identity link"` | `"identity binding"` |
  | `"cross-linked"` | `"cross-bound"` |

"Cross-bound" is slightly awkward but acceptable; "cross-mapped" (see below) is a
natural alternative for that specific adjective.

**Verdict:** cleanest option.

#### `mapping` / `mappings`

*"Map this external ID to a canonical UUID."*

- The table is already named `identity_map`, making "mapping" a natural match.
- However, "mapping" is already heavily used in the *field-mapping* domain
  (`specs/field-mapping.md`, `fieldMappings` in config). Introducing a second,
  unrelated "mapping" concept risks confusion.

**Verdict:** acceptable but adds ambiguity in a domain where "mapping" already has a
specific meaning.

#### `registration` / `registrations`

*"Register this external ID."*

- Precise, but verbose — longer than `association`.

**Verdict:** too long.

#### `entry` / `entries`

*"The identity map entry for this external ID."*

- Too generic; does not carry meaning on its own.

**Verdict:** too weak.

### 5.4 Migration scope for the identity rename (to `binding`)

| Area | Files | Est. changes |
|------|-------|-------------|
| Engine queries (`db/queries.ts`) | 1 | ~6 function names |
| Engine (`engine.ts`) | 1 | ~20 occurrences |
| Spec files (`specs/`) | 4 | prose only (~25 occurrences) |
| Plan files (`plans/`) | ~8 | prose only (~20 occurrences) |

Total: ~70 changes across ~14 files. **Significantly smaller** than renaming
`Association` (~170 changes, ~31 files).

### 5.5 Combined approach

Rename identity link → **binding**, then rename association → **link**:

| Layer | Before | After |
|-------|--------|-------|
| SDK type | `Association` | `Link` |
| SDK field | `associations?: Association[]` | `links?: Link[]` |
| Engine fields | `sourceAssociations` | `sourceLinks` |
| Engine fields | `sourceShadowAssociations` | `sourceShadowLinks` |
| Engine fields | `beforeAssociations` / `afterAssociations` | `beforeLinks` / `afterLinks` |
| Engine method | `_remapAssociations` | `_remapLinks` |
| DB table | `deferred_associations` | `deferred_links` |
| DB sentinel | `__assoc__` | `__link__` |
| Config param | `associationsField` | `linksField` |
| Identity function | `dbLinkIdentity` | `dbBindIdentity` |
| Identity field | `linked: number` | `bound: number` |
| Identity adjective | `crossLinked` | `crossBound` |

This yields the **shortest possible identifiers** for the FK-pointer concept
(`links`, `sourceLinks`, `beforeLinks`) while keeping the identity-map concept
unambiguous (`binding`, `bound`, `crossBound`).

---

## 6. Collision Summary

| Candidate (for Association) | Existing use | Safe as-is? | Safe after identity rename? |
|----------------------------|-------------|------------|---------------------------|
| `link` | identity-map link (external-ID → canonical UUID) | **no** | **yes** if identity → `binding` |
| `edge` | GraphQL pagination cursor nodes | marginal | marginal |
| `reference` | descriptive prose only | yes, barely shorter | yes, barely shorter |
| `rel` | no formal use | yes | yes |
| `ref` | no formal use | **yes** | **yes** |
| `assoc` | `__assoc__` sentinel (consistent) | **yes** | **yes** |

---

## 7. Migration Scope

Three options in ascending scope:

### 7.1 Option A — Rename Association → `ref` only (~170 changes, ~31 files)

| Area | Files | Est. changes |
|------|-------|-------------|
| SDK types (`packages/sdk/src/types.ts`) | 1 | ~10 |
| Engine (`packages/engine/src/engine.ts`) | 1 | ~80 |
| Engine migrations (`db/migrations.ts`) | 1 | table rename |
| Connectors (`connectors/*/src/index.ts`) | 5 | ~15 |
| Dev connectors (`dev/connectors/*/src/`) | 2 | ~25 |
| Playground (`playground/src/`) | 6 | ~30 |
| Demo (`demo/`) | 3 | ~10 |
| Spec files (`specs/`) | 6 | prose + identifiers |
| Plan files (`plans/`) | 6 filenames + body | prose |
| Example data (`demo/data/`) | JSON field | configurable, not renamed |

### 7.2 Option B — Rename identity link → `binding` only (~70 changes, ~14 files)

| Area | Files | Est. changes |
|------|-------|-------------|
| Engine queries (`db/queries.ts`) | 1 | ~6 |
| Engine (`engine.ts`) | 1 | ~20 |
| Spec files (`specs/`) | 4 | prose only (~25) |
| Plan files (`plans/`) | ~8 | prose only (~20) |

Achieves nothing on its own for the ergonomics problem — `sourceAssociations` stays long.
Only worthwhile as a prerequisite for Option C.

### 7.3 Option C — Both renames: identity link → `binding`, Association → `link` (~240 changes, ~40 files)

Combines Option A + Option B. Achieves the shortest possible identifiers:

| Current | After Option C |
|---------|---------------|
| `Association` | `Link` |
| `sourceAssociations` (19) | `sourceLinks` (11) |
| `sourceShadowAssociations` (25) | `sourceShadowLinks` (17) |
| `beforeAssociations` / `afterAssociations` | `beforeLinks` / `afterLinks` |
| `deferred_associations` | `deferred_links` |
| `associationsField` | `linksField` |
| `dbLinkIdentity` | `dbBindIdentity` |
| `linked: number` | `bound: number` |
| `crossLinked` | `crossBound` |

---

## 8. Recommendation

Two viable paths. Neither has a clear winner — this is a judgment call.

### 8.1 Path 1: `ref` (Option A only)

**Adopt `ref` / `refs`.** No prerequisite rename needed. Saves 8–14 chars on compound
identifiers. No collision. Well-understood in developer tooling (git refs, JSON `$ref`,
TypeScript `references`). Slightly ambiguous — `ref` can mean "the predicate" rather
than the whole link object — but context resolves it.

### 8.2 Path 2: `link` (Option C — both renames)

**Rename identity concept to `binding`, then adopt `link` / `links`.** Achieves the
*most natural* English word: "a record links to another record", "three links on this
record". The identity-binding rename is low-risk (no public interface, ~70 changes, prose
only for specs). Total effort is larger but delivers a better long-term API surface.

**Preference:** Path 2 (`link`) if the identity rename is acceptable; Path 1 (`ref`)
if a two-step rename is too disruptive right now.

Both renames are pre-release breaking changes; backward compatibility is not required.

---

## 9. Open Questions

1. **Spec file name.** Rename `specs/associations.md` → `specs/links.md` (or `refs.md`),
   or keep the longer name for documentation discoverability while shortening code identifiers?
2. **JSON data field default.** The jsonfiles connector defaults to field name
   `"associations"`. Change to `"links"` / `"refs"` for consistency, or leave it stable
   for existing data files?
3. **Timing.** Rename before or after `PLAN_ASSOCIATION_SCHEMA.md` and
   `PLAN_NON_LOCAL_ASSOCIATIONS.md`? Earlier is less churn.
4. **`Link` vs `Ref` type name.** `Link` reads like a DOM/HTML element in some TS contexts;
   `Ref` reads like a React mutable ref. Neither is perfect — accept the minor cognitive load?

---

## 10. Decision Record

*(To be filled when a decision is made.)*

| | |
|--|--|
| Decision | — |
| Chosen term | — |
| Identity concept renamed to | — |
| Date | — |
| Notes | — |
