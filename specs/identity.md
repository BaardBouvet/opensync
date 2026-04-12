# Identity Map

Hub-and-spoke identity resolution. Every unique real-world entity gets one global UUID. External IDs in each connected system link to that UUID via the `identity_map` table.

## Why Hub-and-Spoke

Point-to-point (A↔B, B↔C, A↔C) creates N² integrations and circular loop risk. Hub-and-spoke means every system talks to the central shadow state, and changes fan out from there.

Adding a new system = adding one spoke. No changes to existing connectors or mappings.

## Data Model

The `identity_map` table is the single source of truth for "which records across systems represent the same real-world entity":

```sql
-- See specs/database.md § identity_map for the full schema
-- (connector_id, entity_name, external_id) → canonical_id (UUID)
```

One row per (connector, entity, external ID). Multiple rows sharing the same `canonical_id` form a **cluster** — records that the engine treats as the same real-world entity.

Example — one person across three systems:

| canonical_id | connector_id | entity_name | external_id |
|---|---|---|---|
| UUID-123 | hubspot-1 | contact | hs_contact_99 |
| UUID-123 | fiken-1 | customer | fiken_customer_44 |
| UUID-123 | mailchimp-1 | member | mc_member_22 |

The engine assigns and manages `canonical_id`. Connectors never see it — they only deal with their own `external_id`.

## Associations

When a connector reports associations (e.g. contact `companyId` referencing a company), the engine resolves the referenced ID through `identity_map` to produce the correct target-local ID before dispatch. See [`specs/associations.md`](associations.md) for the full association model, and [`specs/sync-engine.md § Association Propagation`](sync-engine.md) for the three propagation rules.

If the referenced record hasn't been synced yet, the association is deferred and retried once the target record arrives.

## First-Time Linking

See [`specs/discovery.md`](discovery.md) for how existing records across systems are matched and linked during onboarding.

## Field-Value-Based Matching (`identity`)

Beyond tracking IDs that the engine itself inserts, the engine can match records across connectors using shared field values — for example, recognising that a HubSpot contact and a Fiken customer with the same email address are the same real-world person.

This is configured per channel with the `identity` key, which accepts two forms:

**Shorthand (string list)** — each field is its own OR group:

```yaml
channels:
  - id: contacts
    identity:
      - email
```

**Compound form (object list)** — AND-within-group, OR-across-groups:

```yaml
channels:
  - id: contacts
    identity:
      - fields: [email]
      - fields: [firstName, lastName, dob]
```

A mixed array (some strings, some objects) is a parse-time error. Use one form or the other.

When `identity` is set on a channel, the engine queries `shadow_state` for any existing row in another connector whose stored canonical values for those fields match the incoming record, before allocating a new canonical UUID. If a match is found, the incoming record is linked to the existing entity rather than creating a duplicate.

The search spans all entity names used by the channel's other members, not only the source member's entity name. This ensures that records are correctly linked when channel members use different entity names (e.g. webshop `order_lines` vs. ERP `orderLines` in an array-expansion channel).

`identity` is also the primary mechanism for linking records during initial onboarding (when running `opensync match` and `opensync link`). After onboarding, the engine relies on identity map lookups by external ID and only falls back to field matching if a record arrives that has never been seen before.

**Trade-offs:**
- Fields used for matching must be stable and trustworthy across systems. Email is a good candidate; names and phone numbers are not (formatting differences cause false misses).
- Multi-field identity (`email` + `organizationId`) reduces false positives but means both fields must match — see § Compound Identity Groups below for AND-within-group, OR-across-groups semantics.
- Transitive closure is supported: A matches B via email, B matches C via tax ID → A = B = C. See § Transitive Closure below.

### Transitive Closure

Spec: plans/engine/PLAN_TRANSITIVE_CLOSURE_IDENTITY.md §2.1

Identity fields are matched using a **union-find (connected-components)** algorithm, not a composite key. Each group in `identity` is processed independently. Records that share a value on ANY group are unioned into the same component, even if they share no OTHER field values.

Example — three systems A, B, C with `identity: [email, taxId]`:

| Record | email               | taxId |
|--------|---------------------|-------|
| A/a1   | alice@example.com   | —     |
| B/b1   | alice@example.com   | 123   |
| C/c1   | —                   | 123   |

A and B share `email` → unioned. B and C share `taxId` → unioned. Therefore A = B = C, even though A and C share no field directly. All three get the same canonical UUID.

**Blank values are skipped**: if a field is absent or empty after normalisation (`toLowerCase().trim()`), it does not participate in matching for that group.

**Ambiguity rule**: if two records from the _same_ connector end up in the same component (intra-connector duplicates bridged via an identity field to a record in another connector), the engine cannot determine which record to link. The entire component is placed in `uniquePerSide` with a console warning. This avoids silently creating incorrect links.

### Compound Identity Groups

