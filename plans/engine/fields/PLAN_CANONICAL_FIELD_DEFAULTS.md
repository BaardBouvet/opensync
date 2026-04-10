# Canonical Field Defaults

**Status:** draft  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** Engine — field mapping, channel config  
**Scope:** `specs/field-mapping.md`, `specs/config.md`, `packages/engine/src/config/loader.ts`, `packages/engine/src/config/schema.ts`, `packages/engine/src/engine.ts`  
**Depends on:** `plans/engine/config-api/PLAN_CHANNEL_CANONICAL_SCHEMA.md`  

---

## § 1 Problem Statement

Per-field `default` and `defaultExpression` (§1.5 in `specs/field-mapping.md`) are declared inside
a connector's mapping entry. They fire during the forward pass when *that connector's* source field
is absent or null. They are per-connector fallbacks.

After conflict resolution, the merged canonical record can still contain null or absent values — for
example when every contributing connector returns null for a field. There is no current mechanism to
supply a value in that case without adding `default` to every individual connector's mapping entry,
which is error-prone and scatters the responsibility.

A **canonical field default** is declared once on the channel's canonical field schema
(`CanonicalFieldDescriptor`) and applied after `resolveConflicts()` returns, before the resolved
canonical record is used for dispatch. It acts as a system-level fallback of last resort, after all
per-connector defaults and all priority/coalesce logic have run.

### § 1.1 Relationship to mapping-level defaults

| Mechanism | Declaration site | When applied | Scope |
|-----------|-----------------|--------------|-------|
| `default` / `defaultExpression` on a field mapping entry | `mappings/*.yaml` per connector | Forward pass inside `applyMapping()` | Only when *this connector's* value is absent/null |
| `default` / `defaultExpression` on a `CanonicalFieldDescriptor` | `channels.yaml` per canonical field | After `resolveConflicts()` | When the *resolved* canonical value is absent/null across all connectors |

The two layers are complementary. A connector-level default fills the gap before the record enters
conflict resolution. A canonical default fills the gap that remains after resolution.

### § 1.2 Motivating examples

```yaml
channels:
  - id: contacts
    fields:
      - name: status
        default: "active"      # every new contact starts active until any connector says otherwise

      - name: displayName
        # dynamic: fall back to first+last if direct displayName is never provided
        defaultExpression: "`${record.firstName ?? ''} ${record.lastName ?? ''}`.trim()"
        defaultSources: [firstName, lastName]
```

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | New §1.11 | Canonical field defaults: declare `default` / `defaultExpression` on `CanonicalFieldDescriptor`; applied after resolution |
| `specs/config.md` | `channels.yaml` / canonical field descriptor table | Add `default` and `default_expression` to the `CanonicalFieldDescriptor` YAML syntax and key reference table |

No changes to `specs/safety.md`, `specs/sync-engine.md`, or connector specs — canonical defaults
are entirely within the engine's mapping pipeline.

---

## § 3 Design

### § 3.1 Type additions — `CanonicalFieldDescriptor` in `loader.ts`

`CanonicalFieldDescriptor` (defined as part of `PLAN_CHANNEL_CANONICAL_SCHEMA.md`) gains two
optional fields:

```typescript
export interface CanonicalFieldDescriptor {
  name:         string;
  description?: string;
  type?:        FieldType;
  /** Static fallback applied to the resolved canonical value when it is absent or null after
   *  conflict resolution. Applied before dispatch. Mutually exclusive with defaultExpression.
   *  Spec: specs/field-mapping.md §1.11 */
  default?: unknown;
  /** Dynamic fallback function applied to the resolved canonical value when it is absent or null
   *  after conflict resolution. Receives the partially-built resolved canonical record (fields
   *  already processed in declaration order). Mutually exclusive with default.
   *  Spec: specs/field-mapping.md §1.11 */
  defaultExpression?: (record: Record<string, unknown>) => unknown;
  /** Canonical field names (already resolved) that `defaultExpression` reads from the
   *  partially-built resolved record. Declaration for tooling; matches the `defaultSources`
   *  semantics on per-field mappings.
   *  Spec: specs/field-mapping.md §1.11 */
  defaultSources?: string[];
}
```

### § 3.2 Zod schema — `schema.ts`

`CanonicalFieldSchema` gains:

```typescript
default: z.unknown().optional(),
default_expression: z.string().optional(),  // compiled via new Function at load time
```

`defaultExpression` is function-valued; the string form `default_expression` is the YAML-reachable
version. At load time, a string `default_expression` is compiled:

```typescript
if (entry.default_expression !== undefined) {
  try {
    descriptor.defaultExpression = new Function("record", `return (${entry.default_expression})`) as
      (record: Record<string, unknown>) => unknown;
  } catch (e) {
    throw new Error(`Channel '${channelId}' canonical field '${entry.name}': invalid default_expression: ${e}`);
  }
}
```

