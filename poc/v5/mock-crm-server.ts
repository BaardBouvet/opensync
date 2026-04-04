/**
 * Mock CRM API server for POC v5 tests.
 *
 * Runs in-process via Bun.serve. Start/stop via MockCrmServer.start() / .stop().
 *
 * Endpoints:
 *   GET    /contacts?since=<iso>     — list contacts (optionally filtered by updatedAt)
 *   POST   /contacts                 — create a contact
 *   PUT    /contacts/:id             — update a contact
 *   GET    /contacts/:id             — get a single contact (used by thin-webhook pattern)
 *   POST   /webhooks/subscribe       — register a webhook URL, returns { subscriptionId }
 *   DELETE /webhooks/:id             — deregister a webhook
 *   POST   /__trigger                — test helper: fire a webhook to all registered URLs
 *
 * Auth: All API routes (except /__trigger) require `Authorization: Bearer <MOCK_API_KEY>`.
 *
 * All state is in-memory — the server is ephemeral and restarted per test suite.
 */

export const MOCK_API_KEY = "test-api-key-secret";

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
    this.contacts.clear();
    this.webhooks.clear();
  }

  /** Seed contacts for test setup without going through the API. */
  seed(contacts: Omit<Contact, "updatedAt">[]): void {
    for (const c of contacts) {
      const contact: Contact = { ...c, updatedAt: new Date().toISOString() };
      this.contacts.set(contact.id, contact);
    }
  }

  private _authenticate(req: Request): boolean {
    const auth = req.headers.get("authorization");
    return auth === `Bearer ${MOCK_API_KEY}`;
  }

  private async _handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Test-only trigger endpoint — no auth
    if (method === "POST" && path === "/__trigger") {
      return this._handleTrigger(req);
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
      return json(contact, 201);
    }

    if (method === "PUT" && singleContact) {
      const id = singleContact[1];
      const existing = this.contacts.get(id);
      if (!existing) return json({ error: "Not Found" }, 404);
      const body = await req.json() as Partial<Contact>;
      const updated: Contact = { ...existing, ...body, id, updatedAt: new Date().toISOString() };
      this.contacts.set(id, updated);
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

  private async _handleTrigger(req: Request): Promise<Response> {
    const body = await req.json() as Record<string, unknown>;
    const payload = JSON.stringify(body);
    const results: Array<{ url: string; status: number }> = [];

    for (const sub of this.webhooks.values()) {
      try {
        const res = await fetch(sub.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        });
        results.push({ url: sub.url, status: res.status });
      } catch (err) {
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
