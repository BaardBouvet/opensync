# Triplestore-Based OpenSync: Experimental Architecture

This folder contains design and exploration for a **fundamental reimagining** of OpenSync using RDF (Resource Description Framework) and triple stores instead of SQLite tables.

## Why?

The current OpenSync stores records as JSON blobs with embedded metadata. A triplestore-based approach offers:

- **Simpler model**: All facts are triples (subject, predicate, object). Provenance lives in named graphs.
- **Native reasoning**: SPARQL queries replace imperative code for mappings, conflicts, lineage.
- **Better for agents**: The graph structure is explicit and inspectable—AI can navigate and reason over it directly.
- **Semantic power**: Associations, calculations, and inference are first-class.

## What's Here

- **PLAN_TRIPLESTORE_ARCHITECTURE.md** — Comprehensive 14-section design plan including data model, configuration format, conflict resolution, safety guarantees, and a concrete HubSpot → Salesforce example.
- This README.

## Key Ideas

1. **RDF as foundation**: Store immutable triples in a queryable knowledge graph.
2. **Named graphs for provenance**: Each connector has its own graph; canonical facts live in a shared graph.
3. **Identity via sameAs**: Link external IDs across systems using RDF's `owl:sameAs`.
4. **SPARQL + YAML config**: High-level YAML for common cases; deep SPARQL for advanced logic.
5. **Query-driven pipeline**: Mapping, conflict resolution, and derivations all expressed as SPARQL queries (or compiled from simpler config).

## Not (Yet) Production

This is **not** a replacement for the current OpenSync. It's an experimental track to explore fundamentally different tradeoffs. The current SQLite-based engine will continue to be maintained.

## Next Steps

1. Iterate on the plan: gather feedback, refine data model and configuration syntax.
2. Prototype Phase 1: stand up Oxigraph, adapt one connector to produce triples.
3. Benchmark: measure SPARQL performance at scale.
4. Parallel development: keep main OpenSync stable; treat triplestore as an alternative experimental branch.

---

**Status**: Design phase. Plan ready for iteration.  
**Author**: Experimental exploration, April 2026
