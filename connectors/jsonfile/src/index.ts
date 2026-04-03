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
// The JSON file is a flat array of objects. Each object must have an id field
// (configurable via `idField`). Any other fields are passed through as-is. The
// connector also maintains a watermark field (configurable via `watermarkField`)
// for incremental syncs.

interface FileRecord {
  [key: string]: unknown;
}

interface FieldConfig {
  idField: string;
  watermarkField: string;
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

const DEFAULT_ID_FIELD = "id";
const DEFAULT_WATERMARK_FIELD = "updatedAt";

function fieldConfig(ctx: ConnectorContext): FieldConfig {
  return {
    idField: (ctx.config["idField"] as string | undefined) ?? DEFAULT_ID_FIELD,
    watermarkField: (ctx.config["watermarkField"] as string | undefined) ?? DEFAULT_WATERMARK_FIELD,
  };
}

// ─── Entity ───────────────────────────────────────────────────────────────────

function makeRecordEntity({ idField, watermarkField }: FieldConfig): EntityDefinition {
  return {
    name: "record",

    schema: {
      [idField]: {
        description: "Record identifier. Must be unique within the file.",
        type: "string",
        required: true,
        immutable: true,
      },
      [watermarkField]: {
        description: "ISO 8601 timestamp of the last modification. Used as the sync watermark.",
        type: "string",
      },
    },

  async *fetch(
    ctx: ConnectorContext,
    since?: string
  ): AsyncIterable<FetchBatch> {
    const records = readFile(filePath(ctx));
    const { idField, watermarkField } = fieldConfig(ctx);

    const filtered = since
      ? records.filter(
          (r) => typeof r[watermarkField] === "string" && (r[watermarkField] as string) > since
        )
      : records;

    const maxWatermark = filtered.reduce<string | undefined>(
      (max, r) => {
        const w = r[watermarkField];
        return typeof w === "string" && (!max || w > max) ? w : max;
      },
      undefined
    );

    yield {
      records: filtered.map((r) => {
        const id = String(r[idField]);
        const { [idField]: _id, ...data } = r;
        return { id, data: data as Record<string, unknown> };
      }) satisfies FetchRecord[],
      since: maxWatermark ?? since,
    };
  },

  async lookup(
    ids: string[],
    ctx: ConnectorContext
  ): Promise<FetchRecord[]> {
    const { idField } = fieldConfig(ctx);
    const idSet = new Set(ids);
    return readFile(filePath(ctx))
      .filter((r) => idSet.has(String(r[idField])))
      .map((r) => {
        const id = String(r[idField]);
        const { [idField]: _id, ...data } = r;
        return { id, data: data as Record<string, unknown> };
      });
  },

  async *insert(
    records: AsyncIterable<InsertRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<InsertResult> {
    const fp = filePath(ctx);
    const { idField, watermarkField } = fieldConfig(ctx);
    for await (const record of records) {
      const existing = readFile(fp);
      const id = (record.data[idField] as string | undefined) ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const newRecord: FileRecord = { ...record.data, [idField]: id, [watermarkField]: now };
      writeFile(fp, [...existing, newRecord]);
      yield { id, data: newRecord as Record<string, unknown> };
    }
  },

  async *update(
    records: AsyncIterable<UpdateRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<UpdateResult> {
    const fp = filePath(ctx);
    const { idField, watermarkField } = fieldConfig(ctx);
    for await (const record of records) {
      const existing = readFile(fp);
      const idx = existing.findIndex((r) => String(r[idField]) === record.id);
      if (idx === -1) {
        yield { id: record.id, notFound: true as const };
        continue;
      }
      const now = new Date().toISOString();
      const updated: FileRecord = {
        ...existing[idx],
        ...record.data,
        [idField]: record.id,
        [watermarkField]: now,
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
    const { idField } = fieldConfig(ctx);
    for await (const id of ids) {
      const existing = readFile(fp);
      const idx = existing.findIndex((r) => String(r[idField]) === id);
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
}

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
      idField: {
        type: "string",
        description: "Field name used as the record identifier.",
        required: false,
        default: DEFAULT_ID_FIELD,
      },
      watermarkField: {
        type: "string",
        description: "Field name used as the incremental sync watermark (ISO 8601 timestamp).",
        required: false,
        default: DEFAULT_WATERMARK_FIELD,
      },
    },
  },

  getEntities(ctx: ConnectorContext): EntityDefinition[] {
    return [makeRecordEntity(fieldConfig(ctx))];
  },
};

export default connector;
