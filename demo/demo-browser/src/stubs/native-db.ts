// Stub for better-sqlite3 — never called in the browser because openBrowserDb() is
// used instead of openDb(). Exists only so Vite can bundle packages/engine/src/db/index.ts
// without resolving the native addon.
export default class Database {
  prepare(): never { throw new Error("better-sqlite3 is not available in the browser"); }
}
