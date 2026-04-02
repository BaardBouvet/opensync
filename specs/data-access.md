# Data Access Layer

The sync engine isn't just a pipe between systems — it's a unified, clean, always-current data layer. This makes it the ideal backend for AI agents and analytics.

## The Problem for Agents Today

When an agent needs customer data, it typically has to:

1. Authenticate with HubSpot → fetch contact
2. Authenticate with Fiken → fetch customer
3. Authenticate with Tripletex → fetch invoice data
4. Reconcile conflicting values across the three responses
5. Figure out which system has the most recent data

This is slow, expensive (API calls + token count), and error-prone (which `phone` is correct when all three disagree?).

## Shadow State as Ground Truth

The engine's shadow state already solves all of this:

- **Unified**: One query returns all known data about an entity, from all connected systems
- **Clean**: Data has been normalized through transforms (phone formats, name concatenation, etc.)
- **Deduplicated**: The identity map has already resolved that HubSpot contact #99 = Fiken customer #44
- **Current**: Shadow state is updated on every sync cycle and webhook
- **Auditable**: Every value has metadata — when it was set, by which system, what it replaced

An agent can query the SQLite database directly:

```sql
-- Get all data about a person, across all systems
SELECT el.connector_instance_id, ss.field_data
FROM shadow_state ss
JOIN entity_links el ON el.id = ss.entity_link_id
WHERE el.entity_id = 'uuid-123';
```

One query, milliseconds, no API calls, no token overhead.

## Queryable State

Because everything is in SQLite with JSONB, agents and scripts can ask sophisticated questions:

```sql
-- Find all contacts where email changed in the last 24 hours
SELECT el.external_id, 
       json_extract(ss.field_data, '$.email.val') as current_email,
       json_extract(ss.field_data, '$.email.prev') as previous_email,
       json_extract(ss.field_data, '$.email.src') as changed_by
FROM shadow_state ss
JOIN entity_links el ON el.id = ss.entity_link_id
WHERE json_extract(ss.field_data, '$.email.ts') > unixepoch() - 86400;

-- Find contacts that exist in HubSpot but not in Fiken
SELECT e.id, el.external_id
FROM entities e
JOIN entity_links el ON el.entity_id = e.id AND el.connector_instance_id = 'hubspot-1'
WHERE e.id NOT IN (
  SELECT entity_id FROM entity_links WHERE connector_instance_id = 'fiken-1'
);

-- Count records per system per entity type
SELECT ci.display_name, e.entity_type, COUNT(*)
FROM entity_links el
JOIN entities e ON e.id = el.entity_id
JOIN connector_instances ci ON ci.id = el.connector_instance_id
GROUP BY ci.display_name, e.entity_type;
```

## Agent Access Patterns

### Direct SQLite Query

The simplest approach. Agents that run locally (Claude Code, Cursor, etc.) can read the SQLite file directly. The database is the API.

### Read-Only Query Endpoint (Future)

A lightweight HTTP endpoint that accepts SQL queries or structured filters and returns JSON. This would let remote agents query the engine without direct file access:

```
GET /api/entities?type=contact&field=email&changed_since=2026-04-01
```

Not in scope for the initial engine, but the data model supports it trivially.

### Event Stream for Real-Time

The engine's event bus (see `actions.md`) emits events on every change. An agent could subscribe to these events to maintain its own view of the data — a vector database for RAG, a search index, or a local cache.

```typescript
eventBus.on('record.updated', async (event) => {
  await vectorDb.upsert(event.entityId, event.data);
});
```

## Why This Matters

Traditional integration tools (Zapier, Make) are fire-and-forget — data passes through but isn't retained. You can't ask Zapier "what's the current state of customer X across all my systems?"

OpenSync retains state by design (shadow state + transaction log). This turns a sync engine into a **data platform**:

- **For agents**: Query one place instead of N APIs. Cheaper, faster, more reliable.
- **For analytics**: The shadow state is a pre-built data warehouse of operational data, updated in real-time.
- **For debugging**: "Why does this customer have the wrong address?" → query the transaction log, find exactly when, where, and why it changed.
- **For RAG/vector search**: Feed clean, normalized, deduplicated data into embedding pipelines.

## Data Freshness

Shadow state is only as fresh as the last sync cycle. For polling-based connectors, this means data could be up to `poll_interval` seconds stale. For webhook-based connectors, it's near-real-time.

The `stream_state.last_fetched_at` column tells you exactly how fresh each entity type is per system. Agents should check this before relying on the data for time-sensitive decisions.

## Privacy Considerations

The shadow state contains a full copy of synced data. This is a feature (unified access) and a responsibility (data governance).

- GDPR right-to-erasure: deleting an entity should cascade through entity_links, shadow_state, and transaction_log
- Data retention policies: configurable per channel (e.g. purge transaction_log entries older than 90 days)
- Access control: in a single-user dev engine this is the user's responsibility; the data lives in a local SQLite file
