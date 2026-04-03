# Building Your First Connector

After reading [Getting Started](../getting-started.md), you understand **why** connectors matter. This guide shows you **how** to build one.

## Setup

Create a new project:

```bash
mkdir my-system-connector
cd my-system-connector
npm init -y
npm install @opensync/sdk typescript
npx tsc --init
touch index.ts
```

## The Minimum

Here's a working connector again (this time we'll build on it):

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

        async *fetch(ctx: ConnectorContext, since?: string) {
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

## Add a Second Entity

Your first sync works for contacts. Now add companies:

```typescript
getEntities(ctx: ConnectorContext) {
  return [
    {
      name: 'contact',
      async *fetch(ctx: ConnectorContext, since?: string) {
        const res = await ctx.http(`${ctx.config.apiUrl}/contacts`);
        const contacts = await res.json();
        yield {
          records: contacts.map((c: any) => ({
            id: c.id,
            data: { name: c.name, email: c.email },
            associations: [
              {
                predicate: 'worksFor',
                targetEntity: 'company',
                targetId: c.companyId,
              },
            ],
          })),
        };
      },
    },
    {
      name: 'company',
      async *fetch(ctx: ConnectorContext, since?: string) {
        const res = await ctx.http(`${ctx.config.apiUrl}/companies`);
        const companies = await res.json();
        yield companies.map((c: any) => ({
          id: c.id,
          data: { name: c.name, industry: c.industry },
        }));
      },
    },
  ];
}
```

Now declare the dependency:

```typescript
{
  name: 'contact',
  dependsOn: ['company'],  // Sync companies first
  async *fetch(ctx: ConnectorContext, since?: string) {
    // ...
  },
}
```

The engine ensures contacts are synced *after* their companies exist in the target system.

## Add Webhooks

So far you're polling. Real-time is better. Most APIs support webhooks:

```typescript
// Inside your entity definition:
{
  name: 'contact',

  async onEnable(ctx: ConnectorContext) {
    // Register webhook when this entity becomes active in a channel
    const res = await ctx.http(`${ctx.config.apiUrl}/webhooks`, {
      method: 'POST',
      body: JSON.stringify({
        url: ctx.webhookUrl,  // The engine provides this
        events: ['contact.created', 'contact.updated', 'contact.deleted'],
      }),
    });
    const webhook = await res.json();

    // Store the ID so we can deregister later
    await ctx.state.set('webhookId', webhook.id);
  },

  async onDisable(ctx: ConnectorContext) {
    // Clean up when the entity is deactivated
    const webhookId = await ctx.state.get('webhookId');
    await ctx.http(`${ctx.config.apiUrl}/webhooks/${webhookId}`, {
      method: 'DELETE',
    });
  },
}
```

And on the connector itself handle the incoming payload:

```typescript
handleWebhook: async (req: Request, ctx: ConnectorContext) => {
  const event: any = await req.json();

  // Return records grouped by entity
  return [{
    entity: 'contact',
    records: [{
      id: event.contact.id,
      data: {
        name: event.contact.name,
        email: event.contact.email,
      },
    }],
  }];
},
```

Now when a contact changes in your API, the engine syncs it instantly to all connected systems.

## Next: Make It Production-Ready

Add error handling (see [Advanced Patterns](./advanced.md))  
Add health checks for monitoring  
Test with a real target system  
Publish to npm for others to use

---

See [Advanced Patterns](./advanced.md) for pagination, rate limiting, semantic sources, and more.
