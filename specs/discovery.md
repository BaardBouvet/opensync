# Discovery & Onboarding

First-time setup between systems that already have data. The most dangerous moment in bi-directional sync — get it wrong and you create thousands of duplicates or trigger an echo storm.

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
