# PLAN: Strict Association Mode + Deadlock Detection

**Status:** backlog  
**Date:** 2026-04-05  
**Domain:** packages/engine  
**Prerequisite:** `PLAN_EAGER_ASSOCIATION_MODE.md` must be complete. Strict mode is an opt-in overlay on top of the eager default.  

---

## 1. What strict mode is

In the default (eager) behaviour, a record with an unresolvable association is inserted
immediately without that association; a deferred row triggers an update once the link
exists. Strict mode inverts this: the **entire record is withheld** from all targets until
every one of its associations can be resolved.

Use case: target systems that reject inserts missing a required foreign key (e.g. a billing
platform that requires every invoice to have a valid customer ID before creation).

---

## 2. The deadlock problem

Strict mode introduces a failure mode that cannot occur in eager mode: two records that
mutually reference each other, both new to the target, will stall permanently.

```
sa/contacts/c1  data.managerId = { '@id': 'c2', '@entity': 'contacts' }
sa/contacts/c2  data.reportId  = { '@id': 'c1', '@entity': 'contacts' }
```

| Step | What happens |
|------|--------------|
| Ingest c1 | c2 not in sb → entire record deferred |
| Ingest c2 | c1 not in sb → entire record deferred |
| Retry | c1 retried: c2 still not in sb → deferred again. c2 retried: c1 still not in sb → deferred again. |
| All future cycles | Same. Neither record ever inserted. No error emitted. |

Cycles need not be length 2. A→B→C→A stalls identically. **Deadlock detection is a
hard requirement of strict mode — strict mode must not ship without it.**

---

## 3. Design

### § 3.1 Channel-level config flag

```ts
interface ChannelConfig {
  associationMode?: "strict";  // omit for default (eager) behaviour
}
```

Mapping YAML:

```yaml
channels:
  - id: contacts
    identityFields: [email]
    associationMode: strict
```

When `associationMode === "strict"`, `_processRecords` uses the existing `remap === null
→ continue` path (already present). No change needed to the current strict code path.

### § 3.2 Storing the blocking association

To detect cycles, each deferred row must record *what* it is waiting for. Extend
`deferred_associations` with two nullable columns:

```sql
blocking_entity      TEXT,  -- targetEntity of the unresolvable association
blocking_external_id TEXT,  -- targetId of the unresolvable association (source namespace)
```

Update `dbInsertDeferred` to accept and write these values. Update `_remapAssociations`
to return the blocking association alongside `null` so the caller can pass it through:

```ts
// Internal return type (not exported)
type RemapBlocked = { blocked: true; blockingEntity: string; blockingExternalId: string };

// _remapAssociations returns: Association[] | RemapBlocked | { error: string }
```

### § 3.3 Cycle detection algorithm

After the retry loop in `ingest()`, when any rows remain deferred (strict channel), run a
cycle check:

```
Build directed graph G from deferred_associations WHERE blocking_external_id IS NOT NULL:
  Node = source_external_id
  Edge X → Y  when row for X has blocking_external_id = Y AND a row for Y also exists

Find all strongly connected components (SCCs) of size > 1 (Tarjan's algorithm, O(V+E)).
Each SCC of size > 1 is a deadlock group.
```

### § 3.4 Surface deadlocks in `IngestResult`

```ts
export interface DeadlockGroup {
  entity: string;
  sourceConnectorId: string;
  targetConnectorId: string;
  cycle: string[];       // source-side record IDs forming the cycle
  predicates: string[];  // association predicates, parallel to cycle edges
}

export interface IngestResult {
  // ... existing fields ...
  deadlocks?: DeadlockGroup[];  // non-empty only when strict mode + cycle detected
}
```

Detection is read-only — it never modifies the deferred table or aborts the ingest.

### § 3.5 Breaking a deadlock

Add a public `breakDeadlock()` method. It sets a `break_requested` flag on the deferred
row for a specific record. On the next ingest retry, the engine calls
`_remapAssociationsPartial` for flagged rows instead of `_remapAssociations`, inserting
the record without the circular association and clearing the flag. The deferred retry loop
then resolves the association in a subsequent pass (same as the eager default path).

