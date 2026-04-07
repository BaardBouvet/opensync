# FK Reference Translation Pipeline

**Status:** backlog  
**Date:** 2026-04-07  
**Effort:** S  
**Domain:** engine  
**Scope:** `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/engine.ts`, `packages/engine/src/db/queries.ts`, `specs/field-mapping.md`  
**Spec:** `specs/field-mapping.md §4`  
**Depends on:** nothing — independent of array expansion and filter plans  

---

## § 1 Problem Statement

Two related gaps exist in the FK handling pipeline. The spec (`specs/field-mapping.md §4.1`)
calls this cluster "designed, not yet implemented":

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

**Reference preservation after merge — already solved**  
`dbMergeCanonicals` updates every `identity_map` row for the losing canonical to point to the
winner. Both the association path and the FK translation path read `identity_map` at runtime, so
they automatically resolve to the winner UUID after a merge. No additional infrastructure (e.g. a
redirect table) is required — this matches how `_remapAssociations` already handles merge
preservation.

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/field-mapping.md` | §4.1 `references` | Update status from "designed, not yet implemented" to "implemented". YAML snippet already matches the intended design; no structural changes needed. |
| `specs/field-mapping.md` | §4.2 `references_field` | Keep status as "requires design work". Not covered by this plan — deferred. |
| `specs/field-mapping.md` | §4.3 Vocabulary targets | Keep status as "requires design work". Not covered by this plan — deferred. |

---

## § 3 Design

### § 3.1 Config changes — `references` on `FieldMapping`

**`config/schema.ts`** — add optional `references` to `FieldMappingEntrySchema`:

```typescript
references: z.string().optional(),
```

**`config/loader.ts`** — add to the `FieldMapping` interface:

```typescript
export interface FieldMapping {
  source?:            string;
  target:             string;
  direction?:         "bidirectional" | "forward_only" | "reverse_only";
  expression?:        (record: Record<string, unknown>) => unknown;
  reverseExpression?: (record: Record<string, unknown>) => unknown;
  normalize?:         (v: unknown) => unknown;
  /** Canonical entity type this field references as a foreign key.
   *  Forward pass: translate source local ID → canonical UUID.
   *  Reverse pass: translate canonical UUID → target connector's local ID.
   *  Spec: specs/field-mapping.md §4.1 */
  references?:        string;
}
```

YAML config example (file-based API):

```yaml
fields:
  - source: account_id
    target: accountId
    references: accounts
