# Plan: Lineage for Nested Arrays and Expression Fields

**Status:** complete  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** Playground, Engine config  
**Scope:** `playground/src/ui/lineage-model.ts`, `playground/src/ui/lineage-diagram.ts`, `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`  
**Spec:** `specs/playground.md §11`, `specs/field-mapping.md §1.3`  
**Depends on:** PLAN_MAPPING_VISUALIZATION.md (complete), PLAN_ARRAY_DEMO_SCENARIO.md (draft)  

---

## § 1 Problem

Three gaps in the field-lineage diagram, surfaced by the array-demo scenario and the
recently-implemented expression resolver feature:

### § 1.1 Array-expansion members

`buildChannelLineage` uses `member.entity` as the entity label and `f.source ?? f.target` as
the source field name. For an array-expansion member (e.g. `webshop` in `order-lines` with
`sourceEntity: "purchases"`, `arrayPath: "lines"`), this produces:

- Entity label: `webshop / order_lines` — wrong. The connector actually exposes `purchases`
  records; the array expansion is internal engine logic.
- Field labels: correct for element fields, but `parentFields` entries come from the parent
  record (one level up the array path), not from the element itself. There is no visual
  distinction between element fields and parent-scope fields.

### § 1.2 Expression fields

When a `FieldMapping` has `expression` set, the canonical value is synthesised from N source
fields. The `source` key is typically absent (not meaningful when an expression runs). The
current code falls back to `sourceField: source ?? target`, placing the canonical name on
both sides of the connection — misleading for cases like:

```yaml
- target: fullName
  expression: (record) => `${record.firstName} ${record.lastName}`
```

Here `fullName ← {firstName, lastName}` is a fan-in of two source fields, but the diagram
currently shows a single `fullName → fullName` identity line.

### § 1.3 Expression resolvers

The `resolve` hook on `FieldMapping` (§2.3, recently implemented) makes a canonical field
depend on contributions from *multiple connectors*. This is multi-source fan-in at the
canonical spine level. It is currently invisible in the diagram.

---

## § 2 Scope

**In scope:**

- `ESSENCE.md` — add belief: declarative mappings give lineage for free (done in this
  session, alongside this plan)
- Array-source entity labels and field annotations in `buildChannelLineage`
- `sources?: string[]` annotation on `FieldMappingEntry` (schema) and `FieldMapping`
  (loader interface) — explicit declaration of which source fields an expression reads
- Static analysis fallback: regex extraction when `sources` is absent
- Diagram rendering for expression fan-in (multiple source pills → one canonical pill)
- `resolve` hook: icon indicator on canonical pill (minimal; full merge-node rendering
  deferred — see §6.2)

**Out of scope / deferred:**

- Full multi-connector merge-node representation for `resolve` (separate plan)
- `reverseExpression` source field tracking (symmetric problem; deferred)
- `defaultExpression` source tracking
- `source_path` (§1.7, not yet implemented) lineage — follow-on work when source_path lands

---

## § 3 Spec Changes Planned

| File | Section | Change |
|------|---------|--------|
| `specs/field-mapping.md` | §1.3 Field expressions | Add `sources?: string[]` — explicit declaration of connector-side fields read by an expression. Document static analysis fallback behaviour and the `(expression)` placeholder. |
| `specs/playground.md` | §11 | Add §11.11 — array-source entity labels and parentField annotation. Add §11.12 — expression fan-in rendering. Append §11.13 — `resolve` hook indicator. |

No changes to `specs/sync-engine.md`, `specs/connector-sdk.md`, or the demo package.

---

## § 4 Array Expansion in Lineage

### § 4.1 Entity label

For a member with `arrayPath`, `buildChannelLineage` computes the entity label as:

```
`${sourceEntity}.${arrayPath}[]`
```

Example: `sourceEntity: "purchases"`, `arrayPath: "lines"` → label `purchases.lines[]`.

The logical entity name (`member.entity`, e.g. `order_lines`) is available as a tooltip but
not the primary display label, because it is an internal engine naming convention, not a
connector concept.

### § 4.2 ConnectorFieldNode additions

Two new optional fields on `ConnectorFieldNode`:

```ts
/** True when the source field originates from parentFields (parent record scope),
 *  not from the array element itself. */
isParentField?: boolean;
/** True when this node came from an array-expansion member (member.arrayPath is set). */
isArraySource?: boolean;
```

`buildChannelLineage` sets `isArraySource = true` for every `ConnectorFieldNode` emitted
from an array-expansion member, and sets `isParentField = true` for fields whose source
name appears in `member.parentFields` (the keys of the `parentFields` object).

### § 4.3 parentField rendering in the diagram

In an expanded entity pill, `parentField` pills render with a visual annotation:

- Pill label suffix: `↑` (e.g. `purchaseRef ↑`) indicating the value comes from the
  parent record, not the array element.
- The connecting SVG line to the canonical node uses a dash pattern (same as the
  pass-through line style, `.ld-line-passthrough`), visually distinguishing it from
  direct element-field mappings.

---

## § 5 Expression Fields in Lineage

### § 5.1 Explicit `sources` declaration (authoritative path)

Add `sources?: string[]` to:

1. `FieldMappingEntrySchema` in `packages/engine/src/config/schema.ts`:
   ```ts
   sources: z.array(z.string()).optional(),
   ```

2. `FieldMapping` interface in `packages/engine/src/config/loader.ts`:
   ```ts
   /** Connector-side field names read by `expression`.
    *  Declared explicitly for lineage; also used as the static-analysis authority
    *  when present. When absent and expression is set, lineage falls back to regex
    *  extraction. Spec: specs/field-mapping.md §1.3 */
   sources?: string[];
   ```

