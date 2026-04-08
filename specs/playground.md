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

### § 2.4 Lineage pseudo-tab

A **lineage** button appears at the right end of the channel tab bar in the right pane (after
the `unmapped` pseudo-tab, separated from the channel tabs by a thin vertical divider). Both
`unmapped` and `lineage` are rendered in italic to visually distinguish them as diagnostic
views rather than channel selectors.

Clicking `lineage` replaces the channel cluster view with the field lineage diagram (§ 11).
The tab is highlighted in blue when active.

Switching to `lineage` does not alter state and does not trigger a reload. The diagram state
(expanded entities, focused canonical field) persists as long as the `lineage` tab remains
mounted. Selecting a channel tab or `unmapped` returns to the corresponding cluster view.
Poll-tick refreshes do not rebuild the diagram while the `lineage` tab is active.

---

## § 3 Scenario system

### § 3.1 Scenario definition

Each scenario is a `ScenarioDefinition` with two fields:
- `label` — display name shown in the dropdown
- `yaml` — raw canonical YAML string (the source of truth; `channels:` + `mappings:` + optional `conflict:` sections)

The `yaml` field is passed directly to the engine's config parser at boot time using
`MappingsFileSchema` + `buildChannelsFromEntries`. There is no serialisation path from parsed
runtime objects back to YAML — config flows one way only (YAML → engine).

### § 3.2 Default seed

The playground uses a fixed set of three systems (`crm`, `erp`, `hr`) with a shared seed
defined in `lib/systems.ts`. Individual scenarios may override specific entity slices.
The seed is deep-copied on boot so resets return to the original state.

### § 3.3 Scenario switching and reset

Selecting a new scenario or pressing "Reset" stops the current engine, drops the in-memory
database, and boots a fresh engine from the scenario seed. If the user has made unsaved
record edits (`isDirty = true`), a confirmation dialog is shown first.

### § 3.4 Config hot-reload

The left-side config editor pane shows the scenario's raw `yaml` string directly — no
serialisation step. On "Save + Reload" the editor:
1. Reads the current editor text
2. Validates it with `MappingsFileSchema.parse(parseYaml(raw))` — throws on invalid YAML or
   unknown keys
3. Calls `buildChannelsFromEntries` to validate channel/mapping consistency
4. If validation passes, constructs a new `ScenarioDefinition` `{ label, yaml: raw }` and
   calls `onConfigReload(next)`, which stops the engine and boots fresh from the new YAML

The YAML format is the same `channels:` + `mappings:` + `conflict:` format used by the
engine's real config files (see `specs/config.md`):

