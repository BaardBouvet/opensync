# v3 Lessons Learned

## What v3 was

Replaced the v2 echo *set* (consume-on-sight, requires all passes in same cycle) with a
`lastWritten` *store* (compare-on-read, pass-order independent). This eliminated the most
fragile constraint inherited from v0: that the caller must run all directed pairs in a
single cycle or echoes accumulate silently.

All other v2 mechanics (declarative config, canonical field model, N-way channels,
patch semantics, rename maps) carried forward unchanged.

## What worked

### Content-based comparison is correct and robust

Comparing canonical field values rather than record IDs is strictly better:
- Works across any number of poll cycles (entries are overwritten, never deleted)
- Handles delayed passes and crashes between passes — the stored entry persists
- Correctly ignores connector-added metadata (ETags, audit fields) that appear after
  outbound renames but not in canonical form

The key insight: because we always store the **canonical** representation (before outbound
renames, after inbound renames), connector-local metadata never causes false positives.

### No pass-ordering constraint

v2 tests failed when only one direction of a pair was run. v3 tests pass regardless of
pass ordering. Running B→A without first running A→B is safe — the stored `lastWritten`
entry from the previous full cycle still correctly identifies echoes.

### `lastWritten` doubles as shadow state

The store encodes "what the engine last wrote here" per record per connector per entity.
This is the same concept as shadow state in the architecture spec — v3 proved that this
is the right primitive before the SQLite migration in v4.

## What broke down

### State file grows without bound

`lastWritten` entries are never garbage collected. Every record ever written to any
connector accumulates an entry. For long-running sync with high churn, the state file
becomes large. Not a problem for the POC; needs a cleanup pass in production.

### In-memory state JSON still not queryable

Same limitation as v0–v2. The state blob must be loaded in full on every engine start.
No way to query "show me the last written value for this specific record" without
reading the entire blob. Fixed in v4 with SQLite.

### Watermarks still per directed pair (`"A→B:entity"`)

v3 kept the directed-pair watermark key from v2. v4 changed this to per-source
(`"connectorId:entity"`) once the fan-out model replaced the directed-pair loop.
Directed-pair watermarks are wasteful when a source feeds many targets.

### No conflict resolution

Last write wins across passes. Content-based echo detection prevents our own writes
from being mistaken for updates, but it does not detect *external* writes to the same
field from two different connectors in the same cycle. Addressed in v4.
