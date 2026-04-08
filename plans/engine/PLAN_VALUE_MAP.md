# Value Maps — Declarative Enum / Code Translation

**Status:** proposed  
**Date:** 2026-04-08  
**Effort:** S  
**Domain:** Engine — field mapping  
**Scope:** `packages/engine/src/config/loader.ts`, `packages/engine/src/config/schema.ts`, `packages/engine/src/core/mapping.ts`, `specs/field-mapping.md`, `specs/config.md`  

---

## § 1 Problem Statement

Different systems use different codes for the same canonical concept.  A CRM stores `status: "a"`
while the ERP stores `status: "1"`, and both mean _active_.  A third system may have `status:
"ACTIVE"`.  The canonical form should be a stable, readable value (e.g. `"active"`) that is
independent of any one connector's representation.

Today the only way to translate these is with a field `expression` / `reverse_expression`:

```yaml
fields:
  - source: status
    target: status
    expression: "({ a: 'active', b: 'inactive', c: 'closed' }[record.status] ?? record.status)"
    reverse_expression: "({ active: 'a', inactive: 'b', closed: 'c' }[record.status] ?? record.status)"
```

This works, but it is noisy, error-prone (the reverse map must be maintained manually in parallel),
and offers no machine-readable structure for validation or visualisation.

A dedicated `value_map` key directly solves this problem with a concise, declarative YAML block.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §1 | Add new §1.10 "Value maps" between existing §1.9 and §2 |
| `specs/config.md` | Field whitelist semantics | Document `value_map`, `reverse_value_map`, `value_map_fallback` in the field keys table |

---

## § 3 Design

### § 3.1 Core semantics

Each connector's mapping entry declares its own `value_map` that translates between that
connector's local codes and the shared canonical vocabulary.

```yaml
# System A uses 'a' / 'b' / 'c'
- connector: crm
  channel: contacts
  entity: contacts
  fields:
    - source: status
      target: status
      value_map:
        'a': 'active'
        'b': 'inactive'
        'c': 'closed'

# System B uses '1' / '2' / '3'
- connector: erp
  channel: contacts
  entity: customers
  fields:
    - source: status
      target: status
      value_map:
        '1': 'active'
        '2': 'inactive'
        '3': 'closed'
```

**Forward pass** (source → canonical): `value_map[sourceValue]`. If the source value is absent
from the map, the `value_map_fallback` governs the result (see §3.2).

**Reverse pass** (canonical → source): `reverse_value_map[canonicalValue]` if declared;
otherwise the auto-inverted map derived from `value_map` at load time (see §3.4). If the
canonical value is absent from the reverse map, `value_map_fallback` applies.

The direction guard (`direction: forward_only` / `reverse_only`) applies **before** the value
map step.  A `reverse_only` field never has its `value_map` evaluated on the forward pass; a
`forward_only` field never has its reverse map evaluated.

---

### § 3.2 `value_map_fallback`

| Value | Behaviour when the lookup key is absent |
|-------|----------------------------------------|
| `"passthrough"` (default) | Return the original value unchanged |
| `"null"` | Return `null` |

`"passthrough"` is the safe default: unmapped values are preserved rather than silently corrupted.
`"null"` is useful when an unmapped code from a source should be treated as unknown / absent.

```yaml
    value_map:
      'a': 'active'
      'b': 'inactive'
    value_map_fallback: 'null'   # 'c' or any unknown code → null
```

---

### § 3.3 `reverse_value_map`

When `value_map` is bijective (no two source keys share the same canonical value), the engine
auto-derives the reverse at load time.  When the forward map is many-to-one (multiple source
codes map to the same canonical value), auto-inversion is ambiguous and an explicit
`reverse_value_map` must be declared:

```yaml
    value_map:
      'a': 'active'
      'A': 'active'    # both 'a' and 'A' map to canonical 'active'
    reverse_value_map:
      'active': 'a'    # explicit: always write 'a' back to source
```

