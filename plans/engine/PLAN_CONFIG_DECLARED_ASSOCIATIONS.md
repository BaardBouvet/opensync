# PLAN: Config-Declared Association Synthesis

**Status:** proposed  
**Date:** 2026-04-08  
**Effort:** S  
**Domain:** packages/engine  
**Scope:** Config synthesis of `Association` objects for root records and array elements  
**Spec:** specs/associations.md, specs/field-mapping.md §3.2, specs/config.md  
**Depends on:** PLAN_DEFERRED_ASSOCIATIONS.md (complete), PLAN_PREDICATE_MAPPING.md (complete)  
**Related:** PLAN_ARRAY_ELEMENT_ASSOCIATIONS.md (connector-supplied element associations via `ElementRecord`)

---

## 1. Problem

The engine's association pipeline (identity remapping, deferred edges, predicate mapping,
write-side filtering) is fully functional, but it only fires when an `Association` is
present on the record reaching `_processRecords`. Two situations leave that array empty
even when the connector data clearly carries FK references:

**Root records — connector omits `ReadRecord.associations`.**  
Most connectors return raw API payloads and never populate `associations`. They expose the
FK field as a plain `data` value (e.g. `data.companyId = 'hs_456'`), leaving the engine
with no way to resolve it cross-system. A connector author currently must add code to
populate `associations` explicitly; there is no declarative alternative.

**Array elements — no per-element association API exists yet.**  
After array expansion, child records have no associations at all unless the connector uses
`ElementRecord` (see PLAN_ARRAY_ELEMENT_ASSOCIATIONS.md). Most connectors won't — they
return plain arrays. Config synthesis is the practical path for the majority of cases.

**The lazy-declaration advantage.** Config synthesis requires zero connector change and can
be added at any time after a connector is wired up — even retroactively on connectors that
are already deployed. This makes it the common path for bootstrapping association support
on existing connectors.

---

## 2. What Does Not Change

- `ReadRecord`, `Association`, `ElementRecord`, and all SDK types are unchanged.
- All downstream handling once an `Association` is on a processed record is unchanged:
  deferred edges (§6.1), predicate mapping (§7.5), identity remapping (§7.2), and
  `associationSchema` write-side filtering all fire identically regardless of whether the
  association was connector-supplied or config-synthesized.
- Connectors that do populate `ReadRecord.associations` are unaffected — config synthesis
  merges with connector-supplied associations; it does not replace them.

---

## 3. Proposed Design

### 3.1 Shared declaration type: `AssociationDeclarationEntry`

Both `record_associations` (root) and `element_associations` (nested) use the same schema
type, exported from the engine config layer:

```typescript
// packages/engine/src/config/schema.ts
export const AssociationDeclarationSchema = z.object({
  /** Field key whose value is the referenced ID.  Also becomes Association.predicate.
   *  Must be the connector's own field name (same namespace as data keys). */
  predicate: z.string().min(1),

  /** Entity name the reference points to.  Must be the connector's own entity name
   *  (specs/associations.md §7.1). */
  targetEntity: z.string().min(1),

  /** Optional dotted path within the record/element to read the ID from
   *  (e.g. "company.id" reads record.data.company.id).
   *  When absent, reads data[predicate] directly. */
  source_path: z.string().optional(),
});

export type AssociationDeclaration = z.infer<typeof AssociationDeclarationSchema>;
```

### 3.2 Root-record config key: `record_associations`

A new optional key on `MappingEntrySchema`. Applies to standard (non-expansion) mapping
entries. For each record ingested for this connector/entity the engine reads the listed
fields and synthesizes `Association` objects.

```typescript
// MappingEntrySchema gains:
record_associations: z.array(AssociationDeclarationSchema).optional(),
```

**YAML example — CRM contacts that reference companies:**

```yaml
- connector: crm
  channel: contacts
  entity: contacts
  fields:
    - source: name
      target: name
    - source: email
      target: email
  record_associations:
    - predicate: companyId       # data.companyId holds the referenced ID
      targetEntity: company      # connector's own entity name
```

For a record `{ id: 'c1', data: { name: 'Alice', companyId: 'hs_456' } }` the engine
synthesizes `{ predicate: 'companyId', targetEntity: 'company', targetId: 'hs_456' }` and
merges it into the record's `associations` before `_processRecords`.

**With `source_path`** — when the FK is nested inside the payload:

```yaml
record_associations:
  - predicate: orgRef             # logical predicate name
    targetEntity: organization
    source_path: org.id           # reads data.org.id
```

### 3.3 Element-level config key: `element_associations`

A new optional key on `MappingEntrySchema`. Valid **only on array expansion members**
(entries with `parent:` set). Applies per element after the array is expanded. Same schema
type as `record_associations`.

```typescript
// MappingEntrySchema gains:
element_associations: z.array(AssociationDeclarationSchema).optional(),
```

**YAML example — ERP order lines referencing products:**

```yaml
- channel: order-lines
  parent: erp_orders
  array_path: lines
  element_key: line_no
  fields:
    - source: line_no
      target: lineNumber
    - source: product_id
      target: productId
  element_associations:
    - predicate: product_id
      targetEntity: products
```

For element `{ line_no: 1, product_id: 'prod-123', qty: 2 }` the engine synthesizes
`{ predicate: 'product_id', targetEntity: 'products', targetId: 'prod-123' }`.

### 3.4 Synthesis algorithm (shared for both contexts)

