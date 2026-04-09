# PLAN: Non-Local Entity Associations

**Status:** draft  
**Date:** 2026-04-05  
**Domain:** packages/engine, packages/sdk  
**Scope:** Association resolution across channel boundaries  
**Spec:** specs/associations.md, specs/connector-sdk.md  
**Depends on:** PLAN_EAGER_ASSOCIATION_MODE.md (complete)  

---

## 1. Problem

Association `targetEntity` currently must name an entity that is a member of the **same
channel** as the source connector. The engine resolves the reference by walking
`this.channels` to find the pair `(fromConnector, entityName)` and then returning
`toConnector`'s entity name in that same channel (`_translateTargetEntity`).

This breaks down when two connectors reference the same real-world thing but live in
different channels — or when neither channel has any explicit cross-connector
membership for the referenced entity type.

**The concrete case: two RDF/SPARQL connectors.**

```
channel: vocabularies
  sparql-a  entity: organization   (reads from endpoint A)
  sparql-b  entity: org            (reads from endpoint B)

channel: events
  sparql-a  entity: event          (also on endpoint A)
```

A record from the `events` channel might carry:

```typescript
// ReadRecord from sparql-a, events channel
{
  id: 'https://example.com/event/1',
  data: {
    'https://schema.org/organizer': {
      '@id': 'https://dbpedia.org/resource/CERN',
      '@entity': 'organization',   // sparql-a's local entity name
    }
  }
}
```

In the RDF world `targetId` is a URI — globally unambiguous, the same URI that
`sparql-b` would use for the same organization. The engine should be able to recognise
that `sparql-b:org` and `sparql-a:organization` are the same thing and reuse the
canonical identity that was already established via the `vocabularies` channel.

With the current model, `_translateTargetEntity('organization', 'sparql-a', 'sparql-b')`
finds no match because the two connectors share the `vocabularies` channel — but
`_translateTargetEntity` is called in the context of the **events** fan-out pass, where
`sparql-b` is not a member. The lookup falls through and `targetEntity` is passed
through unchanged (`organization`), which is wrong for `sparql-b`.

A secondary case: a connector whose association target is an **entity in a different
channel that it does not itself belong to** — the connector knows the target exists
somewhere in the engine's identity map but cannot express the cross-channel link in any
current config construct.

---

## 2. Why This Matters Beyond RDF

The pattern appears whenever:

- A connector references an entity type that is managed by a different sync channel
  (e.g., a `tickets` channel references `contacts` that live in a `people` channel)
- The `targetId` values are already globally stable across systems (URIs, UUIDs, ISINs,
  IATA codes, …) — the identity linkage is implicit in the ID itself, not established
  by discovery
- Two connectors share a common external vocabulary (currency codes, ISO country codes,
  industry taxonomies) that is not itself a sync source — it's read-only seed data that
  both connectors reference in their associations

---

## 3. What Does Not Change

The identity map (`identity_map` table) is already entity-type-agnostic. The lookup
`dbGetCanonicalId(db, connectorId, externalId)` uses only `(connector_id, external_id)` —
no entity type column exists. If two connectors that happen to use the same `externalId`
value for the same real-world thing are ever linked via `dbLinkIdentity`, the engine
already has the canonical UUID to translate the association.

The problem is not the identity map itself. The problem is:

1. **`_entityKnownInShadow`**: returns `false` for an entity name that isn't in any
   channel member, causing the engine to surface an `error` (Rule 3 in
   `specs/associations.md §6`) rather than deferring or resolving.
2. **`_translateTargetEntity`**: requires `fromConnector` and `toConnector` to share a
   channel. Cross-channel references always fall through to the identity passthrough.
3. **No config mechanism** to declare that two connectors in different channels
   reference the same entity type, or that a `targetId` is globally stable (and thus
   needs no translation at all because both systems use the same ID).

---

## 4. Option Space

### Option A — Cross-channel entity alias declarations in config

Add a top-level `entityAliases` block to channel config:

```yaml
entityAliases:
  - connector: sparql-a
    entity: organization
    aliasFor:
      - connector: sparql-b
        entity: org
```

`_translateTargetEntity` and `_entityKnownInShadow` consult this alias table in addition
to channel membership. The alias is directional: `sparql-a:organization` is an alias for
`sparql-b:org` when the target connector is `sparql-b`.

