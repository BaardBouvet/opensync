// Spec: specs/field-mapping.md §3.2 — array expander unit tests
import { describe, expect, it } from "bun:test";
import type { ReadRecord } from "@opensync/sdk";
import { expandArrayRecord, applySortToLeafArray, deriveChildCanonicalId } from "./array-expander.js";
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

// ═══ Scalar array expansion (specs/field-mapping.md §3.3) ════════════════════

describe("SA1: string scalar array expands — _value set, child IDs use value pattern", () => {
  it("string array produces one child per element with _value field", () => {
    const record = baseRecord("c1", { tags: ["vip", "churned"] });
    const member = baseMember({ arrayPath: "tags", scalar: true });
    const children = expandArrayRecord(record, member);
    expect(children).toHaveLength(2);
    expect(children[0]).toEqual({ id: "c1#tags[vip]", data: { _value: "vip" } });
    expect(children[1]).toEqual({ id: "c1#tags[churned]", data: { _value: "churned" } });
  });
});

describe("SA2: number scalar array — _value is numeric, child IDs use String(number)", () => {
  it("numeric array produces children with numeric _value", () => {
    const record = baseRecord("r1", { scores: [10, 20, 30] });
    const member = baseMember({ arrayPath: "scores", scalar: true });
    const children = expandArrayRecord(record, member);
    expect(children).toHaveLength(3);
    expect(children[0]).toEqual({ id: "r1#scores[10]", data: { _value: 10 } });
    expect(children[1]).toEqual({ id: "r1#scores[20]", data: { _value: 20 } });
    expect(children[2]).toEqual({ id: "r1#scores[30]", data: { _value: 30 } });
  });
});

describe("SA3: duplicate scalar values collapse into one child (set semantics)", () => {
  it("duplicate scalar produces same child ID; second occurrence overwrites first", () => {
    const record = baseRecord("c1", { tags: ["vip", "vip", "churned"] });
    const member = baseMember({ arrayPath: "tags", scalar: true });
    const children = expandArrayRecord(record, member);
    // Both "vip" entries produce the same id; expandArrayRecord doesn't deduplicate
    // — the caller stores in shadow_state keyed by id, so the second write wins.
    // What we verify: same id produced for both "vip" occurrences.
    const vipIds = children.filter((c) => c.id === "c1#tags[vip]");
    expect(vipIds.length).toBeGreaterThan(0);
    const unique = new Set(children.map((c) => c.id));
    expect(unique.size).toBe(2); // "vip" and "churned" (deduped by id)
  });
});

describe("SA4: null and undefined elements are skipped", () => {
  it("null elements not included in output", () => {
    const record = baseRecord("r1", { tags: ["a", null, "b"] });
    const member = baseMember({ arrayPath: "tags", scalar: true });
    const children = expandArrayRecord(record, member);
    expect(children).toHaveLength(2);
    expect(children.map((c) => (c.data as Record<string, unknown>)["_value"])).toEqual(["a", "b"]);
  });
});

describe("SA5: parent_fields merged into each scalar child; _value wins on collision", () => {
  it("parent field is included beside _value", () => {
    const record = baseRecord("c1", { id: "c1", tags: ["vip"] });
    const member = baseMember({
      arrayPath: "tags",
      scalar: true,
      parentFields: { contactId: "id" },
    });
    const children = expandArrayRecord(record, member);
    expect(children[0]?.data).toEqual({ contactId: "c1", _value: "vip" });
  });
});

describe("SA6: filter expression receives raw scalar as element binding", () => {
  it("filter skips elements that don't match: 'internal' excluded", () => {
    const record = baseRecord("r1", { tags: ["vip", "internal", "churned"] });
    const member = baseMember({
      arrayPath: "tags",
      scalar: true,
      elementFilter: (el) => el !== "internal",
    });
    const children = expandArrayRecord(record, member);
    expect(children).toHaveLength(2);
    expect(children.map((c) => (c.data as Record<string, unknown>)["_value"])).toEqual(["vip", "churned"]);
  });
});

describe("SA7: config validation — element_key + scalar: true throws", () => {
  // Validated at loader level — tested in loader spec; here we just verify expansion logic
  // for the code path: scalar:true member with no element_key works fine.
  it("scalar: true without element_key works normally", () => {
    const record = baseRecord("r1", { items: ["x"] });
    const member = baseMember({ arrayPath: "items", scalar: true });
    const children = expandArrayRecord(record, member);
    expect(children).toHaveLength(1);
  });
});

describe("SA8: scalar: false / absent behaves as non-scalar; non-object elements skipped", () => {
  it("without scalar: true, bare strings in array are skipped", () => {
    const record = baseRecord("r1", { items: ["string_element"] });
    const member = baseMember({ arrayPath: "items" }); // no scalar flag
    const children = expandArrayRecord(record, member);
    expect(children).toHaveLength(0);
  });
});

