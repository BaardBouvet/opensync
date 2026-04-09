# PLAN: Cluster Split (Break Up a Cluster)

**Status:** complete  
**Date:** 2026-04-09  
**Effort:** M  
**Domain:** Engine + Playground  
**Spec changes planned:** `specs/identity.md` § Split Operation + § Anti-Affinity, `specs/playground.md` § 5.5 + § 4.9 + § 7  

---

## Overview

A cluster in the playground represents one or more connector records linked to a shared
canonical UUID in `identity_map`. The engine creates these links automatically during
onboarding (field-value matching) and can also merge canonicals transitively. When a
merge was incorrect — wrong match, test data, or data drift — there is currently no way
to undo it. This plan adds the ability to **split** a connector's record out of a shared
cluster, giving it a fresh canonical UUID and letting the next sync cycle treat it as a
separate entity.

---

## Four deliverables

1. **Engine: `no_link` table** — a durable anti-affinity store that prevents `_resolveCanonical()` from re-merging explicitly split records
2. **Engine API** — `SyncEngine.splitCanonical()` atomically splits the link and writes `no_link` entries for all sibling pairs
3. **Playground UI** — "Break" button on record cards inside linked clusters; no forced edit modal required
4. **Logging** — the operation is recorded in the event log, `transaction_log`, and a new `no_link` dev-tools tab

---

## § 1 What "break" means (semantics)

A cluster of N has exactly N `identity_map` rows that share one `canonical_id`. Breaking
a cluster for one `(connectorId, externalId)` pair means:

1. Remove that pair's link from the old `canonical_id`.
2. Create a brand-new `canonical_id` (UUID) for the detached pair.
3. Update all `shadow_state` rows for that connector/externalId to reference the new
   canonical ID.
4. Clear all `written_state` rows scoped to the old canonical ID for that connector —
   absence of a written-state row forces a fresh dispatch on the next poll, which inserts
   the split-off record into the other connectors as a new entity.
5. Log the operation to `transaction_log` with `action = "split_canonical"`.

The other links on the old canonical are untouched. If a 3-way cluster `{A, B, C}` splits
off `C`, the result is two clusters: `{A, B}` and `{C}`.

Splitting the **only** remaining link from a canonical (i.e., a cluster with exactly one
populated slot) is a no-op: `splitCanonical()` throws an error rather than creating an
unreachable orphan canonical.

### § 1.1 Effect on next sync cycle

After the split:
- The old cluster `{A, B}` continues to sync normally (shadow state is intact).
- The new cluster `{C}` starts with a `shadow_state` row under its new canonical that
  carries the field values from before the split. The next ingest poll from connector C
  will detect that C's record exists (shadow for C is present, no echo) but has **no** link
  to the other connectors. Because `written_state` was cleared, the noop-suppression check
  fails and the engine will attempt to insert C's record into the remaining connectors as
  a new entity.

This is the intended behaviour: the split-off record re-enters the propagation pipeline as
if it were brand new, and the user can observe the INSERT in the event log.

### § 1.2 Durability via `no_link`

Without additional machinery, a split on a channel with `identity` fields would be undone
on the very next ingest poll — `_resolveCanonical()` would find the identity-field match,
call `dbMergeCanonicals`, and silently re-stitch the two canonicals together.

The solution is an engine-level **anti-affinity store**: a `no_link` table keyed on pairs
of `(connector_id, external_id)`. Before `_resolveCanonical()` or `dbMergeCanonicals` merges
two canonicals, it checks whether any external ID on one side has a `no_link` entry against
any external ID on the other side. If a match is found, the merge is aborted for that pair.

`splitCanonical()` writes `no_link` entries atomically as part of the same transaction as
the split itself. For a cluster `{A, B, C}` where C is split off, it writes:

```
no_link(C, A)
no_link(C, B)
```

One entry per remaining sibling. The split is then durable regardless of whether the
records still share identity-field values.

### § 1.3 Reversibility

