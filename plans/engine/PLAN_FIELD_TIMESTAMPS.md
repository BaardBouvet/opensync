# Field-Level Timestamps (`lastModifiedField` + `derive_timestamps`)

**Status:** proposed  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** Engine — field mapping  
**Scope:** `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/db/queries.ts`, `packages/engine/src/core/conflict.ts`, `packages/engine/src/core/mapping.ts`, `packages/engine/src/engine.ts`, `specs/field-mapping.md`  
**Depends on:** `PLAN_WRITTEN_STATE` (complete)  

---

## § 1 Problem Statement

`last_modified` (LWW) resolution requires a per-field timestamp to know which source's value is
the most recently changed. Currently, every field in a record gets the same batch timestamp
(`ingestTs = Date.now()`), which means:

1. **Connector-supplied per-field timestamps are silently ignored.** Some APIs attach an
   independent update time to each field (e.g. an audit log column `email_updated_at`). Even
   when a connector returns such columns the engine never reads them — every field in the batch
   gets the same clock time.

2. **Timestampless sources cannot participate in LWW resolution.** CSV files, legacy REST APIs,
   flat-file imports, and polling connectors that report no updated-at column look equally "fresh"
   every cycle. Two sources that both lack timestamps cannot be ranked by recency, so
   `last_modified` resolution degenerates to declaration order regardless of what actually changed.

Both gaps are documented in `specs/field-mapping.md` — §1.9 (`lastModifiedField` per-field config)
and §7.2 (`derive_timestamps`) — but neither is implemented. This plan implements both features
together since they share the same machinery: both produce a `Record<string, number>` of per-field
timestamps that replace the single flat `ingestTs` at resolution and shadow-write time.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §1.9 | Update status from "designed, not yet implemented" to "implemented". Add `last_modified` mapping-level config key (timestamp column for all fields in the mapping). |
| `specs/field-mapping.md` | §2.2 | Update status note: "config-level `last_modified` key is now wired". |
| `specs/field-mapping.md` | §7.2 | Update status from "not yet implemented" to "implemented". Add design note: baseline is `shadow_state.val` (not `written_state`), with rationale. |
| `plans/engine/GAP_OSI_PRIMITIVES.md` | §5 Per-field timestamps, §7 `derive_timestamps` | Update §5 per-field timestamps from 🔶 to ✅; §7.2 from ❌ to ✅. Update summary table counts. |

---

## § 3 Design

### § 3.1 Two features, one shared mechanism

**Feature A — Connector-supplied per-field timestamps** (closes spec §1.9 + §2.2):

- `lastModifiedField: col` on an individual field mapping: use `record["col"]` as the update
  timestamp for that specific field.
- `last_modified: col` at the mapping level (already documented in §2.2): use `record["col"]`
  as the timestamp for **all** fields in the mapping (same semantics as today's implicit
  `ingestTs`, but sourced from the connector record rather than the wall clock).

**Feature B — Engine-derived timestamps** (closes spec §7.2):

- `derive_timestamps: true` at the mapping level: for each incoming field, compare the incoming
  value against the stored shadow value. Changed fields get `ingestTs`; unchanged fields carry
  forward the shadow's stored timestamp. This enables LWW resolution for connectors that report
  no timestamps at all.

Both features output a `fieldTimestamps: Record<string, number>` map that is threaded through
resolution (`resolveConflicts`) and shadow writes (`buildFieldData`).

### § 3.2 Priority chain

When multiple mechanisms could supply a timestamp for the same field, the precedence is:

```
per-field lastModifiedField   (highest — most specific, connector-authoritative)
  ?? mapping-level last_modified
  ?? derive_timestamps derivation
  ?? ingestTs                  (default — current behaviour, no config)
```

### § 3.3 Config additions (schema.ts)

**`FieldMappingEntrySchema`** gains one key:

```ts
lastModifiedField: z.string().optional()
// Column on the source record carrying this field's update timestamp.
// Spec: specs/field-mapping.md §1.9
```

**`MappingEntrySchema`** gains two keys:

```ts
last_modified: z.string().optional()
// Column on the source record carrying the update timestamp for all fields.
// Spec: specs/field-mapping.md §2.2

derive_timestamps: z.boolean().optional()
// Derive per-field timestamps by comparing incoming values against shadow.
// Spec: specs/field-mapping.md §7.2
```

**Validation**: if both `last_modified` and `derive_timestamps` are set on the same mapping
entry, throw a config-load error (they are mutually exclusive: one sources timestamps from the
connector record, the other derives them from shadow comparisons).

### § 3.4 Type additions (loader.ts)

**`FieldMapping`** gains:

```ts
/** Source record column carrying the per-field update timestamp. Accepts epoch ms (number)
 *  or ISO 8601 string. When present and non-null, takes priority over mapping-level
 *  lastModified and deriveTimestamps for this field.
 *  Spec: specs/field-mapping.md §1.9 */
lastModifiedField?: string;
```

**`ChannelMember`** gains:

