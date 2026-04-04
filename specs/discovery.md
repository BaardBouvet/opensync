# Discovery & Onboarding

First-time setup between systems that already have data. The most dangerous moment in
bi-directional sync — turn on sync without onboarding first and every record in both
systems looks "new", creating thousands of duplicates.

Proven in POC v7–v9. The algorithm in this document is implementation-ready.

---

## The Problem

System A has 1 000 contacts. System B has 800 customers. 600 are the same people. If you
run a normal `ingest()` without onboarding, the engine sees 1 000 "new" records from A and
inserts them all into B, then sees 800 "new" records from B and inserts them all into A.
Result: 1 800 duplicates across two systems.

The root cause: `identity_map` is empty. The engine has no way to know that `a1` and `b1`
are the same real-world entity. It creates a new canonical UUID for each, links each to its
own connector, and dispatches blindly.

---

## The Solution: Ingest-First

Separate **data collection** from **identity resolution**. Collect data from all connectors
first (writing shadow state, creating provisional canonicals, no fan-out), then resolve
identity in one DB-only pass, then commit the links.

### Initial onboarding of a new channel (A + B)

```
1. ingest(A, { collectOnly: true })
     Reads A's records. For each: writes shadow_state row, creates provisional
     identity_map row (A → canonA). No fan-out. Always safe — no OnboardingRequired guard.

2. ingest(B, { collectOnly: true })
     Same for B. Provisional rows (B → canonB) are self-only.

3. discover(channelId)
     Pure DB query on shadow_state. Matches A and B records by identityFields.
     Returns a DiscoveryReport — no connector calls, safe to run multiple times.

4. onboard(channelId, report)
     For matched pairs: dbMergeCanonicals(canonA, canonB) — updates all identity_map
     and shadow_state rows pointing at canonB to use canonA instead. One canonical per
     real-world entity, linked to both A and B.
     For unique-per-side records: insert into the other side via entity.insert().
     After commit: cross-links exist → fan-out guard allows A↔B sync.

5. ingest(A) / ingest(B) — normal sync. Zero writes (shadow was pre-seeded).
```

### Adding a new connector to a live channel (A + B already ready, adding C)

```
1. ingest(C, { collectOnly: true })
     Writes shadow_state[C] + provisional self-only canonicals.
     Channel stays ready for A+B — C is invisible to the fan-out guard.
     A and B can continue syncing normally during this window. Any changes made
     to A or B during this window are recorded in their shadows.

2. addConnector(channelId, "C")
     a. Read C's records from shadow_state (no live connector call).
     b. Match against the canonical layer (same algorithm as discover()).
     c. For matched entries: dbMergeCanonicals(existingCanon, cProvisional).
     d. CATCH-UP: compare C's collected snapshot against the current canonical
        (which reflects any A/B changes during the collection window). For each
        matched record that differs, call C.update() and advance C's shadow.
        C is fully current before addConnector() returns.
     e. For C records not matched (newFromJoiner): insert into all existing members.
     f. For canonical records absent in C (missingInJoiner): insert into C.
     g. Advance C's watermark. Channel stays ready throughout.

3. ingest(A) / ingest(B) / ingest(C) — all three sync. 0 writes (all shadows current).
```

---

## Channel Readiness

A channel is **ready** for sync when at least two of its configured connectors share a
cross-linked canonical_id in `identity_map` — i.e. a canonical_id that appears in more than
one `(connector_id, external_id)` row.

```sql
-- "Are there any cross-linked canonicals for these connectors?"
SELECT COUNT(*) FROM (
  SELECT canonical_id FROM identity_map
  WHERE connector_id IN (?)
  GROUP BY canonical_id
  HAVING COUNT(DISTINCT connector_id) > 1
)
```

`identity_map` is the sole source of truth for channel readiness. There is no separate status
table.

### `engine.onboardedConnectors(channelId): string[]`

Returns the connector_ids that have at least one cross-linked canonical. Use this to determine
which connectors are participating in active sync and which are still being collected.

---

## `discover(channelId): Promise<DiscoveryReport>`

Reads entirely from shadow_state. Zero live connector calls. Safe to call multiple times
without side effects.

**Requires**: `ingest({collectOnly: true})` has been run for every channel member. If any
member has no shadow_state rows, throws with a message pointing to the collect step.

**Matching**: exact match on all `identityFields` (case-insensitive, whitespace-trimmed).
Records matched on all identity fields → `DiscoveryReport.matched`.
Records with no match in any other connector → `DiscoveryReport.uniquePerSide`.

