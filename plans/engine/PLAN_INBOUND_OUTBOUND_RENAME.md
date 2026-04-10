# Inbound / Outbound Terminology Rename

**Status:** proposed  
**Date:** 2026-04-10  
**Effort:** M  
**Domain:** Engine config, specs, playground UI  
**Scope:** `packages/engine/src/config/`, `packages/engine/src/core/`, `packages/engine/src/engine.ts`, `playground/src/ui/lineage-model.ts`, `specs/`, tests  

---

## § 1 Problem

The codebase uses two different naming frames for the same two directions, causing
discoverable confusion (see plans/engine/PLAN_ATOMIC_ARRAY.md §1.3):

| Concept | Used in config/YAML | Used in TypeScript API | Used in spec narrative |
|---------|---------------------|------------------------|------------------------|
| Data flows **into** the channel (source → canonical) | `forward_only` (direction enum) | — | "Forward pass" |
| Data flows **out of** the channel (canonical → target) | `reverse_only` (direction enum), `reverse_expression`, `reverse_filter`, `reverseRequired` | `reverseExpression`, `reverseRequired` | "Reverse pass" |
| Internal compiled filters | — | `elementReverseFilter`, `recordReverseFilter` | — |

The word "reverse" is the loaded term. It names the direction relative to the initial read
operation (so "reverse" means "going back to the source"), but that framing is confusing
when a channel has many connectors and there is no canonical "source" direction.

The engine already uses `inbound` / `outbound` as the runtime pass labels in `applyMapping()`
(`pass === "inbound"` / `pass === "outbound"`), and `ChannelMember.inbound` / `.outbound`
as the compiled mapping lists. The goal is to surface that same vocabulary everywhere.

**Direction**: "inbound" means data flowing **into** the channel (connector → canonical).
"Outbound" means data flowing **out of** the channel (canonical → connector).

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §1.2 Field direction | Rename table entries `forward_only` → `outbound_only`, `reverse_only` → `inbound_only`; rename YAML examples; update prose |
| `specs/field-mapping.md` | §1.3 Field expressions | Rename YAML key `reverse_expression` → `outbound_expression`; rename TypeScript `reverseExpression` → `outboundExpression`; update prose and spec-status note |
| `specs/field-mapping.md` | §3 / §3.5 Filters | Rename `reverse_filter` → `outbound_filter` throughout |
| `specs/field-mapping.md` | §8.4 `reverse_required` | Rename section and key to `outbound_required` |
| `specs/field-mapping.md` | All "forward pass" / "reverse pass" references | Replace with "inbound pass" / "outbound pass" |
| `specs/field-mapping.md` | Coverage table (end of file) | Update `reverse_required`, `reverse_expression` rows |
| `specs/config.md` | §Field direction table | Rename enum values |
| `specs/config.md` | `reverse_expression` / `reverse_filter` / `reverseRequired` rows in the field reference table | Rename |
| `specs/config.md` | All "forward pass" / "reverse pass" prose | Replace terminology |
| `specs/sync-engine.md` | Embedded `FieldMapping` type snippet | Update direction enum string values |
| `specs/safety.md` | "forward pass" / "reverse pass" references | Replace terminology |

---

## § 3 Rename Map

### § 3.1 YAML config keys (public API — breaking change for any pre-release users)

| Old YAML key / value | New YAML key / value | Notes |
|----------------------|----------------------|-------|
| `direction: forward_only` | `direction: outbound_only` | enum value on `fields` entries |
| `direction: reverse_only` | `direction: inbound_only` | enum value on `fields` entries |
| `direction: bidirectional` | `direction: bidirectional` | **unchanged** — symmetry is clear |
| `reverse_expression: "..."` | `outbound_expression: "..."` | field-level YAML key in `fields` |
| `reverse_filter: "..."` | `outbound_filter: "..."` | mapping-entry level YAML key |
| `reverseRequired: true` | `outbound_required: true` | field-level YAML key; also normalise casing to snake_case for consistency with all other keys |

### § 3.2 TypeScript API (public `FieldMapping` interface — breaking change)

| Old property | New property | Notes |
|--------------|--------------|-------|
| `direction: "forward_only"` | `direction: "outbound_only"` | string literal in the union |
| `direction: "reverse_only"` | `direction: "inbound_only"` | string literal in the union |
| `reverseExpression` | `outboundExpression` | optional function on `FieldMapping` |
| `reverseRequired` | `outboundRequired` | optional boolean on `FieldMapping` |

**`expression` and `filter` are unchanged.** Both are inbound-only in practice, but the
bare names are already natural and renaming would needlessly break all existing embedded
API callers.

### § 3.3 Internal TypeScript identifiers (non-public — rename freely)

| Old identifier | New identifier | Location |
|----------------|----------------|----------|
| `elementReverseFilter` | `elementOutboundFilter` | `ChannelMember` interface, `loader.ts`, `engine.ts`, test files |
| `recordReverseFilter` | `recordOutboundFilter` | `ChannelMember` interface, `loader.ts`, `engine.ts` |
| `compileReverseExpression` | `compileOutboundExpression` | `loader.ts` private function |

### § 3.4 Spec / comment narrative

| Old phrase | New phrase |
|------------|------------|
| "Forward pass (ingest)" | "Inbound pass (ingest)" |
| "Reverse pass (dispatch)" | "Outbound pass (dispatch)" |
| "forward pass" (lowercase) | "inbound pass" |
| "reverse pass" (lowercase) | "outbound pass" |

