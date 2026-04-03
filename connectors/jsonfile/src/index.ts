import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
} from "@opensync/sdk";

// ─── File format ─────────────────────────────────────────────────────────────
// The JSON file is a flat array of objects. Each object must have an "id" field
// (string). Any other fields are passed through as-is. The connector also
// maintains an "updatedAt" field (ISO 8601) so incremental syncs work.

interface FileRecord {
  id: string;
  updatedAt?: string;
  [key: string]: unknown;
}

function readFile(filePath: string): FileRecord[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as FileRecord[];
}

function writeFile(filePath: string, records: FileRecord[]): void {
  writeFileSync(filePath, JSON.stringify(records, null, 2), "utf8");
}

function filePath(ctx: ConnectorContext): string {
  const p = ctx.config["filePath"];
  if (typeof p !== "string" || !p) {
    throw new Error("config.filePath must be a non-empty string");
  }
  return p;
}

// ─── Entity ───────────────────────────────────────────────────────────────────

const recordEntity: EntityDefinition = {
  name: "record",

  schema: {
    id: {
      description: "Record identifier. Must be unique within the file.",
      type: "string",
      required: true,
      immutable: true,
    },
    updatedAt: {
      description:
        "ISO 8601 timestamp of the last modification. Used as the sync watermark.",
      type: "string",
    },
  },

  async *fetch(
    ctx: ConnectorContext,
    since?: string
  ): AsyncIterable<FetchBatch> {
    const records = readFile(filePath(ctx));

    const filtered = since
      ? records.filter(
          (r) => r.updatedAt !== undefined && r.updatedAt > since
        )
      : records;

    // Yield in one batch. Real connectors would page through large datasets.
    const maxUpdatedAt = filtered.reduce<string | undefined>(
      (max, r) => (r.updatedAt && (!max || r.updatedAt > max) ? r.updatedAt : max),
      undefined
    );

    yield {
      records: filtered.map(({ id, ...data }) => ({
        id,
        data: data as Record<string, unknown>,
      })) satisfies FetchRecord[],
      since: maxUpdatedAt ?? since,
    };
  },

  async lookup(
    ids: string[],
    ctx: ConnectorContext
  ): Promise<FetchRecord[]> {
    const idSet = new Set(ids);
    return readFile(filePath(ctx))
      .filter((r) => idSet.has(r.id))
      .map(({ id, ...data }) => ({
        id,
        data: data as Record<string, unknown>,
      }));
  },

  async *insert(
    records: AsyncIterable<InsertRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<InsertResult> {
    const fp = filePath(ctx);
    for await (const record of records) {
      const existing = readFile(fp);
      const id = (record.data["id"] as string | undefined) ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const newRecord: FileRecord = { id, updatedAt: now, ...record.data };
      writeFile(fp, [...existing, newRecord]);
      yield { id, data: newRecord as Record<string, unknown> };
    }
  },

  async *update(
    records: AsyncIterable<UpdateRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<UpdateResult> {
    const fp = filePath(ctx);
    for await (const record of records) {
      const existing = readFile(fp);
      const idx = existing.findIndex((r) => r.id === record.id);
      if (idx === -1) {
        yield { id: record.id, notFound: true as const };
        continue;
      }
      const now = new Date().toISOString();
      const updated: FileRecord = {
        ...existing[idx],
        ...record.data,
        id: record.id,
        updatedAt: now,
      };
      existing[idx] = updated;
      writeFile(fp, existing);
      yield { id: record.id, data: updated as Record<string, unknown> };
    }
  },

  async *delete(
    ids: AsyncIterable<string>,
    ctx: ConnectorContext
  ): AsyncIterable<DeleteResult> {
    const fp = filePath(ctx);
    for await (const id of ids) {
      const existing = readFile(fp);
      const idx = existing.findIndex((r) => r.id === id);
      if (idx === -1) {
        yield { id, notFound: true as const };
        continue;
      }
      existing.splice(idx, 1);
      writeFile(fp, existing);
      yield { id };
    }
  },
};

// ─── Connector ────────────────────────────────────────────────────────────────

const connector: Connector = {
  metadata: {
    name: "jsonfile",
    version: "0.1.0",
    auth: { type: "none" },
    configSchema: {
      filePath: {
        type: "string",
        description: "Absolute path to the JSON file used for storage.",
        required: true,
      },
    },
  },

  getEntities(): EntityDefinition[] {
    return [recordEntity];
  },
};

export default connector;
