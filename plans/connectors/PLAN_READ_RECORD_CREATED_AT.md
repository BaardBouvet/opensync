# PLAN: `ReadRecord.createdAt` — Record Origin Timestamp + `origin_wins` Resolution

**Status:** complete  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** Connector SDK, Engine  
**Scope:** `packages/sdk/src/types.ts`, `packages/engine/src/db/queries.ts`, `packages/engine/src/db/migrations.ts`, `packages/engine/src/core/conflict.ts`, `packages/engine/src/engine.ts`, `specs/connector-sdk.md`, `specs/field-mapping.md`  
**Depends on:** nothing (companion to `PLAN_READ_RECORD_UPDATED_AT`; both may be implemented together or separately)  

---

## § 1 Problem Statement

`updatedAt` (planned in `PLAN_READ_RECORD_UPDATED_AT`) solves *recency ranking* — it tells the
engine which source most recently changed a particular field. But recency is the wrong basis for
some conflicts:

1. **"Which system owns this entity?"** — If the ERP created a customer record on day 1 and the
   CRM created a copy on day 5, every sync cycle using `last_modified` risks letting the CRM
   overwrite authoritative ERP data whenever a CRM user touches the record — even if the ERP
   is the designated source of truth. What we need is: *which system was first*?

2. **LWW tie-breaking is arbitrary.** When two sources have equal `updatedAt` timestamps (same
   second, both NULL, or both absent), `last_modified` resolution falls back to declaration
   order in config — which is arbitrary and makes the outcome non-deterministic across config
   edits. A stable semantic tie-breaker would be: prefer the older source.

3. **"Set once" field semantics.** For fields that should never change after first assignment
   (a canonical customer number, an enrolment date, a creation note), `coalesce` takes the
   first non-null value by declaration order — not by which source actually created the record.
   `created_first` strategy would express the correct intent: use the value from the system
   that created the entity first, and never change it.

4. **Provenance / observability.** Knowing which source is the *originating system* for each
   canonical entity is valuable for debugging, auditing, and building operator-facing dashboards
   about data ownership. Today this information is unavailable in `SyncEvent` payloads.

`updatedAt` cannot substitute for `createdAt` here: modification time grows over time, but
creation time is immutable. A heavily-edited source with a recent `updatedAt` may still be a
downstream copy that was created long after the canonical system.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-sdk.md` | `ReadRecord` section | Document `createdAt` field: optional, ISO 8601, immutable semantics |
| `specs/field-mapping.md` | `§2.? origin_wins` (new) | New mapping-level strategy; describe per-field resolution semantics and ranked fallback |
| `specs/field-mapping.md` | `§2.2 last_modified` | Add tie-breaking note: when `incomingTs === existing.ts`, use `createdAt` of the competing sources as secondary comparator if available |
| `specs/field-mapping.md` | OSI-primitives coverage table | Add `origin_wins` row |

---

## § 3 Design

### § 3.1 `ReadRecord.createdAt` (SDK)

Add to `packages/sdk/src/types.ts`:

```ts
export interface ReadRecord {
  id: string;
  data: Record<string, unknown | unknown[]>;
  deleted?: boolean;
  associations?: Association[];
  version?: string;
  updatedAt?: string;      // from PLAN_READ_RECORD_UPDATED_AT — modification timestamp
  /** Source-assigned creation timestamp in ISO 8601 format.
   *  Treated as immutable by the engine: once stored in shadow, never overwritten.
   *  When present, enables `origin_wins` resolution and stable LWW tie-breaking.
   *  Omit for sources that do not expose a creation time. */
  createdAt?: string;
}
```

**Immutability convention:** The value is set once at the time of record creation on the source
system and never changes. The engine enforces this in shadow storage: once a non-null `created_at`
is persisted for a (connector, entity, externalId) triple, subsequent ingests with a conflicting
value are silently ignored. If the connector begins reporting `createdAt` on an existing record
(previously absent), the first received value is stored.

### § 3.2 Shadow storage (`db/migrations.ts`, `db/queries.ts`)

Add `created_at TEXT` to `shadow_state`:

```sql
-- packages/engine/src/db/migrations.ts (append to schema)
CREATE TABLE IF NOT EXISTS shadow_state (
  ...existing columns...,
  created_at TEXT          -- ISO 8601; set once on first ingest, never overwritten
);
```

On every shadow write for a source record, use `INSERT ... ON CONFLICT DO UPDATE` with a
`CASE` guard so `created_at` is only written when `NULL`:

```sql
UPDATE shadow_state
SET field_data = ?,
    created_at = CASE WHEN created_at IS NULL THEN ? ELSE created_at END
