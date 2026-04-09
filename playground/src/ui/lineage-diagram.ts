// Spec: specs/playground.md § 11
// Field-lineage diagram — three-column interactive SVG+DOM renderer.
// No external graphing library; no engine imports.
import type { ChannelConfig } from "@opensync/engine";
import {
  buildChannelLineage,
  memberKey,
  type ChannelLineage,
  type ConnectorFieldNode,
} from "./lineage-model.js";

// ─── Field preview ───────────────────────────────────────────────────────────

/** Displayable metadata for one field on a connector entity.
 *  Derived from FieldDescriptor in getEntityDefs(); used by the pool and unmapped
 *  sections in the lineage diagram. Spec: specs/playground.md § 11.15 */
export interface FieldPreview {
  name: string;
  isFK: boolean;
  description?: string;
  /** Human-readable type string: "string", "number", "array", "→ accounts", … */
  type?: string;
  example?: unknown;
}

/** Build a hover tooltip string from FieldPreview metadata. */
function buildFieldTitle(fp: FieldPreview): string {
  const parts: string[] = [];
  if (fp.description) parts.push(fp.description);
  if (fp.type)        parts.push(fp.type);
  if (fp.example != null) parts.push(`e.g. ${fp.example}`);
  return parts.join(" · ");
}


// ─── Per-channel state ────────────────────────────────────────────────────────

interface ChannelState {
  expandedLeft: Set<string>;      // memberKey of explicitly user-expanded left entities
  expandedRight: Set<string>;     // memberKey of explicitly user-expanded right entities
  autoExpandedLeft: Set<string>;  // expanded by canonical focus; collapsed on deselect
  autoExpandedRight: Set<string>;
  focusedCanonical: string | null;
  focusedField: { side: "left" | "right"; memberKey: string; sourceField: string } | null;
}

// ─── Entity expand / collapse (DOM + state) ─────────────────────────────────

// Spec: specs/playground.md § 11.5 — explicit user expand/collapse.
// Clears auto-expand tracking and field filter when explicitly expanding.
function setEntityExpanded(
  colEl: HTMLElement,
  mk: string,
  expandedSet: Set<string>,
  expanded: boolean,
  autoExpandedSet?: Set<string>,
): void {
  if (expanded) {
    expandedSet.add(mk);
    autoExpandedSet?.delete(mk);
  } else {
    expandedSet.delete(mk);
    autoExpandedSet?.delete(mk);
  }
  const header = Array.from(
    colEl.querySelectorAll<HTMLElement>(".ld-entity-header"),
  ).find((h) => h.dataset.memberKey === mk) ?? null;
  if (!header) return;
  header.classList.toggle("expanded", expanded);
  const chevron = header.querySelector<HTMLElement>(".ld-chevron");
  if (chevron) chevron.textContent = expanded ? "▾" : "▸";
  const fieldsList = header
    .closest<HTMLElement>(".ld-entity-group")
    ?.querySelector<HTMLElement>(".ld-fields-list") ?? null;
  if (fieldsList) {
    fieldsList.classList.toggle("ld-hidden", !expanded);
    // Explicit expand always shows all fields — remove any focus-driven filter.
    if (expanded) {
      fieldsList.querySelectorAll<HTMLElement>(".ld-field-node")
        .forEach((p) => p.classList.remove("ld-field-filtered"));
    }
  }
}

// Auto-expand entity for canonical focus: shows only the field pill(s) that
// map to `canonicalField`; all other pills are hidden with ld-field-filtered.
// If the entity was already explicitly expanded, leave it untouched (all fields visible).
function autoExpandEntity(
  colEl: HTMLElement,
  mk: string,
  autoExpandedSet: Set<string>,
  expandedSet: Set<string>,
  canonicalField: string,
): void {
  const alreadyExplicit = expandedSet.has(mk);
  if (!alreadyExplicit) autoExpandedSet.add(mk);
  const header = Array.from(
    colEl.querySelectorAll<HTMLElement>(".ld-entity-header"),
  ).find((h) => h.dataset.memberKey === mk) ?? null;
  if (!header) return;
  header.classList.add("expanded");
  const chevron = header.querySelector<HTMLElement>(".ld-chevron");
  if (chevron) chevron.textContent = "▾";
  const fieldsList = header
    .closest<HTMLElement>(".ld-entity-group")
    ?.querySelector<HTMLElement>(".ld-fields-list") ?? null;
  if (!fieldsList) return;
  fieldsList.classList.remove("ld-hidden");
  if (!alreadyExplicit) {
    fieldsList.querySelectorAll<HTMLElement>(".ld-field-node").forEach((pill) => {
      pill.classList.toggle("ld-field-filtered", pill.dataset.canonicalField !== canonicalField);
    });
  }
}

