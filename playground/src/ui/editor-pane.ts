// Editor pane — left side, config-only CodeMirror YAML editor.
// The config editor shows the scenario's canonical YAML (channels: + mappings: + conflict:).
// Saving triggers a full engine reload.
// Spec: specs/playground.md §3.4
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import { defaultKeymap } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { parse as parseYaml } from "yaml";
import { MappingsFileSchema, buildChannelsFromEntries } from "@opensync/engine";
import type { ChannelConfig, ConflictConfig } from "@opensync/engine";
import type { ScenarioDefinition } from "../scenarios/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EditorPaneOptions {
  container: HTMLElement;
  scenario: ScenarioDefinition;
  onConfigReload: (newScenario: ScenarioDefinition) => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a raw YAML string into channels + conflict ready for engine boot.
 *  Throws on invalid YAML or schema violations — caller should catch and display.
 *  Spec: specs/playground.md §3.4 */
function parseScenarioYaml(raw: string): { channels: ChannelConfig[]; conflict: ConflictConfig } {
  const parsed = MappingsFileSchema.parse(parseYaml(raw));
  const channels = buildChannelsFromEntries(parsed.channels ?? [], parsed.mappings ?? []);
  const conflict: ConflictConfig = parsed.conflict ?? {};
  return { channels, conflict };
}


// ─── Public API ───────────────────────────────────────────────────────────────

export function buildEditorPane(opts: EditorPaneOptions): {
  update: (scenario: ScenarioDefinition) => void;
} {
  const { container, onConfigReload } = opts;
  let currentScenario = opts.scenario;
  let view: EditorView | null = null;

  function build(scenario: ScenarioDefinition): void {
    container.innerHTML = "";

    // Header row
    const header = document.createElement("div");
    header.className = "editor-section-header";
    const title = document.createElement("span");
    title.className = "editor-section-title";
    title.textContent = "channels + mappings";
    const saveBtn = document.createElement("button");
    saveBtn.className = "btn-save";
    saveBtn.textContent = "Save + Reload";
    saveBtn.addEventListener("click", doSave);
    header.appendChild(title);
    header.appendChild(saveBtn);
    container.appendChild(header);

    // Hint
    const hint = document.createElement("div");
    hint.className = "editor-hint";
    hint.textContent = "Ctrl/Cmd + Enter to save";
    container.appendChild(hint);

    // Editor — initialised directly from scenario.yaml (no serialisation step)
    const mount = document.createElement("div");
    mount.className = "editor-mount-full";
    container.appendChild(mount);

    view = new EditorView({
      state: EditorState.create({
        doc: scenario.yaml.trimStart(),
        extensions: [
          yamlLang(),
          oneDark,
          EditorView.lineWrapping,
          keymap.of([
            { key: "Ctrl-Enter", run: () => { doSave(); return true; } },
            { key: "Mod-Enter",  run: () => { doSave(); return true; } },
            ...defaultKeymap,
          ]),
          EditorView.theme({
            "&": { height: "100%", fontSize: "12px" },
            ".cm-scroller": { overflow: "auto", height: "100%" },
          }),
        ],
      }),
      parent: mount,
    });
  }

  function doSave(): void {
    if (!view) return;
    const raw = view.state.doc.toString();
    try {
      // Validate + parse — throws on any YAML or schema error
      parseScenarioYaml(raw);
    } catch (e) {
      alert(`Invalid YAML in config editor:\n${String(e)}`);
      return;
    }
    // Store the validated raw YAML string as the new scenario source of truth
    const next: ScenarioDefinition = { ...currentScenario, yaml: raw };
    void onConfigReload(next);
  }

  build(opts.scenario);

  return {
    update(scenario: ScenarioDefinition): void {
      if (scenario !== currentScenario) {
        currentScenario = scenario;
        build(scenario);
      }
    },
  };
}

// One editor for the config (channels + mappings YAML), then one per (system × entity).
