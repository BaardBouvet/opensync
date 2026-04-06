# Playground: Notification Poll (Debounced Mutation Trigger)

**Status:** draft  
**Date:** 2026-04-06  
**Domain:** Playground UX  
**Scope:** `playground/src/main.ts`, `playground/src/engine-lifecycle.ts`, `specs/playground.md`  

---

## § 1 Problem Statement

When the user edits a record in auto mode, `main.ts` immediately calls `pollOnce()` after
mutating the connector.  This collapses the two-phase sync effect into a single instant:
the edited record and all its synced copies flash green simultaneously.

The intended experience is two distinct events:

1. **Mutation flash** — the edited record card flashes green right away (UI refresh only,
   no engine involvement).
2. **Propagation flash** — a short time later the engine tick fires, reads the changed
   record, and synced copies flash green across the other systems.

The delay between the two is what makes the async nature of sync visible and
understandable.  The current code hides it.

---

## § 2 Proposed Solution: Notification Poll

Replace the immediate `pollOnce()` call with a **debounced notification poll** — a
short, fixed delay (default `NOTIFY_MS = 800 ms`) that fires one poll after the most
recent mutation.

Simultaneously raise the regular background interval from `2 000 ms` to `5 000 ms`.
The notification poll handles the "something just changed" case; the interval handles
"has anything changed since I last checked?"

This mirrors how real SaaS integrations work: a webhook arrives moments after a write,
and a background poller provides a safety net for missed webhooks.  In the playground the
"webhook" is the notification timer.

---

## § 3 Design

### § 3.1 Timing constants (proposed defaults)

| Constant | Value | Purpose |
|----------|-------|---------|
| `NOTIFY_MS` | `800` ms | Delay between mutation and notification poll |
| `POLL_MS` | `5 000` ms | Regular background interval |

Both are `const` values in `main.ts` (not user-configurable in this plan).

### § 3.2 Notification timer in `main.ts`

```typescript
let notifyTimer: ReturnType<typeof setTimeout> | undefined;

function schedulePoll(): void {
  // Debounce: reset timer on every mutation; fire one poll after the dust settles.
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined;
    void triggerPoll();
  }, NOTIFY_MS);
}
```

`schedulePoll()` replaces all `void triggerPoll()` calls in the mutation callbacks:

| Callback | Before | After |
|----------|--------|-------|
| `onSave` (auto mode) | `void triggerPoll()` | `schedulePoll()` |
| `onRestore` (auto mode) | `void triggerPoll()` | `schedulePoll()` |

`onSoftDelete` currently only calls `refreshUI()` (no engine trigger) — unchanged.

In **manual mode** (auto off), `schedulePoll()` is not called at all.  Only the "Sync"
button triggers a poll.  This matches current behaviour.

### § 3.3 Interval coordination

The notification poll and the background interval are independent timers.  They may
occasionally fire close together (e.g. notification at T=0, interval at T=200ms
because it was already close to its next tick).  This is harmless — the second poll
produces only skip results, noop ticks are pruned from the Log panel, and the UI
renders nothing extra.

Coordinating the interval (resetting it when a notification poll runs) would require
exposing a `resetInterval()` method on `EngineState`.  The benefit is small and  
adds API surface.  **Not in scope for this plan** — keep timers independent.

### § 3.4 Pass `POLL_MS` to `startEngine`

`startEngine` already accepts `pollMs` as a parameter.  The call site in `main.ts`
currently uses the default `2 000`.  Change to pass `5_000` explicitly:

```typescript
// main.ts — in boot()
const state = await startEngine(scenario, onEvent, onRefresh, 5_000, onTickStart);
```

No change to `engine-lifecycle.ts` is needed.

### § 3.5 Cancel notification timer on engine stop / reset

When `boot()` is called (scenario switch, reset, config apply), the running engine is
stopped and a new one is booted.  Any pending notification timer from the previous
engine must be cancelled so it doesn't call `pollOnce()` on the dead engine:

```typescript
async function boot(scenario: ScenarioDefinition): Promise<void> {
  clearTimeout(notifyTimer);   // ← add this
  notifyTimer = undefined;
  engineState?.stop();
  ...
}
```

### § 3.6 Poll countdown progress bar

A thin progress bar below the auto-mode toggle depletes from full to empty over the remaining
time until the next poll.  It gives the user a direct read of "how long until the engine runs."

