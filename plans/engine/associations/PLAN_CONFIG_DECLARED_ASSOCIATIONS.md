# PLAN: Field-Level Association Annotations

**Status:** complete  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** packages/engine  
**Scope:** `entity` and `entity_connector` keys on `FieldMappingEntry`; replaces top-level `associations` list  
**Spec:** specs/associations.md, specs/field-mapping.md, specs/config.md  
**Depends on:** PLAN_DEFERRED_ASSOCIATIONS.md (complete), PLAN_PREDICATE_MAPPING.md (complete), PLAN_SCHEMA_REF_AUTOSYNTH.md (complete)  
**Related:** plans/connectors/PLAN_SCHEMA_REF_AUTOSYNTH.md (the connector-code equivalent)

---

## 1. Problem

The engine extracts FK associations from `ReadRecord.data` during ingest via
`_extractRefsFromData`, which has two passes:

- **Pass 1** — explicit `Ref` objects (`{ '@id': …, '@entity'?: … }`) already in `data`.
- **Pass 2** — schema auto-synthesis: plain strings where `EntityDefinition.schema[field].entity`
  is declared. The engine wraps the string internally without any connector code change.
  (Spec: `plans/connectors/PLAN_SCHEMA_REF_AUTOSYNTH.md`)

Pass 2 is the recommended light path for SaaS connectors — declare `entity` on a
`FieldDescriptor` in `getEntities()` and return raw API payloads unchanged.

**The gap**: many connectors don't implement `getEntities()` at all, or implement it without
annotating FK fields with `entity`. In both cases Pass 2 finds nothing to synthesize, and the
cross-system FK remapping pipeline never fires — even though the connector's `data` payload
clearly contains a FK string.

Array expansion members face the same issue. After expansion, child records are assembled
from raw element objects with no `EntityDefinition` behind them, so Pass 2 never fires for
their fields either.

**The redundancy problem.** Before this plan the workaround required three separate
declarations for one FK field. For example, a product reference on an order line needed:

```yaml
fields:
  - source: product_id
    target: productId          # 1. field copy
associations:
  - source: product_id
    target: productRef         # 2. predicate routing
element_associations:
  - predicate: product_id
    targetEntity: products     # 3. entity annotation
```

Three declarations that each describe one piece of the same relationship, with the field
name `product_id` repeated in all three.