If the map is not bijective **and** `reverse_value_map` is absent, the engine emits a **config
warning** at load time and uses the last-encountered key as the tie-break (declaration order).
The sync continues normally; validate your maps to silence the warning.

---

### § 3.4 Mutual exclusivity with `expression`

`value_map` and `expression` are **mutually exclusive** on the same field entry.  Both perform a
similar value transformation; combining them would create an ambiguous execution order.  Use
`expression` (which can embed an object literal lookup) when richer logic is needed.

The engine raises a config error at load time when both are declared.

---

### § 3.5 YAML config syntax (full reference)

```yaml
fields:
  - source: status
    target: status
    # Translate source codes to canonical codes on the forward pass.
    # Keys are source values (coerced to string for lookup); values are canonical values.
    value_map:
      'a': 'active'
      'b': 'inactive'
      'c': 'closed'

    # Optional — explicit canonical-to-source translation on the reverse pass.
    # Required when value_map is not bijective.
    # If absent, the engine auto-inverts value_map at load time.
    reverse_value_map:
      'active': 'a'
      'inactive': 'b'
      'closed': 'c'

    # Optional — governs behaviour when a value is not found in the map.
    # 'passthrough' (default): keep the original value.
    # 'null': convert to null.
    value_map_fallback: 'passthrough'
```

---

### § 3.6 TypeScript embedded API

```ts
import { FieldMapping } from "@opensync/engine";

const field: FieldMapping = {
  source: "status",
  target: "status",
  valueMap: { a: "active", b: "inactive", c: "closed" },
  reverseValueMap: { active: "a", inactive: "b", closed: "c" },   // optional
  valueMapFallback: "passthrough",   // optional; default
};
```

The YAML key is snake_case (`value_map`, `reverse_value_map`, `value_map_fallback`); the
TypeScript API uses camelCase (`valueMap`, `reverseValueMap`, `valueMapFallback`).  Both compile
to the same `FieldMapping` shape, consistent with the existing `expression` / `reverse_expression`
/ `reverseExpression` pattern.

---

## § 4 Implementation

### § 4.1 Type changes — `FieldMapping` in `loader.ts`

```typescript
export interface FieldMapping {
  // ... existing fields ...

  /** Forward value map: source code → canonical code.
   *  Applied after expression (if any) on the inbound pass.
   *  Mutually exclusive with expression.
   *  Spec: specs/field-mapping.md §1.10 */
  valueMap?: Record<string, unknown>;

  /** Reverse value map: canonical code → source code.
   *  Applied on the outbound pass.  Auto-derived from valueMap if absent.
   *  Spec: specs/field-mapping.md §1.10 */
  reverseValueMap?: Record<string, unknown>;

  /** Behaviour when a value is absent from the map.
   *  "passthrough" (default) | "null"
   *  Spec: specs/field-mapping.md §1.10 */
  valueMapFallback?: "passthrough" | "null";
}
```

Auto-inversion is computed once in the loader (or in `buildMapping()`) and stored on the
`FieldMapping` object so there is zero per-record overhead:

```typescript
if (m.valueMap && !m.reverseValueMap) {
  const inverse: Record<string, unknown> = {};
  let collision = false;
  for (const [k, v] of Object.entries(m.valueMap)) {
    const key = String(v);
    if (key in inverse) collision = true;
    inverse[key] = k;
  }
  if (collision) {
    // Emit config warning; last-wins is already in `inverse` due to iteration order
    console.warn(`[opensync] value_map on field "${m.target}" is not bijective; ` +
      `declare reverse_value_map explicitly to silence this warning.`);
  }
  m.reverseValueMap = inverse;
}
```

### § 4.2 Schema changes — `FieldMappingEntrySchema` in `schema.ts`

```typescript
value_map: z.record(z.string(), z.unknown()).optional(),
reverse_value_map: z.record(z.string(), z.unknown()).optional(),
value_map_fallback: z.enum(["passthrough", "null"]).optional(),
```

