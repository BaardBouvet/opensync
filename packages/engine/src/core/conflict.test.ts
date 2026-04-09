/**
 * packages/engine/src/core/conflict.test.ts
 *
 * Tests for resolveConflicts() with field mapping extensions.
 * Spec: specs/field-mapping.md §1.4 (normalize), §1.8 (groups)
 * Plans: plans/engine/PLAN_NORMALIZE_NOOP.md, plans/engine/PLAN_FIELD_GROUPS.md
 *
 * N5  Lower-precision source matches normalized canonical → field skipped (not overwritten)
 * N6  Lower-precision source differs beyond precision band → normal resolution applies
 *
 * FG1  Two grouped fields: incoming source wins group → wins both fields
 * FG2  Two grouped fields: existing has higher priority → existing keeps both fields
 * FG3  last_modified: source with higher max-ts wins the whole group (both fields)
 * FG4  last_modified: split winner scenario — whichever source has higher max-ts wins the group
 * FG5  Group field missing from incoming → incoming still wins remaining group fields it provides
 * FG6  Ungrouped field alongside grouped fields → ungrouped resolves independently
 * FG7  Single-field group → behaves the same as ungrouped
 * FG8  New record (no shadow) → all fields accepted
 */
import { describe, it, expect } from "bun:test";
import { resolveConflicts } from "./conflict.js";
import type { FieldData } from "../db/schema.js";
import type { ConflictConfig, FieldMappingList } from "../config/loader.js";

const lww: ConflictConfig = {};

function shadow(fields: Record<string, { val: unknown; src: string; ts: number }>): FieldData {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, v]),
  ) as FieldData;
}

// ─── N5: normalize — lower-precision source matches canonical → skip ──────────

describe("N5: lower-precision source matches normalized canonical — not overwritten", () => {
  it("phone: extra dashes normalized away — field not overwritten", () => {
    const strip = (v: unknown) => String(v).replace(/\D/g, "");
    const fieldMappings: FieldMappingList = [{ target: "phone", normalize: strip }];
    // canonical is the clean version; incoming has formatting, normalized = same
    const existingShadow = shadow({ phone: { val: "5551234567", src: "crm", ts: 100 } });
    const result = resolveConflicts(
      { phone: "(555) 123-4567" },  // lower-fidelity (with formatting)
      existingShadow,
      "erp", 200,                   // newer ts — would win under LWW without normalization
      lww,
      fieldMappings,
    );
    // normalize((555) 123-4567) === normalize(5551234567) → skip, don't overwrite
    expect(result).toEqual({});
  });
});

// ─── N6: normalize — value genuinely differs beyond band → resolves normally ─

describe("N6: value differs beyond normalized band — normal LWW applies", () => {
  it("different phone number still triggers update", () => {
    const strip = (v: unknown) => String(v).replace(/\D/g, "");
    const fieldMappings: FieldMappingList = [{ target: "phone", normalize: strip }];
    const existingShadow = shadow({ phone: { val: "5551234567", src: "crm", ts: 100 } });
    const result = resolveConflicts(
      { phone: "(555) 999-0000" },
      existingShadow,
      "erp", 200,
      lww,
      fieldMappings,
    );
    expect(result).toEqual({ phone: "(555) 999-0000" });
  });
});

// ─── FG1: incoming source wins group → wins both fields ──────────────────────

describe("FG1: incoming wins group — all group fields adopted", () => {
  it("ERP provides newer ts and wins the address group; both street and city taken from ERP", () => {
    const fieldMappings: FieldMappingList = [
      { target: "street", group: "address" },
      { target: "city",   group: "address" },
    ];
    const existingShadow = shadow({
      street: { val: "1 Main St",  src: "crm", ts: 100 },
      city:   { val: "Springfield", src: "crm", ts: 100 },
    });
    const result = resolveConflicts(
      { street: "2 Oak Ave", city: "Shelbyville" },
      existingShadow,
      "erp", 200,   // newer
      lww,
      fieldMappings,
    );
    expect(result).toEqual({ street: "2 Oak Ave", city: "Shelbyville" });
  });
});

