# Plan: Mapping-Level and Field-Level Priority Overrides

**Status:** complete  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** engine / config  
**Scope:** `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/core/conflict.ts`  
**Spec changes planned:** `specs/field-mapping.md §2.1`, `specs/channels.md §3.2`, `specs/config.md §mapping-level priority`  

---

## Problem

`connectorPriorities` in the global `conflict:` block sets source priority for **all channels**.
Two narrower overrides are documented in the spec (`specs/field-mapping.md §2.1`) but not yet
wired through the config schema or the conflict resolver:

1. **Mapping-level `priority:`** — a number on the mapping entry itself sets the priority for
   that connector within that channel only.  Enables CRM to be priority 1 in _persons_ and
   priority 2 in _orgs_ without two separate global entries.

2. **Field-level `priority:`** — a number on an individual `FieldMappingEntry` overrides the
   source priority for that single canonical field.  Enables "CRM is authoritative for `email`
   specifically" while ERP wins everything else.

The GAP doc (`plans/engine/GAP_OSI_PRIMITIVES.md §10`) flags this as 🔶.

---

## Design

### Scope of each override

| Level | YAML location | Scope |
|-------|---------------|-------|
| Global | `conflict.connectorPriorities` | All channels, all fields |
| Mapping | `mappings[].priority` | One channel, one connector, all fields |
| Field | `mappings[].fields[].priority` | One channel, one connector, one canonical field |

Override precedence (highest to lowest): field → mapping → global.

### Mapping-level: promotion into channel's ConflictConfig

`buildChannelsFromEntries` already produces a `ChannelConfig` per channel.
`ChannelConfig.conflict` already exists to carry channel-scoped strategy overrides.

At build time, for each flat mapping entry that declares `priority: N`, the loader adds
`{ [connectorId]: N }` into `channel.conflict.connectorPriorities`.  This means:

- No change to `resolveConflicts()` — it already reads `config.connectorPriorities`, and the
  engine already prefers the channel's `conflict` over the global one.
- No change to `ChannelMember`.
- If the same connector appears in two mapping entries in the same channel with different
  `priority:` values, the loader throws a config validation error.

### Field-level: stored in FieldMapping, consulted in resolver

`FieldMapping` (the compiled interface in `loader.ts`) gains `priority?: number`.
`buildInbound` carries the value from `FieldMappingEntry.priority`.

In `resolveConflicts()`, the coalesce branch currently does:
```typescript
const inPri = config.connectorPriorities?.[incomingSrc] ?? Number.MAX_SAFE_INTEGER;
const exPri = config.connectorPriorities?.[existing.src] ?? Number.MAX_SAFE_INTEGER;
```

It becomes:
```typescript
// Check per-field priority override first, then fall back to connectorPriorities.
// Spec: specs/field-mapping.md §2.1
const fieldEntry = fieldMappings?.find((m) => m.target === field);
const inPri = fieldEntry?.priority ?? config.connectorPriorities?.[incomingSrc] ?? Number.MAX_SAFE_INTEGER;
const exPri = existing.src === incomingSrc
  ? inPri   // same source — never-win comparison; irrelevant
  : fieldEntry   // must look up existing.src's mapping entry for field-level priority
    ? (fieldMappings?.find((m) => m.target === field && /* TODO: how to know existing.src? */ false)?.priority
       ?? config.connectorPriorities?.[existing.src] ?? Number.MAX_SAFE_INTEGER)
    : (config.connectorPriorities?.[existing.src] ?? Number.MAX_SAFE_INTEGER);
```

**The complication**: `FieldMapping` is connector-agnostic — a single entry describes how
_this_ connector maps to the canonical target.  But the existing shadow's `src` is a
_different_ connector, and that connector's field-level priority is in a _different_
`FieldMappingList`.  The conflict resolver currently only receives the **incoming** connector's
`FieldMappingList`.

**Resolution**: thread the full per-channel mapping index into the resolver.  The index maps
`connectorId → FieldMappingList` for all connectors in the channel.  The resolver can then
do:
```typescript
const existingFieldPri =
  allMappings?.[existing.src]?.find((m) => m.target === field)?.priority
  ?? config.connectorPriorities?.[existing.src]
  ?? Number.MAX_SAFE_INTEGER;
```

