import type {
  Association,
  Connector,
  ConnectorContext,
  EntityDefinition,
  ReadBatch,
  ReadRecord,
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

    async *read(
      ctx: ConnectorContext,
      since?: string
    ): AsyncIterable<ReadBatch> {
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
    ): Promise<ReadRecord[]> {
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

// ─── Contact entity (custom — needs association support) ─────────────────────

/**
 * HubSpot-defined association type IDs for the contact→company direction.
 * Spec: plans/playground/PLAN_HUBSPOT_TRIPLETEX_ASSOC_DEMO.md § 4.1
 */
const COMPANY_TYPE_ID_TO_PREDICATE: Record<number, string> = {
  1:   "primaryCompanyId",  // Contact to primary company
  279: "companyId",         // Contact to company (unlabeled default)
};

const PREDICATE_TO_COMPANY_TYPE_ID: Record<string, number> = {
  primaryCompanyId: 1,
  companyId:        279,
};

/**
 * Fetch company associations for a batch of contact IDs via the v4 Associations API.
 * Each edge may carry multiple associationTypes; each known typeId becomes a separate
 * Association entry with a distinct predicate (predicate-as-type pattern).
 */
async function fetchContactCompanyAssocs(
  contactIds: string[],
  ctx: ConnectorContext
): Promise<Map<string, Association[]>> {
  if (contactIds.length === 0) return new Map();

  const res = await ctx.http(
    `${BASE}/crm/associations/2026-03/contacts/companies/batch/read`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: contactIds.map((id) => ({ id })) }),
    }
  );
  if (!res.ok) throwForStatus(res, "batch/read contact→company associations");

  const body = (await res.json()) as {
    results: Array<{
      from: { id: string };
      to: Array<{
        toObjectId: number;
        associationTypes: Array<{
          category: string;
          typeId: number;
          label: string | null;
        }>;
      }>;
    }>;
  };

  const map = new Map<string, Association[]>();
  for (const result of body.results) {
    const assocs: Association[] = [];
    const seen = new Set<string>();
    for (const toEntry of result.to) {
      for (const assocType of toEntry.associationTypes) {
        const predicate = COMPANY_TYPE_ID_TO_PREDICATE[assocType.typeId];
        if (!predicate) continue;
        const key = `${predicate}:${toEntry.toObjectId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        assocs.push({
          predicate,
          targetEntity: "company",
          targetId: String(toEntry.toObjectId),
        });
      }
    }
    if (assocs.length > 0) map.set(result.from.id, assocs);
  }
  return map;
}

/**
 * Write contact→company associations. Only predicates in PREDICATE_TO_COMPANY_TYPE_ID
 * are forwarded; others are silently skipped.
 * Spec: specs/connector-sdk.md § Write Records
 */
async function writeContactCompanyAssocs(
  pairs: Array<{ contactId: string; associations: Association[] }>,
  ctx: ConnectorContext
): Promise<void> {
  type AssocInput = {
    from: { id: string };
    to: { id: string };
    types: Array<{ associationCategory: string; associationTypeId: number }>;
  };

  const allInputs: AssocInput[] = [];
  for (const { contactId, associations } of pairs) {
    for (const assoc of associations) {
      const typeId = PREDICATE_TO_COMPANY_TYPE_ID[assoc.predicate];
      if (typeId === undefined) continue;
      allInputs.push({
        from: { id: contactId },
        to:   { id: assoc.targetId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }],
      });
    }
  }
  if (allInputs.length === 0) return;

  const BATCH_SIZE = 100;
  for (let i = 0; i < allInputs.length; i += BATCH_SIZE) {
    const batch = allInputs.slice(i, i + BATCH_SIZE);
    const res = await ctx.http(
      `${BASE}/crm/associations/2026-03/contacts/companies/batch/create`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: batch }),
      }
    );
    if (!res.ok) throwForStatus(res, "batch/create contact→company associations");
  }
}

const _contactEntityBase = makeCrmEntity({
  name: "contact",
  path: "/crm/v3/objects/contacts",
  schema: {
    firstname: { description: "First name", type: "string" },
    lastname:  { description: "Last name",  type: "string" },
    email:     { description: "Email address", type: "string" },
    phone:     { description: "Phone number",  type: "string" },
    hs_lastmodifieddate: {
      description: "Last modified timestamp (ISO 8601). Used as the sync watermark.",
      type: "string",
      immutable: true,
    },
  },
  scopes: {
    read:  ["crm.objects.contacts.read"],
    write: ["crm.objects.contacts.write"],
  },
  dependsOn: ["company"],
});

/** Contact entity with full company association support (read + write). */
const contactEntity: EntityDefinition = {
  ..._contactEntityBase,

  async *read(
    ctx: ConnectorContext,
    since?: string
  ): AsyncIterable<ReadBatch> {
    for await (const page of paginate(ctx, "/crm/v3/objects/contacts", since)) {
      const ids = page.results.map((r) => r.id);
      const assocMap = await fetchContactCompanyAssocs(ids, ctx);

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
          associations: assocMap.get(r.id),
        })),
        since: maxUpdated ?? since,
      };
    }
  },

  async *insert(
    records: AsyncIterable<InsertRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<InsertResult> {
    for await (const batch of chunk(records, 100)) {
      const res = await ctx.http(`${BASE}/crm/v3/objects/contacts/batch/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: batch.map((r) => ({ properties: r.data })),
        }),
      });
      if (!res.ok) throwForStatus(res, "batch/create contact");

      const body = (await res.json()) as {
        results: Array<{ id: string; properties: Record<string, unknown> }>;
      };

      // Write associations using positional correlation (spec: results in same order as inputs).
      const assocPairs: Array<{ contactId: string; associations: Association[] }> = [];
      for (let i = 0; i < batch.length; i++) {
        const assocs = batch[i].associations;
        const resultId = body.results[i]?.id;
        if (assocs && assocs.length > 0 && resultId) {
          assocPairs.push({ contactId: resultId, associations: assocs });
        }
      }
      if (assocPairs.length > 0) await writeContactCompanyAssocs(assocPairs, ctx);

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
      const res = await ctx.http(`${BASE}/crm/v3/objects/contacts/batch/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: batch.map((r) => ({ id: r.id, properties: r.data })),
        }),
      });
      if (!res.ok) throwForStatus(res, "batch/update contact");

      const body = (await res.json()) as {
        results: Array<{ id: string; properties: Record<string, unknown> }>;
      };

      // Write associations — id is already known on update, no matching needed.
      const assocPairs: Array<{ contactId: string; associations: Association[] }> = [];
      for (const r of batch) {
        if (r.associations && r.associations.length > 0) {
          assocPairs.push({ contactId: r.id, associations: r.associations });
        }
      }
      if (assocPairs.length > 0) await writeContactCompanyAssocs(assocPairs, ctx);

      for (const item of body.results) {
        yield { id: item.id, data: item.properties };
      }
    }
  },
};

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
    allowedHosts: ["api.hubspot.com", "*.hubapi.com"],
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
