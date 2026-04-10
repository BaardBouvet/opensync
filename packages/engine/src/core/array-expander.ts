// Spec: specs/field-mapping.md §3.2/§3.4 — nested array expansion forward pass
import type { EntityDefinition, FieldDescriptor, FieldType, ReadRecord } from "@opensync/sdk";
import { ELEMENT_RECORD } from "@opensync/sdk";
import type { ChannelMember, ExpansionChainLevel } from "../config/loader.js";
export type { ExpansionChainLevel };

// ─── Pure-JS SHA-256 ──────────────────────────────────────────────────────────
// Replaces node:crypto so this module is browser-compatible (Vite/playground).
// Works identically in Bun, Node 18+, and browsers.

/* eslint-disable no-bitwise */
const SHA256_H = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function sha256(msg: Uint8Array): Uint8Array {
  // Pad message: append 0x80, zero bytes, then 64-bit big-endian bit length.
  const bitLen = msg.length * 8;
  const blocks = Math.ceil((msg.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x1_0000_0000), false);
  dv.setUint32(padded.length - 4, bitLen >>> 0, false);

  const h = new Uint32Array(SHA256_H);
  const W = new Uint32Array(64);

  for (let blk = 0; blk < blocks; blk++) {
    const base = blk * 64;
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(base + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(W[i - 15]!, 7)  ^ rotr32(W[i - 15]!, 18) ^ (W[i - 15]! >>> 3);
      const s1 = rotr32(W[i - 2]!,  17) ^ rotr32(W[i - 2]!,  19) ^ (W[i - 2]!  >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!,
        e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1  = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch  = (e & f) ^ (~e & g);
      const t1  = (hh + S1 + ch + SHA256_K[i]! + W[i]!) >>> 0;
      const S0  = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2  = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d  = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]!, false);
  return out;
}
/* eslint-enable no-bitwise */

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}


// ─── Deterministic child canonical ID ─────────────────────────────────────────

/**
 * Spec: specs/field-mapping.md §3.2 — derive a deterministic UUID for a child
 * (expanded array element) from the parent canonical ID and element key.
 *
 * Uses SHA-256 of the composite key, formatted as a UUID. The version nibble is
 * set to 5 and the variant bits to RFC 4122 §4.1.1 to minimise collision risk
 * with random (v4) UUIDs used elsewhere.
 */
