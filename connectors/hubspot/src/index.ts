import type {
  Connector,
  ConnectorContext,
  EntityDefinition,
  FetchBatch,
  FetchRecord,
  InsertRecord,
  InsertResult,
  UpdateRecord,
  UpdateResult,
  DeleteResult,
  OAuthConfig,
} from "@opensync/sdk";
import { ConnectorError, RateLimitError } from "@opensync/sdk";

const BASE = "https://api.hubspot.com";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Collect an async iterable into fixed-size arrays. */
async function* chunk<T>(
  source: AsyncIterable<T>,
  size: number
): AsyncIterable<T[]> {
  let batch: T[] = [];
  for await (const item of source) {
    batch.push(item);
    if (batch.length === size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

/** Throw a typed error based on the HTTP status code. */
function throwForStatus(res: Response, context: string): never {
  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    throw new RateLimitError(
      `HubSpot rate limit hit (${context})`,
      retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined
    );
  }
  throw new ConnectorError(
    `HubSpot API error ${res.status} (${context})`,
    "API_ERROR",
    res.status >= 500
  );
}

/** Paginate through a CRM v3 list endpoint, yielding one page at a time. */
async function* paginate(
  ctx: ConnectorContext,
  path: string,
  since?: string
): AsyncGenerator<{ results: Array<{ id: string; properties: Record<string, unknown>; updatedAt?: string }> }> {
  let after: string | undefined;
  do {
    const params = new URLSearchParams({ limit: "100" });
    if (after) params.set("after", after);
    if (since) params.set("updatedAfter", since);

    const res = await ctx.http(`${BASE}${path}?${params}`);
    if (!res.ok) throwForStatus(res, `GET ${path}`);

    const body = (await res.json()) as {
      results: Array<{ id: string; properties: Record<string, unknown> }>;
      paging?: { next?: { after?: string } };
    };

    yield body;
    after = body.paging?.next?.after;
  } while (after !== undefined);
}

// ─── Entity factory ───────────────────────────────────────────────────────────

/**
 * Build a CRM object entity (company, contact, deal, …) from its object type path.
 * All CRM object types share the same batch API shape.
 */
function makeCrmEntity(opts: {
  name: string;
  path: string; // e.g. '/crm/v3/objects/companies'
  schema: EntityDefinition["schema"];
  scopes: { read: string[]; write: string[] };
  dependsOn?: string[];
  canDelete?: boolean; // some object types (deals) cannot be archived
}): EntityDefinition {
  const { name, path, schema, scopes, dependsOn, canDelete = true } = opts;

  return {
    name,
    schema,
    scopes,
    dependsOn,

    async *fetch(
      ctx: ConnectorContext,
      since?: string
    ): AsyncIterable<FetchBatch> {
      for await (const page of paginate(ctx, path, since)) {
        const maxUpdated = page.results.reduce<string | undefined>(
          (max, r) => {
            const u = r.properties["hs_lastmodifieddate"] as string | undefined;
            return u && (!max || u > max) ? u : max;
          },
          undefined
        );
        yield {
          records: page.results.map((r) => ({
            id: r.id,
            data: r.properties,
          })),
          since: maxUpdated ?? since,
        };
      }
    },

    async lookup(
      ids: string[],
      ctx: ConnectorContext
    ): Promise<FetchRecord[]> {
      const res = await ctx.http(`${BASE}${path}/batch/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: ids.map((id) => ({ id })) }),
      });
      if (!res.ok) throwForStatus(res, `batch/read ${name}`);
      const body = (await res.json()) as {
        results: Array<{ id: string; properties: Record<string, unknown> }>;
      };
      return body.results.map((r) => ({ id: r.id, data: r.properties }));
    },

    async *insert(
      records: AsyncIterable<InsertRecord>,
      ctx: ConnectorContext
    ): AsyncIterable<InsertResult> {
      for await (const batch of chunk(records, 100)) {
        const res = await ctx.http(`${BASE}${path}/batch/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            inputs: batch.map((r) => ({ properties: r.data })),
          }),
        });
        if (!res.ok) throwForStatus(res, `batch/create ${name}`);
        const body = (await res.json()) as {
          results: Array<{ id: string; properties: Record<string, unknown> }>;
        };
        for (const item of body.results) {
          yield { id: item.id, data: item.properties };
        }
      }
    },

    async *update(
      records: AsyncIterable<UpdateRecord>,
      ctx: ConnectorContext
    ): AsyncIterable<UpdateResult> {
      for await (const batch of chunk(records, 100)) {
        const res = await ctx.http(`${BASE}${path}/batch/update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            inputs: batch.map((r) => ({ id: r.id, properties: r.data })),
          }),
        });
        if (!res.ok) throwForStatus(res, `batch/update ${name}`);
        const body = (await res.json()) as {
          results: Array<{ id: string; properties: Record<string, unknown> }>;
        };
        for (const item of body.results) {
          yield { id: item.id, data: item.properties };
        }
      }
    },

    // Only added if canDelete is true
    ...(canDelete
      ? {
          async *delete(
            ids: AsyncIterable<string>,
            ctx: ConnectorContext
          ): AsyncIterable<DeleteResult> {
            for await (const batch of chunk(ids, 100)) {
              const res = await ctx.http(`${BASE}${path}/batch/archive`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  inputs: batch.map((id) => ({ id })),
                }),
              });
              if (!res.ok) throwForStatus(res, `batch/archive ${name}`);
              for (const id of batch) {
                yield { id };
              }
            }
          },
        }
      : {}),
  };
}

// ─── Entities ─────────────────────────────────────────────────────────────────

const companyEntity = makeCrmEntity({
  name: "company",
  path: "/crm/v3/objects/companies",
  schema: {
    name: { description: "Company name", type: "string" },
    domain: { description: "Company website domain", type: "string" },
    industry: { description: "Industry category", type: "string" },
    hs_lastmodifieddate: {
      description: "Last modified timestamp (ISO 8601). Used as the sync watermark.",
      type: "string",
      immutable: true,
    },
  },
  scopes: {
    read: ["crm.objects.companies.read"],
    write: ["crm.objects.companies.write"],
  },
});

const contactEntity = makeCrmEntity({
  name: "contact",
  path: "/crm/v3/objects/contacts",
  schema: {
    firstname: { description: "First name", type: "string" },
    lastname: { description: "Last name", type: "string" },
    email: { description: "Email address", type: "string" },
    phone: { description: "Phone number", type: "string" },
    hs_lastmodifieddate: {
      description: "Last modified timestamp (ISO 8601). Used as the sync watermark.",
      type: "string",
      immutable: true,
    },
  },
  scopes: {
    read: ["crm.objects.contacts.read"],
    write: ["crm.objects.contacts.write"],
  },
  dependsOn: ["company"],
});

const dealEntity = makeCrmEntity({
  name: "deal",
  path: "/crm/v3/objects/deals",
  schema: {
    dealname: { description: "Deal name", type: "string" },
    amount: { description: "Deal value", type: "number" },
    dealstage: { description: "Current pipeline stage identifier", type: "string" },
    closedate: { description: "Expected close date (ISO 8601)", type: "string" },
    hs_lastmodifieddate: {
      description: "Last modified timestamp (ISO 8601). Used as the sync watermark.",
      type: "string",
      immutable: true,
    },
  },
  scopes: {
    read: ["crm.objects.deals.read"],
    write: ["crm.objects.deals.write"],
  },
  dependsOn: ["contact", "company"],
  canDelete: false, // HubSpot does not support archiving deals via the batch API
});

// ─── Webhook handler ──────────────────────────────────────────────────────────

const ENTITY_MAP: Record<string, string> = {
  CONTACT: "contact",
  COMPANY: "company",
  DEAL: "deal",
};

// ─── Connector ────────────────────────────────────────────────────────────────

const connector: Connector = {
  metadata: {
    name: "hubspot",
    version: "0.1.0",
    auth: {
      type: "oauth2",
      // Base scopes always requested. Entity read/write scopes are unioned at channel setup.
      scopes: ["oauth"],
    },
    configSchema: {
      portalId: {
        type: "string",
        description: "HubSpot Portal ID (Account ID), found in Account & Billing settings.",
        required: true,
      },
    },
  },

  getOAuthConfig(_config: Record<string, unknown>): OAuthConfig {
    // HubSpot auth endpoints are fixed regardless of portal or environment.
    return {
      authorizationUrl: "https://app.hubspot.com/oauth/authorize",
      tokenUrl: "https://api.hubspot.com/oauth/v1/token",
    };
  },

  getEntities(): EntityDefinition[] {
    return [companyEntity, contactEntity, dealEntity];
  },

  async handleWebhook(req, ctx) {
    const body = (await req.json()) as Array<{
      objectType: string;
      objectId: string;
      propertyName?: string;
      propertyValue?: unknown;
      changeSource?: string;
    }>;

    // Group individual property-change events into per-object batches.
    const byEntity = new Map<string, Map<string, Record<string, unknown>>>();
    for (const event of body) {
      const entity = ENTITY_MAP[event.objectType.toUpperCase()];
      if (!entity) continue;
      if (!byEntity.has(entity)) byEntity.set(entity, new Map());
      const entityMap = byEntity.get(entity)!;
      const props = entityMap.get(event.objectId) ?? {};
      if (event.propertyName) props[event.propertyName] = event.propertyValue;
      entityMap.set(event.objectId, props);
    }

    return [...byEntity.entries()].map(([entity, objectMap]) => ({
      entity,
      records: [...objectMap.entries()].map(([id, data]) => ({ id, data })),
    }));
  },

  async healthCheck(ctx) {
    const res = await ctx.http(`${BASE}/integrations/v1/me`);
    if (!res.ok) {
      return { healthy: false, message: `API returned ${res.status}` };
    }
    const body = (await res.json()) as { portalId?: number };
    return {
      healthy: true,
      details: { portalId: body.portalId },
    };
  },
};

export default connector;
