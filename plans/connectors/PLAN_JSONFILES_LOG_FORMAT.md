# PLAN: jsonfiles Immutable Log Format

**Status:** complete  
**Date:** 2026-04-05  
**Domain:** dev/connectors/jsonfiles  

**Spec changes planned:** none — jsonfiles is a dev/testing fixture; its format is defined by
code comments in `dev/connectors/jsonfiles/src/index.ts`, not in `specs/`.

---

## 1. Goal

Add an opt-in **companion log file** to the jsonfiles connector.
When `logFormat: true`, every mutation (insert, update, delete) is also appended to a
separate `<basename>.log.json` file alongside the main data file.
The main data file stays a **mutable latest-state view** — users can edit it directly.

---

## 2. Motivation

The original design made the main file append-only and required read-time deduplication.
This turned out to be more awkward than useful: users could no longer simply edit the data
file to trigger changes, and the file became hard to reason about after many cycles.

The revised design keeps the main file clean and adds the log as an opt-in sidecar:
- Users edit `accounts.json` directly; the sync engine picks up the diff as usual.
- The `accounts.log.json` sidecar accumulates every mutation in chronological order,
  making it easy to answer "what actually happened during that demo run?".
- The engine never reads the log file — it is purely observational.

---

## 3. Design

### 3.1 Activation

```jsonc
"logFormat": true   // default: false
```

`false` is the default so all existing demo fixtures and tests continue to work unchanged.

### 3.2 Log file location and format

For a data file `<dir>/<basename>.json` the log file is `<dir>/<basename>.log.json`.

The log file is a JSON array of **log entries**, each with the shape:

```jsonc
{ "op": "insert" | "update" | "delete", "id": "...", "data"?: {...}, "associations"?: [...], "updated": <wm> }
```

`data` is omitted on delete entries. `associations` is omitted when not present.
Entries are appended in the order mutations occur; the file is never rewritten.

Example after two sync cycles:

```json
[
  { "op": "insert", "id": "acc1", "data": { "accountName": "Acme" },      "updated": 1 },
  { "op": "update", "id": "acc1", "data": { "accountName": "Acme Corp" }, "updated": 2 },
  { "op": "delete", "id": "acc2",                                         "updated": 3 }
]
```

### 3.3 Main data file behaviour

Unchanged from the default mutable mode:
- `insert` appends a new entry.
- `update` finds and mutates the existing entry in-place.
- `delete` splices the entry out.
- `read` and `lookup` are unaffected.

### 3.4 Insert in log mode

After writing the main file, append a log entry:
```jsonc
{ "op": "insert", "id": "<id>", "data": <record.data>, "updated": <wm> }
```

### 3.5 Update in log mode

After writing the main file, append a log entry with the **merged** data:
```jsonc
{ "op": "update", "id": "<id>", "data": <mergedData>, "updated": <wm> }
```

### 3.6 Delete in log mode

Compute `nextWatermark` before splicing (for the timestamp). After writing the main file,
append a log entry:
```jsonc
{ "op": "delete", "id": "<id>", "updated": <wm> }
```

### 3.7 Backward compatibility

- Default `logFormat: false` — no log file is created; nothing else changes.
- The log file is never read by the connector.
- Switching `logFormat` on mid-demo simply starts accumulating from that point; the
  existing main data file is not affected.

---

## 4. Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logFormat` | `boolean` | `false` | Write a companion `<basename>.log.json` on every mutation |

`deletedField` was removed — no tombstones needed with this approach.

---

## 5. Implementation tasks

1. **`LogEntry` interface** — `{ op, id, data?, associations?, updated }`.
2. **`logFilePath(entityFilePath)`** — helper that derives `<basename>.log.json` from the entity file path.
3. **`appendLogEntry(logPath, entry)`** — helper that reads the existing log array (or `[]`), appends, and writes.
4. **`LogConfig`** — `{ logFormat: boolean }` only; remove `deletedField`.
5. **`insert`** — unchanged main-file write; add `appendLogEntry` call when `logFormat`.
6. **`update`** — revert to simple mutable in-place update; add `appendLogEntry` call when `logFormat`.
7. **`delete`** — revert to splice; compute `nextWatermark` before splice for the log timestamp; add `appendLogEntry` call when `logFormat`.
8. **`read` / `lookup`** — remove all `logFormat` branching; restore to simple mutable form.
9. Remove `latestByIdLog` helper entirely.
10. **`configSchema`** — remove `deletedField` entry; update `logFormat` description.

---

## 6. Test plan

Replace existing `describe("log format")` block with tests covering:

| # | Scenario | Assertion |
|---|----------|-----------|
| 1 | Without logFormat, no `.log.json` file is written | File absent after insert |
| 2 | Insert writes log entry with `op: "insert"` | Log has 1 entry with correct id/data |
| 3 | Insert does not make main file append-only | Main file has 2 entries after 2 inserts |
| 4 | Update writes log entry with `op: "update"` and merged data | Log entry has merged data |
| 5 | Update still mutates main file in-place | Main file has 1 entry after insert+update |
| 6 | Delete writes log entry with `op: "delete"` | Log has entry, no data field |
| 7 | Delete still removes record from main file | Read emits 0 records |
| 8 | Log file accumulates all operations in order | `map(e => e.op) === ["insert","update","delete"]` |

---

## 7. Demo wiring

`"logFormat": true` is already set on all three connectors in the associations-demo
`opensync.json`. After each run, `crm/contacts.log.json`, `erp/employees.log.json`, etc.
accumulate the full mutation history. Run `bun run wipe && bun run demo` for a fresh start.

No other demo changes are required.
