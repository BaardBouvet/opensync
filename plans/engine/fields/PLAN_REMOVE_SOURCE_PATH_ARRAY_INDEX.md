# PLAN: Remove Array-Index Support from `source_path`

**Status:** proposed  
**Date:** 2026-04-11  
**Effort:** XS  
**Domain:** Engine — field mapping, config  
**Scope:** `specs/field-mapping.md`, `specs/config.md`, `packages/engine/src/config/schema.ts`, `packages/engine/src/core/mapping.ts`, `packages/engine/src/core/mapping.test.ts`  
**Depends on:** PLAN_SOURCE_PATH.md (complete)  

---

## § 1 Problem

`source_path` was designed for **bidirectional** nested-object access: dotted-path extraction
on the forward pass, shared-prefix reconstruction on the reverse pass. That is its core value —
`address.street` and `address.city` on the same mapping group produce `{ address: { street, city } }`
on write-back with no connector changes and no paired `reverse_expression`.

The `[N]` array-index token was added to support positional extraction
(`metadata.tags[0]`, `lines[0].product_id`), but it can never be bidirectional: there is no
safe write-back to a positional index in an existing array. The Zod schema therefore restricts
`[N]` to `forward_only` fields only, raising a validation error otherwise.

This makes `[N]` a special case that cuts against the grain of the feature:

- It forces `direction: forward_only` on any entry using it, without which config load fails.
  The restriction is invisible in the config until you hit the error.
- It is fragile: array reordering in the source silently changes which value is extracted.
- It has no reverse path. The entire value of `source_path` over `expression` is the
  paired write-back; `[N]` entries opt out of that entirely.
- `expression` already handles this case cleanly:

  ```yaml
  - expression: "record.lines?.[0]?.product_id"
    target: firstProductId
  ```

  This is forward-only by definition (no `reverse_expression` → no write). It is explicit,
  composable, and does not require a special mode restriction.

Having two syntaxes for the same forward-only positional extraction — one awkward
(`source_path` with `[N]`, forced `forward_only`) and one natural (`expression`) — is excess
surface area. It should be removed before the first public release while there are no external
callers to migrate.

---

## § 2 Design

Remove `[N]` from the path syntax understood by `resolveSourcePath` and from the config
validation logic. Dotted-path support (`address.street`) is unaffected. String-key bracket
support (`['key']`) for keys containing literal dots or brackets is also unaffected — it is
an escape form for object property names, not array access.

### § 2.1 Config layer

Remove the `.refine()` call in `FieldMappingEntrySchemaBase` that restricts `[N]` tokens to
`forward_only` fields (lines ~194–201 in `schema.ts`). Update the JSDoc comment on
`source_path: z.string().optional()` to remove all mention of array-index tokens.

### § 2.2 `resolveSourcePath` simplification

`resolveSourcePath` currently does two things after splitting on `.`:
1. Traverses object keys (kept).
2. After each segment, checks for and parses trailing `[N]` bracket tokens and indexes into
   arrays (removed).

After removal, `resolveSourcePath` only walks dot-separated object keys. The inner
`/^\[(\d+)\]/` tokeniser loop and all `Array.isArray` guards in that branch are deleted.
`bracketIdx` detection can be removed entirely (since `['key']` string-key bracket is not
part of the simplified syntax — see note below).

**Note on string-key brackets:** The original plan described `['key']` as an escape form
for property names containing dots or brackets. In practice this adds complexity with
minimal benefit — YAML keys and connector field names almost never contain those characters.
Remove `['key']` bracket support along with `[N]` and simplify `resolveSourcePath` to
purely dot-separated key traversal. If a canonical field name or source field name contains
a dot, that is handled at the connector layer rather than in paths.

`assignNestedPath` (reverse pass) splits on `.` and creates nested object structure — it
never supported `[N]` write-back. Remove the comment noting that restriction (no longer
relevant) and simplify the docstring.

### § 2.3 Tests

Remove **SP3** (`describe("SP3: source_path array index inbound (forward_only)")`), which
contains two tests specific to `[N]` behaviour.

In the `resolveSourcePath` unit test block, remove:
- `"array index"` (tests `tags[1]`)
- `"nested then array index"` (tests `meta.tags[0]`)
- `"out of bounds index returns undefined"` (tests `tags[99]`)

**SP10** (`forward_only source_path field skipped on outbound pass`) uses
`sourcePath: "meta.score"` — a plain dotted path. It stays unchanged.

All other SP test cases (SP1–SP2, SP4–SP9) use dotted paths only and are unaffected.

### § 2.4 Spec changes

See §4 below.

---

## § 3 Migration for current users

Anyone using `source_path` with `[N]` replaces it with `expression`:

```yaml
# Before
- source_path: metadata.tags[0]
  target: primaryTag
  direction: forward_only

# After
- expression: "record.metadata?.tags?.[0]"
  target: primaryTag
```

The behaviour is identical: forward-only extraction, produces no output key when the path
is absent. If a `default` was also set, it continues to apply after `expression` when the
returned value is `undefined` — no change needed there.

---

## § 4 Spec changes planned

| File | Section | Change |
|------|---------|--------|
| `specs/field-mapping.md` | §1.7 | Remove `[N]` from path syntax list; remove `metadata.tags[0]` example line from code block; remove "Array-index write-back restriction" paragraph; add one-line note directing positional extraction to `expression` |
| `specs/field-mapping.md` | Status table | Update `source_path extraction` row to reflect `[N]` removal |
| `specs/config.md` | FieldMappingEntry table | Update `source_path` row description to remove `[N]` mention |