`no_link` entries are ordinary rows in a SQLite table. Removing them re-enables automatic
matching. The engine exposes `removeNoLink(connectorIdA, externalIdA, connectorIdB, externalIdB)`
for callers that want to undo an anti-affinity declaration. In the playground, the dev-tools
`no_link` tab (§ 6) shows all active entries and allows per-row deletion.

---

## § 2 Engine: `no_link` table

### § 2.1 Schema

New table in `packages/engine/src/db/migrations.ts`:

```sql
CREATE TABLE IF NOT EXISTS no_link (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id_a TEXT NOT NULL,
  external_id_a  TEXT NOT NULL,
  connector_id_b TEXT NOT NULL,
  external_id_b  TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (connector_id_a, external_id_a, connector_id_b, external_id_b)
);
```

Pairs are stored in canonical order (`connector_id_a ≤ connector_id_b`, then
`external_id_a ≤ external_id_b` when connectors are equal) so that `(A, B)` and `(B, A)`
resolve to the same row.

### § 2.2 DB helpers in `queries.ts`

```ts
/** Insert an anti-affinity pair (idempotent — INSERT OR IGNORE). Normalises pair order. */
export function dbInsertNoLink(
  db: Db,
  connectorIdA: string, externalIdA: string,
  connectorIdB: string, externalIdB: string,
): void

/** Remove an anti-affinity pair (no-op if missing). */
export function dbRemoveNoLink(
  db: Db,
  connectorIdA: string, externalIdA: string,
  connectorIdB: string, externalIdB: string,
): void

/** Returns true if merging the two canonical IDs would violate a no_link entry.
 *  Joins identity_map twice to enumerate all (extId_a, extId_b) pairs across
 *  the two canonicals and cross-references no_link. */
export function dbMergeBlockedByNoLink(
  db: Db,
  canonicalIdA: string,
  canonicalIdB: string,
): boolean

/** Return all no_link rows (for dev-tools tab). */
export function dbGetAllNoLinks(
  db: Db,
): Array<{
  id: number;
  connector_id_a: string; external_id_a: string;
  connector_id_b: string; external_id_b: string;
  created_at: string;
}>
```

### § 2.3 Where `no_link` is enforced

| Call-site | File | Location | Change |
|---|---|---|---|
| `_resolveCanonical()` — incremental ingest | `engine.ts` | ~line 1285 | Before `dbMergeCanonicals(winner, matchedCids[i])`, call `dbMergeBlockedByNoLink`. If blocked, skip that merge (continue loop). |
| `onboard()` — matched canonicals | `engine.ts` | ~line 733 | Same guard before `dbMergeCanonicals(winnerId, dropId)`. |
| `addConnector()` — bridge merge | `engine.ts` | ~lines 1148, 1155 | Same guard before both `dbMergeCanonicals` calls. |

The guard is one SQL query per potential merge. When the `no_link` table is empty (the
common case) SQLite returns immediately; cost is negligible.

### § 2.4 Public API for removal

```ts
/** Remove an anti-affinity declaration, re-enabling automatic matching for this pair. */
removeNoLink(
  connectorIdA: string, externalIdA: string,
  connectorIdB: string, externalIdB: string,
): void
```

Thin synchronous wrapper over `dbRemoveNoLink`.

---

## § 3 Engine API — `splitCanonical()`

### § 3.1 Return type

```ts
export interface SplitCanonicalResult {
  oldCanonicalId: string;
  newCanonicalId: string;
  connectorId: string;
  externalId: string;
  /** Sibling pairs for which a no_link entry was written. */
  noLinkWritten: Array<{ connectorId: string; externalId: string }>;
}
```

Add to the public type exports of `packages/engine/src/engine.ts`.

### § 3.2 Method signature

```ts
splitCanonical(
  channelId: string,
  canonicalId: string,
  connectorId: string,
  externalId: string,
): SplitCanonicalResult
```

Synchronous — all operations are SQLite writes in one transaction.

### § 3.3 Algorithm

