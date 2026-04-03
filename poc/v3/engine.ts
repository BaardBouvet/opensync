import type {
  Association,
  ConnectorContext,
  EntityDefinition,
  InsertRecord,
  UpdateRecord,
} from "../../packages/sdk/src/index.js";

// ─── Persistent State ─────────────────────────────────────────────────────────

/**
 * Plain-object snapshot of engine state that can be JSON-serialised.
 *
 * identityMap[entityName][canonicalId][connectorId] = recordId
 * lastWritten[connectorId][entityName][recordId] = canonicalData
 */
export interface EngineState {
  identityMap: Record<string, Record<string, Record<string, string>>>;
  /** watermarks["fromId→toId:entityName"] = since value */
  watermarks: Record<string, string>;
  /**
   * Content-based echo detection store.
   * Records what canonical data the engine last wrote to each connector record.
   * On read, if the incoming canonical data matches the stored entry, the record
   * is our own write bouncing back and is skipped.
   */
  lastWritten: Record<string, Record<string, Record<string, Record<string, unknown>>>>;
}

// ─── Config Types ─────────────────────────────────────────────────────────────

/**
 * A rename map applied to a record's fields.
 * When provided, acts as a whitelist: only listed fields are included.
 * Keys are source field names; values are destination field names.
 */
export type RenameMap = Record<string, string>;

export interface ChannelMember {
  connectorId: string;
  entity: string;
  /** Rename local fields → canonical fields on read. Whitelist — unlisted fields are dropped. */
  inbound?: RenameMap;
  /** Rename canonical fields → local fields on write. Whitelist — unlisted fields are dropped. */
  outbound?: RenameMap;
}

export interface ChannelConfig {
  id: string;
  members: ChannelMember[];
}

export interface ConnectorInstance {
  id: string;
  ctx: ConnectorContext;
  entities: EntityDefinition[];
}

export interface EngineConfig {
  connectors: ConnectorInstance[];
  channels: ChannelConfig[];
}

// ─── Public Types ─────────────────────────────────────────────────────────────

export type SyncAction = "insert" | "update" | "skip" | "defer" | "error";

export interface RecordSyncResult {
  entity: string;
  action: SyncAction;
  sourceId: string;
  targetId: string;
  /** Set when action === "error" */
  error?: string;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Apply a RenameMap to a data record.
 *
 * When map is provided it acts as a whitelist: only fields explicitly listed are
 * included, renamed to their mapped names. Connector-local fields not in the map
 * are dropped so they never leak into canonical form or into other connectors.
 *
 * When map is omitted/empty the entire record passes through unchanged (correct
 * for channel members that use no renames, e.g. orders).
 */
export function applyRename(
  data: Record<string, unknown>,
  map: RenameMap | undefined,
): Record<string, unknown> {
  if (!map || Object.keys(map).length === 0) return { ...data };
  const result: Record<string, unknown> = {};
  for (const [srcKey, dstKey] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(data, srcKey)) {
      result[dstKey] = data[srcKey];
    }
  }
  return result;
}

/**
 * Shallow canonical equality over JSON-serialisable field values.
 * Order-independent: records are equal iff they have the same keys and values
 * regardless of key insertion order.
 */
export function canonicalEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const stable = (o: Record<string, unknown>) =>
    JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
  return stable(a) === stable(b);
}

// ─── SyncEngine ───────────────────────────────────────────────────────────────

/**
 * Bidirectional sync engine — v3.
 *
 * Changes from v2:
 *
 * 1. Content-based echo detection (lastWritten store) replaces the echo ID set.
 *    The engine records the canonical data it last wrote to each connector record.
 *    On read, if the incoming canonical data matches, the record is skipped as an
 *    echo without needing to have seen it in the same cycle. Pass ordering no
 *    longer matters.
 *
 * 2. Association propagation bugs fixed:
 *    - Empty associations array ([]) is passed to update() rather than collapsed
 *      to undefined, so explicit removal propagates correctly.
 *    - Falsy targetId is treated as a removal tombstone, not a defer trigger.
 *    - Unknown targetEntity surfaces as "error" rather than silently deferring.
 *    - Duplicate predicates are deduplicated (last-wins) before remapping.
 *
 * 3. applyRename acts as a whitelist when a map is provided, preventing
 *    connector-local fields from leaking into canonical form.
 */
