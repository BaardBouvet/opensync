// LOCAL-ONLY CONNECTOR — uses node:fs to read/write local JSON files.
// This connector is a development and testing fixture. It cannot run in an
// isolated sandbox (Deno, vm.Context, workerd) because it directly imports
// node:fs. Do not use node:* imports in connectors intended for remote execution.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import type {
  Connector,
  ConnectorContext,
  EntityDefinition,
  FieldDescriptor,
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
//   { id, data, updated? }
//
// `id`      — required; unique record identifier within the file.
// `data`    — required; the record payload passed to the engine as-is. FK
//             reference fields are stored as plain strings (the referenced ID).
//             The engine synthesises associations from plain strings when the
//             entity schema declares `entity` on the field.
// `updated` — optional watermark. Can be an ISO 8601 timestamp or a
//             monotonically-increasing integer. Records without this field
//             are always included in every read regardless of `since`.
//
// Field names are configurable via connector config (idField, dataField,
// watermarkField) but the defaults cover the common case.
//
// Entity / FK schema declaration:
//   Use `config.entities` to declare entities with their file paths and optional
//   per-entity FK schema overrides:
//     entities: {
//       contacts: { filePath: "contacts.json", schema: { companyId: { entity: "companies" } } },
//       companies: { filePath: "companies.json" }
//     }
//   The engine synthesises associations from the plain string values automatically.
//
// ── Audit log (auditLog: true) ──────────────────────────────────────────────
// When auditLog is enabled, every mutation is also appended to a companion
// <basename>.log.json file in the same directory. The main data file remains
// the mutable latest-state view and continues to work exactly as without auditLog.
// The log file is purely observational — the connector never reads from it.
//
// Log entry shapes:
//   insert: { op: "insert", id, data, updated, at }
//   update: { op: "update", id, before, after, updated, at }
//     before — changed data fields (old values)
//     after  — changed data fields (new values)
//   delete: { op: "delete", id, updated, at }
//   `at`  — ISO 8601 wall-clock timestamp of the mutation (always present)
//
// Spec: plans/connectors/PLAN_JSONFILES_LOG_FORMAT.md

interface FileRecord {
  id?: unknown;
  data?: Record<string, unknown>;
  updated?: unknown;
  [key: string]: unknown;
}

interface FieldConfig {
  idField: string;
  dataField: string;
  watermarkField: string;
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

function fieldConfig(ctx: ConnectorContext): FieldConfig {
  return {
    idField: (ctx.config["idField"] as string | undefined) ?? DEFAULT_ID_FIELD,
    dataField: (ctx.config["dataField"] as string | undefined) ?? DEFAULT_DATA_FIELD,
    watermarkField: (ctx.config["watermarkField"] as string | undefined) ?? DEFAULT_WATERMARK_FIELD,
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
  before?: Record<string, unknown>;        // update only — old values of changed fields
  after?: Record<string, unknown>;         // update only — new values of changed fields
  updated: unknown;
  at: string;                              // ISO 8601 wall-clock timestamp
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
 * Parse the `entities` config value into { entityName, entityFilePath, schemaOverrides } triples.
 * The key is the entity name; each value carries `filePath` and an optional `schema` override.
 */
function parseEntities(ctx: ConnectorContext): Array<{ entityName: string; entityFilePath: string; schemaOverrides?: Record<string, FieldDescriptor> }> {
  const raw = ctx.config["entities"] as Record<string, { filePath: string; schema?: Record<string, FieldDescriptor> }> | undefined;
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0)
    throw new Error("config.entities must be a non-empty object mapping entity names to { filePath, schema? }");
  return Object.entries(raw).map(([entityName, { filePath: entityFilePath, schema }]) => ({
    entityName,
    entityFilePath,
    schemaOverrides: schema,
  }));
}

// ─── Entity ───────────────────────────────────────────────────────────────────

function makeRecordEntity(
  entityName: string,
  entityFilePath: string,
  { idField, dataField, watermarkField }: FieldConfig,
  { auditLog }: LogConfig,
  schemaOverrides?: Record<string, FieldDescriptor>,
): EntityDefinition {
  function extractRecord(r: FileRecord): ReadRecord {
    const id = String(r[idField]);
    const data = { ...(r[dataField] as Record<string, unknown> | undefined) ?? {} };
    return { id, data };
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
      ...schemaOverrides,
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
        };
        writeFile(entityFilePath, [...existing, newRecord]);
        // Spec: plans/connectors/PLAN_JSONFILES_LOG_FORMAT.md §3.4
        if (auditLog) {
          appendLogEntry(logFilePath(entityFilePath), {
            op: "insert", id, data: record.data,
            updated: wm,
            at: new Date().toISOString(),
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

        const merged = { ...prev, ...record.data };
        const updated: FileRecord = {
          ...existing[idx],
          [dataField]: merged,
          [watermarkField]: wm,
        };
        existing[idx] = updated;
        writeFile(entityFilePath, existing);
        // Spec: plans/connectors/PLAN_JSONFILES_LOG_FORMAT.md §3.5
        if (auditLog) {
          const changedKeys = Object.keys(record.data).filter(
            (k) => JSON.stringify(prev[k]) !== JSON.stringify(record.data[k])
          );
          const before: Record<string, unknown> = {};
          const after: Record<string, unknown> = {};
          for (const k of changedKeys) {
            before[k] = prev[k];
            after[k] = record.data[k];
          }
          const hasDiff = changedKeys.length > 0;
          appendLogEntry(logFilePath(entityFilePath), {
            op: "update", id: record.id,
            ...(hasDiff ? { before, after } : {}),
            updated: wm,
            at: new Date().toISOString(),
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
          appendLogEntry(logFilePath(entityFilePath), { op: "delete", id, updated: wm, at: new Date().toISOString() });
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
      entities: {
        type: "object",
        description: "Entity map. Keys are entity names. Each value must have a `filePath` (path to the JSON file) and an optional `schema` (field descriptor map for FK references — use `entity` to declare FK targets so the engine can synthesise associations from plain string values).",
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
    return parseEntities(ctx).map(({ entityName, entityFilePath, schemaOverrides }) =>
      makeRecordEntity(entityName, entityFilePath, fields, log, schemaOverrides)
    );
  },
};

export default connector;

