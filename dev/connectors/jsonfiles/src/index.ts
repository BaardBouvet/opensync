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
// Each JSON file is an array of objects with top-level envelope fields:
//
//   { id, data, updated?, associations? }
//
// `id`           — required; unique record identifier within the file.
// `data`         — required; the record payload passed to the engine as-is.
// `updated`      — optional watermark. Can be an ISO 8601 timestamp or a
//                  monotonically-increasing integer. Records without this field
//                  are always included in every read regardless of `since`.
// `associations` — optional; pre-declared edges in the SDK Association shape.
//
// Field names are configurable via connector config (idField, dataField,
// watermarkField, associationsField) but the defaults cover the common case.
//
// ── Audit log (auditLog: true) ──────────────────────────────────────────────
// When auditLog is enabled, every mutation is also appended to a companion
// <basename>.log.json file in the same directory. The main data file remains
// the mutable latest-state view and continues to work exactly as without auditLog.
// The log file is purely observational — the connector never reads from it.
//
// Log entry shapes:
//   insert: { op: "insert", id, data, associations?, updated }
//   update: { op: "update", id, before, after, updated }
//     before — changed data fields (old values) + old associations (if changed)
//     after  — changed data fields (new values) + new associations (if changed)
//   delete: { op: "delete", id, updated }
//
// Spec: plans/connectors/PLAN_JSONFILES_LOG_FORMAT.md

interface FileRecord {
  id?: unknown;
  data?: Record<string, unknown>;
  updated?: unknown;
  associations?: unknown;
  [key: string]: unknown;
}

interface FieldConfig {
  idField: string;
  dataField: string;
  watermarkField: string;
  associationsField: string;
}

interface LogConfig {
  auditLog: boolean;
}

function readFile(filePath: string): FileRecord[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as FileRecord[];
}

function writeFile(filePath: string, records: FileRecord[]): void {
  writeFileSync(filePath, JSON.stringify(records, null, 2), "utf8");
}

const DEFAULT_ID_FIELD = "id";
const DEFAULT_DATA_FIELD = "data";
const DEFAULT_WATERMARK_FIELD = "updated";
const DEFAULT_ASSOCIATIONS_FIELD = "associations";

function fieldConfig(ctx: ConnectorContext): FieldConfig {
  return {
    idField: (ctx.config["idField"] as string | undefined) ?? DEFAULT_ID_FIELD,
    dataField: (ctx.config["dataField"] as string | undefined) ?? DEFAULT_DATA_FIELD,
    watermarkField: (ctx.config["watermarkField"] as string | undefined) ?? DEFAULT_WATERMARK_FIELD,
    associationsField: (ctx.config["associationsField"] as string | undefined) ?? DEFAULT_ASSOCIATIONS_FIELD,
  };
}

function logConfig(ctx: ConnectorContext): LogConfig {
  return {
    auditLog: (ctx.config["auditLog"] as boolean | undefined) ?? false,
  };
}

// ─── Watermark comparison ─────────────────────────────────────────────────────
// The engine stores watermarks as opaque strings. The connector receives `since`
// as a string. File records may carry a string (ISO 8601) or number (integer
// sequence) in `updatedAt`. We compare by coercing both sides to the same type:
// if the raw value is a number, parse `since` as a number too; otherwise compare
// as strings. This lets integer-sequence watermarks work alongside ISO timestamps.

function isNewerThan(raw: unknown, since: string): boolean {
  if (typeof raw === "number") {
    const sinceNum = Number(since);
    return !Number.isNaN(sinceNum) && raw > sinceNum;
  }
  if (typeof raw === "string") {
    return raw > since;
  }
  return false; // unknown type → include record (safe default)
}

// Serialise a watermark value to a string for storage in the engine.
function watermarkToString(raw: unknown): string | undefined {
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "string") return raw;
  return undefined;
}

// Compute the next watermark to write for a record being inserted or updated.
// Mode is detected from the existing file contents:
//   - If every present watermark value is a number → integer mode: write max + 1.
//   - Otherwise (strings, mixed, or empty file) → ISO timestamp mode.
function nextWatermark(existing: FileRecord[], watermarkField: string): string | number {
  const values = existing
    .map((r) => r[watermarkField])
    .filter((v) => v !== undefined && v !== null);
  if (values.length === 0) return 1; // empty file → start integer sequence at 1
  if (values.every((v) => typeof v === "number")) {
    return Math.max(...(values as number[])) + 1;
  }
  return new Date().toISOString();
}

// ─── Log file helpers ─────────────────────────────────────────────────────────
// Spec: plans/connectors/PLAN_JSONFILES_LOG_FORMAT.md

interface LogEntry {
  op: "insert" | "update" | "delete";
  id: string;
  data?: Record<string, unknown>;          // insert only
  before?: Record<string, unknown> & { associations?: unknown }; // update only — old values of changed fields
  after?: Record<string, unknown> & { associations?: unknown };  // update only — new values of changed fields
  associations?: unknown;                  // insert only
  updated: unknown;
}

function logFilePath(entityFilePath: string): string {
  const ext = extname(entityFilePath);
  return ext
    ? entityFilePath.slice(0, -ext.length) + ".log.json"
    : entityFilePath + ".log.json";
}

