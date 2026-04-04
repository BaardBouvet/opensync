// Spec: specs/sync-engine.md § Conflict Resolution, specs/safety.md
// Pure function: decide which fields to accept for a target connector.

import type { FieldData } from "../db/schema.js";
import type { ConflictConfig } from "../config/loader.js";

/** Apply conflict resolution rules, returning only the fields that are accepted.
 *  An empty result means nothing should be written to the target.
 *  Spec: specs/sync-engine.md § Conflict Resolution */
export function resolveConflicts(
  incoming: Record<string, unknown>,
  targetShadow: FieldData | undefined,
  incomingSrc: string,
  incomingTs: number,
  config: ConflictConfig,
): Record<string, unknown> {
  // New record in target — accept everything
  if (!targetShadow) return incoming;

  const resolved: Record<string, unknown> = {};

  for (const [field, incomingVal] of Object.entries(incoming)) {
    const existing = targetShadow[field];

    if (!existing) {
      // Field new to target — accept
      resolved[field] = incomingVal;
      continue;
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
