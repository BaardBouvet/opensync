# Engine Usability — Gap Analysis

**Status:** backlog  
**Date:** 2026-04-05  
**Domain:** Engine API  
**Scope:** `packages/engine/src/engine.ts`, browser demo glue code  

---

## Problem Statement

The browser demo (`demo/demo-browser/`) repeatedly hit subtle engine integration bugs that
took significant debugging to resolve. The engine is correct, but its API surface is not
well-matched to the way callers need to use it. This document catalogs the friction points
and proposes improvements for a future iteration.

---

## § 1 Multi-step Boot Protocol

### § 1.1 The problem

Standing up a channel requires a precise 3-step sequence:

```
ingest(collectOnly) × N  →  discover()  →  onboard()
```

followed by a separate loop for normal polling:

```
ingest() × N  (repeated on interval)
```

There is no single "boot" call. Callers must assemble this sequence manually, and the order
matters: `discover()` throws if `shadow_state` is empty; `onboard()` re-checks that; the
interval must not start before onboarding completes.

In the browser demo this led to multiple bugs during development:
- Starting the poll interval before onboarding finishing caused double-insert fanouts.
- Missing the warmup ingest pass after `onboard()` left fanned-out records without
  associations for one full poll interval.

### § 1.2 Proposed fix

Add a high-level `engine.bootChannel(channelId)` method (or `engine.ensureReady()`) that
encapsulates the collectOnly → discover → onboard → warmup-ingest sequence and returns a
list of `SyncEvent`-equivalent records for the caller to log. The low-level methods remain
available for advanced use and testing. This would reduce the demo glue from ~40 lines to ~5.

---

## § 2 Event Payload and Onboarding Events

See `plans/connectors/PLAN_ENGINE_SYNC_EVENTS.md` for the design of first-class `SyncEvent`
emission from the engine, which includes:

- **§ 2** — Moving event construction into the engine and extending `RecordSyncResult` to
  carry field payloads (`sourceData`, `sourceShadow`, `before`, `after`).
- **§ 5** — Exposing individual onboarding fanout INSERT events to callers via
  `OnboardResult.inserts`.

This plan originated in this document but is now owned by the connector-integration plan
so that changes to `RecordSyncResult` (a core SDK type) are centralized.

---

## § 3 Association Propagation Gap in Step 1b

### § 3.1 The problem

`onboard()` handles two sub-cases for fanning out records:

- **Unique-per-side** (step 2): records present in exactly one connector. These correctly
  call `lookup()` on the source to obtain associations, attempt `_remapAssociations()`,
  and write a deferred row if remap fails.
- **Matched + missing-connector** (step 1b): records matched across 2+ connectors but
  absent from a 3rd. These do **not** call `lookup()`. The fanout insert carries only
  `canonicalData` (the field-mapped data), with no associations.

As a result, fanout-inserted records land in the target connector without associations.
On the next ingest cycle the source is processed normally, the shadow's assoc sentinel is
empty, the diff fires, and the associations are propagated via UPDATE. This is functionally
correct but requires one extra poll cycle and produces a confusing delayed-update pattern.

### § 3.2 Proposed fix

In step 1b, call `lookup()` on each unique source record (one of `match.sides`) to obtain
the full record including associations, then apply the same remap+deferred logic that
step 2 already uses. This makes the two sub-cases consistent and eliminates the post-boot
UPDATE burst.

---

## § 4 channelStatus() Entity-Scope Bug

### § 4.1 The problem (fixed in T41)

`channelStatus()` used `connector_id IN (...)` without an entity filter. In a multi-channel
scenario where the same connectors (e.g. crm/erp/hr) appear in both a `companies` channel
and a `contacts` channel, the contacts channel saw the companies shadow rows and incorrectly
reported itself as `"collected"`, skipping onboarding entirely.

This caused 14 duplicate inserts on the first poll (all contacts treated as new).

### § 4.2 Resolution

Fixed (T41) by scoping both `hasShadow` and `crossLinked` subqueries to
`(connector_id = ? AND entity_name = ?)` per channel member.

### § 4.3 Systemic lesson

Any DB query that operates on "this channel's connectors" must also filter by entity name.
The channel member type carries both `connectorId` and `entity`; callers should always use
both. The entity-scoped `dbGetCanonicalsByChannelMembers()` pattern should be extracted
into a shared query helper and used everywhere.

---

## § 5 Fan-out Guard Uses Global Identity Map

### § 5.1 The problem

`_processRecords()` builds the `crossLinked` set by querying ALL canonicals in
`identity_map`, not just those belonging to the current channel. The guard is:

```sql
SELECT DISTINCT connector_id FROM identity_map
WHERE canonical_id IN (
  SELECT canonical_id FROM identity_map
  GROUP BY canonical_id HAVING COUNT(DISTINCT connector_id) > 1)
```

For a multi-channel setup, once **any** channel has cross-linked records, all connectors
become "cross-linked in the global map", even if they have no linked records for the
channel currently being processed. This can cause premature fan-out before the channel is
properly onboarded.

### § 5.2 Proposed fix

Scope the `crossLinked` query to the current channel's entity/connector pairs, matching
the pattern from `channelStatus()`.

---

## § 6 No Observable Progress During Boot

### § 6.1 The problem

`startEngine()` in the demo blocks synchronously (from the UI perspective) for the full
onboarding duration. No progress events are emitted. For scenarios with many records or
multiple channels, the UI shows "starting…" for an extended period with no feedback.

### § 6.2 Proposed fix

Both the `bootChannel` helper (§ 1.2) and the individual onboard methods should support an
`onEvent` or `onProgress` callback so the caller can stream events to the UI as they occur.
In the browser demo this maps directly to `devTools?.appendEvent(ev)`.

---

## § 7 Implicit Channel Ordering Dependency

### § 7.1 The problem

When two channels share the same connectors (e.g. companies and contacts both use
crm/erp/hr), the onboarding order matters: contacts that have associations to companies
must be onboarded AFTER the companies channel, so that `_remapAssociations()` can resolve
the company identity links.

This ordering constraint is implicit. Nothing in the API enforces or communicates it.
If the caller iterates `config.channels` and the YAML lists contacts before companies,
associations fail to remap (they get deferred) and require an extra poll cycle to resolve.

### § 7.2 Proposed fix

Either:
a. Detect association dependencies at onboarding time and auto-sort channels (topological
   sort on which channels reference which entities).
b. Document the ordering requirement explicitly in config validation and surface it as an
   error if violated.

---

## § 8 Summary of Proposed API Changes

| Gap | Fix | Complexity |
|-----|-----|------------|
| 3-step boot sequence | `bootChannel()` high-level method | Medium |
| Silent onboard events | Return `RecordSyncResult[]` from `onboard()` | Low |
| Step 1b no associations | Add `lookup()` call in step 1b | Low |
| Global fan-out guard | Scope `crossLinked` to channel entities | Low |
| No boot progress | Add `onEvent` callback to boot methods | Medium |
| Implicit channel order | Config validation or topological sort | Medium |

---

## Spec Changes Planned

No production code changes are planned in this document. This is a backlog analysis.
When items are promoted to active work:
- Spec changes for `bootChannel()` → `specs/sync-engine.md § Boot`
- Spec changes for `onboard()` return type → `specs/sync-engine.md § Onboard`
- Spec changes for fan-out guard scoping → `specs/sync-engine.md § Fan-out guard`