function appendLogEntry(logPath: string, entry: LogEntry): void {
  const existing: LogEntry[] = existsSync(logPath)
    ? (JSON.parse(readFileSync(logPath, "utf8")) as LogEntry[])
    : [];
  writeFileSync(logPath, JSON.stringify([...existing, entry], null, 2), "utf8");
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
  { idField, dataField, watermarkField, associationsField }: FieldConfig,
  { auditLog }: LogConfig
): EntityDefinition {
  function extractRecord(r: FileRecord): ReadRecord {
    const id = String(r[idField]);
    const data = (r[dataField] as Record<string, unknown> | undefined) ?? {};
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
      [dataField]: {
        description: "Record payload. All sync fields live inside this object.",
        type: "object",
        required: true,
      },
      [watermarkField]: {
        description: "Sync watermark. ISO 8601 timestamp or monotonically-increasing integer. Optional — records without it are always included.",
        type: "string",
      },
      [associationsField]: {
        description: "Pre-declared associations to other entities.",
        type: { type: "array" } as const,
      },
    },

    async *read(_ctx: ConnectorContext, since?: string): AsyncIterable<ReadBatch> {
      const records = readFile(entityFilePath);

      // Records without a watermark field are always included (treated as "always newer").
      // Records with a watermark are included only when newer than `since`.
      const filtered = since
        ? records.filter((r) => {
            const w = r[watermarkField];
            if (w === undefined || w === null) return true; // no watermark → always include
            return isNewerThan(w, since);
          })
        : records;

      const maxWatermark = filtered.reduce<string | undefined>((max, r) => {
        const ws = watermarkToString(r[watermarkField]);
        if (!ws) return max;
        if (!max) return ws;
        // Compare in the same domain (numeric if both parse as numbers, else string)
        const wsNum = Number(ws);
        const maxNum = Number(max);
        if (!Number.isNaN(wsNum) && !Number.isNaN(maxNum)) return wsNum > maxNum ? ws : max;
        return ws > max ? ws : max;
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
        const wm = nextWatermark(existing, watermarkField);
        const newRecord: FileRecord = {
          [idField]: id,
          [dataField]: record.data,
          [watermarkField]: wm,
          ...(record.associations ? { [associationsField]: record.associations } : {}),
        };
        writeFile(entityFilePath, [...existing, newRecord]);
        // Spec: plans/connectors/PLAN_JSONFILES_LOG_FORMAT.md §3.4
        if (auditLog) {
          appendLogEntry(logFilePath(entityFilePath), {
            op: "insert", id, data: record.data,
            ...(record.associations ? { associations: record.associations } : {}),
            updated: wm,
          });
        }
        yield { id, data: record.data };
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
        const wm = nextWatermark(existing, watermarkField);
        const prev = (existing[idx]![dataField] as Record<string, unknown> | undefined) ?? {};
        const prevAssoc = existing[idx]![associationsField]; // capture before overwrite
        const merged = { ...prev, ...record.data };
        const updated: FileRecord = {
          ...existing[idx],
          [dataField]: merged,
          [watermarkField]: wm,
          ...(record.associations !== undefined
            ? { [associationsField]: record.associations }
            : {}),
        };
        existing[idx] = updated;
        writeFile(entityFilePath, existing);
        // Spec: plans/connectors/PLAN_JSONFILES_LOG_FORMAT.md §3.5
        if (auditLog) {
          // Compute a field-level diff: only emit keys that actually changed.
          const changedKeys = Object.keys(record.data).filter(
            (k) => JSON.stringify(prev[k]) !== JSON.stringify(record.data[k])
          );
          const before: Record<string, unknown> = {};
          const after: Record<string, unknown> = {};
          for (const k of changedKeys) {
            before[k] = prev[k];
            after[k] = record.data[k];
          }
          // Include associations in the diff when they changed.
          if (record.associations !== undefined) {
            if (JSON.stringify(prevAssoc) !== JSON.stringify(record.associations)) {
              before["associations"] = prevAssoc;
              after["associations"] = record.associations;
            }
          }
          const hasDiff = Object.keys(before).length > 0;
          appendLogEntry(logFilePath(entityFilePath), {
            op: "update", id: record.id,
            ...(hasDiff ? { before, after } : {}),
            updated: wm,
          });
        }
        yield { id: record.id, data: merged };
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
        const wm = nextWatermark(existing, watermarkField);
        existing.splice(idx, 1);
        writeFile(entityFilePath, existing);
        // Spec: plans/connectors/PLAN_JSONFILES_LOG_FORMAT.md §3.6
        if (auditLog) {
          appendLogEntry(logFilePath(entityFilePath), { op: "delete", id, updated: wm });
        }
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
        description: "Top-level field name used as the record identifier.",
        required: false,
        default: DEFAULT_ID_FIELD,
      },
      dataField: {
        type: "string",
        description: "Top-level field name containing the record payload.",
        required: false,
        default: DEFAULT_DATA_FIELD,
      },
      watermarkField: {
        type: "string",
        description: "Top-level field name used as the incremental sync watermark (ISO 8601 timestamp or integer sequence).",
        required: false,
        default: DEFAULT_WATERMARK_FIELD,
      },
      associationsField: {
        type: "string",
        description: "Top-level field name containing pre-declared associations to other entities.",
        required: false,
        default: DEFAULT_ASSOCIATIONS_FIELD,
      },
      auditLog: {
        type: "boolean",
        description: "Write a companion <basename>.log.json file recording every mutation. Insert entries carry the full data; update entries carry a before/after diff of only the changed fields; delete entries carry the id.",
        required: false,
        default: false,
      },
    },
  },

  getEntities(ctx: ConnectorContext): EntityDefinition[] {
    const fields = fieldConfig(ctx);
    const log = logConfig(ctx);
    return parseFilePaths(ctx).map(({ entityName, entityFilePath }) =>
      makeRecordEntity(entityName, entityFilePath, fields, log)
    );
  },
};

export default connector;
