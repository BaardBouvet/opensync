# v1 Lessons Learned

## What v1 was

Fixed the N-system identity map problem from v0. Introduced a canonical UUID per
logical record shared across all connectors, replacing the flat pairwise map.
Extended the scenario to three connector instances (A, B, C) to validate that
N-way sync works without hardcoding pairs.

## What worked

### Canonical UUID identity map
`canonical[entity][canonicalId][connectorId] = recordId` scales correctly to any
number of connectors. Adding a third instance requires no changes to the map
structure. The `externalToCanonical` reverse index keeps lookups O(1).

### Directional echo prevention
Keying echoes as `echoes[target][source]` means A-written records in B are only
suppressed when reading B back to A — not when reading B to C. This is the
correct behaviour for cascade propagation (A change reaches C via B in the same
cycle without being blocked).

### Per-directed-pair watermarks
Keying watermarks `"A→B:customers"` rather than `"A:customers"` allows the same
source to feed multiple targets independently. Each target advances its own cursor
without interfering with sibling passes.

### State serialisation (toJSON/fromJSON)
Externalising engine state as a plain JSON-serialisable object kept the in-memory
engine simple while enabling persistence. The pattern carries forward unchanged
into v2.

## What broke down

### Hardcoded topology in run.ts
Which connectors exist, which entities are connected, and which sync pairs to run
were all written directly into `run.ts`. Adding a new connector meant editing the
runner. There was no way to express the topology declaratively. Addressed in v2.

### No field mapping
All field names passed through unchanged. Real integrations always involve name
mismatches (`name` vs `customerName` vs `fullName`). Without a mapping layer the
POC couldn't model any realistic scenario. Addressed in v2.

### Entity matching was implicit (by name)
The engine matched entities across connectors by comparing `entity.name`. This
assumed all connectors used the same name for the same concept. Addressed in v2
by explicit `entity` per channel member.

### Echo consumption required running all reverse passes
After each write pass, the reverse pass must be run in the same cycle to consume
the echo entries before they accumulate. This was not obvious from the API. The
v1 tests initially ran only forward passes and then had flaky failures in later
steps. The fix (run all directed pairs every cycle) is now documented as a
requirement in v2.

### Tests used `engine.sync(from, to)` tightly coupled to ConnectedSystem
The `sync` method took two `ConnectedSystem` objects, mixing topology (which
connectors) with the engine call. Moving topology into config (v2) required
changing the signature to `sync(channelId, fromId, toId)`.
