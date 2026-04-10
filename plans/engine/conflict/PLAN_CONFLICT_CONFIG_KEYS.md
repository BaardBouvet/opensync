# Plan: Remove `conflict:` YAML Block; `master: true` on Field Entries

**Status:** complete  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** engine / config  
**Scope:** `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/engine.ts`, playground, specs  
**Spec changes planned:**  
- `specs/channels.md §2.1, §3.2, §3.7, §5, §6` — remove `fieldMasters`/`connectorPriorities` from YAML surface  
- `specs/sync-engine.md §Conflict Resolution` — note `ConflictConfig` is loader-internal  
- `specs/config.md` — add `master:` as a field key; remove global conflict section  
- `specs/field-mapping.md §2.1` — update coalesce section  

---

## Problem → Solution

**Three issues with the old `conflict:` top-level YAML block:**

1. `fieldMasters` and `connectorPriorities` are camelCase in a snake_case config.
2. `connectorPriorities` in `conflict:` means channels know connector IDs — channels should  
   be connector-agnostic (they describe a canonical schema, not a wiring topology).
3. There are three places to declare priority (global conflict, channel fields, field entry),  
   which is too much complexity to reason about.

**Solution: delete `conflict:` from the YAML surface entirely.**

| Before | After |
|--------|-------|
| `conflict.connectorPriorities: { crm: 1 }` | `priority: 1` on the mapping entry (already implemented) |
| `conflict.fieldMasters: { email: crm }` | `master: true` on the field entry in the mapping |
| Per-field strategies in global `conflict:` | Already in `channels[].fields:` |
| Global strategy fallback | `channels[].fields.strategy:` (already supported) |

---

## Priority: two levels, both in `mappings:`

```yaml
mappings:
  - connector: crm
    channel: persons
    entity: contacts
    priority: 1           # mapping-level: default coalesce priority for this connector
    fields:
      - source: email
        target: email
        master: true      # was: conflict.fieldMasters.email = crm
      - source: firstName
        target: firstName
        group: name

  - connector: erp
    channel: persons
    entity: employees
    priority: 2           # mapping-level: default
    fields:
      - source: firstName
        target: firstName
        group: name
        priority: 0       # field-level override: ERP wins name despite priority 2 globally
      - source: lastName
        target: lastName
        group: name
        priority: 0
```

---

## Internal `ConflictConfig` unchanged

`ConflictConfig.connectorPriorities` and `ConflictConfig.fieldMasters` remain as internal  
TypeScript properties. They are populated by the loader from mapping entries, never from YAML.  
Tests that build `ConflictConfig` objects directly (`conflict.test.ts`,  
`scalar-route-element.test.ts`) are unaffected.

---

## `_applyCollapseBatch` fix

Element-set resolution previously used `this.conflictConfig` (global) instead of the  
per-channel effective conflict. After this change the method receives `channel: ChannelConfig`  
and calls `this._effectiveConflict(channel)` so `fieldMasters` from `master: true` mapping  
entries works correctly for array collapse resolution too.

---

## Files Changed

| File | Change |
|------|--------|
| `packages/engine/src/config/schema.ts` | Remove `fieldMasters`+`connectorPriorities` from `ConflictConfigSchema`; add `master: boolean` to `FieldMappingEntrySchemaBase`; remove `conflict:` from `MappingsFileSchema` |
| `packages/engine/src/config/loader.ts` | Add `master: true` field promotion → `ch.conflict.fieldMasters` in `buildChannelsFromEntries` |
| `packages/engine/src/engine.ts` | `_applyCollapseBatch` receives `channel`; uses `_effectiveConflict(channel)` |
| `playground/src/scenarios/mapping-showcase.ts` | Remove `conflict:` block; add `priority:` on mapping entries; expand field priority fields |
| Spec files | See spec changes above |
| `CHANGELOG.md` | `### Changed` bullet |


