# PLAN_DEMO_ENHANCEMENTS.md

**Status:** complete (see addendum below for follow-on changes)  
**Date:** 2026-04-05  

Four targeted improvements to the demo experience and the jsonfiles dev connector:

1. **Optional watermark** — jsonfiles reads the whole file anyway; `updatedAt` should not be required in seed data
2. **Nested object format** — `{ id, data, updatedAt, associations }` per record; no underscore-prefixed magic fields
3. **`associations-demo` example** — three systems, two entities (company + contact), associations, field renames
4. **Engine state inspection** — on-demand way to inspect the engine's internal SQLite tables (`identity_map`, `shadow_state`, etc.) rather than continuous stdout noise

Items 1 and 2 share the same connector and seed files; implement them together. Item 3 depends on item 2. Item 4 is independent.

---

## Spec changes planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `specs/demo.md` | §2.2 | Update seed format example to nested `{ id, data, updatedAt, associations }` |
| `specs/demo.md` | §2.2 | Note that `updatedAt` is optional; records without it are always included in a read |
| `specs/demo.md` | new §3 | Describe the `associations-demo` example: layout, field renames, association wiring |
| `specs/demo.md` | new §4 | Describe the `inspect.ts` CLI and its table arguments (option A), or `--snapshot` flag (option B) |

No changes required to `specs/connector-sdk.md` or `specs/associations.md` — the SDK contract already treats watermarks and associations as optional.

---

## 1. Optional watermark in jsonfiles

**Context:** The jsonfiles connector reads the entire file on every poll; the `_updatedAt` watermark is only applied as a post-read filter. This means:
- Seed data must include `_updatedAt` even though it adds noise for authors
- Systems that don't track modification times cannot use the fixture without inventing dummy timestamps

**Change:** The watermark field is optional per record. When a record lacks it, the record is always included in the read output regardless of `since`. The `since` filter only applies to records that carry the watermark field.

```typescript
// Before
records.filter(r => typeof r[watermarkField] === "string" && r[watermarkField] > since)

// After
records.filter(r => {
  const w = r[watermarkField];
  return typeof w !== "string" || w > since;  // no watermark → always include
})
```

**Alternative: integer sequence watermark**

Instead of an ISO 8601 timestamp, `updatedAt` can be a monotonically increasing integer (e.g. `1`, `2`, `3`). This is easier to set and bump by hand in a text editor during testing — increment a number rather than copy-paste a timestamp. The trade-off: integer sequences are local to each file; there is no meaningful ordering across different entities or connectors (you cannot ask "give me everything changed after epoch T across all entities"), whereas ISO timestamps are globally comparable. For the jsonfiles fixture — where each file is polled independently and cross-entity time ordering is not needed — integers are a reasonable default for hand-edited fixtures.

Implementation note: the filter predicate must handle both string and number watermark values. The `since` parameter arrives from the engine as a string (the engine stores watermarks opaquely), so the connector must coerce consistently — either always store and compare as strings, or detect the type and coerce both sides to numbers before comparing. Decide and document the chosen approach before implementing.

**Affected files:**
- `dev/connectors/jsonfiles/src/index.ts` — update `since` filter predicate
- `dev/connectors/jsonfiles/src/index.ts` — remove `required: true` from watermark field schema entry
- Seed data files — `updatedAt` can be omitted once item 2 is also applied

---

## 2. Nested object format for jsonfiles

**Context:** The current flat format uses underscore-prefixed reserved field names (`_id`, `_updatedAt`, `_associations`) to avoid collision with record data fields. This is awkward for fixture authors and makes seed files harder to read.

**Proposed format:**

```json
[
  {
    "id": "c1",
    "data": { "name": "Acme Corp", "domain": "acme.com" }
  },
  {
    "id": "a1",
    "data": { "firstName": "Alice", "email": "alice@example.com", "companyId": "c1" },
    "updatedAt": "2025-01-01T00:00:00.000Z",
    "associations": [
      { "predicate": "companyId", "targetEntity": "company", "targetId": "c1" }
    ]
  }
]
```

Fields:
- `id` — required; the external identity key for this record
- `data` — required; the record's payload (maps directly to `ReadRecord.data`)
- `updatedAt` — optional (see item 1)
- `associations` — optional; pre-declared edges to other entities

**Default field config values change:**

| Key | Old default | New default |
|-----|-------------|-------------|
| `idField` | `"_id"` | `"id"` |
| `watermarkField` | `"_updatedAt"` | `"updatedAt"` |
| `associationsField` | `"_associations"` | `"associations"` |
| `dataField` | *(n/a — was flat)* | `"data"` |

**Connector changes:**
- `FileRecord` interface gains a typed `data` sub-object and top-level `id`, `updatedAt`, `associations`
- `extractRecord` reads `r.data` directly instead of filtering keys from a flat object
- `insert`/`update` handlers write the nested format when writing back
- Schema entry for `dataField` replaces the previous flat field schema — or schema is simplified since data field names are no longer known at connector level
- All existing seed files reformatted