describe("SA9: empty scalar array returns no children", () => {
  it("empty array produces no children", () => {
    const record = baseRecord("r1", { tags: [] });
    const member = baseMember({ arrayPath: "tags", scalar: true });
    const children = expandArrayRecord(record, member);
    expect(children).toHaveLength(0);
  });
});

// ═══ Array ordering utilities (specs/field-mapping.md §6) ════════════════════

const rootWithLines = (lines: Record<string, unknown>[]): Record<string, unknown> => ({
  id: "ord1",
  lines,
});

describe("OR1: custom sort — single field asc", () => {
  it("sorts by lineNumber ascending", () => {
    const data = rootWithLines([{ lineNumber: 3 }, { lineNumber: 1 }, { lineNumber: 2 }]);
    const chain = [{ arrayPath: "lines", elementKey: "lineNumber" }];
    const member = baseMember({ orderBy: [{ field: "lineNumber", direction: "asc" }] });
    applySortToLeafArray(data, chain, member);
    const lines = (data["lines"] as Array<Record<string, unknown>>);
    expect(lines.map((l) => l["lineNumber"])).toEqual([1, 2, 3]);
  });
});

describe("OR2: custom sort — single field desc", () => {
  it("sorts by lineNumber descending", () => {
    const data = rootWithLines([{ lineNumber: 1 }, { lineNumber: 3 }, { lineNumber: 2 }]);
    const chain = [{ arrayPath: "lines", elementKey: "lineNumber" }];
    const member = baseMember({ orderBy: [{ field: "lineNumber", direction: "desc" }] });
    applySortToLeafArray(data, chain, member);
    const lines = (data["lines"] as Array<Record<string, unknown>>);
    expect(lines.map((l) => l["lineNumber"])).toEqual([3, 2, 1]);
  });
});

describe("OR3: custom sort — multi-field", () => {
  it("primary tie broken by secondary field", () => {
    const data = rootWithLines([
      { cat: "b", rank: 2 },
      { cat: "a", rank: 1 },
      { cat: "b", rank: 1 },
    ]);
    const chain = [{ arrayPath: "lines" }];
    const member = baseMember({
      orderBy: [
        { field: "cat", direction: "asc" },
        { field: "rank", direction: "asc" },
      ],
    });
    applySortToLeafArray(data, chain, member);
    const lines = (data["lines"] as Array<Record<string, unknown>>);
    expect(lines).toEqual([
      { cat: "a", rank: 1 },
      { cat: "b", rank: 1 },
      { cat: "b", rank: 2 },
    ]);
  });
});

describe("OR4: custom sort — numeric strings sort numerically", () => {
  it("'2', '10', '1' sorts as 1, 2, 10 (numeric, not lexicographic)", () => {
    const data = rootWithLines([{ n: "2" }, { n: "10" }, { n: "1" }]);
    const chain = [{ arrayPath: "lines" }];
    const member = baseMember({ orderBy: [{ field: "n", direction: "asc" }] });
    applySortToLeafArray(data, chain, member);
    const lines = (data["lines"] as Array<Record<string, unknown>>);
    expect(lines.map((l) => l["n"])).toEqual(["1", "2", "10"]);
  });
});

describe("OR5: custom sort — single element: sort is identity", () => {
  it("one element: no error, element unchanged", () => {
    const data = rootWithLines([{ lineNumber: 1 }]);
    const chain = [{ arrayPath: "lines" }];
    const member = baseMember({ orderBy: [{ field: "lineNumber", direction: "asc" }] });
    applySortToLeafArray(data, chain, member);
    const lines = (data["lines"] as Array<Record<string, unknown>>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ lineNumber: 1 });
  });
});

