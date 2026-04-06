# OpenSync Playground — Specification

The playground is an interactive browser-based UI for exploring and debugging OpenSync sync
behaviour without a backend server. It runs entirely in-memory (sql.js + in-memory connectors)
and is intended for demos, developer on-boarding, and manual testing of scenarios.

---

## § 1 Purpose

The playground provides a real-time, visual representation of how the sync engine processes
records across multiple systems. It is not a production tool; it is an exploratory sandbox.
All data is ephemeral: refreshing the page or switching scenarios destroys all state.

---

## § 2 Layout

The playground uses a three-pane layout:

```
┌────────────────┬──┬────────────────────────────────────────┐
│  Config editor │||│            Systems view                │
│                │  ├────────────────────────────────────────┤
│  (YAML)        │  │           Dev tools panel              │
└────────────────┘  └────────────────────────────────────────┘
```

### § 2.1 Config editor pane

Left pane. Displays the current scenario's channel and mapping configuration as editable YAML.
Width is user-resizable via a drag handle (`#resize-handle`) between the two panes (180–600 px,
default ~240 px).

### § 2.2 Systems view

Right pane, upper area. Displays channels as tabs. Each tab shows a cluster view (§ 4).
Occupies all remaining horizontal space.

### § 2.3 Dev tools panel

Right pane, lower area. Shows internal engine state for debugging. Height is user-resizable via
a drag handle (`#devtools-resize-handle`) between the systems view and the dev tools
(60–500 px, default 160 px).

---

## § 3 Scenario system

### § 3.1 Scenario definition

Each scenario is a self-contained object with:
- `label` — display name shown in the dropdown
- `channels` — array of `ChannelConfig` (same shape as the engine config)
- `conflict` — conflict resolution strategy (`"source-wins"` | `"target-wins"` | …)
- `seed` — optional override of the default record seed per systemId / entity

### § 3.2 Default seed

The playground uses a fixed set of three systems (`crm`, `erp`, `hr`) with a shared seed
defined in `lib/systems.ts`. Individual scenarios may override specific entity slices.
The seed is deep-copied on boot so resets return to the original state.

### § 3.3 Scenario switching and reset

Selecting a new scenario or pressing "Reset" stops the current engine, drops the in-memory
database, and boots a fresh engine from the scenario seed. If the user has made unsaved
record edits (`isDirty = true`), a confirmation dialog is shown first.

### § 3.4 Config hot-reload

The user may edit the YAML in the config editor pane and click "Apply". This validates the
YAML, parses it into a `ScenarioDefinition`, confirms if dirty, and calls `boot()`. The YAML
format mirrors the real `opensync.json` / `mappings/` file format:

```yaml
channels:
  - id: contacts
    members:
      - connectorId: crm
        entity: contacts
      - connectorId: erp
        entity: persons
mappings:
  - channel: contacts
    rules:
      - from: name
        to: fullName
```

---

## § 4 Cluster view

### § 4.1 Overview

A cluster view is the main content area for one channel tab. It shows identity clusters:
groups of records from different connectors that the engine has determined represent the
same real-world entity.

### § 4.2 Column headers

One column per channel member (fixed width 260 px). Each header shows:
- System name (`connectorId`)
- Entity badge (entity name)
- Count badge — the number of active (non-soft-deleted) records for that connector/entity
- `+ New` button — opens the new-record modal (§ 6.2) for that connector/entity combination.
  The button is inline in the header, to the right of the count badge.

### § 4.3 Cluster groups

Each identity cluster is rendered as a bordered group box with:
- A canonical ID label floating on the top border (first 8 characters of the UUID), or
  `• unlinked` for records not yet ingested by the engine.
- A `cluster-cards-row` grid with one cell per channel member.

### § 4.4 Multi-record cells

A cell in `cluster-cards-row` maps to one channel member. Linked clusters always contain
exactly one record per cell (at most). Unlinked clusters group all pending records from the
same connector into a single cluster, so a cell may contain multiple stacked record cards.
Cards within a cell are stacked vertically with a 4 px gap.

### § 4.5 Syncing placeholder

If a slot has an external ID recorded in the identity map but no matching record in the
connector store (transient race condition during a poll), a `cluster-cell-pending` placeholder
showing `<id>… syncing` is displayed instead of a card.

### § 4.6 Empty state

If a channel has no clusters yet, the body shows `— no records —`.

### § 4.7 New record button

The `+ New` button for each connector/entity is placed in the column header (§ 4.2), not
below the clusters.  There is no `cluster-new-row`.

### § 4.8 Unmapped tab

A pseudo-tab labelled `unmapped` is always appended at the end of the tab bar. It shows all
connector entities that are not covered by any channel, in a horizontal column layout matching
the cluster view style. Column headers include count badges (§ 4.2).

---

## § 5 Record cards

### § 5.1 Card anatomy

Each record card displays:
- **ID badge** — the record's external ID in monospace, small font
- **Fields table** — key/value pairs from `record.data`, two-column table layout
- **Association badges** — one badge per association (§ 5.3)
- **Footer** — `modifiedAt` timestamp + action buttons (Edit / Delete / Restore)