**The cross-connector reference gap.** Some integrations use a custom field to carry an
external ID from a different system (e.g. a CRM connector that stores a third-party HR
system's employee ID in a custom field). None of the existing paths support scoping a FK
lookup to a specific foreign connector's identity namespace — they always resolve against
the current channel's own connector namespace.

---

## 2. What Does Not Change

- `ReadRecord`, `Ref`, `Association`, and all SDK types are unchanged.
- `_extractRefsFromData` Pass 1 (explicit Refs) and Pass 2 (connector schema) are unchanged.
- All downstream handling once an `Association` is extracted is unchanged:
  `_filterInboundAssociations`, `_remapAssociations`, deferred edges (spec §6.1), predicate
  mapping (spec §7.5), identity remapping (spec §7.2), and FK write-side filtering (spec §8.1)
  all fire identically regardless of whether the association came from Pass 1, Pass 2, or
  the new Pass 3.
- Connectors that already declare `entity` on their `FieldDescriptor` are unaffected — Pass 2
  handles those records; Pass 3 skips fields already handled.

---

## 3. Proposed Design

### 3.1 Two new keys on `FieldMappingEntry`

```typescript
// packages/engine/src/config/schema.ts — added to FieldMappingEntrySchemaBase
entity: z.string().optional(),
entity_connector: z.string().optional(),
```

| Key | Required | Meaning |
|-----|----------|---------|
| `entity` | — | The connector's own entity name that this field references. Triggers Pass 3. When set, the field's value type is treated as a reference — routed through the identity map rather than copied as a scalar. Must be the connector's own entity name (spec §7.1). |
| `entity_connector` | optional | Scope the identity lookup to a specific connector's namespace. Used when the field carries an external ID from a different connector (cross-connector reference). When absent, resolved within the current connector's namespace. |

Both are ignored if `entity` is absent. `entity_connector` is meaningless without `entity`.

No separate routing key (`association`) is needed. The field's `target` already IS the
canonical name for this FK — the same way scalar field routing works. Two connectors that
both map their FK field to canonical `companyId` (each with their own `source` name and
`entity` value) are automatically linked by that shared `target`. The association is routed
through the identity map using `target` as the predicate, not a separate alias.

### 3.2 Consolidated YAML — comparison

**Before (three separate declarations):**

```yaml
- connector: erp
  channel: order-lines
  parent: erp_orders
  array_path: lines
  element_key: line_no
  fields:
    - source: product_id
      target: productId
  associations:
    - source: product_id
      target: productRef
  element_associations:
    - predicate: product_id
      targetEntity: products
```

**After (one declaration):**

```yaml
- connector: erp
  channel: order-lines
  parent: erp_orders
  array_path: lines
  element_key: line_no
  fields:
    - source: product_id
      target: productId
      entity: products             # declares this field as a FK reference; target is the routing key
```

The same consolidation works identically on flat (non-expansion) members. Two connectors
in the same channel link their FK fields by using the same `target` name:

```yaml
- connector: crm
  channel: contacts
  entity: contacts
  fields:
    - source: companyId
      target: companyId            # canonical name = routing key
      entity: company              # crm's own entity name

- connector: erp
  channel: contacts
  entity: employees
  fields:
    - source: orgId
      target: companyId            # same canonical name → same FK edge
      entity: accounts             # erp's own entity name for the same concept
```

### 3.3 Cross-connector reference via `entity_connector`

When a field carries an external ID from a different connector's namespace, declare
`entity_connector` to scope the identity lookup:

```yaml
- connector: crm
  channel: contacts
  entity: contacts
  fields:
    - source: hr_employee_id       # custom CRM field storing the HR system's employee ID
      target: hrEmployeeId
      entity: employees            # entity name as used in the hr connector
      entity_connector: hr         # look up the identity in hr's namespace, not crm's
      association: employeeRef
```

Without `entity_connector` the engine would try to resolve `hr_employee_id` against the
CRM connector's own identity map, find nothing, and defer. With it, the lookup is correctly
scoped to the `hr` connector, so the canonical UUID is resolved immediately.

`entity_connector` must name a connector that is a member of any channel in the config.
A config-load-time warning is emitted if it names an unknown connector.

### 3.4 Removal of the top-level `associations` list

The top-level `associations: [{ source, target }]` key on `MappingEntrySchema` is removed.
Its function (mapping connector-local predicate names to canonical routing keys) is now
expressed implicitly through field entries that have `entity` set — the field's `target` is
the canonical routing key and the field's `source` (or `target` when `source` is absent) is
the connector-local predicate name.

At config parse time, `ChannelMember.assocMappings` is derived automatically:

```typescript
assocMappings = fields
  .filter(f => f.entity)
  .map(f => ({
    source: f.source ?? f.target,   // connector-local field name
    target: f.target,               // canonical routing key = canonical field name
  }));
```

Existing configs that still have a top-level `associations` key emit a config-load-time
deprecation warning until removed. Because this is pre-1.0 there is no compatibility shim —
the old key is parsed only for the warning and otherwise ignored.

### 3.5 Pass 3 in `_extractRefsFromData`

`_extractRefsFromData` gains an optional third argument carrying compiled field annotations.
Pass 3 runs after Pass 1 and Pass 2, guarded by `handledFields`.

```typescript
// Spec: specs/associations.md §9 — config-declared annotation pass
private _extractRefsFromData(
  data: Record<string, unknown>,
  entityDef: EntityDefinition | undefined,
  fieldAnnotations?: CompiledFieldAnnotation[],  // ← new optional argument
): Association[] {
  // Pass 1: existing Ref objects (unchanged)
  // Pass 2: schema auto-synthesis from FieldDescriptor.entity (unchanged)

  // Pass 3: field-level config annotations
  if (fieldAnnotations?.length) {
    for (const ann of fieldAnnotations) {
      if (handledFields.has(ann.sourceField)) continue;
      const rawId = ann.sourcePath
        ? resolveSourcePath(data, ann.sourcePath)
        : data[ann.sourceField];
      if (!rawId || typeof rawId !== 'string') continue;
      result.push({
        predicate: ann.sourceField,
        targetEntity: ann.entity,
        targetId: rawId,
        ...(ann.entityConnector ? { entityConnector: ann.entityConnector } : {}),
      });
      handledFields.add(ann.sourceField);
    }
  }
}
```

`CompiledFieldAnnotation` is compiled at config load time from `FieldMappingEntry` entries
that have `entity` set:

```typescript
interface CompiledFieldAnnotation {
  sourceField: string;        // f.source ?? f.target
  sourcePath?: string;        // f.source_path, if set
  entity: string;             // f.entity
  entityConnector?: string;   // f.entity_connector
}
```

`sourcePath` reuses `resolveSourcePath` from `core/mapping.ts` — the same dotted-path
helper used by field mapping `source_path` (spec: specs/field-mapping.md §1.7).

Null, `undefined`, non-string, and empty-string values are silently skipped — consistent
with Pass 2 and the convention that connectors omit null FK fields.

### 3.6 Call-site changes

All `_extractRefsFromData` call sites pass `sourceMember.fieldAnnotations` as the third
argument. The same annotations apply for flat members and array expansion members — no
conditional logic needed at the call site.

---

## 4. Validation Rules (config load time)

| Key | Rule | Error / Warning |
|-----|------|-----------------|
| `entity` | Non-empty string | Reject empty |
| `entity` | Names an entity registered for this connector in any channel | Warn if not found (same pre-flight as `FieldDescriptor.entity`) |
| `entity_connector` | Present without `entity` | Reject |
| `entity_connector` | Names an unknown connector in the config | Warn |
| top-level `associations` | Present | Deprecation warning: migrate to field-level `entity` (and `entity_connector` if needed) |

---

## 5. Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/associations.md` | New §9 | "Field-level association annotations": documents `entity` and `entity_connector` on `FieldMappingEntry`; Pass 3 algorithm; `source_path` interaction; `entity_connector` scoped lookup; routing via `target` as canonical name; removal of top-level `associations`. |
| `specs/field-mapping.md` | §1 | Add `entity` and `entity_connector` to the field mapping key reference table. Note that `entity` is the YAML equivalent of `FieldDescriptor.entity` in `getEntities()`. Explain that `target` doubles as the canonical routing key when `entity` is set. |
| `specs/config.md` | `mappings/*.yaml` reference | Replace `associations` examples with field-level `entity` examples. Add `entity_connector` example. Explain the shared-`target` convention for linking FK fields across connectors. Mark top-level `associations` as deprecated. |

---

## 6. Implementation Sketch

1. **`packages/engine/src/config/schema.ts`**
   - Add `entity` and `entity_connector` to `FieldMappingEntrySchemaBase`.
   - Add `refine` rule: `entity_connector` requires `entity`.
   - Emit deprecation log when top-level `associations` is present (parse but ignore).

2. **`packages/engine/src/config/loader.ts`**
   - Add `fieldAnnotations?: CompiledFieldAnnotation[]` to both `ChannelMember` and
     `ExpansionChainLevel`. Flat (non-expansion) members populate `ChannelMember.fieldAnnotations`.
     Each level of a multi-level expansion chain populates `ExpansionChainLevel.fieldAnnotations`
     from the `element_fields` entries at that depth that have `entity` set.
   - Derive `assocMappings` from the same field entries rather than from the top-level
     `associations` key.

3. **`_extractRefsFromData`** — add optional `fieldAnnotations` third argument; implement
   Pass 3. The `entityConnector` field on the synthesized `Association` object is passed
   through to the remap step.

4. **`_remapAssociations`** — when `assoc.entityConnector` is set, scope the
   `identity_map` lookup to `(assoc.entityConnector, assoc.targetId)` rather than
   `(member.connectorId, assoc.targetId)`.

5. **All `_extractRefsFromData` call sites** — pass `sourceMember.fieldAnnotations` for
   flat members; pass `chainLevel.fieldAnnotations` for each level during multi-level
   expansion.

6. **Config validation warnings** — entity not found in any channel; unknown `entity_connector`.

7. **Tests** — new test file `packages/engine/src/field-association-annotations.test.ts`:

   | ID | What it tests |
   |----|---------------|
   | FAA1 | `entity` on flat member: engine extracts association from plain-string FK field |
   | FAA2 | `entity` on expansion member (single-level): extracts association from expanded element field |
   | FAA2b | `entity` on expansion member (multi-level): extracts association at each depth level |
   | FAA3 | `source_path` on field with `entity`: reads nested dotted path |
   | FAA4 | Null/missing FK value → association omitted; record still processed |
   | FAA5 | Field already has explicit `Ref` (Pass 1) → Pass 3 skipped; no duplicate |
   | FAA6 | Field declared in connector schema with `entity` (Pass 2) → Pass 3 skipped |
   | FAA7 | `entity_connector` → identity lookup scoped to named connector; resolves correctly |
   | FAA8 | `entity_connector` without the other connector present → deferred row written |
   | FAA9 | Deferred edge: targetEntity not yet in identity_map → deferred; resolved next cycle |
   | FAA10 | Predicate mapping routed end-to-end via shared `target` name across two connectors |
   | FAA11 | Top-level `associations` key present → deprecation warning emitted; field ignored |
   | FAA12 | Validation: `entity_connector` without `entity` → config load error |

---

## 7. Out of Scope

- **Removing `makeRefs()` from connectors that call it** — those connectors continue to
  work via Pass 1. Migrating them to the field-level config is a connector-by-connector
  decision.

- **Write-back** — remapped association IDs arrive in `InsertRecord.data` /
  `UpdateRecord.data` as plain strings (spec §7.3). No reverse-pass changes.
