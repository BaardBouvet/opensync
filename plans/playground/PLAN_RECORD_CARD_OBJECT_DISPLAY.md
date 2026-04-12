# Plan: Record Card — Object & Array Display, Compact Associations

**Status:** proposed  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** Playground  
**Scope:** `playground/src/ui/systems-pane.ts`, `specs/playground.md`  
**Spec:** `specs/playground.md § 5.1`, `specs/playground.md § 5.3`  
**Depends on:** none  

---

## § 1 Problem

Three display gaps in the record card fields table (§ 5.1) make it hard to read real data:

### § 1.1 Nested objects shown as `[object Object]`

When a field value is a plain object (e.g. an `address` field with `street`, `city`,
`country` sub-keys), `String(value)` produces the useless string `[object Object]`.
The user gets no signal that there is structured data present, let alone what it contains.

### § 1.2 Arrays shown as non-interactive `[N items]` chip

Array fields render a static count chip with a raw JSON tooltip truncated at 120 chars.
For short arrays of primitives (e.g. tag lists) the count tells the user nothing useful.
For arrays of objects the tooltip is unreadable JSON noise. There is no way to see the
items without opening the Edit modal.

### § 1.3 Association section wastes vertical space

Association badges occupy a dedicated `assoc-badges` block below the fields table —
separate from the data with no visual anchor. On records with many fields the section
appears far from any of the related data. The full `● predicate: targetId` format is
verbose; a more compact inline treatment would fit the same information in less height.

---

## § 2 Goals

1. **Object fields** — show a collapsed `{…}` chip by default; clicking the chip or its
   row in-line expands a nested key/value sub-table inside the same card. Re-clicking
   collapses it. Nested objects are expanded one level deep; deeper nesting uses the same
   treatment recursively.

2. **Array fields** — the count chip becomes a toggle. Default state: `[N items]`.
   Clicking expands an inline list:
   - **Scalar items** (string/number/bool): one line per item, prefixed with a small index
     bullet.
   - **Object items**: each item rendered as a compact nested key/value sub-table (same
     style as goal 1), separated by a horizontal rule.
   Re-clicking the chip collapses the list.

3. **Compact inline associations** — remove the separate `assoc-badges` block. Render each
   association as a row in the fields table immediately after the last data field, using the
   predicate as the key column and a clickable target-ID chip as the value column. The chip
   inherits the same three visual states (`assoc-badge-link`, `assoc-deleted-target`,
   `assoc-missing`) and click-to-navigate behaviour from the current badge implementation.
   Parent record and no-link badges remain in their current separate sections because they
   are not association data.

Out of scope:
- Edit-modal behaviour (still submits raw `record.data`; edit modal is not changed).
- Lineage diagram — the field preview in the lineage panel is a separate component and is
  not affected.
- Array sub-object synthetic cards — these are a different mechanism and are unaffected.

---

## § 3 Spec Changes Planned

| File | Section | Change |
|------|---------|--------|
| `specs/playground.md` | § 5.1 | Document object-field chip + expand toggle; document array-field expand toggle for scalar and object items. |
| `specs/playground.md` | § 5.3 | Replace "separate `assoc-badges` block" description with inline fields-table rows. Update CSS class references. |

No other spec files require changes.

---

## § 4 Implementation Notes

### § 4.1 Shared `renderValue` helper

Extract a `renderValue(value: unknown, depth: number): HTMLElement` helper used by both
the fields table loop and the recursive nested rendering. Returns:

- A plain text node for primitives.
- An `<span class="obj-expand-chip">` (collapsed) + hidden `<div class="obj-expand-body">`
  sub-table for plain objects. Click on the chip or the row's `<td>` toggles
  `obj-expanded` on the outer `<tr>` and `hidden` on the body.
- An `<span class="array-count-chip">` toggle + hidden `<div class="array-expand-body">`
  list for arrays. Same click toggle pattern.

`depth` is passed through to avoid rendering beyond a reasonable cap (e.g. 3 levels).
At the cap, render a JSON string truncated to 80 chars instead.

### § 4.2 Association rows

In the fields table loop, after the last `rec.data` entry, iterate `rec.associations`
and append a `<tr class="assoc-row">` per entry. The `<td class="field-key">` holds
the predicate string. The `<td class="field-val">` holds a `<span>` styled with the
same `assoc-badge-*` class and the same three-state logic currently used in the badge
builder block.

Remove the standalone `assoc-badges` div builder for association badges (keep the
`parentRef` and no-link sections unchanged).

### § 4.3 CSS additions

New classes required (add to `playground/src/ui/systems-pane.css` or inline style block):

| Class | Purpose |
|---|---|
| `.obj-expand-chip` | Inline chip for collapsed object, e.g. `{…}` |
| `.obj-expand-body` | Sub-table shown when object is expanded |
| `.array-expand-body` | List shown when array is expanded |
| `.assoc-row` | `<tr>` for an inline association field row |
| `.assoc-row .field-key` | Italic or muted style to distinguish from data fields |

---

## § 5 Acceptance Criteria

- [ ] A field whose value is `{ street: "Main St", city: "Oslo" }` renders as `{…}` chip
      by default; clicking shows a sub-table with `street / Main St` and `city / Oslo`.
- [ ] A field whose value is `["red","blue"]` renders as `[2 items]`; clicking shows two
      bulleted lines `0 · red` and `1 · blue`.
- [ ] A field whose value is an array of objects renders each object as an expandable
      sub-table inside the expanded list.
- [ ] Associations appear as rows in the field table (predicate key + clickable target-ID
      value chip); the standalone `assoc-badges` block for association badges is gone.
- [ ] Parent record badge and no-link badge continue to render as separate sections below
      the table, unchanged.
- [ ] TypeScript strict mode — no `any`, no `// @ts-ignore`.
- [ ] `bun run tsc --noEmit` passes. `bun test --timeout 10000` passes.