**Status:** proposed  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** engine / config  
**Scope:** `packages/engine/src/config/schema.ts`, playground showcase, specs  
**Spec changes planned:**  
- `specs/channels.md §2.1, §3.2, §6` — remove `connectorPriorities` from YAML surface; rename `fieldMasters`  
- `specs/sync-engine.md §Conflict Resolution` — update `ConflictConfig` docs  
- `specs/config.md` — update reserved-key table, remove `connectorPriorities` examples, add mapping-entry `priority:` section  
- `specs/field-mapping.md §2.1, §5.5` — update YAML examples  

---

## Problem

Two issues:

**1. camelCase keys in a snake_case config**

| Current YAML key | Style |
|-----------------|-------|
| `connectorPriorities` | camelCase ← inconsistent |
| `fieldMasters` | camelCase ← inconsistent |

**2. Wrong location — channels should not know about connectors**

`connectorPriorities` lives inside `conflict:` as a channel-level or global setting.
But which connector is authoritative for a field is a property of the *mapping*, not
the channel. The channel is a schema description (which canonical fields exist, what
strategies they use); it has no business knowing which connector IDs participate.
Priority belongs where the connector is declared: on the `mappings[]` entry.

---

## Proposed Changes

### Priority: two levels, both in `mappings:`

Priority is declared where the connector-to-channel wiring is declared — on the mapping
entry. Two levels:

**Mapping-level `priority:`** — already implemented (§PLAN_MAPPING_LEVEL_PRIORITY.md).
Sets a default priority for all coalesce fields from this connector in this channel:

```yaml
mappings:
  - connector: crm
    channel: persons
    entity: contacts
    priority: 1         # CRM is authoritative for this channel
    fields: [...]

  - connector: erp
    channel: persons
    entity: employees
    priority: 2         # ERP is secondary in this channel by default…
    fields:
      - source: firstName
        target: firstName
        priority: 0     # …except for name fields where ERP is HR-of-record
      - source: lastName
        target: lastName
        priority: 0
```

**Field-level `priority:`** on a `FieldMappingEntry` — already implemented. Overrides
the mapping-level default for a single canonical field.

**That is all.** No global `connectorPriorities`, no `connectors:` block anywhere.

At load time the loader promotes mapping-level `priority:` → `ch.conflict.connectorPriorities`
(channel-scoped). This already works. The internal runtime type `ConflictConfig` keeps
`connectorPriorities` for the resolver to consume — it just becomes a loader-internal
detail, not a user-writable YAML key.

### `connectorPriorities` removed from YAML surface

`connectorPriorities` is removed from `ConflictConfigSchema`. Users can no longer write:

```yaml
# REMOVED — priority belongs on the mapping entry, not here
conflict:
  connectorPriorities:
    crm: 1
    erp: 2
```

Any YAML that currently uses this key must migrate to `priority:` on the mapping entry.
Because this is pre-release, there are no shipped examples using it (only the playground
showcase, which will be updated).

### `fieldMasters:` → `field_masters:` (snake_case rename)

Before:
```yaml
conflict:
  fieldMasters:
    email: crm
    price: erp
```

After:
```yaml
conflict:
  field_masters:
    email: crm
    price: erp
```

`field_masters` is a field-level conflict setting — it is legitimately in `conflict:`.

### `conflict:` block after changes

```yaml
conflict:
  strategy: field_master    # optional global fallback
  field_masters:
    email: crm
  phone: { strategy: last_modified }
  domain: { strategy: coalesce }
```

Clean, flat, snake_case, no connector IDs.

---

### Internal TypeScript interface unchanged

`ConflictConfig.connectorPriorities` stays. It becomes a loader-internal runtime property:
set by the loader when it promotes mapping-level `priority:` values, consumed by
`resolveConflicts` — never written directly from YAML.

Tests that construct `ConflictConfig` directly (`conflict.test.ts`,
`scalar-route-element.test.ts`) are **unaffected**.