// ─── FG2: existing wins group → incoming yields both fields ──────────────────

describe("FG2: existing has higher priority (via connectorPriorities) — incoming yields group", () => {
  it("CRM has lower priority number → CRM wins group, ERP incoming yields both fields", () => {
    const fieldMappings: FieldMappingList = [
      { target: "street", group: "address" },
      { target: "city",   group: "address" },
    ];
    const existingShadow = shadow({
      street: { val: "1 Main St",   src: "crm", ts: 50 },
      city:   { val: "Springfield", src: "crm", ts: 50 },
    });
    const config: ConflictConfig = {
      connectorPriorities: { crm: 1, erp: 2 },
    };
    const result = resolveConflicts(
      { street: "2 Oak Ave", city: "Shelbyville" },
      existingShadow,
      "erp", 200,   // newer ts but lower priority
      config,
      fieldMappings,
    );
    // CRM has priority 1 < ERP priority 2 → CRM wins → ERP incoming discarded
    expect(result).toEqual({});
  });
});

// ─── FG3: LWW group — source with higher max-ts wins whole group ─────────────

describe("FG3: LWW group — source with higher max-ts wins both fields", () => {
  it("ERP has newer max-ts on any group field → ERP wins all group fields", () => {
    const fieldMappings: FieldMappingList = [
      { target: "first", group: "name" },
      { target: "last",  group: "name" },
    ];
    // CRM has ts=300 for 'last' but ts=50 for 'first'; max = 300
    const existingShadow = shadow({
      first: { val: "Alice", src: "crm", ts: 50  },
      last:  { val: "Jones", src: "crm", ts: 300 },
    });
    // ERP incoming ts = 200 < 300 → CRM max-ts (300) beats ERP (200) → CRM keeps the group
    const result = resolveConflicts(
      { first: "Bob", last: "Smith" },
      existingShadow,
      "erp", 200,
      lww,
      fieldMappings,
    );
    expect(result).toEqual({});
  });
});

// ─── FG4: LWW group — split: each field would individually have a different winner ─

describe("FG4: group forces atomic winner even when individual field ts differs", () => {
  it("ERP would win 'first' individually but CRM wins group on max-ts of 'last'", () => {
    const fieldMappings: FieldMappingList = [
      { target: "first", group: "name" },
      { target: "last",  group: "name" },
    ];
    const existingShadow = shadow({
      first: { val: "Alice", src: "crm", ts: 50   },
      last:  { val: "Jones", src: "crm", ts: 1000 },
    });
    // ERP ts=200: individually ERP would win 'first' (200>50) but lose 'last' (200<1000).
    // Group max-ts = 1000 > 200 → CRM keeps the whole group.
    const result = resolveConflicts(
      { first: "Bob", last: "Smith" },
      existingShadow,
      "erp", 200,
      lww,
      fieldMappings,
    );
    expect(result).toEqual({});
  });
});

// ─── FG5: group field missing from incoming ───────────────────────────────────

describe("FG5: group field missing from incoming — fields provided are still governed by group winner", () => {
  it("incoming wins the group but does not include 'zip' — 'zip' not in result", () => {
    const fieldMappings: FieldMappingList = [
      { target: "street", group: "address" },
      { target: "city",   group: "address" },
      { target: "zip",    group: "address" },
    ];
    const existingShadow = shadow({
      street: { val: "1 Main", src: "crm", ts: 50 },
      city:   { val: "Spring", src: "crm", ts: 50 },
      zip:    { val: "12345",  src: "crm", ts: 50 },
    });
    // ERP provides street + city but not zip; ts = 200 > 50 → ERP wins group
    const result = resolveConflicts(
      { street: "2 Oak", city: "Shelby" },
      existingShadow,
      "erp", 200,
      lww,
      fieldMappings,
    );
    // ERP wins group → street and city accepted; zip not in incoming → not in result
    expect(result).toEqual({ street: "2 Oak", city: "Shelby" });
  });
});

