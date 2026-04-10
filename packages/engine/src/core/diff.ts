// Spec: specs/sync-engine.md § Diff Engine
// Pure function: compare incoming canonical record against source shadow state.

import type { FieldData } from "../db/schema.js";
import type { FieldDescriptor, FieldType } from "@opensync/sdk";

export type DiffAction = "insert" | "update" | "skip";

/** Spec: specs/field-mapping.md §3.5 — schema-guided recursive normalizer for diff comparison.
 *  Descends the FieldType tree. At every { type:"array", unordered:true } node it sorts
 *  elements by stable JSON representation. At every object node it recurses into declared
 *  properties. Result is used only for comparison — never written to shadow or dispatched. */
export function normalizeForDiff(value: unknown, fieldType: FieldType | undefined): unknown {
  if (!fieldType || typeof fieldType === "string") return value;

  if (fieldType.type === "array") {
    if (!Array.isArray(value)) return value;
    // Recursively normalize each element first (items schema may declare inner unordered arrays)
    const normalized = value.map((el) => normalizeForDiff(el, fieldType.items));
    if (fieldType.unordered) {
      return [...normalized].sort((a, b) => {
        const sa = JSON.stringify(a) ?? "";
        const sb = JSON.stringify(b) ?? "";
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
    }
    return normalized;
  }

  if (fieldType.type === "object" && fieldType.properties) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [k, desc] of Object.entries(fieldType.properties as Record<string, FieldDescriptor>)) {
      if (desc.type) out[k] = normalizeForDiff(out[k], desc.type);
    }
    return out;
  }

  return value;
}

/** Compare an incoming canonical record against the stored shadow for that record.
 *  Returns "insert" if there is no shadow, "skip" if nothing changed, "update" otherwise.
 *  @param normalizers Optional per-field normalize functions (keyed by canonical field name).
 *    When present, normalize(v) is applied to both sides before equality comparison.
 *    Spec: specs/field-mapping.md §1.4 — precision-loss noop.
 *  Spec: specs/sync-engine.md § Diff Engine */
export function diff(
  incoming: Record<string, unknown>,
  shadow: FieldData | undefined,
  assocSentinel: string | undefined,
  normalizers?: Map<string, (v: unknown) => unknown>,
): DiffAction {
  if (shadow === undefined) return "insert";

  // Check field equality
  const shadowKeys = Object.keys(shadow).filter((k) => k !== "__assoc__");
  const incomingKeys = Object.keys(incoming);

  if (incomingKeys.length !== shadowKeys.length) return "update";

  for (const [k, v] of Object.entries(incoming)) {
    const entry = shadow[k];
    if (!entry) return "update";
    const normalize = normalizers?.get(k);
    const lhs = normalize ? normalize(v) : v;
    const rhs = normalize ? normalize(entry.val) : entry.val;
    if (JSON.stringify(lhs) !== JSON.stringify(rhs)) return "update";
  }

  // Check association sentinel
  const existingAssoc = shadow["__assoc__"]?.val;
  if (assocSentinel !== undefined) {
    if (existingAssoc !== assocSentinel) return "update";
  } else {
    if (existingAssoc !== undefined) return "update";
  }

  return "skip";
}

/** Build a Map<fieldTarget, normalizeFn> from a FieldMappingList.
 *  Incorporates both the explicit `normalize` function (§1.4) and `sortElements: true` /
 *  the connector schema's `unordered: true` flag (§3.5).
 *  Fields without any normalization are omitted.
 *  Spec: specs/field-mapping.md §1.4, §3.5 */
export function buildNormalizers(
  mappings:
    | {
        target: string;
        normalize?: (v: unknown) => unknown;
        sortElements?: boolean;
      }[]
    | undefined,
  entitySchema?: Record<string, FieldDescriptor>,
): Map<string, (v: unknown) => unknown> | undefined {
  if (!mappings) return undefined;
  const map = new Map<string, (v: unknown) => unknown>();
  for (const m of mappings) {
    const fieldType = entitySchema?.[m.target]?.type;
    // Determine whether sort-before-compare is needed:
    // mapping-level sortElements OR schema-level unordered on the FieldType
    const needsSort =
      m.sortElements ||
      (fieldType && typeof fieldType === "object" && fieldType.type === "array" && fieldType.unordered);

    if (needsSort || m.normalize) {
      map.set(m.target, (v: unknown) => {
        // schema-guided recursive sort (honours nested unordered arrays)
        const sorted = needsSort
          ? normalizeForDiff(
              v,
              needsSort && fieldType
                ? fieldType
                : { type: "array" as const, unordered: true as const },
            )
          : v;
        // then apply any explicit normalize expression on top
        return m.normalize ? m.normalize(sorted) : sorted;
      });
    }
  }
  return map.size > 0 ? map : undefined;
}
