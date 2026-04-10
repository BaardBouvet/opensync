# Plan: Connector Conformance Test Harness

**Status:** draft  
**Date:** 2026-04-10  
**Effort:** M  
**Domain:** connectors  
**Scope:** `packages/sdk/`, each `connectors/<name>/` and `dev/connectors/<name>/`  
**Spec changes planned:** `specs/connector-sdk.md` — new § "Conformance Test Harness"  

---

## Goal

Provide a reusable, schema-driven test harness that verifies any connector implementation
satisfies the OpenSync connector contract without requiring the test author to write
repetitive CRUD boilerplate.

The harness is exercised against a live (or mock) instance of the target API.  It is **not**
a unit-test replacement — it sits at the integration level and confirms that the connector's
actual HTTP calls behave as the SDK contract requires.

---

## Motivation

Every connector currently has a hand-rolled `index.test.ts` that re-implements the same
scaffolding: spin up a server, make a context, insert a record, read it back, verify the
result.  This creates:

1. **Inconsistent coverage** — some connectors test ETag semantics, most don't; some test
   partial-update safety, most don't.
2. **Regression risk** — a new connector author can ship a connector that passes its
   bespoke tests but violates the contract (e.g. blanks fields on a partial update).
3. **Maintenance drag** — every invariant added to the SDK contract must be retrofitted
   into every connector's test file individually.

A shared harness shifts the burden: adding a new invariant to the harness automatically
covers every connector that opts in.

---

## Conformance Cases

The harness runs each case that is applicable to an entity given its declared
capabilities (`insert`, `update`, `delete`) and schema (`required`, `immutable`, `entity`).

### C1 — Insert round-trip

1. Insert a minimal valid record (using `example` values from the schema where available).
2. Read all records; assert the new record appears with the same field values.
3. Optionally: `lookup()` the returned ID and assert the same values come back.

### C2 — Partial-update safety

1. Insert a record with all known fields populated.
2. Update it with only **one** field changed — leave all others absent from `data`.
3. Read / lookup the record; assert that every field that was **not** sent in the update
   still holds its original value (field blanking regression guard).

### C3 — Immutable field enforcement

*Skipped when no schema fields are marked `immutable: true`.*

1. Insert a record.
2. Attempt to update it with a payload that includes an immutable field value.
3. The engine is supposed to strip immutable fields before the update reaches the
   connector, but the harness verifies at the connector level: the field must not appear
   in the record returned by a subsequent read.  (The harness sends the update **directly**
   to the connector, bypassing the engine, to test the raw HTTP behaviour.)

### C4 — Required field rejection

*Skipped when no schema fields are marked `required: true`.*

1. Attempt to insert a record with a required field omitted.
2. Assert that `InsertResult.error` is set (connector-level validation) **or** the HTTP
   request fails with a 4xx error mapped to an `InsertResult.error`.  Either is acceptable
   — the harness confirms the failure is visible rather than a silent null write.

### C5 — ETag / conditional-write semantics

*Skipped when the entity does not implement `lookup()` or the connector does not declare
ETag support via a future `conditionalWrite: true` flag on `EntityDefinition`.*

1. Insert a record.
2. `lookup()` it to obtain the `version` token.
3. Update successfully with the matching `version`.
4. Attempt a second update using the now-stale `version`; assert `UpdateResult.error`
   is set (i.e. the 412 path is handled properly).

### C6 — Delete and absence

*Skipped when `delete` is not implemented.*

1. Insert a record.
2. Delete it by ID.
3. Assert `DeleteResult.notFound` is **not** set (it did exist).
4. Attempt to delete the same ID again; assert `DeleteResult.notFound` is set.
5. Read all records; assert the ID no longer appears.

### C7 — Watermark / incremental read

*Skipped when `read` is not implemented.*

1. Insert record A.  Capture a watermark by doing a full read.
2. Insert record B after the watermark timestamp.
3. Read with `since = <captured watermark>`; assert B appears and A does not.

### C8 — Dependency ordering (FK references)

*Skipped when no `EntityDefinition.dependsOn` is declared and no schema fields declare `entity`.*

1. The harness resolves the dependency graph declared by `dependsOn`.
2. It creates parent entities first (e.g. company before contact).
3. It then creates a child entity referencing the parent's assigned ID.
4. It reads back the child and asserts the FK field holds a valid ID that points to
   the parent.
5. Cleanup deletes in reverse dependency order: children first, then parents.

### C9 — Cleanup / teardown

After every case (or in an `afterAll` block):

1. Delete every record created during the test run, in reverse dependency order.
2. Confirm deletion via read / lookup — the test must not leave dangling data in the
   live system.
3. If `delete` is not available for an entity, emit a warning listing the IDs that
   remain and advising the user to clean them up manually.

