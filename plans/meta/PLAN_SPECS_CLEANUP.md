# Plan: Specs Folder Cleanup

**Status:** complete  
**Date:** 2026-04-11  
**Effort:** L  
**Domain:** meta  
**Scope:** specs/  

---

## Problem

The `specs/` folder has grown organically alongside ten POC iterations and dozens of feature
plans. It now has three interconnected problems:

1. **Unimplemented content.** Several files document features that have never been built
   (`agent-assistance.md`, `data-access.md`) or contain large sections that are explicitly
   "future", "aspirational", or "not started". These sections misrepresent the system to
   anyone using the specs as a reference.

2. **Duplication between files.** Core concepts (YAML config syntax, circuit-breaker states,
   conflict resolution strategies, association FK annotations, schema tables) are described in
   multiple files with no clear authority. This creates contradictions that have already
   propagated (e.g. circuit-breaker state names differ between `safety.md` and
   `sync-engine.md`; `transaction_log` schema is out-of-date in `rollback.md`; `webhook_queue`
   has two incompatible CREATE TABLE statements in `webhooks.md` and `database.md`).

3. **Stale design artefacts.** Several files still contain pre-POC type definitions, class
   designs, and section headings that were superseded but never removed (e.g. the
   `BulkFetcher`/`MatchEngine`/`Linker` section in `discovery.md`; the Backend Architecture,
   Transform Engine, Job Queue, and Pipeline Orchestrator sections in `sync-engine.md`; the
   `entities`/`entity_links` API in `identity.md`).

Total: 25 spec files, ~10 300 lines.  Estimated post-cleanup: ~15 files, ~6 500 lines.

---

## Goals

- Every sentence in every spec file describes something that is implemented and observable.
- Each topic has exactly one canonical file; other files link to it.
- Inconsistencies between files are resolved and a single authoritative version kept.
- The folder structure itself communicates the architecture at a glance.

## Non-goals

- Do *not* document the road ahead (planned features, aspirations, open questions). Those
  belong in `plans/`, not `specs/`.
- Do *not* close any open implementation gaps as part of this plan. This is documentation
  work only.

---

## Spec changes planned

This plan *is* about the specs folder itself. Every change below is a spec change.  
No production code is modified.

---

## Proposed changes

### 1. Delete — files that document nothing implemented

| File | Reason |
|------|--------|
| `specs/agent-assistance.md` | Explicitly "Early draft. Implementation not yet started." Zero engine code calls it. |
| `specs/data-access.md` | Explicitly "Early draft. Implementation not yet started." No HTTP query endpoint exists anywhere. |

Both files' open questions belong as backlog items in `plans/` if desired.

---

### 2. Merge — files whose content belongs inside another file

#### 2a. `webhooks.md` → split into `connector-sdk.md` + `sync-engine.md`

`webhooks.md` has two conceptually distinct parts:

- **Connector contract** (`handleWebhook`, `onEnable`/`onDisable`, signature validation, thin/thick
  webhook normalisation) → move to `connector-sdk.md` under a `§ Webhooks` section.
- **Engine queue processing** (`processWebhookQueue`, `webhook_queue` table) → already partially
  in `sync-engine.md`; consolidate there and remove the duplicate `CREATE TABLE`.
- **Delete** `webhooks.md`.

The unimplemented `checkRegistration`/auto-recovery and webhook-monitoring YAML config sections
(`registration_check_interval_seconds`, `heartbeat_timeout_seconds`) are **not migrated** —
they have no implementation.

#### 2b. `rollback.md` → `sync-engine.md`

`rollback.md` is 117 lines with one distinct concept (undo/transaction-log replay) that is
directly part of the engine's dispatch contract. Migrate the implemented sections:

- Undo levels (`undoBatch`)
- Capability-aware rollback (`UndoResult`)
- Rollback-is-logged rule

Update the stale `transaction_log` schema references (old `entity_link_id`/`target_instance_id`
naming) to match `database.md`'s current `connector_id`/`external_id`/`canonical_id` columns.

**Do not migrate** `rollback --snapshot <id>` — this CLI command does not exist.