`default` and `default_expression` are mutually exclusive — validated at load time with a clear
error message.

### § 3.3 Application point — `engine.ts`

After each `resolveConflicts()` call (both the main path and the child-entity path), apply
canonical field defaults when the channel declares a `fields` array:

```typescript
// Spec: specs/field-mapping.md §1.11 — canonical field defaults
const resolved = resolveConflicts(...);
applyCanonicalDefaults(resolved, channel, resolvedSoFar);
```

The helper `applyCanonicalDefaults()` lives in a new function (or inline) adjacent to the
resolution call:

```typescript
function applyCanonicalDefaults(
  resolved: Record<string, unknown>,
  channel: ChannelConfig,
  // snapshot of already-processed canonical fields for defaultExpression
): void {
  if (!channel.fields) return;
  for (const descriptor of channel.fields) {
    if (resolved[descriptor.name] !== null && resolved[descriptor.name] !== undefined) continue;
    if (descriptor.defaultExpression) {
      resolved[descriptor.name] = descriptor.defaultExpression(resolved);
    } else if (descriptor.default !== undefined) {
      resolved[descriptor.name] = descriptor.default;
    }
  }
}
```

Fields are iterated in declaration order, consistent with how per-field mapping defaults work.
`defaultExpression` receives the `resolved` record as it exists at that point in iteration, so
earlier canonical fields are accessible (same pattern as `defaultExpression` in `applyMapping()`).

### § 3.4 Guard: no effect during outbound pass

Canonical defaults are applied to the resolved canonical record before outbound dispatch. They do
not change how mapping `applyMapping("outbound")` works — that pass translates the (now-defaulted)
canonical value back to connector-local form exactly as today.

### § 3.5 Interaction with `resolveConflicts` zero-key guard

The zero-key skip guard (`if (!Object.keys(resolved).length && existingTargetId !== undefined)`)
must run **after** canonical defaults are applied, not before. By the time the guard evaluates,
canonical defaults may have added keys to an otherwise empty resolved record. The application point
in §3.3 ensures this ordering.

### § 3.6 Tests

New test group `CDF` in `packages/engine/src/core/` (or an integration test in `engine.ts`
depending on where `applyCanonicalDefaults` lands):

| ID | Scenario |
|----|----------|
| CDF1 | Canonical field absent after resolution → static `default` applied |
| CDF2 | Canonical field null after resolution → static `default` applied |
| CDF3 | Canonical field has value after resolution → `default` NOT applied |
| CDF4 | `defaultExpression` computes from an earlier canonical field already in the resolved record |
| CDF5 | Both `default` and `defaultExpression` absent → field remains absent (no change) |
| CDF6 | Channel has no `fields` array → no canonical defaults applied (fast path) |
| CDF7 | `default` and `default_expression` both present → load-time error |
| CDF8 | `default_expression` compile failure → load-time error with channel/field name in message |

---

## § 4 Implementation Sequence

1. **Spec updates** (do first, per spec-driven development rule)
   - `specs/field-mapping.md`: add §1.11 Canonical field defaults
   - `specs/config.md`: extend `CanonicalFieldDescriptor` YAML syntax with `default` and
     `default_expression`

2. **Type additions** (`packages/engine/src/config/loader.ts`)
   - Extend `CanonicalFieldDescriptor` with `default`, `defaultExpression`, `defaultSources`
   - This depends on `PLAN_CHANNEL_CANONICAL_SCHEMA.md` having been implemented first

3. **Zod schema** (`packages/engine/src/config/schema.ts`)
   - Add `default` and `default_expression` to `CanonicalFieldSchema`
   - Compile `default_expression` to function at load time
   - Mutual-exclusion validation

4. **Engine application point** (`packages/engine/src/engine.ts`)
   - Add `applyCanonicalDefaults()` helper
   - Call it after each `resolveConflicts()` invocation (both paths)
   - Ensure zero-key guard runs after defaults are applied

5. **Tests** — CDF1–CDF8

6. **Changelog** and index updates

---

## § 5 Open Questions

- **`defaultExpression` YAML string form** — `default_expression` is a JS expression string
  compiled via `new Function("record", ...)`. The binding `record` is the partially-resolved
  canonical record at iteration time, same as the inline `defaultExpression` TypeScript API.
  Should we also expose a `defaultSources` YAML key to scope which fields are visible? Decision:
  **yes**, include `default_sources: [field1, field2]` in the Zod schema alongside
  `default_expression`, mirroring the existing `defaultSources` design from
  `PLAN_REVERSE_DEFAULT_SOURCES.md`.

- **`defaultExpression` TypeScript API only (no YAML) vs. YAML-string form** — per the
  constitutional invariant "every engine mapping feature must be reachable from YAML config",
  a YAML `default_expression` string form is required before this is considered complete.
  Include it from the start.
