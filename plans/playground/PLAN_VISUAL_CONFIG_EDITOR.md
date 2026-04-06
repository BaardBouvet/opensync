# Plan: Visual Config Editor in the Playground

**Status:** draft  
**Date:** 2026-04-06  
**Effort:** L  
**Domain:** Playground UX  
**Scope:** `playground/` only — no engine changes  
**Spec:** `specs/playground.md § 2.1`  
**Depends on:** none  

---

## § 1 Problem Statement

The config editor pane (left side of the playground) is a raw CodeMirror YAML editor.
This works for developers who know the OpenSync config format, but is a barrier for:

- First-time users who don't know `channels` / `mappings` / `identityFields` syntax
- Demos where the audience needs to understand *what* is being configured, not *how*
- Teaching the sync model: the YAML abstraction hides the concept of channels, members, and
  field rename rules behind indentation

A visual editor would let users manipulate the config through UI controls instead of, or
alongside, typing YAML.

---

## § 2 Config Shape (reference)

The in-memory config the editor works with is a flat `ScenarioDefinition`:

```
ScenarioDefinition
  channels[]:
    id: string
    identityFields?: string[]
    members[]:
      connectorId: string
      entity: string
      inbound:  [{source: string, target: string}]   # connector field → canonical
      outbound: [{source: string, target: string}]   # canonical → connector field (mirrors inbound)
  conflict: ConflictConfig
```

The visual editor must produce and consume this exact shape. It never touches raw YAML
directly — it operates on the parsed `ScenarioDefinition` and serialises to YAML only on
"Apply" (same path as today).

---

## § 3 Approach Options

### § 3.1 Option A — Structured form editor (new tab in editor pane)

Add a **"Form"** tab to the editor pane header alongside (or replacing) the current "YAML"
label. The form renders the `ScenarioDefinition` as a tree of expandable panels:

```
[YAML] [Form]                     ← tab bar in editor pane header
─────────────────────────────────
▼ contacts channel                ← collapsible section per channel
    identity fields: [email] +
    Members:
      crm / contacts
        name      → fullName
        email     → email
        [+ field]
      erp / persons
        [+ field]
      [+ member]
    [remove channel]
▼ invoices channel …
[+ channel]
```

Controls:
- Channel name — text input (inline edit)
- Identity fields — tag input (comma-separated pills with × per pill)
- Member connector / entity — text inputs or dropdowns if the playground has a known
  connector registry
- Field rows — two text inputs (source / target) + delete button per row
- Add/remove channel, member, field — `+` / `×` buttons
- Conflict strategy — select dropdown at the top

All mutations update an in-memory `ScenarioDefinition` immediately. An **Apply** button at
the bottom (or in the pane header) calls `onConfigReload` with the new scenario — same path
as the YAML "Save + Reload" button. Optionally, a **Back to YAML** button serialises the
current form state to YAML and switches the tab.

**Pros:**
- No new dependencies — plain DOM manipulation, already used throughout the playground
- Predictable, testable, accessible
- Can be shipped incrementally: start with read-only display, then add editable fields
- Lives entirely inside the existing editor pane container — no layout changes

**Cons:**
- Forms are not spatial; the user doesn't see the data *flow* between systems
- A channel with many members and many field rows becomes a long scrollable list
- Connector/entity names are free text (no autocomplete unless we wire up the connector
  schema, which is a separate plan)

**Effort:** M (one focused sprint)

---

### § 3.2 Option B — Inline-editable lineage diagram

The existing field-lineage diagram (§11 of the spec, `ui/lineage-diagram.ts`) already
renders the config as an SVG flow graph: connector entity nodes on each side, canonical
field pills in the centre, SVG lines tracing connections. Making it editable means:

- **Add a field mapping** — an `+` button on each entity node opens a small floating form
  (input pair: source field / canonical field name) that, on confirm, inserts a new line and
  updates the in-memory config
- **Remove a field mapping** — hovering a connection line shows a `×` hit target; clicking
  removes the mapping rule and redraws
