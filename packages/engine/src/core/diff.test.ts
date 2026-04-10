/**
 * packages/engine/src/core/diff.test.ts
 *
 * Tests for diff() with normalize support.
 * Spec: specs/field-mapping.md §1.4  Plan: plans/engine/PLAN_NORMALIZE_NOOP.md
 * Spec: specs/field-mapping.md §3.5  Plan: plans/engine/PLAN_ATOMIC_ARRAY.md
 *
 * N1  Phone: formatted vs stripped — same after normalize → skip
 * N2  Float: within precision band → skip
 * N3  Float: outside precision band → update
 * N4  No normalizer — raw comparison unchanged (regression guard)
 * AA1 sort_elements via buildNormalizers mapping flag → equal despite reorder
 * AA2 sort_elements: changed element → update
 * AA3 unordered via entity schema → equal despite reorder
 * AA4 normalizeForDiff: nested unordered array sorted recursively
 * AA5 normalizeForDiff: non-array values pass through unchanged
 */
import { describe, it, expect } from "bun:test";
import { diff, buildNormalizers, normalizeForDiff } from "./diff.js";
import type { FieldData } from "../db/schema.js";
import type { FieldDescriptor } from "@opensync/sdk";

function shadow(fields: Record<string, { val: unknown; src: string; ts: number }>): FieldData {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v])) as FieldData;
}

// ─── N1: normalized phone → skip ────────────────────────────────────────────

describe("N1: formatted phone vs digits-only shadow — normalized equal → skip", () => {
  it("returns skip when normalize makes them equal", () => {
    const strip = (v: unknown) => String(v).replace(/\D/g, "");
    const normalizers = new Map([["phone", strip]]);
    const s = shadow({ phone: { val: "5551234567", src: "crm", ts: 100 } });
    expect(diff({ phone: "(555) 123-4567" }, s, undefined, normalizers)).toBe("skip");
  });
});

// ─── N2: float within precision band → skip ──────────────────────────────────

describe("N2: float within precision band → skip", () => {
  it("1.23456 vs 1.23 with toFixed(2) → skip", () => {
    const toFixed2 = (v: unknown) => Number(v).toFixed(2);
    const normalizers = new Map([["score", toFixed2]]);
    const s = shadow({ score: { val: 1.23, src: "crm", ts: 100 } });
    expect(diff({ score: 1.23456 }, s, undefined, normalizers)).toBe("skip");
  });
});

// ─── N3: float outside precision band → update ───────────────────────────────

describe("N3: float outside precision band → update", () => {
  it("1.30 vs 1.23 with toFixed(2) → update", () => {
    const toFixed2 = (v: unknown) => Number(v).toFixed(2);
    const normalizers = new Map([["score", toFixed2]]);
    const s = shadow({ score: { val: 1.23, src: "crm", ts: 100 } });
    expect(diff({ score: 1.30 }, s, undefined, normalizers)).toBe("update");
  });
});

// ─── N4: no normalizer — raw comparison unchanged ────────────────────────────

describe("N4: no normalizers — raw comparison unchanged", () => {
  it("insert when shadow is undefined", () => {
    expect(diff({ x: 1 }, undefined, undefined)).toBe("insert");
  });

  it("skip when values identical", () => {
    const s = shadow({ x: { val: 1, src: "crm", ts: 100 } });
    expect(diff({ x: 1 }, s, undefined)).toBe("skip");
  });

  it("update when value changed", () => {
    const s = shadow({ x: { val: 1, src: "crm", ts: 100 } });
    expect(diff({ x: 2 }, s, undefined)).toBe("update");
  });
});

// ─── buildNormalizers helper ──────────────────────────────────────────────────

describe("buildNormalizers: extracts normalize fns from FieldMappingList", () => {
  it("returns undefined when no mappings have normalize", () => {
    expect(buildNormalizers([{ target: "name" }])).toBeUndefined();
  });

  it("returns undefined for empty array", () => {
    expect(buildNormalizers([])).toBeUndefined();
  });

  it("returns map with only the fields that have normalize", () => {
    const strip = (v: unknown) => String(v).replace(/\D/g, "");
    const map = buildNormalizers([
      { target: "phone", normalize: strip },
      { target: "name" },
    ]);
    expect(map).toBeDefined();
    expect(map!.size).toBe(1);
    expect(map!.get("phone")!("(555) 123")).toBe("555123");
  });
});

// ─── AA1: sort_elements mapping flag → equal despite reorder ─────────────────

describe("AA1: sort_elements mapping flag — reordered array is equal (Spec: §3.5)", () => {
  it("skip when sortElements=true and elements are reordered", () => {
    const normalizers = buildNormalizers([
      { target: "tags", sortElements: true },
    ]);
    const s = shadow({ tags: { val: ["a", "b", "c"], src: "crm", ts: 100 } });
    // incoming has same elements in different order
    expect(diff({ tags: ["c", "a", "b"] }, s, undefined, normalizers)).toBe("skip");
  });
});

// ─── AA2: sort_elements: changed element → update ────────────────────────────

describe("AA2: sort_elements — changed element → update (Spec: §3.5)", () => {
  it("update when an element is actually different", () => {
    const normalizers = buildNormalizers([
      { target: "tags", sortElements: true },
    ]);
    const s = shadow({ tags: { val: ["a", "b", "c"], src: "crm", ts: 100 } });
    expect(diff({ tags: ["a", "b", "x"] }, s, undefined, normalizers)).toBe("update");
  });
});

// ─── AA3: unordered via entity schema ────────────────────────────────────────

describe("AA3: unordered via entity schema (Spec: §3.5)", () => {
  it("skip when schema declares array as unordered and elements are reordered", () => {
    const schema: Record<string, FieldDescriptor> = {
      tags: { type: { type: "array", items: "string", unordered: true } },
    };
    const normalizers = buildNormalizers([{ target: "tags" }], schema);
    const s = shadow({ tags: { val: ["x", "y"], src: "crm", ts: 100 } });
    expect(diff({ tags: ["y", "x"] }, s, undefined, normalizers)).toBe("skip");
  });
});

// ─── AA4: normalizeForDiff recursive sort ────────────────────────────────────

describe("AA4: normalizeForDiff sorts nested arrays recursively (Spec: §3.5)", () => {
  it("sorts inner unordered array within object items", () => {
    const fieldType = {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          roles: { type: { type: "array" as const, items: "string" as const, unordered: true as const } },
        },
      },
    };
    const input = [
      { roles: ["editor", "admin"] },
      { roles: ["viewer"] },
    ];
    const result = normalizeForDiff(input, fieldType) as Array<{ roles: string[] }>;
    expect(result[0]!.roles).toEqual(["admin", "editor"]);
    expect(result[1]!.roles).toEqual(["viewer"]);
  });
});

// ─── AA5: normalizeForDiff non-array pass-through ────────────────────────────

describe("AA5: normalizeForDiff — non-array values pass through unchanged (Spec: §3.5)", () => {
  it("null passes through", () => {
    expect(normalizeForDiff(null, { type: "array", items: "string" })).toBeNull();
  });
  it("undefined passes through", () => {
    expect(normalizeForDiff(undefined, { type: "array", items: "string" })).toBeUndefined();
  });
  it("string FieldType passes through", () => {
    expect(normalizeForDiff("hello", "string")).toBe("hello");
  });
});
