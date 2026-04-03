import type {
  Association,
  ConnectorContext,
  EntityDefinition,
  InsertRecord,
  UpdateRecord,
} from "../packages/sdk/src/index.js";

// ─── Persistent State ────────────────────────────────────────────────────────

/**
 * Plain-object snapshot of engine state that can be JSON-serialised.
 *
 * identityMap[entityName][canonicalId][instanceId] = recordId
 * A canonical ID (a UUID) represents the same logical record across all connected
 * systems. Each instanceId entry maps to the record's native ID in that system.
 */
export interface EngineState {
  identityMap: Record<string, Record<string, Record<string, string>>>;
  /** watermarks["instanceId:entityName"] = since value */
  watermarks: Record<string, string>;
}

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface ConnectedSystem {
  /** Short identifier used as a namespace key in the identity map (e.g. "A", "B"). */
  id: string;
  ctx: ConnectorContext;
  /**
   * Entities exposed by this system. The engine matches entities by name across systems.
   * Put parent entities (e.g. "customers") before child entities (e.g. "orders") so
   * FK associations can be resolved in the same sync pass.
   */
  entities: EntityDefinition[];
}

export type SyncAction = "insert" | "update" | "skip" | "defer";

export interface RecordSyncResult {
  entity: string;
  action: SyncAction;
  sourceId: string;
  targetId: string;
}

// ─── SyncEngine ───────────────────────────────────────────────────────────────

/**
 * Minimal bidirectional sync engine for the JSON-files POC.
 *
 * Tracks:
 *  - An in-memory identity map linking source record IDs to target record IDs per entity.
 *  - Per-direction watermarks for incremental reads (keyed by `${instanceId}:${entityName}`).
 *  - An echo-prevention set so writes to a target don't bounce back on the next poll.
 *
 * Known limitations (by design for the POC):
 *  - No conflict resolution — last write wins per field.
 *  - Deferred records (unresolved FK associations) are not retried automatically; they rely
 *    on the caller ordering entities parent-first so deferral never occurs in the happy path.
 */
export class SyncEngine {
  // canonical[entityName][canonicalId][instanceId] = recordId
  // One canonical UUID per logical record, shared across all connected systems.
  private readonly canonical = new Map<string, Map<string, Map<string, string>>>();

  // externalToCanonical[entityName][`${instanceId}:${recordId}`] = canonicalId
  private readonly externalToCanonical = new Map<string, Map<string, string>>();

  // watermarks[`${instanceId}:${entityName}`] = since value for next incremental read
  private readonly watermarks = new Map<string, string>();

