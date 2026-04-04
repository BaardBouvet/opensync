# Spec-Driven Development: Migration Plan

**Status:** `complete — historical`

> Based on analysis of https://github.com/grove/pg-trickle — a project built
> entirely through spec-driven agent development. Sections marked **[pg-trickle]**
> identify specific patterns adopted from their approach.

## The Three Types of Knowledge (and Why They're Currently Mixed)

`plans/` currently holds three distinct things with different lifecycles, and they've been sitting
in the same flat directory:

| Type | Examples in plans/ | Lifecycle |
|------|--------------------|-----------|
| **Pre-spec drafts** | `declarative-connectors.md`, `semantic-sources.md` | Lives until promoted to `specs/` — then deleted |
| **Process records** | `poc-v2.md`–`poc-v7.md`, `gap-report-vs-in-and-out.md`, `lookup-merge-etag.md`, `ts-linting.md` | Permanent record of *why* things are the way they are — never deleted |
| **Already-specced material** | `implementation-plan.md`, `sdk-helpers.md`, `data-access.md`, `agent-assistance.md` | Have a canonical home in `specs/` already — these plans are stale duplicates |

`specs/drafts/` (the previous proposal) is wrong for the second category. Archives and process
logs don't belong in a staging area for specs. Mixing them creates the same confusion in a
different directory.

---

## What pg-trickle Does (and What to Adopt)

pg-trickle is a PostgreSQL extension built entirely with spec-driven agent development —
110+ plan documents, 72,500 lines of design, zero hand-written code. Reading their
structure reveals several things we got wrong in the first draft of this plan.

### Key differences from our initial proposal

**1. `plans/` stays — no `decisions/` directory**

pg-trickle keeps all design material in `plans/`, organized by subdirectory. There is no
separate `decisions/` or `specs/` directory alongside it. The `plans/README.md` defines
document type conventions; `ROADMAP.md` is the master tracker. This is cleaner than
splitting content across two root directories.

**2. Document types are encoded in the filename prefix** `[pg-trickle]`

```
PLAN_<TOPIC>.md   — concrete implementation plan (phases, steps, acceptance criteria)
GAP_<TOPIC>.md    — what is missing relative to a target state or standard
REPORT_<TOPIC>.md — research, options analysis, feasibility; not directly actionable
STATUS_<TOPIC>.md — living progress tracker for an ongoing area
```

The existing OpenSync files in `plans/` don't follow this — they have arbitrary names.
Renaming on significant updates (not retroactively) brings clarity instantly.

**3. `plans/` subfolders by topic, not by document type**

```
plans/
  README.md         ← document conventions (filename prefixes, folder rules)
  INDEX.md          ← full inventory with statuses
  connectors/       ← gap analyses and research about connectors
  engine/           ← gap analyses and research about the engine
  infra/            ← deployment, migration, tooling plans
  testing/          ← test strategy, coverage
  poc/              ← pre-POC design docs (poc-v3.md through poc-v7.md)
```

A GAP analysis about connectors goes in `connectors/`, not a `gaps/` subfolder.

**The rule for `plans/<topic>/`:** only GAP and REPORT documents belong here —
not parallel design specs. Once a domain has a canonical spec in `specs/`, all new
design for that domain goes directly into the spec. A new engine feature is written
into `specs/sync-engine.md`, not into a new `plans/engine/PLAN_*.md`.

The test: ask "is this the *authority* for what the engine does?" → it belongs in
`specs/`. Ask "is this *why* we made a decision, or *what we investigated* before
making it?" → it belongs in `plans/`.

**4. `ROADMAP.md` at root is the master tracker** `[pg-trickle]`

Rather than a `specs/STATUS.md` with a table, pg-trickle uses a detailed `ROADMAP.md`:
- Each milestone has a goal statement, per-item checkboxes, plan file references, and explicit
  **exit criteria** (a checklist that must be fully green before the milestone ships)
- Status per item: `✅ Done`, `⬜ Not started`, `⏭️ Deferred to vX`
- Each item links directly to its plan section: `[PLAN_X.md §Section](plans/path/PLAN_X.md)`

This is far more useful than a STATUS table — it combines the tracker with the release plan.

**5. `AGENTS.md` at root is the agent constitution** `[pg-trickle]`

pg-trickle's `AGENTS.md` is not just an index. It includes:
- Project overview + primary goals (the invariants)
- Workflow section: exact shell commands to run after any code change
- Coding conventions: error handling, unsafe code, memory, logging, SQL functions
- Module layout: what each file does
- Testing tiers and CI trigger matrix
- Code review checklist with checkboxes

