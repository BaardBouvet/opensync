# Plan: POC v3 — Configurable Channels & Field Mapping

**Status:** `done`
**Depends on:** v1 POC (complete)

## Goal

Eliminate all hardcoded wiring from the engine and runner. In v1, the sync topology
(which systems exist, which entities are connected, which fields map to which) is all baked
into `run.ts`. In v3, all of that is expressed in a declarative config object. The engine
consumes configuration at startup; `run.ts` only instantiates and starts it.

A second goal is to introduce field mapping through a **canonical model**. Each channel declares
a canonical field schema; each member declares renames from its local field names into the
canonical names. The engine translates inbound records to canonical form and outbound records
back to each member's local form. Members only need to know about the canonical model — not
about each other — which keeps config linear (N members × 2 mappings) rather than quadratic
(N×(N-1) directed pairs).

Field mapping in v3 is **rename-only**. No split, no merge, no transform functions. That is
sufficient to prove the canonical routing model and keeps the POC scope tight.

Tests remain the authoritative executable specification. Hardcoding is permitted in tests.

## Storage Model

The canonical model is **ephemeral** — it exists only in memory during a single sync pass.
No central copy of data is maintained. Each connector holds its own data in its own format;
the engine's only persistent state is the identity map and per-connector watermarks (carried
over from v1).

The pass for a changed record looks like:

```
read from B  →  apply B.inbound  →  canonical record (in memory)
                                          │
                          ┌───────────────┴──────────────┐
                  apply A.outbound               apply C.outbound
                  patch A                         patch C
```

The canonical record is discarded after the pass. Patch semantics (see below) ensure that
fields owned by other connectors survive untouched on each target.

This is sufficient because v3 has no conflict resolution. When two connectors update the same
canonical field in the same cycle, the last write wins — whichever sync pass runs second
overwrites the first. Proper conflict resolution (field-level masters, shadow state) requires
a persistent central copy and is explicitly out of scope for this POC.

---

## What Changes vs v1

| Area | v1 | v3 |
|------|----|----|
| Connectors | Hardcoded in `run.ts` | Declared in `EngineConfig` |
| N-way channels | Two connectors only | Any number of members per channel |
| Field mapping | None — raw fields pass through | Rename-only, via canonical model |
| Canonical model | Not present | Declared per channel; engine routes through it |
| `run.ts` | Bootstrap + topology | Only reads config and starts engine |
| Tests | Hardcode systems and assertions | Hardcode config and assertions |

---

## Config Shape

A **channel** owns a **canonical schema** — the set of field names the engine uses internally.
Each **channel member** declares two rename maps:

- `inbound` — maps local field names → canonical field names (applied when reading from this member)
- `outbound` — maps canonical field names → local field names (applied when writing to this member)

Unmapped fields pass through under their original name in both directions.

```typescript
/** A rename map: keys are source field names, values are destination field names. */
type RenameMap = Record<string, string>;

interface ChannelMember {
  /** Reference to a ConnectorInstance by its id. */
  connectorId: string;
  /** Entity name in this connector instance (e.g. 'customers'). */
  entity: string;
  /** Rename local fields → canonical fields on read.
   *  Fields not listed are kept as-is. */
  inbound?: RenameMap;
  /** Rename canonical fields → local fields on write.
   *  Fields not listed are kept as-is. */
  outbound?: RenameMap;
}

interface ChannelConfig {
  /** Unique identifier. */
  id: string;
  /** Two or more members. The engine syncs every directed pair via canonical form. */
  members: ChannelMember[];
}

interface EngineConfig {
  connectors: ConnectorInstance[];
  channels: ChannelConfig[];
}
```

---

## Field Mapping Semantics

For each sync pass the engine:

1. Reads a record from the source member (raw local fields).
2. Applies `member.inbound` renames to produce the **canonical record**.
   - Only fields present in the source record appear in the canonical record.
   - Fields not in `inbound` are kept under their original name.
   - The engine never injects fields that were not in the source read.
3. For each other member in the channel, applies that member's `outbound` renames to produce the **local record**.
   - Only fields present in the canonical record appear in the local record.
   - Fields not in `outbound` are kept under their canonical name.
