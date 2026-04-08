# Plan: YAML-First Playground Scenarios

**Status:** complete  
**Date:** 2026-04-08  
**Effort:** M  
**Domain:** Playground UX  
**Scope:** `playground/src/scenarios/`, `playground/src/ui/editor-pane.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/config/schema.ts`, `packages/engine/src/index.ts`, `specs/playground.md §3.1, §3.4`  
**Spec:** `specs/playground.md §3.4`  
**Depends on:** none  

---

## § 1 Problem

The playground has two separate, inconsistent representations of a scenario:

1. **TypeScript source** — `scenarios/*.ts` files construct `ScenarioDefinition` objects
   (parsed `ChannelConfig[]` + `ConflictConfig`) programmatically. This is the authoritative
   source used to boot the engine.
2. **YAML display** — `scenarioToConfigYaml()` serialises the `ScenarioDefinition` back to
   YAML for display in the editor pane.

The serialiser is **lossy**: it only emits `id`, `identityFields`, and flat `fields`. Every
advanced feature — `identityGroups`, `array_path`, `element_key`, `parent_fields`, `parent`,
`associations`, conflict strategy — is silently dropped. Users see wrong YAML; if they click
Save + Reload, the engine boots with a stripped config and behaves differently from the
original TypeScript scenario.

### § 1.1 Root cause

There is no single source of truth. The engine has a documented canonical YAML format
(`channels:` + `mappings:` — same as `demo/examples/*/mappings/*.yaml`) but the playground
ignores it and maintains its own TypeScript-object representation that has no complete
serialisation path.

### § 1.2 Spec inconsistency

`specs/playground.md §3.4` shows a stale YAML example (`members:` inside `channels:`) that
was never the real format, and makes no mention of `conflict:`, `identityGroups`, array
expansion, or association keys.

---

## § 2 Revised Principle: YAML is the source of truth

**Configuration in OpenSync flows in one direction**: you write YAML (or the programmatic API)
and the engine parses/builds from it. There is no reverse path from parsed config back to
config text — that direction is never needed and is inherently lossy when function-typed fields
(expressions, normalizers) are involved.

For the playground this means:

- Scenario definitions **are** YAML strings. The `.ts` scenario files become wrappers that
  hold `label` + a raw YAML string (the canonical config).
- The editor pane displays that YAML string directly — no serialisation step.
- Save + Reload parses the edited YAML string through the engine's Zod schema + builder.
  There is no `scenarioToConfigYaml()`.

---

## § 3 Spec Changes Planned

| File | Section | Change |
|------|---------|--------|
| `specs/playground.md` | §3.1 | Add `rawYaml: string` field to scenario definition description |
| `specs/playground.md` | §3.4 | Replace stale YAML example with the real canonical `channels:` + `mappings:` + `conflict:` format |

No changes to `specs/sync-engine.md`, `specs/connector-sdk.md`, or `specs/field-mapping.md`.

---

## § 4 Approach

### § 4.1 Canonical YAML format (reference)

The authoritative source format is the same one used by `demo/examples/*/mappings/*.yaml`,
extended with a top-level `conflict:` block (playground-only; real deployments take conflict
from `opensync.json`).

Full example for the `array-demo` scenario:

```yaml
channels:
  - id: orders
    identityFields: [ref]
  - id: order-lines
    identityGroups:
      - fields: [orderRef, lineNo]

conflict:
  strategy: lww

mappings:
  # ── Channel: orders ────────────────────────────────────────────────────────
  - connector: erp
    entity: orders
    channel: orders
    fields:
      - { source: orderRef,  target: ref }
      - { source: total,     target: total }
      - { source: status,    target: status }
      - { source: date,      target: date }

  - connector: webshop
    entity: purchases
    channel: orders
    fields:
      - { source: purchaseRef, target: ref }
      - { source: amount,      target: total }
      - { source: state,       target: status }

  # ── Channel: order-lines (array expansion) ─────────────────────────────────
  - name: webshop_purchases_src
    connector: webshop
    entity: purchases
    channel: order-lines

  - parent: webshop_purchases_src
    entity: order_lines
    channel: order-lines
    array_path: lines
    element_key: lineNo
    parent_fields:
      purchaseRef: purchaseRef
    fields:
      - { source: lineNo,      target: lineNo }
      - { source: sku,         target: sku }
      - { source: quantity,    target: qty }
      - { source: linePrice,   target: unitPrice }
      - { source: purchaseRef, target: orderRef }

  - connector: erp
    entity: orderLines
    channel: order-lines
    fields:
      - { source: lineNo,    target: lineNo }
      - { source: sku,       target: sku }
      - { source: qty,       target: qty }
      - { source: unitPrice, target: unitPrice }
      - { source: orderRef,  target: orderRef }
```

### § 4.2 `ScenarioDefinition` type change

Replace the current type:

```ts
// BEFORE — programmatic representation
export interface ScenarioDefinition {
  label: string;
  channels: ChannelConfig[];
  conflict: ConflictConfig;
}
```

With a YAML-first type:

```ts
// AFTER — raw YAML is the source of truth
export interface ScenarioDefinition {
  label: string;
  /** Raw canonical YAML (channels: + mappings: + conflict:). */
  yaml: string;
}
```

