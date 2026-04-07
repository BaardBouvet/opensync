// Spec: specs/field-mapping.md, specs/sync-engine.md § Field Mapping
// Pure field-mapping helpers.

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
