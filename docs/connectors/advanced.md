# Advanced Connector Patterns

Once you have a basic connector working, these patterns help with production scenarios.

## Pagination

Use a generator to yield batches incrementally:

```typescript
async *read(ctx: ConnectorContext, since?: string) {
  let cursor: string | undefined;
  
  while (true) {
    const res = await ctx.http(
      `${ctx.config.apiUrl}/contacts?cursor=${cursor ?? ''}&limit=100`
    );
    const page = await res.json();
    
    if (page.items.length === 0) break;
    
    yield {
      records: page.items.map((item: any) => ({
        id: item.id,
        data: { name: item.name, email: item.email },
      })),
      since: page.nextCursor,
    };
    
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
}
```

This way you don't load 1 million records into memory. The engine processes batches as they arrive.

## Storing Cursors Between Fetches

If a fetch is interrupted, you can resume from where you left off. The engine
passes the last `since` value it received back as the `since` parameter on the
next call — so for most APIs you just return `since` on each batch and the engine
handles persistence automatically. Use `ctx.state` when you need to store
additional state that the `since` field alone can't carry:

```typescript
async *read(ctx: ConnectorContext, since?: string) {
  let cursor = await ctx.state.get<string>('cursor:contact') ?? since;
  
  while (true) {
    const res = await ctx.http(
      `${ctx.config.apiUrl}/contacts?cursor=${cursor ?? ''}`
    );
    const page = await res.json();
    
    if (page.items.length === 0) break;

    cursor = page.nextCursor;
    // Save per-batch so an interruption resumes from the last committed page
    await ctx.state.set('cursor:contact', cursor);

    yield { records: page.items, since: cursor };
    
    if (!cursor) break;
  }
}
```

## Error Handling

Throw typed errors. The engine uses them to decide retry strategy:

```typescript
import { ConnectorError, RateLimitError, AuthError } from '@opensync/sdk';

async *read(ctx: ConnectorContext, since?: string) {
  const res = await ctx.http(`${ctx.config.apiUrl}/contacts`);
  
  if (res.status === 429) {
    // Too many requests — retry with backoff
    const retryAfter = res.headers.get('retry-after');
    throw new RateLimitError(
      'Rate limited',
      retryAfter ? parseInt(retryAfter) * 1000 : undefined,
    );
  }
  
  if (res.status === 401 || res.status === 403) {
    // Auth failed — pause and notify user
    throw new AuthError('Invalid credentials');
  }
  
  if (!res.ok) {
    // Unknown error
    throw new ConnectorError(
      `API error: ${res.status} ${res.statusText}`,
      'API_ERROR',
      res.status >= 500,
    );
  }
  
  const contacts = await res.json();
  yield {
    records: contacts.map((c: any) => ({
      id: c.id,
      data: { name: c.name },
    })),
  };
}
```

## Webhook Security

Validate webhook signatures to ensure requests come from your API:

```typescript
import crypto from 'crypto';

handleWebhook: async (req: Request, ctx: ConnectorContext) => {
  const signature = req.headers.get('x-webhook-signature');
  const secret = ctx.config.webhookSecret as string;
  
  // Most APIs send a signature header like: sha256=<hex>
  // Verify it matches the HMAC of the body
  const body = await req.text();
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  
  if (signature !== `sha256=${expected}`) {
    throw new Error('Invalid webhook signature');
  }
  
  const event = JSON.parse(body);
  // Return records grouped by entity type
  return [{
    entity: 'contact',
    records: [{ id: event.contact.id, data: { name: event.contact.name } }],
  }];
},
```

## Health Checks

Implement monitoring so OpenSync knows if your API is accessible:

```typescript
healthCheck: async (ctx: ConnectorContext) => {
  try {
    const res = await ctx.http(`${ctx.config.apiUrl}/status`);
    if (!res.ok) {
      return {
        healthy: false,
        message: `API returned ${res.status}`,
      };
    }
    const status = await res.json();
    return {
      healthy: true,
      details: {
        apiVersion: status.version,
        rateLimitRemaining: status.rateLimitRemaining,
      },
    };
  } catch (e) {
    return {
      healthy: false,
      message: (e as Error).message,
    };
  }
},
```

Shows up in `opensync status` and triggers alerts if your API goes down.

## Soft Deletes

If your API doesn't physically delete records but marks them deleted:

```typescript
async *read(ctx: ConnectorContext, since?: string) {
  const res = await ctx.http(`${ctx.config.apiUrl}/contacts`);
  const contacts = await res.json();
  
  // Only return active contacts
  const active = contacts.filter((c: any) => !c.deletedAt);
  
  yield {
    records: active.map((c: any) => ({
      id: c.id,
      data: { name: c.name, email: c.email },
    })),
  };
}
```