```
1. Resolve channel — throw if unknown.
2. Verify (connectorId, externalId) exists in identity_map with canonical_id = canonicalId —
   throw "identity link not found" if not.
3. Collect siblings: rows in identity_map WHERE canonical_id = canonicalId
   AND NOT (connector_id = connectorId AND external_id = externalId).
   If siblings is empty, throw "cannot split the last link from a canonical".
4. newId ← crypto.randomUUID()
5. BEGIN TRANSACTION
   a. DELETE FROM identity_map
         WHERE canonical_id = canonicalId
           AND connector_id = connectorId
           AND external_id  = externalId
   b. dbLinkIdentity(newId, connectorId, externalId)
   c. UPDATE shadow_state SET canonical_id = newId
         WHERE connector_id = connectorId AND external_id = externalId
   d. DELETE FROM written_state
         WHERE connector_id = connectorId AND canonical_id = canonicalId
   e. FOR each sibling (sConnId, sExtId) in siblings:
         dbInsertNoLink(connectorId, externalId, sConnId, sExtId)
   f. dbLogTransaction(action = "split_canonical",
         canonical_id = newId,
         dataBefore = { canonicalId },
         dataAfter  = { canonicalId: newId })
6. COMMIT
7. Return { oldCanonicalId: canonicalId, newCanonicalId: newId,
            connectorId, externalId, noLinkWritten: siblings }
```

### § 3.4 Transaction log entry

Extend `dbLogTransaction` action union:
`action: "insert" | "update" | "split_canonical"`.

`dataBefore` carries `{ canonicalId }` (the old canonical); `dataAfter` carries
`{ canonicalId: newId }`. Existing `insert`/`update` rows are unaffected.

---

## § 4 Playground: event log

The `SyncEvent` interface already supports arbitrary `action` strings. The playground's
`SyncEngine.splitCanonical()` call site (in `engine-lifecycle.ts` or `main.ts`) emits:

```ts
const event: SyncEvent = {
  ts: new Date().toLocaleTimeString(),
  channel: channelId,
  sourceConnector: connectorId,
  sourceEntity: entity,           // resolved from channel members
  targetConnector: "",
  targetEntity: "",
  action: "SPLIT",
  sourceId: externalId,
  targetId: result.newCanonicalId.slice(0, 8),
  phase: "poll",
};
```

This appears in the event log as:
```
HH:MM:SS  crm→      SPLIT   contacts  rec-1… → a3f9bc20…
```

The empty `targetConnector` is consistent with the existing READ event format.

---

## § 5 Playground: UI

### § 5.1 Break button placement

In `playground/src/ui/systems-pane.ts`, each record card inside a **linked** cluster
(`cluster.canonicalId !== null`) that has **≥ 2 populated slots** gets a "Break" button
in its footer, alongside the existing Edit/Delete buttons.

Cards in:
- Unlinked clusters (`canonicalId === null`) — no break button (nothing to split from)
- Linked clusters with only 1 populated slot — no break button (only link; split would be
  a no-op)
- Array sub-object cards (read-only footer) — no break button

### § 5.2 Populated slot count

`ChannelCluster.slots` is `Array<ChannelClusterSlot | null>`. A slot is *populated* when
it is non-null AND `slot.externalIds.length > 0`. The helper:

```ts
function populatedSlotCount(cluster: ChannelCluster): number {
  return cluster.slots.filter((s) => s !== null && s.externalIds.length > 0).length;
}
```

Show the break button when `populatedSlotCount(cluster) >= 2`.

### § 5.3 Break button HTML

```html
<button class="btn-break" title="Break this record out of the cluster">⛓️‍💥</button>
```

or plain text `Break` if the emoji renders too large. Decision left to implementation; keep
consistent with existing Edit/Delete button style (`btn-ghost`-class pills).

### § 5.4 Click handler

On click:

```ts
const result = engineState.engine.splitCanonical(
  channelId, cluster.canonicalId!, slot.connectorId, externalId,
);
onSplitCluster(result); // dispatcher in main.ts
```

