// LOCAL-ONLY CONNECTOR — uses node:fs to read/write local JSON files.
// This connector is a development and testing fixture. It cannot run in an
// isolated sandbox (Deno, vm.Context, workerd) because it directly imports
// node:fs. Do not use node:* imports in connectors intended for remote execution.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, extname } from "node:path";
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
} from "@opensync/sdk";

// ─── File format ─────────────────────────────────────────────────────────────
// Each JSON file is a flat array of objects. An id field (configurable via
// `idField`) must be unique within the file. A watermark field (configurable
// via `watermarkField`) drives incremental syncs. An optional associations
// field (configurable via `associationsField`) carries pre-declared edges to
// other entities in the same shape as the SDK's Association type.

interface FileRecord {
  [key: string]: unknown;
}

interface FieldConfig {
  idField: string;
  watermarkField: string;
  associationsField: string;
}

function readFile(filePath: string): FileRecord[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as FileRecord[];
}

function writeFile(filePath: string, records: FileRecord[]): void {
  writeFileSync(filePath, JSON.stringify(records, null, 2), "utf8");
}

const DEFAULT_ID_FIELD = "_id";
const DEFAULT_WATERMARK_FIELD = "_updatedAt";
const DEFAULT_ASSOCIATIONS_FIELD = "_associations";

function fieldConfig(ctx: ConnectorContext): FieldConfig {
  return {
    idField: (ctx.config["idField"] as string | undefined) ?? DEFAULT_ID_FIELD,
    watermarkField: (ctx.config["watermarkField"] as string | undefined) ?? DEFAULT_WATERMARK_FIELD,
    associationsField: (ctx.config["associationsField"] as string | undefined) ?? DEFAULT_ASSOCIATIONS_FIELD,
  };
}

/**
 * Parse the `filePaths` config value (string array) into
 * { entityName, entityFilePath } pairs. Entity name = file basename without extension.
 */
function parseFilePaths(ctx: ConnectorContext): Array<{ entityName: string; entityFilePath: string }> {
  const raw = ctx.config["filePaths"] as string[];
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error("config.filePaths must be a non-empty array of file paths");
  return raw.map((fp) => ({ entityName: basename(fp, extname(fp)), entityFilePath: fp }));
}

// ─── Entity ───────────────────────────────────────────────────────────────────

function makeRecordEntity(
  entityName: string,
  entityFilePath: string,
  { idField, watermarkField, associationsField }: FieldConfig
): EntityDefinition {
  /** Strip the id (and associations, if configured) from a raw file record. */
  function extractRecord(r: FileRecord): ReadRecord {
    const id = String(r[idField]);
    const data = Object.fromEntries(
      Object.entries(r).filter(([k]) => k !== idField && k !== associationsField)
    );
    const record: ReadRecord = { id, data };
    if (Array.isArray(r[associationsField])) {
      record.associations = r[associationsField] as Association[];
    }
    return record;
  }

  return {
    name: entityName,

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
      [associationsField]: {
        description: "Pre-declared associations to other entities.",
        type: { type: "array" } as const,
      },
    },

    async *read(_ctx: ConnectorContext, since?: string): AsyncIterable<ReadBatch> {
      const records = readFile(entityFilePath);

      const filtered = since
        ? records.filter(
            (r) =>
              typeof r[watermarkField] === "string" &&
              (r[watermarkField] as string) > since
          )
        : records;

      const maxWatermark = filtered.reduce<string | undefined>((max, r) => {
        const w = r[watermarkField];
        return typeof w === "string" && (!max || w > max) ? w : max;
      }, undefined);

      yield { records: filtered.map(extractRecord), since: maxWatermark ?? since };
    },

    async lookup(ids: string[]): Promise<ReadRecord[]> {
      const idSet = new Set(ids);
      return readFile(entityFilePath)
        .filter((r) => idSet.has(String(r[idField])))
        .map(extractRecord);
    },

    async *insert(records: AsyncIterable<InsertRecord>): AsyncIterable<InsertResult> {
      for await (const record of records) {
        const existing = readFile(entityFilePath);
        const id = (record.data[idField] as string | undefined) ?? crypto.randomUUID();
        const now = new Date().toISOString();
        const newRecord: FileRecord = {
          ...record.data,
          [idField]: id,
          [watermarkField]: now,
          ...(record.associations ? { [associationsField]: record.associations } : {}),
        };
        writeFile(entityFilePath, [...existing, newRecord]);
        yield { id, data: newRecord as Record<string, unknown> };
      }
    },

    async *update(records: AsyncIterable<UpdateRecord>): AsyncIterable<UpdateResult> {
      for await (const record of records) {
        const existing = readFile(entityFilePath);
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
          ...(record.associations !== undefined
            ? { [associationsField]: record.associations }
            : {}),
        };
        existing[idx] = updated;
        writeFile(entityFilePath, existing);
        yield { id: record.id, data: updated as Record<string, unknown> };
      }
    },

    async *delete(ids: AsyncIterable<string>): AsyncIterable<DeleteResult> {
      for await (const id of ids) {
        const existing = readFile(entityFilePath);
        const idx = existing.findIndex((r) => String(r[idField]) === id);
        if (idx === -1) {
          yield { id, notFound: true as const };
          continue;
        }
        existing.splice(idx, 1);
        writeFile(entityFilePath, existing);
        yield { id };
      }
    },
  };
}

// ─── Connector ────────────────────────────────────────────────────────────────

const connector: Connector = {
  metadata: {
    name: "jsonfiles",
    version: "0.1.0",
    auth: { type: "none" },
    configSchema: {
      filePaths: {
        type: "array",
        items: { type: "string" },
        description: "JSON file paths. Each file becomes one entity named after its basename.",
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
      associationsField: {
        type: "string",
        description: "Field name containing pre-declared associations to other entities.",
        required: false,
        default: DEFAULT_ASSOCIATIONS_FIELD,
      },
    },
  },

  getEntities(ctx: ConnectorContext): EntityDefinition[] {
    const fields = fieldConfig(ctx);
    return parseFilePaths(ctx).map(({ entityName, entityFilePath }) =>
      makeRecordEntity(entityName, entityFilePath, fields)
    );
  },
};

export default connector;
