// Engine lifecycle for the browser demo.
// Manages start / stop / reload (config change) / reset (re-seed only).
//
// The engine and db are entirely in-memory — a config change tears down the running
// engine, drops the sql.js database, and boots a fresh one from the scenario seed.

import { SyncEngine } from "@opensync/engine";
import type { ResolvedConfig, ConnectorInstance, ChannelConfig } from "@opensync/engine";
import type { RecordSyncResult, Db } from "@opensync/engine";
import { openBrowserDb } from "./db-sqljs.js";
import { createInMemoryConnector } from "./inmemory.js";
import type { InMemoryConnector } from "./inmemory.js";
import type { ScenarioDefinition } from "./scenarios/index.js";
import { FIXED_SEED, FIXED_SYSTEMS } from "./lib/systems.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface EngineState {
  scenario: ScenarioDefinition;
  /** Map of systemId → InMemoryConnector (for UI mutation and snapshot). */
  connectors: Map<string, InMemoryConnector>;
  engine: SyncEngine;
  /** Returns identity clusters for a channel, grouped by canonical ID. */
  getClusters(channelId: string): ChannelCluster[];
  /** Returns a snapshot of key internal tables for the DB State dev view. */
  getDbState(): DbSnapshot;
  /** Whether the automatic poll interval is currently running. */
  readonly isRealtime: boolean;
  /** Pause the automatic poll interval (manual sync mode). */
  pause(): void;
  /** Resume the automatic poll interval (real-time mode). */
  resume(): void;
  /** Run one poll cycle immediately (used by manual sync button). */
  pollOnce(): Promise<void>;
  stop(): void;
}

export interface DbSnapshot {
  identityMap: Array<{ canonical_id: string; connector_id: string; external_id: string }>;
  shadowState: Array<{ connector_id: string; entity_name: string; external_id: string; canonical_id: string; canonical_data: string; deleted_at: string | null }>;
  watermarks: Array<{ connector_id: string; entity_name: string; since: string }>;
  channelStatus: Array<{ channel_id: string; entity: string; marked_ready_at: string }>;
}

export interface SyncEvent {
  ts: string;            // HH:MM:SS
  channel: string;
  sourceConnector: string;
  sourceEntity: string;
  targetConnector: string;
  targetEntity: string;
  action: string;
  sourceId: string;
  targetId: string;
  /** "onboard" during boot warmup pass; "poll" during regular interval; undefined = legacy. */
  phase?: "onboard" | "poll";
  /** For READ/INSERT: full record data. */
  data?: Record<string, unknown>;
  /** For READ: source record shadow state before this ingest started (enables diff display).
   *  For UPDATE: state before the write. */
  before?: Record<string, unknown>;
  /** For INSERT/UPDATE: state after the write. */
  after?: Record<string, unknown>;
  /** For READ: associations on the incoming source record. */
  sourceAssociations?: Array<{ predicate: string; targetEntity: string; targetId: string }>;
  /** For READ: associations from the source shadow before this ingest. */
  sourceShadowAssociations?: Array<{ predicate: string; targetEntity: string; targetId: string }>;
  /** For UPDATE: associations stored in the target shadow before the write. */
  beforeAssociations?: Array<{ predicate: string; targetEntity: string; targetId: string }>;
  /** For INSERT/UPDATE: remapped associations written to the target. */
  afterAssociations?: Array<{ predicate: string; targetEntity: string; targetId: string }>;
}

// ─── Cluster types ────────────────────────────────────────────────────────────

export interface ChannelClusterSlot {
  connectorId: string;
  entity: string;
  /** All external IDs from this connector in this cluster.
   * Linked clusters always have exactly one entry. Unlinked clusters may have multiple
   * (all unlinked records from the same connector are grouped into one cluster). */
  externalIds: string[];
}

