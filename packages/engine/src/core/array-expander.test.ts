// Spec: specs/field-mapping.md §3.2 — array expander unit tests
import { describe, expect, it } from "bun:test";
import type { ReadRecord } from "@opensync/sdk";
import { expandArrayRecord, deriveChildCanonicalId } from "./array-expander.js";
import type { ChannelMember } from "../config/loader.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const baseRecord = (id: string, data: Record<string, unknown>): ReadRecord => ({
  id,
  data,
});

const baseMember = (overrides: Partial<ChannelMember> = {}): ChannelMember => ({
  connectorId: "erp",
  entity: "order_lines",
  sourceEntity: "orders",
  ...overrides,
});

// ─── expandArrayRecord ────────────────────────────────────────────────────────

describe("expandArrayRecord", () => {
  it("AE1 — no arrayPath returns single-element passthrough", () => {
    const record = baseRecord("order-1", { id: "order-1", name: "Acme" });
    const member = baseMember({ arrayPath: undefined });
    const result = expandArrayRecord(record, member);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(record);
  });

  it("AE2 — simple top-level array produces N child records with index-based IDs", () => {
    const record = baseRecord("order-1", {
      order_id: "order-1",
      lines: [
        { product_id: "P1", qty: 2 },
        { product_id: "P2", qty: 5 },
      ],
    });
    const member = baseMember({ arrayPath: "lines" });
    const result = expandArrayRecord(record, member);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("order-1#lines[0]");
    expect(result[1]!.id).toBe("order-1#lines[1]");
    expect((result[0]!.data as Record<string, unknown>)["product_id"]).toBe("P1");
  });

  it("AE3 — element_key produces stable IDs from key value", () => {
    const record = baseRecord("order-1", {
      lines: [
        { line_no: "L01", product_id: "P1" },
        { line_no: "L02", product_id: "P2" },
      ],
    });
    const member = baseMember({ arrayPath: "lines", elementKey: "line_no" });
    const result = expandArrayRecord(record, member);
    expect(result[0]!.id).toBe("order-1#lines[L01]");
    expect(result[1]!.id).toBe("order-1#lines[L02]");
  });

  it("AE4 — element_key absent on element falls back to index", () => {
    const record = baseRecord("order-1", {
      lines: [
        { product_id: "P1" },        // no line_no
        { line_no: "L02", product_id: "P2" },
      ],
    });
    const member = baseMember({ arrayPath: "lines", elementKey: "line_no" });
    const result = expandArrayRecord(record, member);
    // First element has no line_no → fallback to index
    expect(result[0]!.id).toBe("order-1#lines[0]");
    expect(result[1]!.id).toBe("order-1#lines[L02]");
  });

  it("AE5 — parentFields string shorthand merges into each element", () => {
    const record = baseRecord("order-1", {
      order_id: "order-1",
      customer_id: "cust-99",
      lines: [{ product_id: "P1" }],
    });
    const member = baseMember({
      arrayPath: "lines",
      parentFields: {
        orderId: "order_id",
        custId: "customer_id",
      },
    });
    const result = expandArrayRecord(record, member);
    const data = result[0]!.data as Record<string, unknown>;
    expect(data["orderId"]).toBe("order-1");
    expect(data["custId"]).toBe("cust-99");
    expect(data["product_id"]).toBe("P1");
  });

  it("AE6 — element field wins over parent field on collision", () => {
    const record = baseRecord("order-1", {
      status: "open",           // parent field
      lines: [{ status: "shipped" }],  // element overrides
    });
    const member = baseMember({
      arrayPath: "lines",
      parentFields: { status: "status" },
    });
    const result = expandArrayRecord(record, member);
    expect((result[0]!.data as Record<string, unknown>)["status"]).toBe("shipped");
  });

  it("AE7 — parentFields object form { field } extracts top-level parent field", () => {
    const record = baseRecord("order-1", {
      customerId: "cust-42",
      lines: [{ sku: "A" }],
    });
    const member = baseMember({
      arrayPath: "lines",
      parentFields: { cId: { field: "customerId" } },
    });
    const result = expandArrayRecord(record, member);
    expect((result[0]!.data as Record<string, unknown>)["cId"]).toBe("cust-42");
  });

  it("AE8 — dotted array_path resolves nested array", () => {
    const record = baseRecord("order-1", {
      order: {
        lines: [{ sku: "X" }],
      },
    });
    const member = baseMember({ arrayPath: "order.lines" });
    const result = expandArrayRecord(record, member);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("order-1#order.lines[0]");
  });

  it("AE9 — non-array value at path logs warning and returns passthrough", () => {
    const record = baseRecord("order-1", { lines: "not-an-array" });
    const member = baseMember({ arrayPath: "lines" });
    const result = expandArrayRecord(record, member);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(record);
  });

  it("AE10 — JSON-string array is parsed and expanded", () => {
    const record = baseRecord("order-1", {
      lines: JSON.stringify([{ sku: "A" }, { sku: "B" }]),
    });
    const member = baseMember({ arrayPath: "lines" });
    const result = expandArrayRecord(record, member);
    expect(result).toHaveLength(2);
    expect((result[0]!.data as Record<string, unknown>)["sku"]).toBe("A");
  });

  it("AE11 — empty array returns empty result", () => {
    const record = baseRecord("order-1", { lines: [] });
    const member = baseMember({ arrayPath: "lines" });
    const result = expandArrayRecord(record, member);
    expect(result).toHaveLength(0);
  });

  it("AE12 — missing path returns passthrough (no key in data)", () => {
    const record = baseRecord("order-1", { name: "Acme" });
    const member = baseMember({ arrayPath: "lines" });
    const result = expandArrayRecord(record, member);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(record);
  });
});

// ─── deriveChildCanonicalId ───────────────────────────────────────────────────

describe("deriveChildCanonicalId", () => {
  it("DC1 — returns a valid UUID-shaped string", () => {
    const id = deriveChildCanonicalId("parent-uuid", "lines", "L01");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("DC2 — same inputs always produce the same output (deterministic)", () => {
    const a = deriveChildCanonicalId("parent-uuid", "lines", "L01");
    const b = deriveChildCanonicalId("parent-uuid", "lines", "L01");
    expect(a).toBe(b);
  });

  it("DC3 — different element keys produce different IDs", () => {
    const a = deriveChildCanonicalId("parent-uuid", "lines", "L01");
    const b = deriveChildCanonicalId("parent-uuid", "lines", "L02");
    expect(a).not.toBe(b);
  });

  it("DC4 — different parent canonical IDs produce different IDs", () => {
    const a = deriveChildCanonicalId("parent-A", "lines", "L01");
    const b = deriveChildCanonicalId("parent-B", "lines", "L01");
    expect(a).not.toBe(b);
  });

  it("DC5 — different array paths produce different IDs", () => {
    const a = deriveChildCanonicalId("parent-uuid", "lines", "0");
    const b = deriveChildCanonicalId("parent-uuid", "items", "0");
    expect(a).not.toBe(b);
  });
});