This is the equivalent of our proposed `copilot-instructions.md` — but as `AGENTS.md`
at the root (open standard, cross-tool, no VS Code dependency).

**6. `ESSENCE.md` captures the plain-language "why"** `[pg-trickle]`

A short document explaining the project's purpose and philosophy in plain language — not
the technical spec, but the motivation and core design choices readable by anyone.
Different from the constitution (which is directive) — `ESSENCE.md` is descriptive.

---

## New Directory Structure

```
AGENTS.md                   ← always-on: constitution + method + memory [pg-trickle]
ESSENCE.md                  ← plain-language "what and why" [pg-trickle]
ROADMAP.md                  ← master tracker: milestones, exit criteria, plan links [pg-trickle]

specs/
  README.md                 ← updated index
  [all current specs/ files stay exactly where they are]

plans/
  README.md                 ← document conventions: prefixes, folder rules [pg-trickle]
  INDEX.md                  ← full inventory with statuses [pg-trickle]
  engine/
    GAP_IN_VS_OUT.md        ← gap-report-vs-in-and-out.md renamed
    [GAP/REPORT docs only — engine design lives in specs/sync-engine.md]
  connectors/
    PLAN_CONNECTOR_CLEANUP.md  ← connector-cleanup.md renamed
    REPORT_SEMANTIC_SOURCES.md
    REPORT_DECLARATIVE_CONNECTORS.md
    [GAP/REPORT docs only — connector design lives in specs/connector-sdk.md]
  poc/
    PLAN_POC_V3.md          ← poc-v3.md renamed (design intent)
    PLAN_POC_V4.md
    PLAN_POC_V5.md
    PLAN_POC_V6.md
    PLAN_POC_V7.md
    REPORT_JSONFILES_SYNC.md ← jsonfiles-sync-poc.md renamed
  testing/
    [future test plans]
  infra/
    PLAN_OSI_PRIMITIVES.md  ← osi-mapping-primitives.md renamed

poc/
  vN/
    LESSONS.md              ← what the POC validated (add for v3–v6)
```

The `plans/` directory is reorganized (not removed). The `specs/` directory is the
canonical spec home and stays separate.

`plans/` = how we design and decide. `specs/` = what we've decided. `poc/` = experiments.

---

`plans/` is **removed** once migration is complete. The three stale duplicates
(`implementation-plan.md`, `sdk-helpers.md`, `data-access.md`, `agent-assistance.md`) are simply
deleted — their content already lives in `specs/`.

---

## Where "The Process" Is Captured

The process of getting from idea to spec has two parts:

### 1. Before the POC: plans/poc/

A `PLAN_POC_VN.md` file in `plans/poc/` captures:
- The problem the POC is trying to solve
- Design alternatives considered and rejected
- The solution selected and why
- Known unknowns to validate

This is written **before** `poc/vN/` code is written, as the design intent.

### 2. After the POC: poc/vN/LESSONS.md

`LESSONS.md` already exists for v0–v2 and captures:
- What worked and why
- What broke down
- What changed from the original design intent

This is written **after** the POC, closing the loop back to the spec.

### Together: design intent + validation result

```
plans/poc/PLAN_POC_VN.md          ← WHY this POC was designed the way it was
        │
        ▼ (POC is built and run)
poc/vN/LESSONS.md                 ← WHAT we learned
        │
        ▼ (patterns promoted)
specs/<name>.md                   ← WHAT the final answer is
        │
        ▼
ROADMAP.md updated                ← milestone exit criteria checked off [pg-trickle]
```

The spec contains *what* and the key decisions behind it. `ESSENCE.md` captures the
overall *why*. The ROADMAP exit criteria confirm *when it is done*.
An agent reading only the spec can implement correctly. An agent reading the plan
can understand constraints and avoid re-litigating settled questions.

---

## The Lifecycle: Idea → Spec → POC → Code

```
Idea
  │
  ▼
plans/poc/PLAN_POC_VN.md          ← scratchpad, gap analysis, or pre-POC design
  │    ↓ (if POC needed)
  │  poc/vN/ + poc/vN/LESSONS.md
  │
  ▼  [agent: spec-writer]
specs/<name>.md                   ← formal spec. canonical. stable.
  │
  ▼  [agent: implementer]
packages/ or connectors/          ← production code with spec-reference comments
  │
  ▼
ROADMAP.md updated                ← milestone exit criteria checked off
```

Pre-spec scratchpads that never become specs stay in `plans/` forever.
They document considered-but-rejected directions — that's valuable history.

---

## The Agent Instruction: `AGENTS.md` (root level) `[pg-trickle]`

