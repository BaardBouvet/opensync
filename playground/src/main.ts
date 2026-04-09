// Browser demo entry point.
// Bootstraps the engine, builds the UI, and manages the scenario lifecycle.
import { scenarios, defaultScenarioKey } from "./scenarios/index.js";
import type { ScenarioDefinition } from "./scenarios/index.js";
import { startEngine } from "./engine-lifecycle.js";
import type { EngineState, ChannelCluster } from "./engine-lifecycle.js";
import { buildChannelsFromEntries, MappingsFileSchema } from "@opensync/engine";
import type { ChannelConfig } from "@opensync/engine";
import { parse as parseYaml } from "yaml";
import { buildEditorPane } from "./ui/editor-pane.js";
import { createSystemsPane } from "./ui/systems-pane.js";
import { createDevTools } from "./ui/devtools.js";

// ─── Constants ──────────────────────────────────────────────────────────────────

// Background interval: how long between polls when no mutation has occurred.
const POLL_MS = 5_000;
// Notification delay: how long after a mutation before the engine is notified.
// Simulates a webhook arriving shortly after a write, making the two-phase
// effect (local flash → propagation flash) visible to the user.
const NOTIFY_MS = 800;
// Delay before the first cross-system sync after boot. Set to 0 for instant
// fanout; raise (e.g. 5_000) to let the user observe the seed-only state first.
const BOOT_NOTIFY_MS = 0;

// GitHub repo used for update checks. Spec: specs/playground.md § 2.5
const GITHUB_REPO = "BaardBouvet/opensync";

// ─── URL hash helpers ─────────────────────────────────────────────────────────
// Spec: specs/playground.md § 12

interface PlaygroundHash { scenario: string | null; tab: string | null; }

function parseHash(): PlaygroundHash {
  const raw = location.hash.slice(1);
  const params = new URLSearchParams(raw);
  return { scenario: params.get("scenario"), tab: params.get("tab") };
}

function buildHash(scenario: string, tab: string | null): string {
  const params = new URLSearchParams({ scenario });
  if (tab) params.set("tab", tab);
  return "#" + params.toString();
}

/** Parse semver strings and return true when `latest` is strictly newer than `current`. */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, "").split(".").map(Number);
  const [la = 0, lb = 0, lc = 0] = parse(latest);
  const [ca = 0, cb = 0, cc = 0] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

let engineState: EngineState | null = null;
let statusEl: HTMLElement;
let editorPane: ReturnType<typeof buildEditorPane> | null = null;
let isDirty = false;
// Debounce timer for notification polls (fired after each mutation in auto mode).
let notifyTimer: ReturnType<typeof setTimeout> | undefined;

function setStatus(text: string, running: boolean): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = running ? "status running" : "status loading";
}

function buildClusters() {
  if (!engineState) return new Map<string, ChannelCluster[]>();
  return new Map(
    engineState.channels.map((ch) => [ch.id, engineState!.getClusters(ch.id)]),
  );
}

async function boot(scenario: ScenarioDefinition): Promise<void> {
  // Cancel any pending notification poll from the previous engine before stopping it.
  clearTimeout(notifyTimer);
  notifyTimer = undefined;
  resetCountdownBar();

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
        systemsPane?.refresh(engineState!.channels, engineState!.connectors, buildClusters());
        editorPane?.update(engineState!.scenario);
        devTools?.refreshDbState();
        // After each poll, if auto-mode is on and no notification is pending,
        // restart the countdown bar for the next background interval tick.
        // Spec: specs/playground.md § 10
        if (engineState?.isRealtime && !notifyTimer) {
          startCountdownBar(POLL_MS);
        }
      },
      POLL_MS,
      (phase) => {
        devTools?.beginTick(phase);
        // Flash the countdown bar when a poll tick actually starts.
        // Spec: specs/playground.md § 10
        if (phase === "poll" && engineState?.isRealtime) flashCountdownBar();
      },
      // onAfterSeed: render seed-only state before onboarding fanout writes.
      // The systems pane records the watermarks for those seed records; when the
      // 800ms schedulePoll fires the fanout records (prevWm === undefined) flash in.
      // Spec: specs/playground.md § 10
      (seedConnectors, preClusters) => {
        // Parse channels from scenario YAML for the pre-onboard render (engineState not yet available).
        const parsed = MappingsFileSchema.parse(parseYaml(scenario.yaml));
        const bootChannels: ChannelConfig[] = buildChannelsFromEntries(parsed.channels ?? [], parsed.mappings ?? []);
        const seedClusterMap = new Map(
          bootChannels.map((ch) => [ch.id, preClusters(ch.id)]),
        );
        systemsPane?.refresh(bootChannels, seedConnectors, seedClusterMap);
      },
    );
  } catch (err) {
    setStatus(`error: ${String(err)}`, false);
    console.error(err);
    return;
  }

  setStatus("● running", true);
  editorPane?.update(engineState.scenario);
  // Sync new engine state with the realtime toggle
  const rt = document.getElementById("toggle-realtime") as HTMLInputElement | null;
  if (rt) {
    if (!rt.checked) engineState.pause();
    const syncBtnEl = document.getElementById("btn-sync") as HTMLButtonElement | null;
    if (syncBtnEl) { syncBtnEl.disabled = rt.checked; }
  }
  // Boot debounce (auto mode only): onAfterSeed already rendered seed records.
  // Schedule the 800ms notification poll so fanout-inserted records flash in.
  // When auto is off show everything immediately — no countdown anyway.
  // Spec: specs/playground.md § 10
  const autoOn = rt?.checked !== false;
  setCountdownBarVisible(autoOn);
  if (autoOn) {
    schedulePoll(BOOT_NOTIFY_MS);
  } else {
    systemsPane?.refresh(engineState.channels, engineState.connectors, buildClusters());
  }
}