---

## Schema Changes (`packages/engine/src/config/schema.ts`)

### `CONFLICT_RESERVED` shrinks

```ts
// Before
const CONFLICT_RESERVED = new Set(["strategy", "fieldMasters", "connectorPriorities"]);

// After
const CONFLICT_RESERVED = new Set(["strategy", "field_masters"]);
```

### `ConflictConfigSchema` — remove `connectorPriorities`, rename `fieldMasters`

- Remove the `connectorPriorities` `superRefine` check and its `transform` branch
- Rename `fieldMasters` → `field_masters` in `superRefine` and `transform`
- Update error message strings

---

## Files to Change

| File | Change |
|------|--------|
| `packages/engine/src/config/schema.ts` | Shrink `CONFLICT_RESERVED`; remove `connectorPriorities` validation; rename `fieldMasters` → `field_masters` in schema |
| `playground/src/scenarios/mapping-showcase.ts` | Remove `conflict: { connectorPriorities: … }`; expand ERP `priority: 0` fields to multi-line form for visibility |
| `specs/channels.md` | §2.1, §3.2, §6 — remove `connectorPriorities` from YAML examples; note it is loader-internal; rename `fieldMasters` → `field_masters` |
| `specs/sync-engine.md` | `ConflictConfig` docs — note `connectorPriorities` is loader-internal only |
| `specs/config.md` | Remove `connectorPriorities` from conflict section; expand mapping-entry `priority:` description; rename `fieldMasters` |
| `specs/field-mapping.md` | §2.1 — update to clarify priority is set on the mapping entry; §5.5 element-set resolution YAML example |
| `plans/engine/GAP_OSI_PRIMITIVES.md` | Update "Mapping-level priority" note |
| `CHANGELOG.md` | `### Changed` bullet |

**Not changing:**
- `packages/engine/src/config/loader.ts` — `ConflictConfig` interface and promotion logic unchanged; `buildChannelsFromEntries` already handles `priority:` on mapping entries
- `packages/engine/src/core/conflict.ts` — unchanged
- `packages/engine/src/engine.ts` — unchanged
- `packages/engine/src/core/conflict.test.ts` — builds `ConflictConfig` directly; unaffected
- `packages/engine/src/scalar-route-element.test.ts` — same

---

## Summary

| Before | After |
|--------|-------|
| `conflict.connectorPriorities: { crm: 1 }` | removed — use `priority: 1` on the mapping entry |
| `conflict.fieldMasters: { email: crm }` | `conflict.field_masters: { email: crm }` |
| Three levels of priority (global, channel, field) | Two levels (mapping-entry default, field override) |
| Channels carry connector IDs in `fields:` | Channels are connector-agnostic |

---

## Questions Resolved

- **Why not a top-level `connectors:` block?** Not needed — priority is already expressible
  on the mapping entry where the connector is wired in. Adding a separate block would be
  a second place to declare the same thing.
- **Why keep `ConflictConfig.connectorPriorities` as an internal type?** The resolver
  already uses it; the loader already populates it from mapping-level `priority:`. Removing
  the internal type would require refactoring the resolver with no user-visible benefit.
- **Impact on tests?** Only YAML-facing tests need updating; direct `ConflictConfig`
  construction tests are unaffected.


**Status:** proposed  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** engine / config  
**Scope:** `packages/engine/src/config/schema.ts`, playground showcase, specs  
**Spec changes planned:**  
- `specs/channels.md §2.1, §3.2, §6` — replace `connectorPriorities` / `fieldMasters` with new keys  
- `specs/sync-engine.md §Conflict Resolution` — update `ConflictConfig` interface docs  
- `specs/config.md` — update mapping-entry, channel-def, and field tables; add `connectors:` section  
- `specs/field-mapping.md §2.1, §5.5` — update YAML examples  

---

## Problem

