# PLAN: Vocabulary Targets (`vocabulary: true`)

**Status:** proposed  
**Date:** 2026-04-10  
**Effort:** XS  
**Domain:** packages/engine — field mapping  
**Scope:** `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/engine.ts`, `specs/field-mapping.md`, `specs/config.md`  
**Spec:** specs/field-mapping.md §4.3  
**Depends on:** none  
**Defers:** `references_field` (§4.2) — see §0 for rationale  

---

## § 0 First Principles — Is There a Simpler Way?

Before designing new primitives, this section works through the alternatives.

### § 0.1 The natural-key pattern (no new constructs)

For the canonical example — a contact with a `country_code: "NO"` FK — the simplest
solution is to use the natural stable identifier *as* the canonical field value rather
than substituting a UUID:

```yaml
# ConnectorA stores ISO alpha-2
- source: country_code
  target: countryCode         # canonical IS the ISO code — no UUID substitution

# ConnectorB stores ISO alpha-3
- source: country_code
  target: countryCode
  value_map: { "NOR": "NO", "DEU": "DE", "GBR": "GB" }

# ConnectorC stores a localised string
- source: land
  target: countryCode
  value_map: { "Norge": "NO", "Deutschland": "DE" }
```

Both connectors now converge on `"NO"` in canonical state. The vocabulary entity
(`countries` channel) does not need to participate at all — the ISO code itself is the
stable, cross-system identity. `value_map` (already implemented, §1.10) handles
per-connector code translation.

This works today. It requires no new engine primitives.

### § 0.2 When the natural-key pattern is enough

- Reference data with a well-known stable external identifier (ISO 3166 country codes,
  ISO 4217 currency codes, IATA codes, IETF language tags, etc.): use the identifier
  itself as the canonical FK value. The vocabulary entity is a convenient reference
  table but not mechanically necessary for FK resolution.
- Connector uses a different enumeration for the same concept: use `value_map`.
- Connector uses a different representation (e.g. full name `"Norway"` rather than
  `"NO"`): use `value_map` with a full enumeration, or `expression` for programmatic
  normalisation.

### § 0.3 Where the natural-key pattern genuinely breaks down

The only case where the natural-key approach cannot substitute is:

1. The connector exposes only an **opaque system-internal ID** (`country_id: 42`) with no
   stable natural key in the API response.
2. The mapping from `42 → "NO"` is **dynamic** — it comes from a lookup table that is
   itself managed by the engine (synced from an API, changes over time, has thousands of
   entries), not a static `value_map`.
