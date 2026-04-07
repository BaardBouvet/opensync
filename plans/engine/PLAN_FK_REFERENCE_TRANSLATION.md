# FK Reference Translation Pipeline

**Status:** backlog  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** engine  
**Scope:** `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/engine.ts`, `packages/engine/src/db/queries.ts`, `packages/engine/src/db/migrations.ts`, `specs/field-mapping.md`, `specs/database.md`  
**Spec:** `specs/field-mapping.md §4`  
**Depends on:** nothing — independent of array expansion and filter plans  

---

## § 1 Problem Statement

**1 — No FK translation on the reverse pass**  
When the engine writes a record back to a connector, FK fields (e.g. `accountId`) contain the
raw source-side local ID that was originally ingested. The target connector receives a foreign ID
from a different system's namespace that it does not recognise.

`dbGetExternalId()` already exists and handles this lookup for the association path
(`_remapAssociations`). It needs to be wired into the field-mapping outbound path.

**2 — No FK translation on the forward pass**  
Conflict resolution compares raw source-local IDs across contributing sources. If two sources
both store a FK field pointing at the same referenced entity but using their own local IDs
(e.g. `"crm-123"` vs `"erp-456"`), the values appear different at diff time. The engine cannot
tell they refer to the same referenced entity.

A `references` annotation on a field mapping tells the engine to translate the source-local FK
value to the canonical UUID of the referenced entity on the forward pass, before the value
reaches shadow state and conflict resolution.

**Associations vs FK fields — why associations are not sufficient**  
Associations (`record.associations`) are explicit structural links handled by `_remapAssociations`
via two live `identity_map` lookups per fan-out cycle. FK fields are plain scalars in
`record.data` — the engine has no way to know they are foreign keys without a `references`
annotation. Systems that store cross-entity references as data columns (e.g. a SQL `account_id`
column) need this separate mechanism.

**3 — Cross-connector FK references — the primary motivation**  
The most common real-world case is connectors that are *not aware of each other*. A sales rep
manually enters an ERP account ID into a custom HubSpot property (`erp_account_id`). HubSpot
has no knowledge of ERP; ERP has no knowledge of HubSpot.

The user handles this by giving the FK semantic meaning in the mapping config:

1. Declare the ERP account PK as a named canonical field on the `accounts` entity:

   ```yaml
   # In the accounts channel (erp connector):
   - source: id          # ERP's primary key, e.g. "ACC-001"
     target: erpId       # named canonical field — now queryable by field value
     direction: forward_only   # don't write erpId back to ERP as a data field
   ```

2. Map HubSpot's custom field to the same canonical `accountId` using `references_field`:

   ```yaml
   # In the contacts channel (hubspot connector):
   - source: erp_account_id     # custom HubSpot property, value "ACC-001"
     target: accountId
     references: accounts
     references_field: erpId    # find the accounts entity whose canonical erpId = "ACC-001"
   ```

The forward pass scans `shadow_state` for an `accounts` entity whose `erpId` field equals
`"ACC-001"` and substitutes its canonical UUID. The reverse pass translates back via
`dbGetExternalId`. No special connector-namespace handling is needed in the engine — the user
expresses the relationship by giving the foreign key a canonical name.

A third case — matching by a non-PK attribute (e.g. domain name, ISO code) — uses the same
`references_field` mechanism with a different canonical field as the match key.

**4 — After entity merge: stale canonical UUID causes one-cycle null-dispatch (flip-flop)**  
The forward pass stores a canonical UUID inside `shadow_state.canonical_data` for the
referencing record. When a merge runs, `dbMergeCanonicals(winner, loser)` only updates the
entity's *own* shadow_state rows — not the FK values stored in the JSON blobs of other records
that reference it. The referencing record's `canonical_data` still holds the loser UUID. On the
next reverse pass, `dbGetExternalId("uuid-loser", connector)` returns null (loser UUID no
longer in `identity_map`), so a null FK is dispatched to the target — one cycle of null before
the next forward ingest corrects it.

