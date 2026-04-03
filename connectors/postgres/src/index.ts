/**
 * Postgres connector — syncs a single table as a connector entity.
 *
 * Design decisions:
 * - One connector instance = one table. If you need multiple tables, run multiple instances.
 * - The primary key column is mapped to FetchRecord.id. Defaults to 'id'.
 * - Incremental fetch uses an `updated_at` timestamp column. If absent, every fetch is a full sync.
 * - Uses parameterised queries throughout — no string interpolation of user data.
 *
 * Auth: connection string (DSN) in configSchema, marked secret.
 * No ctx.http used — all I/O goes through the pg Pool.
 */
import { Pool } from "pg";
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
import { ConnectorError, ValidationError } from "@opensync/sdk";

// ─── Pool management ──────────────────────────────────────────────────────────
// One pool per connector instance, keyed by connection string. In production the
// engine will only instantiate one Connector object per instance so this is
// effectively a singleton per instance, but we guard with a Map anyway.

const pools = new Map<string, Pool>();

function getPool(ctx: ConnectorContext): Pool {
  const dsn = ctx.config["connectionString"];
  if (typeof dsn !== "string" || !dsn) {
    throw new ValidationError("config.connectionString must be a non-empty string");
  }
  if (!pools.has(dsn)) {
    pools.set(dsn, new Pool({ connectionString: dsn, max: 5 }));
  }
  return pools.get(dsn)!;
}

function tableName(ctx: ConnectorContext): string {
  const t = ctx.config["table"];
  if (typeof t !== "string" || !t) {
    throw new ValidationError("config.table must be a non-empty string");
  }
  // Validate: only allow simple identifiers to prevent SQL injection.
  // The column name comes from config, not user data — but still validate.
  if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(t)) {
    throw new ValidationError(
      `config.table '${t}' contains invalid characters. Use schema.table or plain table name.`
    );
  }
  return t;
}

function idColumn(ctx: ConnectorContext): string {
  const col = ctx.config["idColumn"] ?? "id";
  if (typeof col !== "string") throw new ValidationError("config.idColumn must be a string");
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
    throw new ValidationError(`config.idColumn '${col}' contains invalid characters`);
  }
  return col;
}

function updatedAtColumn(ctx: ConnectorContext): string | null {
  const col = ctx.config["updatedAtColumn"];
  if (col === undefined || col === null) return null;
  if (typeof col !== "string") throw new ValidationError("config.updatedAtColumn must be a string");
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
    throw new ValidationError(`config.updatedAtColumn '${col}' contains invalid characters`);
  }
  return col;
}

function rowToRecord(row: Record<string, unknown>, idCol: string): FetchRecord {
  const id = String(row[idCol]);
  const data = { ...row };
  return { id, data };
}

// ─── Entity ───────────────────────────────────────────────────────────────────

