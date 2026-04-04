# Plan: POC v9 — Ingest-first, DB-backed Identity Matching

**Status:** `implemented`
**Depends on:** v8 POC (three-way onboarding, `addConnector`)

---

## Background

v8 implemented `addConnector` as a live-fetch operation: it called the joining connector's
`read()` at onboard time to get a full snapshot, matched those records against the canonical
layer, and linked everything in one pass. This worked, but it created an awkward coupling.

The fundamental problem: **you can't preview the onboarding result without side-effects**.
`dryRun: true` worked, but it still required a live connector call on every invocation. If you
wanted to inspect the match report, you had to call the connector. If you ran `dryRun` multiple
times, you made multiple live calls. And `discover()` had the same issue — it called both
connectors to build the in-memory snapshot, so the "inspect before committing" workflow was
expensive.

The deeper issue is that `discover()` and `addConnector()` were coupled to live I/O, which
meant they couldn't be separated from the data-collection step. Inspection and commitment were
tangled together.

---

## Core Insight

Separate **data collection** from **identity resolution**.

Data collection — reading records from the source system — always writes to `shadow_state`.
That's already true for normal `ingest()`. The v9 insight is: **extend that invariant to
onboarding**. Run `ingest({collectOnly: true})` first, which writes shadow rows without any
fan-out, then let `discover()` and `onboard()` / `addConnector()` read entirely from those
shadow rows. No live connector calls after the initial ingestion.

This makes the flow:

```
ingest(A, { collectOnly: true })   → shadow_state[A] written, no fan-out
ingest(B, { collectOnly: true })   → shadow_state[B] written, no fan-out
discover(channelId)                → pure DB query on shadow_state → DiscoverReport
onboard(channelId, report)         → commits links, propagates uniques, marks ready
ingest(A)  /  ingest(B)            → normal fan-out now works (cross-links exist)
```

For adding a third connector later:

```
ingest(C, { collectOnly: true })   → shadow_state[C] written, no fan-out
                                     channel stays 'ready' for A+B — C is invisible
addConnector(channelId, "C")       → reads C's shadow_state, matches, links, catches up
ingest(A) / ingest(B) / ingest(C)  → all three sync normally
```

---

## Goals

1. **`ingest({collectOnly: true})`**: new mode that writes shadow_state and creates provisional
   self-only identity_map rows, but performs zero fan-out. Safe to call at any time on any
   channel without an `OnboardingRequiredError`.

2. **`discover()` from shadow_state**: reads entirely from the DB — no connector calls. Replaces
   the v8 live-fetch discover. Because it's pure DB, it is cheap, repeatable, and identical on
   every invocation (until the next `ingest`).

3. **`onboard()` with merged provisionals**: instead of creating fresh canonical UUIDs, fold the
   provisional canonicals created during `collectOnly` ingest into the matched canonical.
   `dbMergeCanonicals` updates both `identity_map` and `shadow_state.canonical_id` atomically.

4. **`addConnector()` from shadow_state**: same principle as `discover()` — reads C's
   `shadow_state` rather than fetching live. Requires that `ingest(C, {collectOnly: true})` was
   run first (throws a helpful error otherwise).

5. **Channel status semantics**: a connector that has been collected but not yet linked via
   `addConnector()` is **invisible** to `channelStatus()`. The channel stays `'ready'` for its
   currently-linked members while a new connector is being onboarded.

6. **Catch-up on `addConnector`**: changes that occurred in A/B while C was being collected are
   reconciled during `addConnector()` — not deferred to the next ingest. After `addConnector`
   returns, C is fully current. The following ingest is a no-op.

---

## Channel Status

```
uninitialized  →  no shadow_state rows for any channel member
collected      →  shadow rows exist, no cross-canonical links yet (pre-onboard)
ready          →  at least two members share cross-linked canonical_id rows
```