Spec: plans/engine/PLAN_TRANSITIVE_CLOSURE_IDENTITY.md §2.5

For AND-semantics — requiring ALL fields in a tuple to match — use the object form of `identity`:

```yaml
channels:
  - id: contacts
    # Group 1: email alone (OR-able with group 2)
    # Group 2: all three of firstName + lastName + dob must match together
    identity:
      - fields: [email]
      - fields: [firstName, lastName, dob]
```

A record satisfies a group only when **all** fields in that group are present and non-empty. Groups are OR-ed across: satisfying ANY group links the records. Within each group the AND-semantics prevents false positives from partial field matches.

Internally, the shorthand string form `identity: [email, taxId]` is equivalent to the compound form `identity: [{fields: [email]}, {fields: [taxId]}]` — each string becomes a single-field group.

---

## § Split Operation

`SyncEngine.splitCanonical(canonicalId, connectorId, entityName, externalId)` detaches one
nominated record from a cluster and assigns it a fresh canonical UUID. Unlike `splitCluster()`
(which scatters every member), `splitCanonical()` affects only the nominated record; the
remainder of the cluster stays intact.

### § Split.1 Algorithm

1. Validate that `(connectorId, externalId)` belongs to `canonicalId`. Throw if not found,
   or if it is the **sole** link (nothing to split from).
2. Collect all sibling identity-map rows for `canonicalId` (every row except the one being split).
   Join with `shadow_state` to resolve each sibling's `entity_name`.
3. In a single transaction:
   - Remove the `(canonicalId, connectorId, externalId)` row from `identity_map`.
   - Insert a new `identity_map` row linking the same external record to `newCanonicalId`.
   - `UPDATE shadow_state SET canonical_id = newCanonicalId WHERE connector_id = ? AND external_id = ?`
   - `DELETE FROM written_state WHERE connector_id = ? AND canonical_id = oldCanonicalId`
   - For each sibling, call `dbInsertNoLink` (§ Anti-Affinity.2).
4. Return `{ oldCanonicalId, newCanonicalId, noLinkWritten }`.

**Coexistence with `splitCluster`:** `splitCluster` scatters every member. `splitCanonical`
detaches one. Both methods coexist on `SyncEngine`.

---

## § Anti-Affinity

After `splitCanonical`, the identity-matching logic (`_resolveCanonical`, `onboard`,
`addConnector`) would re-merge the records on the next sync tick if they still share
identity-field values (e.g. the same email address). The `no_link` table prevents this.

### § Anti-Affinity.1 Schema

```sql
CREATE TABLE no_link (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id_a  TEXT NOT NULL,
  entity_name_a   TEXT NOT NULL,
  external_id_a   TEXT NOT NULL,
  connector_id_b  TEXT NOT NULL,
  entity_name_b   TEXT NOT NULL,
  external_id_b   TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (connector_id_a, entity_name_a, external_id_a,
          connector_id_b, entity_name_b, external_id_b)
)
```

Records are identified by the three-part key `(connector_id, entity_name, external_id)`.
The **A-side is always the record that was broken out (the owner)**; the B-side is a sibling
that the owner must never re-merge with. No normalisation is applied — `(A, B)` and `(B, A)`
are distinct rows storing different ownership relationships.

### § Anti-Affinity.2 DB helpers

| Helper | Description |
|---|---|
| `dbInsertNoLink(db, connIdA, entityA, extIdA, connIdB, entityB, extIdB)` | INSERT OR IGNORE — idempotent. A-side is the owner (broken-out record); no normalisation. |
| `dbRemoveNoLink(db, connIdA, entityA, extIdA, connIdB, entityB, extIdB)` | DELETE the row with this exact (A-side owner, B-side sibling) pair (no-op if missing). Caller must pass the owner as A-side. |
| `dbMergeBlockedByNoLink(db, canonicalIdA, canonicalIdB): boolean` | Joins `shadow_state` as `sa` (A-side) and `sb` (B-side); checks both directions (sa in canonA ⛓ sb in canonB, or sa in canonB ⛓ sb in canonA). |
| `dbGetAllNoLinks(db)` | Returns all rows ordered by `id` (used by the playground dev-tools tab). |

### § Anti-Affinity.3 Invariants

- Every `dbMergeCanonicals` call-site in the engine checks `dbMergeBlockedByNoLink` first
  and skips the merge if blocked.
- The badge in the playground is shown only on the **A-side (owner)** record — the one
  that was actively broken out. Partner records (B-side) do not carry a badge.
- Removing an entry via `SyncEngine.removeNoLink(ownerConnId, ownerEntityName, ownerExtId,
  partnerConnId, partnerEntityName, partnerExtId)` re-enables merging. The owner must be
  passed as the A-side.
- Re-merge after removal requires a fresh `discover + onboard` cycle because incremental
  ingest skips unchanged records via echo detection.
