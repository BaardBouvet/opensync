/**
 * packages/engine/src/core/mapping.test.ts
 *
 * Tests for applyMapping() with expression / reverseExpression support.
 * Spec: specs/field-mapping.md §1.3
 * Plan: plans/engine/PLAN_FIELD_EXPRESSIONS.md
 *
 * FE1  Plain rename still works (no regression)
 * FE2  forward expression overrides source-key lookup
 * FE3  reverseExpression scalar → assigns to source ?? target
 * FE4  reverseExpression object → decomposed into multiple source keys
 * FE5  direction: forward_only + expression → no reverse output
 * FE6  direction: reverse_only + reverseExpression → no forward output
 * FE7  expression + plain-rename entries in same mapping list coexist
 * FE8  enum mapping: expression (bool→string) + reverseExpression (string→bool)
 * FE9  expression receives full record (can reference multiple fields)
 * AT1  element_fields: inbound renames per-element fields (Spec: §3.5)
 * AT2  element_fields: outbound reverses per-element renames (Spec: §3.5)
 * AT3  element_fields: nested (self-referential) element_fields (Spec: §3.5)
 * AT4  element_fields: non-array value passes through unchanged (Spec: §3.5)
 * AT5  applyMapping integrates element_fields automatically (Spec: §3.5)
 */
import { describe, it, expect } from "bun:test";
import { applyMapping, applyElementFields, parseTs, computeFieldTimestamps } from "./mapping.js";
import type { FieldMappingList } from "../config/loader.js";
import type { FieldData } from "../db/schema.js";
import type { ReadRecord } from "@opensync/sdk";

// ─── FE1: plain rename regression ────────────────────────────────────────────

describe("FE1: plain rename works unchanged", () => {
  it("inbound rename", () => {
    const mappings: FieldMappingList = [{ source: "first_name", target: "firstName" }];
    expect(applyMapping({ first_name: "Alice" }, mappings, "inbound")).toEqual({ firstName: "Alice" });
  });
  it("outbound rename", () => {
    const mappings: FieldMappingList = [{ source: "first_name", target: "firstName" }];
    expect(applyMapping({ firstName: "Alice" }, mappings, "outbound")).toEqual({ first_name: "Alice" });
  });
});

// ─── FE2: forward expression overrides source key lookup ────────────────────

describe("FE2: forward expression overrides source key", () => {
  it("email normalise", () => {
    const mappings: FieldMappingList = [{
      source: "email",
      target: "email",
      expression: (r) => typeof r["email"] === "string" ? r["email"].toLowerCase() : r["email"],
    }];
    expect(applyMapping({ email: "BOB@EXAMPLE.COM" }, mappings, "inbound")).toEqual({ email: "bob@example.com" });
  });

  it("expression ignores missing source field gracefully", () => {
    const mappings: FieldMappingList = [{
      target: "upper",
      expression: (r) => typeof r["name"] === "string" ? r["name"].toUpperCase() : null,
    }];
    expect(applyMapping({ name: "alice" }, mappings, "inbound")).toEqual({ upper: "ALICE" });
  });
});

// ─── FE3: reverseExpression scalar assignment ─────────────────────────────────

describe("FE3: reverseExpression scalar → assigned to source ?? target", () => {
  it("assigns to source key when source is declared", () => {
    const mappings: FieldMappingList = [{
      source: "is_active",
      target: "status",
      reverseExpression: (r) => r["status"] === "active",
    }];
    // canonical record has status="active"; should write is_active=true to source
    expect(applyMapping({ status: "active" }, mappings, "outbound")).toEqual({ is_active: true });
    expect(applyMapping({ status: "inactive" }, mappings, "outbound")).toEqual({ is_active: false });
  });

  it("assigns to target key when source is absent", () => {
    const mappings: FieldMappingList = [{
      target: "score",
      reverseExpression: (r) => Number(r["score"]) * 100,
    }];
    expect(applyMapping({ score: 0.9 }, mappings, "outbound")).toEqual({ score: 90 });
  });
});

// ─── FE4: reverseExpression object → decomposition ──────────────────────────

