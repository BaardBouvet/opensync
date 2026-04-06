# Plan: Mapping Lineage Visualization in the Playground

**Status:** complete  
**Date:** 2026-04-06  
**Domain:** demo / playground UI  
**Scope:** `playground/` only — no engine changes  
**Spec:** `specs/playground.md`  
**Depends on:** none  

---

## Problem

The config editor pane shows the mapping configuration as YAML. YAML is connector-centric
("for this connector, these fields map to these canonical names"). What it cannot show at a
glance is the *flow*: how data travels from connector fields into the canonical model and back
out to other connectors, and which connector fields are aliases for the same canonical concept.

---

## Goal

An interactive **field-lineage diagram** rendered as a `Diagram` tab alongside the existing
YAML editor. The diagram has two levels of detail:

1. **Channel view (overview):** every channel rendered as a flow graph — connector entities
   on the left and right, canonical fields in the centre spine, with SVG lines tracing
   connections. This is the default state.

2. **Field view (drilldown):** clicking a canonical field pill (always visible in the centre
   column) dims everything except the upstream and downstream connector fields that feed into
   or out of that canonical field. Clicking a connector entity header expands it so individual
   field nodes are visible and selectable.

The diagram updates live whenever the user clicks "Apply" in the YAML tab.

---

## Layout and Interaction Model

### Overall structure

The diagram is per-channel. Each channel renders as a three-column flow graph:

```
  LEFT                  CENTRE               RIGHT
  (connector nodes)     (canonical spine)    (connector nodes)
```

All channel members appear on **both** the left and the right — because OpenSync sync is
bidirectional, every connector is simultaneously a source (left) and a sink (right). The left
column represents *inbound* field flow (connector → canonical); the right column represents
*outbound* field flow (canonical → connector).

SVG `<line>` elements cross the gaps between columns to connect each connector field node to
its canonical field node. Lines are drawn on a transparent SVG overlay sized to the diagram
area; node positions are read via `getBoundingClientRect()` after layout.

### Channel view (overview — default)

In the default state the diagram shows **three columns of pills**:

- **Left column** — one collapsed entity header pill per channel member (inbound side).
- **Centre column** — one canonical field pill per unique canonical field in the channel.
  These are visible and clickable in the overview; they are not revealed only on drilldown.
- **Right column** — one collapsed entity header pill per channel member (outbound side).

SVG lines connect each entity header pill to every canonical field pill it participates in,
giving a high-level picture of "which entities flow into which canonical fields".

Using the default `associations-demo` scenario, the `companies` channel looks like:

```
LEFT (inbound)              CANONICAL              RIGHT (outbound)
──────────────────────────────────────────────────────────────────────
[crm / companies] ────────── [ name   ] ────────── [crm / companies]
[erp / accounts]  ────────── [ domain ] ────────── [erp / accounts]
[hr / orgs]       ──────────────────────────────── [hr / orgs]

                          ○ identity: domain
```

All lines are shown at low opacity. Both the entity header pills and the canonical field pills
are interactive from the outset — the canonical pills are not just labels.

### Drilldown: expanding an entity

Clicking an entity header pill expands it to show individual field nodes (one pill per
connector field in the inbound mapping). The SVG lines re-route to connect individual field
pills to their canonical field node. The rename is visible because the left pill label
differs from the canonical node label it connects to:

```
LEFT                         CANONICAL
──────────────────────────────────────
[crm / companies]
  ○ name        ────────────── name
  ○ domain      ────────────── domain

[erp / accounts]
  ○ accountName ────────────── name     ← rename visible: accountName → name
  ○ website     ────────────── domain   ← rename visible: website → domain

[hr / orgs]
  ○ orgName     ────────────── name
  ○ site        ────────────── domain
```

Multiple entities can be expanded at once. The right column mirrors the left but shows the
outbound direction.

### Drilldown: selecting a canonical field

Clicking a canonical field node (e.g. `name`) enters **field focus** mode:

- All SVG lines connecting to *other* canonical fields dim to ~15% opacity.
- Lines connecting to the selected field highlight (full opacity, accent colour).
- On the left, only the field nodes that feed `name` are shown at full opacity; unrelated
  field nodes within the same entity dim but remain visible for context.
- On the right, same treatment for the outbound side.
- A small inline annotation below the canonical field node lists all connector-side aliases:
  `name · accountName · orgName`.
- Direction indicators (`→`, `←`, `↔`) appear on the highlighted lines only, keeping the
  unfocused state clean.

Clicking the same field again (or pressing Escape) deselects and returns to overview.

Combined with entity expansion, selecting `name` after expanding `erp / accounts` shows the
exact path `accountName → name` highlighted end-to-end.

### Pass-through members

If a channel member has no `fields` list (pass-through), the entity header pill on the left
connects to a single synthetic `(all fields)` node in the canonical spine, with dashed lines
to distinguish it from explicit mappings.

### Identity fields

