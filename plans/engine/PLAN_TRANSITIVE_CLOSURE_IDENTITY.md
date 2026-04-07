# Engine: Transitive Closure Identity

**Status:** complete  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** Engine  
**Scope:** `packages/engine/src/engine.ts`, `packages/engine/src/db/queries.ts`, `packages/engine/src/config/`, `specs/identity.md`, `specs/discovery.md`, `specs/config.md`  
**Depends on:** none  
**See also:** `plans/engine/GAP_OSI_PRIMITIVES.md §2`, `specs/identity.md § Field-Value-Based Matching`  

---

## § 1 Problem Statement

The engine's identity matching uses a composite key — all `identityFields` joined with a
separator. This requires **every** identity field to match for two records to be linked.
It does not handle transitive chains: if A matches B via `email` and B matches C via `taxId`,
the current code never links A and C.

### § 1.1 Concrete failure scenario

Channel `contacts` with `identityFields: [email, taxId]`. Three systems A, B, C each have one
contact record:

| Record | email               | taxId |
|--------|---------------------|-------|
| A/a1   | alice@example.com   | —     |
| B/b1   | alice@example.com   | 123   |
| C/c1   | —                   | 123   |

A and B share `email`. B and C share `taxId`. They are the same real-world person and should
all resolve to the same canonical UUID. The composite key for each is different:

| Record | buildKey result           |
|--------|---------------------------|
| A/a1   | `"alice@example.com\x01"` |
| B/b1   | `"alice@example.com\x01123"` |
| C/c1   | `"\x01123"`              |

None match. `discover()` classifies all three as `uniquePerSide`. `onboard()` inserts A and C
as independent entities into the other connectors, creating three separate canonicals instead
of one.

### § 1.2 Where the bug lives

Three places use the composite key approach:

**`discover()` (lines ~465–510 of `engine.ts`)**  
Builds `keyIndex: Map<compositeKey, DiscoverySide[]>`. Any record whose fields only partially
overlap with other records' fields is classified as unique.

**`addConnector()` (lines ~869–910)**  
Builds `canonIdx: Map<compositeKey, canonicalId>` from existing canonicals, then looks up
each joiner record by composite key. Same miss for partial-overlap bridges.

**`_resolveCanonical()` (lines ~1013–1035)**  
Iterates `identityFields` one at a time and **returns on the first match**. If an incoming
record has `email` matching canonical-A and `taxId` matching canonical-B, only the first
field hit is acted on. The second match is silently dropped — canonical-A and canonical-B
are never merged, and the second match's canonical is orphaned.

---

## § 2 Algorithm Design

Replace per-location composite key logic with a shared **group-aware union-find** (disjoint-set
with path compression and union-by-rank) that handles both single-field and compound groups.

### § 2.1 Union-find for discover() and addConnector()

```
nodes   = all records from all connectors (index 0..N-1)
parent  = [0, 1, 2, ..., N-1]   // each record is its own root initially
rank    = [0, 0, 0, ..., 0]

groups  = resolveGroups(channel)  // [{ fields: ['email'] }, { fields: ['firstName','lastName','dob'] }, ...]

for each group:
  keyIndex: Map<groupKey, nodeIndex[]>
  for each node:
    k = buildGroupKey(node.canonical, group.fields)  // join normalised values; blank if any field absent
    if k is blank: skip           // group key requires all fields to be present
    keyIndex[k].push(nodeIndex)
  for each key with ≥2 nodes:
    union all nodes sharing that key

components = group nodes by find(nodeIndex)
for each component:
  if 2+ distinct connectorIds:  → DiscoveryMatch  (matched)
  if 1 connectorId, 1 record:   → uniquePerSide   (no cross-link)
  if 1 connectorId, 2+ records: → ambiguous       (warn; treat as uniquePerSide)
```

`buildGroupKey(canonical, fields)` = `fields.map(f => normalize(canonical[f])).join("\x01")`; returns
blank if any field in `fields` is absent or empty after normalisation.

The "ambiguous" case — two records from the same connector sharing an identity field value —
would be a duplicate inside that system. The engine cannot resolve which record to link, so it
emits a warning and leaves the component in `uniquePerSide`. A future `DiscoveryWarning` field
on `DiscoveryReport` can surface these.

