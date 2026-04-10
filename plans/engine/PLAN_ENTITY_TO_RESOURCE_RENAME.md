# Entity → Resource Rename

**Status:** proposed  
**Date:** 2026-04-10  
**Effort:** L  
**Domain:** Config, SDK, Engine internals, DB  
**Scope:** `packages/engine/src/`, `packages/sdk/src/`, `playground/src/`, `connectors/`, `dev/`, `demo/`, `specs/`, `docs/`  

---

## § 1 Problem

`entity` is used for two structurally different concepts in the system, and overloaded with
industry meanings (DDD entity, ERP "entity module", etc.):

| Concept | Current name | Where it appears |
|---------|-------------|-----------------|
| The connector's own record type name | `entity` | YAML `entity: customers`, `ChannelMember.entity` |
| An FK pointing to *some* record type | `entity` | `FieldDescriptor.entity`, `Association.targetEntity`, `Ref['@entity']` |

The channel name is the canonical type concept — no separate name is needed for it.
The connector-local record type — what the connector's `read()` and `write()` function
calls the resource — is what gets the rename. The word "resource" fits naturally: it
matches REST/HTTP vocabulary (HubSpot has a `contacts` *resource*), it's how SaaS API
docs describe their endpoints, and it eliminates "two entities" confusion.

### The rename at a glance

```yaml
# Before
- connector: fiken
  channel: contacts
  entity: customers    # Fiken's own name for this record type

# After
- connector: fiken
  channel: contacts
  resource: customers
```

```ts
// Before
interface ChannelMember { entity: string; sourceEntity?: string; }

// After
interface ChannelMember { resource: string; sourceResource?: string; }
```

---

## § 2 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/config.md` | Mapping entry reference table | `entity` → `resource`; `source_entity` (if mentioned) → `source_resource`; all YAML examples |
| `specs/config.md` | Prose | "entity name" → "resource name" throughout |
| `specs/sync-engine.md` | `ChannelMember` snippet | `entity`, `sourceEntity` → `resource`, `sourceResource` |
| `specs/sync-engine.md` | `RecordSyncResult` snippet | `entity` field → `resource` |
| `specs/sync-engine.md` | Prose | "entity" → "resource" when referring to connector-local type |
| `specs/connector-sdk.md` | `FieldDescriptor.entity` | `entity` → `resource` |
| `specs/connector-sdk.md` | `Association.targetEntity` | → `targetResource` |
| `specs/connector-sdk.md` | `Ref['@entity']` | → `Ref['@resource']` |
| `specs/field-mapping.md` | All `entity:` YAML examples | → `resource:` |
| `specs/database.md` | Schema tables | Phase 2 only: `entity_name` → `resource_name` columns |
| All other specs | Any prose using "entity" to mean connector-local type | Replace |

---

## § 3 What Is NOT Being Renamed

The word "entity" appears in several contexts that are **correct and unchanged**:

| Appearance | Reason to keep |
|------------|---------------|
| Prose "real-world entity" / "canonical entity" | Refers to the abstract concept, not the config key |
| `identity` key on channel definitions | Unrelated — identity-matching config |
| DB transaction log `entity` column | Phase 2 only — kept in Phase 1 |
| `EntityDefinition` type from the connector (`.entities[]` on wired connector) | This is the connector's published resource catalogue; renamed in Phase 1 alongside `FieldDescriptor.entity` |
| Historical plan files | Not updated — internal records |

---

## § 4 Phase 1 — Public Surface (Config + SDK + TypeScript API)

**No data migration required.** All changes are source-code only. Existing SQLite databases
continue to work: the DB column is still `entity_name`; the engine just writes the renamed
in-memory field's value into it (same data, new TypeScript key name).

### § 4.1 Zod config schema — `packages/engine/src/config/schema.ts`

```
MappingEntrySchema:
  entity: z.string().optional()    →   resource: z.string().optional()
```

`source_entity` is never a Zod key (it is synthesised by the loader from `parent` chain
resolution). No change needed there in the Zod schema.