// ─── FG6: ungrouped field alongside grouped fields ───────────────────────────

describe("FG6: ungrouped field resolves independently of group outcome", () => {
  it("email resolves independently even when ERP loses the address group", () => {
    const fieldMappings: FieldMappingList = [
      { target: "street", group: "address" },
      { target: "email" },              // no group
    ];
    const existingShadow = shadow({
      street: { val: "1 Main", src: "crm", ts: 500 },
      email:  { val: "old@x.com", src: "crm", ts: 10 },
    });
    // ERP ts=200 loses address group (500>200) but wins email (200>10)
    const result = resolveConflicts(
      { street: "2 Oak", email: "new@x.com" },
      existingShadow,
      "erp", 200,
      lww,
      fieldMappings,
    );
    expect(result).toEqual({ email: "new@x.com" });
  });
});

// ─── FG7: single-field group → same as ungrouped ────────────────────────────

describe("FG7: single-field group behaves identically to ungrouped", () => {
  it("newer ts wins the single-field group", () => {
    const fieldMappings: FieldMappingList = [{ target: "score", group: "score_group" }];
    const existingShadow = shadow({ score: { val: 10, src: "crm", ts: 100 } });
    const result = resolveConflicts({ score: 99 }, existingShadow, "erp", 200, lww, fieldMappings);
    expect(result).toEqual({ score: 99 });
  });

  it("older ts loses the single-field group", () => {
    const fieldMappings: FieldMappingList = [{ target: "score", group: "score_group" }];
    const existingShadow = shadow({ score: { val: 10, src: "crm", ts: 300 } });
    const result = resolveConflicts({ score: 99 }, existingShadow, "erp", 200, lww, fieldMappings);
    expect(result).toEqual({});
  });
});

// ─── FG8: new record — all fields accepted ───────────────────────────────────

describe("FG8: new record (no shadow) — all fields accepted regardless of group", () => {
  it("accepts all fields when targetShadow is undefined", () => {
    const fieldMappings: FieldMappingList = [
      { target: "street", group: "address" },
      { target: "city",   group: "address" },
    ];
    const result = resolveConflicts(
      { street: "2 Oak", city: "Shelby" },
      undefined,
      "erp", 200,
      lww,
      fieldMappings,
    );
    expect(result).toEqual({ street: "2 Oak", city: "Shelby" });
  });
});

// ═══ RS: collect strategy ════════════════════════════════════════════════════
// Spec: specs/field-mapping.md §2.4
// Plans: plans/engine/PLAN_RESOLUTION_STRATEGIES.md §4.1

describe("RS1: collect — first source sets initial scalar", () => {
  it("first source with no shadow: field accepted via fast-path → scalar returned as-is", () => {
    const config: ConflictConfig = {
      fieldStrategies: { tags: { strategy: "collect" } },
    };
    // No existing shadow (first ingest) → fast-path returns incoming unchanged
    const result = resolveConflicts(
      { tags: "vip" },
      undefined,
      "crm", 100,
      config,
    );
    expect(result).toEqual({ tags: "vip" });
  });
});

describe("RS2: collect — second source appends to scalar → array", () => {
  it("second source sends a different value; accumulates into array", () => {
    const config: ConflictConfig = {
      fieldStrategies: { tags: { strategy: "collect" } },
    };
    const existingShadow = shadow({ tags: { val: "vip", src: "crm", ts: 100 } });
    const result = resolveConflicts(
      { tags: "churned" },
      existingShadow,
      "erp", 200,
      config,
    );
    expect(result).toEqual({ tags: ["vip", "churned"] });
  });
});