export class SyncEngine {
  private readonly connectors: Map<string, ConnectorInstance>;
  private readonly channels: Map<string, ChannelConfig>;

  // canonical[entityName][canonicalId][connectorId] = recordId
  private readonly canonical = new Map<string, Map<string, Map<string, string>>>();

  // externalToCanonical[entityName][`${connectorId}:${recordId}`] = canonicalId
  private readonly externalToCanonical = new Map<string, Map<string, string>>();

  // watermarks[`${fromId}→${toId}:${entityName}`] = since value
  private readonly watermarks = new Map<string, string>();

  // lastWritten[connectorId][entityName][recordId] = canonicalData
  private readonly lastWritten = new Map<string, Map<string, Map<string, Record<string, unknown>>>>();

  constructor(config: EngineConfig) {
    this.connectors = new Map(config.connectors.map((c) => [c.id, c]));
    this.channels = new Map(config.channels.map((ch) => [ch.id, ch]));
  }

  // ─── State serialisation ───────────────────────────────────────────────────

  toJSON(): EngineState {
    const identityMap: EngineState["identityMap"] = {};
    for (const [entity, canonMap] of this.canonical) {
      identityMap[entity] = {};
      for (const [canonId, instances] of canonMap) {
        identityMap[entity][canonId] = Object.fromEntries(instances);
      }
    }
    const lastWritten: EngineState["lastWritten"] = {};
    for (const [connId, entityMap] of this.lastWritten) {
      lastWritten[connId] = {};
      for (const [entity, recordMap] of entityMap) {
        lastWritten[connId][entity] = Object.fromEntries(recordMap);
      }
    }
    return {
      identityMap,
      watermarks: Object.fromEntries(this.watermarks),
      lastWritten,
    };
  }

  fromJSON(state: EngineState): void {
    this.canonical.clear();
    this.externalToCanonical.clear();
    this.watermarks.clear();
    this.lastWritten.clear();
    for (const [entity, canonMap] of Object.entries(state.identityMap)) {
      for (const [canonId, instances] of Object.entries(canonMap)) {
        for (const [connectorId, recordId] of Object.entries(instances)) {
          this._linkCanonical(entity, canonId, connectorId, recordId);
        }
      }
    }
    for (const [k, v] of Object.entries(state.watermarks)) {
      this.watermarks.set(k, v);
    }
    for (const [connId, entityMap] of Object.entries(state.lastWritten ?? {})) {
      for (const [entity, recordMap] of Object.entries(entityMap)) {
        for (const [recordId, data] of Object.entries(recordMap)) {
          this._setLastWritten(connId, entity, recordId, data);
        }
      }
    }
  }

  // ─── Public helpers ───────────────────────────────────────────────────────

