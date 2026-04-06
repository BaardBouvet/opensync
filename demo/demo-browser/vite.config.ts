import { defineConfig } from "vite";
import path from "node:path";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

// Copy the sql.js WASM files to public/ so Vite serves them in dev and includes them in dist.
// The browser entry (sql-wasm-browser.js) requests "sql-wasm-browser.wasm"; the Node entry
// requests "sql-wasm.wasm". Copy both so either build works.
function copySqlWasmFiles(): void {
  const sqlJsDistCandidates = [
    path.resolve(import.meta.dirname, "../../node_modules/.bun/sql.js@1.14.1/node_modules/sql.js/dist"),
    path.resolve(import.meta.dirname, "../../node_modules/sql.js/dist"),
  ];
  const filenames = ["sql-wasm-browser.wasm", "sql-wasm.wasm"];
  const publicDir = path.resolve(import.meta.dirname, "public");
  mkdirSync(publicDir, { recursive: true });
  let found = false;
  for (const distDir of sqlJsDistCandidates) {
    if (!existsSync(distDir)) continue;
    for (const name of filenames) {
      const src = path.join(distDir, name);
      if (existsSync(src)) {
        copyFileSync(src, path.join(publicDir, name));
        found = true;
      }
    }
    if (found) return;
  }
  console.warn("sql.js WASM files not found in node_modules; run bun install");
}

copySqlWasmFiles();

export default defineConfig({
  root: ".",
  base: "./",
  resolve: {
    alias: {
      // Stub native-only DB drivers — they are dead code in the browser
      // because openDb() is never called; only openBrowserDb() is used.
      "better-sqlite3": path.resolve(import.meta.dirname, "src/stubs/native-db.ts"),
      // Stub node built-ins pulled in by engine/config/loader.ts (loadConfig is
      // never called in the browser; these are dead code).
      "node:fs":   path.resolve(import.meta.dirname, "src/stubs/node-fs.ts"),
      "node:path": path.resolve(import.meta.dirname, "src/stubs/node-path.ts"),
    },
  },
  optimizeDeps: {
    // Let Vite's CJS→ESM transform handle sql.js; do not exclude it.
    include: ["sql.js"],
  },
  plugins: [
    {
      // bun:sqlite is not a real npm package — stub it so Rollup doesn't choke
      name: "stub-bun-sqlite",
      resolveId(id: string) {
        if (id === "bun:sqlite") return "\0bun-sqlite-stub";
      },
      load(id: string) {
        if (id === "\0bun-sqlite-stub") return "export const Database = class {};";
      },
    },
  ],
  build: {
    outDir: "dist",
    rollupOptions: {
      // Do not try to inline the sql-wasm.wasm binary — it is fetched at runtime
      external: [],
    },
  },
  server: {
    host: true, // bind to 0.0.0.0 so the devcontainer port-forward is reachable from the host
    fs: {
      // Allow importing the WASM file from the sql.js package
      allow: ["../.."],
    },
  },
});
