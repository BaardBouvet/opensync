# Plan: POC v3 — Content-Based Echo Detection

**Status:** `complete`
**Depends on:** v2 POC (complete)

## Goal

Replace the echo *set* (consume-on-sight, requires all passes every cycle) with a
`lastWritten` *store* (compare-on-read, pass-order independent). This eliminates
the most fragile constraint inherited from v0: that the caller must run all directed
pairs in a single cycle or echoes accumulate silently.

All other v2 mechanics (declarative config, canonical field model, N-way channels,
patch semantics, rename maps) are carried forward unchanged.

---

## The Problem with Echo Sets

The v2 echo set works like this:

```
A→B writes Alice  →  echoes["B"]["A"] = { aliceBId }
B→A reads Alice   →  aliceBId found in set → skip, delete from set
```

The delete-on-sight design creates a coupling between passes: the echo entry only
disappears when the reverse pass runs and encounters it. If anything interrupts the
cycle — a delayed pass, a test that only checks one direction, a crash between
passes — the entry persists and silently suppresses the next genuine change from B.

This is what caused the test failure in v2 step 2: step 1 ran A→B but not B→A,
leaving `aliceBId` in the echo set. When step 2 ran B→A after editing Alice,
the genuine update was swallowed as a stale echo.

---

## The Fix: Content-Based Echo Detection

Instead of tracking IDs, the engine tracks **what it last wrote** to each connector
for each record, in canonical form.

```
lastWritten[connectorId][entityName][recordId] = canonicalData
```

### On write (insert or update to a target connector)

After applying the target member's `outbound` renames to get the local record,
store the canonical record (before outbound renames — i.e. the engine's internal
representation) under the target connector, entity, and the target record's ID:

```typescript
lastWritten["B"]["customers"][aliceBId] = { customerName: "Alice Smith" }
```

### On read (before deciding to propagate)

After applying the source member's `inbound` renames to get the canonical record,
compare it to `lastWritten[sourceConnectorId][entityName][sourceRecordId]`.

- **Match** → this record's canonical fields are identical to what the engine last
  wrote here. It is our own write bouncing back. Skip it (do not propagate).
- **No entry** → never written by the engine. Treat as a genuine source record.
- **Mismatch** → the record has been externally modified since the engine last wrote
  it. Propagate the change.

```
A→B writes { customerName: "Alice Smith" }
  → lastWritten["B"]["customers"][aliceBId] = { customerName: "Alice Smith" }

[some time later, B→A runs]
B→A reads Alice from B → canonical: { customerName: "Alice Smith" }
  → matches lastWritten["B"]["customers"][aliceBId]
  → skip (echo)

[user edits customerName in B to "Alicia Smith"]
B→A reads Alice from B → canonical: { customerName: "Alicia Smith" }
  → does not match lastWritten["B"]["customers"][aliceBId]
  → propagate (genuine change)
  → A→B writes { customerName: "Alicia Smith" }
  → lastWritten["B"]["customers"][aliceBId] = { customerName: "Alicia Smith" }
```

### Why canonical comparison is correct

The comparison uses canonical fields only — not raw local fields. A connector may
add its own metadata on write (a server-assigned ETag, a `modifiedBy` audit field,
a processed timestamp). These will appear in the raw read but not in the canonical
record after `inbound` renames, so they never cause false mismatches.

The `lastWritten` entry is never deleted — it is overwritten on the next write.
This means a delayed or repeated read of the same unchanged record is still
correctly identified as an echo, regardless of how many poll cycles have passed.

---

## Comparison: Echo Set vs lastWritten Store

| Property | Echo set (v2) | lastWritten store (v3) |
|----------|---------------|------------------------|
| Echo recognised after | Same cycle only | Any future cycle |
| Pass ordering required | Yes — all passes same cycle | No |
| Entry lifecycle | Deleted on first sight | Overwritten on next write |
| Handles delayed passes | No | Yes |
| Handles crash between passes | No | Yes (entry persists) |
| Comparison basis | Record ID | Canonical field values |
| Connector-added metadata | Not an issue | Not an issue (canonical only) |

---

## State Shape

