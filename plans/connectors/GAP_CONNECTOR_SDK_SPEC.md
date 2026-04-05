# GAP: Connector SDK — Spec vs. Package

> **Status:** Closed — all items resolved or explicitly dismissed
> **Date:** 2026-04-04
> **Type:** gap report
> **Scope:** `specs/connector-sdk.md` vs. `packages/sdk/src/types.ts`

This report documents deviations found between the `connector-sdk.md` spec and the
authoritative `packages/sdk/src/types.ts` package. The package is the source of truth
for connector authors.

---

## Fixed (addressed in spec)

### GAP-1: `ReadRecord.version` field missing from spec

**Spec**: No `version` field on `ReadRecord`
**Package**: `version?: string` — opaque concurrency token (e.g. ETag) passed back in
`UpdateRecord.version` for conditional writes

**Resolution**: Added to spec.

---

### GAP-2: `UpdateRecord.version` field missing from spec

**Spec**: No `version` field on `UpdateRecord`
**Package**: `version?: string` — last-seen version token from `ReadRecord.version`, used
for conditional writes (e.g. `If-Match` ETag)

**Resolution**: Added to spec.

---

### GAP-3: `UpdateRecord.snapshot` field missing from spec

**Spec**: No `snapshot` field on `UpdateRecord`
**Package**: `snapshot?: Record<string, unknown>` — full field snapshot at the time the delta
was computed; used for conflict detection without a `lookup()` round trip

**Resolution**: Added to spec.

---

### GAP-4: `ctx.state` backing table named incorrectly

**Spec**: "Backed by the `instance_meta` table in SQLite"
**Engine**: Table is `connector_state` — `packages/engine/src/db/migrations.ts` line 43

**Resolution**: Fixed in spec.

---

## Confirmed No Action Required

### GAP-5: `StateStore.update()` `timeoutMs` parameter

**Spec**: `update<T>(key, fn, timeoutMs?: number): Promise<T>` — `timeoutMs` present
**Package**: `update<T>(key, fn, timeoutMs?: number): Promise<T>` — matches spec

**Status**: Initially flagged as a deviation but confirmed to match. No action needed.

---

### GAP-6: `ConnectorMetadata.configSchema` — `ConfigField` type coverage

The spec's `ConfigField` type only shows `type: 'string' | 'number' | 'boolean'`. The
package also accepts `type: 'array'` and `type: 'object'` variants with additional properties
(`items`, `properties`). The spec was checked and found to cover these variants (Config Schema
subsection). No action needed.

---

### GAP-7: `ActionDefinition.execute` signature change

**Spec (old)**: `execute(payload, ctx): Promise<ActionResult>` — single payload
**Package**: `execute(payloads: AsyncIterable<ActionPayload>, ctx): AsyncIterable<ActionResult>` — streaming

The spec's Actions section has the new streaming signature. No action needed.

---

### GAP-8: `EntityDefinition.schema` uses `FieldDescriptor`, not `Record<string, string>`

Minor: the spec's inline `EntityDefinition` block at the top shows a simplified `schema`
comment. The full `FieldDescriptor` type is defined in the Metadata section. Connector authors
reading only the top interface might miss the structured type. Low priority.

**Resolution**: No change — the inline comment (`// field metadata (e.g. { "fnavn": ...})`)
is sufficient. The full `FieldDescriptor` type is one section below in the same file. Closing
without action.

**Status**: Closed — no action required.
