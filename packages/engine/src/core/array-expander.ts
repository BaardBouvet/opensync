// Spec: specs/field-mapping.md §3.2/§3.4 — nested array expansion forward pass
import { createHash } from "node:crypto";
import type { ReadRecord } from "@opensync/sdk";
import type { ChannelMember, ExpansionChainLevel } from "../config/loader.js";
export type { ExpansionChainLevel };

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
  const hash = createHash("sha256").update(input, "utf8").digest();
  // Use first 16 bytes; set version=5, variant=0b10xx_xxxx
  hash[6] = ((hash[6]! & 0x0f) | 0x50);
  hash[8] = ((hash[8]! & 0x3f) | 0x80);
  const h = hash.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
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
    if (element === null || typeof element !== 'object' || Array.isArray(element)) {
      // Skip non-object elements (scalar arrays not yet supported)
      continue;
    }
    const elementObj = element as Record<string, unknown>;

    // Spec: plans/engine/PLAN_ELEMENT_FILTER.md §3.2 — forward filter
    if (member.elementFilter && !member.elementFilter(elementObj, rawData, i)) {
      continue;
    }

    // Stable element identity
    const elementKeyValue =
      member.elementKey !== undefined && member.elementKey in elementObj
        ? String(elementObj[member.elementKey])
        : String(i);

    const childId = `${parentId}#${member.arrayPath}[${elementKeyValue}]`;

    // Merge parent scope into element (element fields win on collision)
    const mergedData: Record<string, unknown> = { ...parentScope, ...elementObj };

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
