# PLAN: Read-only Field Declaration in FieldDescriptor

**Status:** backlog  
**Date:** 2026-04-06  
**Effort:** S  
**Domain:** packages/sdk, packages/engine  
**Scope:** FieldDescriptor, UpdateRecord/InsertRecord strip, channel pre-flight  
**Spec:** specs/connector-sdk.md  
**Depends on:** nothing  

---

## Spec changes planned

- `specs/connector-sdk.md` § Entities — add `readonly` field to `FieldDescriptor`;
  document engine strip behaviour on insert/update paths

---

## Problem

`FieldDescriptor.immutable` handles "writable on insert, frozen after creation" — a common
case for things like a record's `createdAt` or a connector-assigned stable key. It does not
cover fields that are **never writable** — not even on insert — because they are entirely
server-computed: API-assigned IDs mirrored in `data`, aggregated counts, last-modified
timestamps set by the server, denormalised display strings computed from other fields.

Today a connector author handles this by silently ignoring such fields when they appear in
`InsertRecord.data` or `UpdateRecord.data`. That works, but:

**Gap 1 — Silent failures at channel setup**
A channel mapping that routes, say, `hs_lastmodifieddate` from HubSpot into a field that
writes back to a target won't produce any error until the write silently fails or is ignored.
There is no machine-readable signal that this field cannot be written.

**Gap 2 — Agent mapping suggestions**
An agent building a channel mapping cannot tell from `FieldDescriptor` alone which fields are
meaningful targets for fan-out writes. It has to guess from `description` or try and fail.

**Gap 3 — Redundant connector boilerplate**
Every connector with server-computed fields adds the same defensive guard in its write
path:

```typescript
// ignore server-computed fields the engine may pass through
const { hs_lastmodifieddate, hs_createdate, ...writable } = record.data;
```

---

## Relationship to Existing Mechanisms

### `immutable: true`

`immutable` means "written once on insert, stripped on all subsequent updates". It is a
subset of the problem — it still allows the field to be written on insert.

`readonly: true` would mean "never written, not even on insert". The two are orthogonal:

| Flag | Insert | Update |
|------|--------|--------|
| _(neither)_ | ✓ | ✓ |
| `immutable: true` | ✓ | ✗ (stripped) |
| `readonly: true` | ✗ (stripped) | ✗ (stripped) |
| `immutable: true` **and** `readonly: true` | — redundant; `readonly` subsumes `immutable` |

### Channel config `direction`

The channel config already supports per-field `direction: reverse_only` in `FieldMapping`
(see `specs/field-mapping.md § 1.2`). This handles the *operator-configured* case: someone
setting up a channel can mark a field reverse-only so it is never written back to the source
connector.

`readonly` on `FieldDescriptor` is the *connector-declared* case: the connector author knows
this field can never be written to the API regardless of how the channel is configured. These
are complementary signals at different layers:

- `FieldDescriptor.readonly` — structural API contract declared by the connector author; engine
  enforces unconditionally
- `FieldMapping.direction` — operator intent for a specific channel; overridable per deployment

Neither replaces the other. A field can be `readonly: true` and the operator need not declare
`reverse_only` on it — the engine already strips it. A field can be `reverse_only` in config
without being `readonly` — that is an operator preference, not an API constraint.

---

## Proposed Change

Add one field to `FieldDescriptor`:

```typescript
interface FieldDescriptor {
  description?: string;
  type?: FieldType;
  required?: boolean;
  immutable?: boolean;

  /** If true, this field is server-computed and cannot be written back via insert() or update().
   *  The engine strips it from InsertRecord.data and UpdateRecord.data before calling the
   *  connector, so connector authors do not need defensive guards in their write paths.
   *
   *  Typical cases: server-assigned IDs mirrored in data, modification timestamps set by
   *  the API, aggregated counts, denormalised strings computed from other fields.
   *
   *  readonly: true subsumes immutable: true — declaring both is redundant; readonly wins. */
  readonly?: boolean;
}
```

