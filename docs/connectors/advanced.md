# Advanced Connector Patterns

Once you have a basic connector working, these patterns help with production scenarios.

## Pagination

Use a generator to yield batches incrementally:

```typescript
async *fetch(ctx: SyncContext) {
  let cursor = null;
  
  while (true) {
    const res = await ctx.http(
      `${ctx.config.apiUrl}/contacts?cursor=${cursor}&limit=100`
    );
    const page = await res.json();
    
    if (page.items.length === 0) break;
    
    yield page.items.map(item => ({
      id: item.id,
      data: { name: item.name, email: item.email },
    }));
    
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
}
```

This way you don't load 1 million records into memory. The engine processes batches as they arrive.

## Storing Cursors Between Fetches

If a fetch is interrupted, you can resume from where you left off:

```typescript
async *fetch(ctx: SyncContext, since?: Date) {
  let cursor = await ctx.state.get(`cursor:contact`);
  
  while (true) {
    const res = await ctx.http(
      `${ctx.config.apiUrl}/contacts?cursor=${cursor}`
    );
    const page = await res.json();
    
    if (page.items.length === 0) break;
    yield page.items;
    
    // After each yield, save where we are
    cursor = page.nextCursor;
    await ctx.state.set(`cursor:contact`, cursor);
    
    if (!cursor) break;
  }
}
```

## Error Handling

Throw typed errors. The engine uses them to decide retry strategy:

```typescript
import { RateLimitError, AuthError, ValidationError } from '@opensync/sdk';

async *fetch(ctx: SyncContext) {
  const res = await ctx.http(`${ctx.config.apiUrl}/contacts`);
  
  if (res.status === 429) {
    // Too many requests — retry with backoff
    const retryAfter = res.headers.get('retry-after');
    throw new RateLimitError('Rate limited', {
      retryAfterMs: retryAfter ? parseInt(retryAfter) * 1000 : 60000,
    });
  }
  
  if (res.status === 401 || res.status === 403) {
    // Auth failed — pause and notify user
    throw new AuthError('Invalid credentials');
  }
  
  if (!res.ok) {
    // Unknown error
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  
  const contacts = await res.json();
  yield contacts.map(c => ({
    id: c.id,
    data: { name: c.name },
  }));
}
```

## Webhook Security

Validate webhook signatures to ensure requests come from your API:

```typescript
import crypto from 'crypto';

handleWebhook: async (req: Request, ctx: SyncContext) => {
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
  return [{
    id: event.contact.id,
    data: { name: event.contact.name },
  }];
},
```

## Health Checks

Implement monitoring so OpenSync knows if your API is accessible:

```typescript
healthCheck: async (ctx: SyncContext) => {
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
async *fetch(ctx: SyncContext) {
  const res = await ctx.http(`${ctx.config.apiUrl}/contacts`);
  const contacts = await res.json();
  
  // Only return active contacts
  const active = contacts.filter((c: any) => !c.deletedAt);
  
  yield active.map(c => ({
    id: c.id,
    data: { name: c.name, email: c.email },
  }));
}
```

When you run a full sync, records that were previously synced but aren't in this fetch are marked as deleted in other systems. This handles soft-delete detection without needing explicit deletion support.

## Immutable Fields

Some fields can't be changed after creation (like invoice numbers). Declare them:

```typescript
{
  entity: 'invoice',
  capabilities: {
    canDelete: true,
    canUpdate: true,
    immutableFields: ['invoiceNumber'],  // Can't update after creation
  },
  async *fetch(ctx: SyncContext) {
    // ...
  },
}
```

Now the engine prevents updates to `invoiceNumber` and warns users if they try.

## Custom Auth (prepareRequest)

For APIs that need custom headers, HMAC signing, or session tokens:

```typescript
prepareRequest: async (req: Request, ctx: SyncContext) => {
  // Add custom header
  req.headers.set('X-API-Key', ctx.config.apiKey);
  
  // Or HMAC sign the request
  const body = await req.clone().text();
  const signature = crypto
    .createHmac('sha256', ctx.config.secret)
    .update(body)
    .digest('hex');
  req.headers.set('X-Signature', signature);
  
  return req;
},
```

Called before every request. This is in addition to standard OAuth handling.

## GraphQL APIs

```typescript
async *fetch(ctx: SyncContext) {
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
  yield data.contacts.map((c: any) => ({
    id: c.id,
    data: { name: c.name, email: c.email },
  }));
}
```

Same pattern as REST — `ctx.http` works for any endpoint.

## Semantic/RDF Sources

For graph data, knowledge bases, or semantic web sources:

```typescript
export default {
  metadata: {
    name: 'my-rdf-source',
    graphAware: true,  // Tell engine: we emit semantic data
    // ...
  },
  
  getStreams() {
    return [{
      entity: 'person',
      graphAware: true,
      async *fetch(ctx: SyncContext) {
        const graph = await ctx.http(`${ctx.config.rdfUrl}`);
        const jsonld = await graph.json(); // JSON-LD
        
        yield jsonld['@graph'].map((node: any) => ({
          id: node['@id'],
          data: node,  // Entire JSON-LD node
          associations: (node['knows'] || [])
            .map((ref: any) => ({
              entity: 'person',
              externalId: ref['@id'],
              role: 'knows',
              metadata: {
                // Relationship properties
                since: ref.since,
                strength: ref.trustLevel,
              },
            })),
        }));
      },
    }];
  },
};
```

OpenSync natively handles multi-valued properties and rich relationships.

## Performance: Batch Updates

If your API supports batch operations, use them:

```typescript
async upsert(entity: string, records: NormalizedRecord[], ctx: SyncContext) {
  // Your API might support PATCH /contacts with an array
  const res = await ctx.http(`${ctx.config.apiUrl}/${entity}/batch`, {
    method: 'PATCH',
    body: JSON.stringify(records.map(r => ({
      id: r.id,
      ...r.data,
    }))),
  });
  
  const stored = await res.json();
  return stored.map((item: any) => ({
    externalId: item.id,
    data: item,
    status: 'updated',
  }));
}
```

The engine will batch multiple upserts into single requests when possible.

## Database Connectors

Your connector doesn't have to use HTTP. It can talk to databases:

```typescript
import { Database } from 'sqlite3';

export default {
  metadata: {
    name: 'my-database',
    configSchema: {
      connectionString: {
        type: 'string',
        required: true,
        secret: true,
        description: 'PostgreSQL connection string',
      },
    },
    // ...
  },

  async *fetch(ctx: SyncContext) {
    // Use ctx.state to store the connection
    let db = await ctx.state.get('db') as Database;
    if (!db) {
      db = new Database(ctx.config.connectionString);
      await ctx.state.set('db', db);
    }
    
    const contacts = await db.all('SELECT * FROM contacts');
    yield contacts.map(c => ({
      id: c.id,
      data: { name: c.name, email: c.email },
    }));
  },

  async upsert(entity: string, record: NormalizedRecord, ctx: SyncContext) {
    const db = await ctx.state.get('db') as Database;
    const isUpdate = Boolean(record.id);
    
    if (isUpdate) {
      await db.run(
        `UPDATE ${entity} SET ? WHERE id = ?`,
        [record.data, record.id]
      );
    } else {
      const result = await db.run(
        `INSERT INTO ${entity} (?) VALUES (?)`,
        [Object.keys(record.data), Object.values(record.data)]
      );
      record.id = result.lastID;
    }
    
    return {
      externalId: record.id,
      data: record.data,
      status: isUpdate ? 'updated' : 'created',
    };
  },
} satisfies OpenSyncConnector;
```

Same pattern, different sink.
