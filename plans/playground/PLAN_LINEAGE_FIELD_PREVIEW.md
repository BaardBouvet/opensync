# PLAN: Lineage Diagram — Entity Field Preview

**Status:** complete  
**Date:** 2026-04-09  
**Effort:** S  
**Domain:** playground  
**Scope:** `packages/sdk/src/types.ts`, `specs/connector-sdk.md`,
  `playground/src/lib/systems.ts`, `playground/src/inmemory.ts`,
  `playground/src/ui/lineage-diagram.ts`, `playground/src/ui/systems-pane.ts`,
  `playground/index.html`, `specs/playground.md`  
**Spec:** specs/playground.md §11  
**Depends on:** PLAN_LINEAGE_DESIGN_MODE.md (complete)  

---

## § 1 Problem

The lineage diagram shows which fields are *mapped*, but it gives no indication of which
fields are *available* to map. When designing a channel config, the user must cross-reference
the YAML with external API docs or connector source code to know what field names exist.

Two gaps:

1. **Pool pills are opaque.** An unassigned entity pill (`crm / contacts`) is a static label.
   The user cannot discover what fields that entity exposes without leaving the playground.

2. **Expanded mapped entity pills are incomplete.** When you expand `crm / contacts` in a
   channel swimlane, you see only the fields listed in `mappings:`. Unmapped fields — those
   present in the connector's data but not yet in the config — are invisible.

---

## § 2 Goal

- Pool pills expand/collapse to show all available field names for that entity.
- Mapped entity groups, when expanded, append a dim section showing unmapped fields below
  the mapped ones.
- No mapping logic or line drawing changes for the mapped fields.
- No lines are drawn for unmapped fields; they are display-only hints.

---

## § 3 Data source — explicit schema

The approach is to define the schema **explicitly** rather than infer it from seed data,
so each field carries rich metadata (description, type, example) right at the declaration
site.

### § 3.1 `FieldDescriptor.example` — SDK change

`packages/sdk/src/types.ts` gains one new optional field on `FieldDescriptor`:

```ts
/** Illustrative example value for this field. Used by UIs and agents to convey what
 *  the field typically contains without needing to read live data.
 *  Any serialisable JSON value; rendered as a string in display contexts. */
example?: unknown;
```

This is display-only metadata — the engine ignores it. No engine behaviour changes.
`specs/connector-sdk.md §FieldDescriptor` gains a corresponding entry.

### § 3.2 `EntitySchemaMap` — full `FieldDescriptor` annotations

`playground/src/lib/systems.ts` currently defines:

```ts
export type EntitySchemaMap = Record<string, Record<string, Record<string, { entity: string }>>>;
// connectorId → entityName → fieldName → { entity }
```

This changes to use `FieldDescriptor` directly:

```ts
import type { FieldDescriptor } from "@opensync/sdk";
export type EntitySchemaMap = Record<string, Record<string, Record<string, FieldDescriptor>>>;
// connectorId → entityName → fieldName → FieldDescriptor
```

`FIXED_SCHEMAS` then expands to cover **all fields** across the fixed seed, with
`description`, `type`, and `example` on each:

```ts
export const FIXED_SCHEMAS: EntitySchemaMap = {
  crm: {
    companies: {
      name:   { type: "string", description: "Company display name", example: "Acme Corp" },
      domain: { type: "string", description: "Primary web domain", example: "acme.com" },
    },
    contacts: {
      name:             { type: "string", description: "Full name", example: "Alice Liddell" },
      email:            { type: "string", description: "Work email address", example: "alice@example.com" },
      primaryCompanyId: { type: "string", entity: "companies", description: "Main company this contact belongs to", example: "co1" },
      secondaryCompanyId: { type: "string", entity: "companies", description: "Secondary company affiliation", example: "co2" },
    },
  },
  erp: {
    accounts: {
      accountName: { type: "string", description: "Account display name", example: "Acme Corp" },
      website:     { type: "string", description: "Account website", example: "acme.com" },
    },
    employees: {
      fullName: { type: "string", description: "Employee full name", example: "Alice Liddell" },
      email:    { type: "string", description: "Work email address", example: "alice@example.com" },
      orgId:    { type: "string", entity: "accounts", description: "Parent account reference", example: "acc1" },
    },
    orders: {
      orderRef: { type: "string", description: "Human-readable order reference", example: "ORD-1001" },
      total:    { type: "number", description: "Order total in account currency", example: 299.90 },
      status:   { type: "string", description: "Order lifecycle status", example: "shipped" },
      date:     { type: "string", description: "ISO 8601 order date", example: "2026-03-15" },
    },
    // ... remaining entities (orderLines, items, etc.)
  },
  // ... hr, webshop
};
```

