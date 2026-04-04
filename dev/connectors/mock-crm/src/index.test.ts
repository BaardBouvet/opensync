/**
 * mock-crm connector — unit tests
 *
 * Coverage:
 *   read()          — returns all contacts on full sync
 *   read()          — filters by since watermark
 *   insert()        — creates a contact and returns the assigned ID
 *   update()        — modifies an existing contact
 *   onEnable()      — registers a webhook subscription
 *   onDisable()     — removes the webhook subscription
 *   handleWebhook() — thick mode: returns records from payload
 *   handleWebhook() — thin mode: fetches full record via ctx.http
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { MockCrmServer, DEFAULT_API_KEY } from "@opensync/server-mock-crm";
import connector from "./index.js";
import type { ConnectorContext, EntityDefinition, StateStore } from "@opensync/sdk";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeState(): StateStore {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async update<T>(
      key: string,
      fn: (current: T | undefined) => T | Promise<T>,
    ): Promise<T> {
      const current = store.get(key) as T | undefined;
      const next = await fn(current);
      store.set(key, next);
      return next;
    },
  };
}

function makeCtx(
  baseUrl: string,
  state: StateStore,
  extra: Record<string, unknown> = {},
): ConnectorContext {
  return {
    config: { baseUrl, apiKey: DEFAULT_API_KEY, ...extra },
    state,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    http(input, init) {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      headers.set("authorization", `Bearer ${DEFAULT_API_KEY}`);
      return fetch(input as string, { ...init, headers });
    },
    webhookUrl: "",
  };
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of gen) results.push(item);
  return results;
}

async function* from<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("mock-crm connector", () => {
  const server = new MockCrmServer();
  let state: StateStore;
  let ctx: ConnectorContext;
  let entity: EntityDefinition;

  beforeAll(() => {
    server.start(0);
  });

  afterAll(() => {
    server.stop();
  });

  beforeEach(async () => {
    await fetch(`${server.baseUrl}/__reset`, { method: "POST" });
    state = makeState();
    ctx = makeCtx(server.baseUrl, state);
    entity = connector.getEntities!(ctx)[0];
  });

  // ── read ────────────────────────────────────────────────────────────────────

  describe("read()", () => {
    it("returns all contacts when no watermark is given", async () => {
      server.seed([
        { id: "c1", name: "Alice", email: "alice@example.com" },
        { id: "c2", name: "Bob", email: "bob@example.com" },
      ]);

      const [batch] = await collect(entity.read!(ctx));
      expect(batch.records).toHaveLength(2);
      expect(batch.records.map((r) => r.id).sort()).toEqual(["c1", "c2"]);
    });

    it("returns only contacts updated after since watermark", async () => {
      server.seed([{ id: "old", name: "Old", email: "old@example.com" }]);
      await Bun.sleep(5); // ensure old contact's updatedAt is strictly before since
      const since = new Date().toISOString();
      await Bun.sleep(5); // ensure new contact's updatedAt is strictly after since
      server.seed([{ id: "new", name: "New", email: "new@example.com" }]);

      const [batch] = await collect(entity.read!(ctx, since));
      const ids = batch.records.map((r) => r.id);
      expect(ids).toContain("new");
      expect(ids).not.toContain("old");
    });
  });

  // ── insert ──────────────────────────────────────────────────────────────────

  describe("insert()", () => {
    it("creates a contact and returns the assigned ID", async () => {
      const results = await collect(
        entity.insert!(from([{ data: { name: "Carol", email: "carol@example.com" } }]), ctx),
      );
      expect(results).toHaveLength(1);
      expect(results[0].id).toBeTruthy();
      expect(results[0].error).toBeUndefined();

      // Verify the record exists on the server
      const [batch] = await collect(entity.read!(ctx));
      expect(batch.records.find((r) => r.id === results[0].id)).toBeDefined();
    });
  });

  // ── update ──────────────────────────────────────────────────────────────────

  describe("update()", () => {
    it("modifies an existing contact", async () => {
      server.seed([{ id: "u1", name: "Dana", email: "dana@example.com" }]);

      const results = await collect(
        entity.update!(
          from([{ id: "u1", data: { name: "Dana Updated", email: "dana@example.com" } }]),
          ctx,
        ),
      );
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("u1");
      expect(results[0].error).toBeUndefined();

      const [batch] = await collect(entity.read!(ctx));
      const updated = batch.records.find((r) => r.id === "u1");
      expect(updated?.data["name"]).toBe("Dana Updated");
    });

    it("returns notFound for a contact that does not exist", async () => {
      const results = await collect(
        entity.update!(from([{ id: "nonexistent", data: { name: "Nobody" } }]), ctx),
      );
      expect(results[0].notFound).toBe(true);
    });
  });

  // ── onEnable / onDisable ─────────────────────────────────────────────────────

  describe("onEnable() / onDisable()", () => {
    it("onEnable registers a webhook and stores subscriptionId in state", async () => {
      // Start a minimal webhook receiver
      let received: Record<string, unknown> | null = null;
      const webhookServer = Bun.serve({
        port: 0,
        async fetch(req) {
          received = await req.json() as Record<string, unknown>;
          return new Response(null, { status: 200 });
        },
      });

      try {
        const webhookCtx = makeCtx(server.baseUrl, state, {
          webhookUrl: `http://localhost:${webhookServer.port}/hook`,
        });
        Object.assign(webhookCtx, { webhookUrl: `http://localhost:${webhookServer.port}/hook` });

        await connector.onEnable!(webhookCtx);
        const subId = await state.get<string>("webhookSubscriptionId");
        expect(subId).toBeTruthy();

        // Trigger a webhook and verify it reaches the receiver
        await fetch(`${server.baseUrl}/__trigger`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "c1", name: "Triggered" }),
        });

        // Give the async fetch a moment to arrive
        await Bun.sleep(20);
        expect(received).not.toBeNull();
      } finally {
        webhookServer.stop(true);
      }
    });

    it("onDisable removes the webhook subscription", async () => {
      const webhookCtx: ConnectorContext = {
        ...makeCtx(server.baseUrl, state),
        webhookUrl: "http://localhost:9999/irrelevant",
      };
      await connector.onEnable!(webhookCtx);
      const subIdBefore = await state.get<string>("webhookSubscriptionId");
      expect(subIdBefore).toBeTruthy();

      await connector.onDisable!(webhookCtx);
      const subIdAfter = await state.get<string>("webhookSubscriptionId");
      expect(subIdAfter).toBeUndefined();
    });
  });

  // ── automatic webhook delivery ───────────────────────────────────────────────

  describe("automatic webhook delivery", () => {
    it("server fires webhook when a contact is created via insert()", async () => {
      const received: Record<string, unknown>[] = [];
      const webhookReceiver = Bun.serve({
        port: 0,
        async fetch(req) {
          received.push(await req.json() as Record<string, unknown>);
          return new Response(null, { status: 200 });
        },
      });

      try {
        const webhookCtx: ConnectorContext = {
          ...makeCtx(server.baseUrl, state),
          webhookUrl: `http://localhost:${webhookReceiver.port}/hook`,
        };
        await connector.onEnable!(webhookCtx);

        await collect(
          entity.insert!(from([{ data: { name: "Eve", email: "eve@example.com" } }]), webhookCtx),
        );

        await Bun.sleep(20);
        expect(received).toHaveLength(1);
        expect(received[0]["name"]).toBe("Eve");
        expect(received[0]["event"]).toBe("created");
      } finally {
        webhookReceiver.stop(true);
      }
    });

    it("server fires webhook when a contact is updated via update()", async () => {
      server.seed([{ id: "w1", name: "Frank", email: "frank@example.com" }]);

      const received: Record<string, unknown>[] = [];
      const webhookReceiver = Bun.serve({
        port: 0,
        async fetch(req) {
          received.push(await req.json() as Record<string, unknown>);
          return new Response(null, { status: 200 });
        },
      });

      try {
        const webhookCtx: ConnectorContext = {
          ...makeCtx(server.baseUrl, state),
          webhookUrl: `http://localhost:${webhookReceiver.port}/hook`,
        };
        await connector.onEnable!(webhookCtx);

        await collect(
          entity.update!(from([{ id: "w1", data: { name: "Frank Updated", email: "frank@example.com" } }]), webhookCtx),
        );

        await Bun.sleep(20);
        expect(received).toHaveLength(1);
        expect(received[0]["id"]).toBe("w1");
        expect(received[0]["name"]).toBe("Frank Updated");
        expect(received[0]["event"]).toBe("updated");
      } finally {
        webhookReceiver.stop(true);
      }
    });
  });

  // ── handleWebhook ────────────────────────────────────────────────────────────

  describe("handleWebhook()", () => {
    it("thick mode: returns records from the payload without an extra HTTP call", async () => {
      const payload = { id: "c1", name: "Alice", email: "alice@example.com", updatedAt: new Date().toISOString() };
      const req = new Request("http://localhost/webhook", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      });

      const batches = await connector.handleWebhook!(req, ctx);
      expect(batches).toHaveLength(1);
      expect(batches[0].entity).toBe("contacts");
      expect(batches[0].records[0].id).toBe("c1");
      expect(batches[0].records[0].data["name"]).toBe("Alice");
    });

    it("thin mode: fetches the full record via ctx.http", async () => {
      server.seed([{ id: "c2", name: "Bob", email: "bob@example.com" }]);

      const thinCtx = makeCtx(server.baseUrl, state, { webhookMode: "thin" });
      const req = new Request("http://localhost/webhook", {
        method: "POST",
        body: JSON.stringify({ id: "c2", event: "updated" }),
        headers: { "content-type": "application/json" },
      });

      const batches = await connector.handleWebhook!(req, thinCtx);
      expect(batches).toHaveLength(1);
      expect(batches[0].records[0].id).toBe("c2");
      expect(batches[0].records[0].data["name"]).toBe("Bob");
    });
  });
});
