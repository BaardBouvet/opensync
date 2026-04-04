# OpenSync — AGENTS.md

> Always-on agent instruction. Read this before writing any code or modifying any spec.
> Cross-tool standard: recognized by GitHub Copilot, Claude, Cursor, and others.

---

## Section 1: Project Overview + Goals

OpenSync is an open-source, developer-friendly, hub-and-spoke bi-directional SaaS sync engine.
Data flows through a central shadow state (SQLite), never directly between systems.

**Primary goals — these cannot be traded away:**
- No data loss, no silent conflicts
- Full reversibility: any sync operation can be rolled back
- Agent-friendly interfaces: clear contracts, predictable structure, minimal surprise

**Key docs:**
- `ESSENCE.md` — plain-language why
- `specs/overview.md` — architecture overview and tech stack
- `specs/sync-engine.md` — canonical engine spec
- `specs/connector-sdk.md` — connector contract
- `ROADMAP.md` — current milestone and exit criteria

---

## Section 2: Workflow — Always Do This

After **any** code change:

```sh
cd /workspaces/opensync
bun run tsc --noEmit        # type-check all packages
bun test                    # run all tests
```

When writing or modifying a connector:

```sh
bun test connectors/<name>/src/index.test.ts
```

When modifying the SDK:

```sh
bun test packages/sdk/
```

**Git discipline:**
- Output git commands for staging and committing but do NOT run `git commit` unless the
  user explicitly says it is fine
- Never create a new branch unless on `main` and the user asks for it
- Never `git push` without explicit user instruction

**Plans discipline:**
- When a plan is completed, update its `Status:` line to `complete` in the plan file itself
- Also update the row in `plans/INDEX.md` with the new status
- If the plan has a corresponding row in `ROADMAP.md`, mark it `done` there too

**Changelog discipline:**
- Add an entry to `CHANGELOG.md` for every feature added or bug fixed
- Format: `## [Unreleased]` section, then `### Added` / `### Fixed` / `### Changed`

**Documentation rules:**
- Docs are informative, not promotional. No superlatives, no sales language.
- Connectors expose raw records. They never perform field mapping, renaming, or
  transformation — that is the engine's job.
- Connectors connect to network services only. Embedded databases (SQLite, LevelDB, etc.)
  run inside the engine process and are inaccessible from a connector. Only
  network-accessible databases (PostgreSQL, MySQL, Redis, etc.) are valid connector targets.

---

## Section 3: Constitution — Never Violate

1. **Connectors are dumb pipes** — raw data in, raw data out. No business logic, no knowledge
   of other systems. Transformations belong in the engine.
2. **The engine is the brain** — all diffing, conflict resolution, circuit breakers, and
   rollback live in the engine, not in connectors.
3. **No direct connector-to-connector writes** — all data flows through shadow state.

### Technical invariants

- TypeScript strict mode everywhere — no `any`, no `// @ts-ignore`
- No `bun:*` imports in engine or SDK source (adapter pattern abstracts the SQLite driver)
- Use global `fetch()` — available in both Bun and Node 18+
- Connectors never import from each other
- **Never hardcode a list of things that can be discovered at runtime.** Use the filesystem
  (`readdirSync`), registry, config, or other authoritative source instead. This applies to
  example names, connector lists, entity lists, migration files, and anything else that changes
  without touching the code that uses it.
- **Keep READMEs concise.** Cover purpose, quick-start, and the non-obvious. Omit long
  prose, exhaustive option tables, and anything self-evident from the code or other docs.
  A good README fits on one screen.
- **No database migration infrastructure before the first public release.** The schema is
  append-only pre-release: modify `packages/engine/src/db/migrations.ts` directly
  (`CREATE TABLE IF NOT EXISTS`). See `plans/engine/PLAN_DB_MIGRATIONS.md` for the post-release plan.
- **No backward compatibility before the first public release.** Interfaces, config shapes,
  and internal contracts can be changed freely. Do not add fallback paths or shims to
  preserve compatibility with pre-release callers — remove the old shape and fix all call
  sites.

---

## Section 4: Method — Spec-Driven Development

### The Rule

No production code is written for a feature that does not have a spec in `specs/`. Write
the spec section first, then the code.

### Before Writing Any Code

1. Check `ROADMAP.md` — is this milestone's exit criteria met? partially met?
2. Find the relevant spec in `specs/` — read the full relevant section
3. If no spec exists, look in `plans/` for a design doc to promote
4. Write code with spec-reference comments on non-trivial logic:
   ```ts
   // Spec: specs/sync-engine.md § Ingest Loop
   ```

### Spec Locations

| Domain | Canonical spec | Rule |
|--------|---------------|------|
| Sync engine | `specs/sync-engine.md` | New engine behaviour → edit the spec directly |
| Connector contract | `specs/connector-sdk.md` | — |
| Safety / circuit breakers | `specs/safety.md` | — |
| All others | `specs/<name>.md` | See `specs/README.md` |

`plans/<topic>/` holds only GAP and REPORT documents — never a parallel design authority.
All plan files must live inside a subfolder (`plans/engine/`, `plans/connectors/`, `plans/poc/`,
`plans/meta/`, etc.). No `.md` files go in the root of `plans/` itself (only `INDEX.md` and
`README.md` are allowed there).

### Spec numbering

Number all items inside spec sections so they can be cited precisely. Use `§N.M` notation:

```
## § 3 Ingest Loop

### § 3.1 Read phase
### § 3.2 Diff phase
```

Plans and code comments cite specs as `specs/sync-engine.md §3.2`. When modifying a spec,
preserve existing numbering and append new numbered items at the end of a section.

---

## Section 5: Module Layout

```
packages/sdk/       — connector SDK types and helpers (no bun:* imports)
packages/engine/    — sync engine
connectors/         — distributable connector implementations (hubspot, kafka, postgres, …)
  <name>/src/index.ts   — the connector (read + write functions only)
  <name>/src/index.test.ts
dev/                — local-only development and test fixtures (never published)
  connectors/       — dev connector packages (jsonfiles, mock-crm, mock-erp)
  servers/          — companion HTTP servers for mock connectors (mock-crm, mock-erp)
demo/               — interactive demo runner and examples
specs/              — canonical specifications (the authority)
plans/              — gap analyses, research, historical rationale
  poc/              — pre-POC design intent documents
  engine/           — gap analyses for the sync engine
  connectors/       — gap analyses for connectors
AGENTS.md           — this file
ESSENCE.md          — plain-language why
ROADMAP.md          — milestones and exit criteria
CHANGELOG.md        — all notable changes
```

---

## Section 6: Code Review Checklist

- [ ] Spec reference comment on non-trivial logic (`// Spec: specs/...`)
- [ ] TypeScript strict — no `any`, no `// @ts-ignore`
- [ ] No `bun:*` imports in engine or SDK source
- [ ] No direct connector-to-connector writes
- [ ] Test covers both success and failure paths
- [ ] `CHANGELOG.md` updated for any feature or fix
- [ ] `ROADMAP.md` exit criteria updated if a milestone checkbox was just completed