### § 5.2 Card states

| State | Visual |
|---|---|
| Normal | Dark border, standard opacity |
| Flash | Green glow animation (1.4 s) — plays when a record is first seen or updated |
| Highlight | Purple border + glow — used by association navigation to locate target |
| Soft-deleted | Dashed border, 45% opacity, strikethrough on field values |

### § 5.3 Association badges

Each association renders as a pill badge. The badge appearance indicates the state of the
association target within the same connector's store:

| State | Class | Appearance |
|---|---|---|
| Target exists and is active | `.assoc-badge-link` | Blue pill; click navigates to target |
| Target is soft-deleted | `.assoc-deleted-target` | Amber pill with ⊘ prefix; click navigates to target |
| Target not found | `.assoc-missing` | Red pill with ⚠ prefix; not clickable |

Target lookup uses the same connector's in-memory store (same `systemId`, `targetEntity`,
`targetId`). Cross-connector associations are not resolved in the playground.

---

## § 6 Modals

### § 6.1 Edit modal

Opens when the user clicks "Edit" on a card. Shows:
- Header: `Edit  <systemId> / <entity> / <id>`
- JSON editor (CodeMirror, one-dark theme) pre-filled with `{ data: ..., associations: [...] }`
- Footer: Cancel / Save (also Ctrl+Enter / Mod+Enter)

On save, the parsed `data` and `associations` are passed to `callbacks.onSave(systemId, entity,
id, data, associations)`. A manual poll is triggered immediately after.

### § 6.2 New record modal

Opens when the user clicks `+ New`. In addition to the JSON editor it shows an **optional ID
input field** above the editor:

```
ID  (optional — leave blank for auto-generated UUID)
[ _____________________________________________ ]
```

If the field is non-empty, its value is used as the record's `id`; otherwise a UUID is
generated. The JSON editor is pre-filled with `{ "data": {}, "associations": [] }`.

On save, `callbacks.onSave(systemId, entity, null, data, associations, explicitId)` is called.
If `explicitId` is `undefined`, `insertRecord` generates a UUID via `crypto.randomUUID()`.

### § 6.3 Dirty tracking

Any successful save, soft-delete, or restore sets `isDirty = true`. This flag gates scenario
switches and resets behind a confirmation prompt.

---

## § 7 Dev tools panel

Three tabs:

| Tab | Contents |
|---|---|
| Log | Tick-grouped event viewer (see § 7.1) |
| identity_map | Table snapshot of `identity_map` rows from the sql.js DB |
| shadow_state | Table snapshot of `shadow_state` rows from the sql.js DB |

The DB tables are refreshed after each poll pass.

### § 7.1 Log tab — tick viewer

The Log tab uses a network-log style layout with two panels side-by-side:

```
┌─────────────────────┬──────────────────────────────────────────┐
│  ticks-left (140px) │  tick-detail                             │
│ ┌─────────────────┐ │                                          │
│ │  ticks-toolbar  │ │  Expandable event rows for selected      │
│ │  [Clear]        │ │  tick (READ, INSERT, UPDATE, DEFER…)     │
│ └─────────────────┘ │                                          │
│  ticks-list         │  Click event row to expand detail        │
│  (scrollable)       │                                          │
└─────────────────────┴──────────────────────────────────────────┘
```

**Tick list (left):** One row per sync tick. Each row shows `phase`, `READ`/`INSERT`/
`UPDATE` counts. Noop ticks (zero non-skip events) are pruned immediately. Clicking a
tick row selects it and populates the right-hand detail panel. A `followLatest` lock
auto-selects new ticks when the list is scrolled to the bottom; user interaction disables
auto-selection.

**Tick phases:**
- `onboard` — emitted during boot (initial reads + fanout inserts from onboarding). Displayed
  dimmed and italic in the tick list with a `[boot]` prefix.
- `poll` — emitted during a regular interval or manual sync pass.

**Detail panel (right):** Each event row is click-expandable (`te-item`). The expanded
panel (`te-detail`) shows data based on action type:

| Action | Expanded content |
|---|---|
| READ (no prior shadow) | All fields, value column only (green) — initial boot read |
| READ (with prior shadow) | Diff — only changed fields: old value → new value |
| INSERT | Full JSON payload (`<pre>`) |
| UPDATE | Diff table — only changed fields: old value → new value |
| DEFER / ERROR | No data panel |

**Clear button:** Inside the `ticks-toolbar` area of the Log tab, not in the tab bar.

## § 8 Engine integration

### § 8.1 In-memory connectors

Each system runs as an `InMemoryConnector` — an in-process implementation of the
`Connector` interface that stores records in a `Map`. It supports:
- `insertRecord(entity, data, associations?, explicitId?)` — insert with optional explicit ID
- `updateRecord(entity, id, data, associations?)` — merge patch
- `softDeleteRecord(entity, id)` — hide from engine without hard-deleting
- `restoreRecord(entity, id)` — un-hide and bump watermark
- `getActivityLog()` / `clearActivityLog()` — access the write activity log

