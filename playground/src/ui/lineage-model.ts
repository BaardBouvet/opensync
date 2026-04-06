// Spec: specs/playground.md § 11.2
// Pure data model for the field-lineage diagram.
// No DOM, no engine imports — derived entirely from ScenarioDefinition.
import type { ChannelConfig } from "@opensync/engine";

export interface CanonicalNode {
  fieldName: string;
  isIdentity: boolean;
  // True when this canonical node represents an association predicate (assocMappings).
  isAssoc: boolean;
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
  const canonicalMap = new Map<string, { isAssoc: boolean }>();
  const inboundFields: ConnectorFieldNode[] = [];
  const outboundFields: ConnectorFieldNode[] = [];

  for (const member of channel.members) {
    const { connectorId, entity } = member;

    if (!member.inbound || member.inbound.length === 0) {
      // Pass-through: synthetic wildcard node.
      inboundFields.push({
        connectorId,
        entity,
        sourceField: "*",
        canonicalField: "*",
        direction: "bidirectional",
        isAssoc: false,
      });
    } else {
      for (const f of member.inbound) {
        const canonicalField = f.target;
        if (!canonicalMap.has(canonicalField)) canonicalMap.set(canonicalField, { isAssoc: false });
        inboundFields.push({
          connectorId,
          entity,
          sourceField: f.source ?? f.target,
          canonicalField,
          direction: f.direction ?? "bidirectional",
          isAssoc: false,
        });
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
      });
    } else {
      for (const f of member.outbound) {
        if (!canonicalMap.has(f.target)) canonicalMap.set(f.target, { isAssoc: false });
        outboundFields.push({
          connectorId,
          entity,
          sourceField: f.source ?? f.target,
          canonicalField: f.target,
          direction: f.direction ?? "bidirectional",
          isAssoc: false,
        });
      }
    }

    // Association predicate mappings — emitted after regular fields so they appear
    // at the bottom of the entity's expanded pill, visually grouped below fields.
    if (member.assocMappings) {
      for (const a of member.assocMappings) {
        if (!canonicalMap.has(a.target)) canonicalMap.set(a.target, { isAssoc: true });
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
  if (canonicalMap.size === 0) canonicalMap.set("*", { isAssoc: false });

  const canonicalFields: CanonicalNode[] = Array.from(canonicalMap.entries()).map(
    ([name, info]) => ({
      fieldName: name,
      isIdentity: identitySet.has(name),
      isAssoc: info.isAssoc,
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
