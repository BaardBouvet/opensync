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
import { OpenSyncConnector, NormalizedRecord, SyncContext } from '@opensync/sdk';

export default {
  metadata: {
    name: 'my-system',
    version: '1.0.0',
    capabilities: { canDelete: true, canUpdate: true },
    configSchema: {
      apiUrl: { type: 'string', required: true, description: 'API base URL' },
    },
  },

  getStreams() {
    return [
      {
        entity: 'contact',
        async *fetch(ctx: SyncContext) {
          const res = await ctx.http(`${ctx.config.apiUrl}/contacts`);
          const contacts = await res.json();
          yield contacts.map((c: any) => ({
            id: c.id,
            data: { name: c.name, email: c.email },
          }));
        },
      },
    ];
  },

  async upsert(entity: string, record: NormalizedRecord, ctx: SyncContext) {
    const isUpdate = Boolean(record.id);
    const url = isUpdate
      ? `${ctx.config.apiUrl}/${entity}/${record.id}`
      : `${ctx.config.apiUrl}/${entity}`;

    const res = await ctx.http(url, {
      method: isUpdate ? 'PUT' : 'POST',
      body: JSON.stringify(record.data),
    });

    const stored = await res.json();
    return {
      externalId: stored.id,
      data: stored,
      status: isUpdate ? 'updated' : 'created',
    };
  },
} satisfies OpenSyncConnector;
```

## Add a Second Entity

Your first sync works for contacts. Now add companies:

```typescript
getStreams() {
  return [
    {
      entity: 'contact',
      async *fetch(ctx: SyncContext) {
        const res = await ctx.http(`${ctx.config.apiUrl}/contacts`);
        const contacts = await res.json();
        yield contacts.map((c: any) => ({
          id: c.id,
          data: { name: c.name, email: c.email },
          associations: [
            {
              entity: 'company',
              externalId: c.companyId,
              role: 'works_for',
            },
          ],
        }));
      },
    },
    {
      entity: 'company',
      async *fetch(ctx: SyncContext) {
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
  entity: 'contact',
  dependsOn: ['company'],  // Sync companies first
  async *fetch(ctx: SyncContext) {
    // ...
  },
}
```

The engine ensures contacts are synced *after* their companies exist in the target system.

## Add Webhooks

So far you're polling. Real-time is better. Most APIs support webhooks:

```typescript
lifecycle: {
  async onEnable(ctx: SyncContext) {
    // Register webhook when the connector is enabled
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

  async onDisable(ctx: SyncContext) {
    // Clean up when the connector is removed
    const webhookId = await ctx.state.get('webhookId');
    await ctx.http(`${ctx.config.apiUrl}/webhooks/${webhookId}`, {
      method: 'DELETE',
    });
  },
},

handleWebhook: async (req: Request, ctx: SyncContext) => {
  const event: any = await req.json();
  
  // Transform webhook payload into NormalizedRecord
  return [{
    id: event.contact.id,
    data: {
      name: event.contact.name,
      email: event.contact.email,
    },
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
