# Identity Map

Hub-and-spoke identity resolution. Every unique real-world entity gets one global UUID. External IDs in each connected system link to it.

## Why Hub-and-Spoke

Point-to-point (A↔B, B↔C, A↔C) creates N^2 integrations and circular loop risk. Hub-and-spoke means every system talks to the central shadow state, and changes fan out from there.

Adding a new system = adding one spoke. No changes to existing connectors.

## Data Model

### entities (the hub)

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Global identity |
| entity_type | text | e.g. 'contact', 'company' |
| created_at | datetime | |
| updated_at | datetime | |

### entity_links (the spokes)

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Link ID |
| entity_id | FK → entities | Global identity |
| connector_instance_id | FK → connector_instances | Which system |
| external_id | text | ID in that system (e.g. 'hs_contact_99') |
| created_at | datetime | |

Example for one person across three systems:

| entity_id | connector_instance_id | external_id |
|-----------|----------------------|-------------|
| UUID-123 | hubspot-1 | hs_contact_99 |
| UUID-123 | fiken-1 | fiken_customer_44 |
| UUID-123 | mailchimp-1 | mc_member_22 |

## API

```typescript
class IdentityMap {
  // Find or create a global entity, link an external ID to it
  linkExternalId(entityType: string, connectorInstanceId: string, externalId: string): Promise<{ entityId: string; isNew: boolean }>;

  // Given an external ID in one system, find all linked external IDs in other systems
  resolveLinks(entityType: string, connectorInstanceId: string, externalId: string): Promise<EntityLink[]>;

  // Get global entity ID for a specific external ID
  getEntityId(connectorInstanceId: string, externalId: string): Promise<string | undefined>;

  // Get external ID for a global entity in a specific system
  getExternalId(entityId: string, connectorInstanceId: string): Promise<string | undefined>;
}
```

## Associations Between Objects

When a connector reports associations (e.g. contact belongs_to company), the engine resolves them through the identity map. See [sync-engine.md — Association Propagation Rules](sync-engine.md) for the four rules that govern how association changes are handled (empty-array removal, null targetId tombstones, unknown entity errors, and predicate deduplication).

### Deferred Associations

If a contact references a company that hasn't been synced yet (no entity_link for it in the target system), the engine defers the association. Once the company is synced and gets a target ID, the engine re-processes pending associations.

### Flat vs Relational Systems

If System A has separate `contact` and `company` objects, and System B has a flat `customer` with all fields in one record:
- The connector for System B just returns one record with all fields
- The mapping config handles splitting/combining: one incoming record can map to fields from multiple entity types
- The identity map links the flat record to both the contact and company global entities if needed

The connector never decides whether to split or combine — that's the engine's job via mapping configuration.

## First-Time Linking (Discovery)

See [discovery.md](discovery.md) for how existing records across systems are matched and linked during onboarding.

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