describe("FE4: reverseExpression object decomposition", () => {
  it("splits fullName back into firstName + lastName", () => {
    const mappings: FieldMappingList = [{
      target: "fullName",
      direction: "forward_only",
      expression: (r) => `${r["firstName"]} ${r["lastName"]}`,
      reverseExpression: (r) => ({
        firstName: String(r["fullName"] ?? "").split(" ")[0] ?? "",
        lastName:  String(r["fullName"] ?? "").split(" ").slice(1).join(" "),
      }),
    }];
    // Outbound pass: fullName → {firstName, lastName}
    const result = applyMapping({ fullName: "Alice Smith" }, mappings, "outbound");
    expect(result).toEqual({ firstName: "Alice", lastName: "Smith" });
  });

  it("merges decomposed fields alongside other plain renames", () => {
    const mappings: FieldMappingList = [
      { source: "email_addr", target: "email" },
      {
        target: "fullName",
        direction: "forward_only",
        reverseExpression: (r) => ({
          first_name: String(r["fullName"] ?? "").split(" ")[0] ?? "",
          last_name:  String(r["fullName"] ?? "").split(" ").slice(1).join(" "),
        }),
      },
    ];
    const result = applyMapping({ email: "a@b.com", fullName: "Bob Jones" }, mappings, "outbound");
    expect(result).toEqual({ email_addr: "a@b.com", first_name: "Bob", last_name: "Jones" });
  });
});

// ─── FE5: direction forward_only ────────────────────────────────────────────
// Spec table: forward_only → Forward (source→canonical) ✗, Reverse (canonical→source) ✓
// i.e. skip on inbound; include on outbound (write TO connector).

describe("FE5: direction forward_only — skipped on inbound, included on outbound", () => {
  it("inbound: entry is skipped entirely", () => {
    const mappings: FieldMappingList = [{
      target: "fullName",
      direction: "forward_only",
      expression: (r) => `${r["first"]} ${r["last"]}`,
    }];
    // forward_only = skip on inbound, so expression does NOT run
    expect(applyMapping({ first: "A", last: "B" }, mappings, "inbound")).toEqual({});
  });
  it("outbound: reverseExpression runs when present", () => {
    const mappings: FieldMappingList = [{
      target: "fullName",
      direction: "forward_only",
      reverseExpression: (r) => ({
        first_name: String(r["fullName"] ?? "").split(" ")[0] ?? "",
        last_name:  String(r["fullName"] ?? "").split(" ").slice(1).join(" "),
      }),
    }];
    expect(applyMapping({ fullName: "Alice Smith" }, mappings, "outbound"))
      .toEqual({ first_name: "Alice", last_name: "Smith" });
  });
  it("outbound: falls back to plain rename when no reverseExpression", () => {
    const mappings: FieldMappingList = [{ target: "code", direction: "forward_only" }];
    // No reverseExpression: plain target→source rename runs
    expect(applyMapping({ code: "ABC" }, mappings, "outbound")).toEqual({ code: "ABC" });
  });
});

// ─── FE6: direction reverse_only ─────────────────────────────────────────────
// Spec table: reverse_only → Forward (source→canonical) ✓, Reverse (canonical→source) ✗
// i.e. include on inbound (read FROM connector); skip on outbound (no write-back).

describe("FE6: direction reverse_only — included on inbound, skipped on outbound", () => {
  it("inbound: expression runs", () => {
    const mappings: FieldMappingList = [{
      source: "raw_score",
      target: "score",
      direction: "reverse_only",
      expression: (r) => Number(r["raw_score"]) * 100,
    }];
    expect(applyMapping({ raw_score: 0.9 }, mappings, "inbound")).toEqual({ score: 90 });
  });
  it("outbound: entry is skipped entirely", () => {
    const mappings: FieldMappingList = [{
      source: "raw_score",
      target: "score",
      direction: "reverse_only",
      reverseExpression: (r) => Number(r["score"]) / 100,
    }];
    // reverse_only = skip on outbound, so reverseExpression does NOT run
    expect(applyMapping({ score: 90 }, mappings, "outbound")).toEqual({});
  });
});

// ─── FE7: expression entries mixed with plain renames ────────────────────────