- **Rename a canonical field** — clicking a canonical field pill makes it an `<input>` in
  place; blur commits the rename across all members that reference it
- **Add a channel member** — `+` button in each channel's left/right entity column header
  opens a small form (connectorId + entity)
- **Add a channel** — footer `+ channel` button below the last channel block in the diagram
- **Remove a channel** — `×` button on the channel heading

The diagram already rerenders from the model after "Apply"; edits would update the model and
trigger a redraw, keeping diagram ↔ model bidirectional.

**Pros:**
- The *editing surface is the visualisation* — users see the effect immediately as nodes and
  lines without a separate mental translation from form fields to graph
- Reuses ~70 % of the existing diagram render code
- The lineage tab already exists; no new tab or layout surface is added

**Cons:**
- SVG hit-testing and inline editing are fiddly to implement correctly
- The SVG `<line>` elements for connections are hard to make clickable with a reasonable
  hit area — need invisible wider `<path>` overlays
- The current diagram is per-channel (one channel per tab); adding a new channel requires
  an out-of-channel surface (e.g. a dedicated "add channel" affordance beside the tab bar)
- The diagram collapses small configs nicely but grows unwieldy with > 5 connector fields
  per entity — the canvas may scroll horizontally in ways that break editing

**Effort:** L (SVG interaction is slow to build and test; the existing diagram code is not
architected around mutations)

---

### § 3.3 Option C — Node-graph canvas (drag-to-map)

A dedicated **"Canvas"** mode — optionally a third tab in the editor pane, or a full-screen
overlay — with draggable nodes and interactive edge drawing:

- Each connector entity is a floating card node with its field list
- Dragging from a source-field port on one node to a target-field port on the canonical
  spine (or another node) creates a mapping edge
- Channels are represented as coloured grouping rings or swim lanes behind the nodes

Library options:
- **Hand-rolled SVG + pointer events** — no deps, full control, very long build time;
  the lineage diagram gives a starting point but interactive panning/dragging is not there
- **React Flow** — polished graph editor with built-in nodes/edges/minimap; requires
  introducing React and Vite React plugin (currently zero React in the project)
- **Svelte-Flow / X6 / Cytoscape** — alternatives with varying bundle sizes and API styles;
  all require a new framework or significant library dep
- **`d3-force` + manual drag events** — compromise: d3's force layout + SVG, no
  framework, but d3 is a large dep and force layout fights the static column layout the
  lineage diagram already uses well

**Pros:**
- Maximum visual impact — the most "WOW" option for demos
- Topology is immediately legible: which connectors are in which channels, which fields flow
  where
- Nearest end-state to how commercial iPaaS tools (Zapier, n8n, Boomi) look

**Cons:**
- Highest complexity and effort by a large margin
- Adds a significant external dep (React / graph lib) or months of hand-rolled work
- Graph editing UX has many edge cases (overlapping nodes, orphan edges, undo/redo)
- Risk of scope creep dominating the playground roadmap for weeks

**Effort:** XL (R&D spike + implementation; not recommended as a first step)

---

### § 3.4 Option D — YAML with schema validation and inline autocompletion

Not a "visual" editor in the graphical sense, but makes the existing YAML editor behave
like a smart form:

- Add a JSON Schema for the playground's YAML format (`channels[]`, `mappings[]`) and wire
  it into CodeMirror via the `@codemirror/lint` + `yaml-language-server-protocol` approach
- The editor shows red underlines on invalid keys, autocomplete suggestions for known
  connector IDs and entity names, inline hover docs for each YAML key
- Invalid YAML blocks the "Save + Reload" button and shows a descriptive error

**Pros:**
- Zero layout change — stays inside CodeMirror
- Pairs very well with Option A or B as a complementary enhancement

**Cons:**
- Not truly visual — it's a smarter text editor, not a GUI
- `yaml-language-server` is heavy; a lighter custom lint pass may be needed
- Autocomplete for connector IDs / entity names requires runtime introspection of the
  playground's fixed system registry

**Effort:** S–M (good candidate for a follow-on after Option A)

