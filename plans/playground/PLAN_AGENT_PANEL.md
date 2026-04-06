# Plan: Agent Chat Panel in the Playground

**Status:** draft  
**Date:** 2026-04-06  
**Effort:** L  
**Domain:** demo / playground UI  
**Scope:** `playground/` only — no engine changes  
**Spec:** `specs/playground.md`, `specs/agent-assistance.md`  
**Depends on:** none  

---

## Problem

The playground lets users explore sync behaviour visually and edit mapping configs as YAML.
However, starting from scratch with a new scenario requires knowledge of which fields exist in
each connector's schema, how they relate across systems, and what the YAML structure looks like.
There is no in-app guidance. A first-time user must read docs, inspect the seed records
manually, and hand-author the YAML.

---

## Goal

An **Agent Chat panel** embedded in the playground — a resizable right-hand sidebar styled
like VS Code's chat panel — where the user can:

1. Ask the agent to **generate a mapping config** from a natural-language description.
2. Ask **questions about data structures**: "What fields does the CRM contacts entity have?",
   "Which fields overlap between ERP persons and CRM contacts?".
3. **Iterate conversationally**: "Add a phone mapping" or "Remove the address fields" — the
   agent updates the config proposal in its reply.
4. **Apply** an agent-proposed config to the YAML editor with one click.

The panel is optional and collapsible. When hidden it adds zero overhead.

Delivered in two phases to keep the first iteration free of external dependencies:

- **Phase 1** — Scripted responses. A small lookup table maps recognised prompts to
  pre-authored replies (including `yaml` code blocks). No LLM, no API key, no network
  request. Ships the full UI and Apply-to-editor flow.
- **Phase 2** — In-browser LLM. WebLLM / transformers.js runs a quantised model (e.g.
  Phi-3-mini) entirely in the browser via WebGPU. No account, no server, no download on
  page load — the model is fetched from a CDN once and cached by the browser's Cache API.
  Works on GitHub Pages with no backend.

---

## Layout

The current playground uses a two-column layout:

```
┌────────────────┬──┬─────────────────────────────────────────┐
│  Config editor │||│           Systems view                  │
│  · YAML tab    │  ├─────────────────────────────────────────┤
│  · Diagram tab │  │           Dev tools panel               │
└────────────────┘  └─────────────────────────────────────────┘
```

The agent panel adds a **third collapsible column** on the far right:

```
┌────────────────┬──┬────────────────────────┬──┬─────────────┐
│  Config editor │||│      Systems view       │||│  Agent      │
│  · YAML tab    │  ├────────────────────────┤  │             │
│  · Diagram tab │  │   Dev tools panel       │  │  [messages] │
│                │  │                         │  │  [input]    │
└────────────────┘  └────────────────────────┘  └─────────────┘
```

When the panel is collapsed it takes 0 px and the third drag handle is hidden. A toggle
button (chat icon) sits in the top toolbar alongside the existing scenario selector and
Reset button.

### § Agent panel anatomy

```
┌─────────────────────────────────────────┐
│  Agent  ·  scripted ▾            [✕]   │  ← header bar (Phase 1)
│  Agent  ·  Phi-3-mini ▾  [Load]  [✕]   │  ← header bar (Phase 2)
├─────────────────────────────────────────┤
│  crm·contacts  erp·persons  hr·employees│  ← context pills (live)
├─────────────────────────────────────────┤
│                                         │
│  ┌───────────────────────────────────┐  │
│  │ user bubble                       │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │ assistant reply                   │  │
│  │                                   │  │
│  │ ```yaml                           │  │
│  │ channels:                         │  │
│  │   …                               │  │
│  │ ```                               │  │
│  │ [ Apply to editor ]               │  │  ← code-block action button
│  └───────────────────────────────────┘  │
│                                         │
│  (suggested prompts when empty)         │
├─────────────────────────────────────────┤
│  ┌───────────────────────────────────┐  │
│  │ textarea (shift+enter = newline)  │  │  ← input area
│  └───────────────────────────────────┘  │
│  [ Send ↵ ]                             │
└─────────────────────────────────────────┘
```

Default width: 320 px. Resizable via a drag handle (200–600 px range). Width is persisted in
`localStorage` like the existing editor-pane width.

---

## Context Injection

Before every user message the agent receives a **system prompt** assembled from live
playground state:

```
You are an assistant for OpenSync, a bi-directional data sync engine.

Available systems and their entity schemas:
- crm → contacts: { firstName (string), lastName (string), email (string), phone (string), … }
- erp → persons:  { fullName (string), emailAddress (string), orgId (string), … }
- hr  → employees:{ name (string), workEmail (string), department (string), … }

Current mapping config:
<the current YAML from the editor — what was last applied>

Respond concisely. When proposing a mapping config, always return it inside a ```yaml
code block. Do not invent field names that are not present in the schemas above.
```

The context builder (`src/ui/agent-context.ts`) reads:
- `EntityDefinition.schema` per connector — field names + `FieldDescriptor.description`
- The last-applied YAML from the editor state
- Optionally: a summary of current record counts per entity ("3 contacts, 2 persons, 2 employees")

Context is re-built on every message send so it always reflects the current playground state,
including any config the user has applied mid-conversation.

---

## Suggested Prompts

When the chat thread is empty, four suggested-prompt chips are displayed:

- "Generate a mapping for contacts between CRM and ERP"
- "What fields does the CRM contacts entity have?"
- "Which fields overlap between CRM contacts and ERP persons?"
- "Explain how the identity field rule works"

Clicking a chip fills the input and sends immediately.

---

## Code Block Actions

When an assistant reply contains a fenced ` ```yaml ` block, the panel renders an
**"Apply to editor"** button below it. Clicking:

1. Writes the block content into the CodeMirror YAML editor (the YAML tab becomes active).
2. Optionally triggers "Apply" automatically if the user has an "auto-apply" toggle enabled
   in the header bar (default: off — user must click Apply manually).