WHERE connector = ? AND entity = ? AND external_id = ?
```

New read helper:

```ts
/** Returns epoch ms for each source connector that has a non-null created_at for this
 *  canonical entity. Used by origin_wins resolution to rank sources. */
export function getSourceCreatedAts(
  db: Database,
  entity: string,
  canonicalId: string,
): Record<string, number>
```

### § 3.3 Resolution — `origin_wins` strategy

A new mapping-level strategy value alongside `coalesce`, `last_modified`, `collect`, `bool_or`:

```yaml
channel:
  conflict:
    strategy: origin_wins
```

**Semantics — per field:**

For each field in a conflict between the incoming source and the existing shadow entry, compare:

- `incomingCreatedAt` — epoch ms derived from `record.createdAt` for the incoming source
- `shadowCreatedAt` — epoch ms from `getSourceCreatedAts()[entry.src]` for the source
  that currently owns the shadow field (i.e., `entry.src` → its `createdAt`)

Rules:

| incoming | shadow | winner |
|----------|--------|--------|
| has `createdAt` and it is earlier | has `createdAt` | incoming wins |
| has `createdAt` | has no `createdAt` or shadow source has no `createdAt` | incoming wins |
| has no `createdAt` | has `createdAt` | shadow wins |
| neither has `createdAt` | — | fall back to `last_modified` (compare `ts`) |

A source with `createdAt` always beats a source without one; among undated sources, recency
(`ts`) decides normal LWW ordering. This means `origin_wins` degrades cleanly to `last_modified`
in the absence of creation timestamps, making it safe to adopt incrementally.

**Atomicity with groups:** If field groups are in use (`group:` on field mappings), the group
winner is elected by the **minimum** `incomingCreatedAt` across the group's fields (or the
owning source's `createdAt`, as above). All fields in the group resolve from the same source.

**Per-field strategy override:** A field-level `strategy:` override continues to take
precedence over the mapping-wide `origin_wins`. This allows mixing: "ERP owns everything
(`origin_wins`) except `priority`, which is always taken from the most recent update
(`last_modified`)."

### § 3.4 `last_modified` tie-breaking with `createdAt`

When the `last_modified` strategy is active and `incomingTs === existing.ts` (exact equality —
both NULL, both zero, or same millisecond), and `createdAt` information is available for both
competing sources, use it as a secondary, deterministic comparator:

- Earlier `createdAt` → **shadow wins** (older source is the origin; don't overwrite with a
  "copy" that happens to carry the same timestamp)

This makes tie resolution stable across config changes and is automatically engaged when
`createdAt` is present; no config change required.

### § 3.5 `resolveConflicts` signature extension (`conflict.ts`)

```ts
export function resolveConflicts(
  incoming: Record<string, unknown>,
  targetShadow: FieldData | undefined,
  incomingSrc: string,
  incomingTs: number,
  config: ConflictConfig,
  fieldMappings?: FieldMappingList,
  incomingFieldTimestamps?: Record<string, number>,  // from PLAN_FIELD_TIMESTAMPS
  incomingCreatedAt?: number,                        // NEW — epoch ms from record.createdAt
  createdAtBySrc?: Record<string, number>,           // NEW — { [srcConnector]: epoch ms }
): Record<string, unknown>
```

All new parameters are optional, preserving backward compatibility with all existing call sites.

### § 3.6 Engine wiring (`engine.ts`)

In `_processRecords`, before `resolveConflicts`:

```ts
// Spec: specs/field-mapping.md §2.? origin_wins
const incomingCreatedAt = record.createdAt
  ? (Date.parse(record.createdAt) || undefined)
  : undefined;

// Only paid when origin_wins strategy or last_modified tie-breaking is active.
const createdAtBySrc =
  (sourceMember.conflictConfig?.strategy === "origin_wins" ||
   sourceMember.conflictConfig?.strategy === "last_modified")
    ? getSourceCreatedAts(db, channel.entity, canonicalId)
    : undefined;