export function deriveChildCanonicalId(
  parentCanonicalId: string,
  arrayPath: string,
  elementKeyValue: string,
): string {
  const input = `opensync:array:${parentCanonicalId}:${arrayPath}[${elementKeyValue}]`;
  const hash = sha256(new TextEncoder().encode(input));
  // Use first 16 bytes; set version=5, variant=0b10xx_xxxx
  /* eslint-disable no-bitwise */
  hash[6] = ((hash[6]! & 0x0f) | 0x50);
  hash[8] = ((hash[8]! & 0x3f) | 0x80);
  /* eslint-enable no-bitwise */
  const h = bytesToHex(hash.subarray(0, 16));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ─── Array element schema navigation ─────────────────────────────────────────

/**
 * Spec: specs/associations.md §9 — navigate the nested FieldType of a parent entity
 * to extract the leaf-level FieldDescriptor map for expanded array elements.
 *
 * Example: chain [{arrayPath:'lines'},{arrayPath:'components'}]
 *   schema['lines'].type.items.properties['components'].type.items.properties
 *
 * Returns undefined when the schema does not declare the array or when the item
 * type is not an object. _extractRefsFromData handles undefined gracefully.
 */
export function getArrayElementSchema(
  entityDef: EntityDefinition | undefined,
  chain: { arrayPath: string }[],
): Record<string, FieldDescriptor> | undefined {
  if (!entityDef?.schema) return undefined;
  let props: Record<string, FieldDescriptor> | undefined = entityDef.schema;
  for (const level of chain) {
    const fd: FieldDescriptor | undefined = props?.[level.arrayPath];
    if (!fd) return undefined;
    const ft: FieldType | undefined = fd.type;
    if (!ft || typeof ft !== 'object' || ft.type !== 'array') return undefined;
    const { items }: { items?: FieldType } = ft;
    if (!items || typeof items !== 'object' || items.type !== 'object') return undefined;
    props = items.properties;
  }
  return props;
}

// ─── Array expander ────────────────────────────────────────────────────────────

/**
 * Spec: specs/field-mapping.md §3.2 — forward pass array expander.
 *
 * If `member` has an `arrayPath`, expands `record` into one ReadRecord per array
 * element.  Returns `[record]` unchanged when no expansion is needed.
 *
 * Identity formula: `<parentId>#<arrayPath>[<elementKeyValue | index>]`
 * Fields listed in `member.parentFields` are merged into each element
 * (element fields win on collision).
 */
export function expandArrayRecord(
  record: ReadRecord,
  member: ChannelMember,
): ReadRecord[] {
  if (!member.arrayPath) return [record];

  const rawData = record.data as Record<string, unknown>;

  // 1. Resolve array at dotted path
  const parts = member.arrayPath.split(".");
  let node: unknown = rawData;
  for (const part of parts) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      node = undefined;
      break;
    }
    node = (node as Record<string, unknown>)[part];
  }

  // If stored as a JSON string, parse it
  if (typeof node === "string") {
    try { node = JSON.parse(node); } catch { node = undefined; }
  }

  if (!Array.isArray(node)) {
    // Graceful degradation — treat containing record as a flat record (no expansion)
    if (node !== undefined) {
      console.warn(
        `[opensync] array-expander: expected array at "${member.arrayPath}" on record "${record.id}" ` +
        `but got ${typeof node}. Treating as flat record.`,
      );
    }
    return [record];
  }

  if (node.length === 0) return [];

  // 2. Build parent scope from parentFields
  const parentScope: Record<string, unknown> = {};
  if (member.parentFields) {
    for (const [alias, ref] of Object.entries(member.parentFields)) {
      if (typeof ref === "string") {
        // String shorthand: alias → source field name on parent
        parentScope[alias] = rawData[ref];
      } else {
        // Object ref: { path?, field }
        let parentNode: unknown = rawData;
        if (ref.path) {
          for (const p of ref.path.split(".")) {
            if (parentNode === null || typeof parentNode !== "object" || Array.isArray(parentNode)) {
              parentNode = undefined;
              break;
            }
            parentNode = (parentNode as Record<string, unknown>)[p];
          }
        }
        parentScope[alias] = parentNode !== undefined && typeof parentNode === "object" && !Array.isArray(parentNode)
          ? (parentNode as Record<string, unknown>)[ref.field]
          : parentNode;
      }
    }
  }

  // 3. Expand elements
  const childRecords: ReadRecord[] = [];
  const parentId = record.id;

  for (let i = 0; i < node.length; i++) {
    const element = node[i];

    // Spec: specs/field-mapping.md §3.3 — scalar array mode
    const isScalar = member.scalar === true;
    if (!isScalar) {
      if (element === null || typeof element !== 'object' || Array.isArray(element)) {
        // Skip non-object elements (use scalar: true for bare-scalar arrays)
        continue;
      }
    } else {
      // Scalar: skip null and undefined
      if (element === null || element === undefined) continue;
    }

    let elementObj: Record<string, unknown>;
    let elementKeyValue: string;

    if (isScalar) {
      // Spec: specs/field-mapping.md §3.3 — wrap scalar as { _value: element }
      elementObj = { _value: element };
      // Element identity is the string form of the scalar value (set semantics — duplicates deduplicated)
      elementKeyValue = String(element);
    } else if (
      typeof element === 'object' &&
      element !== null &&
      ELEMENT_RECORD in (element as object) &&
      (element as Record<symbol, unknown>)[ELEMENT_RECORD] === true
    ) {
      // Spec: specs/connector-sdk.md § ElementRecord — connector-supplied element wrapper.
      // Provides a runtime-computed identity key and carries Ref values in data.
      const er = element as import("@opensync/sdk").ElementRecord;
      elementObj = er.data;
      if (er.id != null) {
        elementKeyValue = er.id;
      } else if (member.elementKey && member.elementKey in er.data) {
        elementKeyValue = String(er.data[member.elementKey]);
      } else {
        elementKeyValue = String(i);
      }
    } else {
      elementObj = element as Record<string, unknown>;
      elementKeyValue =
        member.elementKey !== undefined && member.elementKey in elementObj
          ? String(elementObj[member.elementKey])
          : String(i);
    }

    // Spec: plans/engine/PLAN_ELEMENT_FILTER.md §3.2 — forward filter.
    // For scalar members, `element` binding is the raw scalar value (not the wrapped object).
    const filterArg = isScalar ? element : elementObj;
    if (member.elementFilter && !member.elementFilter(filterArg, rawData, i)) {
      continue;
    }

    const childId = `${parentId}#${member.arrayPath}[${elementKeyValue}]`;

    // Merge parent scope into element (element fields win on collision)
    const mergedData: Record<string, unknown> = { ...parentScope, ...elementObj };

    // Spec: specs/field-mapping.md §6.2 — CRDT ordinal: inject _ordinal from source position
    if (member.crdtOrder) {
      mergedData["_ordinal"] = i;
    }

    // Spec: specs/field-mapping.md §6.3 — CRDT linked-list: inject _prev / _next pointers
    if (member.crdtLinkedList) {
      const keyFn = (el: unknown): string | null => {
        if (el === null || el === undefined) return null;
        if (isScalar) return String(el);
        if (typeof el === "object" && !Array.isArray(el) && member.elementKey) {
          const v = (el as Record<string, unknown>)[member.elementKey];
          return v !== undefined ? String(v) : null;
        }
        return null;
      };
      const prevEl = i > 0 ? node[i - 1] : undefined;
      const nextEl = i < node.length - 1 ? node[i + 1] : undefined;
      mergedData["_prev"] = prevEl !== undefined ? (keyFn(prevEl) ?? String(i - 1)) : null;
      mergedData["_next"] = nextEl !== undefined ? (keyFn(nextEl) ?? String(i + 1)) : null;
    }

    childRecords.push({ id: childId, data: mergedData });
  }

  return childRecords;
}

