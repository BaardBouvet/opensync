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

const lww: ConflictConfig = { strategy: "lww" };

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
      strategy: "lww",
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
