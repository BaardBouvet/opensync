# PLAN: Database Migrations

> **Status:** pre-implementation — no migrations infrastructure exists yet
> **Date:** 2026-04-04
> **Prerequisite:** First public release shipped

---

## Rule: No Migrations Before First Release

Before the first public release, the database schema is append-only and idempotent.
All schema changes are made directly in `packages/engine/src/db/migrations.ts` using
`CREATE TABLE IF NOT EXISTS`. Dropping and recreating tables is acceptable because no
user data exists in persistent storage yet.

**This rule is also in `AGENTS.md`**: do not add migration infrastructure before the first
release.

---

## Background

The current schema boot calls `createSchema(db)` on every engine start. Every table uses
`CREATE TABLE IF NOT EXISTS`, so the call is fully idempotent on an existing database.
This is sufficient while the schema is still evolving and no deployment has user data attached.

Post-release, any schema change (adding a column, adding a table, dropping a column) must be
applied to all existing databases without data loss. A migration system is needed.

---

## Proposed Approach: `PRAGMA user_version`

SQLite has a built-in integer schema-version counter:

```sql
PRAGMA user_version;            -- read current version
PRAGMA user_version = N;        -- set version (integer only)
```

This integer is stored in the database header — no extra table required.

### Migration runner

```typescript
// packages/engine/src/db/migrations.ts

const MIGRATIONS: Array<(db: Db) => void> = [
  // M1 → M2
  (db) => db.exec(`ALTER TABLE request_journal ADD COLUMN batch_id TEXT`),
  // M2 → M3
  (db) => db.exec(`CREATE TABLE IF NOT EXISTS circuit_breaker_events (...)`),
  // future migrations appended here
];

export function runMigrations(db: Db): void {
  const { user_version } = db.get<{ user_version: number }>('PRAGMA user_version')!;
  for (let i = user_version; i < MIGRATIONS.length; i++) {
    MIGRATIONS[i]!(db);
    db.exec(`PRAGMA user_version = ${i + 1}`);
  }
}
```

`runMigrations()` replaces `createSchema()` at engine startup. Each migration function applies
exactly one schema change and advances `user_version` by 1. Migrations are:
- **Idempotent at the runner level** — already-applied migrations are skipped by index
- **Sequential** — each migration assumes all prior migrations have been applied
- **Forward-only** — no down migrations (the transaction log provides rollback for data)

### Numbering

Migrations start at index 0. `user_version` after M0 = 1, after M1 = 2, etc. The final
`user_version` always equals the number of applied migrations.

---

## Schema Changes Allowed Without Migrations

Until a migration is applied, the only safe schema operations are:

| Operation | Safe? | Notes |
|-----------|-------|-------|
| `CREATE TABLE IF NOT EXISTS` | ✅ | Existing databases unaffected |
| `CREATE INDEX IF NOT EXISTS` | ✅ | Existing databases unaffected |
| `ALTER TABLE ... ADD COLUMN` | ✅ via migration | New column must have `DEFAULT` or `NOT NULL` |
| `DROP TABLE` | ❌ | Data loss |
| `DROP COLUMN` | ❌ | Data loss; also not supported on SQLite < 3.35 |
| Rename column | ❌ | Requires migration + data copy |

---

## Rollout Timeline

1. **Before first release**: No migration system. Use `createSchema()` with `IF NOT EXISTS`.
2. **At first release**: Snapshot the complete schema as migration M0. Set `user_version = 1`
   in the initial schema creation.
3. **Post-release changes**: All schema changes via numbered migrations appended to
   `MIGRATIONS` array.

---

## Alternative Considered: Dedicated `schema_migrations` Table

A common pattern (Flyway, Liquibase, Knex, Drizzle Kit) is a `schema_migrations` table
storing applied migration names/checksums. Rejected because:
- SQLite already provides `PRAGMA user_version` built-in with zero overhead
- A migrations table is a dependency on itself (bootstrapping problem)
- Sequential integer indexing is sufficient for a single-process embedded DB

Drizzle Kit was considered in the pre-POC phase and explicitly rejected. See
`plans/engine/GAP_ENGINE_DECISIONS.md §GAP-E10`.