**Appearance**

- A `<div id="poll-countdown">` with an inner `<div id="poll-countdown-fill">`.
- Height: `3 px`; width tracks the full toolbar row.
- Fill colour: same accent as the existing flash green (`#22c55e`), opacity 0.6.
- Hidden (`display: none`) when auto mode is off or when the engine is not running.

**Behaviour**

Two modes, driven by which timer is active:

| Situation | Duration shown | Trigger |
|-----------|---------------|---------|
| Notification timer pending (mutation just made) | `NOTIFY_MS` (800 ms) | `schedulePoll()` called |
| No notification pending; background interval running | `POLL_MS` (5 000 ms) | Poll completes + interval resets |

Implementation uses a CSS `transition` on `width` — no `requestAnimationFrame` loop needed:

```typescript
function startCountdownBar(durationMs: number): void {
  const fill = document.getElementById('poll-countdown-fill') as HTMLDivElement;
  // Snap to full width with transition disabled, then re-enable and shrink to 0.
  fill.style.transition = 'none';
  fill.style.width = '100%';
  // Force a reflow so the browser registers the 100% before the transition starts.
  fill.getBoundingClientRect();
  fill.style.transition = `width ${durationMs}ms linear`;
  fill.style.width = '0%';
}

function resetCountdownBar(): void {
  const fill = document.getElementById('poll-countdown-fill') as HTMLDivElement;
  fill.style.transition = 'none';
  fill.style.width = '0%';
}
```

Call sites:

| Where | Call |
|-------|------|
| `schedulePoll()` — after `notifyTimer = setTimeout(…)` | `startCountdownBar(NOTIFY_MS)` |
| `triggerPoll()` — when auto mode is on and the interval fires | `startCountdownBar(POLL_MS)` |
| `boot()` — after `clearTimeout(notifyTimer)` | `resetCountdownBar()` |
| Auto toggle turned off | `resetCountdownBar()` |

The bar is shown/hidden alongside the auto toggle: add `poll-countdown` to the same
visibility logic that shows/hides auto-specific controls.

---

## § 4 User-visible Effect (before vs after)

| Event | Before | After |
|-------|--------|-------|
| Edit record, auto on | Saved record + all targets flash green simultaneously | Saved record flashes green → ~0.8 s later targets flash green |
| Rapid edits (< 800 ms apart) | Each edit triggers a poll | Only one poll fires, ~0.8 s after the *last* edit |
| No mutations, auto on | Poll fires every 2 s | Poll fires every 5 s |
| Edit record, auto off | `refreshUI()` only | `refreshUI()` only (unchanged) |
| Click Sync, auto off | `pollOnce()` immediately | `pollOnce()` immediately (unchanged) |
| Countdown bar, auto on | — | Depletes over 800 ms after a mutation; resets to 5 s depletion after each poll |
| Countdown bar, auto off | — | Hidden |

---

## § 5 Spec Changes Planned

| Spec file | Section(s) to modify |
|-----------|---------------------|
| `specs/playground.md` | § 8.3 (Poll loop) — update `pollMs` default to 5 000; add note on notification poll. § 10 (Auto mode) — describe the notification-poll behaviour, the two-phase flash effect, and the countdown bar. |

---

## § 6 Implementation Steps

1. Add `const NOTIFY_MS = 800` and `const POLL_MS = 5_000` near the top of `main.ts`.
2. Add `let notifyTimer` and `function schedulePoll()` as described in § 3.2.
3. In `onSave`: replace `if (engineState.isRealtime) void triggerPoll()` with
   `if (engineState.isRealtime) schedulePoll()`.
4. In `onRestore`: same replacement.
5. In `boot()`: add `clearTimeout(notifyTimer); notifyTimer = undefined;` before
   `engineState?.stop()`.
6. Change the `startEngine` call to pass `POLL_MS` explicitly.
7. Add `<div id="poll-countdown"><div id="poll-countdown-fill"></div></div>` to
   `index.html`, styled as a 3 px bar beneath the auto-mode toolbar row.
8. Add `startCountdownBar()` and `resetCountdownBar()` helpers to `main.ts` (§ 3.6);
   wire call sites as specified in the table in § 3.6.
9. Update `specs/playground.md` §§ 8.3 and 10.

Total change: ~25 lines of code.
