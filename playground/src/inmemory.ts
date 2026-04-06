// In-memory connector for the browser demo.
// Mirrors the jsonfiles connector contract but stores records in a Map instead of
// reading/writing the filesystem. No node:fs imports — safe in any browser context.
//
// Usage:
//   const { connector, mutate } = createInMemoryConnector("crm", seed);
//   // insertRecord / updateRecord / deleteRecord are called by the UI.

import type {
  Association,
  Connector,
  ConnectorContext,
  EntityDefinition,
  ReadBatch,
  ReadRecord,
  InsertRecord,
  InsertResult,
  UpdateRecord,
  UpdateResult,
  DeleteResult,
} from "@opensync/sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Seed shape: entity name → array of ReadRecords. */
export type EntitySeed = Record<string, ReadRecord[]>;

/** A ReadRecord enriched with live tracking metadata for the UI. */
export interface RecordWithMeta extends ReadRecord {
  modifiedAt: number;   // Date.now() when last inserted or updated
  watermark: number;    // monotonic counter; changes on every write
  softDeleted: boolean; // true when UI-marked as deleted (hidden from engine read)
}

/** One entry in the per-connector activity log.
 * Captures ONLY engine-driven writes (fan-out inserts and updates), not UI mutations. */
export interface ActivityLogEntry {
  op: "insert" | "update";
  entity: string;
  id: string;
  at: string;  // ISO timestamp
  after: Record<string, unknown>;
  before?: Record<string, unknown>; // only present for updates
}

export interface InMemoryConnector {
  connector: Connector;
  /** Replace the full record list for one entity (bulk overwrite). */
  mutate(entity: string, records: ReadRecord[]): void;
  /** Snapshot of current records per entity (plain ReadRecord, no meta). */
  snapshot(): EntitySeed;
  /** Snapshot enriched with modifiedAt + watermark + softDeleted — used by the UI. */
  snapshotFull(): Record<string, RecordWithMeta[]>;
  /** Insert a single record from the UI. Returns the assigned id. */
  insertRecord(entity: string, data: Record<string, unknown>, associations?: Association[], explicitId?: string): string;
  /** Merge a data patch onto an existing record from the UI. */
  updateRecord(entity: string, id: string, data: Record<string, unknown>, associations?: Association[]): void;
  /** Remove a single record from the UI (hard delete). */
  deleteRecord(entity: string, id: string): void;
  /** Mark a record as soft-deleted (hidden from engine; shown in UI with Restore). */
  softDeleteRecord(entity: string, id: string): void;
  /** Restore a soft-deleted record (engine will pick it up on next poll). */
  restoreRecord(entity: string, id: string): void;
  /** Engine-driven write log (fan-out inserts and updates only, not UI edits). */
  getActivityLog(): ActivityLogEntry[];
  /** Clear the activity log (called on scenario reset). */
  clearActivityLog(): void;
}

// ─── Entity factory ───────────────────────────────────────────────────────────