_(The complete expansion covering all seven seed entities is written at implementation time.)_

### § 3.3 `makeEntity` parameter change

`makeEntity`'s `entitySchema` param widens from
`Record<string, { entity: string }> | undefined` to `Record<string, FieldDescriptor> | undefined`.

The schema assembly simplifies — no seed scan, no merge:

```ts
// entitySchema is now the full FieldDescriptor map — pass through directly.
return {
  name: entityName,
  schema: entitySchema ?? undefined,
  async *read(...) { ... },
};
```

After this change, `getEntities()` is the single authoritative source for all field metadata.
Entities not listed in `FIXED_SCHEMAS` (e.g. dynamically discovered entities with no explicit
annotation) contribute `schema: undefined` — the expand chevron is omitted for those.

---

## § 4 Type change — `allEntities`

### Local type in `lineage-diagram.ts`

```ts
/** One field entry for the entity field preview — maps FieldDescriptor to display data. */
interface FieldPreview {
  name: string;
  isFK: boolean;
  description?: string;
  type?: string;    // human-readable: "string", "number", "boolean", "→ companies", …
  example?: unknown;
}
```

`type` is rendered as a simplified string: scalar `FieldType`s become their name; `entity`
presence overrides with `→ <entityName>` (FK annotation). Complex object/array types render
as `"object"` / `"array"`.

### Current parameter type

```ts
// connectorId → entity names
allEntities?: Map<string, string[]>
```

### Proposed parameter type

```ts
// connectorId → entity name → field previews
allEntities?: Map<string, Map<string, FieldPreview[]>>
```

The entity name list (`[...allEntities.get(connectorId)!.keys()]`) is unchanged.

### Build in `systems-pane.ts`

Replace the existing `allEntities` construction. **No `snapshotFull()` call needed** —
`getEntities()` provides everything:

```ts
// Before
const allEntities = new Map<string, string[]>();
for (const [sysId, conn] of systems) {
  allEntities.set(sysId, Object.keys(conn.snapshot()));
}

// After
const allEntities = new Map<string, Map<string, FieldPreview[]>>();
for (const [sysId, conn] of systems) {
  const entityMap = new Map<string, FieldPreview[]>();
  for (const entityDef of conn.connector.getEntities?.({} as ConnectorContext) ?? []) {
    const fields = Object.entries(entityDef.schema ?? {}).map(([name, desc]) => ({
      name,
      isFK: desc.entity !== undefined,
      description: desc.description,
      type: desc.entity ? `→ ${desc.entity}` : typeof desc.type === "string" ? desc.type : desc.type?.type,
      example: desc.example,
    }));
    entityMap.set(entityDef.name, fields);
  }
  allEntities.set(sysId, entityMap);
}
```

`ConnectorContext` is already imported in `systems-pane.ts` (or can be added via `@opensync/sdk`
if not already present). `InMemoryConnector.connector.getEntities` does not use the context.

---

## § 5 Pool pill expansion

### § 5.1 DOM structure

Convert each `.ld-pool-entity` `<span>` into an expandable `.ld-pool-entity-group` `<div>`:

```html
<!-- Before -->
<span class="ld-pool-entity">crm / contacts</span>

<!-- After -->
<div class="ld-pool-entity-group">
  <div class="ld-pool-entity-header" data-pool-key="crm/contacts">
    <span class="ld-pool-entity-label">crm / contacts</span>
    <span class="ld-chevron">▸</span>           <!-- hidden when fields list is empty -->
  </div>
  <div class="ld-pool-fields-list ld-hidden">
    <!-- plain field -->
    <span class="ld-pool-field" title="Work email address · string · e.g. alice@example.com">email</span>
    <!-- FK field -->
    <span class="ld-pool-field ld-pool-field-fk" title="Main company · → companies · e.g. co1">primaryCompanyId</span>
    …
  </div>
</div>
```