// ─── Multi-level expansion (§3.4) ─────────────────────────────────────────────

/**
 * Extract element key values from a compound child ID, one per chain level.
 * e.g. id="ord1#lines[L01]#components[C01]", chain=[{arrayPath:"lines"},{arrayPath:"components"}]
 * → ["L01", "C01"]
 *
 * Peels the ID from the right, matching `#arrayPath[key]` for each level.
 * Falls back to the level index if a segment can't be found.
 */
export function extractHopKeys(childId: string, chain: ExpansionChainLevel[]): string[] {
  const keys: string[] = new Array(chain.length) as string[];
  let remaining = childId;
  for (let i = chain.length - 1; i >= 0; i--) {
    const marker = `#${chain[i]!.arrayPath}[`;
    const pos = remaining.lastIndexOf(marker);
    if (pos === -1) {
      keys[i] = String(i);
    } else {
      const afterMarker = remaining.slice(pos + marker.length);
      const closeIdx = afterMarker.indexOf("]");
      keys[i] = closeIdx !== -1 ? afterMarker.slice(0, closeIdx) : String(i);
      remaining = remaining.slice(0, pos);
    }
  }
  return keys;
}

/**
 * Spec: specs/field-mapping.md §3.4 — multi-level cross-join expansion.
 *
 * Expands `record` through the full `chain`, producing one leaf ReadRecord per
 * cross-product element.  For chain.length === 1 this is identical to
 * expandArrayRecord (single-level, §3.2 degenerate case).
 *
 * Leaf record IDs: `parentId#level0Path[key0]#level1Path[key1]…`
 *
 * `elementFilter` is applied at the leaf level only (from the calling ChannelMember).
 */
