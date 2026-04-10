# Cross-Channel Declarative Tests

**Status:** proposed  
**Date:** 2026-04-10  
**Effort:** M  
**Domain:** Engine — testing / CLI  
**Scope:** `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/core/channel-tests.ts`, `packages/engine/src/index.ts`, `specs/config.md`, `specs/cli.md`  
**Depends on:** `PLAN_INLINE_MAPPING_TESTS.md` (introduces the `tests:` key precedent and `MappingTestCase` type)  

---

## § 1 Problem Statement

Inline mapping tests (`PLAN_INLINE_MAPPING_TESTS.md §3`) cover per-entry transform logic in isolation. They cannot test the properties that users most want to verify about a real integration:

- _"If HubSpot sends `status: 'a'`, does Fiken receive `status: '1'`?"_
- _"If the ERP sends an update that only the ERP owns, does the CRM shadow remain unchanged?"_
- _"If two records arrive with the same email, are they merged into one canonical entity?"_

These require running the full engine pipeline: ingest → resolution → dispatch. Today the only way to assert these is with a `bun test` file that manually constructs a `SyncEngine` with in-memory connectors. That pattern is powerful but verbose (50–100 lines per test case) and lives outside the config, invisibly to users who only read YAML.

**Channel-level declarative tests** express these end-to-end expectations in YAML, directly alongside the mapping they document. They compile down to the same `SyncEngine`-driven execution but the scaffolding is handled by the framework.

---

## § 2 Scope — What is tested

A channel test drives one full engine cycle with synthetic connector payloads and asserts on
what the engine dispatched (inserts/updates/deletes) to a named target connector.

```
Inputs  →  [engine: ingest + resolve + dispatch]  →  Observed outputs
```

**In scope:**

- Field transforms (expressions, value maps) end-to-end — both passes in one assertion
- Resolution strategies (coalesce, lww, field masters) under multi-source input
- Identity matching: `email`-based merge, compound groups
- Transitive-closure merge across 3+ connectors
- Association remapping across connectors
- `record_filter` / `reverse_filter` routing
- Soft-delete and delete propagation
- Value-map round-trips (A → canonical → B)

**Out of scope:**

- Real network I/O (tests use synthetic in-memory payloads)
- Array expansion / collapse (complexity; deferred — see §8)
- Multi-cycle tests (only one ingest → dispatch round; deferred — see §8)
- Schema enforcement (`required` / `immutable`) — covered separately

---

## § 3 YAML Syntax

Channel tests live in a top-level `channel_tests:` key that can appear in any mappings file.

```yaml
# mappings/contacts.yaml

mappings:
  - connector: crm
    channel: contacts
    entity: contacts
    fields:
      - { source: email,      target: email }
      - { source: status,     target: status, value_map: { a: active, b: inactive } }
      - { source: firstName,  target: firstName }

  - connector: erp
    channel: contacts
    entity: employees
    fields:
      - { source: email,      target: email }
      - { source: statusCode, target: status, value_map: { '1': active, '2': inactive } }
      - { source: name,       target: firstName }

channel_tests:
  - description: CRM record arrives → dispatched to ERP with code translation
    channel: contacts
    given:
      - connector: crm
        records:
          - id: c1
            data: { email: alice@example.com, status: a, firstName: Alice }
    expect:
      - connector: erp
        inserts:
          - data: { email: alice@example.com, statusCode: '1', name: Alice }

  - description: ERP record arrives → dispatched to CRM with code translation
    channel: contacts
    given:
      - connector: erp
        records:
          - id: e1
            data: { email: bob@example.com, statusCode: '2', name: Bob }
    expect:
      - connector: crm
        inserts:
          - data: { email: bob@example.com, status: b, firstName: Bob }

  - description: same email → one canonical entity (identity merge)
    channel: contacts
    given:
      - connector: crm
        records:
          - id: c1
            data: { email: alice@example.com, firstName: Alice, status: a }
      - connector: erp
        records:
          - id: e1
            data: { email: alice@example.com, name: Alice, statusCode: '1' }
    expect:
      - connector: crm
        inserts: []       # CRM already contributed — no insert back to itself
      - connector: erp
        inserts: []       # ERP already contributed — no insert back to itself

  - description: CRM is field master for status — ERP update does not overwrite it
    channel: contacts
    given:
      - connector: crm
        records:
          - id: c1
            data: { email: alice@example.com, status: a }
      - connector: erp
        records:
          - id: e1
            data: { email: alice@example.com, statusCode: '2' }   # ERP tries inactive
    expect:
      - connector: erp
        inserts:
          - data: { statusCode: '1' }   # CRM master wins: active → '1', even after ERP sent '2'
```

### § 3.1 Test case keys

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `description` | string | no | Human-readable label |
| `channel` | string | yes | Channel ID to run the test against |
| `given` | array | yes | Synthetic connector payloads (see §3.2) |
| `expect` | array | yes | Assertions on dispatched operations (see §3.3) |

### § 3.2 `given` — synthetic input

Each element provides a batch of records as if returned by a connector's `read()`:

| Key | Type | Description |
|-----|------|-------------|
| `connector` | string | Connector ID (must exist in `opensync.json`) |
| `records` | array | List of `{ id, data, updatedAt?, deleted? }` |

`updatedAt` is an ISO 8601 timestamp string. When absent, the engine uses the test fixture
time (a constant synthetic timestamp). This is important for `last_modified` resolution.

`deleted: true` triggers delete propagation when the channel has `propagate_deletes: true`.

Connectors not listed in `given` for a test case are treated as returning empty batches.

### § 3.3 `expect` — output assertions

Each element asserts on what the engine dispatched to a connector:

| Key | Type | Description |
|-----|------|-------------|
| `connector` | string | Connector ID |
| `inserts` | array? | List of `{ data }` partial-match assertions on dispatched inserts |
| `updates` | array? | List of `{ data }` partial-match assertions on dispatched updates |
| `deletes` | array? | List of `{ id }` assertions on dispatched deletes |

**Partial match:** the same semantics as inline mapping tests — only the keys present in the
assertion object are checked. Extra keys in the actual dispatched payload are ignored.

**List count match:** the length of the `inserts` / `updates` / `deletes` array must equal
the number of actual dispatched operations for that action type on that connector. An empty
list (`inserts: []`) asserts that no inserts were dispatched.

**Unordered matching:** when more than one item appears in an assertion list, the engine
matches each assertion against the closest actual record (best-match by field coverage) rather
than requiring positional alignment. This makes tests resilient to non-deterministic dispatch
ordering.

---

## § 4 Execution Model

Channel tests run a full, isolated `SyncEngine` instance per test case using an in-memory
SQLite database. No state leaks between test cases.

```
for each test case:
  1. Build a ResolvedConfig for config.channels[test.channel] only
     (exclude other channels — prevents cross-channel resolution noise)
  2. Build one in-memory stub connector per connector in config.connectors:
       - read(): yields test.given[connector].records (or empty if absent)
       - insert() / update() / delete(): capture results into a log
  3. openDb(":memory:")
  4. SyncEngine(config, db)
  5. Run: ingest all members → discover → onboard
  6. Collect captured inserts / updates / deletes per connector
  7. Assert against test.expect (partial match + count match)
```

Key isolation properties:
- Each test case has its own `SyncEngine` + `db` instance (no shared SQLite state).
- Identity resolution happens fresh per case; there is no "previous cycle" state unless the
  test explicitly seeds it (multi-cycle support is deferred, see §8).
- The `readTimeoutMs` is set to a generous constant (e.g. 10 000 ms) for all test runs.

---

## § 5 Schema Changes — `channel_tests:` key

### § 5.1 New schemas in `schema.ts`

```typescript
const ChannelTestRecordSchema = z.object({
  id: z.string(),
  data: z.record(z.string(), z.unknown()),
  updatedAt: z.string().optional(),
  deleted: z.boolean().optional(),
});

const ChannelTestGivenSchema = z.object({
  connector: z.string(),
  records:   z.array(ChannelTestRecordSchema),
});

const ChannelTestExpectEntrySchema = z.object({
  connector: z.string(),
  inserts: z.array(z.object({ data: z.record(z.string(), z.unknown()) })).optional(),
  updates: z.array(z.object({ data: z.record(z.string(), z.unknown()) })).optional(),
  deletes: z.array(z.object({ id:   z.string()                        })).optional(),
});

const ChannelTestCaseSchema = z.object({
  description: z.string().optional(),
  channel:     z.string(),
  given:       z.array(ChannelTestGivenSchema),
  expect:      z.array(ChannelTestExpectEntrySchema),
});
```

`MappingsFileSchema` gains:

```typescript
channel_tests: z.array(ChannelTestCaseSchema).optional(),
```

### § 5.2 Types in `loader.ts`

`MappingsFileSchema` and the corresponding parsed representation. Channel test cases are stored
on `ResolvedConfig`:

```typescript
export interface ChannelTestRecord {
  id: string;
  data: Record<string, unknown>;
  updatedAt?: string;
  deleted?: boolean;
}

export interface ChannelTestCase {
  description?: string;
  channel: string;
  given: Array<{ connector: string; records: ChannelTestRecord[] }>;
  expect: Array<{
    connector: string;
    inserts?: Array<{ data: Record<string, unknown> }>;
    updates?: Array<{ data: Record<string, unknown> }>;
    deletes?: Array<{ id: string }>;
  }>;
}
```

`ResolvedConfig` gains:

```typescript
channelTests?: ChannelTestCase[];
```

`loadConfig()` populates this from the merged mappings files without any compilation step —
test cases are plain data.

---

## § 6 Test Runner — `runChannelTests()`

New file: `packages/engine/src/core/channel-tests.ts`.

Imports: `SyncEngine`, `openDb`, `ResolvedConfig`. No imports from `bun:*` (uses the
standard `Database` adapter pattern already used by the engine).

