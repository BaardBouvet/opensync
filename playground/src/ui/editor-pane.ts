// Editor pane — left side, config-only CodeMirror YAML editor.
// The config editor shows channels + mappings as annotated YAML.
// Saving triggers a full engine reload. The conflict strategy is not exposed
// here — it always inherits from the scenario (LWW by default).
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import { defaultKeymap } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { parse as parseYaml } from "yaml";
import type { ScenarioDefinition } from "../scenarios/index.js";
import type { ChannelConfig } from "@opensync/engine";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EditorPaneOptions {
  container: HTMLElement;
  scenario: ScenarioDefinition;
  onConfigReload: (newScenario: ScenarioDefinition) => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Serialise the scenario as the canonical channels + mappings YAML format,
 * matching the layout used by the engine's own config files (e.g. mappings/companies.yaml).
 * Inline comments explain only the non-obvious keys.
 */
function scenarioToConfigYaml(scenario: ScenarioDefinition): string {
  const lines: string[] = [];

  lines.push("channels:");
  for (const ch of scenario.channels) {
    const idFields = (ch.identityFields ?? []).join(", ");
    lines.push(`  - id: ${ch.id}`);
    lines.push(`    identityFields: [${idFields}]  # canonical fields used to match records`);
  }

  lines.push("");
  lines.push("# connector + entity → channel, with field rename rules");
  lines.push("# fields apply both ways: source = connector field, target = canonical field");
  lines.push("mappings:");
  for (const ch of scenario.channels) {
    for (const m of ch.members) {
      lines.push(`  - connector: ${m.connectorId}`);
      lines.push(`    entity: ${m.entity}`);
      lines.push(`    channel: ${ch.id}`);
      if (m.inbound && m.inbound.length > 0) {
        lines.push(`    fields:`);
        for (const f of m.inbound) {
          lines.push(`      - { source: ${f.source ?? f.target}, target: ${f.target} }`);
        }
      }
    }
  }

  return lines.join("\n") + "\n";
}

interface YamlChannelDef { id: string; identityFields?: string[] }
interface YamlMappingEntry {
  connector: string;
  entity: string;
  channel: string;
  fields?: Array<{ source: string; target: string }>;
}

function mergeConfigYaml(
  existing: ScenarioDefinition,
  raw: string,
): ScenarioDefinition {
  const parsed = parseYaml(raw) as { channels?: YamlChannelDef[]; mappings?: YamlMappingEntry[] };
  if (!parsed || typeof parsed !== "object") throw new Error("YAML must be a mapping");

  const channelMap = new Map<string, ChannelConfig>();
  for (const ch of (parsed.channels ?? [])) {
    channelMap.set(ch.id, { id: ch.id, identityFields: ch.identityFields, members: [] });
  }
  for (const m of (parsed.mappings ?? [])) {
    if (!channelMap.has(m.channel)) {
      channelMap.set(m.channel, { id: m.channel, members: [] });
    }
    const ch = channelMap.get(m.channel)!;
    const fieldMaps = m.fields?.map((f) => ({ source: f.source, target: f.target }));
    ch.members.push({ connectorId: m.connector, entity: m.entity, inbound: fieldMaps, outbound: fieldMaps });
  }
  return { ...existing, channels: Array.from(channelMap.values()) };
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

    // Editor
    const mount = document.createElement("div");
    mount.className = "editor-mount-full";
    container.appendChild(mount);

    view = new EditorView({
      state: EditorState.create({
        doc: scenarioToConfigYaml(scenario),
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
    let next: ScenarioDefinition;
    try {
      next = mergeConfigYaml(currentScenario, view.state.doc.toString());
    } catch (e) {
      alert(`Invalid YAML in config editor:\n${String(e)}`);
      return;
    }
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

// One editor for the config (channels + mappings JSON), then one per (system × entity).
