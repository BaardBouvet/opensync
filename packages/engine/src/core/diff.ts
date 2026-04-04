// Spec: specs/sync-engine.md § Diff Engine
// Pure function: compare incoming canonical record against source shadow state.

import type { FieldData } from "../db/schema.js";

export type DiffAction = "insert" | "update" | "skip";

/** Compare an incoming canonical record against the stored shadow for that record.
 *  Returns "insert" if there is no shadow, "skip" if nothing changed, "update" otherwise.
 *  Spec: specs/sync-engine.md § Diff Engine */
export function diff(
  incoming: Record<string, unknown>,
  shadow: FieldData | undefined,
  assocSentinel: string | undefined,
): DiffAction {
  if (shadow === undefined) return "insert";

  // Check field equality
  const shadowKeys = Object.keys(shadow).filter((k) => k !== "__assoc__");
  const incomingKeys = Object.keys(incoming);

  if (incomingKeys.length !== shadowKeys.length) return "update";

  for (const [k, v] of Object.entries(incoming)) {
    const entry = shadow[k];
    if (!entry) return "update";
    if (JSON.stringify(entry.val) !== JSON.stringify(v)) return "update";
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
