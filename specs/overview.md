# OpenSync: Architecture Overview

## What is OpenSync?

An open-source, developer-friendly, hub-and-spoke bi-directional SaaS sync engine. Data flows through a central "shadow state" (SQLite), never directly between systems. Supports N systems connected to one hub.

## Philosophy

- **Connectors are dumb pipes** — they expose raw data + optional field descriptions. No common data model to maintain.
- **The engine is the brain** — diffing, conflict resolution, circuit breakers, undo/rollback all live in the engine.
- **Field-level tracking** — every field has `{ val, prev, ts, src }` metadata in shadow state.
- **Full traceability** — every HTTP call logged (request journal), every mutation logged (transaction log).
- **Safety first** — circuit breakers, echo prevention, and idempotency are in core, not optional.
- **Undo everything** — any sync operation can be rolled back: single record, batch, or full rollback.
- **Developer-friendly** — writing a connector should take minutes. The SDK handles auth, logging, and retries. Developers just map data.
- **Agent-friendly** — clear interfaces, predictable structure, suitable for AI-assisted connector generation.

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript (strict) | Type safety for connector SDK, agent-friendly |
| Runtime | Bun (Node.js compatible) | Instant TS execution, fast installs, fast tests |
| Database | better-sqlite3 + Drizzle ORM | Single file, JSONB support, zero setup |
| Validation | Zod | Runtime validation of connector outputs and config |
| Testing | Vitest | Fast, ESM-native |
| Monorepo | npm workspaces | Simple, supported by both Bun and Node |
| Logging | pino (structured JSON) | Production-grade, low overhead |

### Runtime: Bun-First, Node-Compatible

We develop with **Bun** for speed — native TypeScript execution (no tsx/tsc needed), ~1s dependency installs, and fast test runs. But all code must also run on **Node.js 18+** without modification.

**Rules to stay compatible:**
- Use `better-sqlite3`, not `bun:sqlite`
- Use standard `node:http` or Hono for HTTP servers, not `Bun.serve`
- Use global `fetch()` (available in both since Node 18)
- Use `npm` workspaces (Bun supports these natively)
- No Bun-specific imports (`bun:*` modules)

This means users can choose: `bun install && bun run dev` for speed, or `npm install && npx tsx src/index.ts` if they prefer Node.

## Monorepo Structure

```
/opensync
├── packages/
│   ├── sdk/              # @opensync/sdk — connector interfaces + types
│   └── engine/           # @opensync/engine — core logic, DB, pipeline, CLI
├── connectors/
│   ├── mock-crm/         # Relational: contacts + companies (in-memory)
│   └── mock-erp/         # Flat: customers (in-memory)
├── config/               # Example YAML configs
├── tests/integration/    # End-to-end tests
└── specs/                # This directory
```

## Data Flow

```
Source System
    │
    ▼
[Connector.read()]  ─── raw JSON + field descriptions
    │
    ▼
[Transform]  ─── TypeScript transform functions
    │
    ▼
[Diff Engine]  ─── compare against shadow state, field-level
    │
    ▼
[Conflict Resolver]  ─── field-level master rules + LWW fallback
    │
    ▼
[Dispatcher]  ─── fan-out to all other channel members
    │
    ▼
[Target Connector.upsert()]  ─── push changes, capture generated IDs
    │
    ▼
[Update Shadow State]  ─── store new values + previous values
```

## Key Concepts

### Shadow State
JSONB blobs in SQLite storing field-level metadata per record per system:
```json
{
  "email": { "val": "ola@test.no", "prev": "old@test.no", "ts": 1711993200, "src": "hubspot" },
  "phone": { "val": "99887766", "prev": null, "ts": 1711993500, "src": "fiken" }
}
```

### Identity Map (Hub-and-Spoke)
A global `entities` table with UUIDs. Each entity links to external IDs via `entity_links`:
```
Entity UUID-123:
  - hubspot: hs_contact_99
  - salesforce: sf_contact_55
  - fiken: fiken_customer_44
```

One change in any system propagates to all others through the hub — not point-to-point. This avoids the N^2 problem and circular loops.

### Sync Channels
A channel defines which connector instances sync a given entity type. Members have role configs including field-level master rules.

### Circuit Breakers
Three states: OPERATIONAL → DEGRADED → TRIPPED. Triggered by volume spikes, loop detection (field oscillation), or high error rates. Part of core engine, not optional.

### Connector Capabilities
Connectors declare what they can do: `canDelete`, `canUpdate`, `immutableFields`. The engine uses these for pre-flight warnings and capability-aware rollback.

### External Change Detection
When the engine polls a system and sees changes that don't match its own outbound log or shadow state, it flags them as external changes. This detects "shadow IT" — other integrations or manual edits modifying data outside the engine's control.
