# Field Sources: Runtime Enforcement

**Status:** proposed  
**Date:** 2026-04-07  
**Effort:** S  
**Domain:** Engine — field mapping  
**Scope:** `packages/engine/src/config/loader.ts`, `packages/engine/src/core/mapping.ts`, `packages/engine/src/engine.ts`, `specs/field-mapping.md`  
**Depends on:** [plans/engine/PLAN_REVERSE_DEFAULT_SOURCES.md](PLAN_REVERSE_DEFAULT_SOURCES.md)  

---

## § 1 Problem Statement

Three expression fields on `FieldMapping` accept source-declaration companions as lineage hints
(implemented or planned by `PLAN_REVERSE_DEFAULT_SOURCES.md`):

| Expression | Receives | Declaration field |
|---|---|---|
| `expression` | full incoming source record | `sources?: string[]` |
| `reverseExpression` | full canonical record (outbound) | `reverseSources?: string[]` |
| `defaultExpression` | partially-built canonical record (inbound, fields-so-far) | `defaultSources?: string[]` |

None of these declarations have any runtime effect today: all three expressions receive the full
record they would receive without a declaration. This means:

- An expression can quietly read a field not listed in its declaration without any error. The
  lineage diagram then lies about data dependencies.
- There is no way to author an expression that is **provably** isolated to a declared field set.
- Parent field aliases injected by `parentFields` land in the flat source record. There is no
  explicit enforcement that only declared aliases are accessed.
- The connector-side external ID (`record.id`) is not accessible to `expression` at all — it is
  stripped before `applyMapping()` runs.

---

## § 2 Spec Changes Planned

### `specs/field-mapping.md §1.3` — change `sources` from hint to enforced scope

Replace the current paragraph that says "`sources` … is a declaration for tooling … and has no
effect at runtime" with the following semantics:

1. **When `sources` is present and `expression` is set**: the expression receives a scoped record
   containing **only** the fields named in `sources`.  Attempting to read any other key from the
   record yields `undefined`, as if the field did not exist.  This is a strict enforcement, not a
   lint warning.

2. **When `sources` is absent and `expression` is set** (opt-out): the expression receives the
   full incoming record, preserving the current behavior and allowing gradual adoption.

3. **Special token `"id"`**: listing `"id"` in `sources` injects the connector-side external ID
   (the value of `ConnectorRecord.id`) into the expression scope under the key `"id"`.  This is
   the only way to access the record ID inside an expression without a connector-side mapping.

4. **Parent field aliases**: fields injected by `parentFields` are merged into the element data
   record before `applyMapping()` is called (handled by `expandArrayRecord` / `expandArrayChain`).
   Their aliases therefore behave as regular field names and can be listed in `sources` normally.
   No special handling is needed.

Update the `reverseSources` paragraph added by `PLAN_REVERSE_DEFAULT_SOURCES.md` similarly: when
`reverseSources` is present and `reverseExpression` is set, the expression receives a scoped
canonical record containing only the listed canonical field names. Opt-out when absent.

Update the `defaultSources` paragraph added by `PLAN_REVERSE_DEFAULT_SOURCES.md`: when
`defaultSources` is present and `defaultExpression` is set, the fallback expression receives a
scoped record containing only the listed keys from the partially-built canonical record. Opt-out
when absent.

No other spec files require changes.

---

## § 3 Design

### § 3.1 `applyMapping()` signature — `mapping.ts`

Add an optional fourth parameter:

```ts
export function applyMapping(
  data: Record<string, unknown>,
  mappings: FieldMappingList | undefined,
  pass: "inbound" | "outbound",
  id?: string,   // connector-side record.id; injected when "id" ∈ m.sources
): Record<string, unknown>
```

The `id` parameter is only consumed on the inbound pass.

### § 3.2 Forward-pass enforcement logic — `applyMapping()`

**`expression` scope (inbound):**
```
if m.expression:
  if m.sources is present:
    scope = {}
    for each name in m.sources:
      if name === "id":
        scope["id"] = id          // inject record ID
      else:
        scope[name] = data[name]  // undefined when key is absent — intentional
    value = m.expression(scope)
  else:
    value = m.expression(data)    // existing behaviour — full record
```

**`defaultExpression` scope (inbound, fallback branch):**
```
if m.defaultExpression:
  if m.defaultSources is present:
    scope = {}
    for each name in m.defaultSources:
      scope[name] = result[name]  // result = partially-built canonical record (fields so far)
    value = m.defaultExpression(scope)
  else:
    value = m.defaultExpression(result)   // existing behaviour — full partial record
```

### § 3.3 Outbound-pass enforcement logic — `applyMapping()`

**`reverseExpression` scope (outbound):**
```
if m.reverseExpression:
  const input = m.reverseSources is present
    ? Object.fromEntries(m.reverseSources.map(k => [k, data[k]]))
    : data                        // existing behaviour — full canonical record
  const v = m.reverseExpression(input)
  // decompose / scalar assign as before
```

The scoped record for all three cases is a plain `Record<string, unknown>` built at call time.
No Proxy, no getter traps, no throw on missing keys — undeclared keys yield `undefined`.

### § 3.4 Call-site changes — `engine.ts`

Every inbound `applyMapping(…, sourceMember.inbound, "inbound")` call must forward the record's
external ID:

```ts
// Before
const canonical = applyMapping(stripped, sourceMember.inbound, "inbound");

// After
const canonical = applyMapping(stripped, sourceMember.inbound, "inbound", record.id);
```