**Backward compatibility:** None required (pre-release — AGENTS.md §3 constitution).

**Affected files:**
- `dev/connectors/jsonfiles/src/index.ts` — all read/write paths
- `demo/examples/two-system/seed/**/*.json`
- `demo/examples/three-system/seed/**/*.json`
- `demo/examples/mock-crm-erp/seed/**/*.json` (if applicable)
- `specs/demo.md §2.2` — update seed format

---

## 3. `associations-demo` example

**Context:** No existing example shows associations or field renames. The three-system example syncs contacts only, with identical field names across all three connectors. A more realistic fixture is needed to demonstrate the full mapping pipeline.

**Example name:** `associations-demo`

**Layout:**

```
demo/examples/associations-demo/
  opensync.json
  mappings/
    companies.yaml
    contacts.yaml
  seed/
    crm/
      companies.json
      contacts.json
    erp/
      accounts.json
      employees.json
    hr/
      orgs.json
      people.json
  README.md
```

**Three systems:**

| Connector | Company entity | Contact entity |
|-----------|---------------|----------------|
| `crm` | `companies` | `contacts` |
| `erp` | `accounts` | `employees` |
| `hr` | `orgs` | `people` |

**Canonical field names (defined in channel mappings):**

| Canonical | crm | erp | hr |
|-----------|-----|-----|----|
| *companies channel* | | | |
| `name` | `name` | `accountName` | `orgName` |
| `domain` | `domain` | `website` | `site` |
| *contacts channel* | | | |
| `name` | `name` | `fullName` | `displayName` |
| `email` | `email` | `email` | `email` |
| `companyId` | `companyId` | `orgId` | `orgRef` |

**Associations:** Each contact record in each system declares an association linking `companyId`/`orgId`/`orgRef` to the `company` entity. The engine resolves these cross-system references via the identity map.

**companies channel** (`dependsOn` is empty — synced first):

```yaml
channels:
  - id: companies
    identityFields:
      - domain

mappings:
  - connector: crm
    entity: companies
    channel: companies
    fields:
      - { source: name,   target: name }
      - { source: domain, target: domain }
  - connector: erp
    entity: accounts
    channel: companies
    fields:
      - { source: accountName, target: name }
      - { source: website,     target: domain }
  - connector: hr
    entity: orgs
    channel: companies
    fields:
      - { source: orgName, target: name }
      - { source: site,    target: domain }
```

**contacts channel** (`contacts.yaml` lists `dependsOn: [companies]` at entity level or via channel ordering):

```yaml
channels:
  - id: contacts
    identityFields:
      - email

mappings:
  - connector: crm
    entity: contacts
    channel: contacts
    fields:
      - { source: name,      target: name }
      - { source: email,     target: email }
      - { source: companyId, target: companyId }
  - connector: erp
    entity: employees
    channel: contacts
    fields:
      - { source: fullName, target: name }
      - { source: email,    target: email }
      - { source: orgId,    target: companyId }
  - connector: hr
    entity: people
    channel: contacts
    fields:
      - { source: displayName, target: name }
      - { source: email,       target: email }
      - { source: orgRef,      target: companyId }
```

**Seed data:** Three companies and three contacts per system, partially overlapping by `domain`/`email` so that discover + onboard produces both matched and unique records.

**Spec changes:** `specs/demo.md` — new §3 describing the example.

---

## 4. Engine state inspection

**Context:** The demo runner logs individual record events (INSERT/UPDATE/DELETE) but gives no view of the engine's internal tables — `identity_map`, `shadow_state`, `watermarks`, `transaction_log`, etc. These are stored in `demo/data/<name>/state.db` (SQLite). The JSON data files are easy to inspect directly; the SQLite state is not.

Printing internal state as part of the poll loop (e.g. a `--show-tables` flag) would be too noisy — the tables are wide, and most poll cycles produce no changes. The useful question is "what does the engine know right now?", asked on demand rather than continuously.

Three approaches follow in increasing complexity / scope. Choose one (or combine A + B).

---

### Option A — `bun run demo/inspect.ts` CLI script

A dedicated script that opens `demo/data/<name>/state.db` and prints selected tables as ASCII tables to stdout. Invoked on demand; the demo runner keeps running in parallel in another terminal.

```sh
bun run demo/inspect.ts -d <example-name>           # all tables
bun run demo/inspect.ts -d <example-name> identity  # identity_map only
bun run demo/inspect.ts -d <example-name> shadow    # shadow_state only
bun run demo/inspect.ts -d <example-name> log       # last 20 transaction_log rows
```

Tables to show:

| Argument | SQLite table | Columns shown |
|----------|-------------|---------------|
| `identity` | `identity_map` | `canonical_id` (short), `connector_id`, `external_id` |
| `shadow` | `shadow_state` | `connector_id`, `entity_name`, `external_id`, `canonical_data` (truncated JSON) |
| `watermarks` | `watermarks` | `connector_id`, `entity_name`, `since` |
| `log` | `transaction_log` | `synced_at`, `connector_id`, `entity_name`, `action`, `external_id`, `canonical_id` (short) |