export function expandArrayChain(
  record: ReadRecord,
  chain: ExpansionChainLevel[],
  elementFilter?: (element: unknown, parent: unknown, index: number) => boolean,
): ReadRecord[] {
  if (chain.length === 0) return [record];

  const level = chain[0]!;

  // Expand this level — apply filter only at the leaf (last) level
  const isLeaf = chain.length === 1;
  const intermediate = expandArrayRecord(record, {
    connectorId: "",
    entity: "",
    arrayPath: level.arrayPath,
    elementKey: level.elementKey,
    parentFields: level.parentFields,
    scalar: level.scalar,
    crdtOrder: isLeaf ? level.crdtOrder : undefined,
    crdtLinkedList: isLeaf ? level.crdtLinkedList : undefined,
    elementFilter: isLeaf ? elementFilter : undefined,
  });

  if (isLeaf) return intermediate;

  // Multi-level: recurse into each intermediate record with the remaining chain
  const results: ReadRecord[] = [];
  for (const inter of intermediate) {
    results.push(...expandArrayChain(inter, chain.slice(1), elementFilter));
  }
  return results;
}

/**
 * Spec: specs/field-mapping.md §3.4 — patch a nested array element in place.
 *
 * Navigates `rootData` using `hops` (each hop: arrayPath + elementKeyValue).
 * Uses the element key FIELD NAME from `chain` to locate the matching element.
 * Merges `localPatch` into the matching leaf element.
 *
 * Returns true if the element was found and patched, false otherwise.
 */
export function patchNestedElement(
  rootData: Record<string, unknown>,
  hops: { arrayPath: string; elementKey: string }[],
  chain: ExpansionChainLevel[],
  localPatch: Record<string, unknown>,
): boolean {
  if (hops.length === 0) return false;

  let current: Record<string, unknown> = rootData;

  // Navigate intermediate hops (all except the last)
  for (let i = 0; i < hops.length - 1; i++) {
    const hop = hops[i]!;
    const fieldName = chain.find((l) => l.arrayPath === hop.arrayPath)?.elementKey;
    const arr = current[hop.arrayPath];
    if (!Array.isArray(arr)) return false;
    const idx = arr.findIndex(
      (el: unknown) =>
        el !== null &&
        typeof el === "object" &&
        !Array.isArray(el) &&
        String((el as Record<string, unknown>)[fieldName ?? ""]) === hop.elementKey,
    );
    if (idx === -1) return false;
    current = arr[idx] as Record<string, unknown>;
  }

  // Leaf hop: find and patch the element
  const lastHop = hops[hops.length - 1]!;
  const leafFieldName = chain.find((l) => l.arrayPath === lastHop.arrayPath)?.elementKey;
  const arr = current[lastHop.arrayPath];
  if (!Array.isArray(arr)) return false;
  const idx = arr.findIndex(
    (el: unknown) =>
      el !== null &&
      typeof el === "object" &&
      !Array.isArray(el) &&
      String((el as Record<string, unknown>)[leafFieldName ?? ""]) === lastHop.elementKey,
  );
  if (idx === -1) return false;

  arr[idx] = { ...(arr[idx] as Record<string, unknown>), ...localPatch };
  return true;
}

// ─── Array ordering utilities (specs/field-mapping.md §6) ────────────────────

/**
 * Strip CRDT synthetic fields from each element before write-back.
 * If a field is explicitly mapped in outbound, the user wants it preserved.
 * Spec: specs/field-mapping.md §6.2/§6.3
 */
function stripCrdtFields(
  arr: Record<string, unknown>[],
  member: Pick<ChannelMember, "crdtOrder" | "crdtLinkedList" | "outbound">,
): void {
  const mappedFields = new Set(member.outbound?.map((f) => f.source) ?? []);
  for (const el of arr) {
    if (member.crdtOrder && !mappedFields.has("_ordinal")) delete el["_ordinal"];
    if (member.crdtLinkedList && !mappedFields.has("_prev")) delete el["_prev"];
    if (member.crdtLinkedList && !mappedFields.has("_next")) delete el["_next"];
  }
}

/**
 * Spec: specs/field-mapping.md §6 — Apply post-collapse ordering to the leaf array.
 *
 * Navigates `rootData` through `chain` to reach the leaf array, then sorts it
 * according to the ordering configuration on `member`.  Modifies the array in place.
 *
 * Only one of orderBy / crdtOrder / crdtLinkedList should be set on `member`
 * (mutual exclusion enforced at config-load time).
 *
 * Strips CRDT synthetic fields after sorting so they don't reach the target connector
 * unless explicitly mapped via outbound.
 */
