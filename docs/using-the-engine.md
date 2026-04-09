# Embedding the Engine in a JavaScript Application

The `@opensync/engine` package can be imported directly into any Node.js or Bun
application. You construct a `SyncEngine` with a config object and an SQLite
database handle, then drive it with ordinary async calls — no CLI, no config
files required.

## Prerequisites

```bash
npm install @opensync/sdk @opensync/engine better-sqlite3
npm install -D @types/better-sqlite3
```

`better-sqlite3` is the SQLite adapter used under Node.js. Under Bun, `openDb`
uses `bun:sqlite` automatically and `better-sqlite3` is not needed.

## The Connector

This is the connector from [Getting Started](./getting-started.md). Save it as
`my-connector.ts`:

```typescript
import type { Connector, ConnectorContext } from '@opensync/sdk';

export default {
  metadata: {
    name: 'my-system',
    version: '1.0.0',
    auth: { type: 'none' },
    configSchema: {
      apiUrl: { type: 'string', required: true, description: 'API base URL' },
    },
  },

  getEntities(ctx: ConnectorContext) {
    return [
      {
        name: 'contact',

        async *read(ctx: ConnectorContext, since?: string) {
          const res = await ctx.http(`${ctx.config.apiUrl}/contacts`);
          const contacts = await res.json();
          yield {
            records: contacts.map((c: any) => ({
              id: c.id,
              data: { name: c.name, email: c.email },
            })),
          };
        },

        async *insert(records, ctx: ConnectorContext) {
          for await (const record of records) {
            const res = await ctx.http(`${ctx.config.apiUrl}/contact`, {
              method: 'POST',
              body: JSON.stringify(record.data),
            });
            const stored = await res.json();
            yield { id: stored.id, data: stored };
          }
        },

        async *update(records, ctx: ConnectorContext) {
          for await (const record of records) {
            const res = await ctx.http(`${ctx.config.apiUrl}/contact/${record.id}`, {
              method: 'PUT',
              body: JSON.stringify(record.data),
            });
            const stored = await res.json();
            yield { id: record.id, data: stored };
          }
        },
      },
    ];
  },
} satisfies Connector;
```

## Wiring the Engine

```typescript
import { SyncEngine, openDb } from '@opensync/engine';
import type { ResolvedConfig } from '@opensync/engine';
import mySystemConnector from './my-connector.js';
import otherSystemConnector from './other-connector.js';

const config: ResolvedConfig = {
  connectors: [
    {
      id: 'my-system',
      connector: mySystemConnector,
      // Connector-specific config passed to ctx.config inside the connector.
      config: { apiUrl: 'https://api.example.com' },
      // Auth credentials — kept separate from config so they never collide
      // with connector config keys. The engine injects them automatically
      // (Bearer token, API key header, OAuth2 refresh, etc.).
      auth: {},
      // batchIdRef and triggerRef are internal engine bookkeeping. The engine
      // writes a UUID into batchIdRef at the start of each ingest pass so that
      // every ctx.http call made during that pass is tagged with the same batch
      // ID in the request_journal table. triggerRef is set to 'poll',
      // 'webhook', etc. for the same purpose. Always initialise to
      // { current: undefined } — never read or write these yourself.
      batchIdRef: { current: undefined },
      triggerRef: { current: undefined },
    },
    {
      id: 'other-system',
      connector: otherSystemConnector,
      config: { apiUrl: 'https://api.other.com' },
      auth: {},
      batchIdRef: { current: undefined },
      triggerRef: { current: undefined },
    },
  ],
  channels: [
    {
      id: 'contacts',
      members: [
        { connectorId: 'my-system',    entity: 'contact' },
        { connectorId: 'other-system', entity: 'contact' },
      ],
      // Fields used to decide that two records across systems represent the
      // same real-world entity. Matching is exact, case-insensitive.
      identityFields: ['email'],
    },
  ],
  // How to resolve competing field values when two systems disagree.
  // Default (no strategy) = last-write-wins based on timestamps.
  // 'field_master' = a named connector always wins for declared fields.
  // This is the engine-wide default. Per-channel and per-connector overrides
  // are not yet supported — see plans/engine/PLAN_ENGINE_API_ERGONOMICS.md.
  conflict: {},
  // Hard ceiling on how long a connector's read() generator may run.
  // Exceeded → ingest rejects with a timeout error.
  // Engine-wide default; per-connector overrides are not yet supported.
  readTimeoutMs: 30_000,
};

// Pass ':memory:' during development; use a file path in production so
// state persists across restarts.
const db = openDb('sync-state.db');
const engine = new SyncEngine(config, db);
```