describe("RS3: collect — duplicate value not re-added", () => {
  it("third source sends same as existing element → array value unchanged (no new element)", () => {
    const config: ConflictConfig = {
      fieldStrategies: { tags: { strategy: "collect" } },
    };
    const existingShadow = shadow({ tags: { val: ["vip", "churned"], src: "crm", ts: 100 } });
    const result = resolveConflicts(
      { tags: "vip" },
      existingShadow,
      "erp", 200,
      config,
    );
    // "vip" already in array — collect returns the existing array (no new element added)
    expect(result).toEqual({ tags: ["vip", "churned"] });
  });
});

describe("RS4: collect — merges unique values from array source", () => {
  it("incoming is an array; unique elements are appended", () => {
    const config: ConflictConfig = {
      fieldStrategies: { tags: { strategy: "collect" } },
    };
    // existing has ["a", "b"], incoming is "c"
    const existingShadow = shadow({ tags: { val: ["a", "b"], src: "crm", ts: 100 } });
    const result = resolveConflicts(
      { tags: "c" },
      existingShadow,
      "erp", 200,
      config,
    );
    expect(result).toEqual({ tags: ["a", "b", "c"] });
  });
});

// ═══ BO: bool_or strategy ════════════════════════════════════════════════════
// Spec: specs/field-mapping.md §2.5
// Plans: plans/engine/PLAN_RESOLUTION_STRATEGIES.md §4.2

describe("BO1: bool_or — first source sends true: accepted", () => {
  it("incoming true accepted when shadow holds false", () => {
    const config: ConflictConfig = {
      fieldStrategies: { deleted: { strategy: "bool_or" } },
    };
    const existingShadow = shadow({ deleted: { val: false, src: "crm", ts: 100 } });
    const result = resolveConflicts({ deleted: true }, existingShadow, "erp", 200, config);
    expect(result).toEqual({ deleted: true });
  });
});

describe("BO2: bool_or — first source sends false (no prior shadow): accepted via fast-path", () => {
  it("first ingest (no shadow) falls through to fast-path", () => {
    const config: ConflictConfig = {
      fieldStrategies: { deleted: { strategy: "bool_or" } },
    };
    const result = resolveConflicts({ deleted: false }, undefined, "erp", 200, config);
    expect(result).toEqual({ deleted: false });
  });
});

describe("BO3: bool_or — existing true, incoming false: no overwrite", () => {
  it("existing shadow = true; incoming false must not overwrite", () => {
    const config: ConflictConfig = {
      fieldStrategies: { deleted: { strategy: "bool_or" } },
    };
    const existingShadow = shadow({ deleted: { val: true, src: "crm", ts: 100 } });
    const result = resolveConflicts({ deleted: false }, existingShadow, "erp", 200, config);
    expect(result).toEqual({});
  });
});

describe("BO4: bool_or — existing false, incoming true: updated to true", () => {
  it("shadow = false → incoming true causes update", () => {
    const config: ConflictConfig = {
      fieldStrategies: { deleted: { strategy: "bool_or" } },
    };
    const existingShadow = shadow({ deleted: { val: false, src: "crm", ts: 100 } });
    const result = resolveConflicts({ deleted: true }, existingShadow, "erp", 200, config);
    expect(result).toEqual({ deleted: true });
  });
});

describe("BO5: bool_or — both false: no change", () => {
  it("existing false, incoming false → no resolved field", () => {
    const config: ConflictConfig = {
      fieldStrategies: { deleted: { strategy: "bool_or" } },
    };
    const existingShadow = shadow({ deleted: { val: false, src: "crm", ts: 100 } });
    const result = resolveConflicts({ deleted: false }, existingShadow, "erp", 200, config);
    expect(result).toEqual({});
  });
});