`onSplitCluster` in `main.ts`:
1. Emits a `SPLIT` `SyncEvent` to the event log.
2. Calls `buildClusters()` and re-renders the cluster view for the active channel.
3. Refreshes the `no_link` dev-tools tab (§ 6) so the new entries are immediately visible.

No forced edit modal. No poll pause. The `no_link` entries written atomically by
`splitCanonical()` make the split durable regardless of identity-field values. No full
engine restart needed — only a cluster view re-render and dev-tools tab refresh.

### § 5.5 Dirty tracking

`splitCanonical()` is a structural identity change (not a record data edit), so it does
**not** set `isDirty`. The split is reversible by Reset (drops the db, including `no_link`
rows) or by removing individual entries directly from the amber badge popover (§ 5.6).

### § 5.6 Anti-affinity badge on record cards

A record that has one or more `no_link` entries associated with it displays a **broken-link
badge** between the association badges and the footer (same slot as association badges,
§ 5.3 in `specs/playground.md`).

**Badge anatomy:**

```html
<button class="no-link-badge">⛓ no-link (2)</button>
```

- Count shows the number of `no_link` partner pairs for this `(connectorId, externalId)`.
- Styled as a muted amber pill — visually distinct from association badges (blue) and
  missing-target badges (red). Amber signals "intentionally separated."
- Clicking the badge opens an **inline popover** anchored to the badge (§ 5.7).

### § 5.7 Anti-affinity popover

A small popover opens anchored to the badge. It lists each blocked partner with a ✕
button per row, and a header explaining the state:

```
┌─────────────────────────────────────┐
│  ⛓ Anti-affinity (2 entries)       │
│  Records blocked from auto-merging  │
├─────────────────────────────────────┤
│  crm / rec-2                  [✕]  │
│  erp / emp-7                  [✕]  │
└─────────────────────────────────────┘
```

Clicking ✕ on a row:
1. Calls `engine.removeNoLink(connectorIdA, externalIdA, connectorIdB, externalIdB)`.
2. Closes the popover (or re-renders it with the row removed if others remain).
3. Re-renders the cluster view — the badge count decreases or disappears.
4. Refreshes the `no_link` dev-tools tab as a side effect.

The user never leaves the cluster view. No navigation to dev-tools required.

The popover is dismissed by clicking outside it or pressing Escape. Only one popover is
open at a time (opening a second closes the first). Implementation follows the same
pattern as any other transient popover in the UI (absolute-positioned `div`,
`document.addEventListener('click', closeOnOutside)`).

**Data source for the badge:**

The `no_link` entries need to be available at card-render time without a separate lookup.
`DbSnapshot.noLinks` (§ 6.3) is already fetched after each poll. During cluster rendering,
build a lookup map:

```ts
// keyed by "connectorId/externalId" → partner entries[]
const noLinksByRecord = new Map<string, typeof noLinks>();
for (const row of dbSnapshot.noLinks) {
  const keyA = `${row.connector_id_a}/${row.external_id_a}`;
  const keyB = `${row.connector_id_b}/${row.external_id_b}`;
  noLinksByRecord.set(keyA, [...(noLinksByRecord.get(keyA) ?? []), row]);
  noLinksByRecord.set(keyB, [...(noLinksByRecord.get(keyB) ?? []), row]);
}
```

Pass this map into the card renderer. Cost is O(|no_link rows|) per render — negligible.

**Why this matters:** without the badge, a user sees two separate clusters with identical
email addresses and has no explanation for why the engine isn't merging them. The badge
makes anti-affinity explicitly visible at the point of confusion rather than requiring the
user to discover the `no_link` dev-tools tab independently.

---

## § 6 Playground: `no_link` dev-tools tab

### § 6.1 Purpose

The `no_link` tab is an **audit and bulk-management view** — not the primary removal
path. Individual entries are removed from the amber badge popover on the card (§ 5.7).
The tab is useful when you want to see all anti-affinity entries across the whole channel
at once, or when you need to clear multiple entries that are no longer traceable to a
visible card (e.g. after records were edited or the connector reseeded).