### § 2.2 Normalize rule

The normalisation applied per value is identical to the current rule: `toLowerCase().trim()`.
Empty string after normalisation is treated as blank (not a key).

### § 2.3 Canonical data for a matched component

When a component spans multiple connectors, `canonicalData` is the merged field set: start
with the record from the first connector (sorted by connectorId for determinism), then fill
in any missing fields from subsequent records. This matches the existing `match.sides[0].rawData`
heuristic but makes field priority explicit.

### § 2.4 Fix for _resolveCanonical()

Replace the early-return loop with a collect-then-merge loop that works over groups:

```
matchedCanonicals: string[]
groups = resolveGroups(channel)

for each group:
  k = buildGroupKey(canonical, group.fields); if blank: continue
  cid = dbFindCanonicalByGroup(db, entityName, connectorId, group.fields, values)
  if cid: matchedCanonicals.push(cid)

if matchedCanonicals.length === 0:
  return _getOrCreateCanonical(connectorId, externalId)

// Merge all found canonicals into one
winner = matchedCanonicals[0]
for rest of matchedCanonicals[1..]:
  if rest !== winner: dbMergeCanonicals(winner, rest)

// Link this external ID to the winner
ownId = dbGetCanonicalId(connectorId, externalId)
if ownId && ownId !== winner:  dbMergeCanonicals(winner, ownId)
if !ownId:
  alreadyLinked = dbGetExternalId(winner, connectorId)
  if !alreadyLinked: dbLinkIdentity(winner, connectorId, externalId)
  else: return _getOrCreateCanonical(connectorId, externalId)

return winner
```

For single-field groups, `dbFindCanonicalByGroup` is the existing `dbFindCanonicalByField`.
For compound groups it uses AND-chained `JSON_EXTRACT` conditions in one SQL query;
no multi-query intersection required.

### § 2.5 Config: identityGroups

`identityFields: string[]` stays in the schema. When the engine resolves groups it
expands `identityFields` as:

```
resolveGroups(channel): IdentityGroup[]
  if channel.identityGroups is set: return identityGroups
  return (channel.identityFields ?? []).map(f => ({ fields: [f] }))
```

A new optional config key `identityGroups` is added alongside `identityFields`:

```yaml
channels:
  - id: contacts
    # Simple case — each field is its own group (OR-per-field, transitive)
    identityFields: [email, taxId]

    # Compound case — group 1: email alone; group 2: all three of firstName+lastName+dob
    identityGroups:
      - fields: [email]
      - fields: [firstName, lastName, dob]
```

If both are present, `identityGroups` takes precedence (a config validation warning is emitted).
Type change is additive; no existing config files break.

---

## § 3 Scope of Changes

### § 3.1 Engine (packages/engine/src/engine.ts)

| Location | Change |
|----------|--------|
| `discover()` — `buildKey` / `keyIndex` block | Replace with group-aware union-find. Extract shared `_buildUnionFind(records, groups)` private method that returns component groups. Remove old `buildKey` helper from this function. |
| `addConnector()` — `canonIdx` / `buildKey` block | Replace `buildKey` lookup with group-aware per-group matching. For each joiner record, collect all matched canonicalIds across groups and merge. |
| `_resolveCanonical()` — early-return loop | Replace with collect-then-merge loop (§2.4). |
| Config resolution | Add private `_resolveGroups(channel)` helper that converts `identityGroups` / `identityFields` to `IdentityGroup[]`. |

### § 3.2 DB queries (packages/engine/src/db/queries.ts)

Add `dbFindCanonicalByGroup(db, entityName, excludeConnectorId, fields, values)` for compound
groups. Uses AND-chained `JSON_EXTRACT` conditions in a single SQL query. For single-field
groups, the existing `dbFindCanonicalByField` is used as-is.

### § 3.3 Config schema + loader (packages/engine/src/config/)

| File | Change |
|------|--------|
| `schema.ts` | Add `identityGroups: z.array(z.object({ fields: z.array(z.string()) })).optional()` to channel schema. Emit `z.warn` if both `identityFields` and `identityGroups` are set. |
| `loader.ts` | Pass `identityGroups` through alongside `identityFields` on the loaded `ChannelConfig`. |