3. The connector cannot resolve the join itself (i.e. it is an HTTP API connector with no
   access to the SDK's shadow DB, not a database connector that can `JOIN countries`).

All three conditions must hold simultaneously. In practice:

- Most APIs already return ISO codes or human-readable string slugs for reference data.
- Database connectors can `SELECT iso_code FROM countries WHERE id = 42` and return the
  natural key alongside the FK.
- For moderately-sized static vocabularies (≤ a few hundred entries), `value_map` with
  the full set declared in YAML is an acceptable static snapshot — especially for
  vocabularies that change rarely or never (country codes do not change).

This leaves a narrow class of genuinely hard cases: a connector with opaque numeric FKs,
a large or frequently-changing vocabulary managed by an external API, and no ability to
resolve the join at the connector layer.

### § 0.4 The association alternative

When a connector has an opaque FK into a dynamic vocabulary entity that is itself synced
through the engine, the cleanest model is often to treat it as an **association** rather
than a field-level translation:

```yaml
# ConnectorA returns record.data.country_id = 42
# Engine knows country_id 42 is in the `countries` channel
associations:
  - source: country_id
    target: country        # predicate
```

The engine's association machinery (deferred resolution, identity map lookup) already
handles the FK-to-canonical-UUID translation through `entity_links`. The connector
writes `{ '@id': target_uuid, '@entity': 'country' }` into the target field on the
outbound pass via the Ref pipeline.

This means `references_field` as originally designed — a cross-entity shadow lookup
that substitutes a UUID into a data field — is largely covered by combining:
- `value_map` for static or small-set translation
- The association machinery for dynamic cross-entity FK resolution

### § 0.5 Revised assessment

| Sub-problem | Existing solution | New construct needed? |
|-------------|------------------|----------------------|
| Two connectors use different codes for the same concept | `value_map` per connector | No |
| Connector uses internal numeric ID for a stable vocabulary | `value_map` with full enumeration | Only if vocabulary is large and dynamic |
| Connector has opaque FK into a synced entity | Association + Ref pipeline | No |
| Channel that should never receive write-back | — | **Yes** — `vocabulary: true` is a clean flag with no alternative |
| Cross-entity shadow lookup during field resolution | `value_map` or connector JOIN | Only in the narrow triple-condition case (§0.3) |

**Conclusion:** `vocabulary: true` (dispatch skip) is independently justified and simple.
`references_field` addresses a genuinely narrow case; implementing it requires design
work and new query infrastructure. The remainder of this plan focuses on `vocabulary:
true` and defers `references_field` pending a concrete use case that cannot be solved
with `value_map` or the association pipeline.

---

## § 1 Problem (Revised Scope)

After the analysis in §0, this plan covers **only `vocabulary: true`**. The
`references_field` cross-entity lookup is deferred.

**`vocabulary: true` — dispatch skip for ingest-only channel members.** Some connectors
contribute data that the engine should read and make available in shadow state but should
never receive write-back dispatches. Examples:

- A reference-data API exposing country/currency/industry codes that the engine ingests
  once or on a schedule but should not attempt to update.
- A read-only reporting source of truth (e.g. a data warehouse) where writes would be
  rejected or nonsensical.
- A connector that provides enrichment data used in `defaultExpression` or for identity
  matching, but is not a sync target.

Today there is no config flag to mark a mapping entry as ingest-only. The only workaround
is to omit outbound field mappings, which suppresses writes by leaving the outbound
payload empty — but this is not a contract; it produces a dispatch attempt that writes
nothing rather than skipping the connector entirely, and it cannot be expressed
self-evidently in config.

**`references_field` — deferred.** The §0 analysis shows that for the dominant class of
vocabulary use cases (ISO codes, currency codes, stable enumerated reference data) the
natural-key pattern works today: make the canonical FK value the stable natural key
itself, use `value_map` per connector for code translation, and no cross-entity shadow
lookup is needed. The genuinely hard case (opaque numeric FK into a large, dynamic
vocabulary) is better addressed by the association pipeline (`predicate` +
`FieldType.ref`). `references_field` is preserved in the spec as a forward reference but
not implemented in this plan.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §4.2 | Add note documenting the natural-key pattern as the preferred alternative; note that `references_field` is deferred — use `value_map` for static code sets, associations for dynamic cross-entity FK resolution |
| `specs/field-mapping.md` | §4.3 | Update status to "implemented"; document `vocabulary` flag behaviour and dispatch-skip semantics |
| `specs/field-mapping.md` | §15 gap table | Mark Vocabulary targets as ✅; `references_field` row annotated with "deferred — natural-key pattern preferred" |
| `specs/config.md` | Mapping entry level keys | Add `vocabulary` entry |

No spec changes for `references_field` in the config key tables — the key is not
being added to the schema.

---

## § 3 Design

### § 3.1 Vocabulary — dispatch skip

`vocabulary: true` on a `MappingEntrySchema` entry carries through to
`ChannelMember.vocabulary`. In `_dispatchToTarget`, add an early return before any
write attempt:

```typescript
// Spec: specs/field-mapping.md §4.3 — vocabulary entities are read-only.
if (targetMember.vocabulary) return { type: "skip" };
```

Vocabulary members still participate in the ingest (forward) pass normally: the
connector's `read()` is called, shadow state is written, identity linking runs, and the
canonical data is available for resolution, `defaultExpression`, and identity matching.
Only write-back dispatch is suppressed.

### § 3.2 Config schema addition

**`packages/engine/src/config/schema.ts`** — in `MappingEntrySchema`:

```typescript
/** Spec: specs/field-mapping.md §4.3 — ingest-only member; no outbound dispatch.
 *  The connector is read on every poll cycle; its records contribute to shadow state
 *  normally. _dispatchToTarget returns { type: "skip" } immediately when this is set. */
vocabulary: z.boolean().optional(),
```

### § 3.3 Compiled type addition

**`packages/engine/src/config/loader.ts`** — in `ChannelMember`:

```typescript
/** Spec: specs/field-mapping.md §4.3 — when true, this member's connector is never
 *  dispatched an update. Ingest proceeds normally; outbound dispatch is suppressed. */
vocabulary?: boolean;
```

Wire through the loader: `MappingEntry.vocabulary` → `ChannelMember.vocabulary` (direct
boolean copy, same pattern as `fullSnapshot`).

### § 3.4 Engine integration

One change in `packages/engine/src/engine.ts`, inside `_dispatchToTarget`, before the
existing written_state / noop checks:

```typescript
// Spec: specs/field-mapping.md §4.3 — vocabulary entities are never write targets.
if (targetMember.vocabulary) return { type: "skip" };
```

No other engine paths change. Fan-out still iterates all channel members — vocabulary
members are included in iteration but exit immediately at this guard.

---

## § 4 Scope Boundaries

**In scope:**
- `vocabulary: true` on flat (root-level) mapping entries.
- Array expansion members: `vocabulary: true` is allowed (dispatch skip propagates
  to child entity writes too). Config validation should reject `vocabulary: true`
  on array expansion members where `array_path` is set, since those are written via
  the collapse path rather than `_dispatchToTarget` — accept this as a follow-on
  clarification if it surfaces.

**Out of scope:**
- `references_field` — deferred (see §0).
- A built-in static-data connector. Any connector type works as a vocabulary source.

---

## § 5 Implementation Steps

1. **Config schema** (`config/schema.ts`) — add `vocabulary: z.boolean().optional()` to
   `MappingEntrySchema`.

2. **Compiled type** (`config/loader.ts`) — add `vocabulary?: boolean` to `ChannelMember`;
   wire through the loader compile path.

3. **Engine guard** (`engine.ts`) — add vocabulary skip in `_dispatchToTarget`.

4. **Tests** (new `vocabulary.test.ts`):

   | ID | Scenario |
   |----|---------|
   | VO1 | Vocabulary member receives no `insert()` or `update()` call |
   | VO2 | Non-vocabulary member in same channel still receives dispatch normally |
   | VO3 | Vocabulary member's data is read (ingested) and visible in shadow state |
   | VO4 | Vocabulary member's canonical data participates in identity matching |
   | VO5 | Vocabulary member with `fullSnapshot: true` still detects deletes (ingest path unchanged) |

5. **Spec updates** (`specs/field-mapping.md §4.3`, `specs/config.md`) as per §2.
