// Spec: specs/field-mapping.md, specs/sync-engine.md § Field Mapping
// Pure field-mapping helpers.

import type { ReadRecord } from "@opensync/sdk";
import type { FieldData } from "../db/schema.js";
import type { FieldMappingList } from "../config/loader.js";

/** Apply inbound (source → canonical) or outbound (canonical → target) rename.
 *  If no mappings are declared, all fields pass through verbatim (whitelist not applied).
 *  If mappings are declared, only listed fields appear in the result (whitelist semantics).
 *  Spec: specs/config.md § Field whitelist semantics
 *  Spec: specs/field-mapping.md §1.3 — expression / reverseExpression
 *  Spec: specs/field-mapping.md §1.5 — default / defaultExpression */
export function applyMapping(
  data: Record<string, unknown>,
  mappings: FieldMappingList | undefined,
  pass: "inbound" | "outbound",
): Record<string, unknown> {
  if (!mappings || mappings.length === 0) return { ...data };

  const result: Record<string, unknown> = {};
  for (const m of mappings) {
    const dir = m.direction ?? "bidirectional";
    if (pass === "inbound") {
      if (dir === "forward_only") continue;
      // Spec: specs/field-mapping.md §1.3 — expression takes precedence over source rename
      let value: unknown;
      if (m.expression) {
        value = m.expression(data);
      } else {
        const sourceKey = m.source ?? m.target;
        value = Object.prototype.hasOwnProperty.call(data, sourceKey) ? data[sourceKey] : undefined;
      }
      // Spec: specs/field-mapping.md §1.5 — apply default when value is null/undefined
      if (value === null || value === undefined) {
        if (m.defaultExpression) {
          value = m.defaultExpression(result);   // result holds fields already written this pass
        } else if (m.default !== undefined) {
          value = m.default;
        }
      }
      if (value !== undefined) {
        result[m.target] = value;
      }
    } else {
      if (dir === "reverse_only") continue;
      // Spec: specs/field-mapping.md §1.3 — reverseExpression: object → decompose, scalar → assign
      if (m.reverseExpression) {
        const v = m.reverseExpression(data);
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          Object.assign(result, v as Record<string, unknown>);
        } else {
          result[m.source ?? m.target] = v;
        }
      } else {
        const sourceKey = m.source ?? m.target;
        if (Object.prototype.hasOwnProperty.call(data, m.target)) {
          result[sourceKey] = data[m.target];
        }
      }
    }
  }
  return result;
}

/** Returns true when any field with reverseRequired:true resolves to null/undefined in the
 *  outbound-mapped record, signalling that the dispatch to this target should be suppressed.
 *  Spec: specs/field-mapping.md §1.6 */
export function isDispatchBlocked(
  outboundRecord: Record<string, unknown>,
  mappings: FieldMappingList | undefined,
): boolean {
  if (!mappings) return false;
  for (const m of mappings) {
    if (!m.reverseRequired) continue;
    const key = m.source ?? m.target;
    const val = outboundRecord[key];
    if (val === null || val === undefined) return true;
  }
  return false;
}

// ─── Per-field timestamp helpers ──────────────────────────────────────────────

/**
 * Parse a value that may be epoch ms (number), ISO 8601 string, or anything else.
 * Returns epoch ms on success, undefined on failure or absence.
 * Spec: specs/field-mapping.md §7.2
 */
export function parseTs(v: unknown): number | undefined {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

/**
 * Compute a per-field timestamp map for one incoming source record.
 *
 * Priority chain:
 *   1. record.fieldTimestamps[field]   — connector-native per-field authority
 *   2. shadow derivation:
 *        unchanged field → carry forward shadow[field].ts
 *        changed field   → record.updatedAt (parsed) ?? ingestTs
 *   3. ingestTs — new record, no shadow
 *
 * Spec: specs/field-mapping.md §7.2
 */
export function computeFieldTimestamps(
  incoming: Record<string, unknown>,
  existingShadow: FieldData | undefined,
  record: ReadRecord,
  ingestTs: number,
): Record<string, number> {
  const baseTs = record.updatedAt ? (Date.parse(record.updatedAt) || ingestTs) : ingestTs;
  const result: Record<string, number> = {};
  for (const field of Object.keys(incoming)) {
    // 1. Connector-native per-field timestamp
    const native = parseTs(record.fieldTimestamps?.[field]);
    if (native !== undefined) { result[field] = native; continue; }
    // 2. Shadow derivation
    const entry = existingShadow?.[field];
    if (entry !== undefined && JSON.stringify(entry.val) === JSON.stringify(incoming[field])) {
      // Unchanged field: carry forward the shadow ts but never go below ingestTs.
      // This ensures that a source-shadow ts from an earlier collectOnly pass does not cause
      // LWW to lose against a target shadow ts that was written at a later ingestTs.
      result[field] = Math.max(entry.ts, ingestTs);
    } else {
      result[field] = baseTs;     // changed or new field
    }
  }
  return result;
}
