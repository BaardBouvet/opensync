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
import type { InMemoryConnector, ActivityLogEntry } from "./inmemory.js";
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
  shadowState: Array<{ connector_id: string; entity_name: string; external_id: string; canonical_id: string; deleted_at: string | null }>;
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
 * Boot a new engine from a scenario.
 * @param onEvent      called for each non-skip sync action during polling
 * @param onRefresh    called after each poll pass so the UI can re-render system columns
 * @param onTickStart  called before each tick group (onboard warmup or regular poll cycle)
 */
export async function startEngine(
  scenario: ScenarioDefinition,
  onEvent: (ev: SyncEvent) => void,
  onRefresh: () => void,
  pollMs = 2_000,
  onTickStart?: (phase: "onboard" | "poll") => void,
): Promise<EngineState> {
  // 1. Create one in-memory connector per fixed system
  const connectors = new Map<string, InMemoryConnector>();
  for (const systemId of FIXED_SYSTEMS) {
    connectors.set(systemId, createInMemoryConnector(systemId, FIXED_SEED[systemId] ?? {}));
  }

  // 2. Open a fresh in-memory sql.js database
  const db = await openBrowserDb();

  // 3. Build engine
  const config = buildConfig(scenario, connectors);
  const engine = new SyncEngine(config, db);

  // 4. Onboard any uninitialised channels
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
    await engine.onboard(ch.id, report);
  }

  // 4b. Emit onboarding READ + INSERT events.
  // First: emit one READ per source record from each connector (what was collected during
  // the collectOnly pass).  These have no `before` because they are initial reads —
  // all fields are shown as new (green) in the UI.
  // Then: emit INSERT events from the transaction_log for each fanout write onboard() made.
  // The boot tick separator is emitted first so all events group under the onboard tick.
  onTickStart?.("onboard");
  {
    // READs — one per record in each source connector's current snapshot
    for (const ch of config.channels) {
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
            // No `before` — initial read, record has no prior shadow state.
            phase: "onboard",
          });
        }
      }
    }

    // INSERTs — one per fanout write in transaction_log
    const onboardRows = db
      .prepare<{ connector_id: string; entity_name: string; external_id: string; canonical_id: string }>(
        `SELECT connector_id, entity_name, external_id, canonical_id
         FROM transaction_log WHERE action = 'insert' ORDER BY synced_at ASC`,
      )
      .all();
    for (const row of onboardRows) {
      const ch = config.channels.find((c) =>
        c.members.some((m) => m.connectorId === row.connector_id && m.entity === row.entity_name),
      );
      if (!ch) continue;
      // Infer source connector: another identity_map entry for the same canonical
      const other = db
        .prepare<{ connector_id: string }>(
          `SELECT connector_id FROM identity_map WHERE canonical_id = ? AND connector_id != ? LIMIT 1`,
        )
        .get(row.canonical_id, row.connector_id);
      const srcConnId = other?.connector_id ?? "onboard";
      const srcMember = ch.members.find((m) => m.connectorId === srcConnId);
      const tgtMember = ch.members.find((m) => m.connectorId === row.connector_id);
      // Look up the actual record data from the target connector so the event is expandable.
      const tgtConn = connectors.get(row.connector_id);
      const tgtRec = tgtConn?.snapshotFull()[row.entity_name]?.find((r) => r.id === row.external_id);
      onEvent({
        ts: hhmm(),
        channel: ch.id,
        sourceConnector: srcConnId,
        sourceEntity: srcMember?.entity ?? "?",
        targetConnector: row.connector_id,
        targetEntity: row.entity_name,
        action: "INSERT",
        sourceId: "(onboard)",
        targetId: row.external_id.slice(0, 8),
        after: tgtRec?.data,
        phase: "onboard",
      });
      // Suppress unused tgtMember reference (used for future extension)
      void tgtMember;
    }
  }

  // 4c. Warmup ingest: propagate associations that onboard() step-1b didn't include.
  // Matched-but-missing-connector fanout inserts do not carry associations; a normal
  // incremental ingest would skip seed records (their watermarks are ≤ the collectOnly
  // watermark). fullSync re-reads every record so echo-detection compares the actual
  // assocSentinel: shadow has undefined (collectOnly never stores it), incoming has a
  // sorted JSON string → they differ → fan-out dispatch runs and sets the association.
  // Watermarks are NOT advanced for fullSync runs, so the first regular poll still picks
  // up only records that changed after collectOnly.
  // NOTE: onRefresh() is NOT called here — startEngine() hasn't returned yet, so the
  // caller's engineState variable is still null. boot() handles the first UI refresh.
  for (const ch of config.channels) {
    for (const member of ch.members) {
      const result = await engine.ingest(ch.id, member.connectorId, { fullSync: true });
      emitEvents(result.records, ch, member.connectorId, onEvent, connectors, "onboard", false);
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
        const sourceEntity = ch.members.find((m) => m.connectorId === member.connectorId)?.entity;
        // Snapshot shadow state BEFORE ingest — used to compute READ event diffs.
        const sourceShadow = sourceEntity
          ? captureSourceShadow(db, member.connectorId, sourceEntity)
          : new Map<string, Record<string, unknown>>();
        const result = await engine.ingest(ch.id, member.connectorId);
        emitEvents(result.records, ch, member.connectorId, onEvent, connectors, "poll", true, sourceShadow);
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
          .prepare<{ connector_id: string; entity_name: string; external_id: string; canonical_id: string; deleted_at: string | null }>(
            "SELECT connector_id, entity_name, external_id, canonical_id, deleted_at FROM shadow_state ORDER BY connector_id, entity_name, external_id",
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

/**
 * Snapshot the recorded field values for every external_id of a connector+entity
 * from the shadow_state table.  Called *before* engine.ingest() so READ events can
 * show only the fields that actually changed compared to what the engine last knew.
 */
function captureSourceShadow(
  db: Db,
  connectorId: string,
  entityName: string,
): Map<string, Record<string, unknown>> {
  const rows = db
    .prepare<{ external_id: string; canonical_data: string }>(
      "SELECT external_id, canonical_data FROM shadow_state WHERE connector_id = ? AND entity_name = ?",
    )
    .all(connectorId, entityName);
  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const fd = JSON.parse(row.canonical_data) as Record<string, { val: unknown }>;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fd)) {
      if (!k.startsWith("__")) data[k] = v.val; // skip __assoc__ and other meta fields
    }
    map.set(row.external_id, data);
  }
  return map;
}

