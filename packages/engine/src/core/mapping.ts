// Spec: specs/field-mapping.md, specs/sync-engine.md § Field Mapping
// Pure field-mapping helpers.

import type { FieldMappingList } from "../config/loader.js";

/** Apply inbound (source → canonical) or outbound (canonical → target) rename.
 *  If no mappings are declared, all fields pass through verbatim (whitelist not applied).
 *  If mappings are declared, only listed fields appear in the result (whitelist semantics).
 *  Spec: specs/config.md § Field whitelist semantics
 *  Spec: specs/field-mapping.md §1.3 — expression / reverseExpression */
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
      if (m.expression) {
        result[m.target] = m.expression(data);
      } else {
        const sourceKey = m.source ?? m.target;
        if (Object.prototype.hasOwnProperty.call(data, sourceKey)) {
          result[m.target] = data[sourceKey];
        }
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