---

## Engine Behaviour Changes

### § A — Strip on insert and update paths

When building `InsertRecord.data` for a target connector, the engine checks the target entity's
`schema` and removes any field whose `FieldDescriptor.readonly === true` before calling
`insert()`.

The same check applies to `UpdateRecord.data` before calling `update()`. This is the same
mechanism `immutable` already uses on the `update()` path — `readonly` extends it to both
paths.

No error or warning is emitted for a stripped field — the strip is silent and expected
(equivalent to how `immutable` silently strips on update).

### § B — Channel pre-flight warning

At channel setup time, if a `FieldMapping` routes a field that the target entity declares
`readonly: true`, the engine emits a pre-flight warning parallel to the existing
immutable-update warning:

```
[WARN] erp:invoice.schema['createdAt'] is readonly — it will be stripped from all writes.
       The field mapping for 'createdAt' → 'created_at' in channel 'invoices'
       will have no effect on this target.
```

### § C — Subsumption of `immutable`

If a field has both `readonly: true` and `immutable: true`, `readonly` takes precedence and
`immutable` is ignored (since readonly already strips on both paths). The engine does not warn
about this redundancy — it is valid, if unnecessary.

---

## What Does Not Change

- Fields without `readonly` behave exactly as today
- `immutable` semantics on the update path are unchanged for fields that are only `immutable`
- Channel config `FieldMapping.direction` is entirely independent; this change does not
  affect how direction is applied during the mapping pass
- `FieldDescriptor` on `ActionDefinition.schema` is unaffected — `readonly` on an action
  input has no meaning and the engine ignores it there

---

## Implementation Sequence

1. **SDK type change** (`packages/sdk/src/types.ts`)
   - Add `readonly?: boolean` to `FieldDescriptor`

2. **Spec update** (`specs/connector-sdk.md`)
   - Add `readonly` to the `FieldDescriptor` interface block and prose paragraph

3. **Engine strip path** (`packages/engine/src/engine.ts` or equivalent fan-out helper)
   - Before `insert()`: filter `InsertRecord.data` keys by `schema[key]?.readonly !== true`
   - Before `update()`: same filter applied alongside the existing `immutable` strip

4. **Engine pre-flight** (channel setup validation)
   - Warn if a `FieldMapping` targets a field declared `readonly: true` on the target entity

5. **Connector updates** (illustrative, not exhaustive)
   - `connectors/hubspot` — mark `hs_lastmodifieddate`, `hs_createdate`, `hs_object_id` as
     `readonly: true` in contact/company/deal schemas
   - `connectors/postgres` — mark auto-generated columns (`created_at`, `updated_at` where
     not user-managed) as `readonly: true`

6. **Tests**
   - Engine strips `readonly` fields from `InsertRecord.data` and `UpdateRecord.data`
   - Engine does not strip `immutable: true` (only) fields from `InsertRecord.data`
   - Pre-flight warning fires when a mapping targets a `readonly` field
   - Fields without `readonly` pass through unchanged (regression)

---

## Open Questions

1. **Connector-level vs. instance-level** — `readonly` is declared in the static `schema` and
   applies to all instances of the connector. Some APIs treat fields differently based on user
   permissions (e.g. a read-only API key yields a read-only record). Instance-level overrides
   are out of scope here; permission-sensitive connectors can omit `readonly` and handle
   stripping in their own write path.

2. **`writeonly`** — The inverse case (a field accepted by `insert()`/`update()` but never
   returned by `read()`) exists for things like password fields or write-only API tokens.
   Not included here because `schema` already describes what `read()` produces — a field
   absent from `schema` is effectively unknown to the engine on reads. A separate `writeonly`
   flag adds little over simply defining the field in a write-path comment. Can be revisited
   if a concrete use case emerges.
