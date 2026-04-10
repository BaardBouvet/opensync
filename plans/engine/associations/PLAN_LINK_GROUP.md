# Engine: `link_group` Coverage (Composite Identity Keys)

**Status:** complete  
**Date:** 2026-04-07  
**Effort:** XS  
**Domain:** Engine — identity / matching  
**Scope:** `packages/engine/src/config/schema.ts`, `packages/engine/src/config/loader.ts`, `packages/engine/src/transitive-identity.test.ts`, `specs/identity.md`, `specs/field-mapping.md`, `plans/engine/GAP_OSI_PRIMITIVES.md`  
**Depends on:** `PLAN_TRANSITIVE_CLOSURE_IDENTITY.md` (complete)  
**See also:** `plans/engine/GAP_OSI_PRIMITIVES.md §2`, `specs/identity.md § Compound Identity Groups`  

---

## § 1 Problem Statement

The OSI-mapping `link_group` primitive groups identity fields into compound match keys with
AND-within-group / OR-across-groups semantics: a record satisfies a group only when **all**
fields in that group are present and non-empty; satisfying **any** group is sufficient to link
two records.

`plans/engine/GAP_OSI_PRIMITIVES.md §2` (Composite keys) was written before the compound
identity group work landed. It still reads 🔶 with the note "the named-group tuple strictness
is not yet modelled in config". This is stale — `identityGroups` was shipped as part of
`PLAN_TRANSITIVE_CLOSURE_IDENTITY.md §2.5` and fully covers the `link_group` semantic.

---

## § 2 Coverage Mapping

| OSI-mapping concept | OpenSync equivalent | Location |
|---------------------|--------------------|-|
| Single identity field (`identity` strategy on one field) | `identityFields: [fieldName]` on channel | `specs/config.md`, `specs/identity.md §Field-Value-Based Matching` |
| Compound match key — AND all fields | One `identityGroups` entry with multiple `fields` | `specs/identity.md §Compound Identity Groups` |
| Multiple groups — OR across groups | Multiple `identityGroups` entries | same |
| Blank-field exclusion | Fields absent or empty after `toLowerCase().trim()` do not participate in the group | `specs/identity.md §Compound Identity Groups` |
| Transitive closure across groups | Union-find bridges groups transitively | `specs/identity.md §Transitive Closure` |

**Config example — exact equivalent of a two-group `link_group` declaration:**

```yaml
channels:
  - id: contacts
    identityGroups:
      - fields: [email]                         # group 1: email alone
      - fields: [firstName, lastName, dob]      # group 2: all three must match
```

Records matching on email (group 1) are linked; records matching on firstName + lastName + dob
(group 2) are also linked; if A matches B via group 1 and B matches C via group 2, transitive
closure links A = B = C.

---

## § 3 Implementation State

All work is already done. No code changes required.

| Component | State | Reference |
|-----------|-------|-----------|
| `IdentityGroupSchema` (Zod schema) | ✅ implemented | `packages/engine/src/config/schema.ts` line ~30 |
| `identityGroups` field on `ChannelConfig` | ✅ implemented | `packages/engine/src/config/loader.ts` line ~145 |
| Compound group matching in `_buildIdentityEdges` | ✅ implemented | `packages/engine/src/transitive-identity.ts` |
| `identityGroups` takes precedence over `identityFields` when both present | ✅ implemented | `specs/identity.md §Compound Identity Groups` |
| Tests T-LG-1 — no partial match | ✅ passing | `transitive-identity.test.ts` line ~312 |
| Tests T-LG-2 — compound group + transitive | ✅ passing | `transitive-identity.test.ts` line ~350 |
| Tests T-LG-3 — compound group at `_resolveCanonical` ingest time | ✅ passing | `transitive-identity.test.ts` line ~401 |
| Tests T-LG-4 — precedence over `identityFields` | ✅ passing | `transitive-identity.test.ts` line ~442 |

---

## § 4 Spec Changes Planned

| Spec file | Section | Change |
|-----------|---------|--------|
| `plans/engine/GAP_OSI_PRIMITIVES.md` | §2 Composite keys (`link_group`) | Update Foundation from 🔶 to ✅; replace stale body text with pointer to `identityGroups` |
| `specs/field-mapping.md` | §10 coverage table row | Update status from 🔶 to ✅ |

---

## § 5 Residual Difference (Not a Gap)

One deliberate difference from OSI-mapping's config model: in OSI-mapping, `link_group` may
vary per mapping entry (per source connector). In OpenSync, `identityGroups` is declared at
channel level — all connectors in the channel share the same match groups. This is intentional:
identity is a property of the entity type, not of individual sources. Per-source group overrides
are not a planned feature.