```yaml
channels:
  - id: contacts
    identityFields: [email]

mappings:
  - connector: crm
    entity: contacts
    channel: contacts
    fields:
      - source: email_address
        target: email

conflict:
  strategy: lww
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
  The button is hidden for array-source members (those with `arrayPath` set): sub-object
  records cannot be created directly; they must be edited through the parent record.

Column display order is sorted alphabetically by `connectorId` for visual consistency.
The engine's internal ingest ordering (which may differ, e.g. webshop before erp for
array-expansion channels) is unaffected.

The `cluster-header-row` element is set with `column-gap: 6px` (matching the cards-row gap)
and left/right padding that aligns its columns with the card columns below it:
- Channel cluster view: `padding: 0 11px` (matching `cluster-body` 6 px + `cluster-group`
  side padding 5 px)
- Unmapped view: `padding: 0 6px` (matching `cluster-body` 6 px only — no `cluster-group`
  nesting in the unmapped layout)

Each `cluster-col-head` carries a `border-left` accent colour (cycling through 4 muted tones
per `nth-child` position). The matching `cluster-cell` at the same nth-child position carries
the same colour at 30 % opacity, visually linking each header cell to its card column.

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
- **Fields table** — key/value pairs from `record.data`, two-column table layout.
  Array-valued fields are rendered as a static `[N items]` chip with a tooltip showing
  up to 120 characters of the serialised value; they are not expanded inline.
- **Association badges** — one badge per association (§ 5.3)
- **Parent record badge** — shown only on array sub-object cards (§ 5.4)
- **Footer** — `modifiedAt` timestamp + action buttons (§ 5.5)

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

### § 5.4 Parent record badge

Array sub-object cards (connector members with `arrayPath` set) display a teal pill badge
of the form `↑ <parentEntity>: <parentId>` between the association badges and the footer.
The badge links back to the parent record (e.g. the `purchases` record whose `lines[]`
contains this sub-object). Clicking navigates to the parent record in the same connector
column and highlights it with the standard highlight animation (§ 5.2).

If the parent record is not found in the connector's store (transient state), the badge
renders with the missing-target style (red, ⚠ prefix, non-clickable).

### § 5.5 Footer and action buttons

Cards that are **not** array sub-objects show Edit and Delete buttons (or Restore for
soft-deleted records). Array sub-objects are read-only; their footer shows a small italic
annotation `⊂ <parentEntity>.<arrayPath>` in place of the action buttons, with a tooltip
explaining that the parent record must be edited to change the sub-object.

### § 5.6 Flash tracking

The flash animation (§ 5.2) is driven by comparing `rec.watermark` against
`lastWatermarks` — a module-level map updated after each render.  For records backed by
real connector entities, watermarks are written by `updateWatermarks()` from `snapshotFull()`.
For synthesized array sub-object records (which never appear in `snapshotFull()`), the
watermark is stored directly into `lastWatermarks` after each card render in the cluster loop,
preventing unwanted flash on every poll tick.

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

Five tabs:

| Tab | Contents |
|---|---|
| Log | Tick-grouped event viewer (see § 7.1) |
| identity_map | Table snapshot of `identity_map` rows from the sql.js DB |
| shadow_state | Split view — metadata table on the left, field detail panel on the right (see § 7.2) |
| watermarks | Table snapshot of `watermarks` rows from the sql.js DB (see § 7.3) |
| channels | Table snapshot of `channel_onboarding_status` rows from the sql.js DB (see § 7.4) |

All DB tabs are refreshed after each poll pass. Re-rendering a DB tab preserves the current
scroll position and, where applicable, the selected row (§ 7.2).

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

### § 7.2 shadow_state tab — split view

The `shadow_state` tab uses a two-panel split layout:

```
┌──────────────────────────────────┬───────────────────┐
│  shadow-left                     │  shadow-right     │
│                                  │                   │
│  Metadata table                  │  Field detail for │
│  (connector_id, entity_name,     │  selected row     │
│   external_id, canonical_id,     │                   │
│   deleted_at)                    │  key → value rows │
│                                  │  from             │
│  Click a row to select           │  canonical_data   │
└──────────────────────────────────┴───────────────────┘
```

**Left panel (`shadow-left`):** Renders the metadata columns of `shadow_state`. The
`canonical_data` column (JSON blob) is intentionally omitted from the table — it is shown
in the right panel instead.

**Right panel (`shadow-right`):** Initially shows `← click a row to inspect fields`. When
a metadata row is clicked, the right panel shows the parsed `canonical_data` fields as
monospace `key → value` rows (values in blue). The panel title shows
`connectorId / entityName / externalId…` (8-char prefix).

The split between `shadow-left` and `shadow-right` is user-resizable via a 5px drag
handle (`#shadow-resizer`) between the two panels (160–600 px right panel width,
default 320 px).

**Selection persistence:** The selected row is tracked by its composite key
(`connector_id / entity_name / external_id`), not by DOM reference. Re-renders (triggered
by poll ticks while the tab is active) re-apply the highlight class and refresh the right
panel with the latest `canonical_data` from the database — without clearing the selection.

### § 7.3 watermarks tab

Shows the `watermarks` table: `connector_id`, `entity_name`, `since`. The `since` value is
the opaque cursor passed as the `after` parameter to each connector's incremental read on
the next poll. Watching this value advance after each manual sync tick or realtime tick
makes the incremental-read boundary directly observable.

### § 7.4 channels tab

Shows the `channel_onboarding_status` table: `channel_id`, `entity`, `marked_ready_at`.
A channel that has completed onboarding has a row here. This is useful for confirming
whether a channel has been fully onboarded during the boot sequence, and is relevant when
using the manual sync button (which only runs poll ticks, not onboarding).

## § 8 Engine integration

### § 8.1 In-memory connectors