```typescript
interface DiscoveryReport {
  channelId:     string;
  entity:        string;
  matched:       DiscoveryMatch[];
  uniquePerSide: DiscoverySide[];
  summary:       Record<string, { total: number; matched: number; unique: number }>;
}

interface DiscoveryMatch {
  canonicalData: Record<string, unknown>;
  sides: Array<{ connectorId: string; externalId: string; rawData: Record<string, unknown> }>;
}
```

---

## `onboard(channelId, report, opts?): Promise<OnboardResult>`

Commits the discovery report. Idempotent: re-running after failure is safe.

Steps:
1. For each `matched` entry: `dbMergeCanonicals(keepId, discardId)` — single atomic UPDATE that
   redirects all identity_map and shadow_state rows from the discarded provisional to the kept one.
2. For each `uniquePerSide` entry: call the other side's `entity.insert()` directly (bypasses
   shadow-diff, which would produce "skip" since the shadow already exists from collect).
   Link the new external ID. Seed shadow_state.
3. Advance watermarks for all members to `now`.

```typescript
interface OnboardResult {
  linked:        number;   // canonical merge operations
  shadowsSeeded: number;   // shadow rows written/updated
}

interface OnboardOptions {
  dryRun?: boolean;   // return what would happen without writing anything
}
```

---

## `addConnector(channelId, connectorId, opts?): Promise<AddConnectorReport>`

Join a new connector to an already-live channel. The connector must have been pre-ingested
with `{ collectOnly: true }` first (throws a helpful error if not).

Steps:
1. Load the current canonical dataset from existing cross-linked members.
2. Read the joiner's records from shadow_state (no live fetch).
3. Match joiner records against the canonical layer using identityFields.
4. If `dryRun`: return the report, stop here.
5. For `linked` entries: `dbMergeCanonicals`, re-seed joiner's shadow.
6. **Catch-up**: for each linked entry, compare joiner's collected data against the current
   canonical. If different, call `joiner.update()` and advance joiner's shadow. This delivers
   any changes made to A/B during the collection window without requiring a subsequent ingest.
7. For `newFromJoiner` entries: insert into all existing members.
8. For `missingInJoiner` entries (default `missingFromJoiner: "propagate"`): insert into joiner.
9. Advance joiner's watermark.

```typescript
interface AddConnectorReport {
  channelId:        string;
  connectorId:      string;
  linked:           Array<{ canonicalId: string; externalId: string; matchedOn: string[] }>;
  newFromJoiner:    Array<{ externalId: string; data: Record<string, unknown> }>;
  missingInJoiner:  Array<{ canonicalId: string; data: Record<string, unknown> }>;
  summary: {
    totalInJoiner:   number;
    linked:          number;
    newFromJoiner:   number;
    missingInJoiner: number;
  };
}

interface AddConnectorOptions {
  dryRun?:           boolean;
  missingFromJoiner?: "propagate" | "skip";  // default: "propagate"
}
```

---

## Deduplication Guarantee

The ingest-first approach guarantees zero duplicates on onboarding because:

1. `collectOnly` ingest creates **provisional** self-only canonicals — one per record, linked
   only to the connector that provided it. This is just pre-seeding; it commits nothing to the
   shared canonical layer.

2. `onboard()` / `addConnector()` calls `dbMergeCanonicals(keep, discard)` which **redirects**
   the discard canonical to the keep canonical in a single UPDATE. No new UUID is allocated for
   matched records. The matched pair ends up sharing one canonical_id with two identity_map rows.

3. Because the canonical_id was already in shadow_state when the record was collected, the
   first normal ingest after onboarding sees shadow = incoming → diff → zero changes → zero writes.
   No records are re-inserted.

Compare with the "naive" approach (no collect phase): turning on normal ingest immediately
would create a new canonical_id for every record on both sides, then fan each to the other
side, resulting in 2× the original record count in each system.

---

## Fuzzy / Probabilistic Matching

Out of scope. All matching is exact on `identityFields` (case-insensitive, trimmed). Fuzzy
matching, confidence scores, and partial-match queues are not proven in the POCs and are not
specified for the initial implementation.


## The Problem

System A has 1000 contacts. System B has 800 customers. 600 are the same people. If you just "turn on" sync, the engine sees 1000 "new" records in A and 800 "new" records in B, creating 1800 duplicates.

## The Solution: Match, Link, Populate

### Step 1: Bulk Fetch

