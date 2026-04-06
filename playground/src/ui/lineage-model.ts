// Spec: specs/playground.md § 11.2
// Pure data model for the field-lineage diagram.
// No DOM, no engine imports — derived entirely from ScenarioDefinition.
import type { ChannelConfig } from "@opensync/engine";

export interface CanonicalNode {
  fieldName: string;
  isIdentity: boolean;
}

export interface ConnectorFieldNode {
  connectorId: string;
  entity: string;
  // Connector-side name (e.g. "accountName"). "*" for pass-through members.
  sourceField: string;
  // Canonical-side name (e.g. "name"). "*" for pass-through members.
  canonicalField: string;
  direction: "bidirectional" | "forward_only" | "reverse_only";
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
  const canonicalSet = new Set<string>();
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
      });
    } else {
      for (const f of member.inbound) {
        const canonicalField = f.target;
        canonicalSet.add(canonicalField);
        inboundFields.push({
          connectorId,
          entity,
          sourceField: f.source ?? f.target,
          canonicalField,
          direction: f.direction ?? "bidirectional",
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
      });
    } else {
      for (const f of member.outbound) {
        canonicalSet.add(f.target);
        outboundFields.push({
          connectorId,
          entity,
          sourceField: f.source ?? f.target,
          canonicalField: f.target,
          direction: f.direction ?? "bidirectional",
        });
      }
    }
  }

  // If all members are pass-through, add the synthetic "*" canonical node.
  if (canonicalSet.size === 0) canonicalSet.add("*");

  const canonicalFields: CanonicalNode[] = Array.from(canonicalSet).map((name) => ({
    fieldName: name,
    isIdentity: identitySet.has(name),
  }));

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