function makeEntity(
  entityName: string,
  store: Map<string, ReadRecord[]>,
  watermarks: Map<string, number>,  // shared with connector level — id → wm
  modifiedAt: Map<string, number>,  // shared with connector level — id → ts
  softDeleted: Set<string>,         // ids to exclude from engine read
  bump: () => number,               // monotonic counter shared across all entities
  activityLog: ActivityLogEntry[],  // shared activity log — engine writes only
): EntityDefinition {
  // Assign initial watermarks and timestamps to seed records.
  const seedTs = Date.now();
  for (const r of store.get(entityName) ?? []) {
    watermarks.set(r.id, bump());
    modifiedAt.set(r.id, seedTs);
  }

  return {
    name: entityName,

    async *read(_ctx: ConnectorContext, since?: string): AsyncIterable<ReadBatch> {
      const records = store.get(entityName) ?? [];
      const sinceNum = since !== undefined ? Number(since) : undefined;

      const filtered = (sinceNum !== undefined
        ? records.filter((r) => {
            const wm = watermarks.get(r.id);
            return wm !== undefined ? wm > sinceNum : true;
          })
        : records
      ).filter((r) => !softDeleted.has(r.id));

      const maxWm = filtered.reduce<number | undefined>((m, r) => {
        const wm = watermarks.get(r.id);
        return wm !== undefined && (m === undefined || wm > m) ? wm : m;
      }, undefined);

      yield {
        records: filtered,
        since: maxWm !== undefined ? String(maxWm) : since,
      };
    },

    async lookup(ids: string[]): Promise<ReadRecord[]> {
      const set = new Set(ids);
      return (store.get(entityName) ?? []).filter((r) => set.has(r.id));
    },

    async *insert(
      records: AsyncIterable<InsertRecord>,
      _ctx: ConnectorContext,
    ): AsyncIterable<InsertResult> {
      for await (const record of records) {
        const id = (record.data["id"] as string | undefined) ?? crypto.randomUUID();
        const newRecord: ReadRecord = {
          id,
          data: record.data,
          ...(record.associations ? { associations: record.associations as Association[] } : {}),
        };
        const existing = store.get(entityName) ?? [];
        store.set(entityName, [...existing, newRecord]);
        watermarks.set(id, bump());
        modifiedAt.set(id, Date.now());
        // Engine-driven write — capture in activity log.
        activityLog.push({ op: "insert", entity: entityName, id, at: new Date().toISOString(), after: { ...record.data } });
        yield { id, data: record.data };
      }
    },

    async *update(
      records: AsyncIterable<UpdateRecord>,
      _ctx: ConnectorContext,
    ): AsyncIterable<UpdateResult> {
      for await (const record of records) {
        const existing = store.get(entityName) ?? [];
        const idx = existing.findIndex((r) => r.id === record.id);
        if (idx === -1) {
          yield { id: record.id, notFound: true as const };
          continue;
        }
        const prev = existing[idx]!;
        const mergedData = { ...prev.data, ...record.data };
        const updated: ReadRecord = {
          id: record.id,
          data: mergedData,
          ...(record.associations !== undefined
            ? { associations: record.associations as Association[] }
            : prev.associations !== undefined ? { associations: prev.associations } : {}),
        };
        const next = [...existing];
        next[idx] = updated;
        store.set(entityName, next);
        watermarks.set(record.id, bump());
        modifiedAt.set(record.id, Date.now());
        // Engine-driven write — capture in activity log.
        activityLog.push({ op: "update", entity: entityName, id: record.id, at: new Date().toISOString(), before: { ...prev.data }, after: mergedData });
        yield { id: record.id, data: updated.data };
      }
    },

    async *delete(
      ids: AsyncIterable<string>,
      _ctx: ConnectorContext,
    ): AsyncIterable<DeleteResult> {
      for await (const id of ids) {
        const existing = store.get(entityName) ?? [];
        const idx = existing.findIndex((r) => r.id === id);
        if (idx === -1) {
          yield { id, notFound: true as const };
          continue;
        }
        const next = [...existing];
        next.splice(idx, 1);
        store.set(entityName, next);
        watermarks.delete(id);
        modifiedAt.delete(id);
        yield { id };
      }
    },
  };
}

// ─── Public factory ───────────────────────────────────────────────────────────

