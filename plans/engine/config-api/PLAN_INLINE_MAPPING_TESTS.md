# Inline Mapping Tests

**Status:** rejected  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** Engine — field mapping / CLI  
**Scope:** `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/core/mapping-tests.ts`, `packages/engine/src/index.ts`, `specs/field-mapping.md`, `specs/config.md`, `specs/cli.md`  
**Superseded by:** `PLAN_CROSS_CHANNEL_DECLARATIVE_TESTS.md`  

---

## § 0 Rejection Rationale

Every inline mapping test can be expressed as a cross-channel test (`PLAN_CROSS_CHANNEL_DECLARATIVE_TESTS.md`)
with a single-record `given` and a single-connector `expect`. The cross-channel form is strictly
more realistic — it runs through direction guards, resolution, and the actual dispatch path —
and users only have to learn one test syntax. The co-location and attribution arguments for
inline tests are marginal; a failing cross-channel test identifies the mapping entry via the
`channel` + `connector` context. If per-expression isolation proves valuable in practice,
inline tests can be revisited then.

---

## § 1 Problem Statement

Mapping configs routinely contain non-trivial field expressions, value maps, and reverse
transforms. Today there is no way to assert that they behave correctly without running a full
sync cycle against live data. Regressions in mapping logic are silent until they corrupt a
production record.

Two gaps:

1. **No inline documentation of expected behaviour.** A mapping author cannot write "given
   `status: 'a'` from the CRM, this entry should produce `status: 'active'` in the canonical
   record" and have that expectation enforced.

2. **No unit test entry-point short of the full engine.** Testing a value map or expression
   requires spinning up connectors, shadow state, and identity resolution just to exercise a
   two-line transform.

Inline mapping tests solve both: a `tests:` key on any mapping entry declares input/expected
pairs that are runnable without a live data source. They double as executable documentation and
regression guards for complex transform logic.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | (new) | Add §9 "Inline mapping tests" |
| `specs/config.md` | `mappings/*.yaml — Field Mappings` | Document `tests:` key on mapping entries |
| `specs/cli.md` | Commands | Add `opensync test-mappings` command |

---

## § 3 Design

### § 3.1 YAML syntax

A `tests:` array is added to any mapping entry. Each element is a **test case**:

```yaml
- connector: crm
  channel: contacts
  entity: contacts
  fields:
    - source: status
      target: status
      value_map: { a: active, b: inactive, c: closed }
    - source: firstName
      target: firstName
    - source: lastName
      target: lastName
    - target: fullName
      sources: [firstName, lastName]
      expression: "`${record.firstName} ${record.lastName}`"
      reverse_expression: >-
        ({
          firstName: record.fullName.split(' ')[0],
          lastName:  record.fullName.split(' ').slice(1).join(' ')
        })

  tests:
    - description: maps status code and derives fullName
      input: { status: a, firstName: Jane, lastName: Doe }
      expected: { status: active, fullName: Jane Doe }

    - description: does not emit unmapped fields
      input: { status: b, firstName: Bob, lastName: Smith, internal: secret }
      expected: { status: inactive }

    - description: reverse maps status code
      direction: outbound
      input: { status: active, fullName: Jane Doe }
      expected: { status: a, firstName: Jane, lastName: Doe }
```

Test case keys:

| Key | Type | Description |
|-----|------|-------------|
| `description` | string? | Human-readable label shown in test output |
| `direction` | `inbound` \| `outbound` | Which pass to run. Default: `inbound` |
| `input` | `Record<string, unknown>` | Source record (inbound) or canonical record (outbound) |
| `expected` | `Record<string, unknown>` | Expected canonical record (inbound) or expected target record (outbound). **Partial match**: only the keys present in `expected` are asserted; extra keys in the actual output are ignored |

### § 3.2 Assertion semantics

The assertion is a **partial record match** using deep structural equality:

- For each key `k` in `expected`: `deepEqual(actual[k], expected[k])` must be true.
- Keys present in `actual` but absent from `expected` are irrelevant to the test.
- `deepEqual` uses `JSON.stringify`-based parity (same as the engine's noop diff approach).
  This is consistent with how the engine itself compares values at diff time.

Partial matching is intentional: mapping entries that produce many fields should not require
the test author to list every generated field — only the ones relevant to the test's intent.

### § 3.3 TypeScript embedded API

Users constructing `ChannelMember` directly in TypeScript also benefit. The `tests?` field
is added to `ChannelMember` and accepts the same `MappingTestCase[]` structure:

```typescript
{
  connectorId: "crm",
  entity: "contacts",
  inbound: [
    { source: "status", target: "status",
      valueMap: { a: "active", b: "inactive" } },
  ],
  tests: [
    { description: "maps active status",
      input: { status: "a" },
      expected: { status: "active" } },
    { description: "reverse maps active status",
      direction: "outbound",
      input: { status: "active" },
      expected: { status: "a" } },
  ],
}
```

### § 3.4 What `tests:` does NOT cover

- **Resolution strategy testing** — multiple sources resolving to a canonical value involves
  identity mapping, timestamps, and priority ordering. That is a channel-level concern, not a
  mapping-entry concern. Per-field `resolve` functions can be tested at the entry level since
  they operate on a single inbound pass.
- **`normalize` testing** — `normalize` is a diff-time comparator, not a pass-through
  transform. It is not applied by `applyMapping()` and therefore not exercised here.
- **Full-cycle / cross-channel tests** — covered by `PLAN_CROSS_CHANNEL_DECLARATIVE_TESTS.md`,
  which supersedes this plan. Any test expressible here can be expressed there with a
  single-record `given` and a single-connector `expect`.

---

## § 4 Schema Changes

### § 4.1 `MappingTestCaseSchema` in `schema.ts`

```typescript
const MappingTestCaseSchema = z.object({
  description: z.string().optional(),
  direction: z.enum(["inbound", "outbound"]).default("inbound"),
  input:    z.record(z.string(), z.unknown()),
  expected: z.record(z.string(), z.unknown()),
});
```

`MappingEntrySchema` gains one new optional key:

```typescript
tests: z.array(MappingTestCaseSchema).optional(),
```

### § 4.2 `MappingTestCase` and `ChannelMember` in `loader.ts`

New exported type:

```typescript
export interface MappingTestCase {
  description?: string;
  direction: "inbound" | "outbound";   // "inbound" when not specified in YAML
  input:    Record<string, unknown>;
  expected: Record<string, unknown>;
}
```

`ChannelMember` gains:

```typescript
tests?: MappingTestCase[];
```

The loader copies the compiled test array from `MappingEntry` → `ChannelMember` verbatim (no
compilation step; tests are plain data).

---

## § 5 Test Runner

### § 5.1 `runMappingTests()` in `packages/engine/src/core/mapping-tests.ts`

New file. No dependencies on the database, network, or connector layer.

```typescript
import { applyMapping } from "./mapping.js";
import type { ResolvedConfig } from "../config/loader.js";

export interface MappingTestFailure {
  field:    string;
  expected: unknown;
  actual:   unknown;
}

export interface MappingTestResult {
  pass:        boolean;
  description?: string;
  direction:   "inbound" | "outbound";
  channelId:   string;
  connectorId: string;
  entity:      string;
  expected:    Record<string, unknown>;
  actual:      Record<string, unknown>;
  failures:    MappingTestFailure[];
}

export function runMappingTests(config: ResolvedConfig): MappingTestResult[] { ... }
```

Algorithm:

```
results = []
for each channel in config.channels:
  for each member in channel.members:
    if !member.tests: continue
    for each test in member.tests:
      mappings = test.direction === "inbound" ? member.inbound : member.outbound
      actual = applyMapping(test.input, mappings, test.direction)
      failures = []
      for each [key, expectedVal] in Object.entries(test.expected):
        if !deepEqual(actual[key], expectedVal):
          failures.push({ field: key, expected: expectedVal, actual: actual[key] })
      results.push({ pass: failures.length === 0, ... })
return results
```

`deepEqual(a, b)` is implemented as `JSON.stringify(a) === JSON.stringify(b)`, consistent with
the engine's existing diff comparisons.

### § 5.2 `runMappingTests()` export from `packages/engine/src/index.ts`

`runMappingTests` and `MappingTestResult` / `MappingTestFailure` are exported from the engine
package index so that CLI authors and third-party tooling can call them directly without
importing from internal paths.

---

## § 6 CLI Command: `opensync test-mappings`

New command added to `specs/cli.md`:

```
$ opensync test-mappings
Running mapping tests…

  contacts — crm (inbound)
    ✓ maps status code and derives fullName
    ✓ does not emit unmapped fields

  contacts — crm (outbound)
    ✗ reverse maps status code
        status:  expected "a"  actual "active"

  orders — erp (inbound)
    ✓ maps line count

4 tests · 3 passed · 1 failed
```

Exit code `0` when all tests pass; `1` when any test fails (suitable for CI).

**Options:**

```
$ opensync test-mappings --channel contacts   # run only tests in the "contacts" channel
$ opensync test-mappings --connector crm      # run only tests for a specific connector
$ opensync test-mappings --root /path/to/dir  # project root (default: cwd)
```

---

## § 7 Implementation Steps

1. Add `MappingTestCaseSchema` to `schema.ts`; extend `MappingEntrySchema` with `tests`.
2. Add `MappingTestCase` type and `tests?` to `ChannelMember` in `loader.ts`; populate in the
   YAML → `ChannelMember` compilation pass.
3. Create `packages/engine/src/core/mapping-tests.ts` with `runMappingTests()`.
4. Export `runMappingTests`, `MappingTestResult`, `MappingTestFailure` from `index.ts`.
5. Add `opensync test-mappings` CLI command.
6. Write tests in `packages/engine/src/core/mapping-tests.test.ts` covering:
   - Inbound pass: value_map, expression, default
   - Outbound pass: reverse_expression, reverse_value_map
   - Partial match: extra actual keys do not fail the test
   - Type mismatch and absent field failures
   - `connectorId` / `entity` / `channelId` present in results
   - Empty test suite returns empty results
7. Update `specs/field-mapping.md`, `specs/config.md`, `specs/cli.md`.

---

## § 8 Test Suite Structure (test file)

Tests for the runner itself live in `packages/engine/src/core/mapping-tests.test.ts`. They
construct `ResolvedConfig` objects directly (no YAML loading) and assert on `MappingTestResult[]`.

| ID | Scenario |
|----|----------|
| MT1 | Single inbound value_map test — pass |
| MT2 | Single inbound value_map test — fail (wrong expected) |
| MT3 | Inbound expression test |
| MT4 | Outbound reverse_expression test |
| MT5 | Partial match: extra actual key not in expected → still passes |
| MT6 | Missing actual key that is in expected → fails |
| MT7 | `description` propagated to result |
| MT8 | Member with no `tests` is skipped |
| MT9 | All failures collected per test (not short-circuit on first) |
| MT10 | deepEqual on number vs string `"1"` vs `1` (fails — not coerced) |
