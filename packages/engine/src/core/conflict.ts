// Spec: specs/sync-engine.md § Conflict Resolution, specs/safety.md
// Pure function: decide which fields to accept for a target connector.

import type { FieldData } from "../db/schema.js";
import type { ConflictConfig, FieldMappingList } from "../config/loader.js";

/** Apply conflict resolution rules, returning only the fields that are accepted.
 *  An empty result means nothing should be written to the target.
 *  @param fieldMappings Optional. Used for:
 *    - normalize (§1.4): lower-fidelity sources whose normalized value matches the golden
 *      record do not win resolution.
 *    - group (§1.8): fields sharing the same group label are resolved atomically from
 *      whichever source wins the group.
 *  Spec: specs/sync-engine.md § Conflict Resolution,
 *        specs/field-mapping.md §1.4, specs/field-mapping.md §1.8 */
export function resolveConflicts(
  incoming: Record<string, unknown>,
  targetShadow: FieldData | undefined,
  incomingSrc: string,
  incomingTs: number,
  config: ConflictConfig,
  fieldMappings?: FieldMappingList,
): Record<string, unknown> {
  // New record in target — accept everything
  if (!targetShadow) return incoming;

  // ─── Group pre-pass (§1.8) ────────────────────────────────────────────────
  // Collect the set of group labels present in incoming and elect a winning source per group.
  // A group winner is determined by the channel-level conflict strategy applied to the
  // group's aggregate timestamp (max across all group fields from the existing shadow).
  const groupWinner = new Map<string, boolean>(); // true = incoming wins the group
  if (fieldMappings) {
    const groupLabels = new Set(
      fieldMappings.filter((m) => m.group && Object.prototype.hasOwnProperty.call(incoming, m.target)).map((m) => m.group!),
    );
    for (const label of groupLabels) {
      const groupFields = fieldMappings.filter((m) => m.group === label);
      // Max existing timestamp across all group fields in the shadow
      let existingGroupTs = -Infinity;
      let existingGroupSrc: string | undefined;
      for (const m of groupFields) {
        const e = targetShadow[m.target];
        if (e && e.ts > existingGroupTs) {
          existingGroupTs = e.ts;
          existingGroupSrc = e.src;
        }
      }
      // No shadow entry for any group field → incoming wins unconditionally
      if (existingGroupTs === -Infinity) { groupWinner.set(label, true); continue; }

      // Elect winner using the global conflict strategy
      if (config.connectorPriorities) {
        // coalesce-style: priority takes precedence; timestamps break ties
        const inPri = config.connectorPriorities[incomingSrc] ?? Number.MAX_SAFE_INTEGER;
        const exPri = (existingGroupSrc && config.connectorPriorities[existingGroupSrc]) ?? Number.MAX_SAFE_INTEGER;
        groupWinner.set(label, inPri < exPri || (inPri === exPri && incomingTs >= existingGroupTs));
      } else {
        // last_modified / lww (default)
        groupWinner.set(label, incomingTs >= existingGroupTs);
      }
    }
  }

  const resolved: Record<string, unknown> = {};

  for (const [field, incomingVal] of Object.entries(incoming)) {
    const existing = targetShadow[field];

    if (!existing) {
      // ─── Group check: new field with no shadow ────────────────────────────
      const groupLabel = fieldMappings?.find((m) => m.target === field)?.group;
      if (groupLabel !== undefined) {
        // The group winner was elected above; respect it even for new fields
        if (groupWinner.get(groupLabel) === false) continue;
      }
      resolved[field] = incomingVal;
      continue;
    }

    // ─── Group atomic gate (§1.8) ─────────────────────────────────────────
    const groupLabel = fieldMappings?.find((m) => m.target === field)?.group;
    if (groupLabel !== undefined) {
      if (groupWinner.get(groupLabel)) resolved[field] = incomingVal;
      // else: losing source yields this group field — don't touch it
      continue;
    }

    // ─── Normalize precision-loss guard (§1.4) ────────────────────────────
    const normalizer = fieldMappings?.find((m) => m.target === field)?.normalize;
    if (normalizer) {
      if (JSON.stringify(normalizer(incomingVal)) === JSON.stringify(normalizer(existing.val))) {
        // Lower-fidelity source matches canonical when normalized — do not overwrite.
        continue;
      }
    }

    // Per-field strategy override
    const fieldStrategy = config.fieldStrategies?.[field];
    if (fieldStrategy) {
      switch (fieldStrategy.strategy) {
        case "last_modified":
          if (incomingTs >= existing.ts) resolved[field] = incomingVal;
          break;
        case "coalesce": {
          const inPri = config.connectorPriorities?.[incomingSrc] ?? Number.MAX_SAFE_INTEGER;
          const exPri = config.connectorPriorities?.[existing.src] ?? Number.MAX_SAFE_INTEGER;
          if (inPri < exPri || (inPri === exPri && incomingTs >= existing.ts)) {
            resolved[field] = incomingVal;
          }
          break;
        }
        case "collect": {
          const arr = Array.isArray(existing.val) ? existing.val : [existing.val];
          resolved[field] = arr.includes(incomingVal) ? arr : [...arr, incomingVal];
          break;
        }
      }
      continue;
    }

    // field_master check
    if (config.fieldMasters?.[field]) {
      if (config.fieldMasters[field] === incomingSrc) {
        resolved[field] = incomingVal;
      }
      continue;
    }

    // Global strategy — default LWW
    if (incomingTs >= existing.ts) {
      resolved[field] = incomingVal;
    }
  }

  return resolved;
}
