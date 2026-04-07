// Spec: specs/playground.md § 11.2
// Pure data model for the field-lineage diagram.
// No DOM, no engine imports — derived entirely from ScenarioDefinition.
import type { ChannelConfig } from "@opensync/engine";

export interface CanonicalNode {
  fieldName: string;
  isIdentity: boolean;
  // True when this canonical node represents an association predicate (assocMappings).
  isAssoc: boolean;
  /** At least one inbound FieldMapping for this canonical field carries a `resolve` function.
   *  Displayed as a small ƒ badge on the canonical pill. */
  hasResolver?: boolean;
}

export interface ConnectorFieldNode {
  connectorId: string;
  entity: string;
  // Connector-side name (e.g. "accountName"). "*" for pass-through members.
  sourceField: string;
  // Canonical-side name (e.g. "name"). "*" for pass-through members.
  canonicalField: string;
  direction: "bidirectional" | "forward_only" | "reverse_only";
  // True when this node represents an association predicate mapping (assocMappings).
  isAssoc: boolean;
  /** True when this node belongs to a member that has arrayPath (array-source member).
   *  The entity label in the diagram shows e.g. `purchases.lines[]`. */
  isArraySource?: boolean;
  /** True when this field is injected from the parent record via parentFields.
   *  Rendered with a ↑ suffix and a dashed connector line. */
  isParentField?: boolean;
  /** True when this node is one of the declared `sources` of an expression mapping.
   *  The canonical pill shows a fan-in arrow from each source. */
  hasExpression?: boolean;
  /** True when the mapping has an `expression` but no `sources` list declared.
   *  Displayed as an italic "(expression)" placeholder pill with amber border. */
  isExpressionPlaceholder?: boolean;
}

export interface ChannelLineage {
  channelId: string;
  canonicalFields: CanonicalNode[];
  // All inbound field nodes across all members (left column source).
  inboundFields: ConnectorFieldNode[];
  // All outbound field nodes across all members (right column source).
  outboundFields: ConnectorFieldNode[];
}