Each system runs as an `InMemoryConnector` — an in-process implementation of the
`Connector` interface that stores records in a `Map`. It supports:
- `insertRecord(entity, data, associations?, explicitId?)` — insert with optional explicit ID
- `updateRecord(entity, id, data, associations?)` — merge patch
- `softDeleteRecord(entity, id)` — hide from engine without hard-deleting
- `restoreRecord(entity, id)` — un-hide and bump watermark

The connector is a dumb pipe: it does not track engine-driven writes.  All `before`/`after`
payloads for `INSERT` and `UPDATE` events come directly from `RecordSyncResult` (see
`specs/sync-engine.md § RecordSyncResult`).

### § 8.2 Boot sequence

After `startEngine()` is called:

1. All channels that report `"uninitialized"` are onboarded (`collectOnly → discover → onboard`).
   The `OnboardResult` (including `inserts`) is stored per channel.
2. A single boot tick is opened (`onTickStart("onboard")`).
3. **READ events** are emitted for every record in every connector's current snapshot —
   one `SyncEvent { action: "READ", data: rec.data }` per record, with no `before` field
   (initial read; all fields are displayed in full green in the dev tools diff view).
4. **INSERT events** from `onboardResult.inserts` are emitted with `phase: "onboard"`,
   each carrying `after` from the `RecordSyncResult` (canonical data written during fanout).
5. The UI is refreshed once to show the fully-resolved initial state.
6. The automatic poll interval starts (if auto mode is enabled).

### § 8.3 Poll loop

Two complementary timers drive engine ticks in auto mode:

| Timer | Constant | Purpose |
|-------|----------|---------|
| Background interval | `POLL_MS = 5 000 ms` | Safety net — catches changes missed by the notification timer |
| Notification timer | `NOTIFY_MS = 800 ms` | "Webhook" — fires one poll shortly after a mutation |

When auto mode is active, `setInterval` fires every `POLL_MS`.  Each interval tick:

1. Calls `onTickStart("poll")` to open a new tick group in the dev tools.
2. For each channel member:
   a. Calls `engine.ingest(channelId, connectorId)`.
   b. Calls `emitEvents(result.records, ch, connectorId, onEvent, "poll")` which iterates
      `RecordSyncResult` entries — emitting `READ`, `INSERT`, `UPDATE`, `DEFER`, or `ERROR`
      events using `r.sourceData`, `r.sourceShadow`, `r.before`, and `r.after` directly.
3. Calls `onRefresh()` to re-render the UI.

When a record mutation occurs in auto mode, `schedulePoll()` is called instead of
`pollOnce()` directly. `schedulePoll()` debounces rapid edits: it sets (or resets) a
`NOTIFY_MS` timer so that only one poll fires after the dust settles, regardless of how
many mutations occur within that window.

The two timers are independent. A notification poll firing close to an interval tick
produces at most one redundant noop pass, which is harmless.

`engineState.pollOnce()` is the single entry point for both interval-driven and
notification poll passes.

**Boot debounce.** After `startEngine()` returns and the engine is fully onboarded,
`schedulePoll()` is called once so the user sees a short 800 ms countdown bar before the
first background poll fires. This makes the initial sync visually distinct from the static
page load.

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
  data?: Record<string, unknown>;   // READ: full source record (from RecordSyncResult.sourceData)
  before?: Record<string, unknown>; // READ: shadow before ingest (RecordSyncResult.sourceShadow)
                                    // UPDATE: state before the write (RecordSyncResult.before)
  after?: Record<string, unknown>;  // INSERT/UPDATE: state after the write (RecordSyncResult.after)
}
```

All payload fields come directly from `RecordSyncResult`: `r.sourceData`, `r.sourceShadow`,
`r.before`, `r.after`.  No shadow-state query is needed before or after `engine.ingest()`.
Comparing `before` vs `data` (for READ events) gives the field-level diff displayed in the
dev tools expanded row.

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
  poll interval and notification timer run. When unchecked, `engineState.pause()` is
  called, both timers are cancelled, and the countdown bar is hidden.
- A **"Sync" button** (`#btn-sync`). Enabled only when auto mode is off. Clicking it calls
  `pollOnce()` once, running a full ingest pass across all channel members and refreshing
  the UI.

