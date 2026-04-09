# PLAN: Require Explicit Field Mapping

**Status:** proposed  
**Date:** 2026-04-09  
**Effort:** XS  
**Domain:** Engine — field mapping  
**Scope:** `packages/engine`, `specs/field-mapping.md`, `specs/config.md`  

---

## Problem

When a mapping entry omits `fields`, the engine currently passes all fields through
verbatim ("implicit passthrough"). This produces a confusing result in the playground
and in real configs: data silently flows between two connectors purely because their
field names happen to coincide — with no indication in the config that any mapping was
intended.

Minimal example that triggers the bug:

```yaml
channels: []
mappings:
  - connector: crm
    entity: contacts
    channel: person
  - connector: erp
    entity: employees
    channel: person
```

All fields named `firstName`, `email`, `phone`, etc. are forwarded from `crm` to `erp`
(and back) even though the author wrote no `fields` list at all. The engine interprets
"no fields" as "all fields" — exactly backwards from the principle of least surprise.

---

## Principle

**Every field that crosses a connector boundary must be explicitly named.**

There is no "passthrough" mode. Even when two connectors happen to use the same field
name, that coincidence must be stated in the config — silence is never consent for
data movement. This principle exists for three reasons:

1. **Correctness** — two connectors sharing a field name (`id`, `status`, `name`) does
   not mean those fields represent the same concept. Implicit passthrough hides
   semantic mismatches until data is already corrupted.

2. **Canonical schema discipline** — the config is the declaration of the canonical
   schema. If a field is not listed it does not exist in the canonical model. Authors
   who skip `fields` have not defined a canonical model; the engine must refuse to act
   as if they have.

3. **No shortcut encourages good design** — a `passthrough` escape hatch would
   encourage treating one connector's schema as implicitly canonical and pressures
   every other connector to match it. That is the opposite of hub-and-spoke: it makes
   one spoke the de-facto hub.

---

## Proposed Change

### Absent `fields` = empty whitelist

Change the semantics so that a mapping entry without a `fields` key behaves as if
`fields: []` were written — i.e., the entry contributes no data fields to the canonical
entity. The entry still participates in identity linking (its records create/join
canonical entities); it just writes nothing to and reads nothing from the canonical
field store.

There is no `passthrough` key and no way to bypass explicit field listing.

---

## Spec Changes Planned

| File | Section | Change |
|------|---------|--------|
| `specs/field-mapping.md` | §1.1 Field rename and whitelist | Update the "If `fields` is omitted…" note: absent = empty whitelist. Remove the passthrough-convenience note. Add principle statement. |
| `specs/config.md` | Field whitelist semantics | Same update. |
| `AGENTS.md` | Section 3 — Technical invariants | Add invariant: every field that crosses a connector boundary must be explicitly declared in `fields`. |

---

## Implementation

### 1. Loader (`packages/engine/src/config/loader.ts`)

In `buildChannelsFromEntries()`, change the logic that sets `inbound`/`outbound`:

```ts
// BEFORE
const inbound  = entry.fields ? buildInbound(entry.fields)  : undefined;
const outbound = entry.fields ? buildOutbound(entry.fields) : undefined;

// AFTER
const inbound  = entry.fields ? buildInbound(entry.fields)  : [];
const outbound = entry.fields ? buildOutbound(entry.fields) : [];
```

(Empty array is the existing signal for "keep nothing".)

> Verify that `applyMapping(data, [])` already returns `{}` — if not, fix that edge
> case as part of this work.

### 2. Tests

- Add a test: mapping entry with no `fields` → no data fields forwarded (identity
  link still formed).
- Update any existing test that uses a no-`fields` entry and relies on the implicit
  passthrough — add an explicit `fields` list to each.

### 3. Playground and demo examples

Audit `playground/src/` and `demo/examples/` for YAML configs that rely on the
implicit passthrough and add explicit `fields` lists where
needed.

---

## Non-Goals

- No new UI affordance in the playground for this — the YAML error message is
  sufficient.
- No migration tooling — pre-release; callers fix their configs.
- No deprecation warning period — change is immediate.