The parsed `channels` and `conflict` are **derived** at boot time by parsing `yaml`. The rest of
the playground machinery (engine-lifecycle, systems-pane) continues to receive `ChannelConfig[]`
and `ConflictConfig` from the parsed result; the `ScenarioDefinition` type no longer carries them.

### § 4.3 Engine changes — exported pure builder

The channel-building logic inside `loadConfig()` must be extractable without file I/O or env
resolution. Extract it as:

```ts
// packages/engine/src/index.ts — new exports
export { buildChannelsFromEntries } from "./config/loader.js";
export { MappingsFileSchema } from "./config/schema.js";
export type { MappingEntry, FieldMappingEntry } from "./config/schema.js";
```

`buildChannelsFromEntries(channelDefs, mappingEntries)` contains steps 3a–3c of today's
`loadConfig()` (namedMappings index, sameChannelDescriptors, channel map build + member push).
No file I/O, no env resolution, no plugin loading. `loadConfig()` is refactored to call it.

### § 4.4 Schema change — `conflict:` block in mappings files

Extend `MappingsFileSchema` with an optional top-level `conflict:` block so playground YAML
files are self-contained:

```ts
export const MappingsFileSchema = z.object({
  mappings:  z.array(MappingEntrySchema).optional(),
  channels:  z.array(ChannelDefSchema).optional(),
  conflict:  ConflictConfigSchema.optional(),   // ← new
});
```

`loadConfig()` currently ignores `conflict:` in mapping files (conflict comes from
`opensync.json`). That is preserved — the new field is parsed but `loadConfig()` does not use it.

### § 4.5 Playground changes

**Scenario files** (`scenarios/*.ts`): each file now exports:

```ts
const scenario: ScenarioDefinition = {
  label: "array-demo (webshop nested lines → erp flat orderLines)",
  yaml: `
channels:
  - id: orders
    ...
mappings:
  ...
conflict:
  strategy: lww
`,
};
export default scenario;
```

Converting the existing four scenarios to inline YAML is mechanical.

**`editor-pane.ts`**:

- `scenarioToConfigYaml()` — **deleted**. The editor is initialised with `scenario.yaml`
  directly; no serialisation ever runs.
- `mergeConfigYaml(existing, raw)` — renamed `parseScenarioYaml(existing, raw)` and
  simplified:

```ts
import { parse as parseYaml } from "yaml";
import { MappingsFileSchema, buildChannelsFromEntries } from "@opensync/engine";

function parseScenarioYaml(
  existing: ScenarioDefinition,
  raw: string,
): { channels: ChannelConfig[]; conflict: ConflictConfig } {
  const parsed = MappingsFileSchema.parse(parseYaml(raw));
  const channels = buildChannelsFromEntries(
    parsed.channels ?? [],
    parsed.mappings ?? [],
  );
  return {
    channels,
    conflict: parsed.conflict ?? existing_default_conflict,
  };
}
```

On Save, the editor stores the validated raw string back into the running scenario's `yaml`
field and calls boot with the parsed channels + conflict.

**JS expression strings**: `filter`, `reverse_filter`, `expression`, `reverse_expression`,
`normalize`, and `resolve` are all plain JS expression strings in the YAML schema, compiled
at parse time via `new Function`. They can be written directly in scenario YAML.

**Programmatic-only field function**: `defaultExpression` is the only exception — it receives
the partially-built canonical record as context, which requires TypeScript. Any scenario using
`defaultExpression` must use the TypeScript embedded API and is not editable in the playground
YAML editor. No existing playground scenario uses it.

---

## § 5 Implementation Steps

1. **Engine — extract `buildChannelsFromEntries`**: refactor step-3 of `loadConfig` into the
   new pure function; add to `index.ts` exports.
2. **Engine — extend schema**: add `ConflictConfigSchema` and the optional `conflict:` field
   to `MappingsFileSchema`; export `MappingsFileSchema`, `MappingEntry`, `FieldMappingEntry`.
3. **Playground — migrate scenario type**: update `ScenarioDefinition` to `{ label, yaml }`;
   update `engine-lifecycle.ts` to call `buildChannelsFromEntries` at boot.
4. **Playground — convert scenarios**: rewrite each `.ts` scenario file from a TS
   ChannelConfig builder to an inline YAML string.
5. **Playground — simplify editor-pane**: delete `scenarioToConfigYaml()`; initialise editor
   with `scenario.yaml`; replace `mergeConfigYaml` with `parseScenarioYaml` (§4.5).
6. **Spec — update `specs/playground.md §3.1` + `§3.4`** per §3 above.
7. **Tests**: for each bundled scenario, parse the YAML and assert the resulting
   `ChannelConfig[]` matches a known-good snapshot (smoke test that no YAML is malformed).

---

## § 6 Risks

- **`buildChannelsFromEntries` in the browser** — `compileElementFilter`/`compileRecordFilter`
  use `new Function()`, blocked by strict CSP. The playground already uses `new Function` (the
  engine runs in-browser today), so no new risk is introduced. Note this in docs.
- **Filter expressions in scenario YAML** — a typo in a `filter:` string throws at parse
  time rather than silently silently being ignored. This is the desired behaviour; surface the
  error in the "Save + Reload" error dialog.