---

## § 4 File-by-File Change Inventory

### § 4.1 Config schema — `packages/engine/src/config/schema.ts`

```
FieldDirectionSchema  z.enum(["bidirectional", "forward_only", "reverse_only"])
                   →  z.enum(["bidirectional", "outbound_only", "inbound_only"])

FieldMappingEntrySchema:
  reverse_expression: z.string().optional()
                   →  outbound_expression: z.string().optional()

  reverseRequired: z.boolean().optional()
               →   outbound_required: z.boolean().optional()

MappingEntrySchema:
  reverse_filter: z.string().optional()
              →   outbound_filter: z.string().optional()
```

### § 4.2 Config loader — `packages/engine/src/config/loader.ts`

`FieldMapping` interface:
```
  direction?: "bidirectional" | "forward_only" | "reverse_only"
          →   direction?: "bidirectional" | "outbound_only" | "inbound_only"

  reverseExpression?: ...   →  outboundExpression?: ...
  reverseRequired?: boolean →  outboundRequired?: boolean
```

`ChannelMember` interface:
```
  elementReverseFilter? → elementOutboundFilter?
  recordReverseFilter?  → recordOutboundFilter?
```

Function renames:
```
  compileReverseExpression → compileOutboundExpression
```

All property-access call sites updating `reverse_expression`, `reverse_filter`,
`reverseRequired`, and the direction string checks inside `buildInbound` / `buildOutbound`.

### § 4.3 Core mapping — `packages/engine/src/core/mapping.ts`

```
  if (dir === "forward_only") continue;   →  if (dir === "outbound_only") continue;
  if (dir === "reverse_only") continue;   →  if (dir === "inbound_only") continue;
  m.reverseExpression                     →  m.outboundExpression
  m.reverseRequired                       →  m.outboundRequired
```

### § 4.4 Engine — `packages/engine/src/engine.ts`

```
  targetMember.recordReverseFilter   →  targetMember.recordOutboundFilter
  collapseTarget.elementReverseFilter →  collapseTarget.elementOutboundFilter
  comments referencing "reverse_filter" → "outbound_filter"
```

### § 4.5 Playground lineage model — `playground/src/ui/lineage-model.ts`

```
  direction: "bidirectional" | "forward_only" | "reverse_only"
          →  direction: "bidirectional" | "outbound_only" | "inbound_only"
```

### § 4.6 Test files

| File | Changes |
|------|---------|
| `packages/engine/src/core/mapping.test.ts` | Rename all `"forward_only"` / `"reverse_only"` string literals; rename `reverseExpression` properties; update test-ID descriptions (FE5/FE6/FE8/RR series) to match new names |
| `packages/engine/src/multilevel-array.test.ts` | Rename `elementReverseFilter` access, rename `reverse_filter` YAML key in inline config fixture, update describe/it descriptions |
| `packages/engine/src/id-field.test.ts` | Rename `direction: "reverse_only"` literal, update describe/it descriptions |

### § 4.7 Spec files

See §2 above for the full per-section list. Key files:

- `specs/field-mapping.md` — ~20 sites (direction table, §1.3, §3.3/3.5, §8.4, coverage table, all narrative pass mentions)
- `specs/config.md` — direction table + field-reference table rows + narrative
- `specs/sync-engine.md` — embedded direction enum
- `specs/safety.md` — forward/reverse pass narrative

---

## § 5 What Is NOT Being Renamed

| Term | Reason to keep |
|------|----------------|
| `expression` | Inbound-only in practice; renaming to `inbound_expression` would be verbose for the common case; no "reverse" confusion exists |
| `filter` | Same as above |
| `bidirectional` | Already neutral and clear |
| `ChannelMember.inbound` / `.outbound` compiled lists | Already use the correct terminology |
| `buildInbound()` / `buildOutbound()` functions in loader | Already use the correct terminology |
| Internal pass label string `"inbound"` / `"outbound"` in `applyMapping()` | Already correct |

---

## § 6 Implementation Order

1. **Specs first** (§4.7) — update spec files so the code rename has a reference to compare against.
2. **Schema** (§4.1) — enum and YAML key renames. Tests immediately fail; keep them red until §3.
3. **Loader** (§4.2) — interface and function renames; update all property reads from `FieldMappingEntry`.
4. **Core mapping** (§4.3) — string-literal checks and property access.
5. **Engine** (§4.4) — internal property access.
6. **Playground** (§4.5) — direction type.
7. **Tests** (§4.6) — update all string literals, property accesses, and descriptions.
8. `bun run tsc --noEmit` + `bun test` must both pass clean before committing.

---

## § 7 Risk

- **Zero semantic risk** — this is a pure rename; no algorithm changes.
- **Broad touch surface** — ~8 source files, ~3 test files, ~5 spec files. Mechanical but tedious. A single grep/sed pass per old name followed by type-check is the fastest safe approach.
- **Playground dist bundle** — `playground/dist/` is a build artifact; rebuild after the source change.
- **Plans directory** — historical plan files that mention the old names (`PLAN_ATOMIC_ARRAY.md`, `PLAN_PK_AS_CHANNEL_FIELD.md`, etc.) are not updated. They are historical records; their old names are self-consistent within their own context.