A horizontal annotation strip below the canonical spine lists the identity fields as
highlighted chips: `○ domain` — these are the fields used for record matching.

---

## Data Sources

The diagram is derived entirely from the `ScenarioDefinition` object — the same value that
`editor-pane.ts` already holds after a boot or config apply. No engine query, no sql.js read,
and no import from `@opensync/engine` is needed.

| Diagram element | Source |
|---|---|
| Channel IDs | `scenario.channels[].id` |
| Connector + entity per member | `member.connectorId`, `member.entity` |
| Field renames | `member.inbound[].{ source, target }` |
| Flow direction | `member.inbound[].direction` (default: bidirectional) |
| Identity fields | `channel.identityFields` |

`buildChannelLineage()` (Step 2) is therefore a pure function: `ChannelConfig → ChannelLineage`.
It has no side effects and requires no async call.

**Consistency guarantee:** the `Diagram` tab always reflects the *applied* config — whatever
was last passed to `boot()`. If the user has typed unsaved edits in the YAML editor, the
diagram does not update until they click "Apply". This keeps the diagram and the running
engine in sync with each other at all times.

What the engine holds that the diagram deliberately does **not** use:

- Actual record data → shown in the cluster view.
- Identity map rows (which records matched to which canonical UUID) → shown in the dev-tools
  panel.
- Shadow state / LWW resolution timestamps → out of scope; belongs in a future resolution
  trace feature.

---

## Where it Lives in the UI

The left (config editor) pane gains a **two-tab header**: `YAML` and `Diagram`.

- `YAML` tab — existing CodeMirror editor, unchanged.
- `Diagram` tab — the lineage diagram. Read-only; no edit controls.

Switching tabs does not alter the scenario or trigger a reload. The `Diagram` tab always
reflects the most recently *applied* config.

The tab strip sits at the top of the left pane, above the existing "Apply" button row. The
"Apply" button is hidden when the `Diagram` tab is active.

If the left pane is narrower than a minimum threshold (~300 px), the `Diagram` tab is
unchanged in position but a horizontal scroll is provided inside the diagram container rather
than collapsing the layout.

---

## Implementation Plan

### Step 1 — Tab chrome in `editor-pane.ts`

Add a `<div class="editor-tab-strip">` with two `<button>` elements (`yaml` / `diagram`)
above the CodeMirror container. Toggle a `data-active-tab` attribute on the pane root.
CSS hides/shows the CodeMirror editor and the diagram container accordingly.

The "Apply" button row is `display: none` when `data-active-tab="diagram"`.

### Step 2 — Data model `ui/lineage-model.ts`

New file. Pure data transformation — no DOM. Exports:

```ts
export interface CanonicalNode {
  fieldName: string;        // e.g. "name"
  isIdentity: boolean;
}

export interface ConnectorFieldNode {
  connectorId: string;      // e.g. "erp"
  entity: string;           // e.g. "accounts"
  sourceField: string;      // connector-side name, e.g. "accountName"
  canonicalField: string;   // canonical-side name, e.g. "name"
  direction: "bidirectional" | "forward_only" | "reverse_only";
}

export interface ChannelLineage {
  channelId: string;
  canonicalFields: CanonicalNode[];
  connectorFields: ConnectorFieldNode[];  // all members × all fields
}

export function buildChannelLineage(channel: ChannelConfig): ChannelLineage;
```

`buildChannelLineage` derives `canonicalFields` from the union of all `target` values across
all members, and derives `connectorFields` from each member's `inbound`/`outbound` lists.
Pass-through members (no `inbound`) emit a single synthetic `ConnectorFieldNode` with
`sourceField: "*"`.

### Step 3 — Diagram renderer `ui/lineage-diagram.ts`

New file. Exports:

```ts
export function renderLineageDiagram(
  container: HTMLElement,
  scenario: ScenarioDefinition,
): void;
```

**DOM structure per channel:**

```
<section class="ld-channel">
  <h3 class="ld-channel-title">companies</h3>
  <div class="ld-graph">
    <div class="ld-col ld-col-left">  <!-- entity header pills, expandable -->
    <div class="ld-col ld-col-centre"> <!-- canonical field chips -->
    <div class="ld-col ld-col-right">  <!-- entity header pills (outbound) -->
    <svg class="ld-lines">             <!-- connection lines, absolutely positioned overlay -->
  </div>
  <div class="ld-identity">identity: domain</div>
</section>
```

**SVG line drawing:**

After the DOM is laid out, `drawLines()` iterates all active connections, reads
`getBoundingClientRect()` for both endpoint elements, and writes `<line>` elements into the
SVG layer. A `ResizeObserver` on the diagram container triggers a `redrawLines()` call
whenever the pane is resized (e.g. user drags the pane resize handle).

**State machine (per channel):**

```
idle
  → hover canonical chip  — highlight connected lines
  → click entity header   — expand entity (toggle), redraw lines
  → click canonical chip  — enter "field focused" state

field-focused(fieldName)
  → click same chip / Escape  — back to idle
  → click different chip      — switch focus
```