describe("BO6: bool_or — null shadow, truthy string incoming: updated to true", () => {
  it("shadow = null/undefined, incoming truthy string → resolved to true", () => {
    const config: ConflictConfig = {
      fieldStrategies: { deleted: { strategy: "bool_or" } },
    };
    const existingShadow = shadow({ deleted: { val: null, src: "crm", ts: 100 } });
    const result = resolveConflicts({ deleted: "yes" }, existingShadow, "erp", 200, config);
    expect(result).toEqual({ deleted: true });
  });
});

// ═══ ER: expression resolver (resolve function) ══════════════════════════════
// Spec: specs/field-mapping.md §2.3
// Plans: plans/engine/PLAN_RESOLUTION_STRATEGIES.md §4.3

describe("ER1: resolve — first source sets initial value", () => {
  it("Math.max resolver: first source (no existing) returns incoming value", () => {
    const fieldMappings: FieldMappingList = [
      { target: "score", resolve: (v, acc) => Math.max(Number(v) || 0, Number(acc) || 0) },
    ];
    const result = resolveConflicts({ score: 42 }, undefined, "crm", 100, lww, fieldMappings);
    expect(result).toEqual({ score: 42 });
  });
});

describe("ER2: resolve — second source with higher value wins", () => {
  it("Math.max resolver: incoming 99 > existing 42 → resolved = 99", () => {
    const fieldMappings: FieldMappingList = [
      { target: "score", resolve: (v, acc) => Math.max(Number(v) || 0, Number(acc) || 0) },
    ];
    const existingShadow = shadow({ score: { val: 42, src: "crm", ts: 100 } });
    const result = resolveConflicts({ score: 99 }, existingShadow, "erp", 200, lww, fieldMappings);
    expect(result).toEqual({ score: 99 });
  });
});

describe("ER3: resolve — second source with lower value: existing preserved", () => {
  it("Math.max resolver: incoming 5 < existing 42 → resolver returns 42 (max stays)", () => {
    const fieldMappings: FieldMappingList = [
      { target: "score", resolve: (v, acc) => Math.max(Number(v) || 0, Number(acc) || 0) },
    ];
    const existingShadow = shadow({ score: { val: 42, src: "crm", ts: 100 } });
    const result = resolveConflicts({ score: 5 }, existingShadow, "erp", 200, lww, fieldMappings);
    // resolver returns 42 (max(5,42)); downstream noop check will suppress if shadow is already 42
    expect(result).toEqual({ score: 42 });
  });
});

describe("ER4: resolve — resolver returning undefined produces noop", () => {
  it("resolve returns undefined → field not emitted", () => {
    const fieldMappings: FieldMappingList = [
      { target: "computed", resolve: () => undefined },
    ];
    const existingShadow = shadow({ computed: { val: "old", src: "crm", ts: 100 } });
    const result = resolveConflicts({ computed: "new" }, existingShadow, "erp", 200, lww, fieldMappings);
    expect(result).toEqual({ computed: undefined });
  });
});

describe("ER5: resolve takes precedence over fieldStrategies", () => {
  it("resolve function wins over fieldStrategies collect when both present", () => {
    const fieldMappings: FieldMappingList = [
      { target: "score", resolve: (v, _acc) => String(v).toUpperCase() },
    ];
    const config: ConflictConfig = {
      fieldStrategies: { score: { strategy: "collect" } },
    };
    const existingShadow = shadow({ score: { val: "alpha", src: "crm", ts: 100 } });
    const result = resolveConflicts({ score: "beta" }, existingShadow, "erp", 200, config, fieldMappings);
    // resolve takes precedence → "BETA" (not ["alpha", "beta"])
    expect(result).toEqual({ score: "BETA" });
  });
});

