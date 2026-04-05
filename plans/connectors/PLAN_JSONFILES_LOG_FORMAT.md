# PLAN: jsonfiles Immutable Log Format

**Status:** complete  
**Domain:** dev/connectors/jsonfiles  
**Spec changes planned:** none — jsonfiles is a dev/testing fixture; its format is defined by
code comments in `dev/connectors/jsonfiles/src/index.ts`, not in `specs/`.

---

## 1. Goal

Add an opt-in **immutable log format** to the jsonfiles connector.  
In log mode every mutation (insert, update, delete) is **appended** to the JSON array rather
than mutating the existing entry.  The array is kept sorted by `updated` ascending.  
Reads deduplicate by id, emitting only the latest version of each record.

---

## 2. Motivation

The current mutable format overwrites records in-place.  After a demo run the JSON files
contain only the final state, making it hard to answer "what actually happened during that
sync cycle?"

With the log format:
- Every change leaves a permanent trace in the file, in chronological order.
- Reviewers can open `accounts.json` and immediately see the sequence of mutations.
- The engine still sees a clean, deduplicated view — nothing else changes.
- Seed data stays human-writable (same envelope shape, just multiple entries per id allowed).

---

## 3. Design

### 3.1 Activation

New per-connector config option:

```jsonc
"logFormat": true   // default: false
```

`false` is the default so all existing demo fixtures and tests continue to work unchanged.

The associations-demo example is the primary candidate for enabling this flag — the demo
produces visible churn across multiple sync cycles, which is exactly what the log makes
legible.

### 3.2 File format in log mode

The envelope shape (`id`, `data`, `updated`, `associations`) is unchanged.  
The only difference is that multiple entries with the same `id` are allowed — each
represents a version.  Versions are kept sorted by `updated` ascending.

Example: `accounts.json` after two sync cycles

```json
[
  { "id": "acc1", "data": { "accountName": "Acme" },            "updated": 1 },
  { "id": "acc2", "data": { "accountName": "Globex" },          "updated": 1 },
  { "id": "acc1", "data": { "accountName": "Acme Corp" },       "updated": 2 },
  { "id": "acc3", "data": { "accountName": "Initech" },         "updated": 3 },
  { "id": "acc2", "_deleted": true,                             "updated": 4 }
]
```

Reading this file emits two live records: `acc1` (version 2) and `acc3` (version 3).
`acc2` is tombstoned.

### 3.3 Read algorithm in log mode

1. Load all entries from the file.
2. Group entries by `id`.
3. For each group, select the entry with the maximum `updated` watermark (the last entry in the
   sorted array).  Call this the *effective* record.
4. Drop any effective record where `_deleted` is `true` (tombstone).
5. If `since` is provided, drop any effective record whose `updated` is not newer than `since`.
6. Compute `maxWatermark` across all emitted effective records.
7. Yield one `ReadBatch` with the deduplicated, filtered records.

The deduplication in step 3 is O(n) and can be done in a single pass over the sorted array
(last-wins), so no extra sort pass is needed at read time.

`since` semantics are unchanged: the engine advances the watermark to `maxWatermark` after
each successful read.  A record whose `updated` has not changed since the last sync will
not be re-emitted — exactly the behaviour the engine relies on.

### 3.4 Insert in log mode

When log mode is active, insert behaves identically to the current implementation:
append a new entry with the next watermark and return the new `id`.  
No duplicate-id conflict check is performed (the same `id` can appear multiple times).

### 3.5 Update in log mode

Instead of finding and mutating the existing entry, the update:

1. Loads the file.
2. Finds the **effective record** for the given `id` (latest version, step 3 above).
3. If no effective record exists (id unknown or tombstoned), yields `{ id, notFound: true }`.
4. Merges the incoming fields over the effective record's `data` (identical merge semantics
   to the current implementation).
5. Appends a new entry with the merged `data`, the next watermark, and the updated
   `associations` if provided.
6. Returns the merged `data`.

The old entries remain untouched.

### 3.6 Delete in log mode (tombstones)

Instead of splicing the entry out of the array, delete appends a **tombstone**:

```jsonc
{ "id": "<id>", "_deleted": true, "updated": <nextWatermark> }
```

