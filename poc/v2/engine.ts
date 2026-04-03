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
 * A canonical ID (a UUID) represents the same logical record across all connected
 * systems. Each connectorId entry maps to the record's native ID in that connector.
 */
export interface EngineState {
  identityMap: Record<string, Record<string, Record<string, string>>>;
  /** watermarks["fromId→toId:entityName"] = since value */
  watermarks: Record<string, string>;
}

// ─── Config Types ─────────────────────────────────────────────────────────────

/**
 * A rename map applied to a record's fields.
 * Keys are source field names; values are destination field names.
 * Fields not listed pass through under their original name.
 */
export type RenameMap = Record<string, string>;

export interface ChannelMember {
  /** ID of the ConnectorInstance this member refers to. */
  connectorId: string;
  /** Entity name as exposed by this connector (e.g. 'customers'). */
  entity: string;
  /** Rename local fields → canonical fields on read. */
  inbound?: RenameMap;
  /** Rename canonical fields → local fields on write. */
  outbound?: RenameMap;
}

export interface ChannelConfig {
  /** Unique identifier for this channel. */
  id: string;
  /** Two or more members. The engine syncs every directed pair via canonical form. */
  members: ChannelMember[];
}

export interface ConnectorInstance {
  /** Short identifier used as a namespace key in the identity map (e.g. "A", "B"). */
  id: string;
  ctx: ConnectorContext;
  /**
   * Entities exposed by this connector. Put parent entities (e.g. "customers") before
   * child entities (e.g. "orders") so FK associations can be resolved in the same pass.
   */
  entities: EntityDefinition[];
}

export interface EngineConfig {
  connectors: ConnectorInstance[];
  channels: ChannelConfig[];
}

// ─── Public Types ─────────────────────────────────────────────────────────────

export type SyncAction = "insert" | "update" | "skip" | "defer";

export interface RecordSyncResult {
  entity: string;
  action: SyncAction;
  sourceId: string;
  targetId: string;
}

// ─── Field Rename ─────────────────────────────────────────────────────────────

/**
 * Apply a RenameMap to a data record.
 * Fields listed in the map are renamed; all other fields pass through unchanged.
 * Returns a new object — the input is never mutated.
 */
export function applyRename(
  data: Record<string, unknown>,
  map: RenameMap | undefined,
): Record<string, unknown> {
  if (!map || Object.keys(map).length === 0) return { ...data };
  // When a map is provided it acts as a whitelist: only listed fields are
  // included, renamed to their mapped names. Unmapped fields are connector-local
  // and must not leak into canonical form or into other connectors.
  const result: Record<string, unknown> = {};
  for (const [srcKey, dstKey] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(data, srcKey)) {
      result[dstKey] = data[srcKey];
    }
  }
  return result;
}

// ─── SyncEngine ───────────────────────────────────────────────────────────────