---

## § 4 Comparison Summary

| Option | Visual? | New deps? | Effort | Ships first? |
|--------|---------|-----------|--------|-------------|
| A — Form editor | form UI | none | M | ✓ recommended |
| B — Editable lineage | diagram | none | L | second step |
| C — Node-graph canvas | graph | React / graph lib | XL | not yet |
| D — YAML + schema | enhanced text | minor (lint) | S–M | complementary |

---

## § 5 Recommended Path

**Phase 1 — Form editor (Option A):** ship a fully functional form-based visual editor as
a second tab in the editor pane. Low risk, no new deps, follows existing DOM patterns.

**Phase 2 — Schema hints (Option D):** add YAML schema validation and autocompletion to the
CodeMirror editor for users who prefer raw YAML.  Builds on the JSON Schema description
already implied by `ChannelConfig`.

**Phase 3 — Editable lineage (Option B):** once the form editor proves the in-memory model
round-trip, evolve the lineage diagram (§11) to support point-and-click mutations.
Option A's model manipulation helpers can be reused verbatim.

Phase 3 and Options C / D can be addressed independently via separate plans.

---

## § 6 Implementation Sketch (Option A — Form editor)

### § 6.1 New file: `playground/src/ui/form-editor.ts`

```ts
export interface FormEditorOptions {
  container: HTMLElement;
  scenario: ScenarioDefinition;
  onApply: (next: ScenarioDefinition) => Promise<void>;
}

export function buildFormEditor(opts: FormEditorOptions): {
  update: (scenario: ScenarioDefinition) => void;
}
```

Renders the form by building the DOM imperatively (same style as `lineage-diagram.ts`,
`systems-pane.ts`, etc. — no framework). Maintains a mutable clone of the scenario via a
`draft` variable; each control's change handler mutates `draft` and calls `renderDraft()`
which patches only the changed subtree.

No reactive framework — just a local `draft: ScenarioDefinition` and a full re-render of the
affected panel on each mutation.  The form is small enough that full panel re-render is
imperceptible.

### § 6.2 Tab bar in the editor pane

Add two buttons to the `editor-section-header` in `editor-pane.ts`:

```
[YAML]  [Form]
```

Clicking a tab hides one mount `<div>` and shows the other.  The `EditorView` (CodeMirror)
lives in the YAML div; the `buildFormEditor` DOM lives in the Form div.

When switching **YAML → Form**: call `formEditor.update(parseCurrentYaml())` to sync form
state to any edits the user made in YAML.

When switching **Form → YAML**: call `view.dispatch({ changes: { from: 0, to: ..., insert: scenarioToConfigYaml(draft) } })` to sync YAML to form state.

A single shared "Apply" button triggers `onConfigReload` regardless of which tab is active.

### § 6.3 Channel section component

Each channel renders as a `<details>` element (native collapsible) with a `<summary>` that
shows the channel ID and a `×` remove button.

Inside: identity-fields tag input, and a members sub-list.

### § 6.4 Member row component

Each member renders as a collapsible sub-`<details>` labelled `connectorId / entity`.
Contains a two-column table of field rows (source input / target input / delete button).
An `+ add field` button appends a blank row.

### § 6.5 Validation

On "Apply", validate:
- No two channels share the same `id`
- No member has an empty `connectorId` or `entity`
- No field row has an empty `source` or `target`

Show an inline error banner (not an alert) in the form pane header. The error clears on the
next "Apply" attempt.

---

## § 7 Spec Changes Planned

The following changes to `specs/playground.md` are required before implementing:

- **§ 2.1** — extend description to cover the YAML/Form tab bar; note that both tabs share
  a single "Apply" button and operate on the same in-memory `ScenarioDefinition`.
- **New § 12 — Visual config editor** — describe the form editor layout (channel sections,
  member rows, field rows, validation rules), the YAML↔Form sync protocol, and the "Apply"
  call path.

No changes required to `specs/config.md` (the YAML format is unchanged) or to any engine
spec (the engine never sees the visual editor).