// Collapse all auto-expanded entities that the user did not explicitly open.
function collapseEntityDOM(colEl: HTMLElement, mk: string): void {
  const header = Array.from(
    colEl.querySelectorAll<HTMLElement>(".ld-entity-header"),
  ).find((h) => h.dataset.memberKey === mk) ?? null;
  if (!header) return;
  header.classList.remove("expanded");
  const chevron = header.querySelector<HTMLElement>(".ld-chevron");
  if (chevron) chevron.textContent = "▸";
  const fieldsList = header
    .closest<HTMLElement>(".ld-entity-group")
    ?.querySelector<HTMLElement>(".ld-fields-list") ?? null;
  if (fieldsList) {
    fieldsList.classList.add("ld-hidden");
    fieldsList.querySelectorAll<HTMLElement>(".ld-field-node")
      .forEach((p) => p.classList.remove("ld-field-filtered"));
  }
}

function collapseAutoExpanded(
  leftCol: HTMLElement,
  rightCol: HTMLElement,
  state: ChannelState,
): void {
  for (const mk of [...state.autoExpandedLeft]) {
    if (!state.expandedLeft.has(mk)) collapseEntityDOM(leftCol, mk);
  }
  state.autoExpandedLeft.clear();
  for (const mk of [...state.autoExpandedRight]) {
    if (!state.expandedRight.has(mk)) collapseEntityDOM(rightCol, mk);
  }
  state.autoExpandedRight.clear();
}

// Spec: specs/playground.md § 11.6 — auto-expand entities for canonical focus.
// skipSide: field-pill click passes its own side so same-side peers are left collapsed.
function expandMembersForCanonical(
  canonicalField: string,
  lineage: ChannelLineage,
  state: ChannelState,
  leftCol: HTMLElement,
  rightCol: HTMLElement,
  skipSide?: "left" | "right",
): void {
  if (skipSide !== "left") {
    const leftMks = new Set(
      lineage.inboundFields
        .filter((f) => f.canonicalField === canonicalField && f.sourceField !== "*")
        .map((f) => memberKey(f.connectorId, f.entity)),
    );
    for (const mk of leftMks) {
      autoExpandEntity(leftCol, mk, state.autoExpandedLeft, state.expandedLeft, canonicalField);
    }
  }
  if (skipSide !== "right") {
    const rightMks = new Set(
      lineage.outboundFields
        .filter((f) => f.canonicalField === canonicalField && f.sourceField !== "*")
        .map((f) => memberKey(f.connectorId, f.entity)),
    );
    for (const mk of rightMks) {
      autoExpandEntity(rightCol, mk, state.autoExpandedRight, state.expandedRight, canonicalField);
    }
  }
}

// ─── SVG helpers ──────────────────────────────────────────────────────────────

function createSVGPath(
  x1: number, y1: number, x2: number, y2: number,
  canonicalField: string,
  connectorKey: string,
  passthrough: boolean,
  side: "left" | "right",
  dashed = false,
): SVGPathElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const curve = Math.abs(x2 - x1) * 0.5;
  const d = `M ${Math.round(x1)},${Math.round(y1)} C ${Math.round(x1 + curve)},${Math.round(y1)} ${Math.round(x2 - curve)},${Math.round(y2)} ${Math.round(x2)},${Math.round(y2)}`;
  el.setAttribute("d", d);
  el.setAttribute("data-canonical-field", canonicalField);
  el.setAttribute("data-connector-key", connectorKey);
  el.dataset.side = side;
  el.classList.add("ld-line");
  if (passthrough) el.classList.add("ld-line-passthrough");
  if (dashed)      el.classList.add("ld-line-dashed");
  return el;
}

// Get bounding rect of `el` relative to `container`.
function relRect(el: Element, container: Element): DOMRect {
  const a = el.getBoundingClientRect();
  const b = container.getBoundingClientRect();
  return new DOMRect(a.left - b.left, a.top - b.top, a.width, a.height);
}

// ─── Line drawing ──────────────────────────────────────────────────────────

function drawLines(
  graphEl: HTMLElement,
  svgEl: SVGSVGElement,
  lineage: ChannelLineage,
  state: ChannelState,
): void {
  svgEl.innerHTML = "";

  const leftCol = graphEl.querySelector<HTMLElement>(".ld-col-left");
  const centreCol = graphEl.querySelector<HTMLElement>(".ld-col-centre");
  const rightCol = graphEl.querySelector<HTMLElement>(".ld-col-right");
  if (!leftCol || !centreCol || !rightCol) return;

  const canonicalChips = new Map<string, HTMLElement>();
  centreCol.querySelectorAll<HTMLElement>(".ld-canonical-chip").forEach((el) => {
    const cf = el.dataset.canonicalField;
    if (cf) canonicalChips.set(cf, el);
  });

  drawSide(graphEl, svgEl, leftCol,  canonicalChips, lineage.inboundFields,  state.expandedLeft,  state.autoExpandedLeft,  "left");
  drawSide(graphEl, svgEl, rightCol, canonicalChips, lineage.outboundFields, state.expandedRight, state.autoExpandedRight, "right");

  applyFocusToLines(svgEl, state);
}