### § 4.2 Config loader — `packages/engine/src/config/loader.ts`

`ChannelMember` interface:
```
  entity: string           →  resource: string
  sourceEntity?: string    →  sourceResource?: string
```

Internal loader variables:
```
  resolvedEntity           →  resolvedResource
  resolvedSourceEntity     →  resolvedSourceResource
  entry.entity             →  entry.resource
  chainResult.sourceEntity →  chainResult.sourceResource
  cursor.entity            →  cursor.resource
```

Return object at member construction:
```
  entity: resolvedEntity,
  sourceEntity: resolvedSourceEntity,
               →
  resource: resolvedResource,
  sourceResource: resolvedSourceResource,
```

### § 4.3 SDK types — `packages/sdk/src/types.ts`

`FieldDescriptor`:
```
  entity?: string          →  resource?: string
```
(FK target annotation: "this field points to a record of resource X")

`Ref` (JSON-LD reference object):
```
  '@entity'?: string       →  '@resource'?: string
```

`Association`:
```
  targetEntity: string     →  targetResource: string
```

### § 4.4 Engine public types — `packages/engine/src/engine.ts`

`RecordSyncResult`:
```
  entity: string           →  resource: string
```

`OnboardResult` (line 133):
```
  entity: string           →  resource: string
```

Internal inline type at line 1928 / 2227:
```
  shadowData: { ...; entity: string; ... }
            →  shadowData: { ...; resource: string; ... }
```

All call sites that set or read `.entity` on these types throughout `engine.ts`.

### § 4.5 Engine internal uses of `member.entity` / `member.sourceEntity`

Every access to `member.entity` or `sourceMember.entity` or `sourceMember.sourceEntity`
throughout `engine.ts` (and any other file that touches `ChannelMember`):

```
  member.entity            →  member.resource
  member.sourceEntity      →  member.sourceResource
  sourceMember.entity      →  sourceMember.resource
  sourceMember.sourceEntity →  sourceMember.sourceResource
```

Specific engine.ts call sites that pass `member.entity` to DB functions
(`dbGetShadow`, `dbSetShadow`, `dbGetWatermark`, `dbSetWatermark`,
`dbGetAllShadowForEntity`, `dbGetDeferred`, `dbRemoveDeferred`, etc.) — the DB functions
themselves still accept a plain `string` argument; renaming the call-site variable is
sufficient.

### § 4.6 DB query helpers — `packages/engine/src/db/queries.ts`

Function parameter names (not the SQL strings):
```
  function dbGetWatermark(db, connectorId, entity)   →  (db, connectorId, resource)
  function dbSetWatermark(db, connectorId, entity, …) →  (db, connectorId, resource, …)
  function dbGetShadow(db, connectorId, entity, …)    →  (db, connectorId, resource, …)
  function dbSetShadow(db, connectorId, entity, …)    →  (db, connectorId, resource, …)
  …etc for all db helpers whose param is currently named "entity" or "entityName"
```

The SQL strings (`WHERE entity_name = ?`, `INSERT INTO shadow_state … entity_name`) remain
**unchanged** in Phase 1. Only the TypeScript variable names change.

Also in `queries.ts`:
```
  m.entity  (inside flatMap for member-clause parameters)  →  m.resource
```

### § 4.7 DB row types — `packages/engine/src/db/schema.ts`

`ChannelOnboardingStatusRow`:
```
  entity: string           →  resource: string
```

`WatermarkRow`, `ShadowStateRow`, `TransactionLogRow`, `WrittenStateRow` — these have
`entity_name: string` which is a mirror of the SQL column name. These are **not** renamed in
Phase 1 (they stay in sync with the SQL column, which Phase 2 renames).

### § 4.8 Test files

