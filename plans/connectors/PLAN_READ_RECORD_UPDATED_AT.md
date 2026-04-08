# PLAN: `ReadRecord.updatedAt` — Source Timestamp for LWW Conflict Resolution

**Status:** complete  
**Date:** 2026-04-06  
**Effort:** S  
**Domain:** Connector SDK, Engine  
**Scope:** `packages/sdk/src/types.ts`, `packages/engine/src/engine.ts`, `packages/engine/src/core/conflict.ts`  
**Depends on:** nothing  

---

## Spec changes planned

- `specs/connector-sdk.md` — `ReadRecord` section: document `updatedAt` field and its
  role as the source-side LWW timestamp
- `specs/sync-engine.md` — `§ Conflict Resolution / LWW` section: state that the engine
  prefers `ReadRecord.updatedAt` over engine ingest time when comparing against shadow `ts`

---

## Problem

LWW conflict resolution uses `ingestTs = Date.now()` — the wall-clock time at the start of
each poll batch — as the `ts` for every record incoming from a source connector.

```typescript
// packages/engine/src/engine.ts
const ingestTs = Date.now();   // set once per poll; same value for all records in the batch
```

This means:
1. **All records in the same batch share the same timestamp.** Two records from the same source
   — one genuinely new, one last touched a year ago — are indistinguishable to the LWW resolver.
2. **Poll timing determines winners.** If system A polls 2 seconds before system B in the same
   cycle, all of A's records get a slightly older `ts` than B's. B always wins LWW for every
   field on every record regardless of actual modification time.
3. **The source's own ordering is discarded.** Every API that exposes a modification timestamp
   (`lastModifiedDate`, `_updatedAt`, `updatedAt`, `modified_time`, etc.) provides the correct
   LWW basis — but the engine doesn't know there is such a field, so it can't use it.

This is acknowledged implicitly in `plans/engine/GAP_ENGINE_DECISIONS.md`.

---

## Solution

Add `updatedAt?: string` to `ReadRecord` as the source's own modification timestamp in ISO
8601 format. Connectors that expose such a field populate it; connectors that don't leave it
absent. The engine parses it into epoch ms and uses it as the LWW `ts` for that record,
falling back to `ingestTs` when absent.

**No connector is forced to change.** The field is optional. Existing connectors continue to
work exactly as before — the only change is that the engine prefers a per-record source
timestamp over a per-batch ingest timestamp when one is available.

---

## Changes

### 1. SDK — `packages/sdk/src/types.ts`

Add `updatedAt` to `ReadRecord`:

```typescript
export interface ReadRecord {
  id: string;
  data: Record<string, unknown | unknown[]>;
  deleted?: boolean;
  associations?: Association[];
  version?: string;

  /** Source-assigned modification timestamp in ISO 8601 format
   *  (e.g. '2026-03-15T10:32:00Z').
   *  When present, the engine uses this as the LWW timestamp for every field in this
   *  record, so that conflict resolution reflects actual change ordering in the source
   *  rather than engine poll timing.
   *  Omit for sources that have no modification timestamp. */
  updatedAt?: string;
}
```

Note on naming: `version` (existing) is an opaque concurrency token for conditional writes
(ETag / If-Match). `updatedAt` is a human-readable ISO timestamp for LWW ordering. They serve
different purposes and both can be present simultaneously on the same record.

### 2. Engine — `packages/engine/src/engine.ts`

In `_processRecords` (or the per-record path before `resolveConflicts` is called), derive a
per-record `recordTs` instead of passing the batch-wide `ingestTs` directly:

```typescript
// Per-record timestamp: prefer source-supplied updatedAt, fall back to batch ingestTs.
const recordTs = record.updatedAt
  ? (Date.parse(record.updatedAt) || ingestTs)   // NaN-safe
  : ingestTs;
```

Pass `recordTs` wherever `ingestTs` is currently passed into `resolveConflicts` and
`buildFieldData` for this record. The batch-level `ingestTs` continues to be used for the
source shadow `FieldEntry.ts` (the "this connector wrote this field at time T" provenance
stamp) where no per-record override is available.

### 3. `resolveConflicts` — no signature change needed

`resolveConflicts(incoming, targetShadow, incomingSrc, incomingTs, config)` already takes a
numeric `incomingTs`. It already does the right thing once `incomingTs` reflects the source's
own modification time rather than engine wall-clock.

---

## Example: HubSpot contact connector

HubSpot exposes `hs_lastmodifieddate` on every contact. The connector today places it in
`data`:

```typescript
{
  id: contact.id,
  data: { name: contact.properties.firstname, hs_lastmodifieddate: contact.properties.hs_lastmodifieddate }
}
```

After this plan, the connector also surfaces it as `updatedAt`:

```typescript
{
  id: contact.id,
  updatedAt: contact.properties.hs_lastmodifieddate,          // ISO 8601
  data: { name: contact.properties.firstname, hs_lastmodifieddate: contact.properties.hs_lastmodifieddate }
}
```

The engine parses `updatedAt` to epoch ms and uses it as the LWW `ts` for this record. A
contact last modified in the source at `T-1h` will now correctly lose to an ERP record
modified at `T-30m`, even if the HubSpot poll ran 5 seconds after the ERP poll.

---

## Current state of demo and playground

Neither the playground nor the CLI demo exercises real LWW conflict resolution today:

- The **playground** seed (`playground/src/lib/systems.ts`) is a static fixture with no
  `updatedAt` field on any record whatsoever. Every record arrives in the same poll batch
  with the same `ingestTs = Date.now()`, so `incomingTs >= existing.ts` is always true
  (equal) and every field is accepted. LWW never rejects anything.
- The **mock-CRM / mock-ERP connectors** have `updatedAt` in their `data` payload, but
  only use it as the `since` watermark filter (to decide which records to return on
  incremental reads). The engine never sees it for LWW purposes because `ReadRecord` has
  no `updatedAt` field to carry it.

This means the `conflict: { strategy: "lww" }` config in every playground scenario is
functionally inert — it cannot reject anything because all records from the same poll share
the same timestamp. Once `ReadRecord.updatedAt` is implemented, the playground seed and
mock connectors should set meaningful values on their records to make LWW visible.

---

## Out of scope

- Connector guide updates recommending where to find `updatedAt` per-API — follow-up
  documentation task.
- Storing `updatedAt` alongside `val/prev/ts/src` in `FieldEntry` as a separate field —
  the existing `ts` column in shadow state is overloaded for both provenance and LWW already.
  If source timestamps need to be independently queryable later, that is a separate schema
  change. For now, the parsed value simply becomes the `ts` the engine stores.
- Making `updatedAt` required. Forcing connectors to declare it is a breaking change; the
  optional fallback-to-ingestTs approach is always safe.
