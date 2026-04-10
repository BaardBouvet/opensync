# PLAN: Eager Association Dispatch (default behaviour change)

**Status:** complete  
**Date:** 2026-04-05  
**Domain:** packages/engine  

---

## 1. Problem

The current association dispatch behaviour is **strict**: when `_remapAssociations` returns
`null` (an association target is not yet cross-linked in the identity map), the entire
record is withheld from all targets and a `deferred_associations` row is written. The row is
retried on future ingest cycles.

This causes two distinct issues:

**Latency.** A record that references an entity not yet synced to the target does not appear
in any target until the association resolves — even though the record's own data is
complete and ready. A contact cannot arrive in the ERP until its company exists there.

**Circular dependency stall (permanent deadlock).** When two records in the same entity
reference each other (e.g. a manager/report pair, or two accounts with a parent/subsidiary
link), and both are new to the target connector, each deferred retry blocks on the other:

```
sa/contacts/c1  associations: [{ predicate: "managerId", targetEntity: "contacts", targetId: "c2" }]
sa/contacts/c2  associations: [{ predicate: "reportId",  targetEntity: "contacts", targetId: "c1" }]
```

Neither can be inserted. Neither deferred row is ever cleared. Every future ingest retries
both records and re-defers them. The engine makes no observable progress and emits no error.

---

## 2. Decision: make eager the default

Instead of withholding the entire record, **insert it immediately with only the associations
that can be resolved**, and write a deferred row for the update that will add the missing
association once the identity link is established.

This is already the correct behaviour for the deferred retry mechanism — once a linked
record arrives, the engine issues an update. Making it the default for the first-pass
dispatch too keeps the model consistent.

Both issues above self-resolve:
- **Latency**: record arrives in the target without its unresolvable associations. Update
  follows when the referenced record is synced.
- **Circular stall**: c1 is inserted without the `managerId` association (c2 not yet in sb).
  c2 is inserted without the `reportId` association. On the retry pass, c1's deferred row
  resolves (c2 now exists in sb) and an update fires, and vice versa. Two passes, no manual
  intervention.

**Invariant preserved:** no dangling reference is ever written. An unresolvable association
is omitted from the write — not replaced with a wrong ID.

---

## 3. Design

### 3.1 No channel flag needed

Eager is the unconditional default. There is no `associationMode` flag for now.
Strict mode (opt-in withholding of the whole record) is a future addition — see §5.

### 3.2 New helper: `_remapAssociationsPartial`

Same logic as `_remapAssociations`, but instead of returning `null` when a target ID is
missing, it **drops that association entry** and continues:

```ts
private _remapAssociationsPartial(
  associations: Association[] | undefined,
  fromId: string,
  toId: string,
): Association[] | { error: string } {
  // Never returns null. Skips entries where canonId or mapped external ID is missing.
  // Returns { error } only for unknown targetEntity — that is always a config mistake.
}
```

### 3.3 Changes to `_processRecords`

Replace the `remap === null → continue` path with:

```ts
if (remap === null) {
  // Write deferred row so the retry loop can issue an update once the link exists.
  dbInsertDeferred(...);
  // Fall through to dispatch using the partial remap (associations with resolved targets
  // only — unresolvable ones omitted).
  const partialRemap = this._remapAssociationsPartial(record.associations, ...);
  if ("error" in partialRemap) { /* handle */ }
  // use partialRemap as the association list for dispatch
}
```

### 3.4 Source shadow on partial dispatch

When a record is dispatched without some of its associations, the source shadow must **not**
store the full association sentinel. If it did, the next normal ingest would see the shadow
matching the full incoming record (including the still-missing association) and suppress via
echo detection, blocking the deferred update.

Write the source shadow with `assocSentinel = undefined` when any association was dropped.
The deferred retry already bypasses echo detection via `skipEchoFor` (T34 fix), so the
retry update fires correctly once the identity link is established.

### 3.5 Deferred retry — no changes needed

The retry loop (`dbGetDeferred` → `lookup` → `_processRecords`) is unchanged. On retry,
the record already exists in the target (inserted in §3.3), so `_processRecords` issues an
`update` with the now-resolved association. `_resolvedMatchesTargetShadow` sees no
`__assoc__` in the target shadow but an incoming association sentinel → not suppressed →
update dispatched.

---

## 4. Spec changes planned

| File | Section | Change |
|------|---------|--------|
| `specs/associations.md` | New section `§ Partial Association Dispatch` | Document the partial dispatch behaviour, circular self-resolution, and the strict-mode future opt-in |
| `specs/sync-engine.md` | `§ Fan-out` | Update to describe partial remap and the deferred-update path |

---

## 5. Implementation steps

1. Add `_remapAssociationsPartial` private method to `SyncEngine`.
2. In `_processRecords`: replace strict `continue` on `remap === null` with deferred-row
   write + fall-through using `_remapAssociationsPartial`. Write source shadow with
   `assocSentinel = undefined` when any association was dropped.
3. Update spec sections listed above.
4. Tests (TDD — all in `packages/engine/src/onboarding.test.ts`):
   - T36: record with unresolvable association is inserted immediately without it
   - T37: deferred retry issues an update once the linked record is synced
   - T38: mutual reference (c1↔c2, both new) — both inserted in first pass, both
     associations resolved in retry pass; no permanent deferred rows remain

---

## 6. Future: strict mode

If a channel needs to withhold a record entirely until all its associations can be
resolved (e.g. a billing system that rejects inserts without a required foreign key),
that is a separate opt-in feature. See `PLAN_CIRCULAR_ASSOCIATION_DEADLOCK.md` for
the full design — strict mode and deadlock detection are specified together there
because you cannot implement one without the other.
