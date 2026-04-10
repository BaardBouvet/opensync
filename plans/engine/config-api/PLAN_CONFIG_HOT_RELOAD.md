# PLAN: Config Hot-Reload (Live Mapping Changes Without Engine Restart)

**Status:** draft  
**Date:** 2026-04-05  
**Domain:** packages/engine  
**Depends on:** nothing — prerequisite for `meta/PLAN_BROWSER_DEMO.md`

---

## 1. Problem

The engine is initialised once from a config object (channels, connectors, field mappings).
The shadow state and identity map are written using the field names as they flow through the
mapping layer — canonical hub field names depend on the rename maps in the active config.

If the user changes a field mapping at runtime and the engine simply reloads the config, the
next ingest will compute diffs against shadow rows whose field names were written under the
old mapping. This produces false positives (everything looks changed) or silent data loss
(old shadow fields are never matched against new canonical names).

This becomes important for the browser REPL demo where users edit `opensync.json` mappings
and expect to see effects without losing engine state.

---

## 2. Categories of config change

Not all config changes are equal. Classifying them by safety:

| Change type | Safe to hot-reload? | Reason |
|---|---|---|
| Add a new entity type to a channel | ✓ safe | No existing shadow rows affected |
| Add a new field to an existing mapping | ✓ safe | New field appears in future shadow rows; old rows missing it are treated as unset |
| Change a field's transform (value mapping) | ✓ safe | Shadow stores canonical values; re-diffing will pick up the effective change |
| Remove a field from a mapping | ✓ safe | Field silently drops from future dispatches; old shadow values become orphaned but don't cause errors |
| Rename a canonical field (change `as:`) | ✗ unsafe | Old shadow rows carry the old name; new ingest produces wrong diffs |
| Change a channel's connector assignment | ✗ unsafe | Identity map links connector-local IDs to hub UUIDs per channel; remapping would corrupt the links |
| Add a new channel | ✓ safe | No existing state; treated as initial onboarding on next ingest |
| Remove a channel | ✓ safe (with cleanup) | Orphaned shadow rows for the removed channel remain but are never read |

---

## 3. Proposed approach

### 3.1 Config diff on reload

When the user triggers a config reload, the engine diffs the new config against the old
before applying it. It classifies each change into **safe** or **unsafe** per the table above.

### 3.2 Safe changes — apply in place

Safe changes are applied immediately by updating the engine's internal config reference.
No shadow state migration needed. The engine continues from its current position.

### 3.3 Unsafe changes — offer three options

The engine surfaces unsafe changes to the caller with the list of affected channels and a
reason. The caller (or the UI) then chooses:

**a) Reject** — do not apply, keep current config. The safest default.

**b) Migrate** — for field renames: rewrite the affected shadow rows in-place so the old
canonical field name is replaced with the new one. This is a SQLite `UPDATE` across
`shadow_state` filtered by `channel_id`. Correct but potentially slow for large datasets.

**c) Reset affected channels** — delete all shadow state and identity map rows for the
affected channels, then apply the new config. The next ingest re-onboards those channels
as if they were new. Guaranteed correct; loses incremental history for those channels.

### 3.4 API

```ts
// New method on SyncEngine
engine.reloadConfig(newConfig: OpenSyncConfig): Promise<ConfigReloadResult>

type ConfigReloadResult =
  | { ok: true }
  | { ok: false; unsafeChanges: UnsafeChange[] }

type UnsafeChange = {
  type: 'field-rename' | 'connector-reassignment';
  channel: string;
  detail: string;
  fix: 'migrate' | 'reset-channel';
}

// To force-apply with a specific resolution per change:
engine.reloadConfig(newConfig, { resolution: 'reset-affected-channels' })
engine.reloadConfig(newConfig, { resolution: 'migrate' })
```

### 3.5 In the browser demo

The UI calls `engine.reloadConfig(editedConfig)`. If the result is `{ ok: true }`, the
next sync cycle proceeds normally. If there are unsafe changes, a banner explains what
happened and offers "Migrate" or "Reset these channels" buttons. This makes the
consequences visible and educational — fitting for a developer REPL.

---

## 4. Implementation steps

1. Write `diffConfig(oldConfig, newConfig): ConfigDiff` — pure function, no side effects
2. Write `classifyChanges(diff): { safe: Change[]; unsafe: UnsafeChange[] }` — per table above
3. Add `applyConfigDiff(safe: Change[]): void` to the engine — updates internal config ref
4. Add `migrateShadowFieldRename(channel, oldName, newName): void` — SQLite UPDATE
5. Add `resetChannelState(channel): void` — DELETE from shadow_state + identity_map for channel
6. Expose `engine.reloadConfig()` as the public entry point
7. Unit tests: one test per change category in the table above

---

## 5. Spec changes planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/sync-engine.md` | new §: Config Hot-Reload | Document `reloadConfig()`, the classification rules, and the three resolution strategies |
| `specs/database.md` | — | No changes — existing schema supports this without modification |