### § 6.2 Tab placement

A sixth tab labelled `no_link` is added to the dev-tools panel alongside `Log`,
`identity_map`, `shadow_state`, `watermarks`, and `channels`.

### § 6.3 Tab content

A table with columns:

| id | connector_a | external_a | connector_b | external_b | created_at | |
|----|-------------|------------|-------------|------------|------------|---|
| 3  | crm         | rec-1      | erp         | emp-7      | 2026-04-09 | ✕ |

The trailing column contains a delete button (✕). Clicking it:
1. Calls `engine.removeNoLink(connectorIdA, externalIdA, connectorIdB, externalIdB)`.
2. Refreshes the tab.
3. Re-renders the cluster view and any affected card badges.

The records are now free to re-merge on the next poll; the UI does not force a poll.

Empty state: `— no anti-affinity entries —`.

### § 6.3 Data source

`DbSnapshot` (returned by `engineState.getDbState()`) is extended with:

```ts
noLinks: Array<{
  id: number;
  connector_id_a: string; external_id_a: string;
  connector_id_b: string; external_id_b: string;
  created_at: string;
}>;
```

Populated by `dbGetAllNoLinks(db)`. Refreshed after each poll pass and after each
`splitCanonical()` / `removeNoLink()` call (whether triggered from the badge popover
or directly from the dev-tools tab).

---

## § 7 Tests

New test file: `packages/engine/src/split-canonical.test.ts`.

**Unit tests (db helpers only):**

| # | Scenario | Expected |
|---|---|---|
| 1 | `dbInsertNoLink` write and read back | Row present; normalised order enforced |
| 2 | `dbInsertNoLink` idempotent on duplicate | No error; still one row |
| 3 | `dbRemoveNoLink` removes existing row | Row gone |
| 4 | `dbRemoveNoLink` no-op on missing row | No error |
| 5 | `dbMergeBlockedByNoLink` — canonicals with a no_link pair | Returns `true` |
| 6 | `dbMergeBlockedByNoLink` — canonicals with no no_link pair | Returns `false` |

**Integration tests (full engine round-trip):**

| # | Scenario | Expected |
|---|---|---|
| 7 | Split one record from a 2-way cluster | Two 1-link clusters; shadow_state updated; written_state cleared; 1 no_link row written |
| 8 | Split one record from a 3-way cluster | One 2-link cluster + one 1-link cluster; 2 no_link rows written |
| 9 | Attempt to split the last link | Throws |
| 10 | Split non-existent `(connectorId, externalId)` pair | Throws |
| 11 | After split, next ingest inserts split-off record into other connectors | INSERT appears in ingest results |
| 12 | After split, identity fields still match — next poll does NOT re-merge | `dbMergeBlockedByNoLink` returns true; `dbMergeCanonicals` is skipped; two clusters remain separate |
| 13 | After `removeNoLink`, identity fields still match — next poll re-merges | `dbMergeCanonicals` fires; clusters reunite |
| 14 | Split on a channel with no identity fields | Split works; no_link rows still written (defensive) |

---

## § 8 Spec changes planned

### `specs/identity.md`

Append two new sections at the end of the file.

**`## § Split Operation`**

> Splitting is the inverse of merging. Given a canonical UUID with ≥ 2 external IDs linked
> to it, a caller may detach one `(connectorId, externalId)` pair by calling
> `engine.splitCanonical(channelId, canonicalId, connectorId, externalId)`. The engine:
>
> 1. Removes the pair's row from `identity_map`.
> 2. Creates a new canonical UUID and inserts the pair under it.
> 3. Migrates `shadow_state` rows for that connector/externalId to the new UUID.
> 4. Clears `written_state` for that connector and old canonical so the next sync cycle
>    propagates the split-off record as a new entity.
> 5. Writes `no_link` entries for every sibling in the old cluster (§ Anti-Affinity).
> 6. Logs a `split_canonical` row to `transaction_log`.
>
> Splitting the sole remaining link on a canonical is rejected.

**`## § Anti-Affinity (no_link)`**

