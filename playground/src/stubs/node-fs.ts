// Stub for node:fs — these functions are never called in the browser because
// loadConfig() is never invoked; only ResolvedConfig is constructed directly.
export const readFileSync = (): never => { throw new Error("node:fs not available"); };
export const readdirSync  = (): never => { throw new Error("node:fs not available"); };
export const existsSync   = (): boolean => false;
export const writeFileSync = (): never => { throw new Error("node:fs not available"); };