  lookupTargetId(
    entityName: string,
    sourceConnectorId: string,
    sourceRecordId: string,
    targetConnectorId: string,
  ): string | undefined {
    const canonId = this.externalToCanonical
      .get(entityName)
      ?.get(`${sourceConnectorId}:${sourceRecordId}`);
    if (!canonId) return undefined;
    return this.canonical.get(entityName)?.get(canonId)?.get(targetConnectorId);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private _linkCanonical(
    entityName: string,
    canonId: string,
    connectorId: string,
    recordId: string,
  ): void {
    let ext = this.externalToCanonical.get(entityName);
    if (!ext) { ext = new Map(); this.externalToCanonical.set(entityName, ext); }
    ext.set(`${connectorId}:${recordId}`, canonId);
    let can = this.canonical.get(entityName);
    if (!can) { can = new Map(); this.canonical.set(entityName, can); }
    let inst = can.get(canonId);
    if (!inst) { inst = new Map(); can.set(canonId, inst); }
    inst.set(connectorId, recordId);
  }

  private _getOrCreateCanonical(
    entityName: string,
    connectorId: string,
    recordId: string,
  ): string {
    const existing = this.externalToCanonical
      .get(entityName)
      ?.get(`${connectorId}:${recordId}`);
    if (existing) return existing;
    const canonId = crypto.randomUUID();
    this._linkCanonical(entityName, canonId, connectorId, recordId);
    return canonId;
  }

  private _setLastWritten(
    connectorId: string,
    entityName: string,
    recordId: string,
    data: Record<string, unknown>,
  ): void {
    let byConnector = this.lastWritten.get(connectorId);
    if (!byConnector) { byConnector = new Map(); this.lastWritten.set(connectorId, byConnector); }
    let byEntity = byConnector.get(entityName);
    if (!byEntity) { byEntity = new Map(); byConnector.set(entityName, byEntity); }
    byEntity.set(recordId, data);
  }

  private _getLastWritten(
    connectorId: string,
    entityName: string,
    recordId: string,
  ): Record<string, unknown> | undefined {
    return this.lastWritten.get(connectorId)?.get(entityName)?.get(recordId);
  }

  /**
   * Returns true if the entity name exists as a known canonical namespace.
   * Used to distinguish "not yet synced" (legitimate defer) from "entity name
   * has never been seen" (likely config error).
   */
  private _entityKnown(entityName: string): boolean {
    return this.externalToCanonical.has(entityName);
  }

  /**
   * Rewrite each association's targetId from the source connector namespace to
   * the target connector namespace.
   *
   * Returns:
   *   - Association[] on success (may be empty)
   *   - null  → at least one dependency not yet in the identity map → defer
   *   - { error: string } → misconfiguration (unknown targetEntity)
   *
   * Deduplicates by predicate (last entry wins) before remapping.
   * Treats falsy targetId as an explicit removal tombstone (passes through as-is).
   */
  private _remapAssociations(
    associations: Association[] | undefined,
    fromConnectorId: string,
    toConnectorId: string,
  ): Association[] | null | { error: string } {
    if (!associations || associations.length === 0) return [];

    // Deduplicate by predicate — last entry wins.
    const deduped = new Map<string, Association>();
    for (const assoc of associations) {
      deduped.set(assoc.predicate, assoc);
    }

    const remapped: Association[] = [];
    for (const assoc of deduped.values()) {
      // Falsy targetId = explicit removal tombstone, not a defer trigger.
      if (!assoc.targetId) {
        remapped.push({ ...assoc, targetId: assoc.targetId });
        continue;
      }
      // Check if the targetEntity namespace is known at all.
      if (!this._entityKnown(assoc.targetEntity)) {
        return { error: `Unknown targetEntity "${assoc.targetEntity}" in association predicate "${assoc.predicate}"` };
      }
      const mapped = this.lookupTargetId(
        assoc.targetEntity,
        fromConnectorId,
        assoc.targetId,
        toConnectorId,
      );
      if (mapped === undefined) return null; // legitimate defer
      remapped.push({ ...assoc, targetId: mapped });
    }
    return remapped;
  }

  // ─── Core sync step ───────────────────────────────────────────────────────

  async sync(
    channelId: string,
    fromConnectorId: string,
    toConnectorId: string,
  ): Promise<RecordSyncResult[]> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Unknown channel: ${channelId}`);

    const from = this.connectors.get(fromConnectorId);
    const to = this.connectors.get(toConnectorId);
    if (!from) throw new Error(`Unknown connector: ${fromConnectorId}`);
    if (!to) throw new Error(`Unknown connector: ${toConnectorId}`);

    const fromMember = channel.members.find((m) => m.connectorId === fromConnectorId);
    const toMember = channel.members.find((m) => m.connectorId === toConnectorId);
    if (!fromMember) throw new Error(`${fromConnectorId} is not a member of channel ${channelId}`);
    if (!toMember) throw new Error(`${toConnectorId} is not a member of channel ${channelId}`);

    const results: RecordSyncResult[] = [];

    const fromEntity = from.entities.find((e) => e.name === fromMember.entity);
    if (!fromEntity?.read) return results;

    const toEntity = to.entities.find((e) => e.name === toMember.entity);
    if (!toEntity?.insert || !toEntity?.update) return results;

    const watermarkKey = `${fromConnectorId}→${toConnectorId}:${fromMember.entity}`;
    const since = this.watermarks.get(watermarkKey);

    const pending: Array<{
      id: string;
      canonical: Record<string, unknown>;
      associations: Association[] | undefined;
    }> = [];
    let newWatermark: string | undefined;

    for await (const batch of fromEntity.read(from.ctx, since)) {
      for (const record of batch.records) {
        // Strip connector-added metadata fields (underscore-prefixed: _id,
        // _updatedAt, _associations, etc.) before building canonical form.
        // This ensures echo comparison is consistent regardless of whether an
        // inbound rename map is provided — connectors without maps would
        // otherwise leak _updatedAt into canonical, breaking cross-connector
        // comparisons where one side uses a whitelist and the other does not.
        const rawData = record.data as Record<string, unknown>;
        const strippedData = Object.fromEntries(
          Object.entries(rawData).filter(([k]) => !k.startsWith("_")),
        );
        const canonical = applyRename(strippedData, fromMember.inbound);

        // Content-based echo detection: skip if canonical data matches what we last wrote.
        const prev = this._getLastWritten(fromConnectorId, fromMember.entity, record.id);
        if (prev !== undefined && canonicalEqual(canonical, prev)) {
          results.push({
            entity: fromMember.entity,
            action: "skip",
            sourceId: record.id,
            targetId: record.id,
          });
          continue;
        }

        pending.push({ id: record.id, canonical, associations: record.associations });
      }
      if (batch.since) newWatermark = batch.since;
    }

    for (const record of pending) {
      const remapResult = this._remapAssociations(
        record.associations,
        fromConnectorId,
        toConnectorId,
      );

      if (remapResult !== null && "error" in remapResult) {
        results.push({
          entity: fromMember.entity,
          action: "error",
          sourceId: record.id,
          targetId: "",
          error: remapResult.error,
        });
        continue;
      }

      if (remapResult === null) {
        results.push({
          entity: fromMember.entity,
          action: "defer",
          sourceId: record.id,
          targetId: "",
        });
        continue;
      }

      const localData = applyRename(record.canonical, toMember.outbound);

      // Pass associations: undefined only when source had none at all.
      // Pass associations: [] when source explicitly has zero associations (propagates removal).
      const remapped = remapResult;
      const associationsPayload: Association[] | undefined =
        record.associations === undefined ? undefined : remapped;

      const existingTargetId = this.lookupTargetId(
        fromMember.entity,
        fromConnectorId,
        record.id,
        toConnectorId,
      );

      if (existingTargetId !== undefined) {
        for await (const r of toEntity.update(
          oneRecord<UpdateRecord>({
            id: existingTargetId,
            data: localData,
            associations: associationsPayload,
          }),
        )) {
          if (!r.notFound && !r.error) {
            this._setLastWritten(toConnectorId, toMember.entity, existingTargetId, record.canonical);
            results.push({
              entity: fromMember.entity,
              action: "update",
              sourceId: record.id,
              targetId: existingTargetId,
            });
          }
        }
      } else {
        for await (const r of toEntity.insert(
          oneRecord<InsertRecord>({
            data: localData,
            associations: associationsPayload,
          }),
        )) {
          if (!r.error && r.id) {
            const canonId = this._getOrCreateCanonical(fromMember.entity, fromConnectorId, record.id);
            this._linkCanonical(fromMember.entity, canonId, toConnectorId, r.id);
            this._setLastWritten(toConnectorId, toMember.entity, r.id, record.canonical);
            results.push({
              entity: fromMember.entity,
              action: "insert",
              sourceId: record.id,
              targetId: r.id,
            });
          }
        }
      }
    }

    if (newWatermark) this.watermarks.set(watermarkKey, newWatermark);
    return results;
  }
}

// ─── Internal helper ──────────────────────────────────────────────────────────

async function* oneRecord<T>(item: T): AsyncIterable<T> {
  yield item;
}

export type { ConnectorContext, EntityDefinition, InsertRecord, UpdateRecord };