```typescript
export interface ChannelTestFailure {
  type:      "count" | "field";
  connector: string;
  action:    "inserts" | "updates" | "deletes";
  index?:    number;     // position of the matched actual record
  field?:    string;     // field key (for "field" failures)
  expected:  unknown;
  actual:    unknown;
}

export interface ChannelTestResult {
  pass:        boolean;
  description?: string;
  channel:     string;
  failures:    ChannelTestFailure[];
}

export async function runChannelTests(config: ResolvedConfig): Promise<ChannelTestResult[]>;
```

The runner is async because `SyncEngine` methods (`ingest`, `discover`, `onboard`) are async.

### § 6.1 Stub connector construction

For each `connector` entry in `config.connectors`, build a stub that:
- `getEntities()` returns one entity per entity name appearing in the channel's members for
  this connector, plus insert/update/delete capture stubs.
- `read()` yields the test's `given` records for this connector (empty batch if absent in `given`).
- `insert()` / `update()` / `delete()` capture dispatched payloads and yield plausible success
  results (insert returns a new UUID; update returns the same ID).

The entity names used in the stub are read from the `ResolvedConfig` channel members, not from
the YAML test case itself. This ensures the stub surface matches the config's declared contract.

### § 6.2 Partial match helper

```typescript
function partialMatch(
  expected: Record<string, unknown>,
  actual:   Record<string, unknown>,
): ChannelTestFailure[] { ... }
```

Same `JSON.stringify` deep-equality used by inline mapping tests (§5 of `PLAN_INLINE_MAPPING_TESTS.md`).

### § 6.3 Best-match unordered matching

When `expect.inserts` has more than one item, match each assertion to the actual insert whose
`data` has the most matching fields (greedy by field-hit count). This prevents order-sensitive
failures when the engine dispatch order is non-deterministic.

---

## § 7 CLI Command: `opensync test-channels`

New command (separate from `opensync test-mappings`):

```
$ opensync test-channels
Running channel tests…

  contacts  —  CRM record arrives → dispatched to ERP with code translation
    ✓ erp inserts (1)
    ✓ erp updates (0)

  contacts  —  same email → one canonical entity (identity merge)
    ✓ crm inserts (0)
    ✓ erp inserts (0)

  contacts  —  CRM is field master for status → ERP update does not overwrite
    ✗ erp inserts count: expected 1  actual 1
         statusCode: expected "1"  actual "2"

3 tests · 2 passed · 1 failed
```

Exit code `0` when all tests pass; `1` on any failure.

**Options:**

```
$ opensync test-channels --channel contacts
$ opensync test-channels --root /path/to/dir
```

A combined command `opensync test` that runs both `test-mappings` and `test-channels` in
sequence (exit `1` if either fails) is worth adding but is a CLI-layer convenience — not
a prerequisite for this plan.

---

## § 8 Deferred Scope

| Item | Reason for deferral |
|------|---------------------|
| Array expansion / collapse tests | Stub entity construction becomes complex when the channel has expansion chains. Design requires separate thought. |
| Multi-cycle tests | A `given_cycle_2:` / `expect_cycle_2:` extension is conceivable (persist state between cycles) but the sequencing and watermark semantics are non-trivial. |
| Association assertions | `expect.inserts[].associations` is useful but requires surfacing associations in the captured dispatch payload. Deferred pending `PLAN_ASSOCIATION_EVENTS.md` output format stabilisation. |
| Cross-channel entity references in `given` | A test for association remapping requires seeding entities in a *different* channel. Deferred — needs a `seed_channel:` key or similar; complex ordering. |

---

## § 9 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/config.md` | (new section after `mappings/*.yaml`) | Document `channel_tests:` key, all sub-keys, assertion semantics |
| `specs/cli.md` | Commands | Add `opensync test-channels` (and `opensync test` combined) |

No changes to `specs/field-mapping.md` or `specs/sync-engine.md` — this is purely a testing
surface on top of existing behaviour.

---

## § 10 Implementation Steps

1. Add schemas in §5.1 to `schema.ts`; extend `MappingsFileSchema`.
2. Add types in §5.2 to `loader.ts`; populate `ResolvedConfig.channelTests` in `loadConfig()`.
3. Create `packages/engine/src/core/channel-tests.ts` with `runChannelTests()`.
4. Export `runChannelTests`, `ChannelTestResult`, `ChannelTestFailure` from `index.ts`.
5. Add `opensync test-channels` CLI command.
6. Write tests in `packages/engine/src/core/channel-tests.test.ts` covering:
   - Single-source insert dispatch (CT1)
   - Two-source identity merge → no echo back to contributors (CT2)
   - Value-map round-trip A→canonical→B (CT3)
   - `coalesce` resolution: priority-1 value wins when both sources present (CT4)
   - Field-count assertion failure (CT5)
   - Field-value assertion failure (CT6)
   - Unordered matching: two inserts matched regardless of dispatch order (CT7)
   - Empty `given` connector treated as empty batch (CT8)
   - Empty `inserts: []` asserts no inserts dispatched (CT9)
7. Update `specs/config.md` and `specs/cli.md`.