The `canonical_redirects` table records each merge outcome. The reverse pass calls
`dbResolveCanonicalRedirect` before the `dbGetExternalId` lookup, turning a stale loser UUID
into the winner UUID at virtually no cost.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §4.1 `references` | Update status from "designed, not yet implemented" to "implemented". Update YAML example to show both `references` alone and with `references_field`. |
| `specs/field-mapping.md` | §4.2 `references_field` | Update status from "requires design work" to "implemented". Update prose and examples to reflect the canonical-field model. |
| `specs/database.md` | tables section | Add `canonical_redirects` table definition. |

---

## § 3 Design

### § 3.1 Config changes — `references` on `FieldMapping`

**`config/schema.ts`** — add optional `references` and `references_field` to `FieldMappingEntrySchema`:

```typescript
references:       z.string().optional(),
references_field: z.string().optional(),
```

**`config/loader.ts`** — add to the `FieldMapping` interface:

```typescript
export interface FieldMapping {
  source?:           string;
  target:            string;
  direction?:        "bidirectional" | "forward_only" | "reverse_only";
  expression?:       (record: Record<string, unknown>) => unknown;
  reverseExpression?: (record: Record<string, unknown>) => unknown;
  normalize?:        (v: unknown) => unknown;
  /** Canonical entity type this field references as a foreign key.
   *  Forward pass: translate source local ID → canonical UUID.
   *  Reverse pass: translate canonical UUID → target connector's local ID.
   *  Spec: specs/field-mapping.md §4.1 */
  references?:       string;
  /** Canonical field name on the referenced entity to match the FK value against.
   *  When set, the forward pass scans shadow_state for the referenced entity whose
   *  `references_field` canonical field equals the FK value, instead of using the
   *  identity_map external_id lookup.
   *  Use when the FK value is not the source connector's own external ID —
   *  e.g. a HubSpot custom field storing an ERP account PK declared as canonical `erpId`.
   *  Spec: specs/field-mapping.md §4.2 */
  references_field?: string;
}
```

YAML examples:

```yaml
# Case 1 — same connector's own external ID (identity_map fast path)
fields:
  - source: account_id      # CRM's own account PK
    target: accountId
    references: accounts

# Case 2 — FK value is a named canonical field on the referenced entity (shadow_state scan)
# First, declare the ERP PK as a canonical field on accounts:
- connector: erp
  channel: accounts
  entity: accounts
  fields:
    - source: id
      target: erpId
      direction: forward_only   # expose as canonical field; don't write back to ERP

# Then, reference it from HubSpot:
- connector: hubspot
  channel: contacts
  entity: contacts
  fields:
    - source: erp_account_id    # custom HubSpot property, value e.g. "ACC-001"
      target: accountId
      references: accounts
      references_field: erpId   # find accounts where canonical erpId = "ACC-001"

# Case 3 — match by a non-PK attribute (same mechanism, different canonical field)
    - source: company_domain
      target: companyId
      references: companies
      references_field: domain  # find companies where canonical domain = "acme.com"
```

---

### § 3.2 DB helpers — `queries.ts`

**New helper — `dbFindCanonicalByFieldValue`:**

Used in the `references_field` forward path to find a canonical UUID by matching a named
canonical field value. Distinct from the existing `dbFindCanonicalByField` (which excludes a
specific connector — correct for identity matching, wrong here where we want any match):

```typescript
export function dbFindCanonicalByFieldValue(
  db: DB,
  entityName: string,
  fieldName: string,
  value: unknown,
): string | undefined {
  const raw =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? value
      : JSON.stringify(value);
  return db
    .prepare<{ canonical_id: string }>(
      `SELECT canonical_id FROM shadow_state
       WHERE entity_name = ?
         AND JSON_EXTRACT(canonical_data, '$.' || ? || '.val') = ?
       LIMIT 1`,
    )
    .get(entityName, fieldName, raw)?.canonical_id;
}
```

**Note on ambiguity:** if multiple canonical entities have the same value for `references_field`
(e.g. two companies with the same domain), `LIMIT 1` picks an arbitrary row. This is a data
quality issue, not an engine bug — the field chosen as `references_field` should be unique
across entities of that type. The engine logs a warning when more than one row matches.

**New helper — `dbResolveCanonicalRedirect`:**

Used in the reverse pass to follow a single redirect hop when a stored canonical UUID has been
superseded by a merge:

```typescript
export function dbResolveCanonicalRedirect(
  db: DB,
  canonId: string,
): string {
  const row = db
    .prepare(
      `SELECT winner_id FROM canonical_redirects WHERE loser_id = ? LIMIT 1`,
    )
    .get(canonId) as { winner_id: string } | undefined;
  return row?.winner_id ?? canonId;
}
```

**Modified — `dbMergeCanonicals`:**

After repointing `identity_map`, record a redirect so reverse-pass lookups against stale UUIDs
stored in other records' `canonical_data` can be resolved:

```typescript
// Flatten any existing chain: if a previous merge already redirects to dropId,
// repoint it directly at keepId so all redirects remain one-hop.
db.prepare(
  `UPDATE canonical_redirects SET winner_id = ? WHERE winner_id = ?`,
).run(keepId, dropId);
db.prepare(
  `INSERT OR REPLACE INTO canonical_redirects (loser_id, winner_id) VALUES (?, ?)`,
).run(dropId, keepId);
```

**New table — `migrations.ts`:**

```sql
CREATE TABLE IF NOT EXISTS canonical_redirects (
  loser_id   TEXT NOT NULL,
  winner_id  TEXT NOT NULL,
  merged_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (loser_id)
);
```

The chain-flattening UPDATE before the INSERT keeps all redirects one-hop deep even through
multi-step merges (A→B then B→C: the first UPDATE changes A→B to A→C, then INSERT adds B→C).
This makes `dbResolveCanonicalRedirect` a single unconditional lookup rather than a loop.

---

### § 3.3 Engine — forward pass FK translation

In `engine.ts`, inside `_processRecords`, after the inbound mapping has been applied but before
the record is committed to shadow state, translate FK fields for this channel member:

```typescript
// Spec: specs/field-mapping.md §4.1–§4.2 — forward pass FK translation
for (const fm of channelMember.fieldMappings ?? []) {
  if (!fm.references) continue;
  const target = fm.target ?? fm.source;
  if (!target) continue;
  const localId = inboundRecord[target];
  if (localId == null) continue;

  let canonId: string | undefined;
  if (fm.references_field) {
    // §4.2 path — FK value matches a named canonical field on the referenced entity.
    // The user declared that field on the referenced entity's channel mapping
    // (e.g. ERP's PK exposed as canonical `erpId`, or a domain/ISO-code field).
    // Spec: specs/field-mapping.md §4.2
    canonId = dbFindCanonicalByFieldValue(
      this.db,
      fm.references,        // referenced entity name
      fm.references_field,  // canonical field to match against
      localId,
    );
  } else {
    // §4.1 path — FK value is the source connector's own external ID;
    // look it up directly in identity_map.
    // Spec: specs/field-mapping.md §4.1
    canonId = dbGetCanonicalByExternalId(
      this.db,
      fm.references,
      connectorInstanceId,
      String(localId),
    );
  }

  inboundRecord[target] = canonId ?? null;
  // null when the referenced entity has not been ingested yet;
  // the field will be re-resolved on the next cycle.
}
```

**Ordering note:** FK translation runs after all per-field `expression` transforms. This ensures
any transform that derives the FK value from other fields runs first.

**Merge-safety note on forward pass:** `dbGetCanonicalByExternalId` reads `identity_map`
fresh. The forward pass correctly stores the winner UUID immediately after a merge (because
`identity_map` is live-updated). The stale-UUID problem only affects existing
`canonical_data` blobs that were written in a *previous* cycle before the merge occurred.
Those stale values are handled by `dbResolveCanonicalRedirect` on the reverse pass (§3.4).

---

### § 3.4 Engine — reverse pass FK translation

In `engine.ts`, inside `_dispatchToTarget`, after the outbound mapping has been applied but
before the record is handed to the connector's `update()` / `insert()`, translate FK fields back
to the target connector's local ID namespace:

```typescript
// Spec: specs/field-mapping.md §4.1 — reverse pass FK translation
for (const fm of channelMember.fieldMappings ?? []) {
  if (!fm.references) continue;
  const target = fm.target ?? fm.source;
  if (!target) continue;
  const rawCanonId = outboundRecord[target];
  if (rawCanonId == null) continue;
  // Follow a redirect in case this UUID was merged and its shadow_state value is stale.
  // canonical_redirects is always one-hop due to chain flattening in dbMergeCanonicals.
  const canonId = dbResolveCanonicalRedirect(this.db, String(rawCanonId));
  const localId = dbGetExternalId(this.db, canonId, targetConnectorId);
  outboundRecord[target] = localId ?? null;
  // null when no identity_map entry exists for the target connector
  // (referenced entity not yet synced to this connector).
}
```