/** One identity cluster in a channel — one slot per channel member (null = not linked). */
export interface ChannelCluster {
  canonicalId: string | null; // null = records not yet ingested by engine
  slots: Array<ChannelClusterSlot | null>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hhmm(): string {
  return new Date().toISOString().slice(11, 19);
}

function buildConfig(scenario: ScenarioDefinition, connectors: Map<string, InMemoryConnector>): ResolvedConfig {
  const instances: ConnectorInstance[] = FIXED_SYSTEMS.map((id) => ({
    id,
    connector: connectors.get(id)!.connector,
    config: {},
    auth: {},
    batchIdRef: { current: undefined },
    triggerRef: { current: undefined },
  }));
  return {
    connectors: instances,
    channels: scenario.channels,
    conflict: scenario.conflict,
    readTimeoutMs: 30_000,
  };
}

// ─── startEngine ─────────────────────────────────────────────────────────────

/**
 * Build unlinked clusters from seed connector data — used for the pre-onboard render.
 * Each seed record becomes its own cluster with canonicalId === null and a single
 * non-null slot; other member slots are null (not yet linked).
 * Spec: specs/playground.md § 10
 */
function buildSeedClusters(
  channelId: string,
  connectors: Map<string, InMemoryConnector>,
  channels: ChannelConfig[],
): ChannelCluster[] {
  const ch = channels.find((c) => c.id === channelId);
  if (!ch) return [];
  const clusters: ChannelCluster[] = [];
  ch.members.forEach((member, mi) => {
    const conn = connectors.get(member.connectorId);
    if (!conn) return;
    const recs = conn.snapshotFull()[member.entity] ?? [];
    for (const rec of recs) {
      const slots: Array<ChannelClusterSlot | null> = ch.members.map((_, i) =>
        i === mi
          ? { connectorId: member.connectorId, entity: member.entity, externalIds: [rec.id] }
          : null,
      );
      clusters.push({ canonicalId: null, slots });
    }
  });
  return clusters;
}

/**
 * Boot a new engine from a scenario.
 * @param onEvent       called for each non-skip sync action during polling
 * @param onRefresh     called after each poll pass so the UI can re-render system columns
 * @param onTickStart   called before each tick group (onboard warmup or regular poll cycle)
 * @param onAfterSeed   called after connectors are seeded but before onboarding fanout;
 *                      receives connectors + a pre-onboard cluster builder so the UI can
 *                      render the seed-only state before cross-system inserts appear.
 */
export async function startEngine(
  scenario: ScenarioDefinition,
  onEvent: (ev: SyncEvent) => void,
  onRefresh: () => void,
  pollMs = 2_000,
  onTickStart?: (phase: "onboard" | "poll") => void,
  onAfterSeed?: (
    connectors: Map<string, InMemoryConnector>,
    preClusters: (channelId: string) => ChannelCluster[],
  ) => void,
): Promise<EngineState> {
  // 1. Create one in-memory connector per fixed system
  const connectors = new Map<string, InMemoryConnector>();
  for (const systemId of FIXED_SYSTEMS) {
    connectors.set(systemId, createInMemoryConnector(systemId, FIXED_SEED[systemId] ?? {}));
  }

  // 1b. Let the UI render the seed-only state before onboarding fanout writes.
  // Spec: specs/playground.md § 10
  onAfterSeed?.(connectors, (chId) => buildSeedClusters(chId, connectors, scenario.channels));

  // 2. Open a fresh in-memory sql.js database
  const db = await openBrowserDb();

  // 3. Build engine
  const config = buildConfig(scenario, connectors);
  const engine = new SyncEngine(config, db);

  // 4. Onboard any uninitialised channels
  const onboardResults = new Map<string, Awaited<ReturnType<SyncEngine["onboard"]>>>();
  for (const ch of config.channels) {
    if (engine.channelStatus(ch.id) !== "uninitialized") continue;

    const collects = [];
    for (const member of ch.members) {
      collects.push(
        await engine.ingest(ch.id, member.connectorId, { collectOnly: true }),
      );
    }

    const snapshotAt = collects.reduce(
      (min, c) => Math.min(min, c.snapshotAt ?? Date.now()),
      Date.now(),
    );

    const report = await engine.discover(ch.id, snapshotAt);
    const onboardResult = await engine.onboard(ch.id, report);
    onboardResults.set(ch.id, onboardResult);
  }

  // 4b. Emit onboarding READ + INSERT events.
  // READs: one per record in each source connector's current snapshot (no `before` — initial
  // read, no prior shadow state).
  // INSERTs: from onboardResult.inserts (fanout writes made by onboard()).
  onTickStart?.("onboard");
  {
    for (const ch of config.channels) {
      const onboardRes = onboardResults.get(ch.id);
      if (!onboardRes) continue; // channel was already initialized

      // READs
      for (const member of ch.members) {
        const snap = connectors.get(member.connectorId)?.snapshotFull()[member.entity] ?? [];
        for (const rec of snap) {
          onEvent({
            ts: hhmm(),
            channel: ch.id,
            sourceConnector: member.connectorId,
            sourceEntity: member.entity,
            targetConnector: member.connectorId,
            targetEntity: member.entity,
            action: "READ",
            sourceId: rec.id.slice(0, 8),
            targetId: rec.id.slice(0, 8),
            data: rec.data as Record<string, unknown>,
            sourceAssociations: rec.associations?.length ? rec.associations : undefined,
            phase: "onboard",
          });
        }
      }

      // INSERTs from onboard()
      for (const r of onboardRes.inserts) {
        const srcMember = ch.members.find((m) => m.connectorId !== r.targetConnectorId);
        onEvent({
          ts: hhmm(),
          channel: ch.id,
          sourceConnector: srcMember?.connectorId ?? "onboard",
          sourceEntity: srcMember?.entity ?? "?",
          targetConnector: r.targetConnectorId,
          targetEntity: r.entity,
          action: "INSERT",
          sourceId: r.sourceId.slice(0, 8),
          targetId: r.targetId.slice(0, 8),
          after: r.after,
          afterAssociations: r.afterAssociations,
          phase: "onboard",
        });
      }
    }
  }

  // 5. Poll loop
  let stopped = false;
  let paused = false;
  let pollTick = 0;

  async function doPoll(): Promise<void> {
    pollTick++;
    onTickStart?.("poll");
    for (const ch of config.channels) {
      for (const member of ch.members) {
        const result = await engine.ingest(ch.id, member.connectorId);
        emitEvents(result.records, ch, member.connectorId, onEvent, "poll");
      }
    }
    onRefresh();
  }

  const poll = async () => {
    if (stopped || paused) return;
    await doPoll();
  };

  const interval = setInterval(() => { void poll(); }, pollMs);

  return {
    scenario,
    connectors,
    engine,
    get isRealtime() { return !paused; },
    pause() { paused = true; },
    resume() { paused = false; },
    async pollOnce(): Promise<void> {
      if (stopped) return;
      await doPoll();
    },
    getClusters(channelId: string): ChannelCluster[] {
      return computeClusters(channelId, engine, connectors, config.channels);
    },
    getDbState(): DbSnapshot {
      return {
        identityMap: db
          .prepare<{ canonical_id: string; connector_id: string; external_id: string }>(
            "SELECT canonical_id, connector_id, external_id FROM identity_map ORDER BY canonical_id, connector_id",
          )
          .all(),
        shadowState: db
          .prepare<{ connector_id: string; entity_name: string; external_id: string; canonical_id: string; canonical_data: string; deleted_at: string | null }>(
            "SELECT connector_id, entity_name, external_id, canonical_id, canonical_data, deleted_at FROM shadow_state ORDER BY connector_id, entity_name, external_id",
          )
          .all(),
        watermarks: db
          .prepare<{ connector_id: string; entity_name: string; since: string }>(
            "SELECT connector_id, entity_name, since FROM watermarks ORDER BY connector_id, entity_name",
          )
          .all(),
        channelStatus: db
          .prepare<{ channel_id: string; entity: string; marked_ready_at: string }>(
            "SELECT channel_id, entity, marked_ready_at FROM channel_onboarding_status ORDER BY channel_id",
          )
          .all(),
      };
    },
    stop() {
      stopped = true;
      clearInterval(interval);
      db.close();
    },
  };
}

// ─── Cluster computation ──────────────────────────────────────────────────────

function computeClusters(
  channelId: string,
  engine: SyncEngine,
  connectors: Map<string, InMemoryConnector>,
  channels: ChannelConfig[],
): ChannelCluster[] {
  const ch = channels.find((c) => c.id === channelId);
  if (!ch) return [];

  const identityMap = engine.getChannelIdentityMap(channelId);
  const result: ChannelCluster[] = [];
  const covered = new Set<string>(); // "connectorId/externalId"

  // Linked clusters from identity_map
  for (const [canonicalId, linkedMap] of identityMap) {
    const slots: Array<ChannelClusterSlot | null> = ch.members.map((m) => {
      const externalId = linkedMap.get(m.connectorId);
      if (!externalId) return null;
      covered.add(`${m.connectorId}/${externalId}`);
      return { connectorId: m.connectorId, entity: m.entity, externalIds: [externalId] };
    });
    result.push({ canonicalId, slots });
  }

  // Unlinked records — group all unlinked records per connector into one cluster
  // so multiple pending records from the same system appear together.
  const unlinkedByConnector = new Map<string, string[]>(); // connectorId → externalIds
  for (const m of ch.members) {
    const conn = connectors.get(m.connectorId);
    if (!conn) continue;
    for (const r of (conn.snapshotFull()[m.entity] ?? [])) {
      const key = `${m.connectorId}/${r.id}`;
      if (covered.has(key)) continue;
      covered.add(key);
      const arr = unlinkedByConnector.get(m.connectorId) ?? [];
      arr.push(r.id);
      unlinkedByConnector.set(m.connectorId, arr);
    }
  }
  for (const [connId, ids] of unlinkedByConnector) {
    const slots: Array<ChannelClusterSlot | null> = ch.members.map((m) =>
      m.connectorId === connId
        ? { connectorId: connId, entity: m.entity, externalIds: ids }
        : null,
    );
    result.push({ canonicalId: null, slots });
  }

  return result;
}

// ─── Emit helpers ─────────────────────────────────────────────────────────────

function emitEvents(
  records: RecordSyncResult[],
  ch: ChannelConfig,
  sourceConnectorId: string,
  onEvent: (ev: SyncEvent) => void,
  phase?: SyncEvent["phase"],
): void {
  const sourceEntity = ch.members.find((m) => m.connectorId === sourceConnectorId)?.entity;
  for (const r of records) {
    if (r.action === "skip") continue;
    if (r.action === "read") {
      onEvent({
        ts: hhmm(),
        channel: ch.id,
        sourceConnector: sourceConnectorId,
        sourceEntity: sourceEntity ?? r.entity,
        targetConnector: sourceConnectorId,
        targetEntity: sourceEntity ?? r.entity,
        action: "READ",
        sourceId: r.sourceId.slice(0, 8),
        targetId: r.sourceId.slice(0, 8),
        data: r.sourceData,
        before: r.sourceShadow,
        sourceAssociations: r.sourceAssociations,
        sourceShadowAssociations: r.sourceShadowAssociations,
        phase,
      });
    } else {
      const targetMember = ch.members.find((m) => m.connectorId === r.targetConnectorId);
      onEvent({
        ts: hhmm(),
        channel: ch.id,
        sourceConnector: sourceConnectorId,
        sourceEntity: r.entity,
        targetConnector: r.targetConnectorId,
        targetEntity: targetMember?.entity ?? r.entity,
        action: r.action.toUpperCase(),
        sourceId: r.sourceId.slice(0, 8),
        targetId: r.targetId.slice(0, 8),
        before: r.before,
        beforeAssociations: r.beforeAssociations,
        after: r.after,
        afterAssociations: r.afterAssociations,
        phase,
      });
    }
  }
}
