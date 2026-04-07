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
 */
import { describe, it, expect } from "bun:test";
import { applyMapping } from "./mapping.js";
import type { FieldMappingList } from "../config/loader.js";

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
