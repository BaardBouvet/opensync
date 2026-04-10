# PLAN: Per-channel opt-out for noop update suppression

**Status:** backlog  
**Date:** 2026-04-05  
**Domain:** packages/engine  
**Depends on:** `PLAN_NOOP_UPDATE_SUPPRESSION.md` (must be implemented first)  

---

## 1. Motivation

Noop update suppression (`PLAN_NOOP_UPDATE_SUPPRESSION.md`) is always on by default.
The suppression guard relies on the target shadow being accurate — if an external system
writes to the target connector outside OpenSync, the shadow becomes stale and the guard
would suppress a write that should heal the target.

Users who have external writers on a target connector need a way to disable the guard
per channel without losing the benefit on other channels.

---

## 2. Config shape

Add `suppressNoopUpdates: false` to a channel in `opensync.json` to disable the guard:

```ts
// packages/engine/src/config/loader.ts
export interface ChannelConfig {
  id: string;
  members: ChannelMember[];
  identityFields?: string[];
  suppressNoopUpdates?: boolean; // default true (guard on); set false to disable
}
```

Default is `true` (guard on), consistent with the always-on behaviour from
`PLAN_NOOP_UPDATE_SUPPRESSION.md`. Setting `false` restores the pre-fix behaviour for
that channel.

---

## 3. Implementation

1. Add `suppressNoopUpdates?: boolean` to `ChannelConfig` in `config/loader.ts`.
2. Accept the key in config schema validation.
3. Wrap the guard in `_processRecords`:
   ```ts
   if (
     channel.suppressNoopUpdates !== false &&
     targetShadow !== undefined &&
     this._resolvedMatchesTargetShadow(resolved, targetShadow, remap.length ? remap : undefined)
   ) {
     results.push({ …, action: "skip" });
     continue;
   }
   ```
4. Tests:
   - `suppressNoopUpdates: false` — second poll of unchanged record → `"update"` (guard disabled).
   - `suppressNoopUpdates` absent (default) — second poll → `"skip"` (guard on).