describe("ER6: resolve runs after normalize guard", () => {
  it("normalize guard suppresses resolve when value is precision-equivalent", () => {
    const strip = (v: unknown) => String(v).replace(/\s/g, "");
    const fieldMappings: FieldMappingList = [
      {
        target: "code",
        normalize: strip,
        resolve: (_v, _acc) => "SHOULD_NOT_APPEAR",
      },
    ];
    const existingShadow = shadow({ code: { val: "ABC123", src: "crm", ts: 100 } });
    // Incoming "ABC 123" normalizes to same as existing "ABC123" → noop guard fires before resolve
    const result = resolveConflicts({ code: "ABC 123" }, existingShadow, "erp", 200, lww, fieldMappings);
    expect(result).toEqual({});
  });
});

// ─── Per-field timestamps (FT) ────────────────────────────────────────────────
// Spec: specs/field-mapping.md §7.2

describe("FT1: per-field timestamps — older field loses even in a later batch", () => {
  it("field with lower per-field ts loses LWW against higher shadow ts", () => {
    const existing = shadow({ email: { val: "new@example.com", src: "erp", ts: 2000 } });
    // Incoming has per-field ts of 1000 < shadow ts 2000 — should lose
    const result = resolveConflicts(
      { email: "old@example.com" }, existing, "crm", 9999, lww,
      undefined, { email: 1000 },
    );
    expect(result).toEqual({});
  });
});

describe("FT2: per-field timestamps — newer field wins LWW", () => {
  it("field with higher per-field ts wins even when batch ingestTs is lower", () => {
    const existing = shadow({ email: { val: "old@example.com", src: "erp", ts: 1000 } });
    const result = resolveConflicts(
      { email: "new@example.com" }, existing, "crm", 500, lww,
      undefined, { email: 3000 },
    );
    expect(result).toEqual({ email: "new@example.com" });
  });
});

describe("FT3: per-field timestamps — fields without entry fall back to flat incomingTs", () => {
  it("a field missing from fieldTimestamps uses incomingTs", () => {
    const existing = shadow({
      email: { val: "a@b.com", src: "erp", ts: 100 },
      name: { val: "Old Name", src: "erp", ts: 100 },
    });
    // email has per-field ts=50 (loses), name has no entry → uses incomingTs=200 (wins)
    const result = resolveConflicts(
      { email: "new@b.com", name: "New Name" }, existing, "crm", 200, lww,
      undefined, { email: 50 },
    );
    expect(result).toEqual({ name: "New Name" });
  });
});

describe("FT4: group winner elected by max per-field ts across group fields", () => {
  it("group elected by max per-field ts not flat incomingTs", () => {
    const fieldMappings: FieldMappingList = [
      { target: "first", group: "name" },
      { target: "last", group: "name" },
    ];
    const existing = shadow({
      first: { val: "Alice", src: "erp", ts: 500 },
      last: { val: "Smith", src: "erp", ts: 500 },
    });
    // flat incomingTs=100 < 500 but max(fieldTimestamps)=600 > 500 → incoming wins group
    const result = resolveConflicts(
      { first: "Bob", last: "Jones" }, existing, "crm", 100, lww,
      fieldMappings, { first: 600, last: 200 },
    );
    expect(result).toEqual({ first: "Bob", last: "Jones" });
  });
});

// ─── LWW tie-breaking with createdAt (TB) ────────────────────────────────────
// Spec: specs/field-mapping.md §2.2

describe("TB1: equal ts + both have createdAt → older source (shadow) wins", () => {
  it("shadow wins when its source has an earlier createdAt", () => {
    const existing = shadow({ email: { val: "shadow@b.com", src: "erp", ts: 1000 } });
    const createdAtBySrc = { erp: 100, crm: 500 }; // erp is older
    const result = resolveConflicts(
      { email: "new@b.com" }, existing, "crm", 1000, lww,
      undefined, { email: 1000 }, 500, createdAtBySrc,
    );
    // erp (shadow source) created earlier than crm (incoming) → shadow wins
    expect(result).toEqual({});
  });
});

