import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import connector from "./index.js";
import type { ConnectorContext, EntityDefinition, InsertRecord, UpdateRecord } from "@opensync/sdk";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(filePaths: string[], extra: Record<string, unknown> = {}): ConnectorContext {
  return {
    config: { filePaths, ...extra },
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

describe("jsonfiles connector", () => {
  let fp: string;
  let ctx: ConnectorContext;
  let entity: EntityDefinition;

  beforeEach(() => {
    fp = join(tmpdir(), `jsonfiles-test-${crypto.randomUUID()}.json`);
    ctx = makeCtx([fp]);
    entity = connector.getEntities!(ctx)[0];
  });

  afterEach(() => {
    if (existsSync(fp)) rmSync(fp);
  });
  // ── schema ─────────────────────────────────────────────────────────────────

  describe("schema", () => {
    it("uses default field names by default", () => {
      expect(entity.schema).toHaveProperty("id");
      expect(entity.schema).toHaveProperty("data");
      expect(entity.schema).toHaveProperty("updated");
      expect(entity.schema).not.toHaveProperty("_id");
    });

    it("reflects custom idField and watermarkField in schema", () => {
      const e = connector.getEntities!(makeCtx([fp], { idField: "uuid", watermarkField: "modifiedAt" }))[0];
      expect(e.schema).toHaveProperty("uuid");
      expect(e.schema).toHaveProperty("modifiedAt");
      expect(e.schema).not.toHaveProperty("id");
      expect(e.schema).not.toHaveProperty("updated");
    });

    it("marks the id field as required and immutable", () => {
      expect(entity.schema!["id"].required).toBe(true);
      expect(entity.schema!["id"].immutable).toBe(true);
    });

    it("includes associationsField in schema when configured", () => {
      const e = connector.getEntities!(makeCtx([fp], { associationsField: "links" }))[0];
      expect(e.schema).toHaveProperty("links");
    });

    it("includes default associations field in schema when not configured", () => {
      expect(Object.keys(entity.schema!)).toEqual(["id", "data", "updated", "associations"]);
    });
  });
  // ── fetch ──────────────────────────────────────────────────────────────────

  describe("read", () => {
    it("returns empty batch when file does not exist", async () => {
      const [batch] = await collect(entity.read!(ctx));
      expect(batch.records).toHaveLength(0);
    });

    it("returns all records on full sync", async () => {
      writeFileSync(fp, JSON.stringify([
        { id: "1", data: { name: "Alice" }, updated: "2026-01-01T00:00:00.000Z" },
        { id: "2", data: { name: "Bob" },   updated: "2026-01-02T00:00:00.000Z" },
      ]));

      const [batch] = await collect(entity.read!(ctx));
      expect(batch.records.map((r) => r.id)).toEqual(["1", "2"]);
    });

    it("filters records older than since watermark", async () => {
      writeFileSync(fp, JSON.stringify([
        { id: "1", data: { name: "Alice" }, updated: "2026-01-01T00:00:00.000Z" },
        { id: "2", data: { name: "Bob" },   updated: "2026-02-01T00:00:00.000Z" },
      ]));

      const [batch] = await collect(entity.read!(ctx, "2026-01-15T00:00:00.000Z"));
      expect(batch.records.map((r) => r.id)).toEqual(["2"]);
    });

    it("returns the max updatedAt as the since watermark", async () => {
      writeFileSync(fp, JSON.stringify([
        { id: "1", data: {}, updated: "2026-01-01T00:00:00.000Z" },
        { id: "2", data: {}, updated: "2026-03-01T00:00:00.000Z" },
      ]));

      const [batch] = await collect(entity.read!(ctx));
      expect(batch.since).toBe("2026-03-01T00:00:00.000Z");
    });

    it("always includes records without an updatedAt field", async () => {
      writeFileSync(fp, JSON.stringify([
        { id: "1", data: { name: "NoWatermark" } },
        { id: "2", data: { name: "HasWatermark" }, updated: "2026-01-01T00:00:00.000Z" },
      ]));

      // "2" is older than the since value but "1" has no watermark — should always appear
      const [batch] = await collect(entity.read!(ctx, "2026-06-01T00:00:00.000Z"));
      expect(batch.records.map((r) => r.id)).toContain("1");
      expect(batch.records.map((r) => r.id)).not.toContain("2");
    });

    it("accepts integer sequence watermarks", async () => {
      writeFileSync(fp, JSON.stringify([
        { id: "1", data: { name: "Alice" }, updated: 1 },
        { id: "2", data: { name: "Bob" },   updated: 3 },
      ]));

      const [batch] = await collect(entity.read!(ctx, "2")); // since = "2"
      expect(batch.records.map((r) => r.id)).toEqual(["2"]);
      expect(batch.since).toBe("3");
    });
  });

  // ── lookup ─────────────────────────────────────────────────────────────────

  describe("lookup", () => {
    it("returns records for requested ids", async () => {
      writeFileSync(fp, JSON.stringify([
        { id: "1", data: { name: "Alice" } },
        { id: "2", data: { name: "Bob" } },
      ]));

      const results = await entity.lookup!(["1"], ctx);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("1");
      expect(results[0].data["name"]).toBe("Alice");
    });

    it("omits ids that are not found", async () => {
      writeFileSync(fp, JSON.stringify([{ id: "1", data: { name: "Alice" } }]));

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

      const [batch] = await collect(entity.read!(ctx));
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

      const [batch] = await collect(entity.read!(ctx));
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
    let customEntity: EntityDefinition;

    beforeEach(() => {
      customCtx = makeCtx([fp], { idField: "uuid", watermarkField: "modifiedAt" });
      customEntity = connector.getEntities!(customCtx)[0];
    });

    it("inserts using the custom id field", async () => {
      const [result] = await collect(
        customEntity.insert!(from([{ data: { uuid: "abc-123", name: "Alice" } }] satisfies InsertRecord[]))
      );
      expect(result.id).toBe("abc-123");

      const stored = await customEntity.lookup!(["abc-123"]);
      expect(stored[0].data["name"]).toBe("Alice");
    });

    it("filters fetch by the custom watermark field", async () => {
      writeFileSync(fp, JSON.stringify([
        { uuid: "1", data: { name: "Old" },  modifiedAt: "2026-01-01T00:00:00.000Z" },
        { uuid: "2", data: { name: "New" },  modifiedAt: "2026-03-01T00:00:00.000Z" },
      ]));

      const [batch] = await collect(customEntity.read!(customCtx, "2026-02-01T00:00:00.000Z"));
      expect(batch.records.map((r) => r.id)).toEqual(["2"]);
      expect(batch.since).toBe("2026-03-01T00:00:00.000Z");
    });

    it("updates using the custom id field", async () => {
      await collect(customEntity.insert!(from([{ data: { uuid: "1", name: "Alice" } }] satisfies InsertRecord[])));

      const [result] = await collect(
        customEntity.update!(from([{ id: "1", data: { name: "Alicia" } }] satisfies UpdateRecord[]))
      );
      expect(result.id).toBe("1");

      const [stored] = await customEntity.lookup!(["1"]);
      expect(stored.data["name"]).toBe("Alicia");
    });

    it("deletes using the custom id field", async () => {
      await collect(customEntity.insert!(from([{ data: { uuid: "1", name: "Alice" } }] satisfies InsertRecord[])));

      const [result] = await collect(customEntity.delete!(from(["1"])));
      expect(result).toEqual({ id: "1" });

      const [batch] = await collect(customEntity.read!(customCtx));
      expect(batch.records).toHaveLength(0);
    });
  });

  // ── associations ───────────────────────────────────────────────────────────

  describe("associations", () => {
    it("extracts associations from the configured field", async () => {
      writeFileSync(fp, JSON.stringify([
        {
          id: "1",
          data: { name: "Alice" },
          links: [{ predicate: "company", targetEntity: "company", targetId: "c1" }],
        },
      ]));

      const assocCtx = makeCtx([fp], { associationsField: "links" });
      const assocEntity = connector.getEntities!(assocCtx)[0];
      const [batch] = await collect(assocEntity.read!(assocCtx));

      expect(batch.records[0].associations).toEqual([
        { predicate: "company", targetEntity: "company", targetId: "c1" },
      ]);
    });

    it("strips the associations field from data", async () => {
      writeFileSync(fp, JSON.stringify([
        {
          id: "1",
          data: { name: "Alice" },
          links: [{ predicate: "company", targetEntity: "company", targetId: "c1" }],
        },
      ]));

      const assocCtx = makeCtx([fp], { associationsField: "links" });
      const assocEntity = connector.getEntities!(assocCtx)[0];
      const [batch] = await collect(assocEntity.read!(assocCtx));

      expect(batch.records[0].data).not.toHaveProperty("links");
    });

    it("also exposes associations via lookup", async () => {
      writeFileSync(fp, JSON.stringify([
        {
          id: "1",
          data: { name: "Alice" },
          links: [{ predicate: "company", targetEntity: "company", targetId: "c1" }],
        },
      ]));

      const assocCtx = makeCtx([fp], { associationsField: "links" });
      const assocEntity = connector.getEntities!(assocCtx)[0];
      const [record] = await assocEntity.lookup!(["1"]);

      expect(record.associations).toEqual([
        { predicate: "company", targetEntity: "company", targetId: "c1" },
      ]);
    });

    it("does not set associations when field is not configured", async () => {
      writeFileSync(fp, JSON.stringify([{ id: "1", data: {}, links: [] }]));

      const [batch] = await collect(entity.read!(ctx));
      expect(batch.records[0].associations).toBeUndefined();
    });
  });

  // ── multiple files ─────────────────────────────────────────────────────────

  describe("multiple files", () => {
    let dir: string;
    let customersFile: string;
    let invoicesFile: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "jsonfiles-multi-"));
      customersFile = join(dir, "customers.json");
      invoicesFile = join(dir, "invoices.json");
    });

    afterEach(() => {
      rmSync(dir, { recursive: true });
    });

    it("creates one entity per file with the filename as entity name", () => {
      const multiCtx = makeCtx([customersFile, invoicesFile]);
      const entities = connector.getEntities!(multiCtx);
      expect(entities.map((e) => e.name)).toEqual(["customers", "invoices"]);
    });

    it("each entity reads and writes to its own file independently", async () => {
      writeFileSync(customersFile, JSON.stringify([{ id: "c1", data: { name: "ACME" } }]));
      writeFileSync(invoicesFile, JSON.stringify([{ id: "i1", data: { amount: 100 } }]));

      const multiCtx = makeCtx([customersFile, invoicesFile]);
      const [customersEntity, invoicesEntity] = connector.getEntities!(multiCtx);

      const [customerBatch] = await collect(customersEntity.read!(multiCtx));
      const [invoiceBatch] = await collect(invoicesEntity.read!(multiCtx));

      expect(customerBatch.records.map((r) => r.id)).toEqual(["c1"]);
      expect(invoiceBatch.records.map((r) => r.id)).toEqual(["i1"]);
    });

    it("inserting into one entity does not affect the other file", async () => {
      const multiCtx = makeCtx([customersFile, invoicesFile]);
      const [customersEntity, invoicesEntity] = connector.getEntities!(multiCtx);

      await collect(customersEntity.insert!(from([{ data: { _id: "c1" } }] satisfies InsertRecord[])));

      const [invoiceBatch] = await collect(invoicesEntity.read!(multiCtx));
      expect(invoiceBatch.records).toHaveLength(0);
    });
  });

  // ── log format ─────────────────────────────────────────────────────────────
  // Spec: plans/connectors/PLAN_JSONFILES_LOG_FORMAT.md

  describe("log format", () => {
    let logCtx: ConnectorContext;
    let logEntity: EntityDefinition;

    beforeEach(() => {
      logCtx = makeCtx([fp], { logFormat: true });
      logEntity = connector.getEntities!(logCtx)[0];
    });

    // ── insert ────────────────────────────────────────────────────────────────

    it("insert two records — file has 2 entries, read emits both", async () => {
      await collect(logEntity.insert!(from([
        { data: { name: "Alice" } },
        { data: { name: "Bob" } },
      ] satisfies InsertRecord[])));

      const [batch] = await collect(logEntity.read!(logCtx));
      expect(batch.records).toHaveLength(2);
      expect(batch.records.map((r) => r.data["name"])).toEqual(expect.arrayContaining(["Alice", "Bob"]));
    });

    it("insert appends entries to the file without removing old ones", async () => {
      await collect(logEntity.insert!(from([{ data: { name: "Alice" } }] satisfies InsertRecord[])));
      await collect(logEntity.insert!(from([{ data: { name: "Bob" } }] satisfies InsertRecord[])));

      const raw = JSON.parse(require("node:fs").readFileSync(fp, "utf8")) as unknown[];
      expect(raw).toHaveLength(2);
    });

    // ── update ────────────────────────────────────────────────────────────────

    it("update appends a new version — file has 2 entries but read emits only latest", async () => {
      const [ins] = await collect(logEntity.insert!(from([{ data: { name: "Alice" } }] satisfies InsertRecord[])));
      const id = ins.id;

      await collect(logEntity.update!(from([{ id, data: { name: "Alicia" } }] satisfies UpdateRecord[])));

      const raw = JSON.parse(require("node:fs").readFileSync(fp, "utf8")) as unknown[];
      expect(raw).toHaveLength(2); // both versions on disk

      const [batch] = await collect(logEntity.read!(logCtx));
      expect(batch.records).toHaveLength(1);
      expect(batch.records[0].data["name"]).toBe("Alicia");
    });

    it("update merges fields from the effective record", async () => {
      const [ins] = await collect(logEntity.insert!(from([{ data: { name: "Alice", age: 30 } }] satisfies InsertRecord[])));
      await collect(logEntity.update!(from([{ id: ins.id, data: { age: 31 } }] satisfies UpdateRecord[])));

      const [batch] = await collect(logEntity.read!(logCtx));
      expect(batch.records[0].data).toMatchObject({ name: "Alice", age: 31 });
    });

    it("update on unknown id yields notFound", async () => {
      const results = await collect(logEntity.update!(from([{ id: "ghost", data: { x: 1 } }] satisfies UpdateRecord[])));
      expect(results[0]).toMatchObject({ id: "ghost", notFound: true });
    });

    // ── delete ────────────────────────────────────────────────────────────────

    it("delete appends a tombstone — read emits nothing", async () => {
      const [ins] = await collect(logEntity.insert!(from([{ data: { name: "Alice" } }] satisfies InsertRecord[])));

      await collect(logEntity.delete!(from([ins.id])));

      const raw = JSON.parse(require("node:fs").readFileSync(fp, "utf8")) as unknown[];
      expect(raw).toHaveLength(2); // original + tombstone

      const [batch] = await collect(logEntity.read!(logCtx));
      expect(batch.records).toHaveLength(0);
    });

    it("delete on unknown id yields notFound", async () => {
      const results = await collect(logEntity.delete!(from(["ghost"])));
      expect(results[0]).toMatchObject({ id: "ghost", notFound: true });
    });

    it("delete on already-tombstoned id yields notFound", async () => {
      const [ins] = await collect(logEntity.insert!(from([{ data: { name: "Alice" } }] satisfies InsertRecord[])));
      await collect(logEntity.delete!(from([ins.id])));

      const results = await collect(logEntity.delete!(from([ins.id])));
      expect(results[0]).toMatchObject({ id: ins.id, notFound: true });
    });

    // ── since / watermark ─────────────────────────────────────────────────────

    it("since filter — updated record is newer than since, re-emitted", async () => {
      const [ins] = await collect(logEntity.insert!(from([{ data: { name: "Alice" } }] satisfies InsertRecord[])));
      const [firstBatch] = await collect(logEntity.read!(logCtx));
      const since = firstBatch.since!;

      await collect(logEntity.update!(from([{ id: ins.id, data: { name: "Alicia" } }] satisfies UpdateRecord[])));

      const [secondBatch] = await collect(logEntity.read!(logCtx, since));
      expect(secondBatch.records).toHaveLength(1);
      expect(secondBatch.records[0].data["name"]).toBe("Alicia");
    });

    it("since filter — record unchanged since last sync, not re-emitted", async () => {
      await collect(logEntity.insert!(from([{ data: { name: "Alice" } }] satisfies InsertRecord[])));
      const [firstBatch] = await collect(logEntity.read!(logCtx));
      const since = firstBatch.since!;

      const [secondBatch] = await collect(logEntity.read!(logCtx, since));
      expect(secondBatch.records).toHaveLength(0);
    });

    it("since filter — record deleted after since, tombstone causes omission", async () => {
      const [ins] = await collect(logEntity.insert!(from([{ data: { name: "Alice" } }] satisfies InsertRecord[])));
      const [firstBatch] = await collect(logEntity.read!(logCtx));
      const since = firstBatch.since!;

      await collect(logEntity.delete!(from([ins.id])));

      const [secondBatch] = await collect(logEntity.read!(logCtx, since));
      expect(secondBatch.records).toHaveLength(0);
    });

    // ── lookup ────────────────────────────────────────────────────────────────

    it("lookup returns only the latest version", async () => {
      const [ins] = await collect(logEntity.insert!(from([{ data: { name: "Alice" } }] satisfies InsertRecord[])));
      await collect(logEntity.update!(from([{ id: ins.id, data: { name: "Alicia" } }] satisfies UpdateRecord[])));

      const results = await logEntity.lookup!([ins.id]);
      expect(results).toHaveLength(1);
      expect(results[0].data["name"]).toBe("Alicia");
    });

    it("lookup for tombstoned id returns nothing", async () => {
      const [ins] = await collect(logEntity.insert!(from([{ data: { name: "Alice" } }] satisfies InsertRecord[])));
      await collect(logEntity.delete!(from([ins.id])));

      const results = await logEntity.lookup!([ins.id]);
      expect(results).toHaveLength(0);
    });

    // ── watermark ordering ────────────────────────────────────────────────────

    it("multiple inserts produce ascending updated ordering in file", async () => {
      await collect(logEntity.insert!(from([{ data: { n: 1 } }, { data: { n: 2 } }, { data: { n: 3 } }] satisfies InsertRecord[])));

      const raw = JSON.parse(require("node:fs").readFileSync(fp, "utf8")) as Array<{ updated: number }>;
      const watermarks = raw.map((r) => r.updated);
      expect(watermarks).toEqual([...watermarks].sort((a, b) => a - b));
    });

    // ── mutable mode unaffected ───────────────────────────────────────────────

    it("logFormat false (default) — update still mutates in-place", async () => {
      const [ins] = await collect(entity.insert!(from([{ data: { name: "Alice" } }] satisfies InsertRecord[])));
      await collect(entity.update!(from([{ id: ins.id, data: { name: "Alicia" } }] satisfies UpdateRecord[])));

      const raw = JSON.parse(require("node:fs").readFileSync(fp, "utf8")) as unknown[];
      expect(raw).toHaveLength(1);
    });
  });
});