```ts
/** Column on the source record carrying the update timestamp for all fields in this mapping.
 *  Accepts epoch ms (number) or ISO 8601 string. Overridden per-field by lastModifiedField.
 *  Spec: specs/field-mapping.md §2.2 */
lastModified?: string;

/** When true, per-field timestamps are derived by comparing incoming values against the
 *  stored shadow. Changed fields get ingestTs; unchanged fields carry forward their prior
 *  shadow timestamp. Enables LWW resolution for connectors that report no timestamps.
 *  Mutually exclusive with lastModified (config-load error if both are set).
 *  Spec: specs/field-mapping.md §7.2 */
deriveTimestamps?: boolean;
```

### § 3.5 New utility: `computeFieldTimestamps` (core/mapping.ts)

A pure function placed in `core/mapping.ts` alongside `applyMapping`:

```ts
/**
 * Compute a per-field timestamp map for one incoming source record.
 * Priority: lastModifiedField > lastModified > deriveTimestamps > ingestTs.
 * Spec: specs/field-mapping.md §1.9, §2.2, §7.2
 */
export function computeFieldTimestamps(
  incoming: Record<string, unknown>,       // canonical (post-mapping) record
  rawStripped: Record<string, unknown>,    // raw pre-mapping record (for column lookups)
  existingShadow: FieldData | undefined,   // current shadow for this (connector, entity, externalId)
  inbound: FieldMappingList | undefined,
  member: ChannelMember,
  ingestTs: number,
): Record<string, number>
```

Implementation sketch:

```ts
const mappingTs = member.lastModified !== undefined
  ? parseTs(rawStripped[member.lastModified])
  : undefined;

const result: Record<string, number> = {};
for (const field of Object.keys(incoming)) {
  // 1. Per-field lastModifiedField override
  const fm = inbound?.find((m) => m.target === field);
  if (fm?.lastModifiedField !== undefined) {
    const v = parseTs(rawStripped[fm.lastModifiedField]);
    if (v !== undefined) { result[field] = v; continue; }
  }
  // 2. Mapping-level last_modified
  if (mappingTs !== undefined) { result[field] = mappingTs; continue; }
  // 3. derive_timestamps — compare against shadow
  if (member.deriveTimestamps) {
    const entry = existingShadow?.[field];
    if (entry && JSON.stringify(entry.val) === JSON.stringify(incoming[field])) {
      result[field] = entry.ts;   // unchanged → carry forward shadow timestamp
    } else {
      result[field] = ingestTs;   // changed or new field
    }
    continue;
  }
  // 4. Default: batch timestamp
  result[field] = ingestTs;
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

### § 3.6 `buildFieldData` extension (db/queries.ts)

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
): FieldData {
  const fd: FieldData = existing ? { ...existing } : {};
  for (const [k, val] of Object.entries(incoming)) {
    const prev = fd[k]?.val ?? null;
    fd[k] = { val, prev, ts: fieldTimestamps?.[k] ?? ts, src };
  }
  if (assocSentinel !== undefined) {
    const prev = fd["__assoc__"]?.val ?? null;
    fd["__assoc__"] = { val: assocSentinel, prev, ts, src };
  }
  return fd;
}
```

The `__assoc__` sentinel continues to use the flat `ts` (not per-field) because associations
are not individual fields and have no meaningful per-field timestamp concept.

### § 3.7 `resolveConflicts` extension (conflict.ts)

Add an optional `incomingFieldTimestamps` parameter:

```ts
export function resolveConflicts(
  incoming: Record<string, unknown>,
  targetShadow: FieldData | undefined,
  incomingSrc: string,
  incomingTs: number,
  config: ConflictConfig,
  fieldMappings?: FieldMappingList,
  incomingFieldTimestamps?: Record<string, number>,  // NEW
): Record<string, unknown>
```

Inside the body, replace every direct use of `incomingTs` in a timestamp comparison with:

```ts
const fieldTs = (field: string) => incomingFieldTimestamps?.[field] ?? incomingTs;
```

**Affected sites:**

1. **Group pre-pass** — the group winner is elected by comparing the incoming aggregate
   timestamp against the existing aggregate timestamp. Replace the per-group `incomingTs` with
   `max(fieldTs(f) for f in groupFields)`:
   ```ts
   let incomingGroupTs = -Infinity;
   for (const m of groupFields) {
     const t = incomingFieldTimestamps?.[m.target] ?? incomingTs;
     if (t > incomingGroupTs) incomingGroupTs = t;
   }
   // ... compare incomingGroupTs against existingGroupTs
   ```

2. **`last_modified` field strategy** — `if (incomingTs >= existing.ts)` →
   `if (fieldTs(field) >= existing.ts)`.

3. **Global LWW (default)** — same replacement.

4. **`coalesce` tie-break** — `incomingTs >= existingTs` → `fieldTs(field) >= existingTs`.

The `collect` and `bool_or` strategies are timestamp-independent and need no changes.

### § 3.8 Engine wiring (engine.ts)

In `_processRecords`, **standard flat path**, after `applyMapping` and the existing shadow read:

```ts
// Spec: specs/field-mapping.md §1.9, §7.2
const fieldTimestamps = computeFieldTimestamps(
  canonical, stripped, existingShadow, sourceMember.inbound, sourceMember, ingestTs,
);
```

Pass `fieldTimestamps` to:
- `resolveConflicts(canonical, targetShadow, ..., sourceMember.inbound, fieldTimestamps)`
- `buildFieldData(existingShadow, canonical, ..., ingestTs, sentinel, fieldTimestamps)`

The same pattern applies in the **array expansion path** for child records (using
`childCanonical`, `childStripped`, and the child's own shadow entry).

For the **`collectOnly` path**, also compute and pass `fieldTimestamps` to `buildFieldData`.
Echo detection in `collectOnly` uses the stripped raw record so it remains unaffected.

### § 3.9 Baseline choice for `derive_timestamps`: shadow vs. written_state

`PLAN_WRITTEN_STATE §5` originally proposed comparing against `written_state` (what the engine
last **wrote** to a connector). This plan uses `shadow_state` (what was last **read** from a
connector) as the comparison baseline.

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

### § 4.1 Unit tests for `computeFieldTimestamps` (mapping.test.ts)

| ID | Scenario |
|----|----------|
| FT1 | No config → all fields get `ingestTs` |
| FT2 | Mapping-level `lastModified` column → all fields get `record[col]` as ms |
| FT3 | Mapping-level `lastModified` as ISO string → correctly parsed to epoch ms |
| FT4 | Per-field `lastModifiedField` overrides mapping-level for that field; other fields still use mapping-level |
| FT5 | `derive_timestamps: true`, field unchanged (same as shadow) → carries forward shadow `ts` |
| FT6 | `derive_timestamps: true`, field changed → gets `ingestTs` |
| FT7 | `derive_timestamps: true`, no shadow (new record) → all fields get `ingestTs` |
| FT8 | `lastModifiedField` column absent or null in source record → falls back to mapping-level or `ingestTs` |
| FT9 | Both `lastModified` and `derive_timestamps` set in YAML → config-load throws |

### § 4.2 Integration tests for LWW with per-field timestamps (conflict.test.ts or mapping.test.ts)

| ID | Scenario |
|----|----------|
| FT10 | `lastModifiedField`: older source field (lower timestamp) loses LWW even if it arrives in a later ingest cycle |
| FT11 | `derive_timestamps`: a field that hasn't changed keeps its original timestamp so a more-recently-changed field from the other source wins |
| FT12 | `derive_timestamps`: a field that did change in this cycle gets `ingestTs` and beats an older competing value |
| FT13 | Group field atomicity preserved with per-field timestamps: group winner elected by max timestamp across group fields |

---

## § 5 Implementation Steps

### Step 1 — Schema additions (schema.ts)

1. Add `lastModifiedField: z.string().optional()` to `FieldMappingEntrySchema`.
2. Add `last_modified: z.string().optional()` and `derive_timestamps: z.boolean().optional()`
   to `MappingEntrySchema`.

### Step 2 — Type and loader additions (loader.ts)

1. Add `lastModifiedField?: string` to `FieldMapping`.
2. Add `lastModified?: string` and `deriveTimestamps?: boolean` to `ChannelMember`.
3. Wire them in the mapping-entry compilation step (where `ChannelMember` is built from
   `MappingEntry`): set `member.lastModified`, `member.deriveTimestamps`, and
   `fm.lastModifiedField` from the parsed YAML values.
4. Add the mutual-exclusion validation: throw if both `last_modified` and `derive_timestamps`
   are set on the same mapping entry.

### Step 3 — `buildFieldData` extension (db/queries.ts)

Add optional `fieldTimestamps?: Record<string, number>` parameter. Use
`fieldTimestamps?.[k] ?? ts` in the `FieldEntry` construction. No existing callers change.

### Step 4 — `computeFieldTimestamps` + `parseTs` (core/mapping.ts)

Add both functions. Export `parseTs` so it can be tested directly.

### Step 5 — `resolveConflicts` extension (conflict.ts)

1. Add optional `incomingFieldTimestamps` parameter.
2. Introduce a per-field accessor `const fieldTs = (f: string) => incomingFieldTimestamps?.[f] ?? incomingTs`.
3. Replace `incomingTs` with `fieldTs(field)` at the four timestamp-comparison sites
   (group pre-pass, `last_modified` strategy, global LWW, `coalesce` tie-break).

### Step 6 — Engine wiring (engine.ts)

1. Import `computeFieldTimestamps` from `core/mapping.ts`.
2. In `_processRecords` (standard flat path): add `computeFieldTimestamps` call after the
   shadow read; pass `fieldTimestamps` to `resolveConflicts` and both `buildFieldData` calls
   (source shadow write and child outcomes).
3. In `_processRecords` (array expansion path): same for child records using `childStripped`,
   `childCanonical`, and the child's own shadow entry.
4. In the `collectOnly` path: same for `buildFieldData`.

### Step 7 — Tests and spec update

1. Write FT1–FT13.
2. Update `specs/field-mapping.md §1.9` → "implemented".
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