export function applySortToLeafArray(
  rootData: Record<string, unknown>,
  chain: ExpansionChainLevel[],
  member: Pick<ChannelMember, "orderBy" | "crdtOrder" | "crdtLinkedList" | "elementKey" | "outbound">,
): void {
  if (!member.orderBy?.length && !member.crdtOrder && !member.crdtLinkedList) return;

  // Navigate to the leaf array through intermediate hops
  let node: Record<string, unknown> = rootData;
  for (let i = 0; i < chain.length - 1; i++) {
    const hop = chain[i]!;
    const arr = node[hop.arrayPath];
    if (!Array.isArray(arr) || arr.length === 0) return;
    // Pick the first element as the intermediate (for multi-level, the caller already
    // isolated the specific root so the array has exactly one matching parent).
    // If elementKey is defined on the hop, we could navigate precisely, but for the
    // current collapse-batch model (one root per call) the first element is always correct.
    const first = arr[0];
    if (first === null || typeof first !== "object" || Array.isArray(first)) return;
    node = first as Record<string, unknown>;
  }

  const leafLevel = chain[chain.length - 1]!;
  const leafArr = node[leafLevel.arrayPath];
  if (!Array.isArray(leafArr)) return;

  const elems = leafArr as Record<string, unknown>[];

  if (member.orderBy?.length) {
    // Spec: §6.1 — multi-key custom sort
    elems.sort((a, b) => {
      for (const key of member.orderBy!) {
        const av = a[key.field];
        const bv = b[key.field];
        const an = Number(av), bn = Number(bv);
        let cmp: number;
        if (Number.isFinite(an) && Number.isFinite(bn)) {
          cmp = an - bn;
        } else {
          cmp = String(av ?? "").localeCompare(String(bv ?? ""));
        }
        if (cmp !== 0) return key.direction === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  } else if (member.crdtOrder) {
    // Spec: §6.2 — sort by _ordinal ascending; elements without _ordinal sort last
    elems.sort((a, b) => {
      const ao = a["_ordinal"], bo = b["_ordinal"];
      if (ao === undefined && bo === undefined) return 0;
      if (ao === undefined) return 1;
      if (bo === undefined) return -1;
      return Number(ao) - Number(bo);
    });
    stripCrdtFields(elems, member);
  } else if (member.crdtLinkedList) {
    // Spec: §6.3 — linked-list reconstruction from _prev / _next pointers
    // Build a map from elementKey value → element
    const keyField = member.elementKey;
    const keyOf = (el: Record<string, unknown>): string => {
      if (keyField) return String(el[keyField] ?? "");
      // fall back to _prev/_next sibling detection by position
      return "";
    };

    const byKey = new Map<string, Record<string, unknown>>();
    const keyList: string[] = [];
    for (const el of elems) {
      const k = keyOf(el);
      if (k) { byKey.set(k, el); keyList.push(k); }
    }

    if (byKey.size === 0) {
      // No keys — can't reconstruct; leave in place
      stripCrdtFields(elems, member);
      return;
    }

    // Find the head: element whose _prev is null or not in the map
    let headKey: string | undefined;
    for (const [k, el] of byKey) {
      const prev = el["_prev"];
      if (prev === null || prev === undefined || !byKey.has(String(prev))) {
        headKey = k;
        break;
      }
    }
    if (!headKey) headKey = keyList[0]; // cycle guard fallback

    // Walk the chain
    const ordered: Record<string, unknown>[] = [];
    const visited = new Set<string>();
    let cursor: string | null | undefined = headKey;
    while (cursor && byKey.has(cursor) && !visited.has(cursor)) {
      const el: Record<string, unknown> = byKey.get(cursor)!;
      ordered.push(el);
      visited.add(cursor);
      const next: unknown = el["_next"];
      cursor = (next !== null && next !== undefined) ? String(next) : null;
    }

    // Append any elements not reached (broken chain or cycle guard)
    for (const [k, el] of byKey) {
      if (!visited.has(k)) ordered.push(el);
    }

    // Replace in-place
    for (let i = 0; i < ordered.length; i++) elems[i] = ordered[i]!;

    stripCrdtFields(elems, member);
  }
}
