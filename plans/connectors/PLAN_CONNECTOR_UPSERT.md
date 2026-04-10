# Plan: Connector Upsert Method

**Status:** backlog  
**Date:** 2026-04-10  
**Effort:** XS  
**Domain:** Connector SDK — write interface  
**Scope:** `specs/connector-sdk.md`, `packages/sdk/src/index.ts`, `packages/engine/src/engine.ts`  
**Depends on:** none  

---

## § 1 Problem

The connector write interface is split into three separate methods: `insert()`, `update()`, and
`delete()`. This is the right model for most APIs. But some targets use a single **upsert
endpoint** — a `PUT /entities/{id}` (or a `POST /entities/batch/upsert`) that creates the
record if it doesn't exist, or updates it if it does. Examples: HubSpot `batchUpsert`, many
REST APIs where `PUT` is idempotent and id-carrying.

For these connectors, `insert()` and `update()` have byte-for-byte identical implementations.
The connector author is forced to branch artificially on a distinction that their API does not
care about.

This plan adds an optional `upsert()` method to `EntityDefinition` as an ergonomic alternative.
**It is a pure SDK convenience change.** It does not change data-flow guarantees, the identity
model, or what information crosses the connector boundary.

---

## § 2 Analysis: Why the Canonical UUID Is Not the Upsert Key

The obvious shortcut — give the connector a stable sync ID so it can always upsert by it — is
unsafe and must not be implemented.

The engine's canonical UUID is an internal join key between shadow rows. It is not stable enough
to store in external systems, for one fundamental reason: **cluster merges change it**.

1. Records `A` (canonical `uuid-1`) and `B` (canonical `uuid-2`) are both written to connector
   `C` with IDs returned from `insert()`.
2. Discovery finds they are the same real-world entity → `dbMergeCanonicals(uuid-1, uuid-2)` runs.
   The winning ID is now `uuid-1`; `uuid-2` is gone.
3. Connector `C` now has **two records** for one canonical entity — one linked to `uuid-1`, one
   to the dropped `uuid-2`.
4. If the engine tried to upsert-by-canonical-ID in a subsequent cycle, it would create a third
   record, because no existing record in `C` carries `uuid-1` as its sync field. The engine
   would then need a separate cleanup write just to update the sync field on records that had
   no data change — a new write category with no benefit.

The engine's external-ID model sidesteps this entirely: the engine stores the connector's own
opaque ID and uses that for all future writes. The connector never sees canonical internals.

---

## § 3 Proposed Design

### § 3.1 New SDK types

```typescript
interface UpsertRecord {
  id?: string;                              // target-local ID if known; absent = new record
  data: Record<string, unknown | unknown[]>; // FK fields carry remapped plain ID strings
  version?: string;                         // last-seen ETag/version for conditional writes
  snapshot?: Record<string, unknown>;       // full pre-snapshot for conflict detection
}

interface UpsertResult {
  id: string;           // ID confirmed or assigned by the target system
  created?: boolean;    // hint: true = row was created, false = row was updated (advisory — not required)
  data?: Record<string, unknown>;  // full API response for echo prevention
  error?: string;
}
```

`id` in `UpsertRecord` is populated by the engine when a prior external ID is known from
`identity_map`. It is absent on the first write. The connector uses this as its own signal for
how to call its API — the engine does not infer `created` from it.

### § 3.2 EntityDefinition extension

Add `upsert` as an optional method alongside the existing write methods:

```typescript
interface EntityDefinition {
  name: string;
  fetch?:  (watermark: ..., ctx: ConnectorContext) => AsyncIterable<ReadRecord>;
  lookup?: (ids: string[], ctx: ConnectorContext) => AsyncIterable<ReadRecord>;
  insert?: (records: AsyncIterable<InsertRecord>, ctx: ConnectorContext) => AsyncIterable<InsertResult>;
  update?: (records: AsyncIterable<UpdateRecord>, ctx: ConnectorContext) => AsyncIterable<UpdateResult>;
  upsert?: (records: AsyncIterable<UpsertRecord>, ctx: ConnectorContext) => AsyncIterable<UpsertResult>;
  delete?: (ids: AsyncIterable<string>,           ctx: ConnectorContext) => AsyncIterable<DeleteResult>;
}
```

