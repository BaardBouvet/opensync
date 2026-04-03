import type {
  Association,
  ConnectorContext,
  EntityDefinition,
  InsertRecord,
  UpdateRecord,
} from "../packages/sdk/src/index.js";

// ─── Persistent State ────────────────────────────────────────────────────────

/** Plain-object snapshot of engine state that can be JSON-serialised. */
export interface EngineState {
  /** identityMap[entityName]["instanceId:recordId"] = otherRecordId */
  identityMap: Record<string, Record<string, string>>;
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
  // identityMap[entityName][`${instanceId}:${recordId}`] = otherInstancesRecordId
  private readonly identityMap = new Map<string, Map<string, string>>();

  // watermarks[`${instanceId}:${entityName}`] = since value for next incremental read
  private readonly watermarks = new Map<string, string>();

  // echoes[instanceId] = IDs we wrote to that instance; skip them on the next read from it
  private readonly echoes = new Map<string, Set<string>>();

  // ─── State serialisation ───────────────────────────────────────────────────

  /** Serialise current identity map + watermarks to a plain object. */
  toJSON(): EngineState {
    const identityMap: Record<string, Record<string, string>> = {};
    for (const [entity, map] of this.identityMap) {
      identityMap[entity] = Object.fromEntries(map);
    }
    return { identityMap, watermarks: Object.fromEntries(this.watermarks) };
  }

  /** Restore state previously returned by toJSON(). Replaces current state. */
  fromJSON(state: EngineState): void {
    this.identityMap.clear();
    for (const [entity, entries] of Object.entries(state.identityMap)) {
      this.identityMap.set(entity, new Map(Object.entries(entries)));
    }
    this.watermarks.clear();
    for (const [k, v] of Object.entries(state.watermarks)) {
      this.watermarks.set(k, v);
    }
  }

  // ─── Public helpers ──────────────────────────────────────────────────────────

  /**
   * Look up what ID a source record has been assigned in another system.
   * Returns undefined if the record has never been synced.
   */
  lookupTargetId(
    entityName: string,
    sourceInstanceId: string,
    sourceRecordId: string,
  ): string | undefined {
    return this.identityMap
      .get(entityName)
      ?.get(`${sourceInstanceId}:${sourceRecordId}`);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private idMap(entityName: string): Map<string, string> {
    let m = this.identityMap.get(entityName);
    if (!m) {
      m = new Map();
      this.identityMap.set(entityName, m);
    }
    return m;
  }

  private echoSet(instanceId: string): Set<string> {
    let s = this.echoes.get(instanceId);
    if (!s) {
      s = new Set();
      this.echoes.set(instanceId, s);
    }
    return s;
  }

  /**
   * Rewrite each association's targetId from the source-system ID to the target-system ID.
   * Returns null if any dependency is not yet in the identity map → caller should defer.
   */
  private remapAssociations(
    associations: Association[] | undefined,
    fromInstanceId: string,
    toInstanceId: string,
  ): Association[] | null {
    if (!associations || associations.length === 0) return [];
    const remapped: Association[] = [];
    for (const assoc of associations) {
      const mapped = this.idMap(assoc.targetEntity).get(
        `${fromInstanceId}:${assoc.targetId}`,
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

      const watermarkKey = `${from.id}:${fromEntity.name}`;
      const since = this.watermarks.get(watermarkKey);
      const fromEchoes = this.echoSet(from.id);
      const toEchoes = this.echoSet(to.id);
      const idMap = this.idMap(fromEntity.name);

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
        const remapped = this.remapAssociations(
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

        const mapKey = `${from.id}:${record.id}`;
        const existingTargetId = idMap.get(mapKey);

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
              idMap.set(mapKey, r.id);
              idMap.set(`${to.id}:${r.id}`, record.id);
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