**Delete** `rollback.md`.

#### 2c. `connector-helpers.md` → `connector-sdk.md`

`connector-helpers.md` is 208 lines describing the `helpers.*` namespace exported from the SDK.
This is part of the SDK's public surface, not a separate concern. Merge as a `§ Helpers` section
at the end of `connector-sdk.md`.

Remove the "Open Questions" section entirely — four unresolved design decisions have no place in
reference documentation.

**Delete** `connector-helpers.md`.

#### 2d. `connector-isolation.md` → `connector-sdk.md`

The *implemented* constraints in `connector-isolation.md` (no module-level state, `ctx.http`
requirement, `allowedHosts` declaration, no `node:*` imports) belong as a `§ Isolation
Constraints` section in `connector-sdk.md`.

The "Execution Isolation (Future)" section (Deno workers, CPU/memory limits, `vm.Context`) is
**not migrated** — none of it is implemented.

**Delete** `connector-isolation.md`.

#### 2e. `connector-distribution.md` → `connector-sdk.md` (packaging section)

`connector-distribution.md` is 614 lines. Most of the lifecycle and packaging content belongs as
a `§ Packaging & Publishing` section in `connector-sdk.md`:

- Development lifecycle stages (raw TS → workspace link → npm)
- Package naming convention and `package.json` requirements
- Engine resolution (import() semantics; never auto-installs)
- `build` + `bundle` npm scripts
- Security: pin versions, verify provenance
- Monorepo workspace pattern

**Do not migrate**:
- `opensync search` CLI command — not implemented
- Pre-built binary via `bun build --compile` — not confirmed in place
- `opensync.bundle` field for worker isolation — depends on unimplemented worker model

**Delete** `connector-distribution.md`.

---

### 3. Restructure — files to significantly prune

#### 3a. `sync-engine.md` — remove stale pre-POC sections

The following sections were written before the POC series and are now superseded.
They have no corresponding code:

- "Backend Architecture" (`SyncBackend` pluggable interface)
- "Transform Engine" (TypeScript `EntityMapping`/`TransformFn`, `TransformContext`)
- "Old Dispatcher class" (pre-ingest-loop design)
- "Old Sync Channels YAML with `role.master_fields`"
- "Job Queue / JobWorker / Pipeline Orchestrator classes"
- "Scheduling YAML with `interval_seconds`"
- "SQL Expressions as Transform Language" (explicitly deferred)
- "Triple-Level (Graph) Backend" (future RDF backend)

After removals, add the rollback+webhook content from §2a and §2b above.

#### 3b. `discovery.md` — remove stale pre-POC design sections

Remove:
- `BulkFetcher`/`MatchEngine`/`Linker` class definitions (superseded, no code)
- `MatchRule`/`MatchReport` TypeScript types (superseded)
- "LLM-Assisted Matching (Future)" section

Keep: all sections describing the implemented `discover()` / `onboard()` / `addConnector()`
pipeline, union-find matching, `DiscoveryReport`, channel readiness SQL, and deduplication
guarantee.

#### 3c. `identity.md` — remove stale Data Model section

The `IdentityMap` class API and `entities`/`entity_links` table design were the pre-POC schema.
The live schema uses the `identity_map` table with a different shape. Remove the old API class
and table design; keep only what reflects the current `identity_map` table as described in
`database.md`.

Re-number sections after the removal.

#### 3d. `actions.md` — trim to SDK contract only

`ActionDefinition`, `ActionPayload`, `ActionResult`, and the `execute()` streaming contract exist
in the SDK types. The engine never calls `getActions()` or dispatches action payloads. Remove:

- `TriggerEngine` class and `triggers:` YAML config (no implementation)
- Trigger condition operators (`changed_to`, `contains`, etc.)
- Idempotency discussion (applies only to the unimplemented dispatch path)
- "Relationship to Sync" section (describes unimplemented firing)

Keep: SDK-side type definitions (`ActionDefinition`, `ActionPayload`, `ActionResult`, `execute()`
method signature) and the design rationale for why actions are a separate connector type.

