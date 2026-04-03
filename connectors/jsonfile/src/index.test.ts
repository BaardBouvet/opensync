import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync, writeFileSync } from "node:fs";
import connector from "./index.js";
import type { ConnectorContext, InsertRecord, UpdateRecord } from "@opensync/sdk";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(filePath: string, extra: Record<string, unknown> = {}): ConnectorContext {
  return {
    config: { filePath, ...extra },
    state: {} as ConnectorContext["state"],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    http: null as unknown as ConnectorContext["http"],
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

// ─── Tests ────────────────────────────────────────────────────────────────────

// Default entity — used as a convenience for tests that don't need custom field names.
// Tests that verify schema or custom fields call connector.getEntities!(ctx) directly.
const defaultCtxStub = { config: {}, state: {} as ConnectorContext["state"], logger: { info() {}, warn() {}, error() {}, debug() {} }, http: null as unknown as ConnectorContext["http"], webhookUrl: "" };
const entity = connector.getEntities!(defaultCtxStub as ConnectorContext)[0];

describe("jsonfile connector", () => {
  let fp: string;
  let ctx: ConnectorContext;

  beforeEach(() => {
    fp = join(tmpdir(), `jsonfile-test-${crypto.randomUUID()}.json`);
    ctx = makeCtx(fp);
  });

  afterEach(() => {
    if (existsSync(fp)) rmSync(fp);
  });
  // ── schema ─────────────────────────────────────────────────────────────────

  describe("schema", () => {
    it("uses default field names by default", () => {
      const e = connector.getEntities!(makeCtx(fp))[0];
      expect(e.schema).toHaveProperty("id");
      expect(e.schema).toHaveProperty("updatedAt");
      expect(e.schema).not.toHaveProperty("uuid");
      expect(e.schema).not.toHaveProperty("modifiedAt");
    });

    it("reflects custom idField and watermarkField in schema", () => {
      const e = connector.getEntities!(makeCtx(fp, { idField: "uuid", watermarkField: "modifiedAt" }))[0];
      expect(e.schema).toHaveProperty("uuid");
      expect(e.schema).toHaveProperty("modifiedAt");
      expect(e.schema).not.toHaveProperty("id");
      expect(e.schema).not.toHaveProperty("updatedAt");
    });

    it("marks the id field as required and immutable", () => {
      const e = connector.getEntities!(makeCtx(fp, { idField: "uuid" }))[0];
      expect(e.schema!["uuid"].required).toBe(true);
      expect(e.schema!["uuid"].immutable).toBe(true);
    });
  });
  // ── fetch ──────────────────────────────────────────────────────────────────

  describe("fetch", () => {
    it("returns empty batch when file does not exist", async () => {
      const [batch] = await collect(entity.fetch!(ctx));
      expect(batch.records).toHaveLength(0);
    });

    it("returns all records on full sync", async () => {
      writeFileSync(fp, JSON.stringify([
        { id: "1", name: "Alice", updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "2", name: "Bob",   updatedAt: "2026-01-02T00:00:00.000Z" },
      ]));

      const [batch] = await collect(entity.fetch!(ctx));
      expect(batch.records.map((r) => r.id)).toEqual(["1", "2"]);
    });

    it("filters records older than since watermark", async () => {
      writeFileSync(fp, JSON.stringify([
        { id: "1", name: "Alice", updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "2", name: "Bob",   updatedAt: "2026-02-01T00:00:00.000Z" },
      ]));

      const [batch] = await collect(entity.fetch!(ctx, "2026-01-15T00:00:00.000Z"));
      expect(batch.records.map((r) => r.id)).toEqual(["2"]);
    });

    it("returns the max updatedAt as the since watermark", async () => {
      writeFileSync(fp, JSON.stringify([
        { id: "1", updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "2", updatedAt: "2026-03-01T00:00:00.000Z" },
      ]));

      const [batch] = await collect(entity.fetch!(ctx));
      expect(batch.since).toBe("2026-03-01T00:00:00.000Z");
    });
  });

  // ── lookup ─────────────────────────────────────────────────────────────────

  describe("lookup", () => {
    it("returns records for requested ids", async () => {
      writeFileSync(fp, JSON.stringify([
        { id: "1", name: "Alice" },
        { id: "2", name: "Bob" },
      ]));

      const results = await entity.lookup!(["1"], ctx);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("1");
      expect(results[0].data["name"]).toBe("Alice");
    });

    it("omits ids that are not found", async () => {
      writeFileSync(fp, JSON.stringify([{ id: "1", name: "Alice" }]));

      const results = await entity.lookup!(["1", "missing"], ctx);
      expect(results.map((r) => r.id)).toEqual(["1"]);
    });
  });

  // ── insert ─────────────────────────────────────────────────────────────────

  describe("insert", () => {
    it("appends a record and returns the assigned id", async () => {
      const [result] = await collect(
        entity.insert!(from([{ data: { id: "abc", name: "Alice" } }] satisfies InsertRecord[]), ctx)
      );

      expect(result.id).toBe("abc");
      expect(result.error).toBeUndefined();

      const [stored] = await entity.lookup!(["abc"], ctx);
      expect(stored.data["name"]).toBe("Alice");
    });

    it("auto-generates an id when not provided in data", async () => {
      const [result] = await collect(
        entity.insert!(from([{ data: { name: "NoId" } }] satisfies InsertRecord[]), ctx)
      );

      expect(typeof result.id).toBe("string");
      expect(result.id.length).toBeGreaterThan(0);
    });

    it("inserts multiple records and persists all of them", async () => {
      await collect(
        entity.insert!(
          from([
            { data: { id: "1", name: "A" } },
            { data: { id: "2", name: "B" } },
          ] satisfies InsertRecord[]),
          ctx
        )
      );

      const [batch] = await collect(entity.fetch!(ctx));
      expect(batch.records).toHaveLength(2);
    });
  });

  // ── update ─────────────────────────────────────────────────────────────────

  describe("update", () => {
    it("updates an existing record", async () => {
      await collect(entity.insert!(from([{ data: { id: "1", name: "Alice" } }] satisfies InsertRecord[]), ctx));

      const [result] = await collect(
        entity.update!(from([{ id: "1", data: { name: "Alicia" } }] satisfies UpdateRecord[]), ctx)
      );

      expect(result.id).toBe("1");
      expect(result.notFound).toBeUndefined();

      const [stored] = await entity.lookup!(["1"], ctx);
      expect(stored.data["name"]).toBe("Alicia");
    });

    it("returns notFound for a record that does not exist", async () => {
      const [result] = await collect(
        entity.update!(from([{ id: "ghost", data: { name: "Nobody" } }] satisfies UpdateRecord[]), ctx)
      );

      expect(result).toEqual({ id: "ghost", notFound: true });
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("removes an existing record", async () => {
      await collect(entity.insert!(from([{ data: { id: "1", name: "Alice" } }] satisfies InsertRecord[]), ctx));

      const [result] = await collect(entity.delete!(from(["1"]), ctx));
      expect(result).toEqual({ id: "1" });

      const [batch] = await collect(entity.fetch!(ctx));
      expect(batch.records).toHaveLength(0);
    });

    it("returns notFound for a record that does not exist", async () => {
      const [result] = await collect(entity.delete!(from(["ghost"]), ctx));
      expect(result).toEqual({ id: "ghost", notFound: true });
    });
  });

  // ── custom field names ─────────────────────────────────────────────────────

  describe("custom idField and watermarkField", () => {
    let customCtx: ConnectorContext;

    beforeEach(() => {
      customCtx = makeCtx(fp, { idField: "uuid", watermarkField: "modifiedAt" });
    });

    it("inserts using the custom id field", async () => {
      const [result] = await collect(
        entity.insert!(from([{ data: { uuid: "abc-123", name: "Alice" } }] satisfies InsertRecord[]), customCtx)
      );
      expect(result.id).toBe("abc-123");

      const stored = await entity.lookup!(["abc-123"], customCtx);
      expect(stored[0].data["name"]).toBe("Alice");
    });

    it("filters fetch by the custom watermark field", async () => {
      writeFileSync(fp, JSON.stringify([
        { uuid: "1", name: "Old",  modifiedAt: "2026-01-01T00:00:00.000Z" },
        { uuid: "2", name: "New",  modifiedAt: "2026-03-01T00:00:00.000Z" },
      ]));

      const [batch] = await collect(entity.fetch!(customCtx, "2026-02-01T00:00:00.000Z"));
      expect(batch.records.map((r) => r.id)).toEqual(["2"]);
      expect(batch.since).toBe("2026-03-01T00:00:00.000Z");
    });

    it("updates using the custom id field", async () => {
      await collect(entity.insert!(from([{ data: { uuid: "1", name: "Alice" } }] satisfies InsertRecord[]), customCtx));

      const [result] = await collect(
        entity.update!(from([{ id: "1", data: { name: "Alicia" } }] satisfies UpdateRecord[]), customCtx)
      );
      expect(result.id).toBe("1");

      const [stored] = await entity.lookup!(["1"], customCtx);
      expect(stored.data["name"]).toBe("Alicia");
    });

    it("deletes using the custom id field", async () => {
      await collect(entity.insert!(from([{ data: { uuid: "1", name: "Alice" } }] satisfies InsertRecord[]), customCtx));

      const [result] = await collect(entity.delete!(from(["1"]), customCtx));
      expect(result).toEqual({ id: "1" });

      const [batch] = await collect(entity.fetch!(customCtx));
      expect(batch.records).toHaveLength(0);
    });
  });
});
