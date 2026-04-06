# PLAN: URL Anchors and Browser History Navigation

**Status:** backlog  
**Date:** 2026-04-06  
**Effort:** S  
**Domain:** playground  
**Scope:** `playground/src/main.ts`, `playground/src/ui/systems-pane.ts`, `specs/playground.md`  
**Spec changes planned:** `specs/playground.md` — add § 12 URL Anchors and Navigation History  

---

## Problem

The playground has no URL state. Refreshing the page always loads the default scenario and
the first channel tab. There is no way to share a direct link to a specific scenario or tab,
and the browser back/forward buttons do nothing.

---

## Goal

- The browser's address bar reflects the active scenario and active tab at all times.
- The user can press Back / Forward to navigate between scenarios (and return to a
  previously-active tab within them).
- A URL can be shared or bookmarked and will restore the same view on load.

---

## Spec changes planned

Add **§ 12 URL Anchors and Navigation History** to `specs/playground.md`.

No other spec files require changes.

---

## Hash format

```
#scenario=<scenarioKey>&tab=<tabId>
```

Examples:
```
#scenario=associations-demo&tab=contacts
#scenario=minimal&tab=__lineage__
#scenario=associations-demo&tab=__unmapped__
```

`tab` is optional. When absent, the first channel tab is shown (existing default behaviour).
`scenario` is optional. When absent, `defaultScenarioKey` is used.

Both values are URL-encoded via `encodeURIComponent` / `decodeURIComponent`. No other
hash schemes are supported; unrecognised params are ignored.

### Why a hash, not a search param?

Hash changes do not trigger a server round-trip. The playground is a single HTML file served
from Vite / GitHub Pages; search-param changes would cause unnecessary reloads and break
the sql.js WASM init on every navigation.

---

## History strategy

| User action | History call | Rationale |
|---|---|---|
| Selects a scenario in the dropdown | `history.pushState` | A distinct "page" — back should return here |
| Clicks a channel tab (incl. `unmapped`, `lineage`) | `history.replaceState` | Tab switches are cheap; clogging history with every tab click would make navigation unusable |
| Config hot-reload (Apply button) | `history.replaceState` | Same scenario, different config — not a distinct history entry |
| Boot from URL hash (initial load) | no push/replace | Hash was already set by previous navigation |
| `popstate` restores a scenario | no push/replace | Responding to the browser's own navigation |

---

## Implementation

### 1. Hash helpers (`playground/src/main.ts`)

```ts
interface PlaygroundHash {
  scenario: string | null;
  tab: string | null;
}

function parseHash(): PlaygroundHash {
  const raw = location.hash.slice(1);  // strip leading '#'
  const params = new URLSearchParams(raw);
  return {
    scenario: params.get("scenario"),
    tab: params.get("tab"),
  };
}

function buildHash(scenario: string, tab: string | null): string {
  const params = new URLSearchParams({ scenario });
  if (tab) params.set("tab", tab);
  return "#" + params.toString();
}
```

### 2. Tab-change notification

`createSystemsPane` gains an optional `onTabChange` callback in its options object:

```ts
export interface SystemsPaneCallbacks {
  // ... existing callbacks ...
  onTabChange?: (tab: string) => void;
}
```

Every place that assigns `activeChannel` and re-renders the tab bar calls
`callbacks.onTabChange?.(activeChannel)`.

`createSystemsPane` also gains a `setActiveTab(tab: string): void` method on its return
value, which sets `activeChannel` and re-renders without pushing history. This is used:
- On initial load to restore tab from hash
- On `popstate` to restore tab after a scenario switch

### 3. Scenario changes push history

In the `dropdown.addEventListener("change", ...)` handler in `main.ts`, after calling
`void boot(s)`:

```ts
history.pushState(null, "", buildHash(dropdown.value, null));
```

Tab is omitted (null) so the URL reflects the default first tab. The systems pane will
call `onTabChange` once the tab bar renders, which calls `replaceState` to fill in the tab.

### 4. Tab changes replace history

In `main.ts`, pass `onTabChange` to `createSystemsPane`:

```ts
systemsPane = createSystemsPane(systemsContainer, {
  // ... existing callbacks ...
  onTabChange(tab) {
    if (!engineState) return;
    history.replaceState(null, "", buildHash(currentScenarioKey(), tab));
  },
});
```

`currentScenarioKey()` is a small helper that returns the currently-active scenario key
(the dropdown's selected value).

### 5. Initial load — read hash

In `DOMContentLoaded`, before calling `void boot(currentScenario)`:

```ts
const initHash = parseHash();
const initScenarioKey = (initHash.scenario && scenarios[initHash.scenario])
  ? initHash.scenario
  : defaultScenarioKey;
const initScenario = scenarios[initScenarioKey]!;

// Set dropdown to match
for (const opt of Array.from(dropdown.options)) {
  opt.selected = opt.value === initScenarioKey;
}

void boot(initScenario).then(() => {
  if (initHash.tab) systemsPane?.setActiveTab(initHash.tab);
});
```

### 6. `popstate` handler

```ts
window.addEventListener("popstate", () => {
  const h = parseHash();
  const key = (h.scenario && scenarios[h.scenario]) ? h.scenario : defaultScenarioKey;
  const s = scenarios[key]!;

  // Update dropdown
  for (const opt of Array.from(dropdown.options)) {
    opt.selected = opt.value === key;
  }

  // Confirm dirty before navigating back — user pressed Back, so warn them
  if (isDirty && !confirm("You have unsaved changes that will be lost. Navigate away?")) {
    // Undo the popstate by re-pushing the current state
    history.pushState(null, "", buildHash(key, null));
    return;
  }

  void boot(s).then(() => {
    if (h.tab) systemsPane?.setActiveTab(h.tab);
  });
});
```

---

## Spec section to add

```markdown
## § 12 URL Anchors and Navigation History

### § 12.1 Hash format

The playground encodes view state in the URL hash:

    #scenario=<scenarioKey>&tab=<tabId>

Both parameters are URL-encoded. `scenario` defaults to `defaultScenarioKey` when absent.
`tab` defaults to the first channel tab when absent. Unrecognised parameters are ignored.

### § 12.2 History strategy

Scenario selection uses `history.pushState` so the browser Back button returns to the
previous scenario. Tab switches use `history.replaceState` so they do not clog the history
stack but remain bookmarkable via the current URL. Config hot-reload (Apply) also uses
`history.replaceState` — same scenario, not a distinct history entry.

### § 12.3 Initial load from hash

On `DOMContentLoaded`, `main.ts` reads `location.hash`, extracts `scenario` and `tab`,
selects the matching scenario in the dropdown, boots the engine, then restores the tab.
An unrecognised scenario key falls back to the default.

### § 12.4 popstate restoration

A `window.addEventListener("popstate", ...)` handler re-runs `boot()` for the scenario
named in the hash and then calls `systemsPane.setActiveTab()` to restore the tab.
If `isDirty` is true, a confirmation dialog is shown; if the user cancels, the navigation
is reversed by re-pushing the previous hash.

### § 12.5 Dirty-state guard

`isDirty` is checked before allowing `popstate` to replace the current scenario, matching
the existing behaviour for dropdown scenario switches.
```

---

## Files changed

| File | Change |
|---|---|
| `playground/src/main.ts` | Add `parseHash`, `buildHash`, initial-load hash read, `onTabChange` wiring, `popstate` handler |
| `playground/src/ui/systems-pane.ts` | Add `onTabChange` callback to `SystemsPaneCallbacks`; call it on every tab change; add `setActiveTab()` to the returned interface |
| `specs/playground.md` | Add § 12 URL Anchors and Navigation History |
| `CHANGELOG.md` | Entry under `### Added` |

---

## Out of scope

- Persisting resize widths (`#editor-pane` width, `#devtools-container` height) in the hash —
  layout state is explicitly discarded on page load (spec § 9).
- Persisting lineage expansion state (which entity pills are open) or canonical field focus.
- Deep-linking to a specific record or cluster.