`'partially-onboarded'` is removed. A connector in the process of being added does not affect
the status of the channel — it is simply not yet a member. Once `addConnector()` commits, it
becomes a full member and the channel stays `'ready'`.

---

## `ingest({ collectOnly: true })`

```typescript
engine.ingest(channelId, connectorId, {
  batchId: crypto.randomUUID(),
  collectOnly: true,
})
```

**Behaviour:**

- Calls the connector's `read()` exactly as a normal ingest.
- For each record: strips `_`-prefixed meta fields, creates or retrieves a provisional
  canonical, writes `shadow_state`, writes `identity_map`. No `OnboardingRequiredError` check.
- Skips all fan-out: no calls to any other channel member's `insert()` or `update()`.
- Returns `RecordSyncResult[]` with `action: 'skip'` for every record (there are no writes).

**Provisional canonicals**: each record gets a self-only `identity_map` row
`(connector_id, external_id) → canonical_id`. These are provisional — they will be merged into
the true shared canonical by `onboard()` or `addConnector()`. They do not count as cross-links
and do not cause `channelStatus()` to return `'ready'`.

---

## `discover()` from shadow_state

```typescript
const report = await engine.discover(channelId);
```

**v9 change**: reads entirely from `shadow_state` — zero live connector calls.

**Requires**: `ingest({collectOnly: true})` has been run for every channel member. If any
member has no `shadow_state` rows, an error is thrown with a hint to run the collect step.

**Returns**: same `DiscoverReport` shape as v8. Matching logic (exact on `identityFields`,
case/whitespace-normalised) is unchanged.

Because there are no live calls, `discover()` is idempotent and cheap to call multiple times.
The report is a snapshot of the current shadow_state; re-running gives the same result until
a new `ingest({collectOnly: true})` is run.

---

## `onboard()` with merged provisionals

**v9 change**: rather than creating fresh canonical UUIDs for matched pairs (as v7/v8 did),
v9 folds the provisional canonical from one side into the provisional canonical from the other.

```
Before onboard:
  identity_map: (A, "a1") → canon-x    ← provisional
  identity_map: (B, "b1") → canon-y    ← provisional

After onboard (matched on email):
  identity_map: (A, "a1") → canon-x    ← kept
  identity_map: (B, "b1") → canon-x    ← merged: canon-y → canon-x
  shadow_state: B/"b1" canonical_id updated to canon-x
```

`dbMergeCanonicals(keepId, discardId)` performs this atomically. No new UUIDs are allocated for
matched records. Unmatched records (unique to one side) are propagated via direct `entity.insert()`
to the other side (bypassing shadow-diff, which would produce 'skip' since the shadow already
exists from the collect step).

---

## `addConnector()` — v9 changes

**v9 change 1 — reads from shadow_state, not live**: the joiner's records come from
`shadow_state` rows written during `ingest(C, {collectOnly: true})`. No live fetch.

**v9 change 2 — merges provisional canonicals**: matched entries go through `dbMergeCanonicals`
(same as `onboard()`), folding C's provisional canonicals into the existing canonical layer.

**v9 change 3 — catch-up on link**: after committing the identity links, `addConnector()`
compares C's collected snapshot (what C had when `collectOnly` was run) against the current
canonical fields (which reflect any A/B updates during the collection window). For each matched
record that has diverged, it calls `C.update()` and advances C's shadow. C is fully current
before `addConnector()` returns.

**v9 change 4 — fan-out guard in `_processRecords`**: while C is in the collected-but-not-linked
state, normal ingest from A or B skips fan-out to C. It detects this by querying for canonical_ids
shared by more than one connector (`crossLinkedConnectors`); C's provisional self-only canonicals
don't qualify. A's shadow advances normally (so A+B continue syncing as usual) — C simply
receives no writes until it is linked.

---

## Scenario (jsonfiles fixture)

| Connector | Records at collect time |
|-----------|------------------------|
| System A | Alice, Bob, Carol |
| System B | Alice, Bob, Carol |
| System C | Alice, Bob, Dave (Carol is missing; Dave is new) |