All test files that construct `ChannelMember` objects inline:
- `packages/engine/src/nested-array.test.ts` — `entity:`, `sourceEntity:` in member fixtures
- `packages/engine/src/split-canonical.test.ts` — `entity:` in member fixtures
- `packages/engine/src/jsonld-contract.test.ts` — `entity:` in member fixtures, `@entity` in Ref objects, `targetEntity:` in Association expectations
- `packages/engine/src/id-field.test.ts` — any `entity:` member constructions
- All other test files constructing `ChannelMember` or reading `.entity` / `.targetEntity`

SQL string fixtures in tests (e.g. `WHERE entity_name = 'order_lines'`) remain
**unchanged** in Phase 1.

### § 4.9 Playground

`playground/src/scenarios/*.ts` — all `entity:` keys in inline YAML/TS config strings.
`playground/src/lib/systems.ts` — `entity: "companies"` on `FieldDescriptor` entries.
`playground/src/ui/lineage-model.ts` — any `.entity` field access.

### § 4.10 Connectors and dev fixtures

All connectors that construct `Association` objects with `targetEntity:` must be updated to
`targetResource:`. Grep target:
```
  grep -rn "targetEntity" connectors/ dev/
```

All connector schema declarations using `entity:` on `FieldDescriptor` must use `resource:`.

### § 4.11 Specs and docs

- `specs/config.md`, `specs/sync-engine.md`, `specs/connector-sdk.md`, `specs/field-mapping.md`,
  `specs/associations.md`, `specs/identity.md`, `specs/database.md` (prose only in Phase 1)
- `docs/connectors/advanced.md`, `docs/connectors/guide.md`, `docs/using-the-engine.md`
- All YAML examples: `entity:` → `resource:`, `source_entity:` → `source_resource:`
- All inline TypeScript examples: `targetEntity` → `targetResource`, `'@entity'` → `'@resource'`

---

## § 5 Phase 2 — DB Storage Layer

**Requires a schema migration.** Existing databases must be migrated before the engine can run.
Pre-release, schema changes are append-only in `migrations.ts` using `CREATE TABLE IF NOT EXISTS`.
A column rename requires `ALTER TABLE … RENAME COLUMN` (supported in SQLite ≥ 3.25.0 / 2018-09-15,
present in all Bun runtimes). Because this is pre-release, no backward-compat shim is needed —
add the `ALTER TABLE` statements directly to `migrations.ts` after all the `CREATE TABLE IF NOT
EXISTS` blocks.

### § 5.1 Column renames in `migrations.ts`

Append after all `CREATE TABLE IF NOT EXISTS` blocks:

```sql
-- Phase 2: entity_name → resource_name  (pre-release rename, no user data preserved)
ALTER TABLE watermarks         RENAME COLUMN entity_name  TO resource_name;
ALTER TABLE shadow_state       RENAME COLUMN entity_name  TO resource_name;
ALTER TABLE transaction_log    RENAME COLUMN entity_name  TO resource_name;
ALTER TABLE deferred_associations RENAME COLUMN entity_name TO resource_name;
ALTER TABLE written_state      RENAME COLUMN entity_name  TO resource_name;
ALTER TABLE anti_affinity_links RENAME COLUMN entity_name_a TO resource_name_a;
ALTER TABLE anti_affinity_links RENAME COLUMN entity_name_b TO resource_name_b;
```

For the `transaction_log` table — the column is currently just `entity` (not `entity_name`),
a naming inconsistency. Fix it at the same time:
```sql
ALTER TABLE transaction_log RENAME COLUMN entity TO resource_name;
```

For `channel_onboarding_status`:
```sql
ALTER TABLE channel_onboarding_status RENAME COLUMN entity TO resource_name;
```

### § 5.2 DB row types — `packages/engine/src/db/schema.ts`

After the migration, update all row type interfaces:

```
WatermarkRow:         entity_name: string  →  resource_name: string
ShadowStateRow:       entity_name: string  →  resource_name: string
TransactionLogRow:    entity_name: string  →  resource_name: string
                      (+ entity → resource_name at the same time)
DeferredRow:          entity_name: string  →  resource_name: string
WrittenStateRow:      entity_name: string  →  resource_name: string
AntiAffinityLinkRow:  entity_name_a / _b   →  resource_name_a / _b
ChannelOnboardingStatusRow: entity         →  resource_name
```

