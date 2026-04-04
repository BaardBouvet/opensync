# plans/ — Document Conventions

This directory holds design history, gap analyses, research reports, and POC design intent.
It is **not** a staging area for specs. Specs live in `specs/`.

## The rule

- `specs/<name>.md` — the **authority** for what OpenSync does. New behaviour goes here.
- `plans/<topic>/` — **why** decisions were made and **what was investigated**. Never a parallel authority.

Ask: *"Is this the authority for what the engine does?"* → `specs/`.  
Ask: *"Is this why we made a decision, or what we investigated before making it?"* → `plans/`.

## Filename prefix conventions

| Prefix | Use for |
|--------|---------|
| `PLAN_` | Concrete implementation plan with phases, steps, acceptance criteria |
| `GAP_` | What is missing relative to a target state or standard |
| `REPORT_` | Research, options analysis, feasibility — not directly actionable |
| `STATUS_` | Living progress tracker for an ongoing area |

ADRs are not maintained separately. Decision rationale lives in the relevant spec section
or in `ESSENCE.md` for project-wide design choices.

## Subdirectory structure

| Directory | Contains |
|-----------|----------|
| `poc/` | Pre-POC design intent documents (`PLAN_POC_VN.md`) |
| `engine/` | Gap analyses and research about the sync engine |
| `connectors/` | Gap analyses and research about connectors |
| `infra/` | Deployment, tooling, and infrastructure plans |
| `testing/` | Test strategy and coverage plans |

## Historical document policy

Plans are a permanent record of how decisions were made. **Do not delete plans once they
are complete.** A completed plan explains *why* code was written the way it was — that
explanation is still valuable when the code changes.

The only plans that may be deleted are those that are exact duplicates of a spec section
(i.e. the spec absorbed the full content and the plan adds nothing new).

## Checklist for new documents

Before creating a new file in `plans/`:

- [ ] Does a spec in `specs/` already cover this? If yes, edit the spec instead.
- [ ] Is this a design decision or rationale? If yes, add it to the relevant spec section.
- [ ] Does the filename use the correct prefix (`PLAN_`, `GAP_`, `REPORT_`, `STATUS_`)?
- [ ] Is this in the right subdirectory (by topic, not by document type)?
- [ ] Is `plans/INDEX.md` updated?

