# PLAN: Config Validation in loadConfig()

**Status:** proposed  
**Date:** 2026-04-04  
**Scope:** `packages/engine/src/config/loader.ts` + `schema.ts`  

---

## Problem

`loadConfig()` currently validates the shape of `opensync.json` and each mappings file using
Zod schemas, but only at the individual-document level. After merging connectors, channels, and
mappings into a `ResolvedConfig`, there is no cross-validation. Invalid configs are silently
passed to the engine, which either crashes with a confusing error at runtime or silently
misbehaves. 

---

## What is currently validated

- `opensync.json` parses as valid JSON and conforms to `OpenSyncJsonSchema` (Zod)
- Each `mappings/*.yaml` file conforms to `MappingsFileSchema` (Zod)
- Plugin paths resolve and export a valid `Connector` object (runtime import check)
- Env vars referenced by `${VAR}` are present (throws at load time)

---

## What is missing

### V1 — cross-reference checks (implement first)

These can be caught statically from the loaded `ResolvedConfig` before the engine starts:

1. **Channel members reference real connector IDs**  
   Every `member.connectorId` in every channel must match a connector declared in `opensync.json`.

2. **Channel has at least two members**  
   A channel with fewer than 2 members cannot sync — it is always a configuration mistake.

3. **No duplicate connector IDs**  
   Duplicate keys in `opensync.json.connectors` are silently last-write-wins in JSON. Detect
   and reject them (requires checking the raw JSON before Zod parses it).

4. **No duplicate channel IDs**  
   Two channels with the same `id` merged from different mappings files should be rejected, not
   silently merged.

5. **Entity names referenced in mappings exist in the connector**  
   After loading the plugin, call `getEntities(ctx)` and verify each `member.entity` is in the
   returned list. Requires a minimal `ConnectorContext` — state and http can be stubs.

### V2 — auth completeness checks (implement after auth.md is complete)

6. **Required auth fields present**  
   If `connector.metadata.auth.type === "oauth2"`, verify `clientId` and `clientSecret` are
   present in the resolved config (merged from `auth:` + `config:`).  
   If `metadata.auth.type === "api-key"`, verify at least one of `apiKey`, `api_key`,
   `accessToken` is present.

7. **Connector implements getOAuthConfig for oauth2 connectors**  
   If `metadata.auth.type === "oauth2"`, verify `connector.getOAuthConfig` is a function.

---

## Where to add validation

Add a `validateResolvedConfig` function in a new file
`packages/engine/src/config/validate.ts`. Call it at the end of `loadConfig()` before
returning `ResolvedConfig`.

```ts
// packages/engine/src/config/validate.ts
export function validateResolvedConfig(config: ResolvedConfig): void {
  // Throws ConfigValidationError with a human-readable message listing all issues.
}
```

Accumulate all issues before throwing so the user sees every problem in one run.

## Error type

```ts
export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Config validation failed:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigValidationError";
  }
}
```

---

## Tests

Add `packages/engine/src/config/validate.test.ts` with tests for each check:
- Valid config → no throw
- Missing connector ID in channel member → throws with clear message
- Channel with 1 member → throws
- Duplicate channel ID → throws
- Entity name not in connector's getEntities list → throws

---

## Out of scope

- Runtime validation during ingest (the engine already enforces preconditions via error throws)  
- Schema versioning or migration  
- Warning-vs-error severity levels (everything is an error for now)
