// Spec: specs/sync-engine.md § Diff Engine
// Pure function: compare incoming canonical record against source shadow state.

import type { FieldData } from "../db/schema.js";

export type DiffAction = "insert" | "update" | "skip";

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
 *  Fields without a normalize function are omitted.
 *  Spec: specs/field-mapping.md §1.4 */
export function buildNormalizers(
  mappings: { target: string; normalize?: (v: unknown) => unknown }[] | undefined,
): Map<string, (v: unknown) => unknown> | undefined {
  if (!mappings) return undefined;
  const map = new Map<string, (v: unknown) => unknown>();
  for (const m of mappings) {
    if (m.normalize) map.set(m.target, m.normalize);
  }
  return map.size > 0 ? map : undefined;
}
