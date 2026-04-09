// Systems pane — right side, channel tabs at top, records grouped by identity cluster.
// Each cluster row spans all channel members horizontally.
// Refreshed after every poll pass. Supports inline edit/delete/new via modal.
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter } from "@codemirror/lint";
import { keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import type { InMemoryConnector, RecordWithMeta } from "../inmemory.js";
import type { ChannelCluster, NoLinkEntry } from "../engine-lifecycle.js";
import type { ChannelConfig } from "@opensync/engine";
import { renderLineageDiagram, type FieldPreview } from "./lineage-diagram.js";

// ─── Public types ──────────────────────────────────────────────────────────────

export interface SystemsPaneCallbacks {
  /** id === null for new records. explicitId is set when user provided a custom ID in the new-record dialog. */
  onSave: (systemId: string, entity: string, id: string | null, data: Record<string, unknown>, explicitId?: string) => void;
  onSoftDelete: (systemId: string, entity: string, id: string) => void;
  onRestore:    (systemId: string, entity: string, id: string) => void;
  /** Break a linked cluster into individual records (each gets its own canonical_id). */
  onSplitCluster: (canonicalId: string) => void;
  /** Detach one record from a cluster and write no_link for all siblings. */
  onSplitCanonical: (canonicalId: string, connectorId: string, entityName: string, externalId: string) => void;
  /** Remove an anti-affinity pair so the two records may be re-merged. */
  onRemoveNoLink: (entry: NoLinkEntry) => void;
  /** Called whenever the active tab changes (channel id, "__unmapped__", or "__lineage__").
   *  Used by main.ts to keep the URL hash in sync. Spec: specs/playground.md § 12.2 */
  onTabChange?: (tab: string) => void;
}

// ─── Modal editor (module-level singleton) ────────────────────────────────────

let modalEl: HTMLDialogElement | null = null;
let modalView: EditorView | null = null;
let modalSaveHandler: (() => void) | null = null;

function ensureModal(): void {
  if (modalEl) return;

  modalEl = document.createElement("dialog");
  modalEl.className = "edit-dialog";
  modalEl.innerHTML = `
    <div class="dialog-header">
      <span class="dialog-title" id="dialog-title"></span>
      <button class="btn-ghost dialog-close">✕</button>
    </div>
    <div class="dialog-id-field" hidden>
      <label class="dialog-id-label">ID <span class="dialog-id-optional">(optional — leave blank for auto-generated UUID)</span></label>
      <input type="text" class="dialog-id-input" placeholder="e.g. contact-42 or acme-corp" autocomplete="off">
    </div>
    <div class="dialog-editor-mount"></div>
    <div class="dialog-footer">
      <span class="editor-hint">Ctrl/Cmd + Enter to save</span>
      <div class="dialog-footer-actions">
        <button class="btn-ghost dialog-cancel">Cancel</button>
        <button class="btn-save dialog-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);

  modalEl.querySelector(".dialog-close")!.addEventListener("click",  () => modalEl!.close());
  modalEl.querySelector(".dialog-cancel")!.addEventListener("click", () => modalEl!.close());
  modalEl.querySelector(".dialog-save")!.addEventListener("click",   () => { modalSaveHandler?.(); modalEl!.close(); });
  modalEl.addEventListener("click", (e) => { if (e.target === modalEl) modalEl!.close(); });

  const mount = modalEl.querySelector(".dialog-editor-mount") as HTMLElement;
  modalView = new EditorView({
    state: EditorState.create({
      doc: "{}",
      extensions: [
        json(),
        linter(jsonParseLinter()),
        oneDark,
        EditorView.lineWrapping,
        keymap.of([
          { key: "Ctrl-Enter", run: () => { modalSaveHandler?.(); modalEl?.close(); return true; } },
          { key: "Mod-Enter",  run: () => { modalSaveHandler?.(); modalEl?.close(); return true; } },
          ...defaultKeymap,
        ]),
        EditorView.theme({
          "&": { fontSize: "13px" },
          ".cm-scroller": { minHeight: "160px", maxHeight: "55vh", overflow: "auto" },
          ".cm-content": { padding: "8px 0" },
        }),
      ],
    }),
    parent: mount,
  });
}

function openModal(title: string, initialJson: string, onSave: (raw: string) => void): void {
  ensureModal();
  (modalEl!.querySelector("#dialog-title") as HTMLElement).textContent = title;
  (modalEl!.querySelector(".dialog-id-field") as HTMLElement).hidden = true;
  modalView!.dispatch({ changes: { from: 0, to: modalView!.state.doc.length, insert: initialJson } });
  modalSaveHandler = () => onSave(modalView!.state.doc.toString());
  modalEl!.showModal();
}

/** New-record variant: shows an optional ID input above the JSON editor. */
function openNewRecordModal(title: string, initialJson: string, onSave: (raw: string, explicitId: string | undefined) => void): void {
  ensureModal();
  (modalEl!.querySelector("#dialog-title") as HTMLElement).textContent = title;
  const idField = modalEl!.querySelector<HTMLElement>(".dialog-id-field")!;
  const idInput = modalEl!.querySelector<HTMLInputElement>(".dialog-id-input")!;
  idField.hidden = false;
  idInput.value = "";
  modalView!.dispatch({ changes: { from: 0, to: modalView!.state.doc.length, insert: initialJson } });
  modalSaveHandler = () => {
    const explicitId = idInput.value.trim() || undefined;
    onSave(modalView!.state.doc.toString(), explicitId);
  };
  modalEl!.showModal();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

// ─── Card builder ─────────────────────────────────────────────────────────────

function buildCard(
  rec: RecordWithMeta,
  systemId: string,
  entity: string,
  flash: boolean,
  isHighlight: boolean,
  callbacks: SystemsPaneCallbacks,
  onNavigate: (targetEntity: string, targetId: string) => void,
  allSystems: Map<string, InMemoryConnector>,
  /** When set, this card is an array sub-object — edit/delete are hidden and an
   *  annotation is shown instead (value: parent path, e.g. "purchases.lines"). */
  embeddedIn?: string,
  /** When set, show a clickable badge linking back to the parent record. */
  parentRef?: { entity: string; id: string },
  /** Canonical ID of the cluster this card belongs to (undefined for unlinked). */
  canonicalId?: string,
  /** When true, the cluster has ≥2 non-null slots — show the Break button. */
  isLinkedCluster?: boolean,
  /** Anti-affinity entries where one endpoint is this record. */
  noLinkEntries?: NoLinkEntry[],
): HTMLElement {
  const card = document.createElement("div");
  card.className = "record-card";
  if (flash) card.classList.add("record-flash");
  if (isHighlight) card.classList.add("record-highlight");
  if (rec.softDeleted) card.classList.add("record-deleted");

  // ID badge
  const idBadge = document.createElement("code");
  idBadge.className = "record-id";
  idBadge.textContent = rec.id;
  card.appendChild(idBadge);

  // Fields table
  const table = document.createElement("table");
  table.className = "record-fields";
  for (const [key, value] of Object.entries(rec.data)) {
    if (Array.isArray(value)) {
      // Array field — static chip showing element count, no expand/collapse.
      const tr = document.createElement("tr");
      const tdK = document.createElement("td"); tdK.className = "field-key"; tdK.textContent = key;
      const tdV = document.createElement("td"); tdV.className = "field-val field-val-array";
      const chip = document.createElement("span");
      chip.className = "array-count-chip";
      chip.title = value.length > 0 ? JSON.stringify(value).slice(0, 120) : "(empty array)";
      chip.textContent = `[${value.length} item${value.length === 1 ? "" : "s"}]`;
      tdV.appendChild(chip);
      tr.appendChild(tdK); tr.appendChild(tdV);
      table.appendChild(tr);
    } else {
      const tr = document.createElement("tr");
      const tdK = document.createElement("td"); tdK.className = "field-key"; tdK.textContent = key;
      const tdV = document.createElement("td"); tdV.className = "field-val";
      tdV.textContent = typeof value === "string" ? value : String(value ?? "");
      tr.appendChild(tdK); tr.appendChild(tdV);
      table.appendChild(tr);
    }
  }
  card.appendChild(table);

  // Association badges (clickable; indicate target existence state)
  if (rec.associations && rec.associations.length > 0) {
    const badges = document.createElement("div");
    badges.className = "assoc-badges";
    const sysSnap = allSystems.get(systemId)?.snapshotFull();
    for (const assoc of rec.associations) {
      const badge = document.createElement("span");
      const targetRec = sysSnap?.[assoc.targetEntity]?.find((r) => r.id === assoc.targetId);
      const isMissing = targetRec === undefined;
      const isDeletedTarget = targetRec?.softDeleted === true;
      badge.className = `assoc-badge${isMissing ? " assoc-missing" : isDeletedTarget ? " assoc-deleted-target" : " assoc-badge-link"}`;
      badge.textContent = `● ${assoc.predicate}: ${assoc.targetId}`;
      if (isMissing) {
        badge.title = `Target "${assoc.targetId}" not found in ${systemId}/${assoc.targetEntity}`;
      } else if (isDeletedTarget) {
        badge.title = `Target "${assoc.targetId}" is soft-deleted`;
        badge.addEventListener("click", () => onNavigate(assoc.targetEntity, assoc.targetId));
      } else {
        badge.title = `Navigate to ${assoc.targetEntity} / ${assoc.targetId}`;
        badge.addEventListener("click", () => onNavigate(assoc.targetEntity, assoc.targetId));
      }
      badges.appendChild(badge);
    }
    card.appendChild(badges);
  }

  // Parent record badge — shown on array sub-object cards.
  if (parentRef) {
    const parentBadges = document.createElement("div");
    parentBadges.className = "assoc-badges";
    const sysSnap = allSystems.get(systemId)?.snapshotFull();
    const parentRec = sysSnap?.[parentRef.entity]?.find((r) => r.id === parentRef.id);
    const isMissing = parentRec === undefined;
    const badge = document.createElement("span");
    badge.className = `assoc-badge parent-badge${isMissing ? " assoc-missing" : " assoc-badge-link"}`;
    badge.textContent = `↑ ${parentRef.entity}: ${parentRef.id}`;
    badge.title = isMissing
      ? `Parent "${parentRef.id}" not found in ${systemId}/${parentRef.entity}`
      : `Navigate to parent: ${parentRef.entity} / ${parentRef.id}`;
    if (!isMissing) badge.addEventListener("click", () => onNavigate(parentRef.entity, parentRef.id));
    parentBadges.appendChild(badge);
    card.appendChild(parentBadges);
  }

  // Anti-affinity badge — shown when this record has no_link entries.
  if ((noLinkEntries?.length ?? 0) > 0) {
    const nlWrap = document.createElement("div");
    nlWrap.className = "assoc-badges";
    nlWrap.style.position = "relative";

    const badge = document.createElement("button");
    badge.className = "no-link-badge";
    badge.textContent = `⛓ no-link (${noLinkEntries!.length})`;
    badge.title = "Click to view or remove anti-affinity entries";

    const popover = document.createElement("div");
    popover.className = "no-link-popover";
    popover.hidden = true;

    function refreshPopover(): void {
      popover.innerHTML = "";
      const heading = document.createElement("div");
      heading.className = "no-link-popover-title";
      heading.textContent = "Anti-affinity — never merge with:";
      popover.appendChild(heading);
      for (const nl of noLinkEntries!) {
        // Badge is only shown on the A-side (owner), so the partner is always the B-side
        const [partConn, partEntity, partExt] = [nl.connector_id_b, nl.entity_name_b, nl.external_id_b];
        const row = document.createElement("div");
        row.className = "no-link-popover-row";
        const label = document.createElement("span");
        label.textContent = `${partConn}/${partEntity}/${partExt}`;
        const removeBtn = document.createElement("button");
        removeBtn.className = "btn-nl-remove";
        removeBtn.textContent = "✕";
        removeBtn.title = "Remove this anti-affinity entry";
        removeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          callbacks.onRemoveNoLink(nl);
        });
        row.appendChild(label);
        row.appendChild(removeBtn);
        popover.appendChild(row);
      }
    }
    refreshPopover();

    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      popover.hidden = !popover.hidden;
    });
    // Close when clicking anywhere outside
    document.addEventListener("click", () => { popover.hidden = true; });

    nlWrap.appendChild(badge);
    nlWrap.appendChild(popover);
    card.appendChild(nlWrap);
  }

  // Footer
  const footer = document.createElement("div");
  footer.className = "card-footer";

  const modTime = document.createElement("span");
  modTime.className = "record-modified";
  modTime.textContent = rec.modifiedAt ? `mod ${fmtTime(rec.modifiedAt)}` : "";
  footer.appendChild(modTime);

  const actions = document.createElement("div");
  actions.className = "card-actions";

  if (embeddedIn) {
    // Array sub-object: read-only in the UI — edit via the parent record.
    const badge = document.createElement("span");
    badge.className = "embedded-badge";
    badge.title = `This record is a sub-object of ${embeddedIn}. Edit the parent record to change it.`;
    badge.textContent = `⊂ ${embeddedIn}`;
    actions.appendChild(badge);
  } else if (!rec.softDeleted) {
    const editBtn = document.createElement("button");
    editBtn.className = "btn-card";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      openModal(
        `Edit  ${systemId} / ${entity} / ${rec.id}`,
        JSON.stringify({ data: rec.data }, null, 2),
        (raw) => {
          let parsed: { data?: Record<string, unknown> };
          try { parsed = JSON.parse(raw) as typeof parsed; }
          catch (e) { alert(`Invalid JSON:\n${String(e)}`); return; }
          const data = parsed.data ?? (parsed as Record<string, unknown>);
          callbacks.onSave(systemId, entity, rec.id, data as Record<string, unknown>);
        },
      );
    });
    actions.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "btn-card btn-delete";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      callbacks.onSoftDelete(systemId, entity, rec.id);
    });
    actions.appendChild(delBtn);

    // Break button — only for records in linked clusters with ≥2 members.
    if (isLinkedCluster && canonicalId) {
      const breakBtn = document.createElement("button");
      breakBtn.className = "btn-card btn-break";
      breakBtn.textContent = "Break";
      breakBtn.title = "Detach this record from the cluster \u2014 writes no_link for all siblings";
      breakBtn.addEventListener("click", () => {
        callbacks.onSplitCanonical(canonicalId, systemId, entity, rec.id);
      });
      actions.appendChild(breakBtn);
    }
  } else {
    const restoreBtn = document.createElement("button");
    restoreBtn.className = "btn-card btn-restore";
    restoreBtn.textContent = "Restore";
    restoreBtn.addEventListener("click", () => {
      callbacks.onRestore(systemId, entity, rec.id);
    });
    actions.appendChild(restoreBtn);
  }

  footer.appendChild(actions);
  card.appendChild(footer);

  return card;
}

// ─── Public factory ───────────────────────────────────────────────────────────

export function createSystemsPane(
  container: HTMLElement,
  callbacks: SystemsPaneCallbacks,
): {
  refresh: (
    channels: ChannelConfig[],
    systems: Map<string, InMemoryConnector>,
    clustersByChannel: Map<string, ChannelCluster[]>,
    noLinks?: NoLinkEntry[],
  ) => void;
  /** Set the active tab without pushing a history entry (used for hash restore). */
  setActiveTab: (tab: string) => void;
} {
  container.innerHTML = "";

  const tabBar = document.createElement("div");
  tabBar.className = "channel-tab-bar";
  container.appendChild(tabBar);

  const channelArea = document.createElement("div");
  channelArea.className = "channel-area";
  container.appendChild(channelArea);

  let activeChannel: string | null = null;
  let highlightId: string | undefined;
  let lastWatermarks = new Map<string, number>();
  let hasRefreshed = false;
  let lastChangedChannels = new Set<string>();
  // Fingerprint of the last channels array — used to detect config changes so the
  // lineage diagram is rebuilt when Apply is clicked. Spec: specs/playground.md § 11
  let lastChannelsKey = "";

  let cachedChannels: ChannelConfig[] = [];
  let cachedSystems: Map<string, InMemoryConnector> = new Map();
  let cachedClusters: Map<string, ChannelCluster[]> = new Map();
  let cachedNoLinks: NoLinkEntry[] = [];

  function noLinksForRecord(connectorId: string, entity: string, externalId: string): NoLinkEntry[] {
    // Badge is shown only on the A-side (owner — the broken-out record)
    return cachedNoLinks.filter((nl) =>
      nl.connector_id_a === connectorId && nl.entity_name_a === entity && nl.external_id_a === externalId
    );
  }

  /** Returns true if any record in the channel has a new or updated watermark
   * since the last render.  Checks real connector records only (synthetic array
   * records track via their parent entity watermark). */
  function hasChannelActivity(
    ch: ChannelConfig,
    systems: Map<string, InMemoryConnector>,
  ): boolean {
    for (const m of ch.members) {
      const conn = systems.get(m.connectorId);
      if (!conn) continue;
      const full = conn.snapshotFull();
      // For array-source members check the parent entity (the real stored entity).
      const entityToCheck = m.arrayPath ? (m.sourceEntity ?? m.entity) : m.entity;
      for (const r of (full[entityToCheck] ?? [])) {
        const prevWm = lastWatermarks.get(`${m.connectorId}/${entityToCheck}/${r.id}`);
        if (prevWm === undefined || r.watermark > prevWm) return true;
      }
    }
    return false;
  }

  function navigateToRecord(targetEntity: string, targetId: string): void {
    const ch = cachedChannels.find((c) => c.members.some((m) => m.entity === targetEntity));
    if (ch) {
      activeChannel = ch.id;
    } else {
      // entity is unmapped — switch to unmapped tab
      activeChannel = "__unmapped__";
    }
    highlightId = targetId;
    renderTabs(cachedChannels);
    renderContent(cachedChannels, cachedSystems, cachedClusters, false);
    updateWatermarks(cachedSystems);
    setTimeout(() => {
      channelArea.querySelector(".record-highlight")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
    setTimeout(() => {
      highlightId = undefined;
      channelArea.querySelector(".record-highlight")?.classList.remove("record-highlight");
    }, 2500);
  }

  function renderUnmappedContent(
    channels: ChannelConfig[],
    systems: Map<string, InMemoryConnector>,
    isFirst: boolean,
  ): void {
    channelArea.innerHTML = "";

    const mapped = new Set<string>();
    for (const ch of channels) {
      for (const m of ch.members) mapped.add(`${m.connectorId}/${m.entity}`);
    }

    const sections: Array<{ connectorId: string; entity: string }> = [];
    for (const [connectorId, conn] of systems) {
      for (const entity of Object.keys(conn.snapshotFull())) {
        if (!mapped.has(`${connectorId}/${entity}`)) {
          sections.push({ connectorId, entity });
        }
      }
    }

    // Reuse the cluster-view layout (header + body columns) for consistency
    const view = document.createElement("div");
    view.className = "cluster-view";
    channelArea.appendChild(view);

    if (sections.length === 0) {
      const empty = document.createElement("div");
      empty.className = "record-empty";
      empty.style.marginTop = "20px";
      empty.textContent = "— all entities are mapped to channels —";
      view.appendChild(empty);
      return;
    }

    const n = sections.length;
    const gridCols = `repeat(${n}, 260px)`;

    // Header row
    const headerRow = document.createElement("div");
    headerRow.className = "cluster-header-row";
    headerRow.style.gridTemplateColumns = gridCols;
    headerRow.style.padding = "0 6px";    // match cluster-body side padding only (no cluster-group here)
    headerRow.style.columnGap = "6px";   // match unmapped-cols-row gap
    for (const { connectorId, entity } of sections) {
      const conn = systems.get(connectorId);
      const allRecs = conn?.snapshotFull()[entity] ?? [];
      const activeCount = allRecs.filter((r) => !r.softDeleted).length;
      const head = document.createElement("div");
      head.className = "cluster-col-head";
      const sysName = document.createElement("span");
      sysName.className = "system-name";
      sysName.textContent = connectorId;
      const entityBadge = document.createElement("span");
      entityBadge.className = "entity-badge";
      entityBadge.textContent = entity;
      const countBadge = document.createElement("span");
      countBadge.className = "count-badge";
      countBadge.textContent = String(activeCount);
      countBadge.title = `${activeCount} active record${activeCount === 1 ? "" : "s"}`;
      const newBtnHead = document.createElement("button");
      newBtnHead.className = "btn-card btn-new-inline";
      newBtnHead.textContent = "+ New";
      newBtnHead.title = `Add a new ${entity} to ${connectorId}`;
      newBtnHead.addEventListener("click", (e) => {
        e.stopPropagation();
        openNewRecordModal(
          `New  ${connectorId} / ${entity}`,
          '{\n  "data": {\n    \n  }\n}',
          (raw, explicitId) => {
              let parsed: { data?: Record<string, unknown> };
            try { parsed = JSON.parse(raw) as typeof parsed; }
            catch (err) { alert(`Invalid JSON:\n${String(err)}`); return; }
            const data = parsed.data ?? (parsed as Record<string, unknown>);
            callbacks.onSave(connectorId, entity, null, data as Record<string, unknown>, explicitId);
          },
        );
      });
      head.appendChild(sysName);
      head.appendChild(entityBadge);
      head.appendChild(countBadge);
      head.appendChild(newBtnHead);
      headerRow.appendChild(head);
    }
    view.appendChild(headerRow);

    // Scrollable body — one column per entity, cards stacked independently
    const body = document.createElement("div");
    body.className = "cluster-body";
    view.appendChild(body);

    const colsRow = document.createElement("div");
    colsRow.className = "unmapped-cols-row";
    colsRow.style.gridTemplateColumns = gridCols;
    body.appendChild(colsRow);

    for (const { connectorId, entity } of sections) {
      const conn = systems.get(connectorId);
      const records = conn?.snapshotFull()[entity] ?? [];

      const col = document.createElement("div");
      col.className = "unmapped-col";

      for (const r of records) {
        const wmKey = `${connectorId}/${entity}/${r.id}`;
        const prevWm = lastWatermarks.get(wmKey);
        const flash = !isFirst && (prevWm === undefined || r.watermark > prevWm);
        const isHl = highlightId !== undefined && r.id === highlightId;
        col.appendChild(buildCard(r, connectorId, entity, flash, isHl, callbacks, navigateToRecord, systems));
      }
      if (records.length === 0) {
        const empty = document.createElement("div");
        empty.className = "record-empty";
        empty.textContent = "— no records —";
        col.appendChild(empty);
      }

      colsRow.appendChild(col);
    }
  }

  function renderContent(
    channels: ChannelConfig[],
    systems: Map<string, InMemoryConnector>,
    clustersByChannel: Map<string, ChannelCluster[]>,
    isFirst: boolean,
  ): void {
    if (activeChannel === "__unmapped__") {
      renderUnmappedContent(channels, systems, isFirst);
      return;
    }
    if (activeChannel === "__lineage__") {
      // Only mount once per config — poll refreshes must not rebuild the diagram (that
      // would destroy interactive state), but a config change (Apply) must force a rebuild.
      // Spec: specs/playground.md § 11
      const channelsKey = channels.map((c) =>
        c.id + ":" +
        c.members.map((m) => {
          const inFields = m.inbound?.map((f) => `${f.source ?? f.target}>${f.target}`).join("+") ?? "*";
          const outFields = m.outbound?.map((f) => `${f.source ?? f.target}>${f.target}`).join("+") ?? "*";
          return `${m.connectorId}/${m.entity}[${inFields}|${outFields}]`;
        }).join(",")
      ).join("|");
      if (!channelArea.querySelector(".ld-map-host") || channelsKey !== lastChannelsKey) {
        lastChannelsKey = channelsKey;
        renderLineageContent(channels, systems);
      }
      return;
    }
    // Save scroll pos so the view doesn't jump on every poll refresh
    const savedScroll = channelArea.querySelector<HTMLElement>(".cluster-body")?.scrollTop ?? 0;
    channelArea.innerHTML = "";
    const ch = channels.find((c) => c.id === activeChannel);
    if (!ch) return;

    const members = ch.members;
    const n = members.length;
    // Display members sorted alphabetically by connectorId so columns appear in a
    // consistent order regardless of the engine's required ingest ordering.
    const displayOrder = ch.members
      .map((m, i) => ({ m, i }))
      .sort((a, b) => a.m.connectorId.localeCompare(b.m.connectorId));
    const gridCols = `repeat(${n}, 260px)`;

    // Pre-build record lookup: "connectorId/entity/externalId" → RecordWithMeta
    const recCache = new Map<string, RecordWithMeta>();
    for (const m of members) {
      const conn = systems.get(m.connectorId);
      if (!conn) continue;
      const full = conn.snapshotFull();

      if (m.arrayPath) {
        // Array-source member: synthesize one RecordWithMeta per array element from parent records.
        // The derived external ID is `${parentId}#${arrayPath}[${elementKeyValue}]`.
        const parentEntity = m.sourceEntity ?? m.entity;
        for (const parentRec of (full[parentEntity] ?? [])) {
          const arr = (parentRec.data as Record<string, unknown>)[m.arrayPath];
          if (!Array.isArray(arr)) continue;
          arr.forEach((el, idx) => {
            const elObj = (el !== null && typeof el === "object" && !Array.isArray(el))
              ? (el as Record<string, unknown>)
              : { _value: el };
            const keyVal = m.elementKey
              ? String((elObj as Record<string, unknown>)[m.elementKey] ?? idx)
              : String(idx);
            const syntheticId = `${parentRec.id}#${m.arrayPath}[${keyVal}]`;

            // Inject parentFields
            const data: Record<string, unknown> = { ...elObj };
            for (const [childKey, ref] of Object.entries(m.parentFields ?? {})) {
              const parentFieldName = typeof ref === "string" ? ref : (ref as { field: string }).field;
              data[childKey] = (parentRec.data as Record<string, unknown>)[parentFieldName];
            }

            recCache.set(`${m.connectorId}/${m.entity}/${syntheticId}`, {
              id: syntheticId,
              data,
              watermark: parentRec.watermark,
              modifiedAt: parentRec.modifiedAt,
              softDeleted: parentRec.softDeleted,
              associations: [],
            });
          });
        }
      } else {
        for (const r of (full[m.entity] ?? [])) {
          recCache.set(`${m.connectorId}/${m.entity}/${r.id}`, r);
        }
      }
    }

    const clusters = clustersByChannel.get(ch.id) ?? [];

    // ── Root ────────────────────────────────────────────────────────────
    const view = document.createElement("div");
    view.className = "cluster-view";
    channelArea.appendChild(view);

    // ── Header row ───────────────────────────────────────────────────────
    // Compute per-member active record counts for the counter badges.
    const memberCounts = new Map<string, number>(); // "connectorId/entity" → count
    for (const m of members) {
      let count = 0;
      for (const [key, r] of recCache) {
        if (key.startsWith(`${m.connectorId}/${m.entity}/`) && !r.softDeleted) count++;
      }
      memberCounts.set(`${m.connectorId}/${m.entity}`, count);
    }

    const headerRow = document.createElement("div");
    headerRow.className = "cluster-header-row";
    headerRow.style.gridTemplateColumns = gridCols;
    headerRow.style.padding = "0 11px";   // match cluster-body(6px) + cluster-group side-padding(5px)
    headerRow.style.columnGap = "6px";    // match cluster-cards-row gap
    for (const { m } of displayOrder) {
      const count = memberCounts.get(`${m.connectorId}/${m.entity}`) ?? 0;
      const head = document.createElement("div");
      head.className = "cluster-col-head";
      const sysName = document.createElement("span");
      sysName.className = "system-name";
      sysName.textContent = m.connectorId;
      const entityBadge = document.createElement("span");
      entityBadge.className = "entity-badge";
      entityBadge.textContent = m.entity;
      const countBadge = document.createElement("span");
      countBadge.className = "count-badge";
      countBadge.textContent = String(count);
      countBadge.title = `${count} active record${count === 1 ? "" : "s"}`;
      const newBtn = document.createElement("button");
      newBtn.className = "btn-card btn-new-inline";
      newBtn.textContent = "+ New";
      newBtn.title = `Add a new ${m.entity} to ${m.connectorId}`;
      newBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openNewRecordModal(
          `New  ${m.connectorId} / ${m.entity}`,
          '{\n  "data": {\n    \n  }\n}',
          (raw, explicitId) => {
              let parsed: { data?: Record<string, unknown> };
            try { parsed = JSON.parse(raw) as typeof parsed; }
            catch (err) { alert(`Invalid JSON:\n${String(err)}`); return; }
            const data = parsed.data ?? (parsed as Record<string, unknown>);
            callbacks.onSave(m.connectorId, m.entity, null, data as Record<string, unknown>, explicitId);
          },
        );
      });
      head.appendChild(sysName);
      head.appendChild(entityBadge);
      head.appendChild(countBadge);
      // Array-source members must be edited via their parent object — no inline create.
      if (!m.arrayPath) head.appendChild(newBtn);
      headerRow.appendChild(head);
    }
    view.appendChild(headerRow);

    // ── Scrollable cluster body ──────────────────────────────────────────
    const body = document.createElement("div");
    body.className = "cluster-body";
    body.scrollTop = savedScroll;  // restore immediately to prevent jump
    view.appendChild(body);

    if (clusters.length === 0) {
      const empty = document.createElement("div");
      empty.className = "record-empty";
      empty.textContent = "— no records —";
      body.appendChild(empty);
    }

    for (const cluster of clusters) {
      const group = document.createElement("div");
      group.className = "cluster-group";

      // Label floats on the top border
      const label = document.createElement("div");
      label.className = "cluster-label";
      label.textContent = cluster.canonicalId ? cluster.canonicalId.slice(0, 8) : "• unlinked";
      group.appendChild(label);

      const filledSlots = cluster.slots.filter((s) => s !== null).length;
      const isLinkedCluster = cluster.canonicalId !== null && filledSlots >= 2;

      // Split button — only for linked clusters with ≥2 non-null slots.
      if (isLinkedCluster) {
        const splitBtn = document.createElement("button");
        splitBtn.className = "btn-cluster-split";
        splitBtn.title = "Break up this cluster — each record gets its own identity";
        splitBtn.textContent = "✂";
        splitBtn.addEventListener("click", () => callbacks.onSplitCluster(cluster.canonicalId!));
        group.appendChild(splitBtn);
      }

      const cardsRow = document.createElement("div");
      cardsRow.className = "cluster-cards-row";
      cardsRow.style.gridTemplateColumns = gridCols;

      for (const { m, i } of displayOrder) {
        const slot = cluster.slots[i] ?? null;
        const cell = document.createElement("div");
        cell.className = "cluster-cell";

        if (slot) {
          // Render all external IDs stacked — linked clusters have one, unlinked may have many.
          for (const externalId of slot.externalIds) {
            const rec = recCache.get(`${slot.connectorId}/${slot.entity}/${externalId}`);
            if (rec) {
              const wmKey = `${slot.connectorId}/${slot.entity}/${rec.id}`;
              const prevWm = lastWatermarks.get(wmKey);
              // Flash whenever a record is newly appearing (no prior watermark) or was
              // updated since the last render.  The !isFirst guard is dropped: on the
              // delayed first render after boot debounce all cards are new and should flash.
              const flash = prevWm === undefined || (!isFirst && rec.watermark > prevWm);
              // Fix: store synthetic record watermarks so they don't flash on every tick.
              // updateWatermarks() only covers real connector entities; array sub-object
              // records are synthesized in recCache and never reach snapshotFull().
              lastWatermarks.set(wmKey, rec.watermark);
              const isHl = highlightId !== undefined && rec.id === highlightId;
              const embeddedIn = m.arrayPath
                ? `${m.sourceEntity ?? m.entity}.${m.arrayPath}`
                : undefined;
              // Parent link: extract parent ID from child external ID ("pu1#lines[L01]" → "pu1")
              const parentRef = m.arrayPath
                ? { entity: m.sourceEntity ?? m.entity, id: rec.id.split("#").slice(0, -1).join("#") }
                : undefined;
              cell.appendChild(buildCard(
                rec, slot.connectorId, slot.entity, flash, isHl,
                callbacks, navigateToRecord, systems,
                embeddedIn, parentRef,
                cluster.canonicalId ?? undefined,
                isLinkedCluster,
                noLinksForRecord(slot.connectorId, slot.entity, externalId),
              ));
            } else {
              const pend = document.createElement("div");
              pend.className = "cluster-cell-pending";
              pend.textContent = `${externalId.slice(0, 8)}… syncing`;
              cell.appendChild(pend);
            }
          }
        } else {
          const empty = document.createElement("div");
          empty.className = "cluster-cell-empty";
          cell.appendChild(empty);
        }

        cardsRow.appendChild(cell);
      }
      group.appendChild(cardsRow);
      body.appendChild(group);
    }
  }

  function renderTabs(channels: ChannelConfig[]): void {
    tabBar.innerHTML = "";
    for (const ch of channels) {
      const btn = document.createElement("button");
      btn.className = `channel-tab${ch.id === activeChannel ? " active" : ""}`;
      btn.textContent = ch.id;
      // Activity dot — shown on non-active tabs with unviewed changes.
      if (ch.id !== activeChannel && lastChangedChannels.has(ch.id)) {
        const dot = document.createElement("span");
        dot.className = "tab-activity-dot";
        dot.title = "This channel has new or updated records";
        btn.appendChild(dot);
      }
      btn.addEventListener("click", () => {
        if (activeChannel === ch.id) return;
        activeChannel = ch.id;
        lastChangedChannels.delete(ch.id); // clear dot when user views the channel
        renderTabs(cachedChannels);
        renderContent(cachedChannels, cachedSystems, cachedClusters, false);
        updateWatermarks(cachedSystems);
        callbacks.onTabChange?.(ch.id);
      });
      tabBar.appendChild(btn);
    }

    // Separator before the view pseudo-tabs
    const sep = document.createElement("span");
    sep.className = "channel-tab-sep";
    tabBar.appendChild(sep);

    // "unmapped" pseudo-tab
    const unmappedBtn = document.createElement("button");
    unmappedBtn.className = `channel-tab channel-tab-unmapped${activeChannel === "__unmapped__" ? " active" : ""}`;
    unmappedBtn.textContent = "unmapped";
    unmappedBtn.title = "Connector entities not covered by any channel";
    unmappedBtn.addEventListener("click", () => {
      if (activeChannel === "__unmapped__") return;
      activeChannel = "__unmapped__";
      renderTabs(cachedChannels);
      renderContent(cachedChannels, cachedSystems, cachedClusters, false);
      updateWatermarks(cachedSystems);
      callbacks.onTabChange?.("__unmapped__");
    });
    tabBar.appendChild(unmappedBtn);

    // "lineage" pseudo-tab — field lineage diagram
    const lineageBtn = document.createElement("button");
    lineageBtn.className = `channel-tab channel-tab-lineage${activeChannel === "__lineage__" ? " active" : ""}`;
    lineageBtn.textContent = "lineage";
    lineageBtn.title = "Field lineage diagram — shows how connector fields flow through the canonical model";
    lineageBtn.addEventListener("click", () => {
      if (activeChannel === "__lineage__") return;
      activeChannel = "__lineage__";
      renderTabs(cachedChannels);
      renderContent(cachedChannels, cachedSystems, cachedClusters, false);
      callbacks.onTabChange?.("__lineage__");
    });
    tabBar.appendChild(lineageBtn);
  }

  function renderLineageContent(channels: ChannelConfig[], systems: Map<string, InMemoryConnector>): void {
    channelArea.innerHTML = "";
    const container = document.createElement("div");
    container.className = "ld-map-host";
    channelArea.appendChild(container);
    // Build allEntities: connectorId → entity name → FieldPreview[] from getEntityDefs().
    // Spec: specs/playground.md § 11.14, § 11.15
    const allEntities = new Map<string, Map<string, FieldPreview[]>>();
    for (const [sysId, conn] of systems) {
      const entityMap = new Map<string, FieldPreview[]>();
      for (const entityDef of conn.getEntityDefs()) {
        const fields = Object.entries(entityDef.schema ?? {}).map(([name, desc]) => ({
          name,
          isFK: desc.entity !== undefined,
          description: desc.description,
          type: desc.entity
            ? `→ ${desc.entity}`
            : typeof desc.type === "string" ? desc.type : desc.type?.type,
          example: desc.example,
        } satisfies FieldPreview));
        entityMap.set(entityDef.name, fields);
      }
      allEntities.set(sysId, entityMap);
    }
    renderLineageDiagram(container, channels, allEntities);
  }

  function updateWatermarks(systems: Map<string, InMemoryConnector>): void {
    for (const [sysId, conn] of systems) {
      for (const [entity, records] of Object.entries(conn.snapshotFull())) {
        for (const r of records) {
          lastWatermarks.set(`${sysId}/${entity}/${r.id}`, r.watermark);
        }
      }
    }
  }

  function refresh(
    channels: ChannelConfig[],
    systems: Map<string, InMemoryConnector>,
    clustersByChannel: Map<string, ChannelCluster[]>,
    noLinks?: NoLinkEntry[],
  ): void {
    cachedChannels = channels;
    cachedSystems  = systems;
    cachedClusters = clustersByChannel;
    cachedNoLinks  = noLinks ?? [];

    if (activeChannel === null && channels.length > 0) {
      activeChannel = channels[0]!.id;
      callbacks.onTabChange?.(activeChannel);
    } else if (
      activeChannel !== "__unmapped__" &&
      activeChannel !== "__lineage__" &&
      activeChannel &&
      !channels.find((c) => c.id === activeChannel)
    ) {
      activeChannel = channels[0]?.id ?? null;
    }

    const isFirst = !hasRefreshed;
    hasRefreshed = true;

    // Compute activity dots for non-active tabs BEFORE updating watermarks so
    // we compare current state against what was seen in the previous render pass.
    if (!isFirst) {
      for (const ch of channels) {
        if (ch.id === activeChannel) continue;
        if (hasChannelActivity(ch, systems)) lastChangedChannels.add(ch.id);
      }
    }

    renderTabs(channels);
    renderContent(channels, systems, clustersByChannel, isFirst);
    updateWatermarks(systems);
  }

  return {
    refresh,
    /** Set the active tab without firing onTabChange (used for hash restore on load/popstate). */
    setActiveTab(tab: string): void {
      activeChannel = tab;
      renderTabs(cachedChannels);
      renderContent(cachedChannels, cachedSystems, cachedClusters, false);
    },
  };
}