**Pros:** Zero impact on the demo runner. Composable with `watch` (`watch -n2 bun run demo/inspect.ts -d two-system identity`). Small, focused script with no new dependencies.

**Cons:** Requires opening a second terminal. Must be re-run manually (or via `watch`).

**Affected files:**
- `demo/inspect.ts` — new script (~80 lines)
- `specs/demo.md` — new §4 documenting the script and its arguments

---

### Option B — `--snapshot` flag on the demo runner

At the end of each poll cycle that produced at least one non-skip result, write a `demo/data/<name>/snapshot/` directory of JSON files — one per table. Files are overwritten in place, so there is no churn in git (they are already gitignored via `demo/data/`). Can be opened in any editor or diffed with the previous snapshot.

```
demo/data/<name>/snapshot/
  identity_map.json
  shadow_state.json
  watermarks.json
  transaction_log.json   ← last 50 rows only
```

This is the "dump to folder" approach from the old POC, but scoped to the engine's internal state rather than the raw data files, and only written when something changed.

**Pros:** Passive — no second terminal needed. Files can be opened in VS Code JSON viewer with formatting. Easy to diff between two points in time using git or any diff tool.

**Cons:** Still creates file churn if changes are frequent. Not interactive. Large `canonical_data` blobs in `shadow_state` make the file hard to read without formatting.

**Affected files:**
- `demo/run.ts` — add `--snapshot` flag and `writeSnapshot()` helper
- `specs/demo.md` — document the flag and snapshot directory layout

---

### Option C — Combination: `--snapshot` always on + `inspect.ts` for interactive queries

Always write snapshots on change (option B, no flag needed), and provide `inspect.ts` (option A) for on-demand formatted output. The snapshot files act as a cheap audit trail; the inspect script gives a readable view on demand.

**Recommendation:** Start with **option A** (`inspect.ts`). It requires no changes to `run.ts`, has no runtime cost, and covers the main use-case (understanding what the engine knows after a sync run). Add option B later if file-based diffing proves useful in practice.

**Affected files (option A only):**
- `demo/inspect.ts` — new script
- `specs/demo.md` — new §4

---

## Implementation order

1. **Items 1 + 2** — jsonfiles format (optional watermark + nested object). Update connector, update all seed files, update spec.
2. **Item 3** — `associations-demo` example. Depends on the new seed format from item 2.
3. **Item 4** — engine state inspection (`inspect.ts` script). Independent. Can be done in parallel with any step.

---

## Exit criteria

- [ ] `bun run tsc --noEmit` passes across all packages
- [ ] `bun test dev/connectors/jsonfiles/` passes with new format
- [ ] `bun run demo/run.ts -d two-system` works with updated seed
- [ ] `bun run demo/run.ts -d associations-demo` shows three systems, field renames, associations in output
- [ ] `bun run demo/inspect.ts -d associations-demo` (or equivalent) prints engine internal tables from SQLite
- [ ] `specs/demo.md` updated: seed format, `associations-demo` description, engine state inspection docs

---

## Addendum — follow-on jsonfiles refinements

Three additional changes agreed after the initial implementation.

### A1. `updatedAt` → `updated`

Rename the default watermark field from `updatedAt` to `updated`. Shorter, reads naturally with both timestamps and integers (`"updated": 3`). The `watermarkField` config option is unchanged; only the default value changes.

### A2. Integer watermark: `max + 1` on writes

Currently `insert` and `update` always write `new Date().toISOString()` as the watermark, regardless of the existing values in the file. This is wrong when the file uses integer sequence watermarks — the engine will store the ISO string as `since`, and the next comparison against an integer fails.

Fix: inspect all existing records' watermark values before writing. If all present values are numbers (or the file is empty), write `max + 1` where `max` is the highest existing watermark (default 0 on empty). If any existing value is a string, keep writing ISO timestamps (already-ISO file). This autodetects the mode already established in the file.

### A3. `associations-demo` seeds: use integer `updated`

Replace the seed files in `demo/examples/associations-demo/seed/` with records carrying `"updated": 1`. Also fix all other seed files to use `updated` (renamed from `updatedAt`). This exercises the integer watermark path end-to-end in the most visible demo and makes the seed easier to edit during testing.

**Spec changes planned:** `specs/demo.md §2.2` — update seed format example to show `updated` field name.

**Affected files:**
- `dev/connectors/jsonfiles/src/index.ts` — `DEFAULT_WATERMARK_FIELD`, insert/update watermark write logic
- `dev/connectors/jsonfiles/src/index.test.ts` — update field name references and watermark write tests
- `packages/engine/src/onboarding.test.ts` — update seed helpers
- `demo/examples/*/seed/**/*.json` — rename `updatedAt` → `updated`, add integer watermarks to associations-demo seeds
- `specs/demo.md §2.2` — update seed format example