`dbGetExternalId` is already used in the association dispatch path — this wires it into
the field-mapping outbound path for the first time. `dbResolveCanonicalRedirect` is the
new one-hop redirect lookup that prevents the flip-flop described in §1.3.

---

## § 4 Edge Cases

| Case | Behaviour |
|------|-----------|
| FK value is null in source | Skipped; null is stored as-is in canonical. |
| Referenced entity not yet ingested (forward pass) | Store null; re-resolved next cycle once the referenced entity is ingested. |
| Referenced entity not yet synced to target (reverse pass) | Write null to target; retried next cycle. |
| Entity merge occurs between cycles | `canonical_redirects` row written by `dbMergeCanonicals`. Reverse pass calls `dbResolveCanonicalRedirect(staleUUID)` → winner UUID → target-local ID. Stable. Next forward cycle stores winner UUID directly; redirect row becomes a passthrough (redirected to itself is never inserted; it simply stays in the table but is no longer exercised). |
| Multi-step merge (A→B then B→C) | Chain-flattening UPDATE in `dbMergeCanonicals` turns A→B into A→C before inserting B→C. All redirect lookups remain one-hop. |
| `references_field` ambiguous match | Two entities have the same value for the referenced field (e.g. duplicate domains). Engine uses `LIMIT 1`, picks an arbitrary canonical entity, and logs a warning. Data quality issue; engine behaviour is defined. |

---

## § 5 Tests

- **FK forward translation — known referenced entity:** source record has `account_id = "crm-456"`; identity_map contains `("crm", "accounts", "crm-456", "uuid-ABC")`; after ingest, canonical shadow has `accountId = "uuid-ABC"`.
- **FK forward translation — unknown referenced entity:** referenced entity not yet in identity_map; `accountId` stored as null; re-resolved on next cycle after the referenced entity is ingested.
- **FK reverse translation:** outbound uses `dbGetExternalId("uuid-ABC", "erp-connector")` → writes ERP-local ID to the dispatched record.
- **FK reverse translation — stale UUID after merge:** before merge, shadow_state has `accountId = "uuid-loser"`; `dbMergeCanonicals("uuid-winner", "uuid-loser")` inserts a redirect row; reverse pass: `dbResolveCanonicalRedirect("uuid-loser")` → `"uuid-winner"` → `dbGetExternalId("uuid-winner", erp)` → correct local ID. No null dispatch.
- **No-op when `references` absent:** records without `references`-annotated fields pass through the translation steps unmodified (regression guard).
- **`references_field` — named canonical field match (cross-connector FK):** ERP accounts channel maps `source: id, target: erpId, direction: forward_only`; HubSpot contacts channel maps `erp_account_id → accountId, references: accounts, references_field: erpId`; forward pass calls `dbFindCanonicalByFieldValue(db, "accounts", "erpId", "ACC-001")` → `uuid-ABC`; canonical shadow stores `accountId = "uuid-ABC"`; reverse pass to ERP writes `"ACC-001"`, reverse pass to HubSpot writes HubSpot's own account ID.
- **`references_field` — non-PK attribute match:** contacts channel maps `company_domain → companyId, references: companies, references_field: domain`; `dbFindCanonicalByFieldValue(db, "companies", "domain", "acme.com")` → `uuid-XYZ`.
- **Two sources, same referenced entity, both using `references`:** ERP and CRM both store their own local `account_id`; both resolve to same `uuid-ABC` via identity_map; conflict resolution sees one canonical UUID from both sources rather than two different strings.

---

## § 6 Out of Scope

### Vocabulary targets

A canonical entity used purely as a lookup table, seeded once and never synced bidirectionally.
The `references` + `references_field` mechanism covers the FK resolution side. The
`vocabulary: true` flag (suppress reverse dispatch) is a separate config concept.
See `specs/field-mapping.md §4.3`, marked "requires design work".

### Enriched cross-entity expressions

Computed fields that aggregate across entity types — a separate post-resolution enrichment
pass unrelated to FK translation. See `specs/field-mapping.md` status note at line 1068.