function emitEvents(
  records: RecordSyncResult[],
  ch: ChannelConfig,
  sourceConnectorId: string,
  onEvent: (ev: SyncEvent) => void,
  connectors: Map<string, InMemoryConnector>,
  phase?: SyncEvent["phase"],
  includeReads = false,
  sourceShadows?: Map<string, Record<string, unknown>>,
): void {
  const sourceEntity = ch.members.find((m) => m.connectorId === sourceConnectorId)?.entity;
  const sourceSnap = sourceEntity
    ? (connectors.get(sourceConnectorId)?.snapshotFull()[sourceEntity] ?? [])
    : [];

  // Emit one READ event per unique source record with at least one non-skip dispatch.
  if (includeReads) {
    const emittedReads = new Set<string>();
    for (const r of records) {
      if (r.action === "skip") continue;
      if (emittedReads.has(r.sourceId)) continue;
      emittedReads.add(r.sourceId);
      const srcRec = sourceSnap.find((rec) => rec.id === r.sourceId);
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
        data: srcRec?.data,
        before: sourceShadows?.get(r.sourceId), // shadow state before this ingest (for diff)
        phase,
      });
    }
  }

  // Emit dispatch events (insert / update / defer / error).
  for (const r of records) {
    if (r.action === "skip") continue;
    const targetMember = ch.members.find((m) => m.connectorId === r.targetConnectorId);
    // Look up the most-recent matching activity log entry for before/after data.
    let actEntry: ActivityLogEntry | undefined;
    if (r.action === "insert" || r.action === "update") {
      const log = connectors.get(r.targetConnectorId)?.getActivityLog() ?? [];
      for (let i = log.length - 1; i >= 0; i--) {
        if (log[i]!.id === r.targetId && log[i]!.op === r.action) {
          actEntry = log[i];
          break;
        }
      }
    }
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
      before: actEntry?.before,
      after: actEntry?.after,
      phase,
    });
  }
}
