# PK as Channel Field

**Status:** complete  
**Date:** 2026-04-07  
**Effort:** XS  
**Domain:** engine  
**Scope:** `packages/engine/src/engine.ts`, `specs/field-mapping.md`  
**Spec:** `specs/field-mapping.md §4`  
**Depends on:** nothing  

---

## § 1 Problem Statement

A connector's external ID (`record.id`) is the primary key as seen by OpenSync. It is used
for identity tracking but is typically **already present in `record.data`** — most connectors
include it as a regular data field alongside the other record fields.

When it is present in `record.data`, a field mapping with `source: "id"` already works today
without any engine change. No injection is needed.

However, some connectors deliberately omit the PK from `record.data` because they treat it
as a transport-layer identifier separate from payload data. In these cases `source: "id"`
produces nothing in canonical.

The fix is an optional `id_field` property on a channel member (analogous to `parent_fields`
for array expansion). When declared, the engine injects `record.id` into the stripped data
map under the given field name before `applyMapping` runs:

```yaml
- connector: erp
  channel: accounts
  entity: accounts
  id_field: erpId          # inject record.id as "erpId" into the mapping scope
  fields:
    - source: erpId
      target: erpId
      direction: forward_only
```

The full cross-connector FK pattern then requires no engine mechanism beyond this:

1. ERP declares `id_field: erpId` so `record.id = "ACC-001"` becomes available as `erpId` in mapping.
2. ERP's field mapping `source: erpId, target: erpId, direction: forward_only` writes it into canonical.
3. HubSpot maps `source: erp_account_id, target: erpId` — pointing the custom property at the
   same canonical field.
4. Both sides now share the stable string `"ACC-001"`. No UUID translation; no special engine path.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §4.1 `references` | Rewrite section. Remove UUID-translation design. Document the PK-as-field pattern: `id_field` config, when to use it vs. plain `source: "id"`, and the cross-connector FK example. Update status to "implemented". |

---

## § 3 Design

### § 3.1 Config — `id_field` on `ChannelMember`

**`config/schema.ts`** — add optional `id_field` to `ChannelMemberSchema`:

```typescript
id_field: z.string().optional(),
```

**`config/loader.ts`** — add to the `ChannelMember` interface:

```typescript
/** When set, inject `record.id` into the stripped data map under this field name
 *  before `applyMapping` runs. Use only when the connector does not include its own
 *  PK in `record.data`. If the PK is already in data, use `source: "<fieldName>"`
 *  in a field mapping directly without setting `id_field`.
 *  Spec: specs/field-mapping.md §4.1 */
idField?: string;
```

Loader wires it from `entry.id_field`.

---

### § 3.2 Engine — inject when `id_field` is set

In `engine.ts`, all call sites that build `stripped`, inject `record.id` only when
`sourceMember.idField` is declared. The connector-provided `record.data` value takes
precedence if the key already exists:

```typescript
// Before:
const stripped = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("_")));

// After:
const base = sourceMember.idField ? { [sourceMember.idField]: record.id } : {};
const stripped = Object.fromEntries(
  Object.entries({ ...base, ...raw }).filter(([k]) => !k.startsWith("_")),
);
```

### § 3.3 Call sites

| Call site | Description |
|-----------|-------------|
| `collectOnly` array expansion path (~line 316) | Parent records expanded into child elements |
| `collectOnly` standard path (~line 427) | Flat records collected for discovery |
| `_processRecords` array child path (~line 1575) | Array child ingest |
| `_processRecords` standard path (~line 1693) | Normal ingest |

(Grep `const stripped = Object.fromEntries` to find exact lines.)

---

## § 4 Edge Cases

| Case | Behaviour |
|------|-----------|
| Connector already includes PK in `record.data` | Use `source: "<fieldName>"` in a field mapping directly. Do not set `id_field` — it is unnecessary. |
| `id_field` set and connector also provides the key in `record.data` | `record.data` wins (`{ ...base, ...raw }` — data overwrites the injected value). |
| `direction: forward_only` not declared on the mapping | The PK value also flows through the outbound mapping and could be written back to the connector as a data field. Usually unwanted for a PK — user should add `direction: forward_only`. |
| Another connector maps a different string to the same canonical field | Standard conflict resolution applies; the field behaves like any other. |
| `id_field` name collides with `_`-prefixed key | Impossible — `id_field` names starting with `_` would be stripped; by convention `id_field` should be a plain field name. |

---

## § 5 Tests

- **`id_field` injection:** connector returns `record.id = "ACC-001"` with no `"erpId"` key in `record.data`; channel member declares `id_field: "erpId"`; after ingest, canonical shadow contains `erpId = "ACC-001"`.
- **`id_field` does not override connector data:** connector returns `record.id = "sys-id"` and `record.data = { erpId: "data-value" }`; channel member declares `id_field: "erpId"`; canonical shadow contains `erpId = "data-value"` (connector data wins).
- **Reverse pass excluded:** `direction: forward_only` on the `erpId` mapping prevents it from appearing in the outbound record sent back to the ERP connector.
- **Cross-connector FK via canonical field:** ERP account declares `id_field: "erpId"`, maps `source: erpId, target: erpId, direction: forward_only`; HubSpot contact maps `source: erp_account_id, target: erpId`; both canonical fields carry `"ACC-001"`; conflict resolution treats them as equal.
- **`id_field` not set — no injection:** channel member without `id_field`; `record.id` is not injected; existing behaviour unchanged (regression guard).

---

## § 6 Out of Scope

### UUID-based FK translation (`references` / `references_field`)

The previous design attempted to translate FK field values to canonical UUIDs on the
forward pass so they could be translated to each target connector's local ID on the reverse
pass. This is unnecessary for the primary use case: if the FK value is a stable string (a
PK, a domain, an ISO code), it flows through canonical unchanged and both connectors can
work with it directly.

Explicit UUID translation would be needed only when the FK value differs across systems AND
no stable shared representation exists. This case has not been observed in practice and is
deferred.

### Vocabulary targets (`vocabulary: true`)

Suppress reverse dispatch for lookup-only entities. Separate config concept; deferred.
See `specs/field-mapping.md §4.3`.