Add `IdentityGroup` type to the engine's type exports.

### § 3.4 No DB schema changes

`identity_map` and `shadow_state` are unchanged. The union-find is a pure in-memory algorithm
at the discover/addConnector phase. `dbMergeCanonicals` handles the DB write.

### § 3.5 No connector changes

No connector interface changes. Connectors continue to return `ReadRecord.data` with whatever
fields they have; `identityFields` / `identityGroups` matching is entirely engine-internal.

---

## § 4 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/identity.md` | Field-Value-Based Matching — Trade-offs bullet on transitive closure | Update to say transitive closure is supported; remove the current "not currently supported" qualifier |
| `specs/identity.md` | Field-Value-Based Matching | Add subsection "Transitive Closure" describing the group-aware union-find algorithm, the blank-value group-skip rule, and the ambiguity warning |
| `specs/identity.md` | Field-Value-Based Matching | Add `identityGroups` config key documentation alongside `identityFields`; explain the AND-within-group, OR-across-groups semantics |
| `specs/discovery.md` | `discover()` § Matching | Replace "exact match on all identityFields" with the group-aware union-find description; add blank-group-skip rule and ambiguity/same-connector-duplicate rule |
| `specs/config.md` | ChannelConfig | Add `identityGroups` field documentation |

All spec updates must be made in the same session as the code change.

---

## § 5 Tests

New tests in `packages/engine/src/onboarding.test.ts` (or a new
`packages/engine/src/transitive-identity.test.ts`):

| Test | Scenario |
|------|----------|
| T-TC-1 | Three connectors, `identityFields: [email, taxId]`. A has email only, B has both, C has taxId only. After discover+onboard, A/B/C share one canonical UUID. |
| T-TC-2 | Longer chain: A–B via email, B–C via taxId, C–D via phone. All four resolve to one canonical (four-leg transitive chain). |
| T-TC-3 | Ambiguous component: two records from connectorA share the same email, plus one record from connectorB. `DiscoveryReport.matched` should not include this component; both connectorA records remain in `uniquePerSide`. |
| T-TC-4 | `_resolveCanonical` ingest-time fix: ingest B (email + taxId) into a channel where A's canonical exists (matched by email) and C's canonical exists (matched by taxId). After ingest, A and C share the same canonical UUID as B. |
| T-TC-5 | `addConnector` bridge: channel A+B live. Add C with both email (matching A's canonical) and taxId (matching a different earlier-ingested provisional). After `addConnector`, C links to the merged A-canonical. |
| T-LG-1 | `identityGroups: [{ fields: [email] }, { fields: [firstName, lastName, dob] }]`. Record A has only email; record B has only firstName+lastName+dob (no email); they do NOT match (no shared group key). |
| T-LG-2 | Same `identityGroups`. Record A has email+firstName+lastName+dob; record B has only email. They match via the email group. Record C has matching firstName+lastName+dob but a different email. C matches B via the compound group; transitive closure links all three. |
| T-LG-3 | `identityGroups` at ingest-time via `_resolveCanonical`: incoming record satisfies the compound group against an existing canonical. Mapped to that canonical, not a new one. |
| T-LG-4 | Both `identityFields` and `identityGroups` present in channel config — `identityGroups` wins; a config validation warning is emitted. |

All tests must be added **before** the implementation (TDD per AGENTS.md).

---

## § 6 Out of Scope

- Weighted/confidence-scored matching: no fuzzy matching; values must still normalise to equal
  strings.
- Cross-channel identity: linking records across *different channels* (e.g. a `contact` in
  channel-contacts and a `company` in channel-companies sharing a tax ID). OpenSync channels
  are independent entity concepts; identity is always resolved within one channel. Within a
  channel, connectors may use different local entity names — that is handled by `ChannelMember.entity`
  and is already in scope.
- Association-mediated identity: linking contact A to contact C because A is associated with
  company B and C is also associated with company B. This is a graph traversal over the
  association layer, not over field values, and is a separate concern.
- `DiscoveryWarning` type on `DiscoveryReport`: the ambiguity warning path (§2.1) logs to
  console for now. A structured `warnings` field on `DiscoveryReport` can be added in a
  follow-up.
