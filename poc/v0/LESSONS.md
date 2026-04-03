# v0 Lessons Learned

## What v0 was

Minimal bidirectional sync between two JSON-file connector instances (A and B).
Proved the core loop: read → identity map → insert/update, with watermarks for
incremental reads and an echo-prevention set to suppress bounce-backs.

## What worked

### The 4-step test scenario as a narrative
Building tests that tell a linear story (insert → associate → update source →
update target) caught real bugs and served as a living specification. Every
subsequent version kept this pattern.

### jsonfiles connector as a test fixture
Using real file I/O rather than mocks meant the connector's actual behaviour
(watermark comparison, patch-on-update, association serialisation) was exercised
from the start. Problems that would have been hidden by mocks surfaced early.

### Echo prevention via a per-instance set
Recording written IDs and skipping them on the next read from the same instance
prevented infinite A→B→A→... loops without needing any diffing logic.

## What broke down

### Pairwise identity map does not scale to N systems
`identityMap[entity]["A:id"] = "B-id"` is a flat key-value store. With two
systems it works. With three it becomes ambiguous: `"A:id"` can only map to one
value, so you cannot store both the B-side and C-side ID for the same source
record. This was the main reason v1 was needed.

### Echo set was not directional enough
The echo set was keyed by target instance only (`echoes["B"] = Set<id>`). This
meant that writes from A to B and writes from C to B shared the same echo bucket.
In a 3-system setup, suppressing a record written from A to B would incorrectly
also suppress a legitimate write from C to B. Fixed in v1 by keying echoes as
`echoes[target][source]`.

### Watermark key did not include the target
Watermarks were keyed `"A:customers"` rather than `"A→B:customers"`. When the
same source feeds multiple targets, each target should advance its own cursor
independently. A single shared watermark causes under-reads on one target when
the other runs first. Fixed in v1.

### State was lost between runs
The identity map was in-memory with optional JSON persistence. Restarting without
deleting data caused re-inserts of every existing record. A persistent store is
needed for production use.
