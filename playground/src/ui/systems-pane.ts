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
import type { Association } from "@opensync/sdk";
import type { InMemoryConnector, RecordWithMeta } from "../inmemory.js";
import type { ChannelCluster } from "../engine-lifecycle.js";
import type { ChannelConfig } from "@opensync/engine";
import { renderLineageDiagram } from "./lineage-diagram.js";

// ─── Public types ──────────────────────────────────────────────────────────────

export interface SystemsPaneCallbacks {
  /** id === null for new records. associations is undefined when not changed. explicitId is set when user provided a custom ID in the new-record dialog. */
  onSave: (systemId: string, entity: string, id: string | null, data: Record<string, unknown>, associations?: Association[], explicitId?: string) => void;
  onSoftDelete: (systemId: string, entity: string, id: string) => void;
  onRestore:    (systemId: string, entity: string, id: string) => void;
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
      <button class="btn-ghost dialog-cancel">Cancel</button>
      <button class="btn-save dialog-save">Save</button>
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
          ...defaultKeymap,
          { key: "Ctrl-Enter", run: () => { modalSaveHandler?.(); modalEl?.close(); return true; } },
          { key: "Mod-Enter",  run: () => { modalSaveHandler?.(); modalEl?.close(); return true; } },
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
    const tr = document.createElement("tr");
    const tdK = document.createElement("td"); tdK.className = "field-key"; tdK.textContent = key;
    const tdV = document.createElement("td"); tdV.className = "field-val";
    tdV.textContent = typeof value === "string" ? value : JSON.stringify(value);
    tr.appendChild(tdK); tr.appendChild(tdV);
    table.appendChild(tr);
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

  // Footer
  const footer = document.createElement("div");
  footer.className = "card-footer";

  const modTime = document.createElement("span");
  modTime.className = "record-modified";
  modTime.textContent = rec.modifiedAt ? `mod ${fmtTime(rec.modifiedAt)}` : "";
  footer.appendChild(modTime);

  const actions = document.createElement("div");
  actions.className = "card-actions";

  if (!rec.softDeleted) {
    const editBtn = document.createElement("button");
    editBtn.className = "btn-card";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      const combined = { data: rec.data, associations: rec.associations ?? [] };
      openModal(
        `Edit  ${systemId} / ${entity} / ${rec.id}`,
        JSON.stringify(combined, null, 2),
        (raw) => {
          let parsed: { data?: Record<string, unknown>; associations?: Association[] };
          try { parsed = JSON.parse(raw) as typeof parsed; }
          catch (e) { alert(`Invalid JSON:\n${String(e)}`); return; }
          const data = parsed.data ?? (parsed as Record<string, unknown>);
          callbacks.onSave(systemId, entity, rec.id, data as Record<string, unknown>, parsed.associations);
        },
      );
    });
    actions.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "btn-card btn-delete";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      if (confirm(`Delete record "${rec.id}" from ${systemId}/${entity}?`)) {
        callbacks.onSoftDelete(systemId, entity, rec.id);
      }
    });
    actions.appendChild(delBtn);
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
  ) => void;
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

  let cachedChannels: ChannelConfig[] = [];
  let cachedSystems: Map<string, InMemoryConnector> = new Map();
  let cachedClusters: Map<string, ChannelCluster[]> = new Map();

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
          '{\n  "data": {\n    \n  },\n  "associations": []\n}',
          (raw, explicitId) => {
            let parsed: { data?: Record<string, unknown>; associations?: Association[] };
            try { parsed = JSON.parse(raw) as typeof parsed; }
            catch (err) { alert(`Invalid JSON:\n${String(err)}`); return; }
            const data = parsed.data ?? (parsed as Record<string, unknown>);
            callbacks.onSave(connectorId, entity, null, data as Record<string, unknown>, parsed.associations, explicitId);
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
      // Only mount once — poll refreshes must not rebuild the diagram (that would destroy state)
      if (!channelArea.querySelector(".ld-map-host")) {
        renderLineageContent(channels);
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
    const gridCols = `repeat(${n}, 260px)`;

    // Pre-build record lookup: "connectorId/entity/externalId" → RecordWithMeta
    const recCache = new Map<string, RecordWithMeta>();
    for (const m of members) {
      const conn = systems.get(m.connectorId);
      if (!conn) continue;
      const full = conn.snapshotFull();
      for (const r of (full[m.entity] ?? [])) {
        recCache.set(`${m.connectorId}/${m.entity}/${r.id}`, r);
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
    for (const m of members) {
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
          '{\n  "data": {\n    \n  },\n  "associations": []\n}',
          (raw, explicitId) => {
            let parsed: { data?: Record<string, unknown>; associations?: Association[] };
            try { parsed = JSON.parse(raw) as typeof parsed; }
            catch (err) { alert(`Invalid JSON:\n${String(err)}`); return; }
            const data = parsed.data ?? (parsed as Record<string, unknown>);
            callbacks.onSave(m.connectorId, m.entity, null, data as Record<string, unknown>, parsed.associations, explicitId);
          },
        );
      });
      head.appendChild(sysName);
      head.appendChild(entityBadge);
      head.appendChild(countBadge);
      head.appendChild(newBtn);
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

      const cardsRow = document.createElement("div");
      cardsRow.className = "cluster-cards-row";
      cardsRow.style.gridTemplateColumns = gridCols;

      for (let i = 0; i < members.length; i++) {
        const m = members[i]!;
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
              const flash = !isFirst && (prevWm === undefined || rec.watermark > prevWm);
              const isHl = highlightId !== undefined && rec.id === highlightId;
              cell.appendChild(buildCard(rec, slot.connectorId, slot.entity, flash, isHl, callbacks, navigateToRecord, systems));
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
      btn.addEventListener("click", () => {
        if (activeChannel === ch.id) return;
        activeChannel = ch.id;
        renderTabs(cachedChannels);
        renderContent(cachedChannels, cachedSystems, cachedClusters, false);
        updateWatermarks(cachedSystems);
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
    });
    tabBar.appendChild(lineageBtn);
  }

  function renderLineageContent(channels: ChannelConfig[]): void {
    channelArea.innerHTML = "";
    const container = document.createElement("div");
    container.className = "ld-map-host";
    channelArea.appendChild(container);
    renderLineageDiagram(container, channels);
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
  ): void {
    cachedChannels = channels;
    cachedSystems  = systems;
    cachedClusters = clustersByChannel;

    if (activeChannel === null && channels.length > 0) {
      activeChannel = channels[0]!.id;
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

    renderTabs(channels);
    renderContent(channels, systems, clustersByChannel, isFirst);
    updateWatermarks(systems);
  }

  return { refresh };
}
