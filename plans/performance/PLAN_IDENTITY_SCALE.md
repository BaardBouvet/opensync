# Performance: Incremental Transitive Identity Resolution

**Status:** draft  
**Date:** 2026-04-07  
**Effort:** L  
**Domain:** Engine  
**Scope:** `packages/engine/src/engine.ts` (`discover`, `addConnector`, `_unionFindComponents`), `packages/engine/src/db/queries.ts`, `specs/identity.md`  
**Depends on:** `plans/engine/PLAN_TRANSITIVE_CLOSURE_IDENTITY.md` (complete)  
**See also:** `plans/performance/GAP_ENGINE_SCALING.md`, `specs/identity.md § Field-Value-Based Matching`  

---

## § 1 Problem Statement

The transitive identity feature introduced three code paths:

| Path | When called | Memory behaviour |
|------|-------------|-----------------|
| `_resolveCanonical()` | Every ingest record | **Incremental** — one `dbFindCanonicalByGroup` SQL lookup per identity group; O(G) queries, O(1) heap |
| `discover()` | Onboarding / full-sync | **Batch** — `dbGetAllShadowForEntity()` SELECT * per connector+entity, all rows into `nodes[]` |
| `addConnector()` | Adding a new connector | **Batch** — `dbGetAllCanonicals()` + `dbGetCanonicalFields()` per canonical + `dbGetAllShadowForEntity()` for joiner, all into Maps |

`_resolveCanonical` already demonstrates the correct pattern. The problem is that
`discover()` and `addConnector()` do not follow it.

### § 1.1 Concrete scaling failure

A contacts channel with five connectors, 200k records each:

- `dbGetAllShadowForEntity()` returns 200k rows per connector call
- `discover()` assembles one `nodes[]` array of 1 000 000 entries before the first union
- `addConnector()` loads all existing canonicals (~1M after previous onboarding) plus the
  new connector's 200k records into Maps before attempting any match
- Peak heap: proportional to **total stored records**, not to the delta arriving in any tick
- SQLite is idle while Node/Bun holds everything — no benefit from the DB's B-tree indexes

### § 1.2 `dbFindCanonicalByGroup` is already written

The incremental helper already exists; it uses `JSON_EXTRACT` with a parameterised WHERE
clause and returns at most one canonical ID per query.  What is missing is:

1. `addConnector()` using it per-record instead of scanning an in-memory Map
2. A SQL-based connected-components pass to replace `_unionFindComponents` inside `discover()`
3. Expression indexes on the identity fields so those `JSON_EXTRACT` calls use the B-tree

---

## § 2 Current Algorithmic Complexity

| Operation | Time | Memory |
|-----------|------|--------|
| `_resolveCanonical` | O(G · log N) at DB index | O(1) heap |
| `addConnector` | O((C + J) + J · G · C) | O(C + J) |
| `discover` | O(N · G · α(N)) union-find + O(N) load | O(N) |

Where N = total records, C = existing canonicals, J = joiner records, G = identity groups,
α = inverse Ackermann (≈ constant).

The O(N) / O(C + J) heap allocations are the problem.

---

## § 3 Proposed Approach

Three independent, orderable sub-tasks:

### § 3.1 Incrementalise `addConnector()` (Quick win)

`addConnector()` currently:
1. Loads all canonicals into `canonicalMap: Map<string, Record<string, unknown>>`
2. Loads all joiner records into `nodes: NodeEntry[]`
3. For each joiner node, iterates `canonicalMap` per group looking for value matches

Replace with the `_resolveCanonical` pattern:
- Iterate joiner records **one at a time** (or in configurable batches, see § 3.4)
- For each record, call `dbFindCanonicalByGroup` per identity group — exactly as
  `_resolveCanonical` does
- When groups resolve to multiple canonicals, call `dbMergeCanonicals` — exactly as
  `_resolveCanonical` does
- Never load `canonicalMap` or a flat `nodes[]` array for existing data

Result: `addConnector()` memory becomes O(batch_size) regardless of corpus size.

The transitive-merge case (`matchedCids.length > 1`) is already handled by
`_resolveCanonical`; `addConnector()` can simply call `_resolveCanonical` (or its
decomposed helpers) for each joiner record directly.

### § 3.2 SQL label-propagation for `discover()` (Core fix)

Replace `_unionFindComponents` (in-memory union-find over a full in-memory `nodes[]`)
with an iterative label-propagation pass that runs entirely in SQLite:

**Algorithm:**