This is a small signature change to `resolveConflicts`:

```typescript
export function resolveConflicts(
  // ... existing params ...
  fieldMappings?: FieldMappingList,
  allChannelMappings?: Record<string, FieldMappingList>,   // ← new, optional
  // ... remaining params ...
): Record<string, unknown>
```

Callers that do not pass `allChannelMappings` behave exactly as before — the optional parameter
defaults to `undefined` and the priority lookup falls back to `connectorPriorities`.

---

## Implementation Checklist

1. **`packages/engine/src/config/schema.ts`**
   - [ ] Add `priority: z.number().optional()` to `MappingEntrySchema`
   - [ ] Add `priority: z.number().optional()` to `FieldMappingEntrySchemaBase`
   - [ ] Document in both with spec ref comment

2. **`packages/engine/src/config/loader.ts`**
   - [ ] Add `priority?: number` to `FieldMapping` interface (with spec comment)
   - [ ] In `buildInbound`: carry `entry.priority` into `FieldMapping`
   - [ ] In `buildChannelsFromEntries`: for each flat mapping entry with `priority` set,
         accumulate `{ [connectorId]: priority }` into the channel's `conflict.connectorPriorities`;
         throw if the same connector appears with conflicting priorities in the same channel
   - [ ] Add `allChannelMappings?: Record<string, FieldMappingList>` optional parameter
         to the `resolveConflicts` call sites in `engine.ts`

3. **`packages/engine/src/core/conflict.ts`**
   - [ ] Add optional `allChannelMappings?: Record<string, FieldMappingList>` parameter
   - [ ] In the coalesce branch: look up `allChannelMappings?.[incomingSrc]` and
         `allChannelMappings?.[existing.src]` for per-field priority before `connectorPriorities`
   - [ ] In the group coalesce branch: same lookup for per-field priority on any group field

4. **`packages/engine/src/engine.ts`**
   - [ ] Build the `allChannelMappings` index per channel from `ChannelConfig.members`
         (`member.inbound` keyed by `member.connectorId`)
   - [ ] Pass it through to `resolveConflicts` call sites

5. **Tests** (`packages/engine/src/core/conflict.test.ts`)
   - [ ] PR1: mapping-level priority sets per-channel priority; overrides global when both set
   - [ ] PR2: field-level priority overrides mapping-level for one field; other fields use mapping-level
   - [ ] PR3: field-level priority on incoming connector; existing connector also has field-level
         priority; lower number wins
   - [ ] PR4: coalesce + group with per-field priority override

6. **Spec updates**
   - [ ] `specs/field-mapping.md §2.1`: confirm example already shown is correct; add note on
         field-level priority lookup for existing.src via allChannelMappings
   - [ ] `specs/channels.md §3.2`: note mapping-level promotion into channel ConflictConfig
   - [ ] `specs/config.md`: document `priority` key in the mapping entry and field entry tables

---

## Spec Changes Planned

| File | Section | Change |
|------|---------|--------|
| `specs/field-mapping.md` | §2.1 | Confirm the `priority:` YAML examples are accurate; add status note |
| `specs/channels.md` | §3.2 | Add sentence: mapping-level `priority:` promotes into `ChannelConfig.conflict.connectorPriorities` |
| `specs/config.md` | mapping entry table | Document `priority?: number` on mapping and field entries |

---

## Showcase

After implementation, `playground/src/scenarios/mapping-showcase.ts` should demonstrate:

```yaml
# ── CRM contacts ──
- connector: crm
  entity: contacts
  channel: persons
  priority: 1          # §2.1 mapping-level: CRM is highest-priority source for persons
  fields:
    - source: email
      target: email
      priority: 0      # §2.1 field-level: CRM is ABSOLUTELY authoritative for email
                       #   (wins even if another mapping has priority: 0)
```

---

## Non-Goals

- Mapping-level `last_modified:` column shorthand from the spec (that replaces the
  `ReadRecord.updatedAt` mechanism which is already the default — it's largely
  historical and is already covered; document it as superseded in §2.2, don't implement).
- Priority on array expansion members (element set resolution uses `connectorPriorities`
  directly; the element resolver can be extended separately if needed).
