# REPORT: Expression-Based `array_path` — Decision Not to Support

**Status:** reference — decided against  
**Date:** 2026-04-07  

Records the analysis and rationale for rejecting an expression-based variant of `array_path`
in nested array expansion (specs/field-mapping.md §3.2).

---

## The Proposal

Replace the static dotted-path string in `array_path` with an evaluated expression that
returns the array at runtime, e.g.:

```yaml
# hypothetical — NOT implemented
array_expr: "record.type === 'order' ? record.lines : record.details"
```

The motivation: polymorphic source records where the embedded array lives at a different field
path depending on a discriminator on the parent record.

---

## Why It Was Rejected

### 1. Canonical ID stability is broken

The child canonical ID formula is (specs/field-mapping.md §3.2):

```
SHA-256("opensync:array:{parentCanonicalId}:{array_path}[{elementKeyValue}]")
```

`array_path` is encoded as a literal string. An expression does not have a stable string
representation that is safe to embed here. Two options are both wrong:

- **Encode the expression source text** — if the expression is ever reformatted or reworded
  without changing its semantics, all existing child canonical IDs change, causing every
  element to be treated as a new insert.

- **Encode the runtime-evaluated path** — requires re-evaluating the expression every time
  the ID is needed, including during collapse, reverse-pass, and `array_parent_map` lookups.
  The result must be stable per record across runs, which cannot be guaranteed for an
  arbitrary expression.

OpenSync's core contract is no data loss and no silent conflicts. Both options undermine that.

### 2. Collapse (reverse pass) needs a structural address

Writing back to the source (specs/field-mapping.md §3.4 collapse) requires knowing where to
patch the parent record in the source system. A dotted path is a structural address that can
be navigated deterministically. An expression that returns an array is not — there is no
general way to invert an arbitrary expression to obtain a writable path.

### 3. Static config guarantees vanish

`expansionChain` is built and validated at config-load time. If any level uses an expression,
chain resolution becomes runtime-only, removing the static validation guarantee (connector
mismatch checks, cycle detection, entity pre-flight checks). Errors would surface at sync
time instead of startup.

### 4. Security surface expands

Array-expansion expressions already run through `new Function` (see the `filter` and
`reverse_filter` implementation note in specs/field-mapping.md §3.2). Extending that surface
to structural path resolution — a deeper engine invariant — is a larger risk.

---

## The Polymorphic Case Has Clean Alternatives

The main scenario driving the proposal (different array path per record type) is fully covered
by existing primitives:

**Option A — Normalize in the connector.**  
Connectors are responsible for the shape of records they emit. A connector for a polymorphic
API can always expose a uniform field name (e.g. always `record.items`) regardless of what
the upstream API calls it internally. This is exactly where data-shape logic belongs per
the architecture constitution: connectors are dumb pipes, but "dumb pipe" includes shaping
the wire format into a consistent schema before handing records to the engine.

**Option B — Multiple expansion members with `record_filter`.**  
Two child mapping entries, each with a static `array_path` and a `record_filter` that gates
on the discriminator field:

```yaml
- parent: erp_orders
  array_path: lines
  record_filter: "record.type === 'standard'"
  element_key: line_no
  fields: [...]

- parent: erp_orders
  array_path: shipments
  record_filter: "record.type === 'split'"
  element_key: shipment_id
  fields: [...]
```

This keeps canonical IDs fully stable, collapse works on a known structural address, and the
config is validated entirely at startup.

---

## Decision

`array_path` stays a static dotted-path string. No expression variant will be introduced.

When a source API uses polymorphic embedding, the correct fix is in the connector
(Option A). When the same source entity genuinely expands into disjoint element types,
use multiple expansion members with `record_filter` (Option B).
