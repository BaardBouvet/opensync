# PLAN_DELETE_PROPAGATION — Opt-in delete propagation

**Status:** complete  
**Date:** 2026-04-05  
**Domain:** engine  
**Scope:** engine, config, SDK types  
**Depends on:** PLAN_FULL_SYNC_SIGNAL.md (for mark-and-sweep path only)  

Spec changes planned:
- `specs/sync-engine.md` — add § Delete Propagation section
- `specs/safety.md` — update § Soft Delete Detection / Propagation to reflect opt-in execution
- `specs/config.md` — document `propagateDeletes` field on channel definition

---

## Current state

Delete propagation is fully unimplemented. The schema and SDK types are pre-wired
for it but the execution path is entirely absent:

| Component | State |
|---|---|
| `ReadRecord.deleted?: boolean` (SDK type) | Type exists; engine never reads it |
| `EntityDefinition.delete()` (SDK type) | Type exists; engine never calls it |
| `shadow_state.deleted_at` column | Column exists; never written |
| `dbMarkDeleted()` helper | Does not exist |
| `DiffAction = "delete"` | Not present |
| `SyncAction = "delete"` | Not present |
| `transaction_log.action = 'delete'` | Not logged |
| `record.deleted` EventBus event | Not emitted |
| Mark-and-sweep (`SoftDeleteDetector`) | Specced in safety.md; not implemented |

When a connector returns a record with `deleted: true`, the engine currently
ignores the flag and processes the record as a normal `insert`/`update`/`skip`.
When a record disappears from a source with no explicit signal (delta sync),
the engine takes no action — the shadow row lives on indefinitely.

---

## Problem statement

Without delete propagation:

1. A contact deleted in CRM stays in the ERP forever — data diverges silently.
2. Connectors that signal deletions via `deleted: true` (webhook DELETED events,
   tombstone APIs, in-band deleted fields) have their signal discarded.
3. The `shadow_state.deleted_at` column and the `EntityDefinition.delete` method
   are dead weight.

Delete propagation is intentionally opt-in because automatic deletion across
systems is a destructive, hard-to-reverse operation. The default must be safe.

---

## Design principles

1. **Opt-in per channel** — `propagateDeletes: true` on the channel config. Off by default.
2. **Connector capability gate** — delete is only dispatched to targets that implement
   `EntityDefinition.delete`. Targets without `delete` are skipped with a warning.
3. **Shadow state is always updated** — `deleted_at` is set regardless of whether
   propagation is enabled. The record stays in shadow state for audit and rollback.
4. **Circuit breaker applies** — delete operations are counted and can trip the circuit
   breaker, preventing accidental mass-deletion cascades.
5. **Two detection modes** — explicit signal (`ReadRecord.deleted = true`) and
   mark-and-sweep (full sync, blocked on PLAN_FULL_SYNC_SIGNAL).

---

## Detection mode 1: Explicit delete signal (P1)

A connector returns `ReadRecord.deleted = true`. This covers:
- Hard deletes (disappeared from source API, deleted-objects endpoint, DELETED webhook)
- Soft deletes the connector has chosen to interpret as removals (`archived: true`)
- In-band `_deleted: true` soft-delete fields from external APIs

### Engine behaviour

During `_processRecords`, after identifying the record's canonical ID:

```
if (record.deleted) {
  mark shadow row deleted_at = now (for this connectorId + entityName + externalId)
  log transaction: action = 'delete', canonicalId, sourceConnectorId

  if (channel.propagateDeletes !== true) {
    emit record.deleted event (action = 'flagged')
    continue  ← stop here; no fan-out
  }

  for each other channel member M (excluding source connector):
    if M.entity.delete is undefined:
      log warning: "connector M has no delete() — skipping"
      continue
    resolve externalId for canonicalId in M (identity map)
    if not found:
      log warning: "no identity mapping for canonicalId in M — cannot delete"
      continue
    dispatch M.entity.delete([externalId])
    record result in transaction_log (action = 'delete')
    emit record.deleted event (action = 'dispatched', targetConnectorId = M.id)
}
```