---

## API Design

The harness is exported from `@opensync/sdk` as a single function:

```typescript
import { runConnectorConformance } from '@opensync/sdk/testing';

runConnectorConformance({
  /** The connector under test. */
  connector,

  /** A ready-to-use ConnectorContext (auth already applied). */
  makeCtx: async () => ConnectorContext,

  /**
   * Seed data factory: called once per entity to produce a minimal valid insert payload.
   * The harness uses `example` values from the schema as defaults; this override allows
   * connectors (or test authors) to supply values for fields without examples or for
   * fields that require uniqueness (timestamps, random strings, etc.).
   */
  fixtures?: {
    [entityName: string]: () => Record<string, unknown>;
  },

  /**
   * Entities to skip entirely — useful when a live sandbox prohibits certain mutations
   * (e.g. delete is rejected by the target API in test mode).
   */
  skip?: string[],

  /**
   * Optional reset hook called before each case.  Use it when the backing server
   * provides a /__reset endpoint (as mock-crm and mock-erp do).
   */
  beforeEach?: () => Promise<void>,
});
```

`runConnectorConformance` must be called at the top level of a describe block (or as a
top-level call in a Bun test file) so that individual cases register as proper `it()` entries
and appear individually in the test reporter.

Internally the function calls `describe(connector.metadata.name, () => { ... })` and
generates one `it()` per case × entity combination.

---

## Fixture Generation Strategy

When a `fixtures` override is absent for an entity the harness generates a minimal fixture
automatically:

1. Walk each field in `schema`.
2. If `example` is set: use that value.
3. Else if `type` is `'string'`: generate `"test-<fieldName>-<randomHex>"`.
4. Else if `type` is `'number'`: generate `0`.
5. Else if `type` is `'boolean'`: generate `false`.
6. Skip `immutable` fields in insert payloads (the server assigns them).
7. Skip fields with `entity` (FK references) — these are filled in during C8 after parents
   are created.

The random suffix on string values prevents uniqueness collisions when the same field has
a unique constraint on the target API.  The suffix is seeded from the test run's start time
so two parallel runs (CI + local) do not collide.

---

## Dependency Graph Resolution

The harness calls `connector.getEntities(ctx)` and builds a DAG from `dependsOn`.  It
topologically sorts the entities so:

- Cases that create records process entities in dependency order (parents first).
- Cleanup processes entities in reverse order (children first).

Circular dependencies are detected and cause the harness to throw a configuration error
before any test runs.

---

## Implementation Location

| File | Role |
|------|------|
| `packages/sdk/src/testing.ts` | `runConnectorConformance` implementation |
| `packages/sdk/src/index.ts` | Re-export via `export * from './testing.js'` (or separate entry-point `@opensync/sdk/testing`) |

A separate entry-point (`/testing`) is preferred so production connector bundles that
import from `@opensync/sdk` do not pull in the test framework dependency (`bun:test`).

---

## Spec Changes Planned

`specs/connector-sdk.md` — add a new section after the existing "Example Connectors" note:

```
## § N  Conformance Test Harness

### § N.1  Purpose
### § N.2  runConnectorConformance API
### § N.3  Conformance cases (C1–C9)
### § N.4  Fixture generation
### § N.5  Dependency-aware ordering and cleanup
```

No changes are needed to the engine spec or connector contract types — the harness is a
test utility only.

---

## Out of Scope

- **Webhook / onEnable / onDisable** testing — those require a publicly routable URL for
  the target API to POST to; the harness tests the CRUD contract only.
- **OAuth2 token flow** — auth setup is the caller's responsibility via `makeCtx`.
- **Engine-level enforcement** (required, immutable stripping) — C4 and C3 test the
  connector's own raw HTTP behaviour, not what the engine would gate.  Engine enforcement
  has its own suite in `packages/engine/`.

---

## Open Questions

1. **`conditionalWrite` flag** — C5 currently relies on `lookup()` presence as a proxy for
   ETag support.  Should we add an explicit `conditionalWrite: true` flag to
   `EntityDefinition` so the harness can skip C5 precisely?  PLAN_LOOKUP_MERGE_ETAG.md is
   the prerequisite for thinking this through.

2. **Partial-update semantics** — C2 assumes the connector does a PATCH-style partial
   update.  Full-replace PUT connectors (like mock-erp) must use `lookup()` + merge to
   avoid blanking.  Should the harness detect this automatically or require a per-entity
   hint (`updateStrategy: 'patch' | 'replace'`)?

3. **Required-field error level** — C4 currently accepts either a connector-level `error`
   field or an engine-gated rejection.  Since the harness calls the connector directly
   (not through the engine), should we tighten this to always pass through the engine's
   required-field pass so the result is consistent?