describe("FE7: expression and plain-rename entries coexist", () => {
  const mappings: FieldMappingList = [
    { source: "email_addr", target: "email" },
    {
      target: "fullName",
      direction: "bidirectional",
      expression: (r) => `${r["first_name"]} ${r["last_name"]}`,
      reverseExpression: (r) => ({
        first_name: String(r["fullName"] ?? "").split(" ")[0] ?? "",
        last_name:  String(r["fullName"] ?? "").split(" ").slice(1).join(" "),
      }),
    },
    { source: "phone_no", target: "phone" },
  ];

  it("inbound: both renames and expression applied", () => {
    const result = applyMapping(
      { email_addr: "a@b.com", first_name: "Alice", last_name: "Smith", phone_no: "123" },
      mappings, "inbound",
    );
    expect(result).toEqual({ email: "a@b.com", fullName: "Alice Smith", phone: "123" });
  });

  it("outbound: reverseExpression decomposes, renames applied", () => {
    const result = applyMapping({ email: "a@b.com", fullName: "Alice Smith", phone: "123" }, mappings, "outbound");
    expect(result).toEqual({ email_addr: "a@b.com", first_name: "Alice", last_name: "Smith", phone_no: "123" });
  });
});

// ─── FE8: enum mapping ────────────────────────────────────────────────────────

describe("FE8: enum mapping expression↔reverseExpression", () => {
  const mappings: FieldMappingList = [{
    source: "is_active",
    target: "status",
    expression: (r) => r["is_active"] ? "active" : "inactive",
    reverseExpression: (r) => r["status"] === "active",
  }];

  it("inbound: bool → string", () => {
    expect(applyMapping({ is_active: true }, mappings, "inbound")).toEqual({ status: "active" });
    expect(applyMapping({ is_active: false }, mappings, "inbound")).toEqual({ status: "inactive" });
  });
  it("outbound: string → bool", () => {
    expect(applyMapping({ status: "active" }, mappings, "outbound")).toEqual({ is_active: true });
    expect(applyMapping({ status: "inactive" }, mappings, "outbound")).toEqual({ is_active: false });
  });
});

// ─── FE9: expression receives full record ────────────────────────────────────

describe("FE9: expression receives full incoming record", () => {
  it("can combine two source fields into one target", () => {
    const mappings: FieldMappingList = [{
      target: "label",
      expression: (r) => `${r["code"]}-${r["year"]}`,
    }];
    expect(applyMapping({ code: "ABC", year: 2026 }, mappings, "inbound")).toEqual({ label: "ABC-2026" });
  });
});

// ─── DF: default / defaultExpression ─────────────────────────────────────────
// Spec: specs/field-mapping.md §1.5  Plan: plans/engine/PLAN_DEFAULT_VALUES.md
//
// DF1  Field absent from source → static default used
// DF2  Field present but null → static default used
// DF3  Field present with "" (empty string) → default NOT applied
// DF4  Field present with 0 (falsy) → default NOT applied
// DF5  defaultExpression referencing earlier field in same mapping
// DF6  Both absent → field dropped (undefined)
// DF7  Reverse pass — default / defaultExpression have no effect

describe("DF1: absent field → static default", () => {
  it("fills missing field with default value", () => {
    const mappings: FieldMappingList = [{ source: "status", target: "status", default: "active" }];
    expect(applyMapping({}, mappings, "inbound")).toEqual({ status: "active" });
  });
});

describe("DF2: null field → static default", () => {
  it("fills null field with default value", () => {
    const mappings: FieldMappingList = [{ source: "status", target: "status", default: "active" }];
    expect(applyMapping({ status: null }, mappings, "inbound")).toEqual({ status: "active" });
  });
});

describe("DF3: empty string is NOT absent — default not applied", () => {
  it("preserves empty string", () => {
    const mappings: FieldMappingList = [{ source: "status", target: "status", default: "active" }];
    expect(applyMapping({ status: "" }, mappings, "inbound")).toEqual({ status: "" });
  });
});

describe("DF4: falsy 0 is NOT absent — default not applied", () => {
  it("preserves zero", () => {
    const mappings: FieldMappingList = [{ source: "score", target: "score", default: 99 }];
    expect(applyMapping({ score: 0 }, mappings, "inbound")).toEqual({ score: 0 });
  });
});

describe("DF5: defaultExpression references earlier field", () => {
  it("computes fallback from already-resolved canonical field", () => {
    const mappings: FieldMappingList = [
      { source: "email", target: "email" },
      { source: "username", target: "username", defaultExpression: (r) => String(r["email"]).split("@")[0] },
    ];
    // username absent → derived from email (already in result)
    expect(applyMapping({ email: "alice@x.com" }, mappings, "inbound"))
      .toEqual({ email: "alice@x.com", username: "alice" });
  });
});

