# v2 Lessons Learned

## What v2 was

Introduced declarative configuration (`EngineConfig`) and a canonical field
mapping model. Topology (which connectors, which entities, which pairs to sync)
moved out of `run.ts` into a config object. Each channel member declares
`inbound` and `outbound` rename maps; the engine routes all data through an
ephemeral canonical representation.

## What worked

### Canonical field model scales linearly with N connectors
Each member only needs to know the canonical field names, not the field names of
every other connector. Adding a fourth connector requires one new `ChannelMember`
entry, not N new directed-pair mappings. The alternative (per-pair mappings) would
have scaled as N×(N-1).

### Canonical form is ephemeral — no central store needed
The canonical record exists only in memory during a single sync pass. Each
connector keeps its own data in its own format. The identity map and watermarks
from v1 are the only persistent engine state needed. This avoids a central
database while still enabling consistent N-way sync.

### Patch semantics make field ownership safe
Sending only the fields that were present in the source read — and having the
connector merge them into the existing record — means connectors can own disjoint
field sets on the same logical record without overwriting each other. The
jsonfiles connector already did this (spread existing first, incoming on top).
This turned out to be a load-bearing contract, not an implementation detail.

### applyRename as a pure function
Isolating the rename step as a pure function (`applyRename(data, map)`) made it
trivially testable in isolation before wiring it into the engine. Six unit tests
caught edge cases (empty map, undefined map, no mutation) before the integration
tests ran.

### sync(channelId, fromId, toId) is a cleaner API
Explicitly naming the channel and connector IDs rather than passing object
references makes it obvious what is being synced and why. The test setup became
more readable, and the poll loop in `run.ts` is a simple list of `[channel, from, to]`
tuples rather than nested object references.

## What broke down

### Echo consumption still requires running all passes every cycle
This was inherited from v1 and not resolved in v2. After A→B inserts a record,
the echo entry for B is only consumed when the B→A pass runs. If the test (or
caller) skips the reverse pass, the echo persists and suppresses a genuine update
from B on the next cycle. The fix — always run all directed pairs each cycle — is
correct but not enforced by the API. A future version could auto-consume echoes
that are older than one cycle.

### No conflict resolution
When two connectors update the same canonical field in the same cycle, the last
write wins — whichever sync pass runs second overwrites the first. This is
acceptable for the POC but not for production. Proper conflict resolution requires
a persistent shadow state (field-level last-known values with provenance) and is
the main thing v3 needs to add.

### RenameMap only — no split or merge
A field named `name` in one connector and `{ firstName, lastName }` in another
cannot be mapped. Only 1:1 renames are supported. Split and merge mappings would
require a transform function, which was deliberately excluded to keep scope tight.
The canonical model still applies — the `inbound`/`outbound` structure works for
any bijective transform, not just renames.

### Entity name aliasing not supported
If connector A calls an entity `contacts` and connector B calls it `customers`,
there is no way to wire them into the same channel. The `entity` field on
`ChannelMember` is the single name the connector exposes. A `remoteEntity` alias
was considered and dropped. A future version could add it.

### In-memory state still lost on restart
Same limitation as v0 and v1. The `toJSON/fromJSON` mechanism persists state to a
file in `run.ts`, but the tests always start fresh. A real implementation needs
the engine's identity map and watermarks to survive process restarts reliably.