```

Embedded TypeScript config example:

```typescript
{ source: "account_id", target: "accountId", references: "accounts" }
```

---

### § 3.2 DB helpers — `queries.ts`

**New helper — `dbGetCanonicalByExternalId`:**

Used in the forward pass to translate a source-local FK value to a canonical UUID.

```typescript
export function dbGetCanonicalByExternalId(
  db: DB,
  entityName: string,
  connectorId: string,
  externalId: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT canonical_id FROM identity_map
       WHERE entity_name = ? AND connector_id = ? AND external_id = ?
       LIMIT 1`,
    )
    .get(entityName, connectorId, externalId) as
    | { canonical_id: string }
    | undefined;
  return row?.canonical_id;
}
```

No schema changes are needed. `identity_map` already has the required columns. `dbMergeCanonicals`
already keeps `identity_map` consistent after merges — no redirect table is required.

---

### § 3.3 Engine — forward pass FK translation

In `engine.ts`, inside `_processRecords`, after the inbound mapping has been applied but before
the record is committed to shadow state, translate FK fields for this channel member:

```typescript
// Spec: specs/field-mapping.md §4.1 — forward pass FK translation
for (const fm of channelMember.fieldMappings ?? []) {
  if (!fm.references) continue;
  const target = fm.target ?? fm.source;
  if (!target) continue;
  const localId = inboundRecord[target];
  if (localId == null) continue;
  const canonId = dbGetCanonicalByExternalId(
    this.db,
    fm.references,         // referenced entity name
    connectorInstanceId,   // connector that produced this record
    String(localId),
  );
  inboundRecord[target] = canonId ?? null;
  // null when the referenced entity has not been ingested yet;
  // the field will be re-resolved on the next cycle (same deferred
  // pattern as associations — specs/identity.md §Deferred Associations).
}
```

**Ordering note:** FK translation runs after all per-field `expression` transforms. This ensures
any transform that derives the FK value from other fields runs first.

**Merge safety:** `dbGetCanonicalByExternalId` reads `identity_map` at runtime. After
`dbMergeCanonicals` runs, the winner canonical ID is what `identity_map` returns — no stale
values can accumulate. This is identical to how `_remapAssociations` is merge-safe without a
redirect table.

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
  const canonId = outboundRecord[target];
  if (canonId == null) continue;
  const localId = dbGetExternalId(this.db, String(canonId), targetConnectorId);
  outboundRecord[target] = localId ?? null;
  // null when no identity_map entry exists for the target connector
  // (referenced entity not yet synced to this connector).
}
```

`dbGetExternalId` is already used in the association dispatch path — this wires it into
the field-mapping outbound path for the first time.

**Merge safety:** `dbMergeCanonicals` rewrites all `identity_map` rows for the losing canonical
to the winner. shadow_state canonical_data stores the canonical UUID (written on the forward
pass). After a merge the forward pass will write the winner UUID on the next ingest cycle;
`dbGetExternalId` will return the correct target-local ID for the winner. No special handling
is needed.

---

## § 4 Edge Cases

| Case | Behaviour |
|------|-----------|
| FK value is null in source | Skipped; null is stored as-is in canonical. |
| Referenced entity not yet ingested (forward pass) | Store null; re-resolved next cycle once the referenced entity is ingested. |
| Referenced entity not yet synced to target (reverse pass) | Write null to target; retried next cycle. |
| Entity merge occurs between cycles | Forward pass on next cycle writes winner UUID via `dbGetCanonicalByExternalId`. Reverse pass immediately reads winner UUID out of shadow_state canonical_data and translates it. No special handling required. |
| `references_field` (ISO code translation) | Not covered; deferred. Spec status stays "requires design work". |

---

## § 5 Tests

- **FK forward translation — known referenced entity:** source record has `account_id = "crm-456"`; identity_map contains `("crm", "accounts", "crm-456", "uuid-ABC")`; after ingest, canonical shadow has `accountId = "uuid-ABC"`.
- **FK forward translation — unknown referenced entity:** referenced entity not yet in identity_map; `accountId` stored as null; re-resolved on next cycle after the referenced entity is ingested.
- **FK reverse translation:** outbound uses `dbGetExternalId("uuid-ABC", "erp-connector")` → writes ERP-local ID to the dispatched record.
- **FK reverse translation — merge-safe:** merge canonical "uuid-X" into "uuid-Y" (via `dbMergeCanonicals`); next forward cycle stores `accountId = "uuid-Y"` in shadow_state; `dbGetExternalId("uuid-Y", "erp")` returns the correct ERP-local ID.
- **No-op when `references` absent:** records without `references`-annotated fields pass through the translation steps unmodified (regression guard).
- **Two sources, same referenced entity:** source A stores `account_id = "A-10"`, source B stores `account_id = "B-20"`; both resolve to `uuid-ABC` after forward translation; conflict resolution correctly picks one winning UUID (rather than treating two distinct strings as a conflict between different entities).

---

## § 6 Out of Scope

- `references_field` (alternative representation translation, e.g. ISO code ↔ UUID) — `specs/field-mapping.md §4.2`, marked "requires design work".
- Vocabulary targets — `specs/field-mapping.md §4.3`, marked "requires design work".
- Enriched cross-entity expressions (computed fields that aggregate across entity types) — `specs/field-mapping.md status note §1068`, a separate post-resolution enrichment pass not related to FK translation.
