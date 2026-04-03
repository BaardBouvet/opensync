/**
 * OpenSync POC v4 — Conflict resolution
 *
 * Placed between diff and dispatch in the ingest loop:
 *
 *   diff → resolveConflicts(changes, shadow, config) → dispatch
 *
 * Global strategies (apply to all fields unless overridden by fieldStrategies):
 *   - lww (last-write-wins): higher ts wins. If incoming ts >= shadow ts the
 *     incoming value is accepted; otherwise the field is dropped.
 *   - field_master: a named connector always wins for that field, regardless
 *     of timestamp. Fields not listed fall back to LWW.
 *
 * Per-field strategies (override global strategy for a specific field):
 *   - coalesce: lower connectorPriority number wins; last_modified is tiebreaker
 *   - last_modified: higher ts wins (same as LWW but declared explicitly per field)
 *   - collect: accumulates values from all connectors as an array
 *
 * Returns a filtered/merged canonical record ready for dispatch.
 */

import type { FieldData } from "./db.js";

// ─── Config ───────────────────────────────────────────────────────────────────

export type ConflictStrategy = "lww" | "field_master";

/**
 * Per-field strategy override. Applied before the global strategy.
 *   coalesce     — lower priority number wins (connectorPriorities map required);
 *                  last_modified used as tiebreaker for equal priority
 *   last_modified — higher ts wins
 *   collect       — accumulate all connector values into an array
 */
export type FieldStrategy =
  | { strategy: "coalesce" }
  | { strategy: "last_modified" }
  | { strategy: "collect" };

export interface ConflictConfig {
  strategy: ConflictStrategy;
  /**
   * `field_master` only.
   * Map of canonical field name → connectorId that always wins for that field.
   * Fields not listed fall back to LWW.
   */
  fieldMasters?: Record<string, string>;
  /**
   * Per-connector priority for the `coalesce` field strategy.
   * Lower number = higher priority (wins conflict). Connectors not listed get
   * a default priority of Number.MAX_SAFE_INTEGER (always loses).
   */
  connectorPriorities?: Record<string, number>;
  /**
   * Per-field strategy overrides. When a field is listed here its entry takes
   * precedence over the global `strategy` and `fieldMasters`.
   */
  fieldStrategies?: Record<string, FieldStrategy>;
}

// ─── Field change descriptor (pre-resolution) ─────────────────────────────────

export interface PendingFieldChange {
  field: string;
  incomingVal: unknown;
  incomingTs: number;
  incomingSrc: string;
}

// ─── Resolution ───────────────────────────────────────────────────────────────

/**
 * Given the incoming canonical values and the current shadow for the target
 * connector, return the set of fields that should actually be written.
 *
 * @param incoming       Plain canonical record from the ingest read (post-rename)
 * @param targetShadow   Current FieldData for this record in the target connector
 * @param incomingSrc    connectorId that produced `incoming`
 * @param incomingTs     Epoch ms timestamp for the ingest pass (same for all fields)
 * @param config         Conflict resolution configuration
 * @returns Filtered/merged canonical record — only fields that won resolution
 */
export function resolveConflicts(
  incoming: Record<string, unknown>,
  targetShadow: FieldData | undefined,
  incomingSrc: string,
  incomingTs: number,
  config: ConflictConfig,
): Record<string, unknown> {
  if (!targetShadow) {
    // New record — no conflict possible, accept everything.
    return incoming;
  }

  const resolved: Record<string, unknown> = {};

  for (const [field, incomingVal] of Object.entries(incoming)) {
    const existing = targetShadow[field];

    if (!existing) {
      // Field doesn't exist yet in target shadow — accept it.
      resolved[field] = incomingVal;
      continue;
    }

    // ── Per-field strategy override ──────────────────────────────────────────
    const fieldStrategy = config.fieldStrategies?.[field];
    if (fieldStrategy) {
      switch (fieldStrategy.strategy) {
        case "last_modified":
          if (incomingTs >= existing.ts) resolved[field] = incomingVal;
          break;

        case "coalesce": {
          const incomingPriority = config.connectorPriorities?.[incomingSrc] ?? Number.MAX_SAFE_INTEGER;
          const existingPriority = config.connectorPriorities?.[existing.src] ?? Number.MAX_SAFE_INTEGER;
          if (incomingPriority < existingPriority) {
            resolved[field] = incomingVal;
          } else if (incomingPriority === existingPriority && incomingTs >= existing.ts) {
            // Equal priority — fall back to last_modified as tiebreaker
            resolved[field] = incomingVal;
          }
          break;
        }

        case "collect": {
          // Accumulate all source values as an array.
          const existingArr = Array.isArray(existing.val) ? existing.val : [existing.val];
          if (!existingArr.includes(incomingVal)) {
            resolved[field] = [...existingArr, incomingVal];
          } else {
            resolved[field] = existingArr; // already collected, no duplicate
          }
          break;
        }
      }
      continue;
    }

    // ── Global strategy ──────────────────────────────────────────────────────

    // field_master check (overrides global strategy for this field)
    if (config.strategy === "field_master" || config.fieldMasters?.[field]) {
      const master = config.fieldMasters?.[field];
      if (master !== undefined) {
        if (master === incomingSrc) {
          resolved[field] = incomingVal;
        }
        // else: master is someone else — drop this field from dispatch
        continue;
      }
      // field_master strategy but no master configured for this field → fall through to LWW
    }

    // LWW: accept if incoming timestamp is >= existing timestamp
    if (incomingTs >= existing.ts) {
      resolved[field] = incomingVal;
    }
    // else: existing is newer — drop this field
  }

  return resolved;
}