## First Run: Onboarding

Before normal polling can start, the engine needs to collect existing records
from each system and find which ones match. This is a one-time step per channel.

```typescript
import type { ChannelConfig } from '@opensync/engine';

async function onboard(channel: ChannelConfig) {
  // 1. Collect phase — read all records into shadow state without writing to
  //    any target yet. Run all members in series; order doesn't matter.
  const collects = [];
  for (const member of channel.members) {
    collects.push(
      await engine.ingest(channel.id, member.connectorId, { collectOnly: true })
    );
  }

  // snapshotAt anchors the watermark: records written *after* this timestamp
  // are picked up on the first incremental poll rather than silently swallowed.
  // Use the earliest timestamp across all members.
  const snapshotAt = collects.reduce(
    (min, c) => Math.min(min, c.snapshotAt ?? Date.now()),
    Date.now(),
  );

  // 2. Discover — compare shadow copies across systems and find matches.
  //    Pure DB read — zero live connector calls.
  const report = await engine.discover(channel.id, snapshotAt);
  console.log(
    `Channel "${channel.id}": ` +
    `${report.matched.length} matched, ` +
    `${report.uniquePerSide.length} unique`
  );

  // 3. Onboard — link matched identities, seed shadows, propagate unmatched
  //    records as new inserts to the other systems.
  const result = await engine.onboard(channel.id, report);
  console.log(
    `  linked: ${result.linked}, ` +
    `propagated: ${result.uniqueQueued}, ` +
    `shadows seeded: ${result.shadowsSeeded}`
  );
}

// Only run onboarding for channels that haven't been set up yet.
for (const ch of config.channels) {
  if (engine.channelStatus(ch.id) === 'uninitialized') {
    await onboard(ch);
  }
}
```

`channelStatus()` returns `'uninitialized'`, `'collected'`, or `'ready'`. A
status of `'ready'` means at least one identity link exists and the channel is
ready for incremental polling.

## Poll Loop

After onboarding, call `ingest()` for each channel member on a regular interval.
Each call reads from one connector and fans out any changes to the other members.
Wrap each member in a try/catch so one failing connector does not block the rest.

```typescript
async function poll() {
  for (const ch of config.channels) {
    for (const member of ch.members) {
      let result;
      try {
        result = await engine.ingest(ch.id, member.connectorId);
      } catch (err) {
        // Connector threw or timed out — the circuit breaker has already
        // recorded the failure. Log and move on to the next member.
        console.error(`[error] ingest ${member.connectorId}:`, err);
        continue;
      }

      for (const r of result.records) {
        switch (r.action) {
          case 'insert':
          case 'update':
            console.log(
              `[${r.action}] ${member.connectorId} → ${r.targetConnectorId} ` +
              `entity=${r.entity} id=${r.targetId}`
            );
            break;
          case 'error':
            console.error(
              `[error] ${member.connectorId} entity=${r.entity} id=${r.sourceId}: ${r.error}`
            );
            break;
        }
      }
    }
  }
}

// Run every 30 seconds.
setInterval(poll, 30_000);
await poll(); // run immediately on startup
```

Each `RecordSyncResult` in `result.records` has:

| Field | Description |
|---|---|
| `action` | `'read'` \| `'insert'` \| `'update'` \| `'skip'` \| `'defer'` \| `'error'` |
| `entity` | Entity name (e.g. `'contact'`) |
| `sourceId` | External ID in the source connector |
| `targetConnectorId` | Connector that received the write |
| `targetId` | External ID in the target connector (after insert/update) |
| `after` | Field values written to the target |
| `before` | Target's previous field values (updates only) |
| `error` | Error message if `action === 'error'` |