Rename to `§ Actions` and consider whether this is a standalone file or absorbs into
`connector-sdk.md`. Given it is a distinct connector type category, keeping it standalone
is defensible — keep as `actions.md` but at ~50 lines.

#### 3e. `field-mapping.md` — remove unimplemented and aspirational sections

Remove:
- §4.2 `references_field` — "requires design work", ❌ in OSI table, no code
- §4.3 Vocabulary targets — "requires design work", ❌ in OSI table, no code
- §7.3 Concurrent edit detection signal — 🔶 data in shadow state but detection not wired;
  the detection plan is in `plans/engine/conflict/PLAN_CONCURRENT_EDIT_DETECTION.md`
- §9 Inline test cases — explicitly "aspirational", no implementation
- Remove the 🔶 entries from the OSI primitive coverage table that correspond to unimplemented
  mapping-level `last_modified` config key (the table row should either be updated to ❌ or
  the feature closed via the `plans/engine/conflict/PLAN_MAPPING_LEVEL_PRIORITY.md` plan first)

The OSI primitive coverage table (§10) is valuable; keep it but update status cells to
reflect current code, not aspirations.

Note: `defaultExpression` is TypeScript API only (no YAML form in config/schema.ts). Add a
single note in the table that its YAML string-expression form is not yet available.

#### 3f. `cli.md` — correct the command list

The CLI binary does not exist yet (`bin/` is absent from all `package.json` files). Options:

- **Option A (preferred):** add a brief preamble: "The CLI is not yet distributed as a binary.
  The commands below document the intended interface; the engine API is the current programmatic
  entry point." Then keep the command spec as the intended design.
- **Option B:** move `cli.md` to `plans/` as a design document. Only valid if we want to signal
  "not yet built" more strongly.

Recommendation: Option A. The CLI design is stable and useful as a reference.

Remove:
- `opensync search` command — not implemented, belongs only in `connector-distribution.md`'s
  packaging section (now moving to `connector-sdk.md`) with a clear "not yet" note
- `opensync rollback --snapshot <id>` — not implemented

Add:
- Note that `opensync add-connector` is referenced in `discovery.md` but absent; align names

#### 3g. `observability.md` — fix circuit-breaker state naming

`observability.md` describes circuit-breaker health as OPERATIONAL / DEGRADED / TRIPPED.
`sync-engine.md` uses CLOSED / OPEN / HALF_OPEN (the standard three-state model).

**Decision:** CLOSED / OPEN / HALF_OPEN is the implementation (`safety/circuit-breaker.ts`).
Update `observability.md` to use the same names.

Remove: "Connectors can opt out per-request by returning a special header (future)" — not
implemented.

#### 3h. `safety.md` — fix circuit-breaker state naming + remove 412 gap text

Same naming fix as above: replace OPERATIONAL / DEGRADED / TRIPPED with CLOSED / OPEN / HALF_OPEN.