describe("OR6: CRDT ordinal — forward injection (_ordinal field set)", () => {
  it("expandArrayRecord injects _ordinal from source array position", () => {
    const record = baseRecord("ord1", { items: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const member = baseMember({ arrayPath: "items", elementKey: "id", crdtOrder: true });
    const children = expandArrayRecord(record, member);
    expect((children[0]?.data as Record<string, unknown>)["_ordinal"]).toBe(0);
    expect((children[1]?.data as Record<string, unknown>)["_ordinal"]).toBe(1);
    expect((children[2]?.data as Record<string, unknown>)["_ordinal"]).toBe(2);
  });
});

describe("OR7: CRDT ordinal — collapse sort + strip", () => {
  it("sort by _ordinal; _ordinal absent from written elements", () => {
    const data = rootWithLines([
      { id: "a", _ordinal: 2 },
      { id: "c", _ordinal: 0 },
      { id: "b", _ordinal: 1 },
    ]);
    const chain = [{ arrayPath: "lines", elementKey: "id", crdtOrder: true }];
    const member = baseMember({ crdtOrder: true, elementKey: "id" });
    applySortToLeafArray(data, chain, member);
    const lines = (data["lines"] as Array<Record<string, unknown>>);
    expect(lines.map((l) => l["id"])).toEqual(["c", "b", "a"]);
    // _ordinal stripped
    for (const l of lines) expect(l).not.toHaveProperty("_ordinal");
  });
});

describe("OR9: CRDT ordinal — elements without _ordinal sort last", () => {
  it("element with no _ordinal comes after elements that have _ordinal", () => {
    const data = rootWithLines([
      { id: "no-ordinal" },
      { id: "b", _ordinal: 1 },
      { id: "a", _ordinal: 0 },
    ]);
    const chain = [{ arrayPath: "lines", elementKey: "id" }];
    const member = baseMember({ crdtOrder: true, elementKey: "id" });
    applySortToLeafArray(data, chain, member);
    const lines = (data["lines"] as Array<Record<string, unknown>>);
    expect(lines[lines.length - 1]?.["id"]).toBe("no-ordinal");
  });
});

describe("LL1: linked-list — forward injection of _prev/_next", () => {
  it("first element has _prev=null, last has _next=null, middle has both set", () => {
    const record = baseRecord("ord1", { items: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const member = baseMember({ arrayPath: "items", elementKey: "id", crdtLinkedList: true });
    const children = expandArrayRecord(record, member);
    const byId: Record<string, Record<string, unknown>> = {};
    for (const c of children) byId[c.id.split("[")[1]!.replace("]", "")] = c.data as Record<string, unknown>;
    expect(byId["a"]?.["_prev"]).toBeNull();
    expect(byId["a"]?.["_next"]).toBe("b");
    expect(byId["b"]?.["_prev"]).toBe("a");
    expect(byId["b"]?.["_next"]).toBe("c");
    expect(byId["c"]?.["_prev"]).toBe("b");
    expect(byId["c"]?.["_next"]).toBeNull();
  });
});

describe("LL2: linked-list — collapse reconstruction", () => {
  it("restores correct linked-list order; pointer fields stripped", () => {
    const data = rootWithLines([
      { id: "c", _prev: "b", _next: null },
      { id: "a", _prev: null, _next: "b" },
      { id: "b", _prev: "a", _next: "c" },
    ]);
    const chain = [{ arrayPath: "lines", elementKey: "id" }];
    const member = baseMember({ crdtLinkedList: true, elementKey: "id" });
    applySortToLeafArray(data, chain, member);
    const lines = (data["lines"] as Array<Record<string, unknown>>);
    expect(lines.map((l) => l["id"])).toEqual(["a", "b", "c"]);
    for (const l of lines) {
      expect(l).not.toHaveProperty("_prev");
      expect(l).not.toHaveProperty("_next");
    }
  });
});

describe("LL3: linked-list — broken chain: remaining elements appended", () => {
  it("broken _next pointer: existing elements appended without error", () => {
    const data = rootWithLines([
      { id: "a", _prev: null, _next: "NONEXISTENT" },
      { id: "b", _prev: "a", _next: null },
    ]);
    const chain = [{ arrayPath: "lines", elementKey: "id" }];
    const member = baseMember({ crdtLinkedList: true, elementKey: "id" });
    applySortToLeafArray(data, chain, member);
    const lines = (data["lines"] as Array<Record<string, unknown>>);
    // "a" is placed first (head), then "b" is appended since _next of "a" is broken
    expect(lines).toHaveLength(2);
    expect(lines[0]?.["id"]).toBe("a");
  });
});

describe("LL4: linked-list — cycle guard prevents infinite loop", () => {
  it("cycle in pointers: guard breaks out; all elements returned without error", () => {
    const data = rootWithLines([
      { id: "a", _prev: "b", _next: "b" }, // cyclic
      { id: "b", _prev: "a", _next: "a" }, // cyclic
    ]);
    const chain = [{ arrayPath: "lines", elementKey: "id" }];
    const member = baseMember({ crdtLinkedList: true, elementKey: "id" });
    // Should not throw
    expect(() => applySortToLeafArray(data, chain, member)).not.toThrow();
    const lines = (data["lines"] as Array<Record<string, unknown>>);
    expect(lines).toHaveLength(2);
  });
});

describe("MX1: mutual exclusion — order: true + order_linked_list: true throws at loadConfig", () => {
  // This validation is at the loader level. We test the config schema / loader here
  // just by confirming that a ChannelMember with both set still calls applySortToLeafArray safely
  // (the validation would throw before this point in production).
  it("applySortToLeafArray with both crdtOrder and crdtLinkedList: crdtOrder takes precedence", () => {
    const data = rootWithLines([{ id: "b", _ordinal: 1 }, { id: "a", _ordinal: 0 }]);
    const chain = [{ arrayPath: "lines", elementKey: "id" }];
    // crdtOrder checked first in the utility
    const member = baseMember({ crdtOrder: true, crdtLinkedList: true, elementKey: "id" });
    applySortToLeafArray(data, chain, member);
    const lines = (data["lines"] as Array<Record<string, unknown>>);
    expect(lines.map((l) => l["id"])).toEqual(["a", "b"]);
  });
});
