// Browser demo entry point.
// Bootstraps the engine, builds the UI, and manages the scenario lifecycle.
import { scenarios, defaultScenarioKey } from "./scenarios/index.js";
import type { ScenarioDefinition } from "./scenarios/index.js";
import { startEngine } from "./engine-lifecycle.js";
import type { EngineState } from "./engine-lifecycle.js";
import { buildEditorPane } from "./ui/editor-pane.js";
import { createSystemsPane } from "./ui/systems-pane.js";
import { createDevTools } from "./ui/devtools.js";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

let engineState: EngineState | null = null;
let statusEl: HTMLElement;
let editorPane: ReturnType<typeof buildEditorPane> | null = null;
let isDirty = false;

function setStatus(text: string, running: boolean): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = running ? "status running" : "status loading";
}

function buildClusters() {
  if (!engineState) return new Map();
  return new Map(
    engineState.scenario.channels.map((ch) => [ch.id, engineState!.getClusters(ch.id)]),
  );
}

async function boot(scenario: ScenarioDefinition): Promise<void> {
  if (engineState) {
    engineState.stop();
    engineState = null;
  }
  isDirty = false;

  setStatus("starting…", false);

  try {
    engineState = await startEngine(
      scenario,
      (ev) => devTools?.appendEvent(ev),
      () => {
        systemsPane?.refresh(engineState!.scenario.channels, engineState!.connectors, buildClusters());
        editorPane?.update(engineState!.scenario);
        devTools?.refreshDbState();
      },
      2_000,
      (phase) => devTools?.beginTick(phase),
    );
  } catch (err) {
    setStatus(`error: ${String(err)}`, false);
    console.error(err);
    return;
  }

  setStatus("● running", true);
  systemsPane?.refresh(engineState.scenario.channels, engineState.connectors, buildClusters());
  editorPane?.update(engineState.scenario);
  // Sync new engine state with the realtime toggle
  const rt = document.getElementById("toggle-realtime") as HTMLInputElement | null;
  if (rt) {
    if (!rt.checked) engineState.pause();
    const syncBtnEl = document.getElementById("btn-sync") as HTMLButtonElement | null;
    if (syncBtnEl) { syncBtnEl.disabled = rt.checked; }
  }
}

// ─── DOM setup ────────────────────────────────────────────────────────────────

let systemsPane: ReturnType<typeof createSystemsPane> | null = null;
let devTools: ReturnType<typeof createDevTools> | null = null;