function drawSide(
  graphEl: HTMLElement,
  svgEl: SVGSVGElement,
  colEl: HTMLElement,
  canonicalChips: Map<string, HTMLElement>,
  fields: ConnectorFieldNode[],
  expandedSet: Set<string>,
  autoExpandedSet: Set<string>,
  side: "left" | "right",
): void {
  // Group fields by member
  const byMember = new Map<string, ConnectorFieldNode[]>();
  for (const f of fields) {
    const k = memberKey(f.connectorId, f.entity);
    if (!byMember.has(k)) byMember.set(k, []);
    byMember.get(k)!.push(f);
  }

  for (const [mk, mFields] of byMember) {
    const isExpanded = expandedSet.has(mk) || autoExpandedSet.has(mk);
    const passthrough = mFields.length === 1 && mFields[0]!.canonicalField === "*";

    if (!isExpanded || passthrough) {
      // Draw one line per canonical field that this member participates in.
      const entityHeader = Array.from(
        colEl.querySelectorAll<HTMLElement>(".ld-entity-header"),
      ).find((h) => h.dataset.memberKey === mk) ?? null;
      if (!entityHeader) continue;

      const canonicalFields = passthrough
        ? ["*"]
        : [...new Set(mFields.map((f) => f.canonicalField))];

      for (const cf of canonicalFields) {
        const chip = canonicalChips.get(cf);
        if (!chip) continue;
        const entityRect = relRect(entityHeader, graphEl);
        const chipRect = relRect(chip, graphEl);

        const [x1, y1, x2, y2] = endpoints(entityRect, chipRect, side);
        const path = createSVGPath(x1, y1, x2, y2, cf, mk, passthrough, side);
        // Direction stored but direction-text on lines removed — arrows shown on canonical chips instead.
        svgEl.appendChild(path);
      }
    } else {
      // Expanded: draw one line per individual field pill.
      for (const f of mFields) {
        const fieldPill = Array.from(
          colEl.querySelectorAll<HTMLElement>(".ld-field-node"),
        ).find((n) => n.dataset.memberKey === mk && n.dataset.sourceField === f.sourceField && !n.dataset.unmapped) ?? null;
        const chip = canonicalChips.get(f.canonicalField);
        if (!fieldPill || !chip) continue;
        const pillRect = relRect(fieldPill, graphEl);
        // Skip if element is still hidden (getBoundingClientRect returns zeros).
        if (pillRect.width === 0 && pillRect.height === 0) continue;
        const chipRect = relRect(chip, graphEl);
        const [x1, y1, x2, y2] = endpoints(pillRect, chipRect, side);
        const path = createSVGPath(x1, y1, x2, y2, f.canonicalField, mk, false, side, f.isParentField);
        svgEl.appendChild(path);
      }
    }
  }
}

/** Compute line endpoints */
function endpoints(
  entityRect: DOMRect,
  chipRect: DOMRect,
  side: "left" | "right",
): [number, number, number, number] {
  const chipMidY = chipRect.top + chipRect.height / 2;
  const entityMidY = entityRect.top + entityRect.height / 2;
  if (side === "left") {
    return [
      entityRect.right,
      entityMidY,
      chipRect.left,
      chipMidY,
    ];
  } else {
    return [
      chipRect.right,
      chipMidY,
      entityRect.left,
      entityMidY,
    ];
  }
}

// ─── Focus ────────────────────────────────────────────────────────────────────

// Spec: specs/playground.md § 11.6
// When a connector field pill is selected, only the line from that specific
// entity is focused; same-side lines from other entities are dimmed.
// CSS class only — safe to call from RAF.
function applyFocusToLines(svgEl: SVGSVGElement, state: ChannelState): void {
  const { focusedCanonical, focusedField } = state;
  svgEl.querySelectorAll<SVGPathElement>(".ld-line").forEach((path) => {
    const cf = path.dataset.canonicalField ?? null;
    const ck = path.dataset.connectorKey ?? null;
    const ps = path.dataset.side as "left" | "right" | undefined;
    let focused: boolean;
    if (focusedField !== null) {
      // Same-side peers → dim; the selected entity's line → focus; opposite-side → focus if matching canonical
      if (ps === focusedField.side && ck !== focusedField.memberKey) {
        focused = false;
      } else {
        focused = cf === focusedCanonical;
      }
    } else {
      focused = cf === focusedCanonical;
    }
    path.classList.toggle("ld-line-focused", focusedCanonical !== null && focused);
    path.classList.toggle("ld-line-dimmed",  focusedCanonical !== null && !focused);
  });
  // Dir-text SVG elements no longer used; kept as no-op guard in case old SVGs linger.
  svgEl.querySelectorAll<SVGTextElement>(".ld-dir-text").forEach((text) => text.remove());
}