Non-YAML code blocks (e.g. ` ```json `) get a **"Copy"** button only.

---

## Phase 1 — Scripted Responses

A `scripts/` map in `playground/src/ui/agent-scripts.ts` holds a list of `{ match, reply }`
entries. `match` is a lowercase substring or regex tested against the user's trimmed input.
On send, the dispatcher finds the first match and returns the associated reply after a short
simulated delay (~600 ms) for realism.

Example entries:

| Trigger phrase | Reply contains |
|---|---|
| `"contacts"` + `"crm"` + `"erp"` | YAML mapping for crm/contacts ↔ erp/persons |
| `"fields"` + connector name | Bulleted list of field names from that entity's schema |
| `"overlap"` | Comparison table of shared semantic fields between two entities |
| `"identity"` | Explanation of the identity rule with a YAML example |
| `"what can you do"` | List of suggested actions |

Unrecognised input returns a fallback: *"I don't have a scripted answer for that yet. Try one
of the suggested prompts."* The suggested-prompt chips always have matches, so new users are
never stuck.

Scripted replies are authored for the default playground seed (crm / erp / hr with the
`associations-demo` scenario). Replies that include YAML are validated against the engine
config schema at build time (simple JSON Schema check in a test).

No external dependencies. No API key. Works on GitHub Pages day one.

---

## Phase 2 — In-Browser LLM

Uses **WebLLM** (`@mlc-ai/web-llm`) to run a quantised model entirely via WebGPU — no
server, no account required.

**Model:** Phi-3.5-mini-instruct-q4f16 (~2.5 GB download, cached in Cache API after first
load). Smaller alternatives (SmolLM2-1.7B-Instruct, ~300 MB) are viable if load time is a
priority.

**Reference:** https://chat.webllm.ai/ — the WebLLM team's own chat demo, useful for testing
whether a given machine/browser combination will work before committing to Phase 2.
Confirmed non-functional on Edge on a Lenovo X1 Carbon (integrated Intel GPU, 16 GB RAM) —
sets a realistic lower bound: older Intel integrated graphics may not meet the WebGPU
driver requirements even on a capable CPU.

**Hardware:** Any system with a WebGPU-capable GPU — mainstream discrete GPUs (NVIDIA
GTX 1060+, AMD RX 5700+), Apple Silicon (M1–M4, best experience), integrated graphics on
recent Intel/AMD chips (gen 12+ Xe graphics generally work; older Intel HD/UHD may not).
CPU/WASM fallback available but slow.

**Browser:** Chrome 113+ recommended. Edge 113+ has WebGPU but driver compatibility is
narrower on older Intel hardware (see reference above). Firefox not yet supported (WebGPU
behind a flag).

**Load flow:**
1. User opens the agent panel — no model loaded yet.
2. Header bar shows "[ Load model ]" button and the model name.
3. Clicking "Load model" starts the download with a progress bar in the panel body.
4. Model downloads once, stored in the browser's Cache API — subsequent page loads are instant.
5. Once loaded, input unlocks and the chat behaves like Phase 1 but with real inference.

**Streaming:** WebLLM's `chat.completions.create({ stream: true })` yields tokens
incrementally. The same rendering path used for simulated delay in Phase 1 handles real
token streaming in Phase 2 — the UI difference is transparent.

**Context injection** is identical to Phase 1: the system prompt is assembled from
`EntityDefinition.schema` and the current editor YAML before every message.

**No API key needed.** The provider selector in the header is removed in Phase 2; the only
choice is which local model to load.

---

## Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/playground.md` | New § 10 "Agent panel" | Add full spec section covering layout, anatomy, context, code-block actions, API key handling, resize behaviour |
| `specs/playground.md` | § 2 Layout | Update layout ASCII diagram to show the third column and the toggle button in the toolbar |
| `specs/agent-assistance.md` | New § 6 "Playground integration" | Describe how the playground assembles the context prompt from `EntityDefinition.schema`, the editor state, and live record counts; note the session-only key storage constraint |

No changes to `specs/sync-engine.md`, `specs/connector-sdk.md`, or any other spec.

---

## Implementation Steps

All steps depend on spec changes being written first (§ "Spec changes planned" above).

### Phase 1 steps

#### Step 1 — Spec write-up

Write the spec sections listed in "Spec changes planned" before writing any code.

#### Step 2 — Layout shell (no logic)

- Add `#agent-panel` column and `#agent-resize-handle` to `playground/index.html`.
- Add toggle button (chat icon, `#agent-toggle`) to the toolbar.
- CSS: collapsed (`width: 0; overflow: hidden`) vs expanded state. Transition on toggle.
- Persist panel width to `localStorage` via the same pattern as `#editor-width`.
- File: `playground/src/ui/agent-panel.ts` (new), `playground/index.html`, `playground/src/style.css`.

#### Step 3 — Chat UI

- Message list rendering: user bubbles (right-aligned), assistant bubbles (left-aligned).
- Markdown-lite renderer: bold, inline code, fenced code blocks with language label.
- Code-block action buttons ("Apply to editor", "Copy").
- Suggested-prompt chips when thread is empty.
- Input area: `<textarea>` that auto-grows, Enter = send, Shift+Enter = newline.

#### Step 4 — Context builder

- `playground/src/ui/agent-context.ts` (new).
- Reads `EntityDefinition[]` from the in-memory connector registry.
- Reads last-applied YAML from editor state.
- Returns a `string` system prompt (used as context for authoring the script entries).

#### Step 5 — Script table + dispatcher

- `playground/src/ui/agent-scripts.ts` (new).
- Authors ~10–15 entries covering the suggested prompts and common follow-ups.
- `dispatch(input: string): Promise<string>` — matches input, returns reply after a simulated
  delay, falls back to the "no scripted answer" message.
- Build-time test: any reply containing a `yaml` block is validated against the engine config
  schema.

#### Step 6 — Apply action

- "Apply to editor" button in code blocks calls a callback exported from `editor-pane.ts`
  that sets the CodeMirror content and switches to the YAML tab.
- Auto-apply toggle calls `boot()` after setting the content (same path as the "Apply" button).

---

### Phase 2 steps

#### Step 7 — WebLLM integration

- Add `@mlc-ai/web-llm` to `playground/package.json`.
- `playground/src/lib/webllm-client.ts` (new): wraps `CreateMLCEngine`, exposes
  `loadModel(name, onProgress): Promise<void>` and
  `streamChat(messages, signal): AsyncIterable<string>`.
- Header bar: model selector `<select>` + "Load model" button + download progress bar.
- Loaded engine instance held in module-level state; re-used across sends.
- The `dispatch` path from Phase 1 is replaced by the WebLLM client; everything else
  (context builder, Apply action, streaming render) is unchanged.

---

## What This Does Not Do

- No cloud API key requirement — Phase 1 needs nothing, Phase 2 needs only WebGPU.
- No connector generation from the agent panel (that belongs to a CLI workflow — see
  `specs/agent-assistance.md § 1`).
- No agent access to the sql.js database or shadow state directly.
- No server-side proxy. The playground has no backend and never will.
- No persistence of chat history across page reloads (ephemeral, same as all other
  playground state).
- No multi-turn memory beyond the browser session (Phase 2); scripted mode is stateless.
