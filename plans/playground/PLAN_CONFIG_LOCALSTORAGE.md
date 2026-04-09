# PLAN: Persist Playground Config in localStorage

**Status:** proposed  
**Date:** 2026-04-09  
**Effort:** XS  
**Domain:** playground  
**Scope:** `playground/src/main.ts`, `specs/playground.md`  
**Spec changes planned:** `specs/playground.md` — add § 13 Config Persistence  

---

## Problem

The playground config editor lets users freely edit the scenario YAML.  Those edits are
purely ephemeral: the URL hash encodes only the scenario **key** (`#scenario=<name>&tab=<tab>`),
not the edited text.  Refreshing the page or restarting the browser silently discards any
work in progress and reloads the bundled scenario default.

---

## Goal

Edited YAML for each scenario survives a page refresh or browser restart.  The scenario
dropdown still selects by key; the editing experience is unchanged; the only observable
difference is that the editor reopens with the user's last-saved text rather than the
bundled default.

---

## Design

### Storage key

```
opensync.playground.config.v1.<scenarioKey>
```

One `localStorage` entry per scenario key.  The `v1.` infix allows a future schema change
to bump the version and ignore stale entries automatically (validation already handles
malformed values — see below).

### Save

On every successful Save + Reload — i.e. after validation passes and immediately before
`boot()` is called with the new `ScenarioDefinition` — write the raw YAML string to
localStorage:

```ts
localStorage.setItem(`opensync.playground.config.v1.${scenarioKey}`, newScenario.yaml);
```

No debounce needed: save is already gated behind an explicit user action and validation.

### Load

At initial page load and on every scenario switch, after the scenario key is resolved from
the URL hash, read the persisted YAML before handing the scenario to `boot()`:

```ts
const persisted = localStorage.getItem(`opensync.playground.config.v1.${scenarioKey}`);
if (persisted !== null) {
  try {
    MappingsFileSchema.parse(parseYaml(persisted));   // validate before trusting
    scenario = { ...scenario, yaml: persisted };
  } catch {
    console.warn("[playground] Discarding invalid persisted config for", scenarioKey);
    localStorage.removeItem(`opensync.playground.config.v1.${scenarioKey}`);
  }
}
```

Validation is the same parse path already used by the Save + Reload button, so any YAML
that survives a save can survive a load.  A persisted value that fails validation is
removed and the bundled default is used, with a console warning.

### Reset

The Reset button must clear the persisted override so the bundled default is restored:

```ts
localStorage.removeItem(`opensync.playground.config.v1.${scenarioKey}`);
void boot(scenario);   // boots with bundled default
```

The confirmation dialog wording already says "Reset will discard all changes" — no wording
change needed.

### Scenario switching

Switching to a different scenario via the dropdown also applies the load logic above for
the new key.  If that scenario has a persisted override it is used; otherwise the bundled
default is used.  No change to the dropdown logic beyond wrapping the resolved scenario
through the load helper.

### Visual indicator

When the editor is opened with a persisted (non-default) YAML, a small
`(modified)` label is shown inline in the editor pane header, alongside the existing
Save + Reload button area.  The label is removed once the user Resets or switches to a
scenario that has no persisted override.

This is the simplest possible affordance — no diff, no "Revert to default" button in the
editor pane itself (Reset in the topbar already serves that purpose).

---

## Spec changes planned

Add **§ 13 Config Persistence** to `specs/playground.md`.

No other spec files require changes.  No engine or SDK types are affected.

---

## Implementation steps

1. Extract a `loadScenario(key: string): ScenarioDefinition` helper in `main.ts` that
   applies the localStorage read + validation guard above.  Replace the two call sites
   (initial load and dropdown change handler) with this helper.

2. In the `onConfigReload` callback in `main.ts`, write to localStorage immediately before
   calling `boot()`.

3. In the Reset button handler in `main.ts`, clear the localStorage key before calling
   `boot()`.

4. In `buildEditorPane` (or its caller in `main.ts`), pass a boolean `isModified` flag
   that controls the `(modified)` label visibility.  Update the flag after every boot.

5. Add § 13 to `specs/playground.md`.

---

## Out of scope

- Persisting record mutations (connector data) — those remain ephemeral by design.
- Export/import of YAML from file — a separate future plan.
- Cross-tab synchronisation — localStorage is single-tab for playground purposes.
- Size limit enforcement — scenario YAMLs are a few hundred bytes at most; the 5 MB
  localStorage cap is not a practical concern.
