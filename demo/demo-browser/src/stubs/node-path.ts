// Stub for node:path — only the functions referenced by engine/config/loader.ts
// are stubbed. Never called in the browser bundle.
export const join        = (..._: string[]): string => "";
export const resolve     = (..._: string[]): string => "";
export const isAbsolute  = (_: string): boolean => false;
export const basename    = (_: string, __?: string): string => "";
export const extname     = (_: string): string => "";
export const dirname     = (_: string): string => "";
export default { join, resolve, isAbsolute, basename, extname, dirname };