describe("DF6: no default, field absent → field dropped", () => {
  it("omits absent field when no default is set", () => {
    const mappings: FieldMappingList = [{ source: "notes", target: "notes" }];
    expect(applyMapping({}, mappings, "inbound")).toEqual({});
  });
});

describe("DF7: default has no effect on outbound pass", () => {
  it("outbound: default not applied (reverse only renames)", () => {
    const mappings: FieldMappingList = [{ source: "status", target: "status", default: "active" }];
    // canonical has status set; outbound should pass it through as-is
    expect(applyMapping({ status: "pending" }, mappings, "outbound")).toEqual({ status: "pending" });
    // canonical missing status — outbound does not inject default
    expect(applyMapping({}, mappings, "outbound")).toEqual({});
  });
});

// ─── RR: reverseRequired ──────────────────────────────────────────────────────
// Spec: specs/field-mapping.md §1.6  Plan: plans/engine/PLAN_REVERSE_REQUIRED.md
//
// RR1  Required field present and non-null → isDispatchBlocked returns false
// RR2  Required field is null → isDispatchBlocked returns true
// RR3  Required field absent (undefined) → isDispatchBlocked returns true
// RR4  Multiple required fields, all present → not blocked
// RR5  Multiple required fields, one null → blocked
// RR6  No reverseRequired fields → never blocked

import { isDispatchBlocked } from "./mapping.js";

describe("RR1: required field present → not blocked", () => {
  it("returns false when required field has a value", () => {
    const mappings: FieldMappingList = [{ source: "ext_id", target: "id", reverseRequired: true }];
    expect(isDispatchBlocked({ ext_id: "abc123" }, mappings)).toBe(false);
  });
});

describe("RR2: required field is null → blocked", () => {
  it("returns true when required field is null", () => {
    const mappings: FieldMappingList = [{ source: "ext_id", target: "id", reverseRequired: true }];
    expect(isDispatchBlocked({ ext_id: null }, mappings)).toBe(true);
  });
});

describe("RR3: required field absent → blocked", () => {
  it("returns true when required field is missing from record", () => {
    const mappings: FieldMappingList = [{ source: "ext_id", target: "id", reverseRequired: true }];
    expect(isDispatchBlocked({}, mappings)).toBe(true);
  });
});

describe("RR4: multiple required fields, all present → not blocked", () => {
  it("returns false when all required fields have values", () => {
    const mappings: FieldMappingList = [
      { source: "a", target: "fieldA", reverseRequired: true },
      { source: "b", target: "fieldB", reverseRequired: true },
    ];
    expect(isDispatchBlocked({ a: 1, b: 2 }, mappings)).toBe(false);
  });
});

describe("RR5: multiple required fields, one null → blocked", () => {
  it("returns true when at least one required field is null", () => {
    const mappings: FieldMappingList = [
      { source: "a", target: "fieldA", reverseRequired: true },
      { source: "b", target: "fieldB", reverseRequired: true },
    ];
    expect(isDispatchBlocked({ a: 1, b: null }, mappings)).toBe(true);
  });
});

describe("RR6: no reverseRequired fields → never blocked", () => {
  it("returns false for regular mappings with no reverseRequired", () => {
    const mappings: FieldMappingList = [{ source: "name", target: "fullName" }];
    expect(isDispatchBlocked({ name: null }, mappings)).toBe(false);
    expect(isDispatchBlocked({}, mappings)).toBe(false);
  });
});

// ─── parseTs ─────────────────────────────────────────────────────────────────
// Spec: specs/field-mapping.md §7.2

describe("PT1: parseTs — epoch ms number → returns as-is", () => {
  it("returns the number unchanged", () => {
    expect(parseTs(1700000000000)).toBe(1700000000000);
  });
});

describe("PT2: parseTs — ISO 8601 string → returns epoch ms", () => {
  it("parses the string to epoch ms", () => {
    const iso = "2024-01-15T12:00:00.000Z";
    expect(parseTs(iso)).toBe(Date.parse(iso));
  });
});

describe("PT3: parseTs — invalid string → returns undefined", () => {
  it("returns undefined for non-parseable strings", () => {
    expect(parseTs("not-a-date")).toBeUndefined();
  });
});

describe("PT4: parseTs — null/undefined/object → returns undefined", () => {
  it("returns undefined for non-string non-number values", () => {
    expect(parseTs(null)).toBeUndefined();
    expect(parseTs(undefined)).toBeUndefined();
    expect(parseTs({ ts: 1 })).toBeUndefined();
  });
});