// Spec: specs/playground.md § 11.6
// Applies dimming and highlighting to entity headers and field pills:
//   - Canonical selected: both sides' field pills for that canonical get .ld-highlighted
//   - Left field selected: right-side field pills highlighted; left-side peers dimmed
//   - Right field selected: left-side field pills highlighted; right-side peers dimmed
// CSS class only — safe to call from RAF (no DOM add/remove, no resize trigger).
function applyNodeDimming(
  graphEl: HTMLElement,
  lineage: ChannelLineage,
  state: ChannelState,
): void {
  const { focusedCanonical, focusedField } = state;
  // Clear all dimming and highlight classes first.
  graphEl.querySelectorAll(".ld-dimmed, .ld-highlighted").forEach((el) => {
    el.classList.remove("ld-dimmed", "ld-highlighted");
  });
  if (focusedCanonical === null) return;

  const participatingLeft = new Set<string>();
  for (const f of lineage.inboundFields) {
    if (f.canonicalField === focusedCanonical) participatingLeft.add(memberKey(f.connectorId, f.entity));
  }
  const participatingRight = new Set<string>();
  for (const f of lineage.outboundFields) {
    if (f.canonicalField === focusedCanonical) participatingRight.add(memberKey(f.connectorId, f.entity));
  }

  // highlightLeft: true when left field pills should get the background highlight.
  // highlightRight: true when right field pills should get the background highlight.
  const highlightLeft  = focusedField === null || focusedField.side === "right";
  const highlightRight = focusedField === null || focusedField.side === "left";

  graphEl.querySelector<HTMLElement>(".ld-col-left")
    ?.querySelectorAll<HTMLElement>(".ld-entity-header, .ld-field-node")
    .forEach((el) => {
      const mk = el.dataset.memberKey ?? "";
      const cf = el.dataset.canonicalField; // undefined on entity headers
      const participates = participatingLeft.has(mk) && (cf === undefined || cf === focusedCanonical);
      if (!participates) {
        el.classList.add("ld-dimmed");
      } else if (cf !== undefined && highlightLeft) {
        el.classList.add("ld-highlighted");
      }
    });

  graphEl.querySelector<HTMLElement>(".ld-col-right")
    ?.querySelectorAll<HTMLElement>(".ld-entity-header, .ld-field-node")
    .forEach((el) => {
      const mk = el.dataset.memberKey ?? "";
      const cf = el.dataset.canonicalField;
      const participates = participatingRight.has(mk) && (cf === undefined || cf === focusedCanonical);
      if (!participates) {
        el.classList.add("ld-dimmed");
      } else if (cf !== undefined && highlightRight) {
        el.classList.add("ld-highlighted");
      }
    });
}

// Spec: specs/playground.md § 11.6 — toggles chip focus classes and direction arrows.
// Called synchronously on focus change — NOT from RAF.
// isFieldFocus=true: connector field was clicked — chip gets .ld-canonical-chip-related
// (background hint only, no border); canonical click gives .ld-canonical-chip-focused.
function syncFocusDecoration(
  centreCol: HTMLElement,
  focusedCanonical: string | null,
  isFieldFocus: boolean,
): void {
  centreCol.querySelectorAll<HTMLElement>(".ld-canonical-chip").forEach((chip) => {
    const cf = chip.dataset.canonicalField ?? null;
    const isMatch = cf === focusedCanonical && focusedCanonical !== null;
    chip.classList.toggle("ld-canonical-chip-focused", isMatch && !isFieldFocus);
    chip.classList.toggle("ld-canonical-chip-related", isMatch && isFieldFocus);
    chip.querySelectorAll(".ld-chip-arrow").forEach((a) => a.remove());
  });
}

// Highlight the specifically-selected connector field pill (if any).
// CSS class only — safe to call from RAF.
function applyFieldFocus(
  graphEl: HTMLElement,
  focusedField: ChannelState["focusedField"],
): void {
  graphEl.querySelectorAll<HTMLElement>(".ld-field-node-focused").forEach((el) => el.classList.remove("ld-field-node-focused"));
  if (!focusedField) return;
  const colEl = graphEl.querySelector<HTMLElement>(
    focusedField.side === "left" ? ".ld-col-left" : ".ld-col-right",
  );
  if (!colEl) return;
  Array.from(colEl.querySelectorAll<HTMLElement>(".ld-field-node"))
    .find((n) => n.dataset.memberKey === focusedField.memberKey && n.dataset.sourceField === focusedField.sourceField)
    ?.classList.add("ld-field-node-focused");
}

// ─── DOM builders ─────────────────────────────────────────────────────────────