### § 10.1 Two-phase flash effect

When auto mode is **on**, record mutations produce two visible events:

1. **Mutation flash** — the edited card flashes green immediately (UI refresh only;
   no engine involvement).
2. **Propagation flash** — `NOTIFY_MS` (800 ms) later the notification timer fires,
   the engine ingests the change, and synced copies flash green across the other systems.

This two-phase effect makes the async nature of sync visible.  Rapid edits within the
`NOTIFY_MS` window are debounced — only one poll fires, after the *last* mutation.

### § 10.2 Countdown bar

A `<div id="poll-countdown">` with an inner `<div id="poll-countdown-fill">` renders
as a small inline pill (40 px × 4 px) sitting directly to the right of the "auto"
checkbox in the topbar.  The fill depletes from 100% to 0% via a CSS `width` transition,
giving a live read of "time until next engine tick."

| Situation | Duration shown |
|-----------|---------------|
| Notification timer pending (mutation just made, or auto just enabled) | `NOTIFY_MS` (800 ms) |
| No notification pending; background interval is next | `POLL_MS` (5 000 ms) |
| Boot: first render after `startEngine()` return | `NOTIFY_MS` (800 ms) |

The bar is hidden (`display: none`) when auto mode is off or the engine is not running.

Transition implementation uses a CSS `width` linear transition — no
`requestAnimationFrame` loop.  A forced reflow (`getBoundingClientRect()`) between
setting `width: 100%` (no transition) and `width: 0%` (with transition) ensures the
browser registers the start point before animating.

### § 10.3 Scenario switch / reset behaviour

Switching scenarios or resetting respects the current toggle state: if auto mode is off
when the new engine boots, it is immediately paused after `startEngine()` returns and the
countdown bar remains hidden.

### § 10.4 Tab activity indicators

When a non-active channel tab receives new or updated records (detected by comparing
connector watermarks against the values stored from the previous render pass), a small
pulsing green dot (`.tab-activity-dot`) appears on that tab. The dot is computed at the
start of each `refresh()` call, before watermarks are updated, so it reflects changes
made since the last visible render.