Each pill's `title` attribute is built from the non-null subset of
`[description, type, example ? "e.g. " + example : null]` joined by ` · `.
This gives a native browser tooltip on hover — no custom popover needed.

When the entity has no field data (`fields.length === 0`), the chevron is not rendered
and the header acts as a non-interactive label (identical to the current static pill).

### § 5.2 Expand/collapse state

A `Set<string>` named `expandedPool` (keys: `"connectorId/entity"`) is created in the
pool-rendering block inside `renderLineageDiagram`. Click events toggle membership and
update the DOM (chevron text, `ld-hidden` on the fields list).

No cross-channel coordination is needed as the pool is a separate DOM subtree from the
channel swimlanes.

---

## § 6 Unmapped fields in channel entity groups

### § 6.1 Source of unmapped fields

For a channel entity group for `(connectorId, entity)`, the unmapped fields are:

```ts
const mappedSourceFields = new Set(fields.map((f) => f.sourceField));
const allFields = allEntities?.get(connectorId)?.get(entity) ?? [];
const unmappedFields = allFields.filter((fp) => !mappedSourceFields.has(fp.name));
```

Skip this section when:
- `allEntities` is undefined (no field data passed).
- The entity is a passthrough (`fields.length === 1 && fields[0].canonicalField === "*"`),
  since all fields are implicitly covered.
- `unmappedFields.length === 0` (all fields are already mapped).

### § 6.2 DOM structure

Appended inside `.ld-fields-list`, after the mapped field nodes, when `unmappedFields` is
non-empty:

```html
<!-- existing mapped field nodes first -->
<div class="ld-field-node" …>name</div>
<div class="ld-field-node" …>email</div>

<!-- separator + unmapped section -->
<div class="ld-fields-separator">— also available —</div>
<div class="ld-field-node ld-field-node-unmapped"
     data-unmapped="true"
     title="Account website · string · e.g. acme.com">website</div>
<div class="ld-field-node ld-field-node-unmapped ld-field-node-fk"
     data-unmapped="true"
     title="Main company · → companies · e.g. co1">primaryCompanyId</div>
```

FK fields (`fp.isFK === true`) receive the additional `ld-field-node-fk` class.
Both pool pills and channel unmapped nodes use the same `title` tooltip format:
`description · type · e.g. example`.

### § 6.3 Interactivity

`.ld-field-node-unmapped` nodes:

- `pointer-events: none` — no click, no focus, no hover state.
- `opacity: ~0.4` — visually distinct from mapped fields.
- Not given `data-canonical-field` or `data-source-field` attributes.
- Excluded from SVG line drawing (checked via `data-unmapped` in `drawSide`).
- Excluded from `applyNodeDimming` highlight/dim logic.

### § 6.4 `buildEntityGroup` signature change

```ts
function buildEntityGroup(
  connectorId: string,
  entity: string,
  fields: ConnectorFieldNode[],
  mk: string,
  expandedSet: Set<string>,
  autoExpandedSet: Set<string>,
  colElRef: { el: HTMLElement | null },
  scheduleRedraw: () => void,
+ allEntityFields: FieldPreview[] | null,  // NEW — full field list for this entity
): HTMLElement
```

`allEntityFields` is threaded from `buildColumn` (which is called from `buildChannelSection`),
and `buildChannelSection` receives it from `renderLineageDiagram`.

`buildColumn` gains a matching `allEntityFields: Map<string, FieldPreview[]>` param (entity →
field previews for the connector on that side).

---

## § 7 Line drawing — exclusion of unmapped nodes

In `drawSide`, the inner loop that looks up `.ld-field-node` elements must skip unmapped
nodes. Add a guard:

```ts
const fieldPill = Array.from(
  colEl.querySelectorAll<HTMLElement>(".ld-field-node"),
).find((n) =>
  n.dataset.memberKey === mk &&
  n.dataset.sourceField === f.sourceField &&
  !n.dataset.unmapped,           // NEW guard
) ?? null;
```

This is the only change needed in line drawing; the rest of the SVG logic is untouched.

---

## § 8 CSS additions (`playground/index.html`)

```css
/* ── Pool entity groups — Spec: specs/playground.md § 11.15 ─── */
.ld-pool-entity-group {
  display: inline-flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}

.ld-pool-entity-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
}
.ld-pool-entity-header:hover { background: var(--hover-bg); }

.ld-pool-fields-list {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  padding: 4px 8px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
}

.ld-pool-field {
  font-size: 11px;
  color: var(--text-dim);
  background: var(--tag-bg);
  border-radius: 3px;
  padding: 1px 5px;
}
.ld-pool-field-fk { font-style: italic; }  /* FK reference fields */

/* ── Unmapped fields in channel entities — Spec: specs/playground.md § 11.15 ─ */
.ld-fields-separator {
  font-size: 10px;
  color: var(--text-dim);
  padding: 4px 6px 2px;
  opacity: 0.6;
}

.ld-field-node-unmapped {
  opacity: 0.4;
  pointer-events: none;
  font-style: italic;
  border-style: dashed;
}
```

---

## § 9 Spec changes planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-sdk.md` | §FieldDescriptor | Add `example?: unknown` with description |
| `specs/playground.md` | §11.14 | Update `allEntities` type to `Map<string, Map<string, FieldPreview[]>>`; update build to use `getEntities()` |
| `specs/playground.md` | New §11.15 | Pool pill expansion + unmapped field section + `title` tooltip format |

No changes required in `specs/sync-engine.md` or `specs/config.md`.

The `makeEntity` parameter widening in `inmemory.ts` is playground-internal; no separate spec
entry needed — `EntityDefinition.schema` documents the `FieldDescriptor` contract.

---

## § 10 Work items

1. **`packages/sdk/src/types.ts`** — add `example?: unknown` to `FieldDescriptor` (§ 3.1).
2. **`specs/connector-sdk.md`** — document `example` in the `FieldDescriptor` section (§ 9).
3. **`playground/src/lib/systems.ts`**
   a. Change `EntitySchemaMap` value type to `FieldDescriptor` (§ 3.2).
   b. Expand `FIXED_SCHEMAS` to cover all seed fields with `description`, `type`, `example`
      (and `entity` where applicable) for every entity in crm/erp/hr/webshop (§ 3.2).
4. **`playground/src/inmemory.ts`** — widen `makeEntity` `entitySchema` param from
   `Record<string, { entity: string }>` to `Record<string, FieldDescriptor>`; pass
   `entitySchema ?? undefined` directly as `schema` (§ 3.3).
5. **`specs/playground.md`** — update §11.14; add §11.15 (§ 9).
6. **`playground/src/ui/lineage-diagram.ts`**
   a. Add `FieldPreview` local type with `description`, `type`, `example` (§ 4)
   b. Change `renderLineageDiagram` param to `allEntities?: Map<string, Map<string, FieldPreview[]>>`
   c. Update pool iteration to use `allEntities.get(connectorId)!.keys()` for entity names
   d. Replace pool `<span>` pill with expandable `.ld-pool-entity-group`; pills carry `title` tooltip (§ 5)
   e. Thread `allEntityFields: Map<string, FieldPreview[]>` through
      `buildChannelSection → buildColumn → buildEntityGroup`
   f. In `buildEntityGroup`: append separator + `.ld-field-node-unmapped` nodes with `title` tooltips (§ 6)
   g. In `drawSide`: guard against `data-unmapped` (§ 7)
7. **`playground/src/ui/systems-pane.ts`** — rebuild `allEntities` from `conn.connector.getEntities()`,
   mapping `FieldDescriptor` → `FieldPreview` (§ 4); remove old `conn.snapshot()` call.
8. **`playground/index.html`** — add CSS (§ 8)
9. **`plans/INDEX.md`** — row already added
