/**
 * mock-erp connector — unit tests (OAuth2 / default export)
 *
 * Coverage:
 *   read()      — returns all employees on first call
 *   read()      — honours since watermark
 *   lookup()    — returns employee with current ETag as version
 *   insert()    — creates an employee
 *   update()    — succeeds when If-Match matches
 *   update()    — yields per-record error when ETag is stale (412)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  MockErpServer,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
} from "@opensync/server-mock-erp";
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

/** Obtain a fresh OAuth2 token from the server and build a context that injects it. */
async function makeCtxWithToken(server: MockErpServer): Promise<ConnectorContext> {
  const baseUrl = server.baseUrl;
  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: DEFAULT_CLIENT_ID,
      client_secret: DEFAULT_CLIENT_SECRET,
    }).toString(),
  });
  const { access_token } = await tokenRes.json() as { access_token: string };

  return {
    config: { baseUrl },
    state: makeState(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    http(input, init) {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      headers.set("authorization", `Bearer ${access_token}`);
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

describe("mock-erp connector (OAuth2)", () => {
  const server = new MockErpServer();
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
    ctx = await makeCtxWithToken(server);
    entity = connector.getEntities!(ctx)[0];
  });

  // ── read ────────────────────────────────────────────────────────────────────

  describe("read()", () => {
    it("returns all employees on first call", async () => {
      server.seed([
        { id: "e1", name: "Alice", email: "alice@corp.com" },
        { id: "e2", name: "Bob", email: "bob@corp.com" },
      ]);

      const [batch] = await collect(entity.read!(ctx));
      expect(batch.records).toHaveLength(2);
      expect(batch.records.map((r) => r.id).sort()).toEqual(["e1", "e2"]);
    });

    it("honours the since watermark", async () => {
      server.seed([{ id: "old", name: "Old", email: "old@corp.com" }]);
      await Bun.sleep(5); // ensure old employee's updatedAt is strictly before since
      const since = new Date().toISOString();
      await Bun.sleep(5); // ensure new employee's updatedAt is strictly after since
      server.seed([{ id: "new", name: "New", email: "new@corp.com" }]);

      const [batch] = await collect(entity.read!(ctx, since));
      const ids = batch.records.map((r) => r.id);
      expect(ids).toContain("new");
      expect(ids).not.toContain("old");
    });
  });

  // ── lookup ──────────────────────────────────────────────────────────────────

  describe("lookup()", () => {
    it("returns employee with its current ETag as version", async () => {
      server.seed([{ id: "e1", name: "Alice", email: "alice@corp.com" }]);

      const records = await entity.lookup!(["e1"], ctx);
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe("e1");
      expect(records[0].version).toBeTruthy();
      // ETag format: "md5hex"
      expect(records[0].version).toMatch(/^"[0-9a-f]{32}"$/);
    });

    it("skips non-existent IDs silently", async () => {
      const records = await entity.lookup!(["nonexistent"], ctx);
      expect(records).toHaveLength(0);
    });
  });

  // ── insert ──────────────────────────────────────────────────────────────────

  describe("insert()", () => {
    it("creates an employee and returns the assigned ID", async () => {
      const results = await collect(
        entity.insert!(
          from([{ data: { name: "Carol", email: "carol@corp.com" } }]),
          ctx,
        ),
      );
      expect(results).toHaveLength(1);
      expect(results[0].id).toBeTruthy();
      expect(results[0].error).toBeUndefined();
    });
  });

  // ── update ──────────────────────────────────────────────────────────────────

  describe("update()", () => {
    it("succeeds when If-Match matches", async () => {
      server.seed([{ id: "e1", name: "Alice", email: "alice@corp.com" }]);

      const [lookup] = await entity.lookup!(["e1"], ctx);
      const results = await collect(
        entity.update!(
          from([{
            id: "e1",
            data: { name: "Alice Updated", email: "alice@corp.com" },
            version: lookup.version,
            snapshot: lookup.data,
          }]),
          ctx,
        ),
      );
      expect(results).toHaveLength(1);
      expect(results[0].error).toBeUndefined();
    });

    it("returns error on stale ETag (412 Precondition Failed)", async () => {
      server.seed([{ id: "e1", name: "Alice", email: "alice@corp.com" }]);
      const [lookup] = await entity.lookup!(["e1"], ctx);

      // Mutate the employee out-of-band so the ETag advances
      await fetch(`${server.baseUrl}/__mutate-employee/e1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ department: "Engineering" }),
      });

      const results = await collect(
        entity.update!(
          from([{
            id: "e1",
            data: { name: "Alice", email: "alice@corp.com" },
            version: lookup.version, // now stale
            snapshot: lookup.data,
          }]),
          ctx,
        ),
      );
      expect(results).toHaveLength(1);
      expect(results[0].error).toMatch(/412/);
    });
  });
});