// ─── computeFieldTimestamps ───────────────────────────────────────────────────
// Spec: specs/field-mapping.md §7.2

function makeRecord(overrides: Partial<ReadRecord> = {}): ReadRecord {
  return { id: "1", data: {}, ...overrides };
}

function shadow(fields: Record<string, { val: unknown; ts: number; src: string }>): FieldData {
  return fields as FieldData;
}

describe("FT1: no shadow, no updatedAt → all fields get ingestTs", () => {
  it("returns ingestTs for every field when shadow is absent", () => {
    const result = computeFieldTimestamps({ email: "a@b.com", name: "Alice" }, undefined, makeRecord(), 5000);
    expect(result).toEqual({ email: 5000, name: 5000 });
  });
});

describe("FT2: record.updatedAt present, new record → all fields get parsed updatedAt", () => {
  it("uses updatedAt instead of ingestTs for changed/new fields", () => {
    const ts = "2024-06-01T00:00:00Z";
    const result = computeFieldTimestamps({ email: "a@b.com" }, undefined, makeRecord({ updatedAt: ts }), 9000);
    expect(result).toEqual({ email: Date.parse(ts) });
  });
});

describe("FT3: unchanged field (same as shadow) → max(shadow ts, ingestTs)", () => {
  it("returns max of shadow ts and ingestTs when incoming value matches shadow val", () => {
    const fd = shadow({ email: { val: "a@b.com", ts: 100, src: "crm" } });
    // shadow ts=100, ingestTs=9999 → returns max=9999
    const result = computeFieldTimestamps({ email: "a@b.com" }, fd, makeRecord(), 9999);
    expect(result).toEqual({ email: 9999 });
  });
  it("shadow ts is returned when it is higher than ingestTs (connector-native ts case)", () => {
    const fd = shadow({ email: { val: "a@b.com", ts: 5000, src: "crm" } });
    // shadow ts=5000 > ingestTs=100 → returns max=5000
    const result = computeFieldTimestamps({ email: "a@b.com" }, fd, makeRecord(), 100);
    expect(result).toEqual({ email: 5000 });
  });
});

describe("FT4: changed field → gets baseTs (ingestTs when no updatedAt)", () => {
  it("returns ingestTs for a field whose value changed", () => {
    const fd = shadow({ email: { val: "old@b.com", ts: 100, src: "crm" } });
    const result = computeFieldTimestamps({ email: "new@b.com" }, fd, makeRecord(), 5000);
    expect(result).toEqual({ email: 5000 });
  });
});

describe("FT5: changed field with updatedAt → gets parsed updatedAt", () => {
  it("prefers updatedAt over ingestTs for changed fields", () => {
    const fd = shadow({ email: { val: "old@b.com", ts: 100, src: "crm" } });
    const ts = "2025-01-01T00:00:00Z";
    const result = computeFieldTimestamps({ email: "new@b.com" }, fd, makeRecord({ updatedAt: ts }), 9999);
    expect(result).toEqual({ email: Date.parse(ts) });
  });
});

describe("FT6: record.fieldTimestamps present → named fields use per-field ts", () => {
  it("uses fieldTimestamps value over shadow derivation", () => {
    const fd = shadow({ email: { val: "a@b.com", ts: 100, src: "crm" } });
    // Value unchanged, but fieldTimestamps supplies 300 — should use 300
    const result = computeFieldTimestamps(
      { email: "a@b.com" }, fd,
      makeRecord({ fieldTimestamps: { email: "2024-03-01T00:00:00Z" } }),
      9999,
    );
    expect(result).toEqual({ email: Date.parse("2024-03-01T00:00:00Z") });
  });
});

describe("FT7: fieldTimestamps present for subset of fields", () => {
  it("uses fieldTimestamps for named fields; shadow derivation (max) for the rest", () => {
    const fd = shadow({
      email: { val: "a@b.com", ts: 100, src: "crm" },
      name: { val: "Alice", ts: 200, src: "crm" },
    });
    // email gets fieldTimestamps value; name is unchanged → max(shadow.ts=200, ingestTs=9999)=9999
    const result = computeFieldTimestamps(
      { email: "a@b.com", name: "Alice" }, fd,
      makeRecord({ fieldTimestamps: { email: "2024-06-01T00:00:00Z" } }),
      9999,
    );
    expect(result).toEqual({ email: Date.parse("2024-06-01T00:00:00Z"), name: 9999 });
  });
});