The loader maps snake_case YAML keys to camelCase `FieldMapping` fields (consistent with
`reverse_expression` → `reverseExpression`).  Mutual exclusivity with `expression` / `reverse_expression`
is checked in the loader after parsing:

```typescript
if (entry.value_map && (entry.expression || entry.reverse_expression)) {
  throw new Error(`Field "${entry.target ?? entry.source}": value_map and expression are mutually exclusive.`);
}
```

### § 4.3 Logic changes — `applyMapping()` in `mapping.ts`

**Inbound pass** — after the value is resolved from `expression` or source-key lookup, apply the
forward map:

```typescript
// Spec: specs/field-mapping.md §1.10 — value map (forward)
if (m.valueMap !== undefined && value !== undefined && value !== null) {
  const key = String(value);
  if (key in m.valueMap) {
    value = m.valueMap[key];
  } else if (m.valueMapFallback === "null") {
    value = null;
  }
  // else: passthrough — value unchanged
}
```

**Outbound pass** — after the value is resolved from `reverse_expression` or canonical-key
lookup, apply the reverse map (which is always populated at this point, either declared or
auto-derived):

```typescript
// Spec: specs/field-mapping.md §1.10 — value map (reverse)
if (m.reverseValueMap !== undefined && value !== undefined && value !== null) {
  const key = String(value);
  if (key in m.reverseValueMap) {
    value = m.reverseValueMap[key];
  } else if (m.valueMapFallback === "null") {
    value = null;
  }
  // else: passthrough — value unchanged
}
```

Null and undefined values bypass the map lookup entirely and propagate as-is, consistent with
the handling throughout the mapping pipeline.

---

## § 5 Tests

Test IDs are prefixed `VM` to avoid collisions.

| ID | Scenario |
|----|----------|
| VM1 | Forward map: source value present in map → translated canonical value |
| VM2 | Forward map: source value absent, fallback=passthrough → original value |
| VM3 | Forward map: source value absent, fallback=null → null |
| VM4 | Forward map: null source value → null (map not consulted) |
| VM5 | Reverse map (explicit): canonical value present → source code |
| VM6 | Reverse map (auto-inverted bijective): canonical value present → source code |
| VM7 | Auto-inversion collision → config warning; last-wins |
| VM8 | Round-trip: two connectors with disjoint code spaces both translate to same canonical |
| VM9 | Mutual exclusivity: expression + value_map at config load → error |
| VM10 | direction=reverse_only: value_map skipped on forward pass; applied on reverse |
| VM11 | direction=forward_only: reverse map skipped on outbound |
| VM12 | normalize + value_map: normalize applied first, value_map translates normalised result |

Tests live in `packages/engine/src/core/mapping.test.ts`.

---

## § 6 Spec Update — `specs/field-mapping.md §1.10`

New section to insert between §1.9 (per-field timestamps) and §2 (Resolution Strategies):

```
### 1.10 Value maps

Per-field translation tables that map source-local codes to canonical codes on the forward pass,
and back on the reverse pass. Solves the common pattern where two systems use different string or
numeric codes for the same concept (e.g. `"a"` in CRM vs `"1"` in ERP both meaning _active_).

[YAML syntax block from §3.5 above]

Auto-inversion, mutual exclusion with expression, and fallback semantics are described in the plan.

**Status: proposed (PLAN_VALUE_MAP.md).**
```

---

## § 7 Out of Scope (Future)

- **Named / shared maps** — define a `value_maps:` block at the top of a mappings file and
  reference maps by name inside field entries.  This avoids repeating the same code table across
  multiple connector entries.  Scope this as a follow-on once the core primitive is live.

- **Case-insensitive lookup** — a `value_map_case_insensitive: true` flag.  Trivially layered on
  top once the base feature exists.

- **Numeric key coercion** — YAML parses `1:` as an integer key.  The current design coerces
  all keys to string via `String(key)` before lookup, which handles this transparently.
  Document this behaviour in the spec.
