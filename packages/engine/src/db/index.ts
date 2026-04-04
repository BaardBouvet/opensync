// Spec: specs/database.md
// Internal DB adapter interface. The rest of the engine types against this — never
// against the underlying driver directly.
// Runtime adapter: uses bun:sqlite when running under Bun, better-sqlite3 under Node.js.

import type BetterSqlite3 from "better-sqlite3";

// ─── Adapter interface ────────────────────────────────────────────────────────

export interface DbStatement<T> {
  get(...params: unknown[]): T | undefined;
  all(...params: unknown[]): T[];
  run(...params: unknown[]): void;
}

export interface Db {
  prepare<T = Record<string, unknown>>(sql: string): DbStatement<T>;
  transaction<T>(fn: () => T): () => T;
  exec(sql: string): void;
  close(): void;
}

// ─── openDb ───────────────────────────────────────────────────────────────────

// Spec: specs/database.md — open the SQLite file, enable WAL + FK enforcement.
// Tries bun:sqlite first (Bun runtime), falls back to better-sqlite3 (Node.js).
export function openDb(path: string): Db {
  // Detect Bun runtime via its global object (populated by Bun, absent in Node.js)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (globalThis as Record<string, unknown>)["Bun"] !== "undefined") {
    return _openBunSqlite(path);
  }
  return _openBetterSqlite3(path);
}

// ─── bun:sqlite adapter ───────────────────────────────────────────────────────

interface BunSqliteDatabase {
  prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): void };
  transaction<T>(fn: () => T): () => T;
  exec(sql: string): void;
  close(): void;
  query(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): void };
}

function _openBunSqlite(path: string): Db {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite") as { Database: new (path: string, opts?: Record<string, unknown>) => BunSqliteDatabase };
  const raw = new Database(path);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return {
    prepare<T = Record<string, unknown>>(sql: string): DbStatement<T> {
      const stmt = raw.prepare(sql);
      return {
        get(...params: unknown[]): T | undefined {
          return stmt.get(...params) as T | undefined;
        },
        all(...params: unknown[]): T[] {
          return stmt.all(...params) as T[];
        },
        run(...params: unknown[]): void {
          stmt.run(...params);
        },
      };
    },
    transaction<T>(fn: () => T): () => T {
      return raw.transaction(fn);
    },
    exec(sql: string): void {
      raw.exec(sql);
    },
    close(): void {
      raw.close();
    },
  };
}

// ─── better-sqlite3 adapter (Node.js) ────────────────────────────────────────

function _openBetterSqlite3(path: string): Db {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3") as typeof BetterSqlite3;
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  return _wrapBetterSqlite3(raw);
}

function _wrapBetterSqlite3(raw: BetterSqlite3.Database): Db {
  return {
    prepare<T = Record<string, unknown>>(sql: string): DbStatement<T> {
      const stmt = raw.prepare<unknown[], T>(sql);
      return {
        get(...params: unknown[]): T | undefined {
          return stmt.get(...params) as T | undefined;
        },
        all(...params: unknown[]): T[] {
          return stmt.all(...params) as T[];
        },
        run(...params: unknown[]): void {
          stmt.run(...params);
        },
      };
    },
    transaction<T>(fn: () => T): () => T {
      return raw.transaction(fn);
    },
    exec(sql: string): void {
      raw.exec(sql);
    },
    close(): void {
      raw.close();
    },
  };
}