3. `buildInbound` / `buildOutbound` in `loader.ts` — pass `entry.sources` through to the
   compiled `FieldMapping`.

When `sources` is declared, `buildChannelLineage` emits one `ConnectorFieldNode` per entry
in `sources`, all mapping to the same `canonicalField`. The diagram renders them fanning in
to the canonical pill:

```
LEFT                          CENTRE
webshop / contacts
  firstName ────────────────> fullName
  lastName  ─────────────────^
```

### § 5.2 Static analysis fallback

When `expression` is set but `sources` is absent, attempt to extract field references via
regex on the expression's `.toString()`:

```ts
/\brecord(?:Data)?\s*[\.\[]['"]?(\w+)/g
```

This covers the common patterns:
- `record.firstName`
- `record['primaryEmail']`
- `recordData.phone`

If matches are found, treat them as `sources` but mark the emitted `ConnectorFieldNode`
entries with `isInferredSources: true`. The diagram renders the fan-in with dashed lines
and adds a tooltip: *"source fields inferred from expression text — declare `sources` to
make this explicit."*

If no matches are found (closure references, computed keys, etc.), emit a single node:
- `sourceField: "(expression)"`
- `hasExpression: true`
- No fan-in lines; the pill renders in italic with an amber border
- Tooltip: the raw expression string (`.toString()`)

### § 5.3 ConnectorFieldNode additions for expressions

```ts
/** True when the mapping has an expression and this node represents one source field. */
hasExpression?: boolean;
/** True when sources were inferred by regex, not declared via sources:[]. */
isInferredSources?: boolean;
```

---

## § 6 Expression Resolvers in Lineage

### § 6.1 MVP: canonical pill indicator

When any source member's `FieldMapping` for a canonical field has `resolve` set, the
canonical `CanonicalNode` gains:

```ts
hasResolver?: boolean;
```

`buildChannelLineage` sets this by inspecting all inbound `FieldMapping` entries for the
canonical field across all members.

In the diagram, the canonical pill gains a small `ƒ` suffix badge (e.g. `totalAmount ƒ`).
Tooltip: *"value computed by a custom resolution function across contributing connectors."*

This is purely additive — no topology change, no new lines. It communicates that the
canonical value is not simply last-write-wins or coalesce, without committing to a full
merge-node layout.

### § 6.2 Future: full merge-node representation (deferred)

A complete representation would add an intermediate merge node in the canonical spine, with
labelled arcs from each contributing connector. This requires a new node type in
`ChannelLineage`, layout changes to `lineage-diagram.ts`, and decisions about how to label
the function semantically (e.g. `max`, `concat`, custom). Deferred to a separate plan.

---

## § 7 CanonicalNode additions

```ts
export interface CanonicalNode {
  fieldName: string;
  isIdentity: boolean;
  isAssoc: boolean;
  /** True when at least one source member's FieldMapping for this field has resolve set. */
  hasResolver?: boolean;
}
```

---

## § 8 Implementation Steps

1. **`ESSENCE.md`** — add declarative-mapping → lineage belief ✓ (done in this session)

2. **`specs/field-mapping.md §1.3`** — document `sources?: string[]`, static analysis
   fallback, and `(expression)` placeholder

3. **`specs/playground.md §11`** — append §11.11, §11.12, §11.13

4. **`packages/engine/src/config/schema.ts`** — add `sources` to `FieldMappingEntrySchema`

5. **`packages/engine/src/config/loader.ts`** — add `sources?: string[]` to `FieldMapping`;
   pass through in `buildInbound` / `buildOutbound`

6. **`playground/src/ui/lineage-model.ts`** — extend `ConnectorFieldNode` and
   `CanonicalNode`; update `buildChannelLineage`:
   - Array-source entity label
   - `isArraySource` / `isParentField` flags
   - Expression fan-in (sources + static analysis)
   - `hasResolver` on canonical nodes

7. **`playground/src/ui/lineage-diagram.ts`** — update rendering:
   - Array-source entity header label uses `purchases.lines[]` form
   - `parentField` pills: `↑` suffix + dashed line
   - Expression fan-in: multiple dashed source pills → canonical node
   - `(expression)` placeholder pill styling
   - `ƒ` badge on canonical pills with `hasResolver`

8. **`bun run tsc --noEmit && bun test`** — no regressions

9. **`CHANGELOG.md`** — add entry under `### Added`

---

## § 9 Open Questions

**Q1: Should `sources` be validated against the member's declared `fields`?**

At config load time, each source field listed in `sources` could be cross-checked against the
same connector's `fields` list. This would catch typos early. Complication: the `fields` list
is declared by the connector, not by the mapping author; in YAML the authorship overlap means
both are present, but in the TypeScript API they may come from different sources.

Decision: warn (not error) at load time if a declared `sources` field name is not in the
inbound `fields` list. Strict validation is not mandatory pre-release.

**Q2: How to handle `reverseExpression` sources in outbound lineage?**

`reverseExpression` synthesises connector-side values from the canonical record. The same
`sources` approach could apply, but the direction is inverted (canonical → connector-side
fields). Deferred: the outbound column is less commonly inspected; add when `reverseExpression`
sees broader use.

**Q3: Expression source extraction reliability**

The regex approach is acknowledged as heuristic. The long-term answer is to require authors
to declare `sources` when using `expression`. A lint rule or schema warning for "expression
without sources" would encourage this. Not in scope for this plan.