The `_deleted` field name defaults to `"_deleted"` and is configurable via a new config
option `deletedField`.

If the id does not exist in the file (no entries with that `id`), the operation yields
`{ id, notFound: true }` without writing a tombstone.

### 3.7 Lookup in log mode

`lookup(ids)` applies the same deduplication as the read algorithm — it returns the latest
effective (non-tombstoned) version of each requested id.  If the latest version is a
tombstone the id is omitted from the result.

### 3.8 Watermark computation

`nextWatermark` examines **all** entries in the file (not just effective records) to
determine the current maximum.  Appending always produces a strictly larger watermark, so
the array stays sorted ascending without a re-sort step.

Integer mode: `max(all updated values) + 1`  
ISO mode: `new Date().toISOString()`  
Empty file: `1` (integer mode starts)

This is the same logic as today; no changes to `nextWatermark` are needed.

### 3.9 Backward compatibility

- Default `logFormat: false` — no existing demo fixture or test is affected.
- The `_deleted` field only appears in log-format files.  
- The `deletedField` config option is only consulted when `logFormat: true`.
- A mutable-format file can be switched to log-format by adding `"logFormat": true` to the
  connector config; the existing entries are treated as version 1 of each record.

---

## 4. New config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logFormat` | `boolean` | `false` | Enable immutable-log mode |
| `deletedField` | `string` | `"_deleted"` | Field name used on tombstone entries |

Both options are added to `configSchema` in the connector metadata.

---

## 5. Implementation tasks

1. **`FileRecord` type** — add optional `[key: string]: unknown` entry for `_deleted` (it
   is already covered by the index signature; document it in the type comment).
2. **`logFormat` and `deletedField` extraction** — add alongside the existing `fieldConfig`
   helper or inline in `makeRecordEntity`.
3. **`latestByIdLog(entries, idField, watermarkField)`** — new internal helper that
   implements the deduplication algorithm (§3.3 steps 1–4).  Returns a `Map<string, FileRecord>`.
4. **`read`** — branch on `logFormat`: call `latestByIdLog`, apply `since` filter, compute
   `maxWatermark` over deduplicated records.
5. **`lookup`** — branch on `logFormat`: apply `latestByIdLog`, filter requested ids.
6. **`insert`** — no change needed; existing append logic is already correct for log mode.
   Add a comment clarifying the invariant.
7. **`update`** — branch on `logFormat`: resolve effective record via `latestByIdLog`,
   append new version instead of mutating in-place.
8. **`delete`** — branch on `logFormat`: find effective record, append tombstone instead of
   splicing.
9. **`configSchema`** — add `logFormat` and `deletedField` entries.
10. **File-format comment block** — extend the comment at the top of `index.ts` to describe
    log-format invariants.

---

## 6. Test plan

All new tests go into the existing `describe("jsonfiles connector")` block in
`dev/connectors/jsonfiles/src/index.test.ts`.

New `describe("log format")` block covering:

| # | Scenario | Assertion |
|---|----------|-----------|
| 1 | Insert two records | File has 2 entries; read emits both |
| 2 | Insert then update | File has 2 entries for same id; read emits only latest data |
| 3 | Insert then delete | File has 2 entries; read emits nothing (tombstone) |
| 4 | `since` filter — updated record is newer than `since` | Re-emitted |
| 5 | `since` filter — record not changed since `since` | Not emitted |
| 6 | `since` filter — record inserted then deleted after `since` | Not emitted (tombstone is latest) |
| 7 | `lookup` returns latest version | Correct merged data |
| 8 | `lookup` for tombstoned id returns nothing | Empty array |
| 9 | `update` on unknown id yields `notFound` | Correct |
| 10 | `delete` on unknown id yields `notFound` | Correct |
| 11 | Multiple inserts produce ascending `updated` ordering in file | Array sorted |
| 12 | `logFormat: false` (default) — update still mutates in-place | File has 1 entry after insert+update |

---

## 7. Demo wiring

Once implemented, add `"logFormat": true` to the jsonfiles connector instances in the
associations-demo `opensync.json` (or whichever demo best illustrates multi-cycle changes).
Reset the seed data files to their original state; after a run, the file will accumulate a
readable history.

No other demo changes are required.