**Pro:** no change to the connector contract. No new field on `Association`.  
**Con:** verbose; O(n²) for large vocabularies; user must maintain it alongside the
channel config even though the semantic equivalence is already implicit in shared predicates.

---

### Option B — `targetType` URI field on `Association`

Extend `Association` with an optional `targetType` field:

```typescript
interface Association {
  predicate: string;
  targetEntity: string;          // connector's local entity name — unchanged
  targetId: string;
  targetType?: string;           // optional globally stable type URI
  metadata?: Record<string, unknown>;
}
```

When `targetType` is present:

1. **Identity resolution**: the engine still uses `(connectorId, targetId)` → canonical UUID
   via the identity map. `targetType` does not change how IDs are looked up.
2. **Entity name translation**: instead of walking channel membership to find the target
   entity name, the engine looks up which local entity name the target connector has
   registered for `targetType`. This requires a per-entity `semanticType` declaration on
   `EntityDefinition` (see §4.3 below).
3. **`_entityKnownInShadow`**: accepts any entity whose `EntityDefinition` carries a
   matching `semanticType`.

```typescript
interface EntityDefinition {
  // ... existing fields
  semanticType?: string;    // e.g. 'https://schema.org/Organization'
}
```

Engine side: build a reverse map `semanticType → Map<connectorId, entityName>` at startup.
`_translateTargetEntity` falls back to this map when channel-membership lookup fails.

**Pro:** connectors declare their own semantic type independently; no cross-connector
config; scales to large vocabularies; RDF connectors can derive `semanticType` from their
schema prefix automatically.  
**Con:** adds a field to both `Association` and `EntityDefinition`; connector authors
must know to set it for RDF-style connectors; two connectors declaring the same
`semanticType` must actually be referencing the same canonical entities (no validation
possible without cross-channel identity linkage).

---

### Option C — Globally stable `targetId` passthrough (zero translation)

If `targetId` is a URI (or any globally unique value), the engine can skip the identity
translation step entirely and pass `targetId` through unchanged to the target connector.
The target connector already knows this URI and can resolve it natively.

The connector signals this by omitting `targetType` (Option B) or by a simpler marker:

```typescript
interface Association {
  predicate: string;
  targetEntity: string;
  targetId: string;
  stable?: true;    // targetId is globally stable; skip identity translation
}
```

When `stable: true`: skip the `dbGetCanonicalId` / `dbGetExternalId` round-trip; pass
`targetId` to the target as-is; skip deferred association handling for this edge.

**Pro:** zero config, zero extra identity infrastructure; perfect for RDF/URI-based IDs.  
**Con:** opts out of identity tracking entirely for this edge; engine cannot detect if the
referenced record changes its canonical mapping; not useful for relational systems where
IDs differ per system.

---

### Option D — Shared "vocabulary channel" with membership in multiple channels

No new primitives. Users add both connectors to a shared channel for the referenced
entity type. `sparql-a:organization` and `sparql-b:org` both become members of a
`organizations` channel. `_translateTargetEntity` already handles this — it will find
the shared channel and return the mapping.

**Pro:** no spec changes, no new fields.  
**Con:** forces every globally-referenced entity to have its own channel, even if the
engine never needs to sync it bidirectionally. Pollutes channel config; confusing to users
who think of channels as sync units, not identity namespaces.

---

## 5. Recommended Direction

**Implement Options B and C together**, as they address complementary cases:

- **Option B** (`semanticType` on `EntityDefinition`, `targetType` on `Association`):
  handles the case where two connectors reference the same real-world type via different
  local names, and the engine needs to translate the entity name and may need identity
  linkage.
- **Option C** (`stable: true` on `Association`): handles URI-identified references
  where the `targetId` is already globally unambiguous and no translation is needed.

These two cases cover the full RDF use case:
- `sparql-a:organization` and `sparql-b:org` both declare `semanticType: 'https://schema.org/Organization'`
- When `sparql-a` emits an association with `targetType: 'https://schema.org/Organization'` and `stable: true`,
  the engine skips identity translation and passes the URI through; `sparql-b` receives the
  same URI it already knows.
- When the reference is to a relational entity that happens to have a `semanticType` (e.g.,
  a `contacts` channel entity that also declares `semanticType: 'https://schema.org/Person'`),
  the engine can translate entity names across channels while still doing ID translation
  through the identity map.

Option A is rejected: it moves semantic knowledge into user config rather than closer to
the connector that has it. Option D is rejected: it misuses channels as identity namespaces.

