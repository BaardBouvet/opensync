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

When a connector reports associations (e.g. contact belongs_to company), the engine resolves them through the identity map.

### Deferred Associations

If a contact references a company that hasn't been synced yet (no entity_link for it in the target system), the engine defers the association. Once the company is synced and gets a target ID, the engine re-processes pending associations.

### Flat vs Relational Systems

If System A has separate `contact` and `company` objects, and System B has a flat `customer` with all fields in one record:
- The connector for System B just returns one record with all fields
- The mapping config handles splitting/combining: one incoming record can map to fields from multiple entity types
- The identity map links the flat record to both the contact and company global entities if needed

The connector never decides whether to split or combine — that's the engine's job via mapping configuration.

## First-Time Linking (Discovery)

See `discovery.md` for how existing records across systems are matched and linked during onboarding.