function buildEntityHeader(
  connectorId: string,
  entity: string,
  mk: string,
): HTMLElement {
  const header = document.createElement("div");
  header.className = "ld-entity-header";
  header.dataset.memberKey = mk;
  header.title = `Click to expand ${connectorId} / ${entity}`;
  const label = document.createElement("span");
  label.className = "ld-entity-label";
  label.textContent = `${connectorId} / ${entity}`;
  const chevron = document.createElement("span");
  chevron.className = "ld-chevron";
  chevron.textContent = "▸";
  header.appendChild(label);
  header.appendChild(chevron);
  return header;
}

function buildFieldNode(f: ConnectorFieldNode): HTMLElement {
  const node = document.createElement("div");
  node.className = "ld-field-node";
  if (f.isAssoc)                  node.classList.add("ld-field-node-assoc");
  if (f.isParentField)            node.classList.add("ld-field-node-parent");
  if (f.isExpressionPlaceholder)  node.classList.add("ld-field-node-expr-placeholder");
  if (f.hasExpression)            node.classList.add("ld-field-node-expr");
  node.dataset.memberKey     = memberKey(f.connectorId, f.entity);
  node.dataset.sourceField   = f.sourceField;
  node.dataset.canonicalField = f.canonicalField;
  if (f.isAssoc) {
    const marker = document.createElement("span");
    marker.className = "ld-assoc-marker";
    marker.textContent = "◇";
    node.appendChild(marker);
    node.appendChild(document.createTextNode(f.sourceField));
  } else if (f.isExpressionPlaceholder) {
    const em = document.createElement("em");
    em.textContent = f.sourceField; // "(expression)"
    node.appendChild(em);
  } else {
    node.textContent = f.sourceField;
    if (f.isParentField) {
      const suffix = document.createElement("span");
      suffix.className = "ld-parent-marker";
      suffix.textContent = " ↑";
      node.appendChild(suffix);
    }
    if (f.hasExpression) {
      const marker = document.createElement("span");
      marker.className = "ld-expr-marker";
      marker.textContent = " ƒ";
      node.appendChild(marker);
    }
  }
  return node;
}

function buildFieldsList(
  fields: ConnectorFieldNode[],
  mk: string,
): HTMLElement {
  const list = document.createElement("div");
  list.className = "ld-fields-list";
  list.dataset.memberKey = mk;
  for (const f of fields) {
    list.appendChild(buildFieldNode(f));
  }
  return list;
}

function buildEntityGroup(
  connectorId: string,
  entity: string,
  fields: ConnectorFieldNode[],
  mk: string,
  expandedSet: Set<string>,
  autoExpandedSet: Set<string>,
  colElRef: { el: HTMLElement | null },
  scheduleRedraw: () => void,
  allEntityFields: FieldPreview[] | null,  // Spec: specs/playground.md § 11.15
): HTMLElement {
  const group = document.createElement("div");
  group.className = "ld-entity-group";

  const header = buildEntityHeader(connectorId, entity, mk);
  group.appendChild(header);

  const passthrough = fields.length === 1 && fields[0]!.canonicalField === "*";
  if (!passthrough) {
    const fieldsList = buildFieldsList(fields, mk);

    // Append unmapped fields below the mapped ones. Spec: specs/playground.md § 11.15
    if (allEntityFields && allEntityFields.length > 0) {
      const mappedSourceFields = new Set(fields.map((f) => f.sourceField));
      const unmappedFields = allEntityFields.filter((fp) => !mappedSourceFields.has(fp.name));
      if (unmappedFields.length > 0) {
        const sep = document.createElement("div");
        sep.className = "ld-fields-separator";
        sep.textContent = "— also available —";
        fieldsList.appendChild(sep);
        for (const fp of unmappedFields) {
          const node = document.createElement("div");
          node.className = "ld-field-node ld-field-node-unmapped";
          if (fp.isFK) node.classList.add("ld-field-node-fk");
          node.dataset.unmapped = "true";
          const nameSpan = document.createElement("span");
          nameSpan.textContent = fp.name;
          node.appendChild(nameSpan);
          const metaParts: string[] = [];
          if (fp.description) metaParts.push(fp.description);
          if (fp.type)        metaParts.push(fp.type);
          if (fp.example != null) metaParts.push(`e.g. ${String(fp.example)}`);
          if (metaParts.length > 0) {
            const meta = document.createElement("span");
            meta.className = "ld-field-node-meta";
            meta.textContent = metaParts.join(" · ");
            node.appendChild(meta);
          }
          fieldsList.appendChild(node);
        }
      }
    }

    fieldsList.classList.add("ld-hidden"); // always start collapsed
    group.appendChild(fieldsList);

    header.addEventListener("click", () => {
      if (colElRef.el) {
        setEntityExpanded(colElRef.el, mk, expandedSet, !expandedSet.has(mk), autoExpandedSet);
      }
      scheduleRedraw();
    });
  } else {
    // Passthrough entity (no explicit field mappings in config).
    if (allEntityFields && allEntityFields.length > 0) {
      // Has schema fields: make expandable showing all fields as "available" (none are mapped)
      const fieldsList = document.createElement("div");
      fieldsList.className = "ld-fields-list";
      fieldsList.dataset.memberKey = mk;
      for (const fp of allEntityFields) {
        const node = document.createElement("div");
        node.className = "ld-field-node ld-field-node-unmapped";
        if (fp.isFK) node.classList.add("ld-field-node-fk");
        node.dataset.unmapped = "true";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = fp.name;
        node.appendChild(nameSpan);
        const metaParts: string[] = [];
        if (fp.description) metaParts.push(fp.description);
        if (fp.type)        metaParts.push(fp.type);
        if (fp.example != null) metaParts.push(`e.g. ${String(fp.example)}`);
        if (metaParts.length > 0) {
          const meta = document.createElement("span");
          meta.className = "ld-field-node-meta";
          meta.textContent = metaParts.join(" \u00b7 ");
          node.appendChild(meta);
        }
        fieldsList.appendChild(node);
      }
      fieldsList.classList.add("ld-hidden");
      group.appendChild(fieldsList);
      header.addEventListener("click", () => {
        if (colElRef.el) {
          setEntityExpanded(colElRef.el, mk, expandedSet, !expandedSet.has(mk), autoExpandedSet);
        }
        scheduleRedraw();
      });
    } else {
      // No schema fields: truly non-interactive passthrough
      header.classList.add("ld-entity-header-passthrough");
      header.title = "";
      header.querySelector<HTMLElement>(".ld-chevron")?.remove();
    }
  }

  return group;
}