### Shadow state semantics

- `deleted_at` is set whenever a deletion is detected, regardless of propagation config.
- A shadow row with `deleted_at` set is considered a **tombstone**. Normal ingest
  (non-deleted record arriving for the same externalId) resurrects it — a path that
  already exists in the engine (`isResurrection` check) but has never been reachable.
- Tombstones are never removed from shadow state (non-destructive rule § 3 in safety.md).

---

## Detection mode 2: Mark-and-sweep (P2 — depends on PLAN_FULL_SYNC_SIGNAL)

After a full sync completes (signalled by `ReadBatch.complete = true`), any shadow
row for `(connectorId, entityName)` where `deleted_at IS NULL` and whose `external_id`
was **not** in the ingest batch is a candidate for deletion.

This mode is blocked on PLAN_FULL_SYNC_SIGNAL because the engine has no reliable
signal that a batch was a complete dataset until that plan ships. Adding mark-and-sweep
without it risks false positives from incomplete incremental reads.

### Algorithm (deferred)

```
after full sync of (connectorId, entityName):
  fetchedIds = set of externalIds in batch
  knownIds   = SELECT external_id FROM shadow_state
               WHERE connector_id = ? AND entity_name = ? AND deleted_at IS NULL
  missingIds = knownIds − fetchedIds

  for each externalId in missingIds:
    treat as record.deleted = true (same path as mode 1)
```

Rate-limit: if `|missingIds| / |knownIds| > circuit_breaker.volume_threshold%`, abort
and emit a circuit-breaker event instead of propagating. This guards against bugs where
a misconfigured full sync returns a partial snapshot.

---

## Implementation plan

### Phase 1 — Config surface

**`packages/engine/src/config/schema.ts`**

```ts
export const ChannelDefSchema = z.object({
  id: z.string(),
  identityFields: z.array(z.string()).optional(),
  conflict_resolution: ConflictStrategySchema.optional(),
  propagateDeletes: z.boolean().optional(), // NEW
});
```

**`packages/engine/src/config/loader.ts`** — `ChannelConfig`:

```ts
export interface ChannelConfig {
  id: string;
  members: ChannelMember[];
  identityFields?: string[];
  propagateDeletes?: boolean; // NEW
}
```

Thread `ch.propagateDeletes` through `allChannelDefs` and the `channelMap` build
step the same way `identityFields` is threaded today.

---

### Phase 2 — Type extensions

**`packages/engine/src/engine.ts`**

```ts
export type SyncAction = "insert" | "update" | "skip" | "defer" | "error" | "delete"; // add "delete"
```

**`packages/engine/src/core/diff.ts`**

`DiffAction` does not need `"delete"` — the delete path bypasses the normal diff
entirely. A record with `deleted: true` never enters `diff()`.

---

### Phase 3 — Shadow state helpers

**`packages/engine/src/db/queries.ts`** — add `dbMarkDeleted`:

```ts
export function dbMarkDeleted(
  db: Database,
  connectorId: string,
  entityName: string,
  externalId: string,
): void {
  db.run(
    `UPDATE shadow_state
        SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE connector_id = ? AND entity_name = ? AND external_id = ?`,
    [connectorId, entityName, externalId],
  );
}
```