// ─── DOM setup ────────────────────────────────────────────────────────────────

let systemsPane: ReturnType<typeof createSystemsPane> | null = null;
let devTools: ReturnType<typeof createDevTools> | null = null;

document.addEventListener("DOMContentLoaded", () => {
  statusEl = document.getElementById("status")!;
  // ── Version badge (Spec: specs/playground.md § 2.5) ──────────────────────────────
  const versionEl = document.getElementById("app-version");
  if (versionEl) versionEl.textContent = `v${__APP_VERSION__}`;

  // ── Update check (fire-and-forget, Spec: specs/playground.md § 2.5) ───────────
  fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`)
    .then((r) => r.json())
    .then((data: unknown) => {
      const d = data as { tag_name?: string; html_url?: string };
      if (!d.tag_name || !d.html_url) return;
      if (!isNewerVersion(d.tag_name, __APP_VERSION__)) return;
      const dismissedKey = `opensync-update-dismissed-${d.tag_name}`;
      if (sessionStorage.getItem(dismissedKey)) return;
      const notif = document.getElementById("update-notification") as HTMLAnchorElement | null;
      const textEl = document.getElementById("update-notification-text");
      if (!notif || !textEl) return;
      textEl.textContent = `${d.tag_name} available`;
      notif.href = d.html_url;
      notif.removeAttribute("hidden");
      document.getElementById("dismiss-update")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        sessionStorage.setItem(dismissedKey, "1");
        notif.setAttribute("hidden", "");
      });
    })
    .catch(() => { /* network errors are silently ignored */ });
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
    // Spec: specs/playground.md § 12.2 — scenario switch pushes a history entry
    history.pushState(null, "", buildHash(dropdown.value, null));
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

  const pollHint = document.getElementById("poll-hint") as HTMLElement;
  pollHint.textContent = `${POLL_MS / 1000}s`;

  realtimeToggle.addEventListener("change", () => {
    if (!engineState) return;
    if (realtimeToggle.checked) {
      engineState.resume();
      setCountdownBarVisible(true);
      schedulePoll(); // start boot-debounce countdown when re-enabling auto
    } else {
      engineState.pause();
      clearTimeout(notifyTimer);
      notifyTimer = undefined;
      resetCountdownBar();
      setCountdownBarVisible(false);
    }
    updatePollControls();
    pollHint.style.opacity = realtimeToggle.checked ? "1" : "0.35";
  });

  syncBtn.addEventListener("click", () => {
    if (!engineState || engineState.isRealtime) return;
    void triggerPoll();
  });

  // ── Systems pane ──────────────────────────────────────────────────────────
  const systemsContainer = document.getElementById("systems-container")!;
  systemsPane = createSystemsPane(systemsContainer, {
    onSave(systemId, entity, id, data, explicitId) {
      if (!engineState) return;
      const conn = engineState.connectors.get(systemId);
      if (!conn) return;
      isDirty = true;
      if (id === null) {
        conn.insertRecord(entity, data, explicitId);
      } else {
        conn.updateRecord(entity, id, data);
      }
      // In manual mode, only refresh the UI — do NOT run the engine.
      // The user explicitly controls when the engine runs via the Sync button.
      if (engineState.isRealtime) schedulePoll();
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
      if (engineState?.isRealtime) schedulePoll();
      else refreshUI();
    },
    onSplitCluster(canonicalId) {
      if (!engineState) return;
      isDirty = true;
      engineState.splitCluster(canonicalId);
      refreshUI();
      devTools?.refreshDbState();
    },
    // Spec: specs/playground.md § 12.2 — tab switches replace the history entry
    onTabChange(tab: string) {
      history.replaceState(null, "", buildHash(dropdown.value, tab));
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
      // Spec: specs/playground.md § 12.2 — config reload replaces (same scenario, different config)
      history.replaceState(null, "", buildHash(dropdown.value, null));
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

  // ── Initial load from URL hash (Spec: specs/playground.md § 12.3) ──────────────
  const initHash = parseHash();
  const initScenarioKey = (initHash.scenario && scenarios[initHash.scenario])
    ? initHash.scenario
    : defaultScenarioKey;
  if (initScenarioKey !== defaultScenarioKey) {
    for (const opt of Array.from(dropdown.options)) opt.selected = opt.value === initScenarioKey;
  }
  const initScenario = scenarios[initScenarioKey]!;

  void boot(initScenario).then(() => {
    if (initHash.tab) systemsPane?.setActiveTab(initHash.tab);
    // Normalise the URL without adding a history entry (hash may be absent or partial)
    history.replaceState(null, "", buildHash(initScenarioKey, initHash.tab));
  });

  // ── popstate (back/forward navigation) ─────────────────────────
  // Spec: specs/playground.md § 12.4
  window.addEventListener("popstate", () => {
    const h = parseHash();
    const key = (h.scenario && scenarios[h.scenario]) ? h.scenario : defaultScenarioKey;
    const prevKey = dropdown.value;
    for (const opt of Array.from(dropdown.options)) opt.selected = opt.value === key;
    if (isDirty && !confirm("You have unsaved changes that will be lost. Navigate away?")) {
      for (const opt of Array.from(dropdown.options)) opt.selected = opt.value === prevKey;
      history.pushState(null, "", buildHash(prevKey, null));
      return;
    }
    void boot(scenarios[key]!).then(() => {
      if (h.tab) systemsPane?.setActiveTab(h.tab);
    });
  });
});

// ─── UI refresh (no engine ingest) ───────────────────────────────────────────

function refreshUI(): void {
  if (!engineState) return;
  systemsPane?.refresh(engineState.channels, engineState.connectors, buildClusters());
  devTools?.refreshDbState();
}

// ─── Notification poll (debounced mutation trigger) ───────────────────────────
// Spec: specs/playground.md § 10

/** Schedule one poll after the most recent mutation; debounces rapid edits.
 *  Pass a custom delayMs to override NOTIFY_MS (e.g. BOOT_NOTIFY_MS on first boot). */
function schedulePoll(delayMs = NOTIFY_MS): void {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined;
    void triggerPoll();
  }, delayMs);
  startCountdownBar(delayMs);
}

// ─── Countdown bar helpers ────────────────────────────────────────────────────
// Spec: specs/playground.md § 10

function startCountdownBar(durationMs: number): void {
  const fill = document.getElementById("poll-countdown-fill") as HTMLDivElement | null;
  if (!fill) return;
  // Do NOT remove poll-blink here: opacity (blink) and width (depletion) are independent
  // CSS properties. The blink plays itself out while the depletion starts simultaneously.
  // Snap to full width (disable transition), then re-enable and animate to 0.
  fill.style.transition = "none";
  fill.style.width = "100%";
  fill.getBoundingClientRect(); // force reflow so the browser registers 100% first
  fill.style.transition = `width ${durationMs}ms linear`;
  fill.style.width = "0%";
}

function resetCountdownBar(): void {
  const fill = document.getElementById("poll-countdown-fill") as HTMLDivElement | null;
  if (!fill) return;
  fill.classList.remove("poll-blink");
  fill.style.transition = "none";
  fill.style.width = "0%";
}

function flashCountdownBar(): void {
  const fill = document.getElementById("poll-countdown-fill") as HTMLDivElement | null;
  if (!fill) return;
  // Snap to full width and play a single forward flash to signal the poll is running.
  // animationend auto-removes the class so subsequent startCountdownBar() starts clean.
  fill.classList.remove("poll-blink");
  fill.style.transition = "none";
  fill.style.width = "100%";
  fill.getBoundingClientRect(); // reflow
  fill.classList.add("poll-blink");
  fill.addEventListener("animationend", () => fill.classList.remove("poll-blink"), { once: true });
}

function setCountdownBarVisible(visible: boolean): void {
  const bar = document.getElementById("poll-countdown") as HTMLElement | null;
  if (bar) bar.style.visibility = visible ? "visible" : "hidden";
}

// ─── Manual poll trigger ──────────────────────────────────────────────────────

async function triggerPoll(): Promise<void> {
  if (!engineState) return;
  await engineState.pollOnce();
}