### § 5.3 SQL strings — `packages/engine/src/db/queries.ts`

All SQL strings that reference `entity_name`, `entity_name_a`, `entity_name_b`, or bare
`entity` in DML/DDL. Replace every occurrence in:
- `WHERE entity_name = ?`
- `PRIMARY KEY (connector_id, entity_name, …)`
- `INSERT INTO … (connector_id, entity_name, …)`
- `ON CONFLICT (connector_id, entity_name, …)`
- join conditions (`sa.entity_name = nl.entity_name_a`, etc.)
- SELECT aliases (`entity_name AS entity_name`, etc.)

After this change every SQL string is consistent with the new column names.

### § 5.4 JS variable names in `queries.ts`

Internal variables that mirror the old column names (`entityName`, `entity_name`)
→ `resourceName`, `resource_name`.

### § 5.5 Engine `engine.ts` residual references

Any SQL strings inlined directly in `engine.ts` (not going through `queries.ts`) that
still reference `entity_name`:
```
  "… AND entity_name = ?"  →  "… AND resource_name = ?"
```

Specifically lines 289, 295 (the `memberClauses` / `idClauses` inline SQL).

### § 5.6 Test SQL fixtures

SQL strings in test files that query `entity_name` directly (e.g. lines 251, 259, 379 in
`nested-array.test.ts`, line 68 in `split-canonical.test.ts`):
```
  WHERE entity_name = 'order_lines'  →  WHERE resource_name = 'order_lines'
```

### § 5.7 `specs/database.md` — schema table documentation

Update the column names in all table schemas documented in `specs/database.md`.

---

## § 6 Implementation Order

### Phase 1

1. Specs first (§4.11) — update spec files and doc examples.
2. SDK types (§4.3) — `FieldDescriptor.resource`, `Association.targetResource`, `Ref['@resource']`.
3. Engine config schema + loader (§4.1, §4.2) — Zod key + `ChannelMember` interface + loader internals.
4. Engine types + engine.ts call sites (§4.4, §4.5).
5. DB query helper param names (§4.6).
6. DB row types partial (§4.7 — `ChannelOnboardingStatusRow.resource` only).
7. Connectors + dev fixtures (§4.10).
8. Playground (§4.9).
9. All test files excluding SQL string fixtures (§4.8).
10. `bun run tsc --noEmit` + `bun test` — must both pass clean.

### Phase 2

1. Add `ALTER TABLE` statements to `migrations.ts` (§5.1).
2. Update DB row types completely (§5.2).
3. Update all SQL strings in `queries.ts` (§5.3) and inline in `engine.ts` (§5.5).
4. Update internal JS variable names in `queries.ts` (§5.4).
5. Update SQL fixtures in test files (§5.6).
6. Update `specs/database.md` (§5.7).
7. `bun run tsc --noEmit` + `bun test` — must both pass clean.
8. `CHANGELOG.md` single entry covering both phases.

---

## § 7 Risk

- **Phase 1 risk: zero data risk.** Pure TypeScript/YAML rename; DB stores the same string
  values under the same column name.
- **Phase 2 risk: migration.** `ALTER TABLE … RENAME COLUMN` is idempotent-ish but not
  wrapped in a guard. If the migration runs twice (e.g. dev re-runs) SQLite will error.
  Use `IF EXISTS` pragma or check the column list first. Pre-release: acceptable to require
  a clean DB if migration fails.
- **Touch surface is wide.** ~6 source files, ~8 test files, ~5 spec files in Phase 1;
  ~3 source files, ~4 test files, ~2 spec files in Phase 2. Mechanical but complete.
- **Connector authors.** After Phase 1, any connector using `targetEntity` in `Association`
  or `entity` on `FieldDescriptor` or `@entity` in `Ref` will get a TypeScript type error —
  which is the correct signal.
- **Playground dist bundle.** `playground/dist/` is a build artifact; rebuild after Phase 1.
