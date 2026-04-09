# PLAN: Lineage Diagram — Unmapped Entity Pool

**Status:** proposed  
**Date:** 2026-04-09  
**Effort:** XS  
**Domain:** playground  
**Scope:** `playground/src/ui/lineage-diagram.ts`, `playground/src/ui/lineage-model.ts`,
  `specs/playground.md`  
**Spec:** specs/playground.md §11  
**Depends on:** PLAN_MAPPING_VISUALIZATION.md (complete),
  PLAN_LINEAGE_ARRAY_EXPRESSIONS.md (complete)  

---

## § 1 Problem

The lineage diagram only shows entities that are already assigned to a channel. Entities
present in the registered connectors but not yet referenced in any channel mapping are
invisible. This makes the diagram useless as a starting point when designing a config
from scratch: the user has no way to see what is available to map.

---

## § 2 Solution

At the bottom of the lineage diagram, below all channel swimlanes, render an **entity pool
row** listing every connector entity that does not appear in any channel in the current
config. Each entry shows `connectorId / entity`.

When the user is working on a fresh or partial config they can see at a glance which
entities still need to be wired up. Once an entity is added to a channel its pill
disappears from the pool — it has been promoted into a swimlane.

If all entities are mapped, the pool row is omitted entirely.

---

## § 3 Spec changes planned

| File | Section | Change |
|------|---------|--------|
| `specs/playground.md` | §11 | Add §11.14 — Unmapped entity pool: rendered at bottom of lineage diagram; omitted when empty |

---

## § 4 Design

### § 4.1 Data source

`renderLineageDiagram` already receives the `channels` array from the parsed
`ScenarioDefinition`. It also needs to know which `(connectorId, entity)` pairs exist in
the registered systems. The simplest source is the `InMemoryConnector.snapshot()` call
that `main.ts` already calls — the keys of the returned object are the entity names for
that connector.

Pass a `Map<connectorId, string[]>` (connector → entity names) as a new optional parameter
to `renderLineageDiagram`. When absent (e.g. in unit tests), the pool row is skipped.

### § 4.2 Computing unmapped entities

```typescript
// Collect all (connectorId, entity) pairs referenced in any channel member
const mapped = new Set<string>();
for (const ch of channels) {
  for (const m of ch.members) {
    // array-source members expose sourceEntity to the pool, not the synthetic entity name
    mapped.add(`${m.connectorId}/${m.sourceEntity ?? m.entity}`);
  }
}

// Pool = all available entities minus mapped ones
const pool: { connectorId: string; entity: string }[] = [];
for (const [connectorId, entities] of allEntities) {
  for (const entity of entities) {
    if (!mapped.has(`${connectorId}/${entity}`)) pool.push({ connectorId, entity });
  }
}
```

### § 4.3 Rendering

When `pool.length > 0`, append a `<div class="ld-unassigned-pool">` below the last
channel graph:

```
────────────────────────────────────────────────
unassigned   crm/contacts   erp/employees   hr/people  …
```

- A muted italic label `unassigned` on the left.
- One `<span class="ld-pool-entity">` pill per entry, labelled `connectorId / entity`.
- Styled to visually separate from the channel swimlanes (top border, reduced opacity).
- No interactivity — pills are read-only labels in this plan.

When `pool` is empty the element is not rendered.

---

## § 5 Work Items (in order)

1. Extend `renderLineageDiagram` signature to accept optional
   `allEntities: Map<string, string[]>`.
2. Compute the pool set as in §4.2.
3. Render `ld-unassigned-pool` row when pool is non-empty.
4. Pass `allEntities` from `main.ts` (build from `conn.snapshot()` keys for each system).
5. Add `specs/playground.md §11.14`.