document.addEventListener("DOMContentLoaded", () => {
  statusEl = document.getElementById("status")!;

  // ── Scenario dropdown ────────────────────────────────────────────────────
  const dropdown = document.getElementById("scenario-select") as HTMLSelectElement;
  for (const key of Object.keys(scenarios)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = key;
    if (key === defaultScenarioKey) opt.selected = true;
    dropdown.appendChild(opt);
  }
  dropdown.addEventListener("change", () => {
    const s = scenarios[dropdown.value];
    if (!s) return;
    if (isDirty && !confirm("You have unsaved changes that will be lost. Switch scenario?")) {
      dropdown.value = engineState?.scenario.label ?? defaultScenarioKey;
      // Re-select the current scenario key in the dropdown
      for (const opt of Array.from(dropdown.options)) {
        opt.selected = scenarios[opt.value] === engineState?.scenario;
      }
      return;
    }
    void boot(s);
  });

  // ── Reset button ─────────────────────────────────────────────────────────
  document.getElementById("btn-reset")?.addEventListener("click", () => {
    const s = scenarios[dropdown.value];
    if (!s) return;
    if (isDirty && !confirm("Reset will discard all changes. Continue?")) return;
    void boot(s);
  });

  // ── Real-time toggle + manual sync button ─────────────────────────────────
  const syncBtn = document.getElementById("btn-sync") as HTMLButtonElement;
  const realtimeToggle = document.getElementById("toggle-realtime") as HTMLInputElement;

  function updatePollControls(): void {
    const rt = engineState?.isRealtime ?? true;
    syncBtn.disabled = rt;
    syncBtn.title = rt ? "Disable auto-sync to use manual sync" : "Run one poll cycle now";
  }

  realtimeToggle.addEventListener("change", () => {
    if (!engineState) return;
    if (realtimeToggle.checked) { engineState.resume(); } else { engineState.pause(); }
    updatePollControls();
  });

  syncBtn.addEventListener("click", () => {
    if (!engineState || engineState.isRealtime) return;
    void triggerPoll();
  });

  // ── Systems pane ──────────────────────────────────────────────────────────
  const systemsContainer = document.getElementById("systems-container")!;
  systemsPane = createSystemsPane(systemsContainer, {
    onSave(systemId, entity, id, data, associations, explicitId) {
      if (!engineState) return;
      const conn = engineState.connectors.get(systemId);
      if (!conn) return;
      isDirty = true;
      if (id === null) {
        conn.insertRecord(entity, data, associations, explicitId);
      } else {
        conn.updateRecord(entity, id, data, associations);
      }
      // In manual mode, only refresh the UI — do NOT run the engine.
      // The user explicitly controls when the engine runs via the Sync button.
      if (engineState.isRealtime) void triggerPoll();
      else refreshUI();
    },
    onSoftDelete(systemId, entity, id) {
      isDirty = true;
      engineState?.connectors.get(systemId)?.softDeleteRecord(entity, id);
      refreshUI();
    },
    onRestore(systemId, entity, id) {
      isDirty = true;
      engineState?.connectors.get(systemId)?.restoreRecord(entity, id);
      // Same as onSave: only propagate via engine when in real-time mode.
      if (engineState?.isRealtime) void triggerPoll();
      else refreshUI();
    },
  });

  // ── Dev tools ─────────────────────────────────────────────────────────────
  const devtoolsContainer = document.getElementById("devtools-container")!;
  devTools = createDevTools(
    devtoolsContainer,
    () => engineState!.getDbState(),
  );

  // ── Editor pane ──────────────────────────────────────────────────────────
  const editorContainer = document.getElementById("editor-container")!;
  const currentScenario = scenarios[defaultScenarioKey]!;

  editorPane = buildEditorPane({
    container: editorContainer,
    scenario: currentScenario,
    onConfigReload: async (newScenario: ScenarioDefinition) => {
      if (isDirty && !confirm("Reloading config will discard all record changes. Continue?")) return;
      await boot(newScenario);
    },
  });

  // ── Resize handles ────────────────────────────────────────────────────────
  // Horizontal: drag #resize-handle to resize the config editor pane
  const editorPaneEl = document.getElementById("editor-pane")!;
  const hResizeHandle = document.getElementById("resize-handle")!;
  hResizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    hResizeHandle.classList.add("dragging");
    const startX = e.clientX;
    const startW = editorPaneEl.getBoundingClientRect().width;
    function onMove(ev: MouseEvent) {
      const w = Math.max(180, Math.min(600, startW + (ev.clientX - startX)));
      editorPaneEl.style.width = `${w}px`;
    }
    function onUp() {
      hResizeHandle.classList.remove("dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  // Vertical: drag #devtools-resize-handle to resize the devtools panel
  const devtoolsEl = document.getElementById("devtools-container")!;
  const vResizeHandle = document.getElementById("devtools-resize-handle")!;
  vResizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    vResizeHandle.classList.add("dragging");
    const startY = e.clientY;
    const startH = devtoolsEl.getBoundingClientRect().height;
    function onMove(ev: MouseEvent) {
      // Dragging up increases height
      const h = Math.max(60, Math.min(500, startH + (startY - ev.clientY)));
      devtoolsEl.style.height = `${h}px`;
    }
    function onUp() {
      vResizeHandle.classList.remove("dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  void boot(currentScenario);
});

// ─── UI refresh (no engine ingest) ───────────────────────────────────────────

function refreshUI(): void {
  if (!engineState) return;
  systemsPane?.refresh(engineState.scenario.channels, engineState.connectors, buildClusters());
  devTools?.refreshDbState();
}

// ─── Manual poll trigger ──────────────────────────────────────────────────────

async function triggerPoll(): Promise<void> {
  if (!engineState) return;
  await engineState.pollOnce();
}
