/**
 * mock-crm connector — POC v5
 *
 * Implements the `Connector` interface against the local MockCrmServer.
 *
 * Entity: contacts
 *   read()    — GET /contacts?since=<iso>
 *   insert()  — POST /contacts
 *   update()  — PUT /contacts/:id
 *
 * Lifecycle:
 *   onEnable()  — POST /webhooks/subscribe, stores subscriptionId in ctx.state
 *   onDisable() — DELETE /webhooks/:subscriptionId
 *
 * Webhook:
 *   handleWebhook() supports two modes via config.webhookMode:
 *     "thick" (default) — full contact in payload, no additional HTTP call
 *     "thin"            — payload contains { id, event }, fetches full contact via ctx.http
 *
 * Auth: Bearer token from ctx.config.apiKey injected automatically by ctx.http.
 */
import type {
  Connector,
  ConnectorContext,
  EntityDefinition,
  WebhookBatch,
} from "@opensync/sdk";

interface ContactPayload {
  id: string;
  name: string;
  email: string;
  updatedAt: string;
  [key: string]: unknown;
}

const mockCrmConnector: Connector = {
  metadata: {
    name: "mock-crm",
    version: "0.1.0",
    auth: { type: "api-key" },
  },

  getEntities(ctx: ConnectorContext): EntityDefinition[] {
    return [
      {
        name: "contacts",

        async *read(ctx: ConnectorContext, since?: string) {
          const base = ctx.config.baseUrl as string;
          const url = since
            ? `${base}/contacts?since=${encodeURIComponent(since)}`
            : `${base}/contacts`;
          const res = await ctx.http(url);
          if (!res.ok) throw new Error(`GET /contacts failed: ${res.status}`);
          const records = await res.json() as ContactPayload[];
          const watermark = new Date().toISOString();
          yield {
            records: records.map((c) => ({
              id: c.id,
              data: { name: c.name, email: c.email, updatedAt: c.updatedAt },
            })),
            since: watermark,
          };
        },

        async *insert(records, ctx: ConnectorContext) {
          const base = ctx.config.baseUrl as string;
          for await (const record of records) {
            const res = await ctx.http(`${base}/contacts`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(record.data),
            });
            if (!res.ok) {
              yield { id: "", error: `POST /contacts failed: ${res.status}` };
              continue;
            }
            const created = await res.json() as ContactPayload;
            yield { id: created.id, data: created };
          }
        },

        async *update(records, ctx: ConnectorContext) {
          const base = ctx.config.baseUrl as string;
          for await (const record of records) {
            const res = await ctx.http(`${base}/contacts/${record.id}`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(record.data),
            });
            if (res.status === 404) {
              yield { id: record.id, notFound: true as const };
              continue;
            }
            if (!res.ok) {
              yield { id: record.id, error: `PUT /contacts/${record.id} failed: ${res.status}` };
              continue;
            }
            const updated = await res.json() as ContactPayload;
            yield { id: record.id, data: updated };
          }
        },
      },
    ];
  },

  async handleWebhook(req: Request, ctx: ConnectorContext): Promise<WebhookBatch[]> {
    const payload = await req.json() as Record<string, unknown>;
    const mode = (ctx.config.webhookMode as string | undefined) ?? "thick";

    if (mode === "thin") {
      // Thin webhook: payload contains { id, event } — fetch full record
      const id = payload.id as string;
      const base = ctx.config.baseUrl as string;
      const res = await ctx.http(`${base}/contacts/${id}`);
      if (!res.ok) return [];
      const contact = await res.json() as ContactPayload;
      return [{ entity: "contacts", records: [{ id: contact.id, data: { name: contact.name, email: contact.email, updatedAt: contact.updatedAt } }] }];
    }

    // Thick webhook: payload is the full contact
    const contact = payload as ContactPayload;
    return [{ entity: "contacts", records: [{ id: contact.id, data: { name: contact.name, email: contact.email, updatedAt: contact.updatedAt } }] }];
  },

  async onEnable(ctx: ConnectorContext) {
    const base = ctx.config.baseUrl as string;
    const res = await ctx.http(`${base}/webhooks/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: ctx.webhookUrl }),
    });
    if (!res.ok) throw new Error(`Webhook subscribe failed: ${res.status}`);
    const { subscriptionId } = await res.json() as { subscriptionId: string };
    await ctx.state.set("webhookSubscriptionId", subscriptionId);
  },

  async onDisable(ctx: ConnectorContext) {
    const id = await ctx.state.get<string>("webhookSubscriptionId");
    if (!id) return;
    const base = ctx.config.baseUrl as string;
    await ctx.http(`${base}/webhooks/${id}`, { method: "DELETE" });
    await ctx.state.delete("webhookSubscriptionId");
  },
};

export default mockCrmConnector;
