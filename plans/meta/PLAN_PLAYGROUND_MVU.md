# Plan: Migrate Playground to MVU Architecture

**Status:** backlog  
**Date:** 2026-04-06  
**Domain:** Demo / Architecture  
**Scope:** playground/  
**Spec changes planned:** None — this is internal demo plumbing only.

---

## Problem

The playground app (`playground/`) is built with imperative DOM mutation scattered
across `main.ts` and the `ui/` modules. Module-level mutable state (`engineState`,
`systemsPane`, `devTools`, `isDirty`, etc.) is read and written from many places.
There is no single source of truth for "what the UI should look like right now."

Consequences:
- Bugs from stale local state (the real-time toggle bug was one such case)
- `refreshUI()` and `triggerPoll()` call the same render methods in different orders —
  easy to miss a call site
- No testable pure render logic — tests would have to spin up a full DOM
- Adding new state often requires touching `main.ts`, `boot()`, `refreshUI()`,
  `triggerPoll()`, and each UI module's `refresh()` method separately

---

## Goal

Migrate to a **Model–View–Update (MVU)** architecture:
- All application state in one immutable `AppModel` object
- All state transitions expressed as pure `update(model, msg) → AppModel`
- `render(model)` is the sole writer to the DOM — all UI modules become pure renderers
- No module-level mutable variables outside the dispatch loop

The result is a playground that can be tested with `render(model)` → snapshot assertions
and `update(model, msg)` → model assertions, without touching the DOM at all.

---

## § 1 Model

### § 1.1 AppModel shape

```typescript
interface AppModel {
  // Engine
  phase: "idle" | "booting" | "running" | "error";
  error: string | null;
  engineState: EngineState | null;   // opaque, replaced on boot
  isRealtime: boolean;               // mirrors engineState.isRealtime; survives re-boot

  // Scenarios / editor
  activeScenarioKey: string;
  editorYaml: string;                // current YAML in the editor (may be unsaved)
  isDirty: boolean;

  // DevTools
  devtoolsTab: "events" | "logs" | "identity_map" | "shadow_state";
  selectedLogConnector: string | null;

  // Overlay
  unsavedConfirmPending: "scenario-change" | "config-reload" | "reset" | null;
  pendingScenarioKey: string | null; // set when user picks a scenario while dirty
}
```

### § 1.2 Derived data (computed in render, never stored)

- `clusters: Map<string, ChannelCluster[]>` — derived from `engineState.getClusters()`
- `dbSnapshot: DbSnapshot` — derived from `engineState.getDbState()`
- `activityLog: ActivityLogEntry[]` — derived from `engineState.connectors`
- `eventLog: SyncEvent[]` — maintained as an append-only array on the model (replaces
  the mutable `eventList` DOM element)
- `tickBoundaries: number[]` — indices in `eventLog` where a new tick started

---

## § 2 Messages

All state transitions go through a discriminated-union `Msg` type dispatched to `update`:

```typescript
type Msg =
  // Engine lifecycle
  | { type: "BOOT_START"; scenarioKey: string }
  | { type: "BOOT_DONE"; engineState: EngineState }
  | { type: "BOOT_ERROR"; error: string }
  | { type: "SCENARIO_SELECT"; key: string }
  | { type: "RESET" }
  | { type: "CONFIRM_DISCARD" }
  | { type: "CANCEL_DISCARD" }
  // Poll / sync
  | { type: "POLL_START" }
  | { type: "POLL_DONE" }
  | { type: "TICK_BEGIN"; phase: "onboard" | "poll" }
  | { type: "EVENT_EMITTED"; ev: SyncEvent }
  | { type: "TOGGLE_REALTIME"; checked: boolean }
  | { type: "SYNC_BUTTON_CLICKED" }
  // Record mutations
  | { type: "RECORD_SAVE"; systemId: string; entity: string; id: string | null; data: Record<string, unknown>; associations?: Association[]; explicitId?: string }
  | { type: "RECORD_SOFT_DELETE"; systemId: string; entity: string; id: string }
  | { type: "RECORD_RESTORE"; systemId: string; entity: string; id: string }
  // Editor
  | { type: "EDITOR_CHANGE"; yaml: string }
  | { type: "CONFIG_RELOAD"; scenario: ScenarioDefinition }
  // DevTools
  | { type: "DEVTOOLS_TAB"; tab: AppModel["devtoolsTab"] }
  | { type: "LOG_CONNECTOR_SELECT"; connId: string }
  | { type: "CLEAR_EVENTS" }
  | { type: "CLEAR_ACTIVITY_LOGS" };
```

### § 2.1 `update(model, msg) → AppModel`

Pure function, no side effects. Returns a new model object. Side effects (engine calls,
DOM writes) are handled by the dispatch loop, not inside `update`.