```typescript
// Spec: specs/associations.md §8 — config-declared association synthesis
function synthesizeAssociations(
  source: Record<string, unknown>,   // record.data (root) or rawElement (expansion)
  declarations: AssociationDeclaration[],
): Association[] {
  const result: Association[] = [];
  for (const decl of declarations) {
    const rawId = decl.sourcePath
      ? getByPath(source, decl.sourcePath)   // reuses existing dotted-path helper
      : source[decl.predicate];
    if (rawId != null && rawId !== '') {
      result.push({
        predicate: decl.predicate,
        targetEntity: decl.targetEntity,
        targetId: String(rawId),
      });
    }
  }
  return result;
}
```

Null, `undefined`, and empty-string values are silently skipped — mirrors the convention
that connectors omit associations for null FKs.

### 3.5 Merge with connector-supplied associations

Config-synthesized associations are **appended after** any connector-supplied associations.
The combined list is deduplicated on `(predicate, targetEntity, targetId)` — connector-
supplied entries take precedence on exact duplicates ("connector knows best").

```typescript
// Root record (ingest path, before _processRecords):
const configAssocs = synthesizeAssociations(record.data, member.recordAssociations ?? []);
record.associations = deduplicateAssociations([
  ...(record.associations ?? []),
  ...configAssocs,
]);

// Array element (expansion path, after ElementRecord extraction):
const configAssocs = synthesizeAssociations(rawElement, member.elementAssociations ?? []);
childRecord.associations = deduplicateAssociations([
  ...connectorAssociations,   // from ElementRecord, or [] for plain objects
  ...configAssocs,
]);
```

`deduplicateAssociations` is a small pure helper (same contract as the one used in the
association sentinel serialiser).

---

## 4. Validation Rules (config load time)

| Scope | Rule | Error |
|-------|------|-------|
| Both | `predicate` is empty string | Reject |
| Both | `targetEntity` is empty string | Reject |
| Both | Same `predicate` appears twice in the same list | Reject: duplicate predicate |
| Both | `predicate` also appears in `assocMappings` with a different `source` spelling | Warning: confirm spelling matches the data field name |
| `element_associations` | `parent` key is absent on the same entry | Reject: `element_associations` requires `parent` and `array_path` |
| `record_associations` | Entry has `parent` set (is an expansion member) | Reject: use `element_associations` on expansion members |

---

## 5. Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/associations.md` | New §8 | Add "Config-declared association synthesis" section: documents `record_associations` (root), `element_associations` (array elements), shared `AssociationDeclaration` shape, synthesis algorithm, null-skip rule, and merge-with-connector-supplied behaviour. |
| `specs/field-mapping.md` | §3.2 | Add `element_associations` to the config-key table with type, description, and example. Add forward-pass note: config synthesis runs after `ElementRecord` extraction; results merged. |
| `specs/config.md` | `mappings/*.yaml` reference | Add `record_associations` and `element_associations` key documentation with examples and `source_path` sub-key. |

---

## 6. Implementation Sketch

1. **`packages/engine/src/config/schema.ts`** — add `AssociationDeclarationSchema` type.
   Add `record_associations` to `MappingEntrySchema`. Add `element_associations` to
   `MappingEntrySchema` (validated to require `parent`).

2. **`packages/engine/src/config/loader.ts`** — compile `record_associations` and
   `element_associations` into `ChannelMember`. Compile optional `source_path` values into
   path-segment arrays at load time (same pattern as `array_path`).

3. **Root ingest path** — just before calling `_processRecords` for a non-expansion member,
   call `synthesizeAssociations(record.data, member.recordAssociations)` and merge into
   `record.associations`.

4. **Array expansion path** — after `ElementRecord` extraction (PLAN_ARRAY_ELEMENT_ASSOCIATIONS),
   call `synthesizeAssociations(rawElement, member.elementAssociations)` and merge.

5. **`deduplicateAssociations` helper** — pure function; extract from the association
   sentinel serialiser if it already exists there, or add as a new utility.

6. **Config validation** — enforce the rules in §4.

7. **Tests** — new test file `packages/engine/src/config-declared-associations.test.ts`:

   | ID | What it tests |
   |----|---------------|
   | CDA1 | `record_associations`: engine synthesizes association from root record field |
   | CDA2 | `record_associations` with `source_path`: reads nested field |
   | CDA3 | `record_associations`: null FK value → association omitted; record still processed |
   | CDA4 | `record_associations` merges with connector-supplied `ReadRecord.associations`; duplicate deduplicated, connector-supplied takes precedence |
   | CDA5 | `element_associations`: engine synthesizes association from expanded element field |
   | CDA6 | `element_associations` with `source_path`: reads nested field inside element |
   | CDA7 | `element_associations`: null FK in one element → omitted; other elements unaffected |
   | CDA8 | Deferred edge (root): targetEntity not yet in identity_map → deferred row; resolved next cycle |
   | CDA9 | Deferred edge (element): same as CDA8 but via array expansion |
   | CDA10 | Predicate mapping: config-synthesized predicate translated through `assocMappings` |
   | CDA11 | Validation: `element_associations` without `parent` → throws |
   | CDA12 | Validation: duplicate `predicate` in same list → throws |

---

## 7. Out of Scope

- **`associationSchema`-driven auto-synthesis** — having the engine synthesize associations
  purely from the entity's declared `associationSchema` without any config key. That blurs
  schema-as-metadata with schema-as-behaviour and is deferred.

- **Write-back** — synthesized associations arrive in `UpdateRecord.associations` at the
  target; the connector injects them into the appropriate field. No reverse-pass changes.

- **Multi-level element associations** — `element_associations` applies at each expansion
  level independently; multi-level canonical ID threading is a follow-on.