### Full flow

```
ingest(A, collectOnly)  → shadow_state[A]: Alice, Bob, Carol
ingest(B, collectOnly)  → shadow_state[B]: Alice, Bob, Carol
discover()              → matched: [(Alice,A)↔(Alice,B), (Bob,A)↔(Bob,B), (Carol,A)↔(Carol,B)]
onboard()               → 6 identity_map rows (3 canonicals × 2); propagates nothing (sets equal)
                          channelStatus → 'ready'

ingest(C, collectOnly)  → shadow_state[C]: Alice, Bob, Dave
                          channelStatus stays 'ready' (A+B unaffected)

[A/B sync normally during this window, e.g. Alice's name updated in A → synced to B, not C]

addConnector(C)         → matches Alice+Bob in C to existing canonicals
                          Dave (newFromJoiner) → inserted into A and B
                          Carol (missingInJoiner) → inserted into C
                          Alice catch-up → C.update("c1", { name: "Alice Updated" })
                          channelStatus → 'ready'

ingest(A), ingest(B), ingest(C) → 0 writes each
```

---

## Test Coverage (`engine.test.ts`)

| Suite | Tests |
|-------|-------|
| `ingest({ collectOnly: true })` | writes shadow_state; no fan-out; provisional canonicals; channelStatus = 'collected' |
| `discover() from shadow_state` | correct report without live calls; works after files deleted; normalises identityFields; errors helpfully if no shadow rows |
| `onboard() with merged provisionals` | 6 identity_map rows; canonical_id consistent per pair; unique records propagated; ingest after onboard = 0 writes; channelStatus = 'ready'; dryRun leaves DB clean |
| `A+B stays ready while C is collected` | ingest to A produces no fan-out to C; channelStatus stays 'ready'; addConnector catches up C immediately; post-addConnector ingest = 0 writes to C |
| `addConnector() with shadow-backed matching` | throws if C not pre-ingested; correct linked/new/missing counts; identity_map = 12 rows; Dave in A+B; Carol in C; 0 writes after; channelStatus = 'ready' |

23 tests, 55 assertions. All passing.

---

## What v9 Leaves Out

- **Fuzzy / probabilistic matching**: still exact on `identityFields` only.
- **Removing a connector** from a live channel (the inverse of `addConnector`).
- **Conflict resolution** when C's canonical value disagrees with A/B's: `addConnector` uses
  A/B's canonical as the authoritative value and writes it to C. C's own differing value is
  discarded on link. This may need revisiting if C should be allowed to "win" certain fields.
- **Multiple joiners at once**: `addConnector` handles one connector per call.
- **CLI / config-driven onboarding**: the flow is still exercised programmatically via the
  engine API.

---

## Key Design Decisions

**Why not suppress A's shadow when C is being collected?**
An earlier attempt held back A's shadow advancement so that the pending update would be
re-processed after `addConnector`. This broke A+B syncing: A re-processed every record on every
ingest, sending redundant writes to B. The correct fix is to let A sync normally and reconcile
the gap inside `addConnector` as a catch-up step. `addConnector` already has the current
canonical state; comparing it against C's collected snapshot is cheap and sufficient.

**Why merge provisionals rather than create new canonicals?**
Creating a new canonical UUID for each matched pair (as v7/v8 did) would require updating all
existing shadow_state rows that reference the old provisional canonical. `dbMergeCanonicals`
does this in a single `UPDATE` statement and avoids allocating IDs that are immediately retired.

**Why is `channelStatus` blind to unlinked collected connectors?**
A connector that has been collected but not yet committed via `addConnector` is not a channel
member in any operational sense. Including it in the status computation would force the channel
into a degraded state during a routine maintenance operation. The channel's observable behaviour
(A+B sync, fan-out, watermarks) is unaffected by C's presence in the engine config.