---

## 6. Design Detail

### 6.1 `EntityDefinition.semanticType`

```typescript
interface EntityDefinition {
  name: string;
  semanticType?: string;   // globally stable type URI or CURIE
  // ... rest unchanged
}
```

The engine builds a `Map<semanticType, Map<connectorId, entityName>>` at channel
initialisation time (in the constructor, same pass that builds `this.channels`). Updated
when a new connector is added via `addConnector()`.

### 6.2 `Association.targetType` and `Association.stable`

```typescript
interface Association {
  predicate: string;
  targetEntity: string;
  targetId: string;
  targetType?: string;   // optional semantic type URI — used only when targetEntity
                         // name alone is insufficient for cross-channel translation
  stable?: true;         // targetId is globally stable; skip identity translation
  metadata?: Record<string, unknown>;
}
```

When the engine processes `Association` during fan-out:

1. If `stable: true` → pass `targetId` through unchanged; skip identity map lookup;
   translate entity name via `targetType` lookup if `targetType` is present, else use
   `targetEntity` as-is.
2. Else if `targetType` is present:
   a. Try existing channel-membership translation first.
   b. If it fails, look up `semanticType → (toConnectorId → entityName)` in the
      semantic map built at init time.
   c. Proceed with normal identity translation (`dbGetCanonicalId` + `dbGetExternalId`).
3. Else: existing behaviour unchanged.

### 6.3 `_entityKnownInShadow` extension

Current check: entity name must appear in any `ch.members` entry or in `shadow_state`.

New check: also accept any entity name that maps to a `semanticType` in the semantic map,
or any `targetType` URI that is registered in the semantic map.

### 6.4 Wire format compatibility

`targetType` and `stable` are optional and additive. Existing connectors that set neither
are unaffected. The SDK type change is backward-compatible.

---

## 7. Open Questions

- **CURIE support**: should `semanticType` allow CURIEs (`schema:Organization`) with a
  prefix table, or require full URIs? Full URIs are unambiguous at the cost of verbosity.
  Recommendation: full URIs only for now; CURIE prefix support can be layered on.
- **Vocabulary-only entities revisited**: `specs/field-mapping.md §4.3` defines
  vocabulary targets as "seeded once, used only for FK translation". `semanticType` offers
  an alternative model — vocabulary entities could instead be declared once with
  `semanticType` and referenced by any connector without channel membership.
  Follow-on plan needed.
- **Identity sharing across channels**: option B uses `targetType` to *translate entity
  names*, but for non-stable IDs each connector still has its own foreign key. Two
  connectors in different channels would need a shared ingest pass (or a cross-channel
  discovery step) to establish the `identity_map` link before the deferred association
  resolves. This is the same deferred association mechanism that already exists — it just
  needs to tolerate the linked connector being in a different channel.
- **Association predicate URIs**: `predicate` is already a URI in the RDF examples. Should
  the engine use `predicate` as a semantic identifier too, or is `targetType` sufficient?

---

## 8. Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/connector-sdk.md` | `ReadRecord` / `Association` interface | Add `targetType?: string` and `stable?: true` to `Association` |
| `specs/connector-sdk.md` | `EntityDefinition` interface | Add `semanticType?: string` |
| `specs/associations.md` | New `§ 8 Non-Local Entity Resolution` | Document the `targetType` + `semanticType` mechanism and the `stable` passthrough |
| `specs/associations.md` | `§ 7.2 Engine remap steps` | Add branch for `targetType` and `stable` handling |

No spec changes to `specs/config.md` (Option A rejected; no new config constructs needed).

---

## 9. Implementation Steps (when this plan is promoted)

1. Add `semanticType` to `EntityDefinition` (SDK type change — non-breaking)
2. Add `targetType` + `stable` to `Association` (SDK type change — non-breaking)
3. Build semantic map in `SyncEngine` constructor (and update on `addConnector`)
4. Extend `_translateTargetEntity` to fall back to semantic map
5. Extend `_entityKnownInShadow` to accept semantic map matches
6. Add `stable` passthrough branch in `_remapAssociations` / `_remapAssociationsPartial`
7. Write spec sections (§8 of `associations.md`, SDK interface updates)
8. Add tests: cross-channel association remap via `semanticType`; stable URI passthrough;
   unknown `targetType` still surfaces as an error; no regression on existing relational tests
