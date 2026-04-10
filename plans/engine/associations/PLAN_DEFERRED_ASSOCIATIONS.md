# PLAN: Deferred Association Retry

**Status:** complete  
**Date:** 2026-04-05  
**Domain:** packages/engine  

---

## 1. Problem

When a source record has an association pointing to a target entity that has not yet been
cross-linked in the identity map, `_remapAssociations` returns `null` and the fan-out
produces a `"defer"` action. The deferred fact is emitted in the result but **never
persisted**. Once the watermark advances past that record, the connector's incremental
filter (`isNewerThan(updated, since)`) filters it out forever. The association is
permanently lost.

**Concrete example (associations-demo):**

| Step | What happens |
|------|-------------|
| `collectOnly` (CRM contacts) | Carol (`c3`) collected with `associations: [companyId→co3/Initech]`. Source shadow written with `assocSentinel = undefined` (collectOnly never stores associations). |
| `collectOnly` (ERP employees) | Initech account doesn't exist in ERP — nothing to collect. |
| `onboard` (companies channel) | Initech (`co3`) is CRM-unique → ERP account created. Companies channel becomes ready. |
| `onboard` (contacts channel) | Carol is CRM-unique → `onboard` inserts her into ERP as data-only (no associations — onboard unique-per-side path never processes associations). |
| First incremental (CRM contacts) | CRM watermark = `"1"`, Carol's `updated = 1`. `isNewerThan(1, "1")` → `1 > 1` → `false`. Carol is **not returned**. Association never retried. |
| All subsequent polls | Same filter. Carol's association is permanently absent from ERP. |

No `deferred_associations` table exists. The `"defer"` action is a transient signal with
no durable effect.

---

## 2. Proposed fix

### 2.1 New table: `deferred_associations`

```sql
CREATE TABLE IF NOT EXISTS deferred_associations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_connector  TEXT    NOT NULL,
  entity_name       TEXT    NOT NULL,
  source_external_id TEXT   NOT NULL,
  target_connector  TEXT    NOT NULL,
  deferred_at       INTEGER NOT NULL,
  UNIQUE (source_connector, entity_name, source_external_id, target_connector)
);
```

### 2.2 Write to the table on defer

In `_processRecords`, when `remap === null` (currently only pushed as `"defer"` action),
also write a row:

```ts
dbInsertDeferred(this.db, {
  sourceConnector: sourceMember.connectorId,
  entityName: sourceMember.entity,
  sourceExternalId: record.id,
  targetConnector: targetMember.connectorId,
});
results.push({ …, action: "defer" });
```

### 2.3 Retry deferred records at the end of each `ingest()`

After the normal watermark-based batch finishes, before returning, query the table for any
deferred records whose **source connector matches the current ingest call**:

```ts
const deferred = dbGetDeferred(this.db, connectorId, sourceMember.entity);
```

For each deferred source external ID not already processed in this cycle, call
`connector.lookup(ids, ctx)` to fetch the current record data from the source, then pass
it through `_processRecords` as a synthetic batch. If the remap now succeeds, remove the
row from `deferred_associations`. If it still defers, leave it.

`lookup()` is already used by `_dispatchToTarget` for ETag pre-fetch. Connectors that
don't implement `lookup` cannot be retried — in that case log a warning and leave the row,
relying on a future incremental returning the record naturally.

### 2.4 Remove on success

When `_remapAssociations` succeeds for a `(source_connector, entity, source_external_id,
target_connector)` combination that has a row in `deferred_associations`, delete the row
atomically in the same transaction as the shadow update.

---

## 3. Scope constraints

- No changes to watermarks or the connector `read()` interface.
- The deferred table is a pure engine concern — connectors never see it.
- `lookup()` is called only for the specific IDs in the deferred table, not a full re-read.
- If `lookup()` is absent on the source connector, the retry is skipped silently; the
  record will be retried if and when the connector's incremental read returns it (e.g.
  after an explicit edit bumps its `updated` value).

---

## 4. Edge cases

| Case | Handling |
|------|---------|
| Source record deleted before retry | `lookup()` returns nothing for that ID → remove from deferred (nothing to propagate) |
| Multiple target connectors deferred for the same source record | One row per `(source, entity, external_id, target)` — each cleared independently |
| Retry itself defers again | Row stays; retried again next ingest cycle |
| `onboard` creates the missing link between cycles | Next ingest retry succeeds — normal path |
| Source connector has no `lookup()` | Retry skipped; warning logged; row retained |

---

## 5. Spec changes planned

`specs/sync-engine.md` → add section `§ Deferred Association Retry`:
- Document the `deferred_associations` table
- Document the retry loop at the end of `ingest()`
- Document the `lookup()`-based re-fetch behaviour

---

## 6. Implementation tasks

1. `packages/engine/src/db/migrations.ts`: add `CREATE TABLE IF NOT EXISTS deferred_associations`.
2. `packages/engine/src/db/queries.ts`: add `dbInsertDeferred`, `dbGetDeferred`, `dbRemoveDeferred`.
3. `packages/engine/src/engine.ts`:
   a. On `remap === null`: call `dbInsertDeferred`.
   b. On successful dispatch: call `dbRemoveDeferred` inside the atomic transaction.
   c. After the main ingest batch loop: fetch deferred rows for this connector+entity, call
      `lookup()`, pass results back through `_processRecords`.
4. Tests (TDD — write failing tests first):
   - Carol scenario: after onboard, Carol's association is in `deferred_associations`.
   - Next ingest: `lookup()` called, association propagated, row removed.
   - Source record deleted before retry: row removed, no dispatch.
   - Connector without `lookup()`: row retained, no error.