> The `no_link` table stores explicit anti-affinity declarations between pairs of external
> IDs. Each row asserts that those two records must never be merged into the same canonical
> UUID. The guard is checked before every `dbMergeCanonicals` call: in `_resolveCanonical()`
> (incremental ingest), `onboard()`, and `addConnector()`. If a merge would violate a
> `no_link` row, that merge is skipped; other merges in the same pass proceed normally.
>
> Anti-affinity is reversible: `engine.removeNoLink()` deletes the row and re-enables
> automatic matching for that pair. Pairs are stored in normalised order so `(A, B)` and
> `(B, A)` map to the same row.

### `specs/playground.md`

1. Add `§ 4.9 Cluster split (break) button`:
   - Button on non-array cards in linked clusters with ≥ 2 populated slots.
   - On click: calls `engine.splitCanonical()`, emits `SPLIT` event, re-renders cluster view
     and refreshes `no_link` dev-tools tab.

2. Extend `§ 5.5 Footer and action buttons`:
   - Add "Break" button; absent from unlinked clusters and sole-link clusters.

3. Add `§ 5.6 Anti-affinity badge` and `§ 5.7 Anti-affinity popover`:
   - Amber pill badge `⛓ no-link (N)` on cards that have `no_link` entries.
   - Clicking opens an inline popover listing each blocked partner with a ✕ per row.
   - ✕ calls `removeNoLink()`, collapses the row, re-renders badges and cluster view.
   - Popover dismissed by outside click or Escape.

4. Extend `§ 7` dev-tools panel table — add `no_link` tab row:
   - Audit/bulk view: table of all anti-affinity pairs with per-row delete (✕).
   - Primary removal path is the badge popover (§ 5.7); this tab is for bulk/audit use.
   - Empty state: `— no anti-affinity entries —`.
   - Refreshed after each poll pass and after each `splitCanonical()` / `removeNoLink()`.

---

## § 9 Open questions

- **Icon vs text label.** The ⛓️‍💥 emoji is visually descriptive but may not render on
  all platforms. A plain text "Break" or a chain-link SVG icon is a safe fallback.
- **`no_link` across Reset.** A playground Reset drops the db, wiping all `no_link` rows.
  For the playground this is fine — the session is ephemeral. For a real deployment,
  `no_link` rows survive restarts because they live in the persistent SQLite db.
- **Cross-cluster anti-affinity (future).** The current plan only writes `no_link` entries
  implicitly via `splitCanonical()`. Explicitly marking two records from *different* clusters
  as non-matching would need a two-card selection UI gesture. Out of scope for this plan.
- **`no_link` guard completeness in `onboard()`/`addConnector()`.** For the playground,
  only the `_resolveCanonical()` guard (incremental path) is exercised — `onboard()` and
  `addConnector()` only run at boot and are cleared by Reset. The guards should still be
  implemented per § 2.3 for correctness in persistent deployments.

---

## § 10 Changelog entry (draft)

```
### Added
- **Sync Engine** — `no_link` anti-affinity table: explicit pairs of external IDs that
  must never be merged; checked before every `dbMergeCanonicals` call in ingest,
  onboard, and addConnector.
- **Sync Engine** — `SyncEngine.splitCanonical()`: detach one connector record from a
  shared canonical cluster, atomically writing `no_link` entries for all siblings so the
  split is durable across subsequent identity-field-matching polls.
- **Sync Engine** — `SyncEngine.removeNoLink()`: remove an anti-affinity declaration,
  re-enabling automatic matching for the pair.
- **Browser Playground** — Break button on linked cluster cards (≥ 2 populated slots);
  logs a SPLIT event to the event log.
- **Browser Playground** — `no_link` dev-tools tab: table of active anti-affinity entries
  with per-row delete.
- **Browser Playground** — amber `⛓ no-link (N)` badge on record cards that have
  anti-affinity entries; clicking opens an inline popover listing each blocked partner
  with a ✕ per row to remove the entry without leaving the cluster view.
```