The "Known gap from v6" note on the 412 retry loop is honest but belongs in a plan
(`plans/engine/sync-loop/PLAN_LOOKUP_MERGE_ETAG.md` already covers it). Remove the
"known gap" acknowledgement from the spec (specs document what *is*, not what isn't).

Remove: "External Change Pattern Detection (future)" section.

---

### 4. Deduplication — establish single authorities

After the merges above, enforce these single-authority rules and add `→ see X.md` pointers
in files that previously covered the topic:

| Topic | Authority file | Remove from |
|-------|---------------|-------------|
| YAML channel config syntax | `config.md` | `channels.md` (keep only semantic/behavioural description) |
| Conflict resolution strategies | `channels.md` | `field-mapping.md` (already cross-references; turn cross-references into hard links) |
| Field-level YAML key reference table | `config.md` | `field-mapping.md` (keep semantics and examples; remove the reference table duplicate) |
| `entity`/`entity_connector` YAML syntax | `config.md` → link to `associations.md` for semantics | remove from `field-mapping.md` §4.4 (keep a one-sentence cross-ref) |
| Schema tables (CREATE TABLE) | `database.md` | All other files — replace inline CREATE TABLE with a link to `database.md §<table name>` |
| `Ref` type definition | `connector-sdk.md` | `associations.md` (keep a one-line definition and link) |
| `OAuthConfig`/`prepareRequest` types | `connector-sdk.md` | `auth.md` (keep the behavioural description and examples; remove type re-declarations) |
| `ActionDefinition`/`execute()` types | `actions.md` | `connector-sdk.md` (keep only a cross-ref link) |

---

### 5. Database.md — consolidate missing table definitions

The following tables are defined in non-database spec files. Move their `CREATE TABLE`
statements into `database.md` and add a link in the originating file:

| Table | Currently defined in |
|-------|---------------------|
| `dead_letter` | `safety.md` |
| `idempotency_keys` | `safety.md` |
| `no_link` | `identity.md` |
| `deferred_associations` | `associations.md` (implicit, via text) |
| `webhook_queue` | `webhooks.md` (conflicts with partial def in `database.md`) |

Reconcile the `webhook_queue` column-name discrepancy (pick the schema that matches the live
migrations file `packages/engine/src/db/migrations.ts`).

---

### 6. README.md — update index

After the merges and deletions, update `specs/README.md` to reflect:
- Removed files
- Correct section-level pointers for content that moved

---

## Proposed post-cleanup file list (~15 files)

| File | Content |
|------|---------|
| `README.md` | Index + authority table |
| `overview.md` | Architecture, philosophy, tech stack, data flow, key concepts |
| `config.md` | `opensync.json`, channel YAML, all field-level YAML keys (canonical reference) |
| `connector-sdk.md` | Full connector contract: types, read/write/actions/webhooks/isolation/packaging |
| `actions.md` | Action connector type (SDK side only, ~50 lines) |
| `sync-engine.md` | Ingest loop, shadow state, conflict, dispatch, rollback, webhook queue |
| `field-mapping.md` | Mapping pipeline semantics and examples (not the YAML reference table) |
| `channels.md` | Conflict resolution strategies (not the YAML syntax) |
| `associations.md` | Ref type, FK annotations, deferred edge resolution, cross-system remapping |
| `identity.md` | Identity map, union-find matching, split, anti-affinity |
| `discovery.md` | Onboarding pipeline: discover/onboard/addConnector |
| `database.md` | All table schemas, SQLite adapter, key queries |
| `safety.md` | Circuit breakers, echo prevention, idempotency, DLQ, retry |
| `auth.md` | OAuth2, API keys, prepareRequest, credential config |
| `observability.md` | Request journal, structured logging, introspection SQL |
| `webhooks.md` | → **deleted** (absorbed into `connector-sdk.md` + `sync-engine.md`) |
| `rollback.md` | → **deleted** (absorbed into `sync-engine.md`) |
| `connector-helpers.md` | → **deleted** (absorbed into `connector-sdk.md`) |
| `connector-isolation.md` | → **deleted** (absorbed into `connector-sdk.md`) |
| `connector-distribution.md` | → **deleted** (absorbed into `connector-sdk.md`) |
| `agent-assistance.md` | → **deleted** |
| `data-access.md` | → **deleted** |
| `cli.md` | Keep as interface design document (see §3f) |
| `demo.md` | Keep (remove §4 "field mapping showcase — planned") |
| `playground.md` | Keep (remove aspirational update-notification details) |

---

## Execution order

1. Fix the two cross-spec inconsistencies first (circuit-breaker state names, transaction_log
   column names). These are low-risk one-line fixes that unblock everything else.
2. Consolidate all `CREATE TABLE` into `database.md`.
3. Perform the five merges (§2a–§2e) — large files first (connector-sdk.md absorbs four
   files worth of content).
4. Prune the stale sections (§3a–§3h).
5. Apply the deduplication authority table (§4) — add cross-ref links, remove duplicates.
6. Delete the seven files.
7. Update `specs/README.md`.
8. Update `plans/INDEX.md`.
9. Run `bun run tsc --noEmit && bun test --timeout 10000` — specs-only changes should produce
   zero test failures.