function buildColumn(
  fields: ConnectorFieldNode[],
  expandedSet: Set<string>,
  autoExpandedSet: Set<string>,
  scheduleRedraw: () => void,
  allEntities?: Map<string, Map<string, FieldPreview[]>>,
): HTMLElement {
  const col = document.createElement("div");
  col.className = "ld-col";
  const colElRef: { el: HTMLElement | null } = { el: null };

  const byMember = new Map<string, ConnectorFieldNode[]>();
  for (const f of fields) {
    const k = memberKey(f.connectorId, f.entity);
    if (!byMember.has(k)) byMember.set(k, []);
    byMember.get(k)!.push(f);
  }

  for (const [mk, mFields] of byMember) {
    const { connectorId, entity } = mFields[0]!;
    const allEntityFields = allEntities?.get(connectorId)?.get(entity) ?? null;
    col.appendChild(buildEntityGroup(connectorId, entity, mFields, mk, expandedSet, autoExpandedSet, colElRef, scheduleRedraw, allEntityFields));
  }

  colElRef.el = col;
  return col;
}

function buildCentreColumn(lineage: ChannelLineage): HTMLElement {
  const col = document.createElement("div");
  col.className = "ld-col ld-col-centre";

  for (const node of lineage.canonicalFields) {
    const chip = document.createElement("div");
    chip.className = "ld-canonical-chip";
    chip.dataset.canonicalField = node.fieldName;
    if (node.isIdentity) chip.classList.add("ld-canonical-identity");
    if (node.isAssoc)    chip.classList.add("ld-canonical-chip-assoc");
    const nameSpan = document.createElement("span");
    nameSpan.className = "ld-canonical-name";
    if (node.isAssoc) {
      const marker = document.createElement("span");
      marker.className = "ld-assoc-marker";
      marker.textContent = "◇";
      nameSpan.appendChild(marker);
      nameSpan.appendChild(document.createTextNode(node.fieldName === "*" ? "(all fields)" : node.fieldName));
    } else {
      nameSpan.textContent = node.fieldName === "*" ? "(all fields)" : node.fieldName;
    }
    chip.appendChild(nameSpan);
    if (node.hasResolver) {
      const badge = document.createElement("span");
      badge.className = "ld-resolver-badge";
      badge.textContent = "ƒ";
      badge.title = "Custom resolver function";
      chip.appendChild(badge);
    }
    col.appendChild(chip);
  }

  if (lineage.canonicalFields.some((n) => n.isIdentity)) {
    const identityFields = lineage.canonicalFields
      .filter((n) => n.isIdentity)
      .map((n) => `○ ${n.fieldName}`)
      .join("  ");
    const identityDiv = document.createElement("div");
    identityDiv.className = "ld-identity";
    identityDiv.textContent = `identity: ${identityFields}`;
    col.appendChild(identityDiv);
  }

  return col;
}

// ─── Flow direction header ───────────────────────────────────────────────────

// Spec: specs/playground.md § 11.3
// Three-column header above the graph: columns align with ld-graph grid.
// Shows data flow direction and labels each column role.
function buildFlowHeader(channelId: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "ld-flow-header";

  const upstream = document.createElement("div");
  upstream.className = "ld-flow-label ld-flow-left";
  upstream.textContent = "upstream";

  const centre = document.createElement("div");
  centre.className = "ld-flow-channel-id";
  centre.textContent = channelId;

  const downstream = document.createElement("div");
  downstream.className = "ld-flow-label ld-flow-right";
  downstream.textContent = "downstream";

  row.appendChild(upstream);
  row.appendChild(centre);
  row.appendChild(downstream);
  return row;
}