The mapping-file config uses snake_case for all keys (`soft_delete`, `array_path`,
`element_key`, `source_path`, `reverse_filter`, `last_modified`, `id_field`, …) but
two conflict-related keys break the convention:

| Current YAML key | Style |
|-----------------|-------|
| `connectorPriorities` | camelCase ← inconsistent |
| `fieldMasters` | camelCase ← inconsistent |

`connectorPriorities` also conflates "connector-level settings" with "conflict config"
when priority is really a property of how a connector participates in a channel — not
a sub-topic of conflict resolution. Future per-connector settings (enabled, display_name,
weight, etc.) belong alongside priority, not buried inside `conflict:`.

---

## Proposed Changes

### 1. `connectors:` — new top-level key in mapping files

`connectors:` moves **out of** `conflict:` and becomes its own top-level key in
`mappings/*.yaml` (parallel to `conflict:`, `channels:`, `mappings:`).

Before:
```yaml
conflict:
  connectorPriorities:
    crm: 1
    erp: 2
    hr: 3
```

After:
```yaml
connectors:
  crm:
    priority: 1
  erp:
    priority: 2
  hr:
    priority: 3
```

Same key appears at channel level to override per-channel:
```yaml
channels:
  - id: persons
    connectors:
      erp:
        priority: 0   # ERP wins name fields in this channel despite global ordering
    fields:
      phone: { strategy: last_modified }
```

The nested shape is immediately extensible — future per-connector settings (`enabled`,
`display_name`, `weight`, …) add under the same connector ID without a schema migration.

### 2. `fieldMasters:` → `field_masters:`

Simple snake_case rename. Value shape unchanged (canonical field → connectorId).

Before:
```yaml
conflict:
  fieldMasters:
    email: crm
    price: erp
```

After:
```yaml
conflict:
  field_masters:
    email: crm
    price: erp
```

### 3. `conflict:` block after changes

After removing `connectorPriorities`, the `conflict:` block only holds field-level
and strategy settings where everything is already snake_case:

```yaml
conflict:
  strategy: field_master    # optional global fallback
  field_masters:
    email: crm
  phone: { strategy: last_modified }
  domain: { strategy: coalesce }
```

---

### Internal TypeScript `ConflictConfig` interface (no change)

**The TypeScript property names stay camelCase** — that is the TypeScript convention and
changing them would touch every in-code reference with no user-facing benefit.

The Zod schemas absorb the mapping:

| YAML location | YAML key | Internal `ConflictConfig` property |
|--------------|----------|-----------------------------------|
| top-level `connectors:` | `<id>.priority` | `connectorPriorities[id]` (merged into effective conflict at run time) |
| `channels[].connectors:` | `<id>.priority` | `ch.conflict.connectorPriorities[id]` (channel-scoped) |
| `conflict:` | `field_masters` | `fieldMasters` |

Tests that construct `ConflictConfig` objects directly (`conflict.test.ts`,
`scalar-route-element.test.ts`) are **unaffected** — they build the internal type,
never go through YAML parsing.

---

## Schema Changes (`packages/engine/src/config/schema.ts`)

### New `ConnectorSettingsSchema` (top-level and channel-level)

```ts
export const ConnectorSettingsSchema = z.object({
  priority: z.number().optional(),
  // future keys go here
});

export const ConnectorsBlockSchema = z.record(z.string(), ConnectorSettingsSchema);
```

### `ConflictConfigSchema` update

- Remove `connectorPriorities` from `superRefine` and `transform` (it is no longer inside `conflict:`)
- Add `field_masters` validation (replacing `fieldMasters`)
- Update `CONFLICT_RESERVED`:

```ts
const CONFLICT_RESERVED = new Set(["strategy", "field_masters"]);
```

### `ChannelDefSchema` update

```ts
export const ChannelDefSchema = z.object({
  id: z.string(),
  identity: IdentitySchema.optional(),
  propagateDeletes: z.boolean().optional(),
  connectors: ConnectorsBlockSchema.optional(),  // NEW — channel-scoped connector settings
  fields: ConflictConfigSchema.optional(),
});
```

