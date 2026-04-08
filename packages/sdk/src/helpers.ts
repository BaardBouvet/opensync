/**
 * SDK helper functions for working with Ref values in connector read/write payloads.
 * Spec: specs/connector-sdk.md § SDK Helpers
 */
import { isRef } from "./types.js";
import type { EntityDefinition } from "./types.js";

/**
 * Strip all `Ref` values from a write-payload recursively, replacing each
 * `{ '@id': id, '@entity'?: entity }` with the plain `id` string.
 *
 * Use this inside `update()` and `insert()` to build the plain JSON object that
 * most REST APIs expect, before passing it to your HTTP client.
 *
 * Non-`Ref` values (scalars, plain objects without `@id`, arrays) pass through unchanged.
 *
 * @example
 * ```ts
 * const payload = readRefs(rec.data);
 * // { name: 'Alice', companyId: { '@id': '99' } }
 * // → { name: 'Alice', companyId: '99' }
 * await ctx.http(`/contacts/${rec.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
 * ```
 */
export function readRefs(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = _unwrapValue(value);
  }
  return result;
}

function _unwrapValue(value: unknown): unknown {
  if (isRef(value)) return value['@id'];
  if (Array.isArray(value)) return value.map(_unwrapValue);
  if (typeof value === 'object' && value !== null) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = _unwrapValue(v);
    }
    return obj;
  }
  return value;
}

/**
 * Wrap FK fields in a raw API response with `Ref` values, guided by the entity schema.
 *
 * For each field in `data` where the schema entry declares `entity: 'someName'`,
 * wraps the string value with `{ '@id': value, '@entity': someName }`. Null / undefined
 * values are left as-is. Fields not in the schema pass through unchanged.
 *
 * Use this inside `read()` to annotate FK fields without manually constructing Ref objects.
 * Alternatively, declare `entity` in the schema and return raw API payloads — the engine
 * auto-synthesizes Ref objects during ingest.
 *
 * @example
 * ```ts
 * const schema: EntityDefinition['schema'] = {
 *   name:      { type: 'string' },
 *   companyId: { type: 'string', entity: 'company' },
 * };
 * const data = makeRefs({ name: 'Alice', companyId: 'hs_456' }, schema);
 * // → { name: 'Alice', companyId: { '@id': 'hs_456', '@entity': 'company' } }
 * ```
 */
export function makeRefs(
  data: Record<string, unknown>,
  schema: EntityDefinition['schema'],
): Record<string, unknown> {
  if (!schema) return { ...data };
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const entityName = schema[key]?.entity;
    result[key] = _wrapRefValue(value, entityName);
  }
  return result;
}

function _wrapRefValue(value: unknown, entityName: string | undefined): unknown {
  if (!entityName || value === null || value === undefined) return value;
  if (typeof value === 'string' && value !== '') {
    return { '@id': value, '@entity': entityName };
  }
  if (Array.isArray(value)) {
    return value.map((item) => _wrapRefValue(item, entityName));
  }
  return value;
}