```
1. CREATE TEMP TABLE discovery_components (
     connector_id TEXT, external_id TEXT, label TEXT, PRIMARY KEY (connector_id, external_id)
   )
   — initialised: INSERT SELECT connector_id, external_id, external_id AS label
     FROM shadow_state WHERE entity_name = ?

2. FOR EACH identity group g:
   a. Find all (label_a, label_b) pairs where two rows share the same normalised value
      for group g's fields:
        SELECT a.label, b.label
        FROM discovery_components a
        JOIN shadow_state sa ON a.connector_id = sa.connector_id AND a.external_id = sa.external_id
        JOIN shadow_state sb ON JSON_EXTRACT(sa.field_data, '$.<f>') = JSON_EXTRACT(sb.field_data, '$.<f>')
              [AND ... for each field in group]
        JOIN discovery_components b ON b.connector_id = sb.connector_id AND b.external_id = sb.external_id
        WHERE sa.entity_name = ? AND sb.entity_name = ? AND a.label <> b.label
   b. For each pair (la, lb), set component label = MIN(la, lb) for all rows with
      label = MAX(la, lb):
        UPDATE discovery_components SET label = ? WHERE label = ?

3. REPEAT step 2 until no rows were updated (fixed-point, typically 2–3 passes for real data)

4. GROUP BY label in discovery_components — each group is one connected component
```

No `nodes[]` array is ever allocated; the heap only holds the current pair batch in step 2b.
Step 2 benefits from expression indexes (§ 3.3) and processes data in O(edges) disk reads
rather than O(N) heap allocations.

**Fixed-point convergence:** For the identity graph of real-world CRM data, the diameter
(longest chain A-B-C-D via distinct fields) is typically 2–4 hops. The loop runs at most
`diameter` iterations. In degenerate pathological graphs it could take O(N) iterations but
each iteration is a short DB round-trip, not a full heap load.

### § 3.3 Expression indexes on identity fields (Supporting)

`dbFindCanonicalByGroup` and the label-propagation JOIN both use `JSON_EXTRACT`. Without an
expression index these are full scans of `shadow_state`.

When a channel is registered (or its `identityGroups` config is set), the engine should
`CREATE INDEX IF NOT EXISTS` for each identity field:

```sql
CREATE INDEX IF NOT EXISTS idx_shadow_<entity>_<field>
  ON shadow_state(entity_name, JSON_EXTRACT(field_data, '$.<field>'))
  WHERE entity_name = '<entity>';
```

Indexes are cheap to create; they need to be created once at channel boot, not on every
ingest. Add a `dbEnsureIdentityIndexes(db, entityName, groups)` helper called from
`SyncEngine.addChannel()`.

SQLite supports expression indexes since 3.9.0 (2015); the bundled Bun version is
far newer.

### § 3.4 Configurable joiner batch size (Housekeeping)

Even with § 3.1, each joiner record is one or more SQL round-trips. For very large connectors
it may be faster to process records in small in-memory batches (e.g. 1 000) and issue a
single multi-value SQL query per batch:

```sql
SELECT external_id, JSON_EXTRACT(field_data, '$.<f>') AS v
FROM shadow_state
WHERE entity_name = ? AND JSON_EXTRACT(field_data, '$.<f>') IN (?, ?, ...)
```

Expose `identityBatchSize?: number` on `ChannelConfig` (default 1 000). This is a tuning
knob, not a correctness change.

---

## § 4 Migration Path

| Step | Change | Risk |
|------|--------|------|
| 1 | Add `dbEnsureIdentityIndexes`; call from `addChannel()` | No behaviour change; indexes are advisory |
| 2 | Rewrite `addConnector()` to use per-record SQL lookups (§ 3.1) | Same observable outcome; testable with existing test suite |
| 3 | Rewrite `discover()` to use label propagation (§ 3.2) | Same observable outcome for all non-pathological graphs; add tests for chain depth ≥ 3 |
| 4 | Expose `identityBatchSize` config knob (§ 3.4) | Additive config; no breaking change |

Steps 1–4 are safe in any order. Step 3 has the most surface area and should get its own
PR. Steps 1 and 2 can go together.

---

## § 5 What Does Not Change

- The `_resolveCanonical()` ingest hot path is already correct. No changes planned there.
- The `dbMergeCanonicals` merge operation is unchanged.
- The external behaviour of `discover()` and `addConnector()` (their return values and
  the shadow-state mutations they produce) is identical. This is a pure implementation change.
- `identityGroups` / `identityFields` config shape is unchanged.

---

## § 6 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/identity.md` | New §: "Scalability" | Document that `discover()` and `addConnector()` use SQL label propagation rather than in-memory union-find; note that expression indexes are created automatically for declared identity fields |

No changes to the external contract sections of `specs/identity.md` (the union-find
*semantics* are unchanged; only the *implementation mechanism* changes).