State is local to the diagram component (plain object, no external store needed).

**Focus implementation:**

Each SVG line element carries `data-canonical-field` and `data-connector-id` attributes.
On focus:

```ts
for (const line of svgLines) {
  line.classList.toggle("ld-line-dimmed", line.dataset.canonicalField !== focusedField);
  line.classList.toggle("ld-line-focused", line.dataset.canonicalField === focusedField);
}
```

No re-render; only CSS class toggling. This keeps interaction latency to zero.

Direction indicators (`→`, `←`, `↔`) are `<text>` elements on the SVG layer, shown only on
`ld-line-focused` lines via CSS `visibility`.

### Step 4 — Wiring in `editor-pane.ts`

Call `renderLineageDiagram(diagramEl, scenario)` on:
- Initial pane construction.
- After each successful "Apply" (config hot-reload): destroy the previous diagram and
  re-render from scratch.

### Step 5 — Spec update

Add `§ 2.4` (editor-pane tab modes) and `§ 9` (Field Lineage Diagram) to
`specs/playground.md`, covering layout, interaction model, and SVG line strategy.

### Step 6 — CSS

New classes under `.ld-*` namespace in the playground stylesheet:

| Class | Purpose |
|---|---|
| `.ld-channel` | Channel section block |
| `.ld-graph` | Three-column flex container, `position: relative` for SVG overlay |
| `.ld-col` | Flex column for node lists |
| `.ld-entity-header` | Collapsible entity pill |
| `.ld-entity-header.expanded` | Expanded state |
| `.ld-field-node` | Individual field pill |
| `.ld-canonical-chip` | Canonical field chip, clickable |
| `.ld-canonical-chip.focused` | Selected state |
| `.ld-lines` | Full-size SVG overlay (`position: absolute; inset: 0; pointer-events: none`) |
| `.ld-line` | Default line style — low opacity, thin |
| `.ld-line-focused` | Highlighted line — full opacity, accent colour |
| `.ld-line-dimmed` | Dimmed line — ~15% opacity |

---

## Spec Changes Planned

| Spec file | What changes |
|---|---|
| `specs/playground.md` | New `§ 2.4` — editor pane tab modes (YAML vs Diagram). New `§ 9` — Field Lineage Diagram: three-column layout, channel view, entity expansion, canonical field focus, SVG line strategy, direction indicators, pass-through treatment. |

No other spec files need updating.

---

## Out of Scope (v1)

- Editing field mappings by dragging lines (that is a full graphical editor; separate plan).
- Displaying expression bodies in the diagram; these remain YAML-only.
- Association lineage (what entity an association foreign key resolves to); add later.
- Printing or exporting the diagram.

---

## Possible v2 Additions

### Connector field pill focus

After entity expansion, individual connector field pills could themselves be selectable,
entering a more specific focus than clicking the canonical pill:

- Click **canonical pill** → highlight all connectors that participate in that canonical field.
- Click **connector field pill** → highlight only the single path from that field to its
  canonical node (e.g. `accountName → name`), dimming even other lines that connect to the
  same canonical field.

This creates a clear two-level focus hierarchy and is most useful for `forward_only` /
`reverse_only` fields where the full canonical-pill view would reveal more connections than
the user is asking about. It is not worth the added interaction surface in v1, where all
fields are bidirectional.

Implementation delta from v1: add a `data-connector-id` + `data-source-field` attribute to
each field pill; extend the state machine with a `field-focused` state distinct from
`canonical-focused`; add a CSS class `.ld-line-single` for single-path highlight.

---

## Acceptance Criteria

- [ ] `Diagram` tab shows a channel block for every channel in the active scenario.
- [ ] Each channel block has a left column (inbound), centre canonical spine, and right
      column (outbound), connected by SVG lines.
- [ ] In overview mode, connector entities are shown as collapsed header pills connected by
      lines to every canonical field they participate in.
- [ ] Clicking an entity header expands it to show individual field pills; lines route to the
      individual pills.
- [ ] Clicking a canonical field chip enters field-focus mode: unrelated lines dim, related
      lines highlight with direction indicators.
- [ ] Clicking the focused chip again (or pressing Escape) returns to overview.
- [ ] Pass-through members display a dashed line to a synthetic `(all fields)` canonical node.
- [ ] Identity fields are listed as chips below the canonical spine.
- [ ] Lines are redrawn correctly after the pane is resized.
- [ ] After clicking "Apply", the diagram re-renders to reflect the new config.
- [ ] Switching back to `YAML` tab preserves CodeMirror cursor and scroll position.
- [ ] No external graphing library (`d3`, `mermaid`, etc.) is added.
- [ ] TypeScript strict — no `any`, no `// @ts-ignore`.
- [ ] `specs/playground.md` is updated before or alongside the feature implementation.
