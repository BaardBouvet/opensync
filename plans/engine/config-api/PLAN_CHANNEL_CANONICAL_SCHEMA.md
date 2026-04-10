# PLAN: Canonical Field Schema on Channel Definitions

**Status:** draft  
**Date:** 2026-04-06  
**Effort:** M  
**Domain:** Engine, Config  
**Scope:** `specs/config.md`, `specs/field-mapping.md`, `packages/engine/src/config/`  
**Depends on:** nothing  

---

## Spec changes planned

- `specs/config.md` — `mappings/channels.yaml` section: add `fields` and `associations`
  to the channel definition; update design rationale
- `specs/field-mapping.md` — add section on channel canonical schema declaration and
  validation against mapping entries

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
The predicate mapping plan (`PLAN_PREDICATE_MAPPING.md`) proposes `associations` entries
in each mapping with a `target` canonical predicate name (e.g. `companyRef`). Without a
channel-level declaration of `companyRef`, these canonical predicate names are as implicit
and scattered as canonical field names are today. The same problem exists one layer up.

---

## Proposed Design

### Channel definition gains `fields` and `associations`

```yaml
channels:
  - id: contacts
    identityFields: [email]

    # Canonical field schema for this channel.
    # All target values in mapping entries for this channel must appear here.
    fields:
      - name: name
        description: Full display name of the contact.
        type: string
      - name: email
        description: Primary email address.
        type: string
      - name: phone
        description: Primary phone number.
        type: string

    # Canonical association schema for this channel.
    # All target values in association mapping entries must appear here.
    associations:
      - name: companyRef
        description: The company or organisation this contact belongs to.
```

Both arrays are optional — a channel with neither behaves exactly as today. `identityFields`
values must appear in `fields` when `fields` is declared (validation error if absent).

### `CanonicalFieldDescriptor`

Canonical fields use a lightweight descriptor — a subset of the connector-side `FieldDescriptor`
that carries only the metadata relevant to the canonical layer:

```typescript
interface CanonicalFieldDescriptor {
  name:         string;   // canonical field name (matches target in mapping entries)
  description?: string;   // human-readable description for agents and operators
  type?:        FieldType; // same JSON-Schema-subset type as FieldDescriptor
}

interface CanonicalAssociationDescriptor {
  name:         string;   // canonical predicate name (matches target in association mapping entries)
  description?: string;
}
```

### Validation at load time

When a channel declares `fields`, the engine validates:

1. Every `target` value in every mapping entry for that channel appears in `fields.name`.
   Unknown targets → validation error: `contacts mapping for crm declares target 'fullName'
   but 'fullName' is not declared in channel 'contacts' canonical fields`.
2. Every value in `identityFields` appears in `fields.name` (already implied, made explicit).

When a channel declares `associations`:

3. Every `target` value in every association mapping entry for that channel appears in
   `associations.name`. Unknown targets → same pattern of validation error.

This validation is **opt-in by declaration** — channels without `fields` or `associations`
arrays skip validation entirely. Adding the arrays is a progressive adoption path.

### What channels still do not own

- **Which connectors are members** — that comes from the mapping entries (which reference
  the channel by `id`). Channel definitions remain pure metadata; membership is still derived.
- **Per-connector field names** — those stay in `mappings/*.yaml` mapping entries.
- **Resolution strategies / conflict config** — already on the channel, unchanged.

---

## Relationship to the Predicate Mapping Plan

`PLAN_PREDICATE_MAPPING.md` proposes `associations` entries on each mapping entry:
```yaml
associations:
  - source: companyId
    target: companyRef
```

`companyRef` here is a canonical predicate name that, without this plan, is only defined
implicitly by its appearance in multiple mapping files. With this plan, the channel declares:
```yaml
associations:
  - name: companyRef
    description: The company this contact belongs to.
```

The two plans are independent — predicate mapping works without canonical association
declarations (same as field mapping works today without canonical field declarations).
But the same gap applies to both, and declaring canonicals on the channel is the correct fix
for both simultaneously.

---

## Config Rationale Extension

The existing three-section rationale in `specs/config.md` gains a clarifying addendum:

> Channels declare the **canonical schema** — the field and association names that all
> connected systems agree on. Mapping entries translate each connector's local names into
> that shared vocabulary. A connector mapping entry is invalid if it references a canonical
> name the channel does not declare (when the channel has declared its schema). This makes
> the channel definition the authoritative contract: operators can read one channel block
> to understand what the sync ring carries, without reading every mapping file.

---

## Implementation Sequence

1. **Spec update** (`specs/config.md`)
   - Add `fields` and `associations` to the channel definition YAML syntax and examples
   - Extend design rationale with canonical schema paragraph

2. **Spec update** (`specs/field-mapping.md`)
   - Add section: "Channel canonical schema declaration and validation"

3. **Type additions** (`packages/engine/src/config/loader.ts`)
   - Add `CanonicalFieldDescriptor` and `CanonicalAssociationDescriptor` interfaces
   - Extend `ChannelConfig` with optional `fields?: CanonicalFieldDescriptor[]` and
     `associations?: CanonicalAssociationDescriptor[]`

4. **Zod schema additions** (`packages/engine/src/config/schema.ts`)
   - Add `CanonicalFieldSchema` and `CanonicalAssociationSchema`
   - Extend `ChannelSchema` with the new optional arrays

5. **Validation** (config load path)
   - When channel declares `fields`: validate all mapping `target` values are declared
   - When channel declares `associations`: validate all association mapping `target` values
   - Validate `identityFields` entries appear in declared `fields`

6. **Tests**
   - Validation rejects unknown `target` value when channel declares `fields`
   - Validation rejects unknown association `target` when channel declares `associations`
   - `identityFields` referencing an undeclared canonical field is a validation error
   - Channels without `fields`/`associations` load and run without validation (regression)

---

## Open Questions

1. **Auto-inference as an alternative** — the engine could infer the canonical schema by
   unioning all `target` values from mapping entries, and expose it via an inspect command
   or API, without requiring declaration. This is strictly additive and does not replace
   explicit declaration (operators still can't attach descriptions to inferred canonicals),
   but it covers the discovery gap for agents. Could be a companion feature to explicit
   declaration rather than a replacement.

2. **Strict mode vs. advisory** — should undeclared `target` values be a hard error or a
   warning when the channel has a `fields` array? Hard error is simpler and makes the schema
   authoritative; warning allows incremental migration. Leaning toward hard error since the
   declaration is entirely opt-in — once you've opted in, the schema should be complete.