describe("TB2: equal ts + incoming source has earlier createdAt → incoming wins", () => {
  it("incoming wins when it has an earlier createdAt than the shadow source", () => {
    const existing = shadow({ email: { val: "shadow@b.com", src: "erp", ts: 1000 } });
    const createdAtBySrc = { erp: 500, crm: 100 }; // crm is older
    const result = resolveConflicts(
      { email: "new@b.com" }, existing, "crm", 1000, lww,
      undefined, { email: 1000 }, 100, createdAtBySrc,
    );
    // crm (incoming) created earlier than erp (shadow source) → incoming would normally win
    // but since erp.createdAt > crm.createdAt, shadow does NOT have exCa < inCa, so incoming wins
    expect(result).toEqual({ email: "new@b.com" });
  });
});

describe("TB3: equal ts + no createdAt for either → incoming wins (>= semantics preserved)", () => {
  it("incoming wins on equal ts when neither side has createdAt", () => {
    const existing = shadow({ email: { val: "shadow@b.com", src: "erp", ts: 1000 } });
    const result = resolveConflicts(
      { email: "new@b.com" }, existing, "crm", 1000, lww,
      undefined, { email: 1000 },
    );
    // No createdAt for either → original >= semantics: incoming wins
    expect(result).toEqual({ email: "new@b.com" });
  });
});

// ─── origin_wins strategy (OW) ────────────────────────────────────────────────
// Spec: specs/field-mapping.md §2.N origin_wins

const originWinsConfig: ConflictConfig = { strategy: "origin_wins" };

describe("OW1: origin_wins — incoming has earlier createdAt → incoming wins", () => {
  it("incoming wins when it has an earlier createdAt than the shadow source", () => {
    const existing = shadow({ name: { val: "Old Co", src: "erp", ts: 1000 } });
    const createdAtBySrc = { erp: 500 };
    const result = resolveConflicts(
      { name: "New Co" }, existing, "crm", 2000, originWinsConfig,
      undefined, undefined, 100, createdAtBySrc,
    );
    expect(result).toEqual({ name: "New Co" });
  });
});

describe("OW2: origin_wins — shadow source has earlier createdAt → shadow wins", () => {
  it("existing value preserved when shadow source is the origin", () => {
    const existing = shadow({ name: { val: "Original Co", src: "erp", ts: 1000 } });
    const createdAtBySrc = { erp: 50 };
    const result = resolveConflicts(
      { name: "Overwrite Attempt" }, existing, "crm", 2000, originWinsConfig,
      undefined, undefined, 500, createdAtBySrc,
    );
    expect(result).toEqual({});
  });
});

describe("OW3: origin_wins — incoming has createdAt, shadow source does not → incoming wins", () => {
  it("incoming wins when it has createdAt and shadow source has none", () => {
    const existing = shadow({ name: { val: "Old", src: "erp", ts: 1000 } });
    const createdAtBySrc: Record<string, number> = {}; // no createdAt for erp
    const result = resolveConflicts(
      { name: "New" }, existing, "crm", 500, originWinsConfig,
      undefined, undefined, 100, createdAtBySrc,
    );
    expect(result).toEqual({ name: "New" });
  });
});

describe("OW4: origin_wins — neither has createdAt → falls back to LWW", () => {
  it("falls back to LWW ordering when no createdAt is available", () => {
    const existing = shadow({ name: { val: "Old", src: "erp", ts: 2000 } });
    const result = resolveConflicts(
      { name: "New" }, existing, "crm", 1000, originWinsConfig,
    );
    // incomingTs 1000 < shadow ts 2000 → existing wins
    expect(result).toEqual({});
  });
});

describe("OW5: origin_wins — new record (no shadow) → all fields accepted", () => {
  it("accepts all fields when there is no shadow", () => {
    const result = resolveConflicts(
      { name: "Brand New", email: "a@b.com" }, undefined, "crm", 1000, originWinsConfig,
      undefined, undefined, 100, {},
    );
    expect(result).toEqual({ name: "Brand New", email: "a@b.com" });
  });
});