This is the **always-on** workspace instruction. Unlike `.github/copilot-instructions.md`
(VS Code-specific), `AGENTS.md` at root is an open standard recognized across tools.
It contains five sections — not three:

### Section 1: Project Overview + Goals (the invariants)

```markdown
## Project Overview

OpenSync is an open-source, developer-friendly, hub-and-spoke bi-directional SaaS
sync engine. Data flows through a central shadow state (SQLite), never directly
between systems.

**Primary goals:** Field-level traceability, full reversibility, and agent-friendly
interfaces are top priorities. No data loss, no silent conflicts.

Key docs: specs/overview.md · specs/sync-engine.md · specs/safety.md
```

### Section 2: Workflow (commands to always run)

```markdown
## Workflow — Always Do This

After **any** code change:

    cd /workspaces/opensync
    bun run tsc --noEmit        # type-check
    bun test                    # run tests

When writing connectors, run the connector test:

    bun test connectors/<name>/src/index.test.ts

Output git commands for staging and committing. Do not commit unless the user
explicitly says it is fine. Never create a new git branch unless on main.
```

### Section 3: Constitution (the invariants)

The immutable design rules that cannot change without rewriting specs:

```markdown
## Constitution (never violate)

1. Connectors are dumb pipes — no business logic, no CDM. Raw data in, raw data out.
2. The engine is the brain — diffing, conflict resolution, circuit breakers, rollback.
3. Field-level tracking — every field carries { val, prev, ts, src } in shadow state.
4. Full traceability — every HTTP call (request journal) and mutation (transaction log) logged.
5. Safety first — circuit breakers, echo prevention, idempotency are core, not optional.
6. Undo everything — any sync operation can be rolled back: single record, batch, or full.

### Technical invariants
- TypeScript strict mode everywhere
- No `bun:*` imports in engine or SDK source (adapter pattern abstracts the SQLite driver)
- Use global `fetch()` — available in both Bun and Node 18+
- No direct connector-to-connector writes — all data flows through shadow state
- Every record mutation logged to `transaction_log`
```

### Section 4: Method (the spec-driven workflow)

```markdown
## Method: Spec-Driven Development

### The Rule
No code is written for a feature that does not have a spec in `specs/`. POC code in
`poc/` is exploratory and may lead the spec, but must loop back to update a spec.

### Before Writing Any Code
1. Check `ROADMAP.md` — is this milestone's exit criteria met? partially?
2. Find the relevant spec in `specs/` — read the full relevant section
3. If no spec exists, look in `plans/` for a design doc to promote
4. Write code with spec-reference comments:
   // Spec: specs/sync-engine.md § Ingest Loop

### POC Relationship
- Pre-POC design lives in `plans/poc/PLAN_POC_VN.md` (written BEFORE the code)
- `poc/vN/LESSONS.md` documents what was validated (written AFTER the code)
- POC code is NEVER copied directly into `packages/` — re-implemented cleanly
```

### Section 5: Memory Pointers + Code Review Checklist `[pg-trickle]`