For mutations with side effects (`RECORD_SAVE`, `POLL_START`, etc.) `update` returns the
new model and the dispatch loop runs the effect, then dispatches a follow-up message with
the result (`POLL_DONE`, `BOOT_DONE`, etc.).

---

## § 3 Render

`render(model: AppModel, prev: AppModel | null): void`

Called after every `dispatch`. Diffs `model` vs `prev` to skip unchanged sub-trees.
Returns nothing. Never dispatches.

Sub-renders:

| Sub-render | Currently | After |
|---|---|---|
| `renderTopbar(model)` | inline in `DOMContentLoaded` | pure renderer |
| `renderSystemsPane(model)` | `systemsPane.refresh(...)` | pure renderer |
| `renderEditorPane(model)` | `editorPane.update(...)` | pure renderer |
| `renderDevTools(model)` | `devTools.refreshDbState()` + `refreshSystemLogs()` | pure renderer |
| `renderConfirmDialog(model)` | `window.confirm(...)` | declarative modal element |

Key invariant: **`render` is the only function that writes to the DOM**. No UI module has
a `refresh()` or `update()` method — they receive the full model and produce a DOM tree.

---

## § 4 Dispatch loop

```typescript
let _model: AppModel = initialModel();
let _prev: AppModel | null = null;

function dispatch(msg: Msg): void {
  const [next, effect] = update(_model, msg);
  _model = next;
  render(_model, _prev);
  _prev = _model;
  if (effect) void runEffect(effect, dispatch);
}
```

`Effect` is a discriminated union of async operations:

```typescript
type Effect =
  | { type: "BOOT"; scenarioKey: string }
  | { type: "POLL" }
  | { type: "MUTATE_CONNECTOR"; op: MutateOp }
```

`runEffect(effect, dispatch)` performs the async work and dispatches the result message.
This separates async I/O from state logic.

---

## § 5 Migration strategy

The migration is designed to be done incrementally without breaking the running demo.

### § 5.1 Phase A — Lift state (no render changes)

1. Define `AppModel` and `Msg` types
2. Write `initialModel()` — initial model from current defaults
3. Write `update(model, msg)` covering all existing message types
4. Replace module-level variables in `main.ts` with a single `_model`
5. Add `dispatch()` that calls the OLD render functions after each message
6. Route all event listeners through `dispatch`

**Checkpoint:** The app behaves identically. `update` is now the only place state changes.

### § 5.2 Phase B — Pure render

1. For each UI module, add a `render(model)` function alongside the existing `refresh()` / `update()` methods
2. In `dispatch`, call the new `render(model)` functions instead of the old ones
3. Remove the old `refresh()` / `update()` methods once all callers are migrated
4. Remove `systemsPane`, `devTools`, `editorPane` module-level variables — replaced by the top-level `render` call

**Checkpoint:** All UI state is derived from model. DOM is only written in render functions.

### § 5.3 Phase C — Confirm dialog

Replace `window.confirm(...)` calls with a declarative `overlay` field in the model rendered
as a modal `<dialog>`. This is the last imperative pattern.

### § 5.4 Phase D — Event log in model

Move `eventLog: SyncEvent[]` and `tickBoundaries: number[]` into the model instead of
being mutated inside the devtools DOM element. The devtools render function becomes
fully pure.

---

## § 6 Testing unlocked

Once Phase B is complete:

```typescript
// update() unit tests (no DOM)
const m0 = initialModel();
const m1 = update(m0, { type: "TOGGLE_REALTIME", checked: false })[0];
expect(m1.isRealtime).toBe(false);

// render() snapshot tests (JSDOM or Playwright)
const dom = renderToFragment(model);
expect(dom.querySelector(".status")?.textContent).toBe("● running");
```

---

## § 7 File layout after migration

```
playground/src/
  model.ts          — AppModel, Msg, initialModel(), update()
  dispatch.ts       — dispatch loop, runEffect()
  render.ts         — top-level render(model, prev)
  effects.ts        — runEffect() implementations (engine boot, poll, mutations)
  ui/
    topbar.ts       — renderTopbar(model, dispatch)
    systems-pane.ts — renderSystemsPane(model, dispatch)  [was: createSystemsPane]
    editor-pane.ts  — renderEditorPane(model, dispatch)   [was: buildEditorPane]
    devtools.ts     — renderDevTools(model, dispatch)     [was: createDevTools]
  main.ts           — DOMContentLoaded → dispatch({ type: "BOOT_START", ... })
```

---

## § 8 Out of scope

- Replacing the engine itself — `EngineState` remains opaque
- Framework adoption (React, Solid, etc.) — the MVU pattern is implemented in plain TS
- Server-side rendering
- State persistence across page reloads