/**
 * Bidirectional sync engine for the v3 POC.
 *
 * Accepts a declarative EngineConfig — no hardcoded connector wiring. Topology,
 * entity pairing, and field renames are all derived from the config at construction time.
 *
 * Canonical model: each channel routes data through a canonical representation.
 * Each member declares inbound renames (local → canonical) and outbound renames
 * (canonical → local). The engine applies them on every read/write; the canonical
 * record is ephemeral (in-memory only during a single sync pass).
 *
 * Known limitations (by design for the POC):
 *  - No conflict resolution — last write wins.
 *  - Deferred records (unresolved FK associations) are not retried automatically.
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

  // echoes[targetConnectorId][sourceConnectorId] = Set<targetRecordId>
  private readonly echoes = new Map<string, Map<string, Set<string>>>();

  constructor(config: EngineConfig) {
    this.connectors = new Map(config.connectors.map((c) => [c.id, c]));
    this.channels = new Map(config.channels.map((ch) => [ch.id, ch]));
  }

  // ─── State serialisation ───────────────────────────────────────────────────

  /** Serialise current identity map + watermarks to a plain object. */
  toJSON(): EngineState {
    const identityMap: EngineState["identityMap"] = {};
    for (const [entity, canonMap] of this.canonical) {
      identityMap[entity] = {};
      for (const [canonId, instances] of canonMap) {
        identityMap[entity][canonId] = Object.fromEntries(instances);
      }
    }
    return { identityMap, watermarks: Object.fromEntries(this.watermarks) };
  }

  /** Restore state previously returned by toJSON(). Replaces current state. */
  fromJSON(state: EngineState): void {
    this.canonical.clear();
    this.externalToCanonical.clear();
    this.watermarks.clear();
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
  }

  // ─── Public helpers ───────────────────────────────────────────────────────

  /**
   * Look up what ID a source record has been assigned in a specific target connector.
   * Returns undefined if the record has never been synced to that connector.
   */
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

  private _echoSet(targetConnectorId: string, sourceConnectorId: string): Set<string> {
    let m = this.echoes.get(targetConnectorId);
    if (!m) { m = new Map(); this.echoes.set(targetConnectorId, m); }
    let s = m.get(sourceConnectorId);
    if (!s) { s = new Set(); m.set(sourceConnectorId, s); }
    return s;
  }

  /**
   * Rewrite each association's targetId from the source connector ID to the
   * target connector ID. Returns null if any dependency is not yet in the
   * identity map → caller should defer.
   */
  private _remapAssociations(
    associations: Association[] | undefined,
    fromConnectorId: string,
    toConnectorId: string,
  ): Association[] | null {
    if (!associations || associations.length === 0) return [];
    const remapped: Association[] = [];
    for (const assoc of associations) {
      const mapped = this.lookupTargetId(
        assoc.targetEntity,
        fromConnectorId,
        assoc.targetId,
        toConnectorId,
      );
      if (mapped === undefined) return null;
      remapped.push({ ...assoc, targetId: mapped });
    }
    return remapped;
  }

  // ─── Core sync step ───────────────────────────────────────────────────────

  /**
   * Sync one directed pair within a channel: read all changed records from
   * `fromConnectorId`, translate them through the canonical model, and write
   * them to `toConnectorId`.
   *
   * Returns one RecordSyncResult per source record.
   */
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

    // Per-pair watermark so each target's cursor advances independently.
    const watermarkKey = `${fromConnectorId}→${toConnectorId}:${fromMember.entity}`;
    const since = this.watermarks.get(watermarkKey);

    const fromEchoes = this._echoSet(fromConnectorId, toConnectorId);
    const toEchoes = this._echoSet(toConnectorId, fromConnectorId);

    const pending: Array<{
      id: string;
      canonical: Record<string, unknown>;
      associations?: Association[];
    }> = [];
    let newWatermark: string | undefined;

    for await (const batch of fromEntity.read(from.ctx, since)) {
      for (const record of batch.records) {
        if (fromEchoes.has(record.id)) {
          fromEchoes.delete(record.id);
          results.push({
            entity: fromMember.entity,
            action: "skip",
            sourceId: record.id,
            targetId: record.id,
          });
          continue;
        }
        // Step 2: apply inbound renames → canonical record.
        const canonical = applyRename(record.data as Record<string, unknown>, fromMember.inbound);
        pending.push({ id: record.id, canonical, associations: record.associations });
      }
      if (batch.since) newWatermark = batch.since;
    }

    for (const record of pending) {
      const remapped = this._remapAssociations(record.associations, fromConnectorId, toConnectorId);
      if (remapped === null) {
        results.push({
          entity: fromMember.entity,
          action: "defer",
          sourceId: record.id,
          targetId: "",
        });
        continue;
      }

      // Step 3: apply outbound renames → target-local record.
      const localData = applyRename(record.canonical, toMember.outbound);

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
            associations: remapped.length > 0 ? remapped : undefined,
          }),
        )) {
          if (!r.notFound && !r.error) {
            toEchoes.add(existingTargetId);
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
            associations: remapped.length > 0 ? remapped : undefined,
          }),
        )) {
          if (!r.error && r.id) {
            const canonId = this._getOrCreateCanonical(fromMember.entity, fromConnectorId, record.id);
            this._linkCanonical(fromMember.entity, canonId, toConnectorId, r.id);
            toEchoes.add(r.id);
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

// Re-export SDK types so callers only need to import from this file.
export type { ConnectorContext, EntityDefinition, InsertRecord, UpdateRecord };
