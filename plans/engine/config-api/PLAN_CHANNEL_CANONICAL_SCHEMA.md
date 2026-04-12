# PLAN: Canonical Field Schema on Channel Definitions

**Status:** draft  
**Date:** 2026-04-06  
**Effort:** M  
**Domain:** Engine, Config  
**Scope:** `specs/config.md`, `specs/field-mapping.md`, `packages/engine/src/config/`  
**Depends on:** nothing  

---

## Spec changes planned

- `specs/config.md` — `mappings/channels.yaml` section: document extended `fields:` entries
  (now `CanonicalFieldDescriptor` with optional `description`, `type`, and `strategy`),
  the `strict: true` reserved key, and `type: association` as the way to declare canonical
  association fields; update design rationale
- `specs/channels.md` — §2.1: extend the `fields:` entry schema to include metadata fields;
  add the `strict: true` opt-in; add a section on canonical schema declaration and validation
- `specs/field-mapping.md` — add section on channel canonical schema and strict validation

---

## Problem

Canonical field names exist only implicitly, scattered as `target` values across individual
connector mapping entries. There is no single place that declares what the canonical schema
for a channel looks like.

This creates three concrete gaps:

**Gap 1 — `identityFields` has no authoritative backing**
`identityFields` on the channel definition already requires canonical field names:
```yaml
channels:
  - id: contacts
    identityFields: [email]
```
`email` here is a canonical field name — but there is no declaration anywhere that `contacts`
has a canonical field called `email`. The engine can only verify that `email` appears as a
`target` in at least one mapping entry for this channel, which requires scanning all mapping
entries at load time rather than reading a channel-level declaration.

**Gap 2 — No single source of truth for the canonical schema**
To understand what fields a `contacts` channel carries canonically, you must read every
mapping entry across every `mappings/*.yaml` file and union all the `target` values. There
is no channel-level document that says "this channel has canonical fields: name, email, phone".
This is hostile to agents, UIs, and operators understanding the data model at a glance.

**Gap 3 — No place for canonical metadata**
There is currently no place to attach a description or type hint to a canonical field —
the kind of information that helps agents propose mappings and operators understand what
each canonical field means. `FieldDescriptor` (from the SDK) carries this metadata for
connector fields, but canonical fields have no equivalent.

**Gap 4 — Predicate mapping has no canonical anchor**
The predicate mapping plan (`PLAN_PREDICATE_MAPPING.md`) proposes association entries
in each mapping with a `target` canonical predicate name (e.g. `companyRef`). Without a
channel-level declaration of `companyRef`, these canonical predicate names are as implicit
and scattered as canonical field names are today. The same problem exists one layer up.
Since associations are mapped using regular field mappings, the fix is the same: declare
`companyRef` in `fields:` with `type: association`.

---

## Proposed Design

### Merge into `fields:` — one descriptor per canonical field

`fields:` entries on a channel already name each canonical field (as a record key) and carry
conflict config (`strategy`). Adding `description` and `type` to the same entry makes each
entry a full **`CanonicalFieldDescriptor`** — no new key needed, no duplication:

```yaml
channels:
  - id: contacts
    identity: [email]
    fields:
      strict: true             # reserved key — opt into strict schema validation
      name:
        description: Full display name of the contact.
        type: string
        # no strategy → default LWW applies
      email:
        description: Primary email address.
        type: string
        strategy: last_modified
      phone:
        description: Primary phone number.
        type: string
        strategy: coalesce
      companyRef:
        description: The company or organisation this contact belongs to.
        type: association     # marks this as a relational reference, not a plain data field
```

Association fields are declared in `fields:` just like any other canonical field. The
`type: association` annotation is the only distinction — it signals to the engine, playground,
and agents that this field carries a reference rather than a plain value. No separate
`associations:` block is needed.

`description` and `type` are both optional on every field entry. A channel that only wants
conflict config continues to declare `{ strategy: last_modified }` exactly as before. Adding
metadata is strictly additive — no structural change to the existing format.

### Opt-in: `strict: true`

`strict: true` is a new reserved key inside the `fields:` block (alongside the existing
`strategy` top-level key). When present, the engine enables strict target validation for
that channel: every `target` value in mapping entries must appear as a declared key in
`fields:`. Without `strict: true`, the field entries carry metadata but no validation runs —
backward-compatible with channels that already declare `fields:` only for conflict config.

### `CanonicalFieldDescriptor`

Each entry under `fields:` becomes a `CanonicalFieldDescriptor`. Its shape is a superset of
the existing conflict entry — `strategy` is now optional, `description` and `type` are new:

```typescript
interface CanonicalFieldDescriptor {
  // conflict config (previously the only content of a field entry)
  strategy?:    "coalesce" | "last_modified" | "collect" | "bool_or" | "origin_wins";
  // canonical metadata (new)
  description?: string;   // human-readable; surfaced in inspect, playground, agents
  type?:        FieldType | "association"; // "association" marks relational reference fields
}

// The record key is the canonical field name; name is not a property of the descriptor.
// fields: Record<string, CanonicalFieldDescriptor>  (existing shape, entries extended)
```

`"association"` extends the existing `FieldType` set. Association fields declared here
correspond to association mapping entries in `mappings/*.yaml` — they use the same field
mapping mechanism, just typed differently at the channel level.

The `fields:` runtime type in `ChannelConfig` stays a record. `ChannelFieldsYaml` extended:

```typescript
interface ChannelFieldsYaml {
  // existing reserved cross-field keys:
  strategy?:             "field_master" | "origin_wins";
  // new reserved key:
  strict?:               true;
  // per-field entries (any other key) — now CanonicalFieldDescriptor:
  [fieldName: string]:   CanonicalFieldDescriptor | undefined;
}
```

### Validation at load time

When a channel's `fields:` block contains `strict: true`, the engine validates:

1. Every `target` value in every mapping entry for that channel (both regular field mappings
   and association mappings) appears as a declared key in `fields:`. Unknown targets →
   validation error: `contacts mapping for crm declares target 'fullName' but 'fullName' is
   not declared in channel 'contacts' canonical fields`.
2. Every value in `identity` appears as a declared key in `fields:` (already implied, explicit).

Channels without `strict: true` in `fields:` skip target validation entirely — existing
channel configs that declare `fields:` only for conflict strategy are unaffected.
Association targets are validated by the same `strict: true` gate as regular field targets;
no separate flag or block is needed.

### What channels still do not own

- **Which connectors are members** — that comes from the mapping entries (which reference
  the channel by `id`). Channel definitions remain pure metadata; membership is still derived.
- **Per-connector field names** — those stay in `mappings/*.yaml` mapping entries.
- **Resolution strategies** — still declared as `strategy:` inside each `fields:` entry;
  the extended descriptor is additive and does not change conflict resolution behaviour.

---

## Relationship to the Predicate Mapping Plan

`PLAN_PREDICATE_MAPPING.md` proposes association entries on each mapping entry that use the
same `source`/`target` shape as regular field mappings. The canonical predicate name
(`target`) is anchored in `fields:` just like any other canonical field:

```yaml
# channel definition
fields:
  strict: true
  companyRef:
    description: The company this contact belongs to.
    type: association

# mapping entry (in mappings/*.yaml)
fields:
  - source: companyId
    target: companyRef   # validated against channel fields: when strict: true
```

The two plans are independent — predicate mapping works without canonical field declarations
(same as today). But `type: association` in `fields:` is the natural anchor for association
targets, and `strict: true` gates both regular and association targets in one place.

---

## Config Rationale Extension

The existing three-section rationale in `specs/config.md` gains a clarifying addendum:

> The `fields:` block on a channel is the single authority for canonical field metadata. Each
> entry declares the canonical field name (as the key), an optional conflict strategy, an
> optional human-readable description, and an optional type hint (including `type: association`
> for relational reference fields). Adding `strict: true` to the block enables validation that
> every `target` in every mapping entry — both plain field and association mappings — is
> declared here, making the channel definition the complete canonical schema contract.

---

## Implementation Sequence

1. **Spec update** (`specs/config.md`)
   - Extend the `fields:` entry reference table: add `description` and `type` as optional keys
   - Document `type: association` as the value for relational reference fields
   - Document `strict: true` as a new reserved key inside `fields:`
   - Extend design rationale with canonical schema paragraph

2. **Spec update** (`specs/channels.md`)
   - §2.1: extend the `ChannelFieldsYaml` interface snippet to show `strict?`, `description?`,
     `type?` on field entries; add prose explaining the reserved-key list now includes `strict`
   - Add a new section for strict schema validation

3. **Spec update** (`specs/field-mapping.md`)
   - Add section: "Channel canonical schema declaration and strict validation"

4. **Schema changes** (`packages/engine/src/config/schema.ts`)
   - Extend `FieldStrategyEntrySchema` to also allow `description?: string` and
     `type?: FieldType | "association"`
   - Add `strict` to `CONFLICT_RESERVED` so it is never treated as a field name
   - Extract the `strict` flag from the parsed data in `ConflictConfigSchema.transform` and
     carry it through to the normalised result

5. **Type / loader changes** (`packages/engine/src/config/loader.ts`)
   - `ConflictConfig` gains optional `strict?: true` and per-field `description?`/`type?`
   - Loader promotes `strict` from parsed `fields` into `ChannelConfig.conflict.strict`

6. **Validation** (config load path)
   - When `channel.conflict.strict` is true: validate all mapping `target` values (both
     regular field and association mapping entries) appear as keys in `fields:`
   - Validate `identity` entries appear in declared `fields:` keys when `strict` is true

7. **Tests**
   - `strict: true` + unknown mapping `target` → validation error
   - `strict: true` + unknown association mapping `target` → same validation error
   - `strict: true` + `identity` referencing undeclared field → validation error
   - `fields:` without `strict: true` → no validation, existing behaviour preserved
   - `description` and `type` (including `type: association`) preserved and accessible at runtime

---

## Open Questions

1. **Auto-inference as an alternative** — the engine could infer the canonical schema by
   unioning all `target` values from mapping entries, and expose it via an inspect command
   or API, without requiring declaration. This is strictly additive and does not replace
   explicit declaration (operators still can't attach descriptions to inferred canonicals),
   but it covers the discovery gap for agents. Could be a companion feature to explicit
   declaration rather than a replacement.

2. **Strict mode vs. advisory** — should undeclared `target` values be a hard error or a
   warning when the channel has `strict: true`? Hard error is simpler and makes the schema
   authoritative; warning allows incremental migration. Leaning toward hard error since
   `strict: true` is entirely opt-in — once declared, the schema should be complete.