### § 3.3 Engine dispatch precedence

In `_dispatchToTarget` (and the `onboard`/`addConnector` fan-out paths), the engine currently
branches on whether `existingTargetId` is known:

```
existingTargetId present → update()
existingTargetId absent  → insert()
```

With this plan, the branch becomes:

```
if upsert() present:
  call upsert({ id: existingTargetId /* may be undefined */, data, version, snapshot })
  treat UpsertResult like InsertResult (for identity_map write) if result.id differs from
  existingTargetId, otherwise like UpdateResult
else if existingTargetId present:
  call update()
else:
  call insert()
```

Result handling:

- `UpsertResult.id` is always stored in `identity_map` (same as `InsertResult.id`).
  If the connector returns the same ID the engine passed in, `dbLinkIdentity` is a no-op.
- `UpsertResult.data` is stored for echo prevention (same as `InsertResult.data` /
  `UpdateResult.data`).
- `UpsertResult.error` is treated as a write failure (same as the other methods).

### § 3.4 Validation rules

At config load time:

- A connector entity may declare `upsert()` without `insert()` or `update()` — valid, the
  engine uses `upsert()` for both new and existing records.
- A connector entity may declare all three — valid, `upsert()` takes precedence at dispatch.
- A connector entity that declares neither `insert()` nor `upsert()` is a read-only entity —
  existing behaviour, no change.

### § 3.5 What does not change

- `delete()` is unaffected — upsert semantics do not apply to deletion.
- The identity model is unchanged — canonical UUIDs remain engine-internal.
- `written_state` upsert logic is unchanged — `localData` is stored the same way regardless
  of which write method was called.
- Echo prevention is unchanged — `UpsertResult.data` feeds the same mechanism.
- Circuit breaker integration is unchanged.

---

## § 4 Example: HubSpot batch upsert

```typescript
async function* upsert(
  records: AsyncIterable<UpsertRecord>,
  ctx: ConnectorContext,
): AsyncIterable<UpsertResult> {
  for await (const batch of chunk(records, 100)) {
    const payload = batch.map((r) => ({
      idProperty: "hs_object_id",
      id: r.id,          // undefined for new records → HubSpot creates
      properties: r.data,
    }));
    const res = await ctx.http(`${ctx.config.baseUrl}/crm/v3/objects/contacts/batch/upsert`, {
      method: "POST",
      body: JSON.stringify({ inputs: payload }),
    });
    const json = await res.json() as { results: Array<{ id: string; properties: Record<string, unknown> }> };
    for (let i = 0; i < json.results.length; i++) {
      yield { id: json.results[i]!.id, data: json.results[i]!.properties };
    }
  }
}
```

The connector no longer needs an `insert()`/`update()` branch. The `id` field drives the
HubSpot-side create-or-update.

---

## § 5 Alternative considered: engine-side shim

An alternative is to keep `insert()`/`update()` as the only write interface and have the engine
call them via a generated shim when the connector provides only `upsert()`. The shim would
wrap `UpsertRecord` → `InsertRecord` / `UpdateRecord` based on `id` presence.

Rejected: it adds engine complexity with no benefit over the chosen design. The connector
interface is the right place to express "this API is upsert-native".

---

## § 6 Spec changes planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-sdk.md` | Write Records | Add `UpsertRecord` and `UpsertResult` TypeScript interfaces |
| `specs/connector-sdk.md` | Write Results | Add `UpsertResult` to the write results table |
| `specs/connector-sdk.md` | EntityDefinition | Add `upsert?` to the method table with dispatch precedence note |
| `specs/connector-sdk.md` | (new subsection) | "Upsert-native connectors" — when to use `upsert()` vs `insert()`+`update()`; the canonical-ID-as-key anti-pattern with merge-safety reasoning |
| `specs/sync-engine.md` | Dispatch | Note that `upsert()` takes precedence over `insert()`/`update()` when declared; describe result handling |
