# Getting Started: Build a Connector

## Why Build Here?

A connector is a thin adapter: read records from a system, write records to a system. The engine handles everything else.

- **One connector, any system.** Once built, your connector works with any other connector on the network. No point-to-point integration code.
- **Engine handles the hard part.** Diffing, conflict resolution, undo, audit logs, retry logic, field mapping — none of that is in the connector.
- **Webhooks.** Declare `handleWebhook()` and the engine routes inbound events automatically.
- **Circuit breakers and safety.** If your API goes down the engine pauses gracefully, backs off, and notifies the user.
- **Field-level master assignment.** Different systems can own different fields. The engine resolves conflicts at the field level, not the record level.
- **Full undo.** Any sync can be rolled back — a single field, a batch, or an entire sync cycle.

## The 15-Minute Version

Here's everything required to build a working connector:

```typescript
import type { Connector, ConnectorContext } from '@opensync/sdk';

export default {
  metadata: {
    name: 'my-system',
    version: '1.0.0',
    auth: { type: 'none' },
    configSchema: {
      apiUrl: { type: 'string', required: true, description: 'Your API base URL' },
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

That's a real connector. It reads/writes data, integrates with the engine, and can sync to any other system.

## What This Gives You

Out of the box:

✅ **Authentication** — no manual token handling  
✅ **Logging** — every request, response, error is journaled  
✅ **Retry logic** — transient failures auto-retry with backoff  
✅ **Pagination support** — use generators, yield as you go  
✅ **Webhook support** — declare `handleWebhook()` and it works  
✅ **State management** — persistent KV store for pagination cursors, webhook IDs, etc.  
✅ **Error recovery** — circuit breakers, graceful degradation  
✅ **Undo/rollback** — all syncs are reversible  
✅ **Multi-system orchestration** — connected to any other system instantly  

You don't implement any of this. It's all in the engine.

## Your First Sync

```bash
# 1. Create a project
mkdir my-system-connector
cd my-system-connector
npm init -y
npm install @opensync/sdk

# 2. Create index.ts with the connector code above

# 3. Test it
npm link
cd /where/opensync/is/installed
npm link ../my-system-connector

# 4. Add the connector
opensync add-connector my-system --config apiUrl=https://api.mysys.com

# 5. Connect it to another system
opensync create-channel contact \
  --members my-system salesforce-prod

# 6. Go
opensync sync
```

Your data flows. Instantly. No scripts, no glue code, no ongoing maintenance.

## The Real Wins

**Use case 1: Your API changes**  
You update the field mapping in your connector. Run. Done. No re-syncing required — the engine re-processes existing shadow state with your new logic.

**Use case 2: A user wants to sync to a system you don't support**  
They build a connector for it. Plug into the same channel. Now your system and theirs sync automatically.

**Use case 3: Something went wrong**  
`opensync rollback --transaction-id xyz`. All writes to all systems are reversed. Users get their data back. No disaster.

**Use case 4: Scale to 10 systems**  
Add them one at a time. Each connector is independent. No N² point-to-point integrations. Each new system just joins the channel.

## The Journey

**Day 1**: Write connector (1 hour)  
**Day 2**: Add webhooks for real-time sync (30 min)  
**Day 3**: Add more entities and relationships (30 min)  
**Day 4**: User syncs it to 3 other systems (0 min on your part)

Compare that to:

- Building Zapier-like integrations? Months.
- Custom sync scripts? Years of maintenance.
- Point-to-point bridges? Exponential complexity.

With OpenSync, you offload the infrastructure. You expose your API's schema. The engine handles field mapping, conflict resolution, and all distributed systems concerns.

## Next Steps

1. **[Building Your First Connector](./connectors/guide.md)** — detailed walkthrough with examples
2. **[Connector Reference](./connectors/reference.md)** — full API documentation
3. **[Advanced Patterns](./connectors/advanced.md)** — webhooks, error handling, semantic sources, idempotency

---

Start with a new npm project and `npm install @opensync/sdk`.
