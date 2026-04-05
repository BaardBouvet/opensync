# PLAN: Remove POC Code

> **Status:** complete — `poc/` removed
> **Date:** 2026-04-04
> **Gate:** Execute when the exit criteria below are met

---

## Why Remove It?

The `poc/` directory (v0–v9, ~1 000 lines per version) was the development laboratory where
the engine design was proven. Now that `packages/engine/` exists and all lessons are
captured elsewhere, the POC code:

- Adds noise to repository searches
- Misleads new contributors into reading obsolete implementations
- Uses `bun:*` imports, old table names, and outdated patterns that conflict with the spec

AGENTS.md §5 already states: "Do not copy poc/ into packages/."

---

## What Each POC Version Contributed

| Version | What it proved | Lesson captured in |
|---------|---------------|-------------------|
| v0 | Basic shadow state + diff algorithm | `specs/sync-engine.md`, `poc/v0/LESSONS.md` |
| v1 | Hub-and-spoke identity map, canonical UUIDs | `specs/identity.md`, `poc/v1/LESSONS.md` |
| v2 | Field-level LWW conflict resolution | `specs/sync-engine.md`, `poc/v2/LESSONS.md` |
| v3 | Declarative connectors, mappings YAML | `specs/connector-sdk.md`, `specs/config.md`, `poc/v3/LESSONS.md` |
| v4 | Circuit breaker, event log, echo prevention | `specs/safety.md`, `poc/v4/LESSONS.md` |
| v5 | Mock CRM server, webhook pipeline | `specs/webhooks.md`, `connectors/mock-crm`, `poc/v5/LESSONS.md` |
| v6 | Mock ERP server, multi-auth patterns | `connectors/mock-erp`, `poc/v6/LESSONS.md` |
| v7 | Discover/onboard pattern, dedup guarantee | `specs/discovery.md`, `poc/v7/LESSONS.md` |
| v8 | Third-connector join, fan-out guard | `specs/discovery.md`, `poc/v8/LESSONS.md` |
| v9 | Live-I/O decoupling, test isolation | `packages/engine`, `poc/v9/LESSONS.md` |

---

## Removal Gate

The POC can be deleted when **all** of the following are true:

1. **Engine tests cover every POC scenario**: `bun test packages/engine/` has explicit tests
   for every distinct scenario in any `poc/*/engine.test.ts`. The tests added in T10–T24
   (discover/onboard/addConnector parity) fulfil this for v9. Earlier POC versions (v0–v8)
   all have their key scenarios subsumed by v9 or already covered in T1–T9.

2. **No active references**: `grep -r "from.*poc/" --include="*.ts"` returns no imports from
   `poc/` in `packages/` or `connectors/`.

**Removed gates (no longer required):**
- ~~LESSONS.md files preserved~~ — lessons are already captured in `plans/poc/GAP_POC_LESSONS.md`
  and `plans/poc/PLAN_CLOSE_POC_GAPS.md`. No further archiving needed.
- ~~Connector helpers implemented~~ — `paginate` and `chunk` from POC v5/v6 can be
  re-implemented properly when building the helpers package. The POC versions are not the
  reference implementation.

---

## Removal Procedure

Once the gate criteria are met:

```sh
# 1. Delete the poc/ directory
git rm -r poc/

# 2. Update AGENTS.md to remove the "poc/" directory entry from the layout section

# 3. Commit
git commit -m "chore: remove poc/ — all lessons captured in specs and engine"
```

---

## What to Preserve Forever

The `openlink.json` files in v3/v4/v5/v6 are example channel config files. They have been
adapted and moved to `demo/examples/`:

- `jsonfiles-two-system.openlink.json` — two-connector jsonfiles config (from v3/v4)
- `jsonfiles-three-system.openlink.json` — three-connector jsonfiles config (from v3/v4)
- `mock-crm-erp.openlink.json` — CRM + ERP two-system config (from v6)

The mock server implementations (`mock-crm-server.ts`, `mock-erp-server.ts`) in v5/v6 were
superseded by the standalone packages in `servers/mock-crm/` and `servers/mock-erp/`. Confirm
those packages contain everything before deleting the POC originals.