Fetch ALL records from both systems (no `since` filter).

```typescript
class BulkFetcher {
  fetchAll(connectorInstanceId: string, entityType: string): AsyncIterable<NormalizedRecord[]>;
}
```

### Step 2: Match Engine

Compare records across systems using configurable rules.

```typescript
interface MatchRule {
  sourceField: string;
  targetField: string;
  strategy: 'exact' | 'fuzzy' | 'composite';
  weight?: number;        // for composite scoring
  threshold?: number;     // for fuzzy matching (0.0 - 1.0)
}

class MatchEngine {
  match(
    sourceRecords: NormalizedRecord[],
    targetRecords: NormalizedRecord[],
    rules: MatchRule[],
    mapping: EntityMapping      // for field name translation
  ): Promise<MatchReport>;
}
```

### Match Report

The output categorizes every record:

```typescript
interface MatchResult {
  sourceRecord: NormalizedRecord;
  targetRecord: NormalizedRecord;
  confidence: number;       // 0.0 - 1.0
  matchedFields: string[];
}

interface MatchReport {
  matched: MatchResult[];              // high confidence — auto-link
  partial: MatchResult[];              // needs human review
  uniqueInSource: NormalizedRecord[];  // only in source, create in target?
  uniqueInTarget: NormalizedRecord[];  // only in target, create in source?
  summary: {
    total_source: number;
    total_target: number;
    matched_count: number;
    partial_count: number;
    unique_source_count: number;
    unique_target_count: number;
  };
}
```

Example output:
```
Found 600 exact matches on email.
Found 12 partial matches (same name, different email) — review recommended.
200 contacts only in HubSpot.
50 customers only in Fiken.
```

### Match Strategies

**exact**: Field values must be identical (after normalization). Best for email, org number.

**fuzzy**: Levenshtein distance or similar. Good for names where spelling varies. Configurable threshold (e.g. 0.85 = 85% similar).

**composite**: Weighted combination of multiple fields. Example: email match = 0.6 weight, name match = 0.3 weight, phone match = 0.1 weight. Total score must exceed threshold.

### Step 3: Linking

Create identity map entries from match results.

```typescript
class Linker {
  linkMatches(
    matchReport: MatchReport,
    sourceInstanceId: string,
    targetInstanceId: string,
    mapping: EntityMapping
  ): Promise<LinkingResult>;
}

interface LinkingResult {
  linked: number;        // matched records linked
  newInSource: number;   // unique-in-source records queued for creation in target
  newInTarget: number;   // unique-in-target records queued for creation in source
  skipped: number;       // partial matches not auto-linked
}
```

### Step 4: Shadow State Population (Critical)

**This prevents the echo storm.** After linking matched records, populate shadow state for BOTH sides with their current data.

When the engine later runs a normal sync:
- It fetches from System A → diffs against shadow state → "no changes" (values match)
- It fetches from System B → diffs against shadow state → "no changes"

Without this step, every matched record would look "new" and be synced back, creating chaos.

```typescript
// Inside Linker.linkMatches():
for (const match of matchReport.matched) {
  const entityId = await identityMap.linkExternalId(entityType, sourceInstanceId, match.sourceRecord.id);
  await identityMap.linkExternalId(entityType, targetInstanceId, match.targetRecord.id);

  // Populate shadow state for BOTH sides
  await shadowState.upsert(sourceLinkId, fieldsFromRecord(match.sourceRecord));
  await shadowState.upsert(targetLinkId, fieldsFromRecord(match.targetRecord));
}
```

## Pre-flight Checks

Before starting onboarding or any large sync, run capability checks.

```typescript
interface PreflightWarning {
  level: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

function runPreflightChecks(
  sourceConnector: OpenSyncConnector,
  targetConnector: OpenSyncConnector,
  mapping: EntityMapping
): PreflightWarning[];
```

Example warnings:
- "Target system cannot delete records. Inserts are permanent."
- "Target system has immutable fields: [invoice_number]. These cannot be updated after creation."
- "Source field 'org_nr' has no mapping to target. It will be ignored."
- "200 records in source have no match. They will be created in target."

## LLM-Assisted Matching (Future)

For partial matches where confidence is uncertain, an LLM could analyze the data and suggest whether two records are the same entity. Example: "Ola Nordmann" in System A and "O. Nordmann" in System B — an LLM can infer these are likely the same person with higher confidence than simple string similarity.

This is not in scope for the initial implementation but the match engine's pluggable strategy design supports it.
