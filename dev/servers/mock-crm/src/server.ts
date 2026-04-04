/**
 * MockCrmServer — standalone mock HTTP server for connector tests.
 *
 * Extracted from poc/v5/mock-crm-server.ts. Adds env-var configuration
 * and a /__reset test-helper endpoint.
 *
 * Endpoints:
 *   GET    /contacts?since=<iso>   — list contacts (filtered by updatedAt when since is given)
 *   POST   /contacts               — create a contact
 *   PUT    /contacts/:id           — update a contact
 *   GET    /contacts/:id           — fetch a single contact
 *   POST   /webhooks/subscribe     — register webhook URL; returns { subscriptionId }
 *   DELETE /webhooks/:id           — deregister webhook
 *   POST   /__trigger              — test helper: fire webhook to all subscribers
 *   POST   /__reset                — test helper: clear all state
 *
 * Auth: All API routes (except /__trigger and /__reset) require
 *   Authorization: Bearer <apiKey>
 *
 * Environment variables (read by main.ts; tests pass values directly):
 *   MOCK_CRM_PORT    — listening port (default: 4001)
 *   MOCK_CRM_API_KEY — bearer token to accept (default: test-api-key-secret)
 */

export const DEFAULT_API_KEY = "test-api-key-secret";

interface Contact {
  id: string;
  name: string;
  email: string;
  updatedAt: string;
  [key: string]: unknown;
}

interface WebhookSubscription {
  id: string;
  url: string;
}

export class MockCrmServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private contacts = new Map<string, Contact>();
  private webhooks = new Map<string, WebhookSubscription>();
  private _port = 0;
  private _apiKey: string;

  constructor(apiKey = DEFAULT_API_KEY) {
    this._apiKey = apiKey;
  }

  get port(): number { return this._port; }
  get baseUrl(): string { return `http://localhost:${this._port}`; }

  start(port = 0): void {
    const self = this;
    this.server = Bun.serve({
      port,
      async fetch(req) {
        return self._handle(req);
      },
    });
    this._port = this.server.port;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
    this._reset();
  }

  /** Seed contacts for test setup without going through the API. */
  seed(contacts: Omit<Contact, "updatedAt">[]): void {
    for (const c of contacts) {
      const contact: Contact = { ...c, updatedAt: new Date().toISOString() };
      this.contacts.set(contact.id, contact);
    }
  }

  private _reset(): void {
    this.contacts.clear();
    this.webhooks.clear();
  }

  private _authenticate(req: Request): boolean {
    const auth = req.headers.get("authorization");
    return auth === `Bearer ${this._apiKey}`;
  }

  private async _handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Test-only helper endpoints — no auth
    if (method === "POST" && path === "/__trigger") {
      return this._handleTrigger(req);
    }
    if (method === "POST" && path === "/__reset") {
      this._reset();
      return json({ ok: true });
    }

    if (!this._authenticate(req)) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (method === "GET" && path === "/contacts") {
      const since = url.searchParams.get("since");
      let contacts = Array.from(this.contacts.values());
      if (since) {
        contacts = contacts.filter((c) => c.updatedAt > since);
      }
      return json(contacts);
    }

    const singleContact = /^\/contacts\/([^/]+)$/.exec(path);

    if (method === "GET" && singleContact) {
      const id = singleContact[1];
      const contact = this.contacts.get(id);
      if (!contact) return json({ error: "Not Found" }, 404);
      return json(contact);
    }

    if (method === "POST" && path === "/contacts") {
      const body = await req.json() as Partial<Contact>;
      const id = crypto.randomUUID();
      const contact: Contact = {
        id,
        name: String(body.name ?? ""),
        email: String(body.email ?? ""),
        ...body,
        updatedAt: new Date().toISOString(),
      };
      this.contacts.set(id, contact);
      await this._fireWebhooks({ event: "created", ...contact });
      return json(contact, 201);
    }

    if (method === "PUT" && singleContact) {
      const id = singleContact[1];
      const existing = this.contacts.get(id);
      if (!existing) return json({ error: "Not Found" }, 404);
      const body = await req.json() as Partial<Contact>;
      const updated: Contact = { ...existing, ...body, id, updatedAt: new Date().toISOString() };
      this.contacts.set(id, updated);
      await this._fireWebhooks({ event: "updated", ...updated });
      return json(updated);
    }

    if (method === "POST" && path === "/webhooks/subscribe") {
      const body = await req.json() as { url: string };
      const subscriptionId = crypto.randomUUID();
      this.webhooks.set(subscriptionId, { id: subscriptionId, url: body.url });
      return json({ subscriptionId }, 201);
    }

    const webhookPath = /^\/webhooks\/([^/]+)$/.exec(path);
    if (method === "DELETE" && webhookPath) {
      const id = webhookPath[1];
      this.webhooks.delete(id);
      return new Response(null, { status: 204 });
    }

    return json({ error: "Not Found" }, 404);
  }

  private async _fireWebhooks(payload: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(payload);
    for (const sub of this.webhooks.values()) {
      try {
        await fetch(sub.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
      } catch {
        // Delivery failures are silent — the consumer is responsible for retry
      }
    }
  }

  private async _handleTrigger(req: Request): Promise<Response> {
    const body = await req.json() as Record<string, unknown>;
    const results: Array<{ url: string; status: number }> = [];

    for (const sub of this.webhooks.values()) {
      try {
        const res = await fetch(sub.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        results.push({ url: sub.url, status: res.status });
      } catch {
        results.push({ url: sub.url, status: -1 });
      }
    }

    return json({ fired: results.length, results });
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