Note: `dbSetShadow` currently always writes `deleted_at = NULL`. That `ON CONFLICT`
clause must stop clearing `deleted_at` unconditionally — the resurrect path should set
it to NULL explicitly when `record.deleted` is falsy and the record is being upserted.
(This is a minor correctness fix; currently it's a no-op since nothing ever sets it.)

---

### Phase 4 — Engine ingest changes

In `engine.ts` `_processRecords`, after canonical ID resolution and before the
existing `diff()` call, add the delete branch:

```ts
// Spec: specs/sync-engine.md § Delete Propagation
if (record.deleted === true) {
  await this._handleDeletedRecord(record, sourceMember, channel, canonical);
  results.push({ externalId: record.id, action: "delete" });
  continue;
}
```

New private method `_handleDeletedRecord`:
1. Call `dbMarkDeleted(db, sourceMember.connectorId, sourceMember.entityName, record.id)`
2. Log transaction: `action = "delete"`, `connector_id = sourceMember.connectorId`, `canonical_id`
3. Emit `record.deleted` with `action = "flagged"` if `!channel.propagateDeletes`; return
4. If `channel.propagateDeletes`:
   - For each other `member` in `channel.members`:
     - Resolve target `externalId` via identity map (`dbLookupIdentity`)
     - If not found → warn, push `{ externalId: record.id, action: "error" }`, continue
     - Get entity definition; if no `delete` method → warn, continue
     - Call `member.entity.delete(asyncIterable([targetExternalId]), ctx)`
     - Collect `DeleteResult`; log transaction + emit `record.deleted` with `action = "dispatched"`

---

### Phase 5 — Pre-flight warning

At engine startup (or channel-setup time), if `channel.propagateDeletes === true`:
- For each `member` with a `delete`-capable entity: OK
- For each `member` without `delete`: emit a startup warning
  `"propagateDeletes is enabled for channel '${id}' but connector '${cid}' has no delete() — deletions will be skipped for this connector"`

---

### Phase 6 — Transaction log

`transaction_log.action` column comment in `schema.ts` currently says `'insert' | 'update'`.
Update the comment to include `'delete'`. No schema change required (it's a `TEXT` column).

---

### Phase 7 — Tests

Cover at minimum:

| Test | Description |
|---|---|
| T-DEL-01 | `record.deleted = true` marks `deleted_at` in shadow state |
| T-DEL-02 | Without `propagateDeletes`, no `delete()` call is made on any target |
| T-DEL-03 | With `propagateDeletes`, `delete()` is called on each target with a mapped identity |
| T-DEL-04 | Target without `delete()` method is skipped (warning, no error) |
| T-DEL-05 | Target with no identity mapping is skipped (warning, no error) |
| T-DEL-06 | `SyncAction = "delete"` is returned in results |
| T-DEL-07 | Circuit breaker trips if delete volume exceeds threshold |
| T-DEL-08 | A subsequent upsert for the same externalId resurrects the record (`deleted_at → NULL`) |

---

## Spec changes

### `specs/sync-engine.md` — add new section

Add a **§ Delete Propagation** section covering:
- How `record.deleted = true` is detected and handled
- The opt-in `propagateDeletes` flag and its default
- Shadow state tombstone semantics
- Fan-out rules (only to members with `delete()`)
- Mark-and-sweep as a future extension (blocked on full-sync signal)

### `specs/safety.md` — update § Soft Delete Detection / Propagation

The current text says:

> "When a soft delete is detected, the engine does NOT automatically delete in other systems."

Update to:

> "When a delete is detected, the engine marks `deleted_at` in shadow state. Propagation
> to other systems is **opt-in** via `propagateDeletes: true` on the channel. Off by default."

Remove or qualify the sentence "the user (or config) decides whether to propagate deletions"
since the config path is now specified here.

### `specs/config.md` — update channel definition

Add `propagateDeletes` to the channel YAML example and table:

```yaml
channels:
  - id: contacts
    propagateDeletes: true   # opt-in: propagate deletions to all channel members
```

Document: default `false`; connectors without `delete()` are skipped with a warning.

---

## Out of scope

- **Mark-and-sweep detection** — deferred until PLAN_FULL_SYNC_SIGNAL ships.
- **Per-member propagation control** — `propagateDeletes` is per-channel. Fine-grained
  per-member targeting (e.g. "delete in ERP but not in data warehouse") is not in scope.
- **Rollback of propagated deletes** — rollback of deletes requires `insert()` on the
  target and the full last-known field data. This is possible in principle (shadow state
  has the canonical data) but is a separate concern and out of scope here.
- **Connector capability check at registration** — the pre-flight warning covers this
  informally; a hard-error path is out of scope.