export function createInMemoryConnector(
  systemId: string,
  seed: EntitySeed,
): InMemoryConnector {
  const store = new Map<string, ReadRecord[]>();
  // Deep-copy the seed so resets don't mutate the original
  for (const [entity, records] of Object.entries(seed)) {
    store.set(entity, records.map((r) => ({ ...r, data: { ...r.data } })));
  }

  // Per-entity tracking maps (exposed to UI via snapshotFull)
  const allWatermarks = new Map<string, Map<string, number>>();  // entity → id → wm
  const allModifiedAt  = new Map<string, Map<string, number>>();  // entity → id → ts
  let counter = 0;
  const bump = (): number => ++counter;

  const allSoftDeleted = new Map<string, Set<string>>();

  // Activity log: records engine-driven writes only (not UI mutations).
  const activityLog: ActivityLogEntry[] = [];

  const entities = Object.keys(seed).map((name) => {
    const wms  = new Map<string, number>();
    const mods = new Map<string, number>();
    const sds  = new Set<string>();
    allWatermarks.set(name, wms);
    allModifiedAt.set(name, mods);
    allSoftDeleted.set(name, sds);
    return makeEntity(name, store, wms, mods, sds, bump, activityLog);
  });

  const connector: Connector = {
    metadata: {
      name: `inmemory-${systemId}`,
      version: "0.1.0",
      auth: { type: "none" },
    },
    getEntities(): EntityDefinition[] {
      return entities;
    },
  };

  // Ensure tracking maps exist for an entity (covers entities added at runtime).
  function ensureMaps(entity: string): { wms: Map<string, number>; mods: Map<string, number> } {
    let wms = allWatermarks.get(entity);
    let mods = allModifiedAt.get(entity);
    if (!wms) { wms = new Map(); allWatermarks.set(entity, wms); }
    if (!mods) { mods = new Map(); allModifiedAt.set(entity, mods); }
    if (!allSoftDeleted.has(entity)) allSoftDeleted.set(entity, new Set());
    return { wms, mods };
  }

  return {
    connector,

    mutate(entity: string, records: ReadRecord[]): void {
      store.set(entity, records.map((r) => ({ ...r, data: { ...r.data } })));
    },

    snapshot(): EntitySeed {
      const out: EntitySeed = {};
      for (const [entity, records] of store.entries()) {
        out[entity] = records.map((r) => ({ ...r, data: { ...r.data } }));
      }
      return out;
    },

    snapshotFull(): Record<string, RecordWithMeta[]> {
      const out: Record<string, RecordWithMeta[]> = {};
      for (const [entity, records] of store.entries()) {
        const mods = allModifiedAt.get(entity)   ?? new Map<string, number>();
        const wms  = allWatermarks.get(entity)   ?? new Map<string, number>();
        const sds  = allSoftDeleted.get(entity)  ?? new Set<string>();
        out[entity] = records.map((r) => ({
          ...r,
          modifiedAt:  mods.get(r.id) ?? 0,
          watermark:   wms.get(r.id)  ?? 0,
          softDeleted: sds.has(r.id),
        }));
      }
      return out;
    },

    insertRecord(entity: string, data: Record<string, unknown>, associations?: Association[], explicitId?: string): string {
      const id = explicitId ?? (data["id"] as string | undefined) ?? crypto.randomUUID();
      const { wms, mods } = ensureMaps(entity);
      const existing = store.get(entity) ?? [];
      store.set(entity, [...existing, { id, data: { ...data }, ...(associations ? { associations } : {}) }]);
      wms.set(id, bump());
      mods.set(id, Date.now());
      return id;
    },

    updateRecord(entity: string, id: string, data: Record<string, unknown>, associations?: Association[]): void {
      const { wms, mods } = ensureMaps(entity);
      const existing = store.get(entity) ?? [];
      const idx = existing.findIndex((r) => r.id === id);
      if (idx === -1) return;
      const prev = existing[idx]!;
      const next = [...existing];
      next[idx] = {
        id,
        data: { ...prev.data, ...data },
        ...(associations !== undefined
          ? { associations }
          : prev.associations !== undefined ? { associations: prev.associations } : {}),
      };
      store.set(entity, next);
      wms.set(id, bump());
      mods.set(id, Date.now());
    },

    deleteRecord(entity: string, id: string): void {
      const existing = store.get(entity) ?? [];
      const idx = existing.findIndex((r) => r.id === id);
      if (idx === -1) return;
      const next = [...existing];
      next.splice(idx, 1);
      store.set(entity, next);
      allWatermarks.get(entity)?.delete(id);
      allModifiedAt.get(entity)?.delete(id);
      allSoftDeleted.get(entity)?.delete(id);
    },

    softDeleteRecord(entity: string, id: string): void {
      let sds = allSoftDeleted.get(entity);
      if (!sds) { sds = new Set(); allSoftDeleted.set(entity, sds); }
      sds.add(id);
    },

    restoreRecord(entity: string, id: string): void {
      allSoftDeleted.get(entity)?.delete(id);
      // Bump watermark so the engine picks up the re-appearing record on the
      // next incremental poll and can sync it to other connectors if needed.
      const { wms, mods } = ensureMaps(entity);
      if (wms.has(id)) {
        wms.set(id, bump());
        mods.set(id, Date.now());
      }
    },

    getActivityLog(): ActivityLogEntry[] {
      return activityLog;
    },

    clearActivityLog(): void {
      activityLog.length = 0;
    },
  };
}

