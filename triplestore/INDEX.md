# Triplestore Architecture: Plan Index

This folder contains two interrelated design documents for a potential reimagining of OpenSync using RDF triple stores.

## Reading Order

### 1. **README.md**
Quick overview and context. Start here.

### 2. **PLAN_TRIPLESTORE_ARCHITECTURE.md** (1006 lines, 14 sections)
The core architectural redesign. Covers:
- **§1–2**: RDF data model, triples, named graphs, connector contract
- **§3**: Configuration format (YAML + SPARQL hybrid)
- **§4–5**: Conflict resolution and safety/rollback
- **§6–7**: Backend options (Oxigraph) and configuration tooling
- **§8–9**: Comparison with current OpenSync, development roadmap
- **§10–14**: Key decisions to iterate, open questions, success criteria
- **Appendices**: Worked example (HubSpot → Salesforce), ontology sketch

**Key insight**: Triples as the universal currency. All data flows become graph operations.

### 3. **PLAN_STRUCTURAL_TRANSFORMATION.md** (1061 lines, 14 sections)
Companion plan addressing a major challenge: **systems use different structural shapes**.

- **§1–2**: RDF representation of nesting (blank nodes, arrays via predicates)
- **§3–4**: Decomposition (flat→nested) and recomposition (nested→flat) rules
- **§5–6**: Configuration format, SPARQL for complex transforms
- **§7–8**: SDK connector hints, full worked example (HubSpot ↔ SF ↔ Shopify)
- **§9–14**: Performance, edge cases, testing strategy

**Key insight**: Blank node identity + deterministic naming + SPARQL recomposition solves the structural mismatch problem.

### 4. **example-config.yaml** (253 lines)
Concrete YAML configuration for a HubSpot ↔ Salesforce sync, showing:
- Namespace definitions
- Connector configuration
- Field mappings with conflict resolution
- Derived fields (SPARQL)
- Safety settings and observability

## How They Relate

```
PLAN_TRIPLESTORE_ARCHITECTURE.md
  ├─ § 1–2: Core data model & connector contract
  │
  ├─ § 3: Configuration format
  │   └─ REFERENCES §3 of PLAN_STRUCTURAL_TRANSFORMATION
  │      (Configuration includes field mappings + structural transforms)
  │
  └─ § 6–7: Backend & tooling
      └─ DEPENDS ON §3 of PLAN_STRUCTURAL_TRANSFORMATION
         (SDK hints must be declared in connector metadata)

PLAN_STRUCTURAL_TRANSFORMATION.md
  ├─ § 1–2: RDF representation of structures
  │   └─ EXTENDS § 1–2 of PLAN_TRIPLESTORE_ARCHITECTURE
  │      (Same triple/graph foundation + nested triples)
  │
  ├─ § 3–6: Config + SDK for decomposition/recomposition
  │   └─ INTEGRATES WITH § 3 & 6 of PLAN_TRIPLESTORE_ARCHITECTURE
  │
  └─ § 8–14: Examples, testing, edge cases
      └─ SHOWS CONCRETE APPLICATION of main plan concepts
```

## Key Sections to Focus On

**If you want to understand...**

- **The core idea**: Read README + PLAN_TRIPLESTORE_ARCHITECTURE §1–3
- **How to sync different systems**: Read both plans + example-config.yaml
- **How to handle real-world data shapes**: Read PLAN_STRUCTURAL_TRANSFORMATION §1–8
- **Configuration syntax**: Read both § 3 sections
- **The backend choice**: PLAN_TRIPLESTORE_ARCHITECTURE §6
- **Safety & rollback**: PLAN_TRIPLESTORE_ARCHITECTURE §5
- **Prototype roadmap**: PLAN_TRIPLESTORE_ARCHITECTURE §9

## Major Design Decisions Requiring Iteration

### From Main Plan (PLAN_TRIPLESTORE_ARCHITECTURE)
1. **Versioning strategy** (§10.1): Separate triples vs. temporal graphs?
2. **Provenance granularity** (§10.2): Per batch, per triple, or per transaction?
3. **Watermark storage** (§10.3): In triplestore or separate KV store?
4. **Performance** (§11.1): How fast is SPARQL on 1M triples?

### From Structural Plan (PLAN_STRUCTURAL_TRANSFORMATION)
1. **Blank node identity**: Deterministic naming via content hash or other scheme?
2. **Array representation**: Repeated predicates vs. RDF collections? (picked predicates)
3. **Materialized views**: Precompute recomposed shapes for performance?
4. **Nesting depth**: Support arbitrary depth or limit to N levels?

## Status

- **Architecture**: Design phase, not prototype
- **Structural xforms**: Design phase, companion to main architecture
- **Next step**: Stakeholder feedback; iterate on key decisions; prototype Phase 1

## Quick Reference: File Sizes & Sections

| File | Lines | Sections | Purpose |
|------|-------|----------|---------|
| README.md | 41 | — | Overview + next steps |
| PLAN_TRIPLESTORE_ARCHITECTURE.md | 1006 | 14 | Core architecture |
| PLAN_STRUCTURAL_TRANSFORMATION.md | 1061 | 14 | Flat ↔ nested handling |
| example-config.yaml | 253 | — | Concrete example |
| **Total** | **2361** | — | — |

## Architecture Philosophy

These plans embrace a **graph-centric model**:

1. **Immutability**: Triples are appended, never modified.
2. **Semantics first**: RDF predicates carry meaning; queries are self-documenting.
3. **Configuration as queries**: SPARQL is both engine logic and user-facing DSL.
4. **Transparency**: Every fact, transformation, and lineage is queryable.
5. **Reversibility**: Any sync operation is rolledback via graph surgery.

---

**Ready for iteration.** Questions, feedback, and design refinements welcome.