Switching to a channel tab clears its activity dot immediately. The active channel never
shows a dot. Array-source members check the parent entity for watermark changes (since the
sub-object records are synthesized and never stored in the connector's entity map).

---

## § 11 Field Lineage Diagram

### § 11.1 Purpose

The **lineage** pseudo-tab in the channel tab bar (§ 2.4) renders the active `ScenarioDefinition`
as an interactive field-lineage graph. It shows which connector fields flow into the canonical
model and back out to other connectors, making field renames and channel topology visible
without reading YAML.

The diagram occupies the full width of the right pane, which gives enough horizontal space
for a three-connector scenario to render clearly.

### § 11.2 Data source

The diagram is derived entirely from the in-memory `ScenarioDefinition`. It does not query
the sql.js database or the engine. `buildChannelLineage()` is a pure function:
`ChannelConfig → ChannelLineage`. No engine import is required.

### § 11.3 Three-column layout

Each channel renders as a three-column flow graph inside a `<div class="ld-graph">`:

```
LEFT column          CENTRE column       RIGHT column
(ld-col-left)        (ld-col-centre)     (ld-col-right)
─────────────        ──────────────      ─────────────
entity pills  ──── canonical pills ────  entity pills
              SVG line overlay (absolute)
```

A transparent `<svg class="ld-lines">` overlay (`position: absolute; inset: 0;
pointer-events: none`) is drawn on top of the columns. SVG `<line>` elements connect
left-column elements to canonical pills (inbound direction) and canonical pills to
right-column elements (outbound direction). Coordinates are computed via
`getBoundingClientRect()` relative to the `.ld-graph` container.

### § 11.4 Overview state (default)

- **Left column:** one collapsed entity header pill per channel member.
- **Centre column:** one canonical field pill per unique canonical field in the channel.
- **Right column:** one collapsed entity header pill per channel member (outbound side).

In the overview, each entity header pill is connected by SVG lines to every canonical field
pill it participates in. Lines are shown at low opacity (`.ld-line` default style).

### § 11.5 Entity expansion

Clicking an entity header pill expands it to show individual connector field pills
(`.ld-field-node`), one per `inbound` mapping entry. SVG lines are redrawn from each
field pill to its canonical field pill. Renames become visible because the field pill label
(connector-side name) may differ from the canonical pill label.

Multiple entities may be expanded at once, on either or both sides. Clicking the header
again collapses it.

### § 11.6 Canonical field focus

Clicking a canonical field pill enters **field focus** mode for that field:

- All SVG lines whose `data-canonical-field` does not match the focused field receive class
  `ld-line-dimmed` (~15% opacity).
- Lines matching the focused field receive class `ld-line-focused` (full opacity, accent
  colour).
- Entity header and field pills that do not participate in the focused field receive class
  `ld-dimmed`.
- An alias annotation appears below the canonical pill listing all connector-side field
  names for that canonical field (e.g. `name · accountName · orgName`).
- Direction indicators (`→`, `←`, `↔`) appear as SVG `<text>` elements on focused lines.

Clicking the same canonical pill again, or pressing Escape, returns to the overview state.

Focus is implemented via CSS class toggling only — no DOM re-render is triggered. This
keeps interaction latency at zero.

### § 11.7 Pass-through members

A channel member with no `inbound` list is a pass-through connector. Its entity pill
connects to a synthetic canonical pill labelled `(all fields)` with dashed lines
(`.ld-line-passthrough`).

### § 11.8 Identity fields

A `<div class="ld-identity">` strip below the canonical spine lists identity fields as
highlighted chips (e.g. `○ domain`).

### § 11.9 Resize handling

A `ResizeObserver` on the diagram host section redraws all SVG lines whenever the container
is resized (e.g. user drags `#resize-handle`).

### § 11.10 Re-render on config apply

When the user saves and reloads config, `renderLineageDiagram()` is called fresh the next
time the user opens the `lineage` tab.

---

### § 11.11 Array-expansion channels — lifecycle skip

Channels that contain at least one member with `arrayPath` skip the
collect → discover → onboard lifecycle step. Instead, after all non-array channels are
onboarded, a warmup ingest pass runs for each member of every array channel (webshop first,
per member declaration order, to ensure `array_parent_map` rows are written before the flat
ERP member ingests). This pass is synchronous at boot so the initial render already has
cluster data. `buildSeedClusters` returns `[]` for these channels.

```ts
const isArrayChannel = (ch: ChannelConfig): boolean =>
  ch.members.some((m) => m.arrayPath !== undefined);
```

`FIXED_SYSTEMS` may include systems (e.g. `webshop`) that are not participants of every
channel — unused connectors simply return empty records on `read()`.

The ERP `orderLines` entity seed starts empty; it is fully populated by the engine from
webshop expansion during the warmup pass. The `orderLines` entity key must still be present
in the seed (as an empty array) so the in-memory connector registers its entity definition.

### § 11.12 Array-source entity labels in lineage diagram

When a `ChannelMember` has `arrayPath`, `buildChannelLineage` uses
`${member.sourceEntity ?? member.entity}.${member.arrayPath}[]` as the entity display label
(e.g. `purchases.lines[]`). The logical entity name (`member.entity`) remains the key for
shadow state and watermarks.

---

### § 11.13 Expression lineage and resolver badge

**`sources` fan-in.** When a `FieldMapping` has `expression` and a non-empty `sources` list,
`buildChannelLineage` emits one `ConnectorFieldNode` per source with `hasExpression: true`.
The diagram renders each source as a separate field pill connected to the canonical node.

**Expression placeholder.** When `expression` is present but `sources` is absent or empty,
a single `ConnectorFieldNode` with `sourceField: "(expression)"` and
`isExpressionPlaceholder: true` is emitted. The pill is rendered in italic with an amber
border to indicate that the exact source fields are not declared.

**Parent-field marker.** Fields injected from the parent record via `parentFields` carry
`isParentField: true`. They are rendered with a `↑` suffix on the pill and a dashed SVG
connector line.

**Resolver badge.** When at least one inbound `FieldMapping` for a canonical field carries a
`resolve` function, the canonical chip shows a small `ƒ` badge (class `ld-resolver-badge`).