Affected call sites (non-exhaustive — grep for `"inbound"` in engine.ts):
- flat-record path (~line 368)
- array-child path (~line 341)
- cross-channel expansion flat path (~line 1713)
- cross-channel expansion child path (~line 1619)

Outbound call sites are unchanged.

### § 3.5 JSDoc updates — `loader.ts`

Update the three JSDoc comments to reflect enforcement semantics (types are unchanged — all are
already `string[] | undefined`):

**`sources`** (inbound expression scope):
```ts
/** Connector-side field names (and the special token `"id"`) that `expression` is allowed to read.
 *
 * When present: `applyMapping()` builds a scoped record with exactly these keys.
 * Any field not listed yields `undefined` inside the expression. Also drives lineage arrows.
 *
 * When absent: `expression()` receives the full incoming record (opt-out).
 *
 * Parent field aliases from `parentFields` are merged before mapping runs and can be listed here.
 *
 * Spec: specs/field-mapping.md §1.3 */
sources?: string[];
```

**`reverseSources`** (outbound expression scope, added by prerequisite plan):
```ts
/** Canonical field names that `reverseExpression` is allowed to read.
 *
 * When present: `applyMapping()` builds a scoped canonical record with exactly these keys.
 * Any field not listed yields `undefined` inside the expression.
 *
 * When absent: `reverseExpression()` receives the full canonical record (opt-out).
 *
 * Spec: specs/field-mapping.md §1.3 */
reverseSources?: string[];
```

**`defaultSources`** (inbound default-fallback scope, added by prerequisite plan):
```ts
/** Canonical field names (already mapped in this pass) that `defaultExpression` is allowed to read.
 *
 * When present: `applyMapping()` builds a scoped partial-canonical record with exactly these keys.
 * Any field not listed yields `undefined` inside the expression.
 *
 * When absent: `defaultExpression()` receives the full partially-built canonical record (opt-out).
 *
 * Spec: specs/field-mapping.md §1.5 */
defaultSources?: string[];
```

---

## § 4 Test Plan

All new tests go in `packages/engine/src/core/mapping.test.ts`.

**`expression` / `sources`:**

| ID | Scenario | Pass | Declaration | Expected |
|----|----------|------|-------------|----------|
| SC1 | `sources` present — only listed field visible | inbound | `sources: ["firstName"]` | expression sees `{ firstName: "Alice" }`, not `lastName` |
| SC2 | `sources` present — unlisted field silently `undefined` | inbound | `sources: ["firstName"]` | `record.lastName` inside expression is `undefined` |
| SC3 | `sources` absent — full record visible | inbound | none | expression receives all fields (existing behavior) |
| SC4 | `"id"` token — record ID injected | inbound | `sources: ["id"]` | expression receives `{ id: "ext-123" }` |
| SC5 | `"id"` + data field — both in scope | inbound | `sources: ["id", "email"]` | expression receives `{ id: "ext-123", email: "a@b.com" }` |
| SC6 | parent alias in `sources` — accessible | inbound | `sources: ["orderId"]` | pre-merged alias is in scope |
| SC7 | `sources` present, no `expression` — no effect | inbound | `sources: ["email"]` | normal source-key rename runs unchanged |

Tests SC4–SC5 require passing a non-`undefined` `id` argument to `applyMapping()`.
Test SC6 requires a pre-merged data record (simulating `expandArrayRecord` output).

**`reverseExpression` / `reverseSources`:**

| ID | Scenario | Pass | Declaration | Expected |
|----|----------|------|-------------|----------|
| RS1 | `reverseSources` present — only listed canonical field visible | outbound | `reverseSources: ["firstName"]` | expression sees `{ firstName: "Alice" }`, not `lastName` |
| RS2 | `reverseSources` present — unlisted field silently `undefined` | outbound | `reverseSources: ["firstName"]` | `record.lastName` inside expression is `undefined` |
| RS3 | `reverseSources` absent — full canonical record visible | outbound | none | existing behavior preserved |
| RS4 | `reverseSources` present, no `reverseExpression` — no effect | outbound | `reverseSources: ["email"]` | normal target-key rename runs unchanged |

**`defaultExpression` / `defaultSources`:**

| ID | Scenario | Pass | Declaration | Expected |
|----|----------|------|-------------|----------|
| DS1 | `defaultSources` present — only listed partial-canonical field visible | inbound (fallback) | `defaultSources: ["email"]` | defaultExpression sees `{ email: "a@b.com" }`, not other fields |
| DS2 | `defaultSources` present — unlisted field silently `undefined` | inbound (fallback) | `defaultSources: ["email"]` | other already-mapped fields are `undefined` |
| DS3 | `defaultSources` absent — full partial-canonical record visible | inbound (fallback) | none | existing behavior preserved |

DS1–DS3 require a mapping list where `email` appears before the field with `defaultExpression`
so it is present in the partial-canonical record at invocation time.

---

## § 5 Non-Goals

- Config-file (YAML/JSON) expression evaluation or serialisation of `sources` / `reverseSources` /
  `defaultSources` at that level — expressions are TypeScript-only.
- Any Proxy-based trap or throw on undeclared access — silent `undefined` is sufficient and avoids
  surprise for expressions that conditionally read optional fields.
- A `"id"` token for `reverseSources` or `defaultSources` — neither expression works with a
  connector-side external ID.

---

## § 6 Migration

Since OpenSync has not had a public release, there are no third-party callers to protect.  The
change from hint → enforced is breaking for any internal expression that reads fields not listed in
`sources`.  The fix at each such call site is simply to add the missing field names to `sources`.

Expressions that currently omit `sources` entirely are **unaffected** (opt-out path, § 3.2).