```markdown
## Memory: Where to Start
- `ROADMAP.md` — current milestone, exit criteria, plan references
- `specs/README.md` — catalog of all formal specs
- `plans/INDEX.md` — catalog of all design docs with statuses
- `poc/` version map: v0=minimal-2-system, v1=n-way-canonical, v2=field-mapping, v3=content-echo,
  v4=sqlite+circuit-breakers, v5=http+webhooks, v6=oauth+etag, v7=discover+onboard,
  v8=add-connector-live-channel, v9=ingest-first-db-identity (planned)

## Code Review Checklist
- [ ] Spec reference comment present on non-trivial logic
- [ ] TypeScript strict — no `any`, no `// @ts-ignore`
- [ ] No `bun:*` imports outside of `poc/`
- [ ] No direct connector-to-connector writes
- [ ] Every mutation logged to `transaction_log`
- [ ] Test covers both success and failure paths
- [ ] `ROADMAP.md` exit criteria updated if a checkbox was just completed
```

---

## Migration Plan for `plans/`

Each file in `plans/` falls into one of three categories:

### Delete (stale duplicates — canonical version is in `specs/`)
- `implementation-plan.md` → already `specs/plan.md`
- `sdk-helpers.md` → already `specs/sdk-helpers.md`
- `data-access.md` → already `specs/data-access.md`
- `agent-assistance.md` → already `specs/agent-assistance.md`
- `README.md` → replaced by `plans/README.md` (new conventions file)
- `spec-driven-migration.md` → this file; superseded once migration is done

### Rename into `plans/poc/`
Design intent documents (pre-POC designs and POC gap reports):
- `poc-v0.md` → `plans/poc/PLAN_POC_V0.md` (reverse-engineered)
- `poc-v1.md` → `plans/poc/PLAN_POC_V1.md` (reverse-engineered)
- `poc-v2.md` → `plans/poc/PLAN_POC_V2.md`
- `poc-v3.md` → `plans/poc/PLAN_POC_V3.md`
- `poc-v4.md` → `plans/poc/PLAN_POC_V4.md`
- `poc-v5.md` → `plans/poc/PLAN_POC_V5.md`
- `poc-v6.md` → `plans/poc/PLAN_POC_V6.md`
- `poc-v7.md` → `plans/poc/PLAN_POC_V7.md`
- `poc-v8.md` → `plans/poc/PLAN_POC_V8.md`
- `poc-v9.md` → `plans/poc/PLAN_POC_V9.md`
- `jsonfiles-sync-poc.md` → `plans/poc/REPORT_JSONFILES_SYNC.md`

### Rename into `plans/engine/`
Gap analyses — historical context, not design authority (`specs/sync-engine.md` is the authority):
- `gap-report-vs-in-and-out.md` → `plans/engine/GAP_IN_VS_OUT.md`
- `idempotency-and-batch-actions.md` → promote to `specs/` or `plans/engine/PLAN_IDEMPOTENCY_BATCH.md` (review first — may belong in `specs/sync-engine.md`)

### Rename into `plans/connectors/`
Connector-related research and cleanup plans (`specs/connector-sdk.md` is the authority):
- `connector-cleanup.md` → `plans/connectors/PLAN_CONNECTOR_CLEANUP.md`
- `semantic-sources.md` → `plans/connectors/REPORT_SEMANTIC_SOURCES.md`
- `declarative-connectors.md` → `plans/connectors/REPORT_DECLARATIVE_CONNECTORS.md`

### Rename into `plans/infra/`
- `osi-mapping-primitives.md` → `plans/infra/PLAN_OSI_PRIMITIVES.md`

### Delete or fold in
Decision rationale belongs in the relevant spec, not standalone files. Review before deleting:
- `ts-linting.md` → fold relevant decisions into `specs/` or delete
- `lookup-merge-etag.md` → fold relevant content into `specs/sync-engine.md` or delete

### Also: Add missing LESSONS.md files
`poc/v3/` through `poc/v6/` have no `LESSONS.md`. v7 through v9 also need them once implementation settles.
These should be written to close the process loop for each version.

---

## Files to Create

| File | Purpose |
|------|---------|
| `AGENTS.md` | Always-on: constitution + method + memory (open standard) |
| `ESSENCE.md` | Plain-language "what and why" — descriptive, not directive |
| `ROADMAP.md` | Master tracker: milestones, exit criteria, plan file references |
| `plans/README.md` | Document conventions: filename prefixes, folder rules, checklist |
| `plans/INDEX.md` | Full inventory of all plan documents with status |
| `poc/v3/LESSONS.md` | What v3 (content-based echo detection) validated |
| `poc/v4/LESSONS.md` | What v4 (SQLite + circuit breakers) validated |
| `poc/v5/LESSONS.md` | What v5 (HTTP surface + webhooks) validated |
| `poc/v6/LESSONS.md` | What v6 (OAuth + ETag threading) validated |

---

## Where the Engine and Connector Specs Live

This is the explicit answer to "where does the engine spec live over time?":

| Domain | Canonical spec | `plans/` role |
|--------|---------------|---------------|
| Sync engine | `specs/sync-engine.md` | GAP/REPORT docs only — never a parallel design |
| Safety / circuit breakers | `specs/safety.md` | ADRs explaining why specific decisions |
| Rollback | `specs/rollback.md` | Historical context |
| Field mapping | `specs/field-mapping.md` | Pre-spec research if still evolving |
| Connector contract | `specs/connector-sdk.md` | GAP/REPORT/cleanup plans |
| Connector isolation | `specs/connector-isolation.md` | GAP/REPORT docs only |

New engine behaviour → edit `specs/sync-engine.md` directly.
New connector contract change → edit `specs/connector-sdk.md` directly.
`plans/engine/` and `plans/connectors/` grow only with **why/what-we-investigated** documents,
never with new authoritative design.

---

## What Changes for Everyday Development

**Before**: agent writes code by searching around and guessing.

**After**:
1. Read `ROADMAP.md` → understand current milestone and exit criteria
2. Read the relevant spec in `specs/` → `specs/sync-engine.md` for engine, `specs/connector-sdk.md` for connectors
3. If curious about *why* that design: read `plans/` → gap analyses, ADRs, historical rationale
4. Write code with spec-reference comments → traceable to spec
5. Update `ROADMAP.md` exit criteria → progress is visible