## Observing Sync Activity

Pass an `onEvent` callback to the `SyncEngine` constructor. The engine calls it
for every non-skip result: reads, inserts, updates, defers, and errors. This is
how the browser playground and the demo CLI build their event logs — they
register a callback rather than iterating `IngestResult.records` themselves.

```typescript
import type { SyncEvent } from '@opensync/engine';

const engine = new SyncEngine(config, db, {
  onEvent(ev: SyncEvent) {
    // ev.phase      — 'onboard' | 'poll' | 'webhook'
    // ev.action     — 'read' | 'insert' | 'update' | 'defer' | 'error'
    // ev.channel    — which channel fired the event
    // ev.sourceConnector / ev.targetConnector
    // ev.entity     — entity name
    // ev.sourceId / ev.targetId
    // ev.data       — READ: incoming source field values
    // ev.before     — READ: last known values; UPDATE: pre-write target values
    // ev.after      — INSERT/UPDATE: values written to the target

    if (ev.action === 'error') {
      console.error(`[sync error] ${ev.sourceConnector}→${ev.targetConnector} ${ev.entity}:`, ev);
    }

    if (ev.action === 'insert' || ev.action === 'update') {
      console.log(`[${ev.action}] ${ev.sourceConnector}→${ev.targetConnector} ${ev.entity} ${ev.sourceId}`);
    }

    if (ev.action === 'update' && ev.before && ev.after) {
      const changed = Object.keys(ev.after).filter(k => ev.before![k] !== ev.after![k]);
      console.log(`  changed fields: ${changed.join(', ')}`);
    }
  },
});
```

Callers that do not care about events omit the callback entirely.

For longer-term audit, all successful writes are persisted to the `transaction_log`
SQLite table (`batch_id`, `connector_id`, `entity_name`, `external_id`, `canonical_id`,
`action`, `data_before`, `data_after`, `synced_at`). Every outbound HTTP call is in
`request_journal`.

> **Note:** `onEvent` and `SyncEvent` are not yet shipped. They are designed in
> [plans/engine/PLAN_ENGINE_API_ERGONOMICS.md](../plans/engine/PLAN_ENGINE_API_ERGONOMICS.md).
> Until then, iterate `IngestResult.records` directly (see the `RecordSyncResult`
> table in the Poll Loop section above).

## Field Mapping

If the two systems use different field names, declare mappings on the channel
members. The engine translates field names inbound (source → canonical) and
outbound (canonical → target) transparently.

```typescript
channels: [
  {
    id: 'contacts',
    members: [
      {
        connectorId: 'my-system',
        entity: 'contact',
        // no mappings — connector fields are used as-is as canonical names
      },
      {
        connectorId: 'other-system',
        entity: 'contact',
        inbound: [
          { source: 'full_name', target: 'name' },
          { source: 'email_address', target: 'email' },
        ],
        outbound: [
          { source: 'full_name', target: 'name' },
          { source: 'email_address', target: 'email' },
        ],
      },
    ],
    identityFields: ['email'],
  },
],
```

## Auth

If a connector requires credentials, put them in the `auth` key — separate from
`config` so connector config keys and credential names never collide.

```typescript
{
  id: 'my-system',
  connector: mySystemConnector,
  config: { apiUrl: 'https://api.example.com' },
  auth: { apiKey: process.env.MY_SYSTEM_API_KEY ?? '' },
  batchIdRef: { current: undefined },
  triggerRef: { current: undefined },
}
```

Declare the expected auth shape in the connector's `metadata.auth` block. The
engine resolves credentials for the connector context automatically. For OAuth2,
the engine handles token acquisition, refresh, and concurrent-refresh locking;
you only need to supply `clientId` and `clientSecret` in `auth`.

## Cleaning Up

```typescript
process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
```