// ─── Channel section ──────────────────────────────────────────────────────────

function buildChannelSection(
  channel: ChannelConfig,
  lineage: ChannelLineage,
  allEntities?: Map<string, Map<string, FieldPreview[]>>,
): HTMLElement {
  const state: ChannelState = {
    expandedLeft: new Set(),
    expandedRight: new Set(),
    autoExpandedLeft: new Set(),
    autoExpandedRight: new Set(),
    focusedCanonical: null,
    focusedField: null,
  };

  const section = document.createElement("section");
  section.className = "ld-channel";

  section.appendChild(buildFlowHeader(channel.id));

  const graphEl = document.createElement("div");
  graphEl.className = "ld-graph";

  // RAF-debounced redraw — Spec: specs/playground.md § 11.9
  // Using requestAnimationFrame (not Promise microtask) ensures getBoundingClientRect()
  // reads post-layout positions. The "already scheduled" guard collapses rapid
  // consecutive triggers (entity expand + ResizeObserver) into a single draw pass.
  let rafId: number | null = null;
  function scheduleRedraw(): void {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      drawLines(graphEl, svgEl, lineage, state);
      applyFocusToLines(svgEl, state);
      // applyNodeDimming only toggles CSS classes — no DOM add/remove, no resize trigger.
      applyNodeDimming(graphEl, lineage, state);
      applyFieldFocus(graphEl, state.focusedField);
    });
  }

  // Build 3 columns
  const leftCol = buildColumn(lineage.inboundFields, state.expandedLeft, state.autoExpandedLeft, scheduleRedraw, allEntities);
  leftCol.classList.add("ld-col-left");

  const centreCol = buildCentreColumn(lineage);

  const rightCol = buildColumn(lineage.outboundFields, state.expandedRight, state.autoExpandedRight, scheduleRedraw, allEntities);
  rightCol.classList.add("ld-col-right");

  // SVG overlay
  const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgEl.classList.add("ld-lines");

  graphEl.appendChild(leftCol);
  graphEl.appendChild(centreCol);
  graphEl.appendChild(rightCol);
  graphEl.appendChild(svgEl);
  section.appendChild(graphEl);

  // Connector field pill click — selects the canonical that field maps to and
  // highlights the specific pill. Uses event delegation on the column so we don't
  // need to touch the field node builders.
  function handleFieldClick(e: MouseEvent, side: "left" | "right"): void {
    const fieldNode = (e.target as HTMLElement).closest<HTMLElement>(".ld-field-node");
    if (!fieldNode) return;
    const mk = fieldNode.dataset.memberKey ?? null;
    const sf = fieldNode.dataset.sourceField ?? null;
    const cf = fieldNode.dataset.canonicalField ?? null;
    if (!mk || !sf || !cf) return;
    const isSame = state.focusedField?.side === side &&
      state.focusedField.memberKey === mk &&
      state.focusedField.sourceField === sf;
    collapseAutoExpanded(leftCol, rightCol, state);
    if (isSame) {
      state.focusedCanonical = null;
      state.focusedField = null;
    } else {
      state.focusedCanonical = cf;
      state.focusedField = { side, memberKey: mk, sourceField: sf };
      // Only expand entities on the OPPOSITE side — same-side peers stay neutral.
      expandMembersForCanonical(cf, lineage, state, leftCol, rightCol, side);
    }
    syncFocusDecoration(centreCol, state.focusedCanonical, /* isFieldFocus */ true);
    requestAnimationFrame(() => scheduleRedraw());
  }
  leftCol.addEventListener("click",  (e) => handleFieldClick(e, "left"));
  rightCol.addEventListener("click", (e) => handleFieldClick(e, "right"));

  // Canonical chip click — focus toggle + auto-expand relevant entities.
  // Spec: specs/playground.md § 11.6
  centreCol.querySelectorAll<HTMLElement>(".ld-canonical-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const cf = chip.dataset.canonicalField ?? null;
      const wasFieldFocus = state.focusedField !== null;
      state.focusedField = null;
      collapseAutoExpanded(leftCol, rightCol, state);
      // Deselect only when the canonical is already the primary selection
      // (no field pill was selected). If a field pill was selected, clicking
      // the related canonical promotes it to primary selection.
      if (!wasFieldFocus && state.focusedCanonical === cf) {
        state.focusedCanonical = null;
      } else {
        state.focusedCanonical = cf;
        if (cf !== null) {
          expandMembersForCanonical(cf, lineage, state, leftCol, rightCol);
        }
      }
      syncFocusDecoration(centreCol, state.focusedCanonical, /* isFieldFocus */ false);
      // Double RAF: first frame commits the ld-hidden removal to layout,
      // second frame reads settled getBoundingClientRect positions.
      requestAnimationFrame(() => scheduleRedraw());
    });
  });

  // Escape key to clear focus
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (state.focusedCanonical !== null || state.focusedField !== null)) {
      collapseAutoExpanded(leftCol, rightCol, state);
      state.focusedCanonical = null;
      state.focusedField = null;
      syncFocusDecoration(centreCol, null, false);
      scheduleRedraw();
    }
  });

  // Observe the section (not graphEl) for pane-resize redraws.
  // Observing graphEl would fire on every entity expand/collapse, creating a
  // feedback loop. The section also fires when the diagram tab becomes visible
  // (size goes from 0 to actual), handling the initial draw correctly.
  // Spec: specs/playground.md § 11.9
  const resizeObserver = new ResizeObserver(() => scheduleRedraw());
  resizeObserver.observe(section);

  // Initial draw (fires on first animation frame; also covered by ResizeObserver
  // when the Diagram tab is first shown).
  scheduleRedraw();

  return section;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Spec: specs/playground.md § 11
