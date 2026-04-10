// Spec: specs/field-mapping.md, specs/sync-engine.md § Field Mapping
// Pure field-mapping helpers.

import type { ReadRecord } from "@opensync/sdk";
import type { FieldData } from "../db/schema.js";
import type { FieldMappingList } from "../config/loader.js";

/**
 * Walk a dotted-path with optional `[N]` array-index tokens and return the value at
 * that location, or `undefined` if any intermediate step is absent.
 *
 * Syntax supported:
 *   - `address.street`        — object key traversal
 *   - `metadata.tags[0]`      — array index within an object key
 *   - `lines[0].product_id`   — array index then key
 *
 * Only non-negative integer indices are recognised. Everything else is treated as a
 * plain object key. Missing intermediates resolve to `undefined` without throwing.
 *
 * Spec: specs/field-mapping.md §1.7
 */
export function resolveSourcePath(
  record: Record<string, unknown>,
  path: string,
): unknown {
  // Split on `.` first, then parse `key[N]` tokens within each segment.
  const segments = path.split(".");
  let current: unknown = record;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    // Handle trailing `[N]` on a segment (e.g. "tags[0]" or "lines[2]")
    const bracketIdx = seg.indexOf("[");
    if (bracketIdx !== -1) {
      const key = seg.slice(0, bracketIdx);
      const rest = seg.slice(bracketIdx);
      // Navigate into the object key first (if non-empty)
      if (key) {
        if (typeof current !== "object" || Array.isArray(current)) return undefined;
        current = (current as Record<string, unknown>)[key];
        if (current === null || current === undefined) return undefined;
      }
      // Parse all consecutive `[N]` tokens
      let remaining = rest;
      while (remaining.length > 0) {
        const m = /^\[(\d+)\](.*)/.exec(remaining);
        if (!m) return undefined;
        const idx = parseInt(m[1], 10);
        remaining = m[2];
        if (!Array.isArray(current)) return undefined;
        current = (current as unknown[])[idx];
        if (current === null || current === undefined) return undefined;
      }
    } else {
      if (typeof current !== "object" || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[seg];
    }
  }
  return current;
}

/**
 * On the reverse pass, assign a value into a nested path within `result`, creating
 * intermediate objects as needed. Array-index write-back is not supported (caught at
 * config load time for non-forward_only fields).
 *
 * Spec: specs/field-mapping.md §1.7 (reverse pass)
 */
function assignNestedPath(
  result: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  let cursor: Record<string, unknown> = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cursor[key] === undefined || cursor[key] === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

/** Apply inbound (source → canonical) or outbound (canonical → target) rename.
 *  If no mappings are declared, all fields pass through verbatim (whitelist not applied).
 *  If mappings are declared, only listed fields appear in the result (whitelist semantics).
 *  Spec: specs/config.md § Field whitelist semantics
 *  Spec: specs/field-mapping.md §1.3 — expression / reverseExpression
 *  Spec: specs/field-mapping.md §1.5 — default / defaultExpression
 *  Spec: specs/field-mapping.md §1.7 — source_path extraction */
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
      // Spec: specs/field-mapping.md §1.7 — source_path extraction takes precedence over source key lookup
      let value: unknown;
      if (m.expression) {
        value = m.expression(data);
      } else if (m.sourcePath) {
        value = resolveSourcePath(data, m.sourcePath);
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
        // Spec: specs/field-mapping.md §3.5 — apply element_fields to each array element
        result[m.target] = m.elementFields ? applyElementFields(value, m.elementFields, pass) : value;
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
      } else if (m.sourcePath) {
        // Spec: specs/field-mapping.md §1.7 — reverse: reconstruct nested path in result
        if (Object.prototype.hasOwnProperty.call(data, m.target)) {
          const outVal = data[m.target];
          // Array-index write-back not supported (caught at config load for non-forward_only)
          assignNestedPath(result, m.sourcePath, outVal);
        }
      } else {
        const sourceKey = m.source ?? m.target;
        if (Object.prototype.hasOwnProperty.call(data, m.target)) {
          const outVal = data[m.target];
          // Spec: specs/field-mapping.md §3.5 — apply element_fields to each array element
          result[sourceKey] = m.elementFields ? applyElementFields(outVal, m.elementFields, pass) : outVal;
        }
      }
    }
  }
  return result;
}

/** Apply per-element field mappings to each element of an array field.
 *  Recursively handles nested element_fields via applyMapping (which internally
 *  calls applyElementFields for any mapping entry that has elementFields set).
 *  Spec: specs/field-mapping.md §3.5 */
export function applyElementFields(
  arrayValue: unknown,
  elementFields: FieldMappingList,
  pass: "inbound" | "outbound",
): unknown {
  if (!Array.isArray(arrayValue)) return arrayValue;
  return arrayValue.map((el) => {
    if (typeof el !== "object" || el === null || Array.isArray(el)) return el;
    return applyMapping(el as Record<string, unknown>, elementFields, pass);
  });
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