```typescript
/**
 * Canonical data last written by the engine to a specific record in a specific
 * connector. Used for content-based echo detection.
 *
 * lastWritten[connectorId][entityName][recordId] = canonicalData
 */
type LastWritten = Record<string, Record<string, Record<string, Record<string, unknown>>>>;
```

This is serialisable and can be included in `EngineState` alongside `identityMap`
and `watermarks`, so echo detection survives process restarts.

---

## Comparison Logic

A shallow equality check over canonical fields is sufficient. Field values come
from JSON-serialisable connector data; reference equality is meaningless. Two
canonical records are equal if they have the same keys and the same values under
`JSON.stringify` with sorted keys (to be order-independent).

```typescript
function canonicalEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const stable = (o: Record<string, unknown>) =>
    JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
  return stable(a) === stable(b);
}
```

---

## What Does Not Change

- `RenameMap`, `applyRename` — unchanged.
- `sync(channelId, fromId, toId)` signature — unchanged.
- State serialisation pattern (`toJSON`/`fromJSON`) — extended to include `lastWritten`.
- Patch semantics for `update()` — unchanged.

---

## Config Style Exploration (inspired by OSI-mapping)

### Background

The [OSI-mapping](https://github.com/BaardBouvet/OSI-mapping) schema uses a clean
three-section structure for integration configuration:

- **`sources`** — connector instances (just identity + primary key, no mapping)
- **`targets`** — the canonical model: field names + per-field resolution strategy
  (`identity`, `coalesce`, `last_modified`, `expression`)
- **`mappings`** — a flat list; each entry wires one connector to one channel via
  explicit field-level mappings (`source: localField`, `target: canonicalField`)

Mappings are first-class citizens, separate from both connector declarations and
channel declarations. This separates three genuinely orthogonal concerns that the
v2 config conflates into a single `ChannelMember` object.

OSI-mapping also introduces several ideas that are directly relevant to opensync's
design gaps:

| OSI-mapping concept | Relevance to opensync |
|---------------------|----------------------|
| `written_state` + `derive_noop` | Directly equivalent to the v3 `lastWritten` store — OSI-mapping solves the same "don't re-propagate what you just wrote" problem via an ETL-maintained table |
| Per-field `direction` (`bidirectional`, `forward_only`, `reverse_only`) | Opensync's `inbound`/`outbound` separate maps achieve the same thing but are harder to read side-by-side |
| Resolution strategies (`coalesce`, `last_modified`) on target fields | Completely absent from opensync — currently last-write-wins with no declared preference |
| `references` on FK fields | Direct equivalent of `_associations` in opensync; OSI-mapping makes FK resolution a first-class field-level declaration rather than a separate array |

---

### Config Style A — Channel-centric (v2, current)

```typescript
const config: EngineConfig = {
  connectors: [connectorA, connectorB, connectorC],
  channels: [
    {
      id: "customers",
      members: [
        { connectorId: "A", entity: "customers", inbound: { name: "customerName" }, outbound: { customerName: "name" } },
        { connectorId: "B", entity: "customers" },
        { connectorId: "C", entity: "customers", inbound: { fullName: "customerName" }, outbound: { customerName: "fullName" } },
      ],
    },
    {
      id: "orders",
      members: [
        { connectorId: "A", entity: "orders" },
        { connectorId: "B", entity: "orders" },
        { connectorId: "C", entity: "orders" },
      ],
    },
  ],
};
```

### Config Style B — Connector-centric

Channels are declared as slots; each connector block owns its participation in
each channel. To answer "what does connector A do?", read only the A block.

```typescript
const config = {
  channels: [
    { id: "customers" },
    { id: "orders" },
  ],
  connectors: [
    {
      id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx),
      channels: {
        customers: { entity: "customers", inbound: { name: "customerName" }, outbound: { customerName: "name" } },
        orders:    { entity: "orders" },
      },
    },
    {
      id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx),
      channels: {
        customers: { entity: "customers" },
        orders:    { entity: "orders" },
      },
    },
    {
      id: "C", ctx: cCtx, entities: connector.getEntities!(cCtx),
      channels: {
        customers: { entity: "customers", inbound: { fullName: "customerName" }, outbound: { customerName: "fullName" } },
        orders:    { entity: "orders" },
      },
    },
  ],
};
```

### Config Style C — OSI-mapping inspired (three sections)

Inspired by OSI-mapping's `sources` / `targets` / `mappings` separation.
Connectors, channels, and field wiring are all declared independently. Field
mappings use explicit `source`/`target` pairs (instead of two separate rename maps)
and support a `direction` flag.

```typescript
const config = {
  // Channels: just named slots. No field declarations yet — opensync doesn't
  // have resolution strategies, but this is where they would live.
  channels: [
    { id: "customers" },
    { id: "orders" },
  ],

  // Connectors: runtime instances only — no mapping info here.
  connectors: [
    { id: "A", ctx: aCtx, entities: connector.getEntities!(aCtx) },
    { id: "B", ctx: bCtx, entities: connector.getEntities!(bCtx) },
    { id: "C", ctx: cCtx, entities: connector.getEntities!(cCtx) },
  ],

  // Mappings: flat list — each entry wires one connector to one channel.
  // Fields are explicit pairs; direction defaults to "bidirectional".
  mappings: [
    {
      connectorId: "A",
      channelId: "customers",
      entity: "customers",
      fields: [
        { source: "name", target: "customerName" },
        // direction: "bidirectional" (default) — renamed both ways
      ],
    },
    {
      connectorId: "B",
      channelId: "customers",
      entity: "customers",
      fields: [
        { source: "customerName", target: "customerName" },
      ],
    },
    {
      connectorId: "C",
      channelId: "customers",
      entity: "customers",
      fields: [
        { source: "fullName", target: "customerName" },
      ],
    },
    { connectorId: "A", channelId: "orders", entity: "orders" },
    { connectorId: "B", channelId: "orders", entity: "orders" },
    { connectorId: "C", channelId: "orders", entity: "orders" },
  ],
};
```

### Trade-off comparison

| Property | A: channel-centric | B: connector-centric | C: OSI-inspired |
|----------|--------------------|----------------------|-----------------|
| See all participants in a channel | One place | Must scan connectors | Must scan mappings |
| See all channels for a connector | Must scan channels | One place | Must scan mappings |
| Adding a connector | Edit every channel block | Add one block | Add block + entries |
| Field mapping lives with | Channel | Connector | Mapping (independent) |
| `direction` per field | No (separate maps) | No (separate maps) | Yes (string flag) |
| Config is serialisable (JSON/YAML) | Yes | Yes | Yes |
| Channels and connectors evolve independently | No | No | Yes |

---

### Version Control, Multi-team, and the One-Document Decision

**The config must be plain data in version control.** Connector instances carry
runtime state (auth tokens, HTTP clients, file paths) that clearly belongs in code,
but the *wiring* — which channels exist, which connectors participate, how fields
are named — is configuration. It should live in a YAML or JSON file committed
alongside the project, diffable, reviewable, and editable without a TypeScript
compiler.

**One document, not one-file-per-connector.** The temptation to split config across
files (one per connector, one per channel) seems attractive for large teams but
creates more problems than it solves:

- **Cross-references break locality.** A mapping entry must reference both a
  `connectorId` and a `channelId`. If those are defined in separate files, a
  reviewer must jump between files to verify correctness. In one document the
  full picture is a single scroll.
- **Most open source projects ship one config file.** `docker-compose.yml`,
  `webpack.config.js`, `tsconfig.json`, `.eslintrc`, GitHub Actions workflow files
  — all of these mix concerns that belong to different teams and all deliberately
  stay as one document. The ecosystem has established tooling (diff viewers, schema
  validators, lint rules) around single-file configs.
- **File splitting is opt-in via `$ref` or `include`.** If a project genuinely
  outgrows a single file, YAML anchors or a merge step can compose multiple files
  into one schema-valid document. This is an escape hatch, not the default. The
  schema should be designed for one file; tooling for multi-file composition can
  come later.

**Code review ergonomics for Style C.** Because `connectors`, `channels`, and
`mappings` are separate top-level arrays, a PR that adds a new connector produces
a diff with three clearly scoped additions:

```diff
  connectors:
+   - id: hubspot
+     plugin: "@opensync/hubspot"

  channels:
    - id: customers   # unchanged

  mappings:
+   - connector: hubspot
+     channel: customers
+     entity: contacts
+     fields:
+       - { source: firstname, target: customerName }
```

Compare this to Style A, where adding a connector means inserting into every
channel block — the diff is scattered and the reviewer must mentally re-assemble
the picture.

**Style B has the same review problem, inverted.** Adding a new channel means
editing every connector block. In large deployments with many connectors, this is
the more common operation (channels are stable; connectors come and go).

**Decision: Style C, one document.**

The `opensync.yaml` (or `opensync.json`) file will contain three top-level keys:

```
connectors:  — one entry per connector instance (id, plugin, auth config)
channels:    — one entry per channel (id, canonical field list, resolution rules)
mappings:    — one entry per connector×channel pair (field-level wiring)
```

The engine reads the file, instantiates the connector plugins, and builds the
internal `ChannelMember` representation at startup. Teams editing different
connectors will touch different `mappings` entries and different `connectors`
entries — natural conflict isolation without requiring separate files.

---

### Config file format: YAML

**YAML vs the alternatives:**

| Format | Comments | Multi-line strings | Footguns | Parsing |
|--------|----------|--------------------|----------|---------|
| YAML | ✅ yes | ✅ yes | ⚠️ some (Norway problem, tab/space) | requires `js-yaml` or similar |
| TOML | ✅ yes | ✅ yes | ✅ minimal | requires `@iarna/toml` |
| JSON | ❌ no | ❌ awkward | ✅ none | built-in |
| JSON5 | ✅ yes | ✅ yes | ✅ minimal | requires `json5` |

YAML is the right choice here. Comments are important for a config that multiple
teams edit — anyone adding a connector field mapping should be able to explain
*why* the rename exists inline. YAML is also the dominant format in the ecosystem
that this tool targets (GitHub Actions, Docker Compose, Kubernetes, most CI/CD
tooling), so users will be fluent in it. The parser footguns (Norway problem,
implicit type coercion) are manageable: field names and values in an opensync
config are always strings, so a schema validator catches mistyped values early.

---

### YAML sketch: `opensync.yaml` for the v3 three-connector POC

```yaml
version: "1"

# ─── Connectors ───────────────────────────────────────────────────────────────
# One entry per connector instance.
# "plugin" is the connector package or local path.
# "config" is plugin-specific; its shape is defined by the connector's own schema.
# Secrets should reference environment variables (not inline values).

connectors:
  - id: A
    plugin: "@opensync/jsonfiles"
    config:
      dataDir: ./data/connector-a

  - id: B
    plugin: "@opensync/jsonfiles"
    config:
      dataDir: ./data/connector-b

  - id: C
    plugin: "@opensync/jsonfiles"
    config:
      dataDir: ./data/connector-c

# ─── Channels ─────────────────────────────────────────────────────────────────
# One entry per logical data channel. The channel defines the canonical field
# names; future versions will add resolution strategies here.

channels:
  - id: customers
  - id: orders

# ─── Mappings ─────────────────────────────────────────────────────────────────
# One entry per connector×channel pair. Each entry wires a connector's local
# entity into a channel, with optional per-field rename declarations.
#
# Field direction defaults to "bidirectional". Use "read_only" (read from this
# connector but never write back) or "write_only" (injected on write, never read).
#
# Omitting "fields" means all fields pass through under their local names
# (assumes local names already match the canonical names).

mappings:
  - connector: A
    channel: customers
    entity: customers
    fields:
      # A stores "name"; the canonical field is "customerName"
      - source: name
        target: customerName

  - connector: B
    channel: customers
    entity: customers
    # B already uses "customerName" — no field renames needed

  - connector: C
    channel: customers
    entity: customers
    fields:
      - source: fullName
        target: customerName

  - connector: A
    channel: orders
    entity: orders

  - connector: B
    channel: orders
    entity: orders

  - connector: C
    channel: orders
    entity: orders
```

---

### What stays in code vs. what moves to YAML

| Concern | YAML | Code (`run.ts`) |
|---------|------|-----------------|
| Connector IDs | ✅ | — |
| Plugin name / path | ✅ | — |
| Plugin config (dataDir, etc.) | ✅ | — |
| Channel IDs | ✅ | — |
| Field mappings + direction | ✅ | — |
| Poll interval | ✅ (or env var) | — |
| Auth secrets | ❌ — env var refs | Injected at startup |
| Connector instantiation | — | ✅ plugin loader resolves `plugin:` → JS module |
| Seed data (first-run bootstrap) | — | ✅ |
| Poll loop | — | ✅ |
| Engine + state management | — | ✅ |

The plugin loader is the only new piece of non-trivial code that `run.ts` needs:
given a `plugin:` string, resolve it as either an npm package name
(`@opensync/hubspot`) or a relative path (`./connectors/jsonfiles`), import it,
call `getEntities(ctx)`, and return a `ConnectorInstance`. Everything else in
`run.ts` already exists.
This is the JavaScript equivalent of Java reflection. In Java you'd write
`Class.forName("com.example.HubspotConnector").getDeclaredConstructor().newInstance()`.
In JavaScript/TypeScript it's a dynamic `import()`, which accepts a string resolved
at runtime and returns the module's exports:

```typescript
// Java analogy: Class.forName(plugin) → newInstance() → call method
async function loadConnector(plugin: string): Promise<Connector> {
  // Resolves npm package name or relative path — no compile-time dependency needed.
  const mod = await import(plugin);
  return (mod.default ?? mod) as Connector;
}

async function instantiate(entry: ConfigConnector): Promise<ConnectorInstance> {
  const plugin = await loadConnector(entry.plugin);
  const ctx = buildCtx(entry.config);         // auth, dataDir, etc. from YAML
  return {
    id: entry.id,
    ctx,
    entities: plugin.getEntities?.(ctx) ?? [],
  };
}
```

`plugin.getEntities` is then just a normal function call — same as `run.ts` already
does with the statically-imported connector. The only difference is that the module
was loaded from a string at runtime rather than resolved at compile time via a
static `import` statement. Bun and Node both support dynamic `import()` natively;
no extra dependency is needed.
---

### Design decisions to resolve

1. **`dataDir` vs explicit `filePaths`** — The v2 jsonfiles connector takes a
   `filePaths` array. Exposing a `dataDir` in the config and having the connector
   derive the paths internally is cleaner for the config file, but requires a
   contract change in the connector. The POC can use `filePaths` directly; `dataDir`
   is a future connector improvement.

2. **Env var interpolation syntax** — Secrets should not be committed. Options:
   - `apiKey: ${HUBSPOT_API_KEY}` — shell-style, familiar from Docker Compose
   - `apiKey: !env HUBSPOT_API_KEY` — YAML custom tag
   - A separate `.env` file loaded before config parsing (simplest for the POC)
   
   Shell-style `${VAR}` is the most recognisable and easiest to implement with a
   simple string replacement pass before YAML parsing.

3. **Directed pairs generation** — The v2 `run.ts` hardcodes all N×(N-1) directed
   pairs. With a config, the engine can derive them automatically: for each channel,
   generate a directed pair for every ordered combination of its mapping entries.
   No manual specification needed. This also removes the risk of forgetting a pair.

4. **`version:` field** — Always `"1"` for now. Enables schema evolution later
   without breaking existing files; the loader can reject unknown versions with a
   clear error message.

### Work items

| # | Task |
|---|------|
| 13 | Design and document `opensync.yaml` JSON Schema (Draft 2020-12) for `version`, `connectors`, `channels`, `mappings` |
| 14 | Implement `loadConfig(path)`: read YAML, validate against schema, return typed `OpenSyncConfig` |
| 15 | Implement plugin loader: `plugin:` string → npm package or local path → `ConnectorInstance` |
| 16 | Implement normaliser: `OpenSyncConfig` → `EngineConfig` (internal `ChannelMember[]` representation) |
| 17 | Implement directed-pair auto-derivation from channel membership (replace hardcoded pairs in `run.ts`) |
| 18 | Rewrite `run.ts` to load `opensync.yaml`, wire everything up, run poll loop |
| 19 | Write `poc/v3/opensync.yaml` matching the three-connector POC scenario |

---

## Work Items

| # | Task |
|---|------|
| 1 | Add `lastWritten` to `EngineState`; extend `toJSON`/`fromJSON` |
| 2 | Implement `canonicalEqual(a, b)` — pure function |
| 3 | On write: store canonical record in `lastWritten` after insert/update |
| 4 | On read: compare incoming canonical record to `lastWritten` entry; skip on match |
| 5 | Remove all echo-set machinery (`echoes` map, `_echoSet()`, `toEchoes.add()`, `fromEchoes.delete()`) |
| 6 | Update `engine.test.ts`: remove forced reverse-pass setup from step 1/3; assert detection works across non-contiguous cycles |
| 7 | Add `canonicalEqual` unit tests: equal records, differing value, extra key, key order independence |

---

## Association Propagation Bugs (found in v2)

Exploratory testing of the v2 engine surfaced four distinct bugs in how the engine
handles `_associations`. These should be fixed in v3.

### Bug 1 — Removal is not propagated (`[] → undefined`)

In `sync()`, after `_remapAssociations` returns an empty array, the engine passes
`associations: undefined` to the connector's `update()` call:

```ts
associations: remapped.length > 0 ? remapped : undefined,
```

Connectors treat `undefined` as "field not present in this patch — leave it alone".
So removing all associations from a source record is silently dropped; the target
retains its old associations indefinitely.

**Fix:** distinguish `undefined` (source record had no `_associations` key at all)
from `[]` (source explicitly carries zero associations). Pass `associations: []`
when the source has an empty associations array so connectors can apply the removal.

### Bug 2 — `null` / empty `targetId` defers instead of removing

When a source record nulls out the `targetId` in an association, `_remapAssociations`
calls `lookupTargetId(assoc.targetEntity, ..., null, ...)` which always returns
`undefined` → the record is deferred indefinitely. A null `targetId` is an
explicit disassociation signal, not a missing dependency.

**Fix:** in `_remapAssociations`, treat a falsy `targetId` as an explicit removal
tombstone: emit `{ ...assoc, targetId: null }` (or omit the association) rather
than returning `null` to trigger a defer.

### Bug 3 — Non-existent `targetEntity` defers instead of erroring

An association referencing an entity name that has never been synced (e.g. a typo
like `"custmers"`) also causes `lookupTargetId` to return `undefined` → defer.
The record is silently queued forever and the error is invisible.

**Fix:** separate "not yet in identity map" (legitimate defer) from "entity name
has no canonical entries at all" (configuration error). The latter should surface
as a distinct action (e.g. `"error"`) or throw, not silently defer.

### Bug 4 — Duplicate predicates are replicated verbatim

The engine passes all associations through `_remapAssociations` without checking
for duplicates. If a source record carries two identical `{ predicate, targetEntity,
targetId }` tuples, both are remapped and written to the target, which then also
stores duplicates.

**Fix:** deduplicate associations by `predicate` (last-wins or error) before
remapping, at least as an option. The connector contract should specify whether
multiple associations with the same predicate are allowed.

### Updated Work Items

| # | Task |
|---|------|
| 8 | Distinguish `undefined` vs `[]` associations; pass `[]` to `update()` when source has no associations |
| 9 | Treat falsy `targetId` in an association as an explicit removal — do not defer |
| 10 | Detect unknown `targetEntity` in `_remapAssociations`; surface as `"error"` action rather than defer |
| 11 | Deduplicate associations by `predicate` before remapping |
| 12 | Add `engine.test.ts` cases: remove association, null targetId, unknown entity, duplicate predicate |

---

## `applyRename` Whitelist Semantics (fixed in v2, carry forward)

The original `applyRename` iterated source fields and fell back to `map[key] ?? key`,
passing any field not present in the rename map through unchanged. This caused
connector-local fields (e.g. a `foo` field only meaningful to connector A) to leak
into canonical form and be written verbatim to every other connector.

**Fix (applied in v2):** when a map is provided, iterate the map entries rather than
the source fields. Only fields explicitly listed in the map are included in the
output; all others are silently dropped. When no map is provided the existing
pass-through behaviour (`{ ...data }`) is preserved, which is correct for channel
members with no renaming needs (e.g. orders).

```typescript
// Before (leaks unmapped fields)
for (const [key, value] of Object.entries(data)) {
  result[map[key] ?? key] = value;
}

// After (whitelist)
for (const [srcKey, dstKey] of Object.entries(map)) {
  if (Object.prototype.hasOwnProperty.call(data, srcKey)) {
    result[dstKey] = data[srcKey];
  }
}
```