```

Pass both to `resolveConflicts`.

Shadow write — when calling `db.writeShadow(...)`, also pass `incomingCreatedAt` so the
`created_at` column is populated on first encounter.

### § 3.7 Observability — `originSource` in `SyncEvent`

Extend `RecordSyncResult` with an optional `originSource?: string` field indicating which
connector has the earliest stored `createdAt` for this canonical entity. This is derived
post-resolution from `createdAtBySrc` (minimum value wins), so no extra query is needed beyond
what §3.6 already fetches. When no source has `createdAt`, `originSource` is absent.

Engine emits this in `SyncEvent.result.originSource`.

---

## § 4 Tests

### § 4.1 Unit tests for `resolveConflicts` — `origin_wins` strategy

| ID | Scenario |
|----|----------|
| OW1 | `origin_wins`: incoming has earlier `createdAt` — incoming wins |
| OW2 | `origin_wins`: shadow source has earlier `createdAt` — shadow wins |
| OW3 | `origin_wins`: incoming has `createdAt`, shadow source does not — incoming wins |
| OW4 | `origin_wins`: neither has `createdAt` — falls back to `last_modified` ordering |
| OW5 | `origin_wins` + equal `createdAt` — falls back to `last_modified` then declaration order |
| OW6 | Field-level `strategy: last_modified` override respected on top of mapping `origin_wins` |
| OW7 | Group field atomicity: group winner elected by minimum `createdAt` across group fields |

### § 4.2 Unit tests — `last_modified` tie-breaking

| ID | Scenario |
|----|----------|
| TB1 | `last_modified`, equal `ts`, both have `createdAt` — shadow (older source) wins |
| TB2 | `last_modified`, equal `ts`, incoming has no `createdAt` — shadow wins deterministically |
| TB3 | `last_modified`, equal `ts`, shadow source has no `createdAt` — tie resolved by declaration order (no regression) |

### § 4.3 Shadow storage tests

| ID | Scenario |
|----|----------|
| CA1 | First ingest with `createdAt` — stored in shadow |
| CA2 | Second ingest with different `createdAt` — original value preserved (immutability) |
| CA3 | First ingest without `createdAt`, second ingest with `createdAt` — stored on second |
| CA4 | `getSourceCreatedAts` returns correct map for multi-source entity |

---

## § 5 Implementation Steps

### Step 1 — SDK (`types.ts`)
Add `createdAt?: string` to `ReadRecord` immediately after `updatedAt`.

### Step 2 — Shadow schema (`migrations.ts`)
Add `created_at TEXT` column to `shadow_state` using `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
inside the existing migration block.

### Step 3 — Shadow write (`db/queries.ts`)
Update `writeShadow` (or equivalent) to accept `createdAt?: string` and apply the
SET-if-NULL logic described in §3.2. Add `getSourceCreatedAts` query.

### Step 4 — `resolveConflicts` (`conflict.ts`)
Add `incomingCreatedAt` and `createdAtBySrc` parameters. Implement `origin_wins` strategy.
Add `createdAt` tie-breaking to the `last_modified` strategy.

### Step 5 — Engine wiring (`engine.ts`)
Parse `record.createdAt`, call `getSourceCreatedAts` when appropriate, pass both to
`resolveConflicts` and shadow write.

### Step 6 — Observability
Add `originSource?: string` to `RecordSyncResult`; derive from `createdAtBySrc` post-resolution.

### Step 7 — Tests + spec update
Write OW1–OW7, TB1–TB3, CA1–CA4. Update `specs/connector-sdk.md` and `specs/field-mapping.md`
as described in §2.

---

## § 6 Future Extensions

**`created_first` as a field-level strategy alias** — syntactic sugar for `strategy: origin_wins`
scoped to a single field. The same `incomingCreatedAt` / `createdAtBySrc` machinery applies;
only the scope changes. Deferred: `origin_wins` at the mapping level already covers the
field-level case through per-field strategy overrides.

**Deduplication signal** — records from different sources with very similar `createdAt` values
(within a configurable tolerance) are strong identity-match candidates. Could feed a future
fuzzy-identity matching pass. Out of scope here; `createdAt` would be available in shadow for
that feature to read.

**Migration-window filtering** — an engine-level config option to only accept records from a
source if `record.createdAt > cutoffDate` (for staged migrations where historical records on
the new system should be ignored). Out of scope; expressible today via `record_filter`
expressions once `createdAt` is in `data`, or via a future filter that reads from shadow.

**`createdAt` on `WriteRecord`** — when the engine writes a new record to a target connector,
passing the canonical `createdAt` (from the originating source) allows the target to preserve
the original creation time. Requires a `createdAt` field on the connector SDK's write side.
Out of scope pre-v1 since not all APIs accept external creation timestamps.
