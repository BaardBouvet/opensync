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
 *  @param incomingFieldTimestamps Optional per-field timestamps from computeFieldTimestamps.
 *    When present, overrides the flat incomingTs for individual fields.
 *    Spec: specs/field-mapping.md §7.2
 *  @param incomingCreatedAt Optional epoch ms from record.createdAt for the incoming source.
 *    Enables origin_wins strategy and stable LWW tie-breaking.
 *    Spec: specs/field-mapping.md §2.N origin_wins
 *  @param createdAtBySrc Optional map of { connectorId → epoch ms } for all sources that
 *    have a stored created_at for this canonical entity. Used by origin_wins and LWW tie-break.
 *  Spec: specs/sync-engine.md § Conflict Resolution,
 *        specs/field-mapping.md §1.4, specs/field-mapping.md §1.8 */
export function resolveConflicts(
  incoming: Record<string, unknown>,
  targetShadow: FieldData | undefined,
  incomingSrc: string,
  incomingTs: number,
  config: ConflictConfig,
  fieldMappings?: FieldMappingList,
  incomingFieldTimestamps?: Record<string, number>,
  incomingCreatedAt?: number,
  createdAtBySrc?: Record<string, number>,
): Record<string, unknown> {
  // New record in target — accept everything
  if (!targetShadow) return incoming;

  // Per-field timestamp accessor: prefer computed per-field ts, fall back to flat incomingTs.
  // Spec: specs/field-mapping.md §7.2
  const fieldTs = (field: string): number => incomingFieldTimestamps?.[field] ?? incomingTs;

  // origin_wins helper: compare createdAt of incoming source vs the source that owns the
  // existing shadow entry. Returns true when incoming should win based on origin age.
  // Falls back to LWW (fieldTs) when createdAt info is unavailable for either side.
  // Spec: specs/field-mapping.md §2.N origin_wins
  const originWins = (field: string, existingSrc: string): boolean => {
    const inCa = incomingCreatedAt;
    const exCa = createdAtBySrc?.[existingSrc];
    if (inCa !== undefined && exCa !== undefined) {
      if (inCa !== exCa) return inCa < exCa; // earlier creation = true origin
      // Equal createdAt — fall through to LWW
    } else if (inCa !== undefined && exCa === undefined) {
      return true;  // incoming has createdAt, existing doesn't — incoming wins
    } else if (inCa === undefined && exCa !== undefined) {
      return false; // existing has createdAt, incoming doesn't — existing wins
    }
    // Neither has createdAt — fall back to LWW
    return fieldTs(field) >= (targetShadow[field]?.ts ?? -Infinity);
  };

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
      if (config.strategy === "origin_wins") {
        // For groups, use min createdAt across group fields (the "oldest" group member wins)
        const inCa = incomingCreatedAt;
        const exCa = existingGroupSrc ? createdAtBySrc?.[existingGroupSrc] : undefined;
        if (inCa !== undefined && exCa !== undefined) {
          groupWinner.set(label, inCa <= exCa);
        } else if (inCa !== undefined) {
          groupWinner.set(label, true);
        } else if (exCa !== undefined) {
          groupWinner.set(label, false);
        } else {
          // Fall back to LWW for index: use max per-field ts across group fields
          let incomingGroupTs = -Infinity;
          for (const m of groupFields) {
            const t = incomingFieldTimestamps?.[m.target] ?? incomingTs;
            if (t > incomingGroupTs) incomingGroupTs = t;
          }
          groupWinner.set(label, incomingGroupTs >= existingGroupTs);
        }
      } else if (config.connectorPriorities) {
        // coalesce-style: priority takes precedence; timestamps break ties
        const inPri = config.connectorPriorities[incomingSrc] ?? Number.MAX_SAFE_INTEGER;
        const exPri = existingGroupSrc
          ? (config.connectorPriorities[existingGroupSrc] ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER;
        // Use max per-field ts across group fields as the group timestamp for incoming
        let incomingGroupTs = -Infinity;
        for (const m of groupFields) {
          const t = incomingFieldTimestamps?.[m.target] ?? incomingTs;
          if (t > incomingGroupTs) incomingGroupTs = t;
        }
        groupWinner.set(label, inPri < exPri || (inPri === exPri && incomingGroupTs >= existingGroupTs));
      } else {
        // last_modified / lww (default): use max per-field ts across group fields
        let incomingGroupTs = -Infinity;
        for (const m of groupFields) {
          const t = incomingFieldTimestamps?.[m.target] ?? incomingTs;
          if (t > incomingGroupTs) incomingGroupTs = t;
        }
        groupWinner.set(label, incomingGroupTs >= existingGroupTs);
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

    // Per-field resolve function (§2.3) — takes precedence over fieldStrategies and global LWW.
    // Spec: specs/field-mapping.md §2.3
    const resolverFn = fieldMappings?.find((m) => m.target === field)?.resolve;
    if (resolverFn) {
      resolved[field] = resolverFn(incomingVal, existing?.val);
      continue;
    }

    // Per-field strategy override
    const fieldStrategy = config.fieldStrategies?.[field];
    if (fieldStrategy) {
      switch (fieldStrategy.strategy) {
        case "last_modified": {
          const ft = fieldTs(field);
          if (ft > existing.ts) {
            resolved[field] = incomingVal;
          } else if (ft === existing.ts) {
            // On equal timestamps the original behaviour was to accept incoming (>=).
            // createdAt tie-breaking: if both sources have createdAt and the shadow's
            // source is older, shadow wins — otherwise incoming wins (preserving >=).
            // Spec: specs/field-mapping.md §2.2
            const inCa = incomingCreatedAt;
            const exCa = createdAtBySrc?.[existing.src];
            if (inCa !== undefined && exCa !== undefined && exCa < inCa) {
              // Shadow source is older — shadow wins; don't overwrite.
            } else {
              resolved[field] = incomingVal;
            }
          }
          break;
        }
        case "coalesce": {
          const inPri = config.connectorPriorities?.[incomingSrc] ?? Number.MAX_SAFE_INTEGER;
          const exPri = config.connectorPriorities?.[existing.src] ?? Number.MAX_SAFE_INTEGER;
          if (inPri < exPri || (inPri === exPri && fieldTs(field) >= existing.ts)) {
            resolved[field] = incomingVal;
          }
          break;
        }
        case "collect": {
          const arr = Array.isArray(existing.val) ? existing.val : [existing.val];
          resolved[field] = arr.includes(incomingVal) ? arr : [...arr, incomingVal];
          break;
        }
        case "bool_or": {
          // Spec: specs/field-mapping.md §2.5 — accumulates truthy values.
          // Once true, never reverts to false (other sources may have contributed true).
          const alreadyTrue = Boolean(existing.val);
          if (!alreadyTrue && Boolean(incomingVal)) {
            resolved[field] = true;
          }
          // If alreadyTrue: no change — shadow already holds true.
          // If neither truthy: no change — don't write false over a prior true.
          break;
        }
        case "origin_wins":
          if (originWins(field, existing.src)) resolved[field] = incomingVal;
          break;
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

    // Global strategy
    if (config.strategy === "origin_wins") {
      // Spec: specs/field-mapping.md §2.N origin_wins
      if (originWins(field, existing.src)) resolved[field] = incomingVal;
    } else {
      // Default LWW: incoming wins on equal timestamp (idempotent, preserves original >= semantics).
      // createdAt tie-breaking: when timestamps are equal and shadow's source is older, shadow wins.
      // Spec: specs/field-mapping.md §2.2
      const ft = fieldTs(field);
      if (ft > existing.ts) {
        resolved[field] = incomingVal;
      } else if (ft === existing.ts) {
        const inCa = incomingCreatedAt;
        const exCa = createdAtBySrc?.[existing.src];
        if (inCa !== undefined && exCa !== undefined && exCa < inCa) {
          // Shadow source is older — shadow wins; don't overwrite.
        } else {
          resolved[field] = incomingVal;
        }
      }
    }
  }

  return resolved;
}