```ts
engine.breakDeadlock(
  channelId: string,
  entity: string,
  sourceConnectorId: string,
  recordId: string,
): void
```

This requires adding `break_requested INTEGER NOT NULL DEFAULT 0` to `deferred_associations`.

---

## 4. Spec changes planned

| File | Section | Change |
|------|---------|--------|
| `specs/associations.md` | New section `§ Strict Mode` | Define strict mode, the deadlock problem, and the resolution API |
| `specs/config.md` | `§ Channel configuration` | Add `associationMode: "strict"` |
| `specs/sync-engine.md` | `§ Deferred Association Retry` | Note that strict channels emit `deadlocks` in `IngestResult` |
| `specs/database.md` | `deferred_associations` table | Add `blocking_entity`, `blocking_external_id`, `break_requested` columns |

---

## 5. Implementation steps

1. Add `associationMode?: "strict"` to `ChannelConfig` and mapping YAML schema.
2. Extend `deferred_associations` schema with `blocking_entity`, `blocking_external_id`,
   `break_requested` columns.
3. Change `_remapAssociations` internal return type to `RemapBlocked` instead of `null`.
   Update all call sites (3 total).
4. Update `dbInsertDeferred` to write blocking columns.
5. Add `_detectDeadlocks(deferred)` private method (Tarjan's SCC).
6. Call `_detectDeadlocks` after retry loop when channel is strict; attach to result.
7. Add `breakDeadlock()` public method.
8. Update retry loop to use `_remapAssociationsPartial` for `break_requested` rows.
9. Add spec sections listed above.
10. Tests (TDD):
    - T_S1: strict mode — record withheld until all associations resolve
    - T_S2: strict mode — mutual reference produces `DeadlockGroup` in result
    - T_S3: strict mode — three-record cycle detected correctly
    - T_S4: `breakDeadlock()` unblocks one record; other resolves on next retry
    - T_S5: eager channels on same engine instance are unaffected by strict detection


### § 1.1 Concrete example

```
sa/contacts/c1  data.managerId = { '@id': 'c2', '@entity': 'contacts' }
sa/contacts/c2  data.reportId  = { '@id': 'c1', '@entity': 'contacts' }
```

Both c1 and c2 are unique to `sa` (not yet in `sb`). Processing order:

| Step | What happens |
|------|-------------|
| Ingest c1 | `_remapAssociations` looks up c2's canonical in sb → not found (`dbGetExternalId = undefined`) → `null` → deferred. Source shadow for c1 written. |
| Ingest c2 | Same for c1 → deferred. Source shadow for c2 written. |
| Retry loop | `lookup([c1, c2])` called. c1 retried: c2 still not in sb → `null` → deferred again (echo bypassed). c2 retried: c1 still not in sb → deferred again. |
| All future ingest cycles | Same result. Neither record ever inserted. Deferred rows never cleared. |

The engine loops indefinitely with no observable progress and no error.

### § 1.2 Why non-obvious

Each deferred row only stores `(source_connector, entity_name, source_external_id,
target_connector)` — it records that a record is stuck, but not **which specific association
target** is causing the block. Cycle detection therefore requires a second-pass read of the
source records' associations.

### § 1.3 Longer cycles

Cycles need not be length 2. Any chain where A→B→C→A (all new to the target) produces
the same infinite stall. The detection algorithm must handle arbitrary cycle length.

---

## 2. Proposed design

### § 2.1 Extend `deferred_associations` with blocking target columns

Add two nullable columns to record which association is causing the deferral:

```sql
CREATE TABLE IF NOT EXISTS deferred_associations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  source_connector     TEXT    NOT NULL,
  entity_name          TEXT    NOT NULL,
  source_external_id   TEXT    NOT NULL,
  target_connector     TEXT    NOT NULL,
  blocking_entity      TEXT,       -- NEW: targetEntity of the unresolvable association
  blocking_external_id TEXT,       -- NEW: targetId  of the unresolvable association (source namespace)
  deferred_at          INTEGER NOT NULL,
  UNIQUE (source_connector, entity_name, source_external_id, target_connector)
);
```

`blocking_entity` and `blocking_external_id` are the source-connector-side identity of the
association target that `_remapAssociations` could not resolve. They identify the **node
this record is waiting for** in the source connector's ID space — the same space used by
`dbGetCanonicalId`.

When `_remapAssociations` returns `null`, the call site already has the blocking `assoc`
that caused it to return null (the first association in the loop that failed). Pass that
information through to `dbInsertDeferred`.

### § 2.2 Updated `dbInsertDeferred` signature

```ts
dbInsertDeferred(
  db,
  sourceConnector,
  entityName,
  sourceExternalId,
  targetConnector,
  blockingEntity?: string,       // assoc.targetEntity that caused remap to fail
  blockingExternalId?: string,   // assoc.targetId    that caused remap to fail (source namespace)
)
```

The columns are nullable for backward compatibility with any existing rows; the cycle
detector tolerates missing blocking info by skipping those rows.

### § 2.3 Extracting the blocking association in `_remapAssociations`

Currently `_remapAssociations` returns `null` opaquely. Change to return richer information:

```ts
// New internal return type (not exported — internal detail):
type RemapResult =
  | Association[]                         // success
  | null                                  // blocked — new: includes blocking info
  | { error: string };                    // configuration error

// Use a tagged union for the null case:
type RemapNullResult = {
  blocked: true;
  blockingEntity: string;
  blockingExternalId: string;
};
```

Or — to avoid a large refactor — change the return type only in the engine-internal path
that then calls `dbInsertDeferred`, using a sentinel object:

```ts
type RemapBlocked = { blocked: true; blockingEntity: string; blockingExternalId: string };

// _remapAssociations returns Association[] | RemapBlocked | { error: string }
// Callers use `if ("blocked" in remap)` to distinguish null from the old `=== null`.
```

This is a breaking change to an internal-only type — no public API impact.

### § 2.4 Cycle detection algorithm

After the retry loop in `ingest()`, run a cycle check over all deferred rows for the
current `connectorId` + `entity`:

```
Build directed graph G:
  Nodes: source_external_id values from deferred_associations
  Edge X → Y exists if:
    there is a deferred row for X with blocking_external_id = Y
    AND there is a deferred row for Y (Y is also stuck)

Find all strongly connected components (SCCs) of size > 1
  (or any cycle in a DAG, simpler since SCCs suffice for length-2+ detection)
Each SCC of size > 1 is a deadlock group.
```

Tarjan's SCC algorithm is O(V + E) and simple enough to inline as a ~50-line helper.
No external dependency needed.

### § 2.5 New `DeadlockGroup` type in `IngestResult`

```ts
export interface DeadlockGroup {
  entity: string;
  sourceConnectorId: string;
  targetConnectorId: string;
  /** The cycle of source-side record IDs, in order: [c1, c2, c1] */
  cycle: string[];
  /** Association predicates that form the cycle, parallel to cycle edges */
  predicates: string[];
}

export interface IngestResult {
  channelId: string;
  connectorId: string;
  records: RecordSyncResult[];
  snapshotAt?: number;
  /** Non-empty when deferred records form circular dependencies that cannot self-resolve. */
  deadlocks?: DeadlockGroup[];
}
```

The engine emits `deadlocks` only when at least one SCC is found. The caller (demo runner,
CLI, application code) decides what to do with this information.

### § 2.6 Cycle detection is read-only and non-blocking

The detection never modifies the deferred table and never aborts the ingest. It is a pure
diagnostic that appends to the result. The deferred rows remain in place until the user
resolves the deadlock.

### § 2.7 Options for breaking the deadlock

The engine surfaces the deadlock; the user chooses a resolution strategy. Two mechanisms
are needed:

**Option A — eager mode (planned separately in PLAN_EAGER_ASSOCIATION_MODE.md)**  
Setting `associationMode: "eager"` on the channel causes one of the records to be inserted
without the circular association on the next ingest cycle that retries it. The retry
update then wires the association once the other record exists. This is the zero-config
break: re-run with eager mode, the cycle self-resolves in two passes.

**Option B — `breakDeadlock(channelId, entity, sourceConnectorId, recordId)` API**  
A targeted, one-shot API that forces a specific deferred record to be inserted without its
circular associations on the next ingest cycle. Internally: sets a `break_deadlock`
flag on the deferred row(s) for that record. The retry loop checks the flag: if set,
calls `_remapAssociationsPartial` (from eager mode plan) instead of `_remapAssociations`,
inserts without the circular association, and clears the flag.

```ts
engine.breakDeadlock(channelId: string, entity: string, sourceConnectorId: string, recordId: string): void
```

This is the surgical option when the operator wants to keep `strict` mode globally but
needs to unblock a specific set of records.

---

## 3. Changes to `_remapAssociations` internal return type

The current `null` return needs to carry the blocking association so `dbInsertDeferred`
can be called with the right `blockingEntity` and `blockingExternalId`. Proposed change:

```ts
// Before (internal)
private _remapAssociations(...): Association[] | null | { error: string }

// After (internal)
private _remapAssociations(...):
  | Association[]
  | { blocked: true; blockingEntity: string; blockingExternalId: string }
  | { error: string }
```

All internal callers of `_remapAssociations` must be updated. There are exactly three
call sites (`_processRecords`, onboard unique-per-side, `_remapAssociationsPartial` when
added by the eager mode plan).

---

## 4. Spec changes planned

| File | What changes |
|------|-------------|
| `specs/associations.md` | New section `§ Circular Association Deadlocks`: definition, example, when they occur, detection, resolution options |
| `specs/sync-engine.md` | Note in `§ Deferred Association Retry` that the retry loop emits `DeadlockGroup` entries when a cycle is detected |
| `specs/database.md` | Add `blocking_entity` / `blocking_external_id` columns to the `deferred_associations` schema section |

---

## 5. Implementation steps

1. Extend `deferred_associations` schema — add `blocking_entity TEXT, blocking_external_id
   TEXT` columns to `migrations.ts`.
2. Change `_remapAssociations` internal return type to `{ blocked; blockingEntity;
   blockingExternalId }` instead of `null`. Update all three call sites.
3. Update `dbInsertDeferred` to write the blocking columns.
4. Add `_detectDeadlocks(deferred: Array<{...}>): DeadlockGroup[]` private method using
   Tarjan's SCC algorithm.
5. Call `_detectDeadlocks` after the retry loop in `ingest()` when any records remain
   deferred after retry. Attach the result to `IngestResult.deadlocks`.
6. Add `breakDeadlock(...)` public method that sets a per-row flag on the deferred table
   (new `break_requested INTEGER NOT NULL DEFAULT 0` column).
7. Update retry loop to call `_remapAssociationsPartial` instead of `_remapAssociations`
   for rows with `break_requested = 1`.
8. Add spec sections listed above.
9. Tests (TDD):
   - T36: two mutually-referencing records produce `DeadlockGroup` in `IngestResult`
   - T37: three-record cycle (A→B→C→A) detected correctly
   - T38: `breakDeadlock` on one record causes it to be inserted without the circular
     association; the other record's deferred row is resolved on the next retry

---

## 6. Out of scope

- Cross-channel deadlocks (A in channel X refers to B in channel Y which refers back to A
  in channel X). The detection scope is single-connector × single-entity, consistent with
  how the retry loop fires.
- Automatic deadlock breaking without user input. The engine detects and reports; it never
  silently drops associations.
- UI for deadlock resolution. A `DeadlockGroup` in the result is sufficient for a CLI or
  demo runner to format a user-facing message.