export function renderLineageDiagram(
  container: HTMLElement,
  channels: ChannelConfig[],
  allEntities?: Map<string, Map<string, FieldPreview[]>>,
): void {
  container.innerHTML = "";

  for (const channel of channels) {
    const lineage = buildChannelLineage(channel);
    container.appendChild(buildChannelSection(channel, lineage, allEntities));
  }

  // Spec: specs/playground.md § 11.14 — unmapped entity pool
  // Spec: specs/playground.md § 11.15 — expandable field preview in pool
  if (allEntities) {
    const mapped = new Set<string>();
    for (const ch of channels) {
      for (const m of ch.members) {
        // array-source members expose their sourceEntity to the pool
        const entityName = (m as { sourceEntity?: string }).sourceEntity ?? m.entity;
        mapped.add(`${m.connectorId}/${entityName}`);
      }
    }
    const pool: { connectorId: string; entity: string; fields: FieldPreview[] }[] = [];
    for (const [connectorId, entityMap] of allEntities) {
      for (const [entity, fields] of entityMap) {
        if (!mapped.has(`${connectorId}/${entity}`)) {
          pool.push({ connectorId, entity, fields });
        }
      }
    }
    if (pool.length > 0) {
      const expandedPool = new Set<string>();
      const poolEl = document.createElement("div");
      poolEl.className = "ld-unassigned-pool";
      const label = document.createElement("span");
      label.className = "ld-pool-label";
      label.textContent = "unassigned";
      poolEl.appendChild(label);
      const pills = document.createElement("div");
      pills.className = "ld-pool-pills";
      for (const { connectorId, entity, fields } of pool) {
        const key = `${connectorId}/${entity}`;
        const group = document.createElement("div");
        group.className = "ld-pool-entity-group";
        const header = document.createElement("div");
        header.className = "ld-pool-entity-header";
        const entityLabel = document.createElement("span");
        entityLabel.className = "ld-pool-entity-label";
        entityLabel.textContent = `${connectorId} / ${entity}`;
        header.appendChild(entityLabel);
        if (fields.length > 0) {
          const chevron = document.createElement("span");
          chevron.className = "ld-chevron";
          chevron.textContent = "▸";
          header.appendChild(chevron);
          const fieldsList = document.createElement("div");
          fieldsList.className = "ld-pool-fields-list ld-hidden";
          for (const fp of fields) {
            const row = document.createElement("div");
            row.className = "ld-pool-field-row";
            if (fp.isFK) row.classList.add("ld-pool-field-fk");
            const nameEl = document.createElement("span");
            nameEl.className = "ld-pool-field-name";
            nameEl.textContent = fp.name;
            row.appendChild(nameEl);
            const metaParts: string[] = [];
            if (fp.description) metaParts.push(fp.description);
            if (fp.type)        metaParts.push(fp.type);
            if (fp.example != null) metaParts.push(`e.g. ${String(fp.example)}`);
            if (metaParts.length > 0) {
              const meta = document.createElement("span");
              meta.className = "ld-pool-field-meta";
              meta.textContent = metaParts.join(" · ");
              row.appendChild(meta);
            }
            fieldsList.appendChild(row);
          }
          group.appendChild(header);
          group.appendChild(fieldsList);
          header.addEventListener("click", () => {
            const isExpanded = expandedPool.has(key);
            expandedPool[isExpanded ? "delete" : "add"](key);
            chevron.textContent = isExpanded ? "▸" : "▾";
            fieldsList.classList.toggle("ld-hidden", isExpanded);
          });
        } else {
          group.appendChild(header);
        }
        pills.appendChild(group);
      }
      poolEl.appendChild(pills);
      container.appendChild(poolEl);
    }
  }
}
