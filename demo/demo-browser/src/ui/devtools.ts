// Developer tools panel — tabbed panel at the bottom of the right pane.
// Tabs: Ticks (network-log style: list left, detail right) | identity_map | shadow_state
import type { SyncEvent, DbSnapshot } from "../engine-lifecycle.js";

interface TickGroup {
  id: number;
  phase: "onboard" | "poll";
  events: SyncEvent[];
  // DOM refs for live summary updates
  rowEl: HTMLElement;
  readCountEl: HTMLElement;
  insCountEl: HTMLElement;
  updCountEl: HTMLElement;
}

export function createDevTools(
  container: HTMLElement,
  getDbState: () => DbSnapshot,
): {
  appendEvent: (ev: SyncEvent) => void;
  beginTick: (phase: "onboard" | "poll") => void;
  clearEvents: () => void;
  refreshDbState: () => void;
} {
  container.innerHTML = "";

  // ── Tab bar ──────────────────────────────────────────────────────────────
  const tabBar = document.createElement("div");
  tabBar.className = "devtools-tab-bar";
  tabBar.innerHTML = `
    <button class="devtools-tab active" data-tab="ticks">Log</button>
    <button class="devtools-tab" data-tab="identity_map">identity_map</button>
    <button class="devtools-tab" data-tab="shadow_state">shadow_state</button>
  `;
  container.appendChild(tabBar);

  // ── Ticks panel ──────────────────────────────────────────────────────────
  const ticksPanel = document.createElement("div");
  ticksPanel.className = "devtools-panel devtools-panel-ticks devtools-panel-active";
  container.appendChild(ticksPanel);

  const ticksSplit = document.createElement("div");
  ticksSplit.className = "ticks-split";
  ticksPanel.appendChild(ticksSplit);

  // Left: tick list with clear toolbar
  const ticksLeft = document.createElement("div");
  ticksLeft.className = "ticks-left";
  ticksSplit.appendChild(ticksLeft);

  const ticksToolbar = document.createElement("div");
  ticksToolbar.className = "ticks-toolbar";
  const clearBtn = document.createElement("button");
  clearBtn.className = "btn-ghost ticks-clear-btn";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => clearEvents());
  ticksToolbar.appendChild(clearBtn);
  ticksLeft.appendChild(ticksToolbar);

  const ticksList = document.createElement("div");
  ticksList.className = "ticks-list";
  ticksLeft.appendChild(ticksList);

  // Right: event detail for selected tick
  const tickDetail = document.createElement("div");
  tickDetail.className = "tick-detail";
  ticksSplit.appendChild(tickDetail);

  // ── DB table panels ───────────────────────────────────────────────────────
  const identityPanel = document.createElement("div");
  identityPanel.className = "devtools-panel devtools-panel-db";
  container.appendChild(identityPanel);

  const shadowPanel = document.createElement("div");
  shadowPanel.className = "devtools-panel devtools-panel-db";
  container.appendChild(shadowPanel);

  const panels: Record<string, HTMLElement> = {
    ticks: ticksPanel,
    identity_map: identityPanel,
    shadow_state: shadowPanel,
  };

  // ── Tab switching ─────────────────────────────────────────────────────────
  let activeTab = "ticks";
  function showTab(tab: string): void {
    activeTab = tab;
    for (const btn of Array.from(tabBar.querySelectorAll<HTMLElement>(".devtools-tab"))) {
      btn.classList.toggle("active", btn.dataset["tab"] === tab);
    }
    for (const [key, panel] of Object.entries(panels)) {
      panel.classList.toggle("devtools-panel-active", key === tab);
    }
    if (tab === "identity_map") renderIdentityMap();
    if (tab === "shadow_state") renderShadowState();
  }

  tabBar.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".devtools-tab");
    if (btn?.dataset["tab"]) showTab(btn.dataset["tab"]);
  });

  // ── Ticks panel ──────────────────────────────────────────────────────────
  const ticks: TickGroup[] = [];
  let currentTick: TickGroup | null = null;
  let selectedTickId: number | null = null;
  let pollTickCount = 0;
  // Whether to auto-follow the latest tick — detaches when user scrolls up in tick list.
  let followLatest = true;

  ticksList.addEventListener("scroll", () => {
    const atBottom = ticksList.scrollHeight - ticksList.scrollTop - ticksList.clientHeight < 36;
    followLatest = atBottom;
  });

  function selectTick(tick: TickGroup, userInitiated = false): void {
    if (selectedTickId === tick.id && !userInitiated) return;
    if (selectedTickId !== null) {
      ticks.find((t) => t.id === selectedTickId)?.rowEl.classList.remove("tick-row-selected");
    }
    selectedTickId = tick.id;
    tick.rowEl.classList.add("tick-row-selected");
    renderTickDetail(tick);
    if (userInitiated) {
      // Re-enable follow-latest only when the user explicitly clicks the current tick.
      followLatest = (tick === ticks[ticks.length - 1]);
    }
  }

  function renderTickDetail(tick: TickGroup): void {
    tickDetail.innerHTML = "";
    if (tick.events.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tick-detail-empty";
      empty.textContent = "(no events)";
      tickDetail.appendChild(empty);
      return;
    }
    for (const ev of tick.events) {
      tickDetail.appendChild(buildEventItem(ev));
    }
  }

  // ── Event item (collapsible) ──────────────────────────────────────────────

  function buildEventItem(ev: SyncEvent): HTMLElement {
    const hasData = ev.data !== undefined || ev.after !== undefined || ev.before !== undefined;

    const wrapper = document.createElement("div");
    wrapper.className = "te-item";

    const row = document.createElement("div");
    row.className = "tick-event-row";
    if (hasData) {
      row.classList.add("te-expandable");
      row.setAttribute("role", "button");
      row.tabIndex = 0;
    }

    const opBadge = document.createElement("span");
    opBadge.className = `te-op te-op-${ev.action.toLowerCase()}`;
    opBadge.textContent = ev.action;
    row.appendChild(opBadge);

    // For dispatches show src→tgt; for READ show just the source connector
    if (ev.action !== "READ") {
      const connSpan = document.createElement("span");
      connSpan.className = "te-conn";
      connSpan.textContent = `${ev.sourceConnector} → ${ev.targetConnector}`;
      row.appendChild(connSpan);
    } else {
      const connSpan = document.createElement("span");
      connSpan.className = "te-conn";
      connSpan.textContent = ev.sourceConnector;
      row.appendChild(connSpan);
    }

    const entitySpan = document.createElement("span");
    entitySpan.className = "te-entity";
    entitySpan.textContent = ev.sourceEntity;
    row.appendChild(entitySpan);

    const idSpan = document.createElement("span");
    idSpan.className = "te-id";
    idSpan.textContent = ev.action === "READ"
      ? `${ev.sourceId}…`
      : `${ev.sourceId}… → ${ev.targetId}…`;
    row.appendChild(idSpan);

    if (hasData) {
      const chevron = document.createElement("span");
      chevron.className = "te-chevron";
      chevron.textContent = "▸";
      row.appendChild(chevron);
    }

    const tsSpan = document.createElement("span");
    tsSpan.className = "te-ts";
    tsSpan.textContent = ev.ts;
    row.appendChild(tsSpan);

    wrapper.appendChild(row);

    // ── Expandable detail panel ───────────────────────────────────────────
    if (hasData) {
      const detail = document.createElement("div");
      detail.className = "te-detail";

      if (ev.action === "READ" || ev.action === "INSERT") {
        const payload = ev.data ?? ev.after;
        if (ev.action === "READ" && payload) {
          if (ev.before !== undefined) {
            // READ with prior shadow state: show only changed fields as a diff table.
            const allKeys = new Set([...Object.keys(ev.before), ...Object.keys(payload)]);
            const changed = [...allKeys].filter((k) => {
              const a = JSON.stringify((ev.before ?? {})[k]);
              const b = JSON.stringify((payload as Record<string, unknown>)[k]);
              return a !== b;
            });
            if (changed.length === 0) {
              const note = document.createElement("div");
              note.className = "te-detail-note";
              note.textContent = "(no field changes)";
              detail.appendChild(note);
            } else {
              const table = document.createElement("table");
              table.className = "te-diff-table";
              for (const k of changed) {
                const oldVal = (ev.before ?? {})[k];
                const newVal = (payload as Record<string, unknown>)[k];
                const tr = document.createElement("tr");
                const tdKey = document.createElement("td"); tdKey.className = "te-diff-key"; tdKey.textContent = k;
                const tdOld = document.createElement("td"); tdOld.className = "te-diff-old";
                tdOld.textContent = oldVal === undefined ? "—" : typeof oldVal === "string" ? oldVal : JSON.stringify(oldVal);
                const tdArr = document.createElement("td"); tdArr.className = "te-diff-arrow"; tdArr.textContent = "→";
                const tdNew = document.createElement("td"); tdNew.className = "te-diff-new";
                tdNew.textContent = newVal === undefined ? "—" : typeof newVal === "string" ? newVal : JSON.stringify(newVal);
                tr.append(tdKey, tdOld, tdArr, tdNew);
                table.appendChild(tr);
              }
              detail.appendChild(table);
            }
          } else {
            // READ with no prior shadow state (initial boot read): show all fields in green.
            const table = document.createElement("table");
            table.className = "te-diff-table";
            for (const [k, v] of Object.entries(payload)) {
              const tr = document.createElement("tr");
              const tdKey = document.createElement("td"); tdKey.className = "te-diff-key"; tdKey.textContent = k;
              const tdVal = document.createElement("td"); tdVal.className = "te-diff-new";
              tdVal.textContent = typeof v === "string" ? v : JSON.stringify(v);
              tr.append(tdKey, tdVal);
              table.appendChild(tr);
            }
            detail.appendChild(table);
          }
        } else {
          // INSERT: full JSON payload
          const pre = document.createElement("pre");
          pre.className = "te-json";
          pre.textContent = JSON.stringify(payload, null, 2);
          detail.appendChild(pre);
        }
      } else if (ev.action === "UPDATE" && (ev.before !== undefined || ev.after !== undefined)) {
        const allKeys = new Set([
          ...Object.keys(ev.before ?? {}),
          ...Object.keys(ev.after ?? {}),
        ]);
        const changed = [...allKeys].filter((k) => {
          const a = JSON.stringify((ev.before ?? {})[k]);
          const b = JSON.stringify((ev.after ?? {})[k]);
          return a !== b;
        });
        if (changed.length === 0) {
          const note = document.createElement("div");
          note.className = "te-detail-note";
          note.textContent = "(no field changes)";
          detail.appendChild(note);
        } else {
          const table = document.createElement("table");
          table.className = "te-diff-table";
          for (const k of changed) {
            const oldVal = (ev.before ?? {})[k];
            const newVal = (ev.after ?? {})[k];
            const tr = document.createElement("tr");
            const tdKey = document.createElement("td"); tdKey.className = "te-diff-key"; tdKey.textContent = k;
            const tdOld = document.createElement("td"); tdOld.className = "te-diff-old";
            tdOld.textContent = oldVal === undefined ? "—" : typeof oldVal === "string" ? oldVal : JSON.stringify(oldVal);
            const tdArr = document.createElement("td"); tdArr.className = "te-diff-arrow"; tdArr.textContent = "→";
            const tdNew = document.createElement("td"); tdNew.className = "te-diff-new";
            tdNew.textContent = newVal === undefined ? "—" : typeof newVal === "string" ? newVal : JSON.stringify(newVal);
            tr.append(tdKey, tdOld, tdArr, tdNew);
            table.appendChild(tr);
          }
          detail.appendChild(table);
        }
      }

      wrapper.appendChild(detail);

      function toggle(): void {
        const open = wrapper.classList.toggle("te-item-open");
        const chev = row.querySelector<HTMLElement>(".te-chevron");
        if (chev) chev.textContent = open ? "▾" : "▸";
      }
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    }

    return wrapper;
  }

  // ── Tick summary badges ────────────────────────────────────────────────────

  function updateTickSummary(tick: TickGroup): void {
    const reads = tick.events.filter((e) => e.action === "READ").length;
    const ins   = tick.events.filter((e) => e.action === "INSERT").length;
    const upd   = tick.events.filter((e) => e.action === "UPDATE").length;
    tick.readCountEl.textContent = `${reads}r`;
    tick.readCountEl.style.display = reads > 0 ? "" : "none";
    tick.insCountEl.textContent = `${ins}+`;
    tick.insCountEl.style.display = ins > 0 ? "" : "none";
    tick.updCountEl.textContent = `${upd}~`;
    tick.updCountEl.style.display = upd > 0 ? "" : "none";
  }

  // ── beginTick / appendEvent ────────────────────────────────────────────────

  function beginTick(phase: "onboard" | "poll"): void {
    // Remove the previous tick if it ended up empty (noop — nothing interesting happened).
    if (currentTick !== null && currentTick.events.length === 0) {
      currentTick.rowEl.remove();
      ticks.pop();
      if (selectedTickId === currentTick.id) {
        selectedTickId = null;
        tickDetail.innerHTML = "";
      }
    }

    if (phase === "poll") pollTickCount++;
    const id = ticks.length;
    const label = phase === "onboard" ? "boot" : `tick #${pollTickCount}`;

    const rowEl = document.createElement("div");
    rowEl.className = `tick-row tick-row-${phase}`;

    const labelEl = document.createElement("span");
    labelEl.className = "tick-label";
    labelEl.textContent = label;
    rowEl.appendChild(labelEl);

    const countsEl = document.createElement("span");
    countsEl.className = "tick-counts";

    const readCountEl = document.createElement("span");
    readCountEl.className = "tick-count-read";
    readCountEl.style.display = "none";

    const insCountEl = document.createElement("span");
    insCountEl.className = "tick-count-ins";
    insCountEl.style.display = "none";

    const updCountEl = document.createElement("span");
    updCountEl.className = "tick-count-upd";
    updCountEl.style.display = "none";

    countsEl.append(readCountEl, insCountEl, updCountEl);
    rowEl.appendChild(countsEl);
    ticksList.appendChild(rowEl);

    const tick: TickGroup = { id, phase, events: [], rowEl, readCountEl, insCountEl, updCountEl };
    ticks.push(tick);
    currentTick = tick;

    if (followLatest) {
      selectTick(tick);
      ticksList.scrollTop = ticksList.scrollHeight;
    }

    rowEl.addEventListener("click", () => selectTick(tick, true));
  }

  function appendEvent(ev: SyncEvent): void {
    if (!currentTick) return;
    currentTick.events.push(ev);
    updateTickSummary(currentTick);
    // Live-append to the detail panel if this tick is currently selected
    if (selectedTickId === currentTick.id) {
      const firstChild = tickDetail.firstChild as HTMLElement | null;
      if (firstChild?.className === "tick-detail-empty") tickDetail.innerHTML = "";
      const wasAtBottom = tickDetail.scrollHeight - tickDetail.scrollTop - tickDetail.clientHeight < 36;
      tickDetail.appendChild(buildEventItem(ev));
      if (wasAtBottom) tickDetail.scrollTop = tickDetail.scrollHeight;
    }
  }

  function clearEvents(): void {
    ticks.length = 0;
    currentTick = null;
    selectedTickId = null;
    pollTickCount = 0;
    followLatest = true;
    ticksList.innerHTML = "";
    tickDetail.innerHTML = "";
  }

  // ── DB table rendering ────────────────────────────────────────────────────
  function renderTable<T extends Record<string, unknown>>(
    panel: HTMLElement,
    rows: T[],
  ): void {
    panel.innerHTML = "";
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "db-table-empty";
      empty.textContent = "(empty)";
      panel.appendChild(empty);
      return;
    }

    const cols = Object.keys(rows[0]!);
    const table = document.createElement("table");
    table.className = "db-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const col of cols) {
      const th = document.createElement("th");
      th.textContent = col;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (const col of cols) {
        const td = document.createElement("td");
        const val = row[col];
        td.textContent = val === null || val === undefined ? "—" : String(val);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    panel.appendChild(table);
  }

  function renderIdentityMap(): void {
    renderTable(identityPanel, getDbState().identityMap);
  }

  function renderShadowState(): void {
    renderTable(shadowPanel, getDbState().shadowState);
  }

  function refreshDbState(): void {
    if (activeTab === "identity_map") renderIdentityMap();
    else if (activeTab === "shadow_state") renderShadowState();
  }

  return { appendEvent, beginTick, clearEvents, refreshDbState };
}

