# Per-Field Timestamps — Always-On Shadow Derivation

**Status:** complete  
**Date:** 2026-04-08  
**Effort:** S  
**Domain:** Engine — ingest  
**Scope:** `packages/engine/src/core/mapping.ts`, `packages/engine/src/db/queries.ts`, `packages/engine/src/core/conflict.ts`, `packages/engine/src/engine.ts`, `specs/field-mapping.md`  
**Depends on:** `PLAN_WRITTEN_STATE` (complete), `plans/connectors/PLAN_FIELD_TIMESTAMPS.md`  

---

## § 1 Problem Statement

`last_modified` (LWW) resolution requires a per-field timestamp to know which source's value is
the most recently changed. Currently every field in a record gets the flat batch-wide
`ingestTs = Date.now()`, which means:

1. **Timestampless sources cannot be ranked by recency.** If a connector reports no per-field
   modification timestamps, a field that hasn't changed in six months gets the same `ts` as one
   that changed a minute ago. `last_modified` resolution degenerates to declaration order.

2. **Connector-supplied per-field timestamps are not consumed.** `ReadRecord.fieldTimestamps`
   (see `plans/connectors/PLAN_FIELD_TIMESTAMPS.md`) allows connectors to supply authoritative
   per-field modification times, but the engine has no code to read or use them.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §1.9 | Replace: config-based `lastModifiedField` is superseded by `ReadRecord.fieldTimestamps` on the connector. Update the section to describe the connector-native approach (see `plans/connectors/PLAN_FIELD_TIMESTAMPS.md`). |
| `specs/field-mapping.md` | §2.2 | Update note: config-level `last_modified` column is superseded by `ReadRecord.updatedAt`; remove the "not yet wired" notice and replace with a note that the engine now uses `updatedAt` directly. |
| `specs/field-mapping.md` | §7.2 | Redesign: `derive_timestamps` is no longer an opt-in config flag — shadow derivation is applied unconditionally on every ingest. Add the priority chain (§3.1 below). Update baseline from `written_state` to `shadow_state` with rationale. |
| `plans/engine/GAP_OSI_PRIMITIVES.md` | §5 Per-field timestamps, §7.2 | Update §5 from 🔶 to ✅; §7.2 from ❌ to ✅. Update summary table counts. |

---

## § 3 Design

### § 3.1 Always-on shadow derivation

For every incoming field on every ingest cycle the engine now computes a per-field timestamp
rather than using a flat `ingestTs`. No configuration is required. The priority chain is:

```
record.fieldTimestamps[field]        (highest — connector-native, per-field authoritative)
  ?? derive from shadow:
       changed field  →  record.updatedAt ?? ingestTs
       unchanged field → shadow[field].ts
  ?? ingestTs                        (new record, no shadow exists yet)
```

`record.fieldTimestamps` and `record.updatedAt` are both defined in
`plans/connectors/PLAN_FIELD_TIMESTAMPS.md` and `plans/connectors/PLAN_READ_RECORD_UPDATED_AT`
respectively; neither is required and existing connectors continue to work unchanged.

### § 3.2 New utility: `computeFieldTimestamps` (core/mapping.ts)

A pure function added to `core/mapping.ts` alongside `applyMapping`:

```ts
/**
 * Compute a per-field timestamp map for one incoming source record.
 * Spec: specs/field-mapping.md §7.2
 */
export function computeFieldTimestamps(
  incoming: Record<string, unknown>,    // canonical (post-mapping) record
  existingShadow: FieldData | undefined,
  record: ReadRecord,
  ingestTs: number,
): Record<string, number>
```

Implementation:

```ts
const baseTs = record.updatedAt ? (Date.parse(record.updatedAt) || ingestTs) : ingestTs;
const result: Record<string, number> = {};
for (const field of Object.keys(incoming)) {
  // 1. Connector-native per-field timestamp
  const native = parseTs(record.fieldTimestamps?.[field]);
  if (native !== undefined) { result[field] = native; continue; }
  // 2. Shadow derivation
  const entry = existingShadow?.[field];
  if (entry && JSON.stringify(entry.val) === JSON.stringify(incoming[field])) {
    result[field] = entry.ts;   // unchanged — carry forward shadow timestamp
  } else {
    result[field] = baseTs;     // changed or new field
  }
}
return result;
```

**`parseTs`** (also in `core/mapping.ts`, exported for tests):

```ts
/** Accept epoch ms (number), ISO 8601 string, or null/undefined. Returns epoch ms or undefined. */
export function parseTs(v: unknown): number | undefined {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}
```

### § 3.3 `buildFieldData` extension (db/queries.ts)

Add an optional `fieldTimestamps` parameter (backward-compatible — all existing call sites
continue working without change):

```ts
export function buildFieldData(
  existing: FieldData | undefined,
  incoming: Record<string, unknown>,
  src: string,
  ts: number,                               // fallback used when fieldTimestamps absent
  assocSentinel: string | undefined,
  fieldTimestamps?: Record<string, number>, // NEW — per-field overrides
): FieldData
```

Inside the loop: `fd[k] = { val, prev, ts: fieldTimestamps?.[k] ?? ts, src }`.

The `__assoc__` sentinel continues to use the flat `ts` — associations have no per-field
timestamp concept.

### § 3.4 `resolveConflicts` extension (conflict.ts)

Add optional `incomingFieldTimestamps?: Record<string, number>` as the last parameter.
Introduce a per-field accessor inside the body:

```ts
const fieldTs = (field: string) => incomingFieldTimestamps?.[field] ?? incomingTs;
```