// ─── AT1: element_fields inbound rename ──────────────────────────────────────

describe("AT1: element_fields inbound per-element rename (Spec: §3.5)", () => {
  it("renames fields within each array element on inbound pass", () => {
    const elementFields: FieldMappingList = [
      { source: "number", target: "value" },
      { source: "label",  target: "type" },
    ];
    const input = [
      { number: "+1-555-0100", label: "work" },
      { number: "+1-555-0200", label: "home" },
    ];
    expect(applyElementFields(input, elementFields, "inbound")).toEqual([
      { value: "+1-555-0100", type: "work" },
      { value: "+1-555-0200", type: "home" },
    ]);
  });
});

// ─── AT2: element_fields outbound reverse rename ─────────────────────────────

describe("AT2: element_fields outbound per-element reverse rename (Spec: §3.5)", () => {
  it("reverses field renames within each array element on outbound pass", () => {
    const elementFields: FieldMappingList = [
      { source: "number", target: "value" },
      { source: "label",  target: "type" },
    ];
    const input = [
      { value: "+1-555-0100", type: "work" },
      { value: "+1-555-0200", type: "home" },
    ];
    expect(applyElementFields(input, elementFields, "outbound")).toEqual([
      { number: "+1-555-0100", label: "work" },
      { number: "+1-555-0200", label: "home" },
    ]);
  });
});

// ─── AT3: nested element_fields ──────────────────────────────────────────────

describe("AT3: nested (self-referential) element_fields (Spec: §3.5)", () => {
  it("applies nested element_fields to inner arrays", () => {
    const elementFields: FieldMappingList = [
      { source: "dept",    target: "deptName" },
      {
        source: "members", target: "members",
        elementFields: [
          { source: "userId", target: "id" },
        ],
      },
    ];
    const input = [
      {
        dept: "Engineering",
        members: [{ userId: "u1" }, { userId: "u2" }],
      },
    ];
    expect(applyElementFields(input, elementFields, "inbound")).toEqual([
      {
        deptName: "Engineering",
        members: [{ id: "u1" }, { id: "u2" }],
      },
    ]);
  });
});

// ─── AT4: non-array value passes through unchanged ────────────────────────────

describe("AT4: non-array value passes through unchanged (Spec: §3.5)", () => {
  it("returns null unchanged", () => {
    const elementFields: FieldMappingList = [{ source: "a", target: "b" }];
    expect(applyElementFields(null, elementFields, "inbound")).toBeNull();
  });
  it("returns string unchanged", () => {
    const elementFields: FieldMappingList = [{ source: "a", target: "b" }];
    expect(applyElementFields("not-an-array", elementFields, "inbound")).toBe("not-an-array");
  });
});

// ─── AT5: applyMapping integrates element_fields automatically ────────────────

describe("AT5: applyMapping applies element_fields via mapping list (Spec: §3.5)", () => {
  it("inbound: renames top-level field and per-element fields", () => {
    const mappings: FieldMappingList = [
      {
        source: "phoneNumbers",
        target: "phones",
        elementFields: [
          { source: "number", target: "value" },
          { source: "label",  target: "type" },
        ],
      },
    ];
    const data = {
      phoneNumbers: [
        { number: "+1-555-0100", label: "work" },
        { number: "+1-555-0200", label: "home" },
      ],
    };
    expect(applyMapping(data, mappings, "inbound")).toEqual({
      phones: [
        { value: "+1-555-0100", type: "work" },
        { value: "+1-555-0200", type: "home" },
      ],
    });
  });

  it("outbound: reverse-renames top-level field and per-element fields", () => {
    const mappings: FieldMappingList = [
      {
        source: "phoneNumbers",
        target: "phones",
        elementFields: [
          { source: "number", target: "value" },
          { source: "label",  target: "type" },
        ],
      },
    ];
    const canonical = {
      phones: [
        { value: "+1-555-0100", type: "work" },
        { value: "+1-555-0200", type: "home" },
      ],
    };
    expect(applyMapping(canonical, mappings, "outbound")).toEqual({
      phoneNumbers: [
        { number: "+1-555-0100", label: "work" },
        { number: "+1-555-0200", label: "home" },
      ],
    });
  });
});