**Activity log:** Every engine-driven `insert` or `update` call through `makeEntity`
appends an `ActivityLogEntry` to the connector's internal `activityLog` array:

```typescript
interface ActivityLogEntry {
  op: "insert" | "update";
  entity: string;
  id: string;          // external ID in this connector
  at: string;          // ISO timestamp
  after: Record<string, unknown>;
  before?: Record<string, unknown>;  // only for updates
}
```

The `emitEvents` helper uses the activity log to attach `before`/`after` payloads to `INSERT`
and `UPDATE` `SyncEvent`s so the dev tools panel can display diffs.

The log is never cleared automatically; it accumulates across polls. Searches scan from the
most recent entry backwards, so the correct entry is found even after many polls.

### § 8.2 Boot sequence

After `startEngine()` is called:

1. All channels that report `"uninitialized"` are onboarded (`collectOnly → discover → onboard`).
2. A single boot tick is opened (`onTickStart("onboard")`).
3. **READ events** are emitted for every record in every connector's current snapshot —
   one `SyncEvent { action: "READ", data: rec.data }` per record, with no `before` field
   (the records are new; all fields are displayed in full green in the dev tools diff view).
4. **INSERT events** from `transaction_log` (fanout writes from `onboard()`) are emitted with
   `phase: "onboard"`, each carrying `after: record.data` from the target connector snapshot.
5. A warmup ingest pass runs all channel members once with `{ fullSync: true }`.  Its main
   purpose is to propagate association sentinels that `onboard()` step 1b omits.  In most
   scenarios the warmup produces only skip results (noop suppression eliminates redundant
   writes) so it contributes no events to the boot tick.
6. The UI is refreshed once to show the fully-resolved initial state.
7. The automatic poll interval starts (if auto mode is enabled).

### § 8.3 Poll loop

When auto mode is active, a `setInterval` fires every 2 000 ms.  Each tick:

1. Calls `onTickStart("poll")` to open a new tick group in the dev tools.
2. For each channel member:
   a. Snapshots the connector's current shadow state from `shadow_state` table (used to
      compute READ event diffs — see § 7.1).
   b. Calls `engine.ingest(channelId, connectorId)`.
   c. Calls `emitEvents(result.records, …, sourceShadows)` which emits `READ`, `INSERT`,
      `UPDATE`, or `DEFER` events as appropriate.
3. Calls `onRefresh()` to re-render the UI.

Manual record mutations call `pollOnce()` immediately after the mutation without waiting
for the next tick.

`engineState.pollOnce()` is the single entry point for both interval-driven and manual
poll passes.

### § 8.4 Manual sync

When auto mode is disabled (`engineState.pause()`), the poll interval is paused. The
"Sync" button in the topbar calls `triggerPoll()` directly when clicked.

### § 8.5 sql.js database

The engine uses `sql.js` (WebAssembly SQLite) loaded via a CDN-hosted WASM binary. The
database is fully in-memory; there is no persistence between page loads or scenario resets.

### § 8.6 SyncEvent structure

`SyncEvent` is the data model passed from `emitEvents` to the dev tools via `onEvent`:

```typescript
interface SyncEvent {
  ts: string;               // HH:MM:SS
  channel: string;
  sourceConnector: string;
  sourceEntity: string;
  targetConnector: string;
  targetEntity: string;
  action: string;           // "READ" | "INSERT" | "UPDATE" | "DEFER" | "ERROR"
  sourceId: string;         // first 8 chars of external ID
  targetId: string;
  phase?: "onboard" | "poll";
  data?: Record<string, unknown>;   // READ: full source record
  before?: Record<string, unknown>; // READ: shadow state before this ingest
                                    // UPDATE: state before the write
  after?: Record<string, unknown>;  // INSERT/UPDATE: state after the write
}
```

`before` for READ events is populated by `captureSourceShadow()`, which queries the
`shadow_state` table *before* `engine.ingest()` runs.  Comparing `before` vs `data` gives
the field-level diff displayed in the dev tools expanded row.

---

## § 9 Resizing

Two drag handles allow the user to resize panels:

| Handle | Direction | Target | Clamp |
|---|---|---|---|
| `#resize-handle` | Horizontal | `#editor-pane` width | 180–600 px |
| `#devtools-resize-handle` | Vertical | `#devtools-container` height | 60–500 px |

Dragging adds a `.dragging` class to the handle for a visual highlight. Resize state is not
persisted across page loads.

---

## § 10 Auto mode and manual sync

The topbar contains:
- An **"auto" checkbox** (`#toggle-realtime`). When checked (default), the automatic
  2-second poll interval runs. When unchecked, `engineState.pause()` is called and the
  interval is suspended.
- A **"Sync" button** (`#btn-sync`). Enabled only when auto mode is off. Clicking it calls
  `pollOnce()` once, running a full ingest pass across all channel members and refreshing
  the UI.

When auto mode is **on**, every record mutation (edit, create, delete) calls `pollOnce()`
immediately, which is why syncs appear instantaneous — the poll is not waiting for the
2-second timer.

Switching scenarios or resetting respects the current toggle state: if auto mode is off when
the new engine boots, it is immediately paused after `startEngine()` returns.