  // echoes[targetInstanceId][sourceInstanceId] = Set<targetRecordId>
  // Records written to targetInstance while syncing FROM sourceInstance.
  // Suppressed when reading FROM targetInstance back TO sourceInstance (prevents bounce).
  // Does NOT suppress reads from targetInstance to other systems (allows N-system cascade).
  private readonly echoes = new Map<string, Map<string, Set<string>>>();

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
        for (const [instanceId, recordId] of Object.entries(instances)) {
          this._linkCanonical(entity, canonId, instanceId, recordId);
        }
      }
    }
    for (const [k, v] of Object.entries(state.watermarks)) {
      this.watermarks.set(k, v);
    }
  }

  // ─── Public helpers ──────────────────────────────────────────────────────────

  /**
   * Look up what ID a source record has been assigned in a specific target system.
   * Returns undefined if the record has never been synced to that target.
   */
  lookupTargetId(
    entityName: string,
    sourceInstanceId: string,
    sourceRecordId: string,
    targetInstanceId: string,
  ): string | undefined {
    const canonId = this.externalToCanonical
      .get(entityName)
      ?.get(`${sourceInstanceId}:${sourceRecordId}`);
    if (!canonId) return undefined;
    return this.canonical.get(entityName)?.get(canonId)?.get(targetInstanceId);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private _linkCanonical(
    entityName: string,
    canonId: string,
    instanceId: string,
    recordId: string,
  ): void {
    let ext = this.externalToCanonical.get(entityName);
    if (!ext) { ext = new Map(); this.externalToCanonical.set(entityName, ext); }
    ext.set(`${instanceId}:${recordId}`, canonId);
    let can = this.canonical.get(entityName);
    if (!can) { can = new Map(); this.canonical.set(entityName, can); }
    let inst = can.get(canonId);
    if (!inst) { inst = new Map(); can.set(canonId, inst); }
    inst.set(instanceId, recordId);
  }

  private _getOrCreateCanonical(
    entityName: string,
    instanceId: string,
    recordId: string,
  ): string {
    const existing = this.externalToCanonical
      .get(entityName)
      ?.get(`${instanceId}:${recordId}`);
    if (existing) return existing;
    const canonId = crypto.randomUUID();
    this._linkCanonical(entityName, canonId, instanceId, recordId);
    return canonId;
  }

  private _echoSet(targetInstanceId: string, sourceInstanceId: string): Set<string> {
    let m = this.echoes.get(targetInstanceId);
    if (!m) { m = new Map(); this.echoes.set(targetInstanceId, m); }
    let s = m.get(sourceInstanceId);
    if (!s) { s = new Set(); m.set(sourceInstanceId, s); }
    return s;
  }

  /**
   * Rewrite each association's targetId from the source-system ID to the target-system ID.
   * Returns null if any dependency is not yet in the identity map → caller should defer.
   */
  private _remapAssociations(
    associations: Association[] | undefined,
    fromInstanceId: string,
    toInstanceId: string,
  ): Association[] | null {
    if (!associations || associations.length === 0) return [];
    const remapped: Association[] = [];
    for (const assoc of associations) {
      const mapped = this.lookupTargetId(
        assoc.targetEntity,
        fromInstanceId,
        assoc.targetId,
        toInstanceId,
      );
      if (mapped === undefined) return null; // unresolved dependency — defer
      remapped.push({ ...assoc, targetId: mapped });
    }
    return remapped;
  }

  // ─── Core sync step ──────────────────────────────────────────────────────────

  /**
   * Read all changed records from `from` since the last sync and write them to `to`.
   * Returns one RecordSyncResult per source record describing what action was taken.
   */
  async sync(
    from: ConnectedSystem,
    to: ConnectedSystem,
  ): Promise<RecordSyncResult[]> {
    const results: RecordSyncResult[] = [];

    for (const fromEntity of from.entities) {
      if (!fromEntity.read) continue;
      const toEntity = to.entities.find((e) => e.name === fromEntity.name);
      if (!toEntity?.insert || !toEntity?.update) continue;

      // Per-pair watermark: `${from.id}→${to.id}:${entityName}` so that syncing
      // from the same source to multiple targets advances each target's cursor
      // independently (avoids the strict > watermark filter cutting off sibling passes).
      const watermarkKey = `${from.id}→${to.id}:${fromEntity.name}`;
      const since = this.watermarks.get(watermarkKey);
      // fromEchoes: records in `from` written there from `to` — skip to prevent bounce back.
      const fromEchoes = this._echoSet(from.id, to.id);
      // toEchoes: records we write to `to` — recorded to suppress the reverse pass.
      const toEchoes = this._echoSet(to.id, from.id);

      // Collect all records first; watermark advances uniformly after the full read.
      const pending: Array<{
        id: string;
        data: Record<string, unknown>;
        associations?: Association[];
      }> = [];
      let newWatermark: string | undefined;

      for await (const batch of fromEntity.read(from.ctx, since)) {
        for (const record of batch.records) {
          if (fromEchoes.has(record.id)) {
            // This record was written by us — suppress the echo.
            fromEchoes.delete(record.id);
            results.push({
              entity: fromEntity.name,
              action: "skip",
              sourceId: record.id,
              targetId: record.id,
            });
            continue;
          }
          pending.push({
            id: record.id,
            data: record.data as Record<string, unknown>,
            associations: record.associations,
          });
        }
        if (batch.since) newWatermark = batch.since;
      }

      for (const record of pending) {
        const remapped = this._remapAssociations(
          record.associations,
          from.id,
          to.id,
        );

        if (remapped === null) {
          // FK target not yet in the identity map — skip for this cycle.
          results.push({
            entity: fromEntity.name,
            action: "defer",
            sourceId: record.id,
            targetId: "",
          });
          continue;
        }

        const existingTargetId = this.lookupTargetId(fromEntity.name, from.id, record.id, to.id);

        if (existingTargetId !== undefined) {
          // Record already exists in the target — update it.
          for await (const r of toEntity.update(
            oneRecord<UpdateRecord>({
              id: existingTargetId,
              data: record.data,
              associations: remapped.length > 0 ? remapped : undefined,
            }),
          )) {
            if (!r.notFound && !r.error) {
              toEchoes.add(existingTargetId);
              results.push({
                entity: fromEntity.name,
                action: "update",
                sourceId: record.id,
                targetId: existingTargetId,
              });
            }
          }
        } else {
          // New record — insert and capture the generated target ID.
          for await (const r of toEntity.insert(
            oneRecord<InsertRecord>({
              data: record.data,
              associations: remapped.length > 0 ? remapped : undefined,
            }),
          )) {
            if (!r.error && r.id) {
              const canonId = this._getOrCreateCanonical(fromEntity.name, from.id, record.id);
              this._linkCanonical(fromEntity.name, canonId, to.id, r.id);
              toEchoes.add(r.id);
              results.push({
                entity: fromEntity.name,
                action: "insert",
                sourceId: record.id,
                targetId: r.id,
              });
            }
          }
        }
      }

      if (newWatermark) this.watermarks.set(watermarkKey, newWatermark);
    }

    return results;
  }
}

// ─── Internal helper ─────────────────────────────────────────────────────────

async function* oneRecord<T>(item: T): AsyncIterable<T> {
  yield item;
}

// Re-export SDK types so callers only need to import from this file.
export type { ConnectorContext, EntityDefinition, InsertRecord, UpdateRecord };
