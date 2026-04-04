# Plan: POC v7 — Discoverability & Onboarding

**Status:** `planned`
**Depends on:** v5 POC (SQLite state layer, shadow state, identity map)
**Triggered by:** State-wipe incident — deleting `opensync.db` then re-running a full sync
caused both jsonfiles connectors to double up because the engine had no memory of
previously-synced records.

---

## The Problem

The engine's state (SQLite) and the connectors' data (JSON files / remote APIs) are two separate
things. They can get out of sync. The most dangerous moment is when:

1. **Fresh install** — two systems each have existing data, unknown overlap.
2. **State wipe** — the database was deleted but the connected systems already have previously-
   synced data in them.

In both cases, `ingest()` with `fullSync: true` sees every record as new (no shadow state, no
identity map) and inserts all of them into every other connector. If the records were already
there, they get duplicated. With two jsonfiles connectors this looks like:

```
System A: [a1, a2, a3]   →   ingest   →   System B inserts a1ʼ, a2ʼ, a3ʼ
System B: [b1, b2, b3]   →   ingest   →   System A inserts b1ʼ, b2ʼ, b3ʼ

Result:
  System A: [a1, a2, a3, b1ʼ, b2ʼ, b3ʼ]   ← 6 records, 3 are duplicates
  System B: [b1, b2, b3, a1ʼ, a2ʼ, a3ʼ]   ← 6 records, 3 are duplicates
```

Where `b1 = a1` (same person, different generated IDs) because they were previously synced —
the engine just forgot.

The current code has no mechanism to detect this situation or prevent it.

---

## Goals

1. **Match phase**: before writing anything, fetch all records from all channel members and
   compare them using identity fields — produce a `MatchReport` that categorises records as
   matched, partial, or unique-per-side.

2. **Link phase**: commit a `MatchReport` to the DB — write identity_map rows and fully populate
   shadow_state for both sides of every confirmed match. This is the echo-storm prevention step
   from `specs/discovery.md`.

3. **Onboarding state machine**: track per-channel whether discovery has been completed.
   Guard `ingest()` so it refuses to run on an uninitialised channel that already has data.

4. **Dry-run mode**: `engine.discover()` produces a report without touching the DB.
   `engine.onboard(channelId, matchReport)` commits it. These are separate, inspectable steps.

5. **Demonstrate the failure**: the runner script should show exactly what goes wrong without
   discovery (duplicate insertion) and exactly what goes right with it (zero writes on a clean
   re-run after state wipe).

---

## New Engine Operations

### `engine.discover(channelId)`

Read ALL records from every member connector (no `since` filter, no watermark). Compare across
connectors using the channel's `identityFields` configuration. Return a `DiscoveryReport` — no
DB writes.

```typescript
interface DiscoveryMatch {
  canonicalData: Record<string, unknown>;
  sides: Array<{
    connectorId: string;
    externalId: string;
    rawData: Record<string, unknown>;
  }>;
}

interface DiscoverySide {
  connectorId: string;
  externalId: string;
  rawData: Record<string, unknown>;
}

interface DiscoveryReport {
  channelId: string;
  entity: string;
  matched: DiscoveryMatch[];         // high-confidence: same value on all identity fields
  uniquePerSide: DiscoverySide[];    // records that exist on only one connector
  summary: {
    [connectorId: string]: { total: number; matched: number; unique: number };
  };
}
```

Implementation notes:
- Reads use `entity.read(ctx, undefined)` (no watermark) — same as `fullSync` but read-only.
- Matching is exact: all `identityFields` must match after inbound field mapping is applied.
- For v7, only two-connector channels are in scope. N-way matching can come later.
- `identityFields` is already on `ChannelConfig` — no schema changes needed.

### `engine.onboard(channelId, report, opts?)`

Commit a `DiscoveryReport` to the DB. For each `matched` entry:
1. Assign a `canonical_id` (new UUID).
2. Write `identity_map` rows for all sides.
3. Write `shadow_state` rows for all sides with the current canonical data.
4. Advance the watermark for each connector to `now` so the next incremental sync
   starts from this point and doesn't re-read already-onboarded records.

For `uniquePerSide` records:
- Default: queue them for creation in the other system (controlled by
  `opts.propagateUnique`, default `true`). This is done by running a normal
  `_processRecords` pass, which will treat them as new inserts.
- If `opts.propagateUnique === false`: write a shadow row with `onboarded_only` status
  and skip them — they stay local.

```typescript
interface OnboardResult {
  linked: number;          // identity_map pairs created
  shadowsSeeded: number;   // shadow_state rows written
  uniqueQueued: number;    // records queued for creation in the other connector
  uniqueSkipped: number;   // unique records explicitly skipped
}
```

### `engine.channelStatus(channelId)`

Return the current onboarding state for a channel:

```typescript
type ChannelStatus =
  | "uninitialized"   // no identity_map rows, no shadow_state for this channel — needs discovery
  | "ready";          // onboarding was completed at least once — normal sync is safe
```

The check is lightweight: any `identity_map` row linked to a connector in this channel means
`"ready"`. No separate status table needed for v7 — derive from existing state.

---

## New DB Table: `onboarding_log`

Track when discovery/onboard ran so the runner output (and future UI) can show history:

```sql
CREATE TABLE IF NOT EXISTS onboarding_log (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  entity        TEXT NOT NULL,
  action        TEXT NOT NULL,   -- 'discover' | 'onboard'
  matched       INTEGER,
  unique_count  INTEGER,
  linked        INTEGER,
  shadows_seeded INTEGER,
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL
);
```

This is append-only and used only for diagnostics. It does not affect engine behaviour.

---

## Guard in `ingest()`

Before reading from the source connector, check:

1. Is there at least one record in the target connector's JSON file / API?
2. Is there zero shadow state for this channel?

If both are true: throw `OnboardingRequiredError` with a clear message:

```
OnboardingRequiredError: Channel "contacts-channel" has data in connector "system-b"
but no shadow state. Run engine.discover() and engine.onboard() before syncing.
Use { skipOnboardingCheck: true } to override (creates duplicates).
```

The `skipOnboardingCheck` escape hatch exists so tests that deliberately exercise the
failure scenario can opt out.

The check only protects the write side. Reading and diffing local shadow state is always safe.

---

## Demo Scenario (`run.ts`)

The runner should walk through three sub-scenarios in sequence:

### Scenario A — The Bug (shows the problem)

1. Populate `system-a/contacts.json` and `system-b/contacts.json` with the same 3 contacts
   (different `_id`s, same `name`/`email`), simulating a previous sync whose DB state was lost.
2. Delete the SQLite DB.
3. Call `ingest()` on both sides with `skipOnboardingCheck: true`.
4. Print the resulting file contents — show 6 records per file (3 duplicates each).
5. Reset state and JSON files for the next scenario.

### Scenario B — Happy Path (shows the fix)

1. Same starting data as Scenario A.
2. Call `engine.discover("contacts-channel")` — print the `DiscoveryReport`.
   Output should show `3 matched, 0 unique`.
3. Call `engine.onboard("contacts-channel", report)` — print the `OnboardResult`.
   Output should show `3 linked, 6 shadows seeded, 0 unique queued`.
4. Call `ingest()` on both sides — output should show `3 skipped, 0 inserts`.
5. Make one edit (change Alice's email in system-a) — ingest should show `1 update`.

### Scenario C — Fresh Onboarding (no prior overlap)

1. Populate only `system-a/contacts.json` with 3 contacts. `system-b/contacts.json` is empty.
2. Call `engine.discover()` — show `0 matched, 3 unique in system-a`.
3. Call `engine.onboard()` with default `propagateUnique: true`.
4. system-b should now have all 3 contacts (created by onboarding, not loose ingest).
5. Call `ingest()` on both sides — show `0 inserts` (already handled).

---

## Test Coverage (`engine.test.ts`)

- `discover()` returns correct match/unique counts for pre-seeded JSON files.
- `discover()` makes zero DB writes (verified by snapshot of DB state before/after).
- `onboard()` writes the correct `identity_map` and `shadow_state` rows.
- After `onboard()`, `ingest()` on both sides produces zero inserts.
- After `onboard()` + one edit on side A, `ingest()` from A produces exactly one update on side B.
- `ingest()` without prior `onboard()` throws `OnboardingRequiredError` when target has data.
- `ingest()` with `skipOnboardingCheck: true` succeeds and creates duplicates (negative test).
- Watermarks are advanced to `finished_at` of `onboard()` so next incremental sync is clean.

---

## What v7 Does NOT Cover

- **Fuzzy / partial matching** (name similarity, phone normalisation) — the spec describes this
  but it's a follow-on. v7 only implements exact-match on the declared `identityFields`.
- **N-way matching** (3+ connectors in one channel). Two-connector channels only.
- **Interactive review of partial matches** — no CLI/UI. Partial matches are reported but not
  acted on; the operator must resolve them manually and re-run.
- **Incremental discovery** (resumable, paginated for large datasets). v7 loads everything into
  memory; that's fine for the POC scale.
- **OAuth2 / authenticated connectors** — the test fixture is still jsonfiles. The discovery
  plumbing is connector-agnostic, so it will work with HTTP connectors when v6 lands.
- **Rollback** — if `onboard()` is interrupted mid-write, the DB is left in a partially-linked
  state. A transaction wrapper is all that's needed; note it as a known gap.

---

## Open Questions

1. **Identity fields and field mapping**: `identityFields` are currently canonical field names.
   When comparing side A to side B the inbound mapping has already been applied, so canonical
   names are used for matching. Is that always correct, or do we need a per-side identity field
   declaration? This matters when the field is renamed between connectors.

2. **Watermark advancement after onboard**: advancing to `now` is safe but means a window of
   changes made between the `discover()` and `onboard()` calls won't be picked up until the
   next full sync. Should `discover()` record a `snapshot_at` timestamp and `onboard()` use
   that instead of `now`?

3. **The `onboarding_log` vs `sync_runs`**: could just add an `action` column to `sync_runs`
   and reuse it rather than a new table. Worth deciding before implementing so the schema is
   stable across POCs.

4. **What signals `"ready"` reliably?**: deriving channel status from the existence of
   `identity_map` rows works for the common case but not for channels where the left side
   legitimately has zero records. An explicit `channel_onboarding_status` table (keyed on
   `channel_id`) would be simpler and more explicit. Evaluate at implementation time.