### Top-level `MappingFileSchema` update

```ts
export const MappingFileSchema = z.object({
  mappings: z.array(MappingEntrySchema).optional(),
  channels: z.array(ChannelDefSchema).optional(),
  conflict: ConflictConfigSchema.optional(),
  connectors: ConnectorsBlockSchema.optional(),  // NEW
});
```

### `loader.ts` — `buildChannelsFromEntries` signature

The function currently receives `channelDefs` with an optional `conflict` property.
After this change, `channelDefs` also carries an optional `connectors` property, and
the loader merges `connectors.<id>.priority` into `ch.conflict.connectorPriorities` at
channel-def build time, the same way mapping-level `priority:` is promoted today.

The top-level `connectors:` block (file-level) is merged into the global
`ResolvedConfig.conflict.connectorPriorities` by `loadConfig` before being passed to
the engine (same pattern as the existing global `conflict:` merge).

---

## `CONFLICT_RESERVED` update

After removing `connectorPriorities` from `conflict:`, the reserved set shrinks:

```ts
const CONFLICT_RESERVED = new Set(["strategy", "field_masters"]);
```

---

## Files to Change

| File | Change |
|------|--------|
| `packages/engine/src/config/schema.ts` | Add `ConnectorSettingsSchema` + `ConnectorsBlockSchema`; update `CONFLICT_RESERVED`; update `ConflictConfigSchema` (remove `connectorPriorities`, rename `fieldMasters` → `field_masters`); update `ChannelDefSchema`; update `MappingFileSchema` |
| `packages/engine/src/config/loader.ts` | Update `buildChannelsFromEntries` channel-def type to include `connectors?`; merge `connectors.<id>.priority` into `ch.conflict.connectorPriorities`; update `loadConfig` to merge top-level `connectors:` into global conflict |
| `playground/src/scenarios/mapping-showcase.ts` | Replace `conflict: { connectorPriorities: … }` with top-level `connectors:` block; expand ERP `priority: 0` fields to multi-line form for visibility; rename any `fieldMasters:` |
| `specs/channels.md` | §2.1, §3.2, §6 — rename keys in text and YAML examples; add note that `connectors:` is now top-level |
| `specs/sync-engine.md` | `ConflictConfig` docs — update external YAML example |
| `specs/config.md` | Remove `connectorPriorities` from conflict section; add top-level `connectors:` section; update channel-def table; rename `fieldMasters` |
| `specs/field-mapping.md` | §2.1 status note, §5.5 element-set resolution YAML example |
| `plans/engine/GAP_OSI_PRIMITIVES.md` | Update "Mapping-level priority" entry |
| `CHANGELOG.md` | `### Changed` bullet |

**Not changing (internal TS only):**
- `packages/engine/src/core/conflict.ts` — reads `config.connectorPriorities`/`config.fieldMasters`; unchanged
- `packages/engine/src/engine.ts` — same
- `packages/engine/src/core/conflict.test.ts` — builds `ConflictConfig` directly; unchanged
- `packages/engine/src/scalar-route-element.test.ts` — same

---

## Future Expansion (`connectors:` block)

```yaml
connectors:
  crm:
    priority: 1
    # future:
    # enabled: false
    # display_name: "Salesforce CRM"
```

---

## Questions Resolved

- **Why not `conflict.connectors:`?** Priority (and future settings) belong to the
  connector's participation in a channel, not to conflict strategy. Top-level `connectors:`
  is the right home.
- **camelCase vs snake_case for internal TS?** Keep camelCase internally; Zod transform
  absorbs the difference.
- **`field_masters` or `fields: { masters: … }`?** Flat rename is sufficient.
- **Impact on tests?** Only YAML-facing tests need updating; direct `ConflictConfig`
  construction tests are unaffected.