Replace every direct `incomingTs` timestamp comparison with `fieldTs(field)` at the four
affected sites:

1. **Group pre-pass** — elect group winner by `max(fieldTs(f) for f in groupFields)`.
2. **`last_modified` field strategy** — `if (fieldTs(field) >= existing.ts)`.
3. **Global LWW (default)** — same.
4. **`coalesce` tie-break** — same.

`collect` and `bool_or` strategies are timestamp-independent; no changes.

### § 3.5 Engine wiring (engine.ts)

In `_processRecords`, after the shadow read, compute field timestamps and thread them through
the ingest path:

```ts
// Spec: specs/field-mapping.md §7.2
const fieldTimestamps = computeFieldTimestamps(canonical, existingShadow, record, ingestTs);
```

Pass `fieldTimestamps` to:
- `resolveConflicts(..., sourceMember.inbound, fieldTimestamps)`
- both `buildFieldData` calls (source shadow write and child outcomes)

Apply the same pattern in the **array expansion path** (child records use their own
`childCanonical` and child shadow entry) and the **`collectOnly` path** (`buildFieldData` only).

### § 3.6 Baseline choice: shadow vs. written_state

The comparison is against `shadow_state.val` (last value read from the connector), not
`written_state` (last value written to a connector).

- `shadow_state` is always present for source connectors. `written_state` is only populated
  when the engine has written back to a connector as a target. A read-only connector will never
  have a `written_state` row.
- `shadow_state.val` is what the connector reported — the right baseline for detecting whether
  the connector itself changed a field since the last ingest.
- `written_state` solves echo prevention after round-trip writes; it is the wrong baseline here.

Rationale:

- **`shadow_state` is always available for sources.** It is written on every ingest cycle for
  every source. `written_state` is only populated when the engine writes back to a connector as
  a *target*. A read-only source (one the engine never writes to) will never have a
  `written_state` row, making the `written_state` approach useless for the most common
  timestampless-source case.

- **`shadow_state.val` is the last seen value, which is exactly the right comparison.** If
  `incoming[field] == shadow[field].val`, the source hasn't changed that field since the last
  ingest; carry forward its timestamp. If they differ, the source changed it; stamp `ingestTs`.

- **`written_state` solves a different problem** (echo prevention after round-trip writes). It
  is not the right baseline for detecting what a source itself changed.

Edge case — normalisation divergence: if the engine writes `email=bob@example.com` to a source
that echoes back `email=BOB@EXAMPLE.COM`, `derive_timestamps` will see them as different and
assign `ingestTs`. The `normalize` function (§1.4) already handles this at the noop-diff and
conflict-resolution levels. The slight over-attribution of freshness to precision-diverging
fields is harmless for LWW purposes because `normalize` also guards the conflict resolver,
preventing a normalisation echo from winning resolution inappropriately.

---

## § 4 Tests

| ID | Scenario |
|----|----------|
| FT1 | New record (no shadow) → all fields get `ingestTs` |
| FT2 | New record with `record.updatedAt` → all fields get parsed `updatedAt` |
| FT3 | `record.fieldTimestamps` present → named fields use per-field ts; unlisted fields use derivation |
| FT4 | Unchanged field (same value as shadow) → carries forward shadow `ts` |
| FT5 | Changed field (differs from shadow) → gets `ingestTs` |
| FT6 | Changed field with `record.updatedAt` → gets parsed `updatedAt`, not `ingestTs` |
| FT7 | `fieldTimestamps` entry present for field that is also in shadow → `fieldTimestamps` wins |
| FT8 | `parseTs` with epoch ms number → returns as-is |
| FT9 | `parseTs` with ISO 8601 string → returns epoch ms |
| FT10 | `parseTs` with invalid string → returns `undefined` |
| FT11 | LWW integration: older-ts field loses even if it arrives in a later ingest cycle |
| FT12 | LWW integration: unchanged field keeps old ts; competing more-recent value wins |
| FT13 | Group atomicity preserved: group winner elected by max ts across group fields |

---

## § 5 Implementation Steps

1. Add `parseTs` and `computeFieldTimestamps` to `core/mapping.ts`.
2. Add optional `fieldTimestamps` parameter to `buildFieldData` in `db/queries.ts`.
3. Add optional `incomingFieldTimestamps` parameter to `resolveConflicts` in `conflict.ts`;
   introduce `fieldTs(field)` helper; replace timestamp-comparison sites.
4. Wire `computeFieldTimestamps` in `engine.ts` (`_processRecords`: flat, array expansion,
   and `collectOnly` paths).
5. Write FT1–FT13.
6. Update `specs/field-mapping.md §1.9`, `§2.2`, `§7.2` and `GAP_OSI_PRIMITIVES.md`.
3. Update `specs/field-mapping.md §2.2` status note.
4. Update `specs/field-mapping.md §7.2` → "implemented"; add baseline-choice note.
5. Update `GAP_OSI_PRIMITIVES.md` §5 and §7.2 markers and summary table.

---

## § 6 Future Extension

**`written_state` as derive baseline (post-v1 option):** For connectors where the engine
also writes back (bidirectional sync), comparing against `written_state` would ignore
round-trip echoes more precisely than shadow comparison. This could be a follow-on
`derive_timestamps: "written"` variant. Not needed before first public release.

**`lastModifiedField` in `collectOnly`:** The current design applies `computeFieldTimestamps`
in `collectOnly` only to pass through to `buildFieldData`. LWW resolution does not run during
`collectOnly`. The timestamps are stored in shadow so that when the first full ingest follows,
the pre-seeded timestamps are already correct for resolution.