When you run a full sync, records that were previously synced but aren't in this fetch are marked as deleted in other systems. This handles soft-delete detection without needing explicit deletion support.

## Immutable Fields

Some fields can't be changed after creation (like invoice numbers). Declare them:

```typescript
{
  name: 'invoice',
  schema: {
    invoiceNumber: { immutable: true },  // Can't update after creation
  },
  async *read(ctx: ConnectorContext, since?: string) {
    // ...
  },
}
```

Now the engine prevents updates to `invoiceNumber` and warns users if they try.

## Custom Auth (prepareRequest)

For APIs that need custom headers, HMAC signing, or session tokens:

```typescript
prepareRequest: async (req: Request, ctx: ConnectorContext) => {
  // Add custom header
  const headers = new Headers(req.headers);
  headers.set('X-API-Key', ctx.config.apiKey as string);
  
  // Or HMAC sign the request
  const body = await req.clone().text();
  const signature = crypto
    .createHmac('sha256', ctx.config.secret as string)
    .update(body)
    .digest('hex');
  headers.set('X-Signature', signature);
  
  return new Request(req, { headers });
},
```

Called before every request. This is in addition to standard OAuth handling.

## GraphQL APIs

```typescript
async *read(ctx: ConnectorContext, since?: string) {
  const query = `
    query GetContacts {
      contacts {
        id
        name
        email
      }
    }
  `;
  
  const res = await ctx.http(`${ctx.config.apiUrl}/graphql`, {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
  
  const { data } = await res.json();
  yield {
    records: data.contacts.map((c: any) => ({
      id: c.id,
      data: { name: c.name, email: c.email },
    })),
  };
}
```

Same pattern as REST — `ctx.http` works for any endpoint.

## Semantic/RDF Sources

For graph data, knowledge bases, or semantic web sources:

```typescript
export default {
  metadata: {
    name: 'my-rdf-source',
    auth: { type: 'none' },
    // ...
  },
  
  getEntities(ctx: ConnectorContext) {
    return [{
      name: 'person',
      async *read(ctx: ConnectorContext, since?: string) {
        const res = await ctx.http(`${ctx.config.rdfUrl}`);
        const jsonld = await res.json(); // JSON-LD
        
        yield {
          records: jsonld['@graph'].map((node: any) => ({
            id: node['@id'],
            data: node,  // Entire JSON-LD node
            associations: (node['knows'] || [])
              .map((ref: any) => ({
                predicate: 'knows',
                targetEntity: 'person',
                targetId: ref['@id'],
                metadata: {
                  since: ref.since,
                  strength: ref.trustLevel,
                },
              })),
          })),
        };
      },
    }];
  },
} satisfies Connector;
```

OpenSync natively handles multi-valued properties and rich relationships.

## Performance: Batch Writes

If your API supports batch operations, collect records and send them together:

```typescript
async *insert(records: AsyncIterable<InsertRecord>, ctx: ConnectorContext) {
  // Accumulate up to 100 records and send one batch request
  let batch: InsertRecord[] = [];

  async function* flush() {
    if (batch.length === 0) return;
    const res = await ctx.http(`${ctx.config.apiUrl}/contacts/batch`, {
      method: 'POST',
      body: JSON.stringify({ inputs: batch.map(r => r.data) }),
    });
    const stored = await res.json();
    for (const item of stored) {
      yield { id: item.id, data: item };
    }
    batch = [];
  }

  for await (const record of records) {
    batch.push(record);
    if (batch.length >= 100) yield* flush();
  }
  yield* flush();
}
```

## Database Connectors

Your connector doesn't have to use HTTP. It can talk to databases directly:

```typescript
import { Pool } from 'pg';

export default {
  metadata: {
    name: 'my-database',
    auth: { type: 'none' },
    configSchema: {
      connectionString: {
        type: 'string',
        required: true,
        secret: true,
        description: 'PostgreSQL connection string',
      },
    },
  },

  getEntities(ctx: ConnectorContext) {
    // Create the pool once per connector instance.
    // ctx is the same object across all entity method calls so this is safe.
    const pool = new Pool({ connectionString: ctx.config.connectionString as string });

    return [{
      name: 'row',

      async *read(ctx: ConnectorContext, since?: string) {
        const result = await pool.query('SELECT * FROM my_table ORDER BY id');
        yield { records: result.rows.map(r => ({ id: String(r.id), data: r })) };
      },

      async onDisable(ctx: ConnectorContext) {
        // Return the pool to the OS when the connector is disabled.
        await pool.end();
      },
    }];
  },
} satisfies Connector;
```

Same pattern works for any database driver — SQLite, MySQL, Redis, etc.