4. Writes the local record to that member via `insert()` or `update()`.
   - `insert()` receives exactly the fields from step 3 — no extras.
   - `update()` receives exactly the fields from step 3 — connectors must **patch** (merge into the existing record), not full-replace.

The source member's `outbound` map and the target member's `inbound` map are never used in the
same pass — `inbound` is for reading, `outbound` is for writing.

## Patch Semantics for `update()`

Because payloads only carry the fields the source explicitly provided, `update()` must be a
**patch** — it merges the incoming fields into the existing record and leaves all other fields
untouched. Full-replace would silently delete fields owned by other connectors in the channel.

The jsonfiles connector already does this correctly (spreads existing record first, then incoming
fields on top). All future connectors must follow the same contract. This is enforced by
convention in the POC; a future API-level safeguard can be added when needed.

Consequence: a connector that calls a full-replace API (e.g. HTTP PUT) must first `lookup()` the
current record and merge locally before writing.

---

## Rename Example: `name` ↔ `customerName`

Connector A calls the field `name`; the canonical model calls it `customerName`.

```typescript
// Connector A member config
{
  connectorId: "A",
  entity: "customers",
  inbound:  { name: "customerName" },   // A's "name"  → canonical "customerName"
  outbound: { customerName: "name" },   // canonical "customerName" → A's "name"
}
```

Connector B already uses `customerName` natively — no rename needed, mappings omitted.

---

## Scenario for `run.ts` and Tests

Three connector instances, one channel. The canonical customer model has `{ customerName }`.

| Connector | Local field | Mapping |
|-----------|-------------|---------||
| A | `name` | inbound: `name → customerName` / outbound: `customerName → name` |
| B | `customerName` | (none — already canonical) |
| C | `fullName` | inbound: `fullName → customerName` / outbound: `customerName → fullName` |

The demo seeds `"Alice Smith"` in connector A as `{ name: "Alice Smith" }`. After one sync cycle:
- Connector B has `{ customerName: "Alice Smith" }`
- Connector C has `{ fullName: "Alice Smith" }`

Editing `customerName` to `"Alicia Smith"` in connector B propagates to `{ name: "Alicia Smith" }`
in A and `{ fullName: "Alicia Smith" }` in C.

Orders have no renames — all three connectors use the same field names — so their member configs
omit `inbound`/`outbound` entirely.

### Complete config

```typescript
const config: EngineConfig = {
  connectors: [connectorA, connectorB, connectorC],
  channels: [
    {
      id: "customers",
      members: [
        {
          connectorId: "A",
          entity: "customers",
          inbound:  { name: "customerName" },       // A reads "name"  → canonical "customerName"
          outbound: { customerName: "name" },       // canonical "customerName" → A writes "name"
        },
        {
          connectorId: "B",
          entity: "customers",
          // B already uses "customerName" — no renames needed
        },
        {
          connectorId: "C",
          entity: "customers",
          inbound:  { fullName: "customerName" },   // C reads "fullName" → canonical "customerName"
          outbound: { customerName: "fullName" },   // canonical "customerName" → C writes "fullName"
        },
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

---

## File Layout

```
poc/
  v3/
    engine.ts        # SyncEngine accepting EngineConfig
    engine.test.ts   # hardcoded config + assertions
    run.ts           # reads a config, starts engine, polls
    data/            # gitignored
      connector-a/
      connector-b/
      connector-c/
```

---

## Work Items

| # | Task |
|---|------|
| 1 | Define `RenameMap`, `ChannelMember`, `ChannelConfig`, `EngineConfig` types in `poc/v2/engine.ts`; rename `ConnectedSystem` → `ConnectorInstance` |
| 2 | Implement `applyRename(data, map)` — pure function, applies a `RenameMap` to a record |
| 3 | Port `SyncEngine` from v1 to accept `EngineConfig`; derive directed pairs from channel members at startup |
| 4 | On read: apply source member's `inbound` map → canonical record |
| 5 | On write: apply target member's `outbound` map → local record before `insert`/`update` |
| 6 | Write `engine.test.ts`: rename passthrough, inbound-only, outbound-only, and full round-trip assertions; 3-connector scenario |
| 7 | Write `run.ts`: declare 3-connector config with `name`/`customerName`/`fullName` renames, seed and poll |