// Spec: specs/playground.md § 11.2
export function buildChannelLineage(channel: ChannelConfig): ChannelLineage {
  const identitySet = new Set(channel.identityFields ?? []);
  // Map from canonical name → { isAssoc } so fields are listed first, assoc predicates second.
  const canonicalMap = new Map<string, { isAssoc: boolean; hasResolver: boolean }>();
  const inboundFields: ConnectorFieldNode[] = [];
  const outboundFields: ConnectorFieldNode[] = [];

  for (const member of channel.members) {
    const { connectorId } = member;
    // Array-source members: display entity as `sourceEntity.arrayPath[]`.
    const isArraySource = member.arrayPath !== undefined;
    const entity = isArraySource
      ? `${member.sourceEntity ?? member.entity}.${member.arrayPath}[]`
      : member.entity;
    // Set of field names injected from the parent record via parentFields.
    const parentFieldKeys = new Set(Object.keys(member.parentFields ?? {}));

    if (!member.inbound || member.inbound.length === 0) {
      // Pass-through: synthetic wildcard node.
      inboundFields.push({
        connectorId,
        entity,
        sourceField: "*",
        canonicalField: "*",
        direction: "bidirectional",
        isAssoc: false,
        isArraySource: isArraySource || undefined,
      });
    } else {
      for (const f of member.inbound) {
        const canonicalField = f.target;
        const canonicalEntry = canonicalMap.get(canonicalField) ?? { isAssoc: false, hasResolver: false };
        // Mark canonical field with resolver badge when the mapping declares resolve.
        if (f.resolve) canonicalEntry.hasResolver = true;
        if (!canonicalMap.has(canonicalField)) canonicalMap.set(canonicalField, canonicalEntry);
        else canonicalMap.set(canonicalField, canonicalEntry);

        if (f.expression) {
          if (f.sources && f.sources.length > 0) {
            // Fan-in: one node per declared source field.
            for (const src of f.sources) {
              inboundFields.push({
                connectorId,
                entity,
                sourceField: src,
                canonicalField,
                direction: f.direction ?? "bidirectional",
                isAssoc: false,
                isArraySource: isArraySource || undefined,
                isParentField: parentFieldKeys.has(src) || undefined,
                hasExpression: true,
              });
            }
          } else {
            // Expression with no declared sources: placeholder pill.
            inboundFields.push({
              connectorId,
              entity,
              sourceField: "(expression)",
              canonicalField,
              direction: f.direction ?? "bidirectional",
              isAssoc: false,
              isArraySource: isArraySource || undefined,
              isExpressionPlaceholder: true,
            });
          }
        } else {
          inboundFields.push({
            connectorId,
            entity,
            sourceField: f.source ?? f.target,
            canonicalField,
            direction: f.direction ?? "bidirectional",
            isAssoc: false,
            isArraySource: isArraySource || undefined,
            isParentField: parentFieldKeys.has(f.source ?? f.target) || undefined,
          });
        }
      }
    }

    if (!member.outbound || member.outbound.length === 0) {
      outboundFields.push({
        connectorId,
        entity,
        sourceField: "*",
        canonicalField: "*",
        direction: "bidirectional",
        isAssoc: false,
        isArraySource: isArraySource || undefined,
      });
    } else {
      for (const f of member.outbound) {
        if (!canonicalMap.has(f.target)) canonicalMap.set(f.target, { isAssoc: false, hasResolver: false });
        outboundFields.push({
          connectorId,
          entity,
          sourceField: f.source ?? f.target,
          canonicalField: f.target,
          direction: f.direction ?? "bidirectional",
          isAssoc: false,
          isArraySource: isArraySource || undefined,
          isParentField: parentFieldKeys.has(f.source ?? f.target) || undefined,
        });
      }
    }

    // Association predicate mappings — emitted after regular fields so they appear
    // at the bottom of the entity's expanded pill, visually grouped below fields.
    if (member.assocMappings) {
      for (const a of member.assocMappings) {
        if (!canonicalMap.has(a.target)) canonicalMap.set(a.target, { isAssoc: true, hasResolver: false });
        inboundFields.push({
          connectorId,
          entity,
          sourceField: a.source,
          canonicalField: a.target,
          direction: "bidirectional",
          isAssoc: true,
        });
        outboundFields.push({
          connectorId,
          entity,
          sourceField: a.source,
          canonicalField: a.target,
          direction: "bidirectional",
          isAssoc: true,
        });
      }
    }
  }

  // If all members are pass-through with no assoc mappings, add the synthetic "*" canonical node.
  if (canonicalMap.size === 0) canonicalMap.set("*", { isAssoc: false, hasResolver: false });

  const canonicalFields: CanonicalNode[] = Array.from(canonicalMap.entries()).map(
    ([name, info]) => ({
      fieldName: name,
      isIdentity: identitySet.has(name),
      isAssoc: info.isAssoc,
      hasResolver: info.hasResolver || undefined,
    }),
  );

  return { channelId: channel.id, canonicalFields, inboundFields, outboundFields };
}

/** Unique member key used as entity expansion toggle key. */
export function memberKey(connectorId: string, entity: string): string {
  return `${connectorId}:${entity}`;
}

/** Distinct channel members from an inbound/outbound field list. */
export function distinctMembers(
  fields: ConnectorFieldNode[],
): Array<{ connectorId: string; entity: string }> {
  const seen = new Set<string>();
  const result: Array<{ connectorId: string; entity: string }> = [];
  for (const f of fields) {
    const k = memberKey(f.connectorId, f.entity);
    if (!seen.has(k)) {
      seen.add(k);
      result.push({ connectorId: f.connectorId, entity: f.entity });
    }
  }
  return result;
}
