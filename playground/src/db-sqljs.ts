// Spec: specs/database.md — browser-native Db adapter backed by sql.js (SQLite via WASM).
// Implements the same Db interface as the bun:sqlite and better-sqlite3 adapters so the
// engine can be used unchanged in a browser context.
//
// sql.js is loaded asynchronously (WASM bootstrap) — call openBrowserDb() and await the
// result before constructing SyncEngine.

import type { Db } from "@opensync/engine";
// sql.js ships a CommonJS bundle — import as a namespace and call the factory.
import * as SqlJs from "sql.js";
type SqlJsDatabase = SqlJs.Database;
type Statement = SqlJs.Statement;
// The factory may be on .default (Vite CJS interop) or directly on the namespace.
const initSqlJs: (config?: SqlJs.SqlJsConfig) => Promise<SqlJs.SqlJsStatic> =
  (SqlJs as unknown as { default?: typeof SqlJs.default }).default ?? SqlJs.default;

// Local copy of DbStatement (not part of engine's public API)
interface DbStatement<T> {
  get(...params: unknown[]): T | undefined;
  all(...params: unknown[]): T[];
  run(...params: unknown[]): void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// sql.js returns SqlValue = number | string | null | Uint8Array. The engine's
// Db interface uses Record<string, unknown> for row types, which is compatible.

function wrapStatement<T>(stmt: Statement): DbStatement<T> {
  return {
    get(...params: unknown[]): T | undefined {
      stmt.bind(params as (number | string | null | Uint8Array)[]);
      const has = stmt.step();
      const result = has ? (stmt.getAsObject() as T) : undefined;
      stmt.reset();
      return result;
    },
    all(...params: unknown[]): T[] {
      stmt.bind(params as (number | string | null | Uint8Array)[]);
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      stmt.reset();
      return rows;
    },
    run(...params: unknown[]): void {
      stmt.run(params as (number | string | null | Uint8Array)[]);
    },
  };
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

function buildDb(raw: SqlJsDatabase): Db {
  return {
    prepare<T = Record<string, unknown>>(sql: string): DbStatement<T> {
      return wrapStatement<T>(raw.prepare(sql));
    },

    transaction<T>(fn: () => T): () => T {
      return () => {
        raw.run("BEGIN");
        try {
          const result = fn();
          raw.run("COMMIT");
          return result;
        } catch (err) {
          try { raw.run("ROLLBACK"); } catch { /* ignore rollback errors */ }
          throw err;
        }
      };
    },

    exec(sql: string): void {
      raw.exec(sql);
    },

    close(): void {
      raw.close();
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Open a fresh in-memory SQLite database backed by sql.js (WebAssembly).
 *  Must be awaited before constructing SyncEngine. */
export async function openBrowserDb(): Promise<Db> {
  const SQL = await initSqlJs({
    // Vite copies the WASM file to the output root; fetch it from the same base path.
    locateFile: (file: string) => `./${file}`,
  });
  const raw = new SQL.Database();
  // Match the PRAGMA setup used by the Node.js adapters
  raw.run("PRAGMA foreign_keys = ON;");
  return buildDb(raw);
}