const tableEntity: EntityDefinition = {
  // Name is dynamic — we use 'row' as the entity name. Connectors that manage multiple
  // tables should create multiple instances, each with their own config.
  name: "row",

  schema: {
    // Schema is intentionally minimal — the actual columns are determined by the table.
    // Connector authors can extend this if they want field-level metadata.
  },

  async *fetch(
    ctx: ConnectorContext,
    since?: string
  ): AsyncIterable<FetchBatch> {
    const pool = getPool(ctx);
    const table = tableName(ctx);
    const idCol = idColumn(ctx);
    const updCol = updatedAtColumn(ctx);

    const pageSize = 500;
    let offset = 0;

    while (true) {
      let query: string;
      const params: unknown[] = [];

      if (updCol && since) {
        query = `SELECT * FROM ${table} WHERE ${updCol} > $1 ORDER BY ${updCol} ASC, ${idCol} ASC LIMIT ${pageSize} OFFSET $2`;
        params.push(since, offset);
      } else {
        query = `SELECT * FROM ${table} ORDER BY ${idCol} ASC LIMIT ${pageSize} OFFSET $1`;
        params.push(offset);
      }

      let rows: Record<string, unknown>[];
      try {
        const result = await pool.query(query, params);
        rows = result.rows as Record<string, unknown>[];
      } catch (err) {
        throw new ConnectorError(
          `Postgres query failed: ${(err as Error).message}`,
          "QUERY_ERROR",
          true
        );
      }

      if (rows.length === 0) break;

      const maxUpdated = updCol
        ? rows.reduce<string | undefined>((max, r) => {
            const v = r[updCol];
            const s = v instanceof Date ? v.toISOString() : String(v ?? "");
            return !max || s > max ? s : max;
          }, undefined)
        : undefined;

      yield {
        records: rows.map((r) => rowToRecord(r, idCol)),
        since: maxUpdated ?? since,
      };

      if (rows.length < pageSize) break;
      offset += rows.length;
    }
  },

  async lookup(ids: string[], ctx: ConnectorContext): Promise<FetchRecord[]> {
    const pool = getPool(ctx);
    const table = tableName(ctx);
    const idCol = idColumn(ctx);

    // Use ANY($1) for a single-query batch fetch.
    let result;
    try {
      result = await pool.query(
        `SELECT * FROM ${table} WHERE ${idCol} = ANY($1)`,
        [ids]
      );
    } catch (err) {
      throw new ConnectorError(
        `Postgres lookup failed: ${(err as Error).message}`,
        "QUERY_ERROR",
        true
      );
    }
    return (result.rows as Record<string, unknown>[]).map((r) =>
      rowToRecord(r, idCol)
    );
  },

  async *insert(
    records: AsyncIterable<InsertRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<InsertResult> {
    const pool = getPool(ctx);
    const table = tableName(ctx);
    const idCol = idColumn(ctx);

    for await (const record of records) {
      const cols = Object.keys(record.data);
      if (cols.length === 0) {
        yield { id: "", error: "InsertRecord.data is empty" };
        continue;
      }

      // Validate column names — they come from engine-transformed data, not raw user input,
      // but we guard anyway.
      for (const col of cols) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
          yield {
            id: "",
            error: `Invalid column name: '${col}'`,
          };
          continue;
        }
      }

      const colList = cols.map((c) => `"${c}"`).join(", ");
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const values = cols.map((c) => record.data[c]);

      let result;
      try {
        result = await pool.query(
          `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) RETURNING *`,
          values
        );
      } catch (err) {
        yield {
          id: String(record.data[idCol] ?? ""),
          error: (err as Error).message,
        };
        continue;
      }

      const row = result.rows[0] as Record<string, unknown>;
      yield { id: String(row[idCol]), data: row };
    }
  },

  async *update(
    records: AsyncIterable<UpdateRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<UpdateResult> {
    const pool = getPool(ctx);
    const table = tableName(ctx);
    const idCol = idColumn(ctx);

    for await (const record of records) {
      const cols = Object.keys(record.data);
      if (cols.length === 0) {
        yield { id: record.id, error: "UpdateRecord.data is empty" };
        continue;
      }

      for (const col of cols) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
          yield {
            id: record.id,
            error: `Invalid column name: '${col}'`,
          };
          continue;
        }
      }

      const setClause = cols.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
      const values = [...cols.map((c) => record.data[c]), record.id];

      let result;
      try {
        result = await pool.query(
          `UPDATE ${table} SET ${setClause} WHERE "${idCol}" = $${cols.length + 1} RETURNING *`,
          values
        );
      } catch (err) {
        yield {
          id: record.id,
          error: (err as Error).message,
        };
        continue;
      }

      if (result.rowCount === 0) {
        yield { id: record.id, notFound: true as const };
        continue;
      }

      const row = result.rows[0] as Record<string, unknown>;
      yield { id: record.id, data: row };
    }
  },

  async *delete(
    ids: AsyncIterable<string>,
    ctx: ConnectorContext
  ): AsyncIterable<DeleteResult> {
    const pool = getPool(ctx);
    const table = tableName(ctx);
    const idCol = idColumn(ctx);

    for await (const id of ids) {
      let result;
      try {
        result = await pool.query(
          `DELETE FROM ${table} WHERE "${idCol}" = $1`,
          [id]
        );
      } catch (err) {
        yield {
          id,
          error: (err as Error).message,
        };
        continue;
      }

      if (result.rowCount === 0) {
        yield { id, notFound: true as const };
      } else {
        yield { id };
      }
    }
  },
};

// ─── Connector ────────────────────────────────────────────────────────────────

const connector: Connector = {
  metadata: {
    name: "postgres",
    version: "0.1.0",
    // No HTTP auth — the DSN embeds credentials.
    auth: { type: "none" },
    configSchema: {
      connectionString: {
        type: "string",
        description:
          "PostgreSQL connection string (DSN). Example: postgres://user:pass@host:5432/db",
        required: true,
        secret: true,
      },
      table: {
        type: "string",
        description:
          "Table to sync (e.g. 'contacts' or 'public.contacts'). One instance per table.",
        required: true,
      },
      idColumn: {
        type: "string",
        description: "Primary key column name. Defaults to 'id'.",
        required: false,
        default: "id",
      },
      updatedAtColumn: {
        type: "string",
        description:
          "Optional timestamp column used for incremental fetch. If absent, every fetch is a full table scan.",
        required: false,
      },
    },
  },

  getEntities(): EntityDefinition[] {
    return [tableEntity];
  },

  async healthCheck(ctx) {
    const pool = getPool(ctx);
    try {
      await pool.query("SELECT 1");
      return { healthy: true };
    } catch (err) {
      return {
        healthy: false,
        message: `Database connection failed: ${(err as Error).message}`,
      };
    }
  },

  async onDisable(ctx) {
    const dsn = ctx.config["connectionString"] as string | undefined;
    if (dsn && pools.has(dsn)) {
      await pools.get(dsn)!.end();
      pools.delete(dsn);
    }
  },
};

export default connector;
