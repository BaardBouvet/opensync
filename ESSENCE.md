# OpenSync: Essence

OpenSync exists because syncing data between SaaS systems is a solved problem that keeps
getting solved badly.

The usual approach is point-to-point: write a script that reads from A and writes to B.
Then someone adds C, and you write two more scripts. Then D. The scripts start depending on
each other's timing. Conflicts are ignored or cause silent data loss. No one knows what
happened three syncs ago. Nobody can roll anything back.

OpenSync takes a different approach: all data flows through a single hub — a local SQLite
database that holds a shadow copy of every synced record. Connectors are dumb data pipes
that expose raw records; the engine is the one place where business logic lives. Every
field carries provenance metadata. Every write is reversible. Every HTTP call is logged.

## Core beliefs

**Connectors should be trivial to write.** A connector is just two functions: read records
in, write records out. No knowledge of other systems. No shared schema to conform to.
A developer with no prior experience should be able to write a working connector in a
few hours.

**The engine should be trustworthy.** You can point it at two live systems and let it run.
It won't loop. It won't duplicate. It won't silently overwrite a change you made manually.
Circuit breakers trip before a bad batch does damage. Any sync can be rolled back to a
known-good state.

**Semantic translation is a first-class goal.** Field-level renames are just the start.
The engine is designed to support full semantic mapping — splitting, merging, and
transforming fields between systems that describe the same concept differently.

**Declarative mappings give lineage for free.** Field mappings are data structures, not
opaque code. Because every rename, expression, and conflict rule is inspectable without
running the engine, a complete field-lineage graph — from raw connector field to canonical
name to every system that receives it — can be derived statically. This is the reason the
playground can render a live lineage diagram from config alone, and why any downstream
tool can audit data flows without instrumenting the engine.

**Actions and light workflows belong here.** Sync events are a natural trigger for
downstream actions: notify a Slack channel, create a task, fire an approval workflow.
The Actions feature makes OpenSync a lightweight event-driven workflow engine — not a
replacement for a full orchestration platform, but capable enough for the common cases
that always end up bolted on to sync pipelines anyway.

**Process matters as much as code.** Every design decision is documented. Specs are the
authority — code serves specs, not the other way around.

## What OpenSync is not

- A replacement for a full workflow orchestration platform (Temporal, Airflow)
- A hosted service — it is a TypeScript library and engine binary you embed in your own process
- A generic ETL pipeline — it syncs structured records between systems, not arbitrary data
