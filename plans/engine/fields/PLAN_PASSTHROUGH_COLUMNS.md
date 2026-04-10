# PLAN: Passthrough Columns

**Status:** rejected  
**Date:** 2026-04-10  
**Effort:** S  
**Domain:** Engine — field mapping, shadow state, config  
**Scope:** `specs/field-mapping.md`, `specs/config.md`, `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/core/mapping.ts`, `packages/engine/src/engine.ts`  
**Depends on:** none  

## Decision

**Rejected.** Requiring the operator to enumerate every unmapped field under `passthrough:` is
fragile: a forgotten field is silently zeroed on write-back, which is exactly the problem this was
meant to solve. It transfers a connector-implementation concern into the config layer without giving
the operator a reliable safety net.

The correct solution is the existing connector contract: connectors that use a full-replace (PUT)
write API are responsible for calling `lookup()` to fetch the current record and merging incoming
fields before submitting the PUT. The engine provides `UpdateRecord.snapshot` (populated when
`lookup` is available) to avoid an extra round-trip in the common case. See
`specs/connector-sdk.md` §"Patch semantics for `update()`".  

