# PLAN: Per-channel opt-out for echo detection

**Status:** backlog  
**Domain:** packages/engine

---

## 1. Motivation

Echo detection (`_shadowMatchesIncoming`) is always on. When a source record returns the
same value it had on the previous poll, the engine skips fan-out entirely — no target
write happens.

This is correct in the common case, but there is one scenario where it causes drift to go
unhealed: **the source record has not changed, but the target was modified externally
outside OpenSync**. Echo detection sees "nothing new" and skips indefinitely. The target
never gets pushed back to the canonical value.

Users who know their target connectors may be written by external systems need a way to
force unconditional re-push per channel.

---

## 2. Config shape

```ts
// packages/engine/src/config/loader.ts
export interface ChannelConfig {
  id: string;
  members: ChannelMember[];
  identityFields?: string[];
  echoDetection?: boolean; // default true (guard on); set false to disable
}
```

Setting `echoDetection: false` means every inbound source record fans out to all targets
on every poll, regardless of whether the source shadow matches.

---

## 3. Trade-off

Disabling echo detection increases write volume: every non-changed source record generates
a target write on every poll cycle. With noop update suppression active (the default after
`PLAN_NOOP_UPDATE_SUPPRESSION.md`), most of these re-pushed writes will be suppressed at
the target side anyway — the extra cost is mainly the `resolveConflicts` call and the
`_resolvedMatchesTargetShadow` comparison per record per cycle.

If noop suppression is also disabled (`suppressNoopUpdates: false`), every poll generates
a real target dispatch for every unchanged source record.

---

## 4. Implementation

1. Add `echoDetection?: boolean` to `ChannelConfig` in `config/loader.ts`.
2. Accept the key in config schema validation.
3. Wrap the echo detection guard in `_processRecords`:
   ```ts
   if (channel.echoDetection !== false && !isResurrection && existingShadow !== undefined) {
     const same = this._shadowMatchesIncoming(existingShadow, canonical, assocSentinel);
     if (same) { …skip… }
   }
   ```
4. Tests:
   - `echoDetection: false` — source record unchanged → still fans out (action `"update"` or suppressed by noop guard).
   - `echoDetection` absent (default) — source record unchanged → `"skip"`.
