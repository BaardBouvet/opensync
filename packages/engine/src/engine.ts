// Spec: specs/sync-engine.md
// Production SyncEngine — ported from poc/v9/engine.ts with:
//   - Gap 1: snapshot_at watermark anchor
//   - Gap 2: circuit breaker DB persistence (via CircuitBreaker class)
//   - Gap 6: 412 retry loop
//   - Gap 8: onboarding inserts routed through safety pipeline

import type {
  Association,
  ReadRecord,
  InsertRecord,
  UpdateRecord,
} from "@opensync/sdk";
import type { Db } from "./db/index.js";
import type { ChannelConfig, ChannelMember, ConflictConfig, ResolvedConfig } from "./config/loader.js";
import type { WiredConnectorInstance } from "./auth/context.js";
import type { FieldData } from "./db/schema.js";
import {
  dbGetCanonicalId,
  dbGetExternalId,
  dbLinkIdentity,
  dbMergeCanonicals,
  dbFindCanonicalByField,
  dbGetAllCanonicals,
  dbGetCanonicalsByChannelMembers,
  dbGetCanonicalFields,
  dbGetWatermark,
  dbSetWatermark,
  dbGetShadow,
  dbGetShadowRow,
  dbSetShadow,
  dbGetAllShadowForEntity,
  shadowToCanonical,
  buildFieldData,
  dbLogTransaction,
  dbLogSyncRun,
  dbGetChannelStatus,
  dbSetChannelReady,
  dbInsertDeferred,
  dbGetDeferred,
  dbRemoveDeferred,
} from "./db/queries.js";
import { applyMapping } from "./core/mapping.js";
import { resolveConflicts } from "./core/conflict.js";
import { CircuitBreaker } from "./safety/circuit-breaker.js";
import { createSchema } from "./db/migrations.js";
import { makeWiredInstance } from "./auth/context.js";

// ─── Public result types ──────────────────────────────────────────────────────

// Spec: specs/sync-engine.md § RecordSyncResult
export type SyncAction = "read" | "insert" | "update" | "skip" | "defer" | "error";

export interface RecordSyncResult {
  entity: string;
  action: SyncAction;
  sourceId: string;
  targetConnectorId: string;
  targetId: string;
  error?: string;
  // ── Payload fields ────────────────────────────────────────────────────────
  /** READ: source record field values after inbound mapping. Present for non-skip reads. */
  sourceData?: Record<string, unknown>;
  /** READ: engine's last known field values for the source record (shadow before this ingest). */
  sourceShadow?: Record<string, unknown>;
  /** INSERT/UPDATE: resolved canonical field values written to the target. */
  after?: Record<string, unknown>;
  /** UPDATE: target's previous field values from shadow_state before the write. */
  before?: Record<string, unknown>;
  // ── Association payload fields ─────────────────────────────────────────────
  /** READ: associations on the incoming source record. */
  sourceAssociations?: Association[];
  /** READ: associations stored in the source shadow before this ingest pass. */
  sourceShadowAssociations?: Association[];
  /** INSERT/UPDATE: remapped associations written to the target connector. */
  afterAssociations?: Association[];
  /** UPDATE: associations stored in the target shadow before the write. */
  beforeAssociations?: Association[];
}

export interface IngestResult {
  channelId: string;
  connectorId: string;
  records: RecordSyncResult[];
  /** For collectOnly: timestamp (ms since epoch) at which read phase started. Gap 1 fix. Pass to discover(). */
  snapshotAt?: number;
}

// ─── Discovery types ──────────────────────────────────────────────────────────

export interface DiscoverySide {
  connectorId: string;
  externalId: string;
  rawData: Record<string, unknown>;
}

export interface DiscoveryMatch {
  canonicalData: Record<string, unknown>;
  sides: DiscoverySide[];
}

export interface DiscoveryReport {
  channelId: string;
  entity: string;
  /** Timestamp at which collectOnly ingest started — use as watermark anchor. Gap 1 fix. */
  snapshotAt?: number;
  matched: DiscoveryMatch[];
  uniquePerSide: DiscoverySide[];
  summary: Record<string, { total: number; matched: number; unique: number }>;
}

export interface OnboardResult {
  linked: number;
  shadowsSeeded: number;
  uniqueQueued: number;
  /** Individual fanout INSERT records produced during onboarding. */
  inserts: RecordSyncResult[];
}

export type ChannelStatus = "uninitialized" | "collected" | "ready";

export interface AddConnectorOptions {
  dryRun?: boolean;
  missingFromJoiner?: "propagate" | "skip";
}

export interface AddConnectorReport {
  channelId: string;
  connectorId: string;
  linked: Array<{ canonicalId: string; externalId: string; matchedOn: string[] }>;
  newFromJoiner: Array<{ externalId: string; data: Record<string, unknown> }>;
  missingInJoiner: Array<{ canonicalId: string; data: Record<string, unknown> }>;
  summary: { totalInJoiner: number; linked: number; newFromJoiner: number; missingInJoiner: number };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Spec: specs/sync-engine.md § RecordSyncResult — materialise FieldData to a plain
 * Record by extracting .val from each entry, skipping __-prefixed meta keys. */
function fieldDataToRecord(fd: FieldData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fd)) {
    if (!k.startsWith("__")) out[k] = v.val;
  }
  return out;
}

/** Parse the sorted-JSON assoc sentinel stored as __assoc__ back to Association[].  Returns
 * undefined if no sentinel is present or the array would be empty. */
function parseSentinelAssociations(fd: FieldData): Association[] | undefined {
  const raw = fd["__assoc__"]?.val;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as Association[];
    return parsed.length ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ─── ConflictError — signals a 412 Precondition Failed ───────────────────────

export class ConflictError extends Error {
  constructor(public readonly targetId: string) {
    super(`Conflict (412) on record ${targetId}`);
    this.name = "ConflictError";
  }
}

// ─── SyncEngine ───────────────────────────────────────────────────────────────

export class SyncEngine {
  private readonly wired: Map<string, WiredConnectorInstance>;
  private readonly channels: Map<string, ChannelConfig>;
  private readonly db: Db;
  private readonly conflictConfig: ConflictConfig;
  private readonly breakers: Map<string, CircuitBreaker>;
  private readonly readTimeoutMs: number;

  constructor(config: ResolvedConfig, db: Db, webhookBaseUrl = "") {
    this.db = db;
    this.conflictConfig = config.conflict;
    this.readTimeoutMs = config.readTimeoutMs;
    this.channels = new Map(config.channels.map((ch) => [ch.id, ch]));

    // Schema is created idempotently on construction
    createSchema(db);

    // Wire each connector instance with a live ConnectorContext
    this.wired = new Map();
    for (const instance of config.connectors) {
      this.wired.set(instance.id, makeWiredInstance(instance, db, webhookBaseUrl));
    }

    // One CircuitBreaker per channel — persisted to DB (Gap 2)
    this.breakers = new Map();
    for (const ch of config.channels) {
      this.breakers.set(ch.id, new CircuitBreaker(ch.id, db));
    }
  }

  // ─── Channel status ───────────────────────────────────────────────────────

  channelStatus(channelId: string): ChannelStatus {
    const channel = this.channels.get(channelId);
    if (!channel) return "uninitialized";

    // Spec: specs/sync-engine.md — all shadow/identity queries must be scoped to these
    // channel members' (connectorId, entity) pairs, not just connectorId. Without entity
    // scoping a multi-channel scenario (e.g. companies + contacts sharing crm/erp/hr) would
    // cause the second channel to see the first channel's shadow rows and believe it is
    // already "collected", skipping onboarding entirely.
    const memberClauses = channel.members.map(() => "(connector_id = ? AND entity_name = ?)").join(" OR ");
    const memberParams = channel.members.flatMap((m) => [m.connectorId, m.entity]);

    const base = dbGetChannelStatus(this.db, channelId);
    if (base === "ready") {
      // Entity-aware cross-link check: canonicals linked across 2+ of this channel's specific entities
      const idClauses = channel.members.map(() => "(im.connector_id = ? AND ss.entity_name = ?)").join(" OR ");
      const idParams = channel.members.flatMap((m) => [m.connectorId, m.entity]);
      const crossLinked = this.db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) as n FROM (
             SELECT im.canonical_id
             FROM identity_map im
             JOIN shadow_state ss ON ss.connector_id = im.connector_id AND ss.external_id = im.external_id
             WHERE (${idClauses})
             GROUP BY im.canonical_id HAVING COUNT(DISTINCT im.connector_id) > 1)`,
        )
        .get(...idParams);
      if ((crossLinked?.n ?? 0) > 0) return "ready";
    }

    const hasShadow = this.db
      .prepare<{ n: number }>(
        `SELECT COUNT(*) as n FROM shadow_state WHERE (${memberClauses})`,
      )
      .get(...memberParams);
    return (hasShadow?.n ?? 0) > 0 ? "collected" : "uninitialized";
  }

  onboardedConnectors(channelId: string): string[] {
    const channel = this.channels.get(channelId);
    if (!channel) return [];
    const memberIds = channel.members.map((m) => m.connectorId);
    const ph = memberIds.map(() => "?").join(", ");
    return this.db
      .prepare<{ connector_id: string }>(
        `SELECT DISTINCT connector_id FROM identity_map WHERE connector_id IN (${ph})
         AND canonical_id IN (
           SELECT canonical_id FROM identity_map
           GROUP BY canonical_id HAVING COUNT(DISTINCT connector_id) > 1)`,
      )
      .all(...memberIds)
      .map((r) => r.connector_id);
  }

  // ─── ingest ───────────────────────────────────────────────────────────────

  // Spec: specs/sync-engine.md § Ingest Loop
  async ingest(
    channelId: string,
    connectorId: string,
    opts?: { collectOnly?: boolean; fullSync?: boolean },
  ): Promise<IngestResult> {
    const startedAt = new Date().toISOString();
    const batchId = crypto.randomUUID();

    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Unknown channel: ${channelId}`);

    const sourceMember = channel.members.find((m) => m.connectorId === connectorId);
    if (!sourceMember) throw new Error(`${connectorId} is not a member of channel ${channelId}`);

    const source = this.wired.get(connectorId);
    if (!source) throw new Error(`Unknown connector: ${connectorId}`);

    const sourceEntity = source.entities.find((e) => e.name === sourceMember.entity);
    if (!sourceEntity || !sourceEntity.read) return { channelId, connectorId, records: [] };
    const sourceRead = sourceEntity.read;

    // ── collectOnly fast path ─────────────────────────────────────────────
    // Spec: specs/sync-engine.md § collectOnly mode
    if (opts?.collectOnly) {
      const snapshotAt = Date.now();
      const ts = snapshotAt;
      const since = opts.fullSync
        ? undefined
        : dbGetWatermark(this.db, connectorId, sourceMember.entity);

      if (source.batchIdRef) source.batchIdRef.current = batchId;
      let connectorWatermark: string | undefined;
      try {
        for await (const batch of sourceRead(source.ctx, since)) {
          for (const record of batch.records) {
            const raw = record.data as Record<string, unknown>;
            const stripped = Object.fromEntries(
              Object.entries(raw).filter(([k]) => !k.startsWith("_")),
            );
            const canonical = applyMapping(stripped, sourceMember.inbound, "inbound");
            const provisionalId = this._getOrCreateCanonical(connectorId, record.id);
            const existing = dbGetShadow(this.db, connectorId, sourceMember.entity, record.id);
            const fd = buildFieldData(existing, canonical, connectorId, ts, undefined);
            dbSetShadow(this.db, connectorId, sourceMember.entity, record.id, provisionalId, fd);
          }
          if (batch.since) connectorWatermark = batch.since;
        }
      } finally {
        if (source.batchIdRef) source.batchIdRef.current = undefined;
      }

      // Store the connector's watermark exactly as returned — watermarks are opaque.
      // If the connector returned no batch.since (e.g. empty read), store nothing:
      // the next poll will pass since=undefined (full sync), which is correct.
      if (connectorWatermark !== undefined) {
        dbSetWatermark(this.db, connectorId, sourceMember.entity, connectorWatermark);
      }
      return { channelId, connectorId, records: [], snapshotAt };
    }

    // ── Normal sync path ─────────────────────────────────────────────────

    const breaker = this._breaker(channelId);
    if (breaker.evaluate() === "OPEN") {
      return { channelId, connectorId, records: [] };
    }

    const pollTargets = channel.members
      .filter((m) => m.connectorId !== connectorId)
      .flatMap((m) => { const w = this.wired.get(m.connectorId); return w ? [w] : []; });

    if (source.batchIdRef) source.batchIdRef.current = batchId;
    if (source.triggerRef) source.triggerRef.current = "poll";
    for (const t of pollTargets) {
      if (t.batchIdRef) t.batchIdRef.current = batchId;
      if (t.triggerRef) t.triggerRef.current = "poll";
    }

    try {
      const ingestTs = Date.now();
      const since = opts?.fullSync
        ? undefined
        : dbGetWatermark(this.db, connectorId, sourceMember.entity);

      const allRecords: ReadRecord[] = [];
      let newWatermark: string | undefined;

      await Promise.race([
        (async () => {
          for await (const batch of sourceRead(source.ctx, since)) {
            allRecords.push(...batch.records);
            if (batch.since) newWatermark = batch.since;
          }
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`read() timeout after ${this.readTimeoutMs}ms (${connectorId})`)),
            this.readTimeoutMs,
          )
        ),
      ]);

      const results = await this._processRecords(
        channelId,
        sourceMember,
        allRecords,
        batchId,
        ingestTs,
      );

      // Spec: plans/engine/PLAN_DEFERRED_ASSOCIATIONS.md §2.3
      // Retry any previously-deferred records via lookup() so associations that
      // couldn't be remapped at fan-out time are propagated once the identity
      // link is established (typically the cycle after onboard).
      const deferred = dbGetDeferred(this.db, connectorId, sourceMember.entity);
      if (deferred.length > 0) {
        const sourceEntityDef = source.entities.find((e) => e.name === sourceMember.entity);
        if (sourceEntityDef?.lookup) {
          const uniqueIds = [...new Set(deferred.map((d) => d.source_external_id))];
          const alreadyProcessed = new Set(allRecords.map((r) => r.id));
          const idsToLookup = uniqueIds.filter((id) => !alreadyProcessed.has(id));
          if (idsToLookup.length > 0) {
            const lookedUp = await sourceEntityDef.lookup(idsToLookup, source.ctx);
            if (lookedUp.length > 0) {
              // Pass the looked-up IDs as skipEchoFor so echo detection is bypassed for
              // records whose source shadow was already written on the first deferred pass.
              const retryIds = new Set(lookedUp.map((r) => r.id));
              const retryResults = await this._processRecords(
                channelId, sourceMember, lookedUp, batchId, ingestTs, retryIds,
              );
              results.push(...retryResults);
            }
            // Records that lookup returned nothing for → remove deferred rows (source deleted)
            const returnedIds = new Set(lookedUp.map((r) => r.id));
            for (const id of idsToLookup) {
              if (!returnedIds.has(id)) {
                for (const row of deferred.filter((d) => d.source_external_id === id)) {
                  dbRemoveDeferred(this.db, connectorId, sourceMember.entity, id, row.target_connector);
                }
              }
            }
          }
        }
      }

      if (newWatermark && !opts?.fullSync) {
        dbSetWatermark(this.db, connectorId, sourceMember.entity, newWatermark);
      }

      const counts = { inserted: 0, updated: 0, skipped: 0, deferred: 0, errors: 0 };
      for (const r of results) {
        if (r.action === "insert") counts.inserted++;
        else if (r.action === "update") counts.updated++;
        else if (r.action === "skip") counts.skipped++;
        else if (r.action === "defer") counts.deferred++;
        else if (r.action === "error") counts.errors++;
      }

      dbLogSyncRun(this.db, {
        batchId, channelId, connectorId, ...counts, startedAt,
        finishedAt: new Date().toISOString(),
      });

      return { channelId, connectorId, records: results };
    } finally {
      if (source.triggerRef) source.triggerRef.current = undefined;
      for (const t of pollTargets) {
        if (t.triggerRef) t.triggerRef.current = undefined;
        if (t.batchIdRef) t.batchIdRef.current = undefined;
      }
      if (source.batchIdRef) source.batchIdRef.current = undefined;
    }
  }

  // ─── discover ─────────────────────────────────────────────────────────────

  // Spec: specs/discovery.md, specs/sync-engine.md § collectOnly mode
  async discover(channelId: string, snapshotAt?: number): Promise<DiscoveryReport> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Unknown channel: ${channelId}`);
    if (channel.members.length < 2) throw new Error(`discover() needs at least 2 members`);

    const entity = channel.members[0].entity;

    type Side = { connectorId: string; records: Array<{ id: string; canonical: Record<string, unknown> }> };
    const sides: Side[] = [];

    for (const member of channel.members) {
      const rows = dbGetAllShadowForEntity(this.db, member.connectorId, member.entity);
      if (rows.length === 0) {
        throw new Error(
          `Connector "${member.connectorId}" has no shadow_state for "${member.entity}". ` +
          `Run ingest("${channelId}", "${member.connectorId}", { collectOnly: true }) first.`,
        );
      }
      sides.push({
        connectorId: member.connectorId,
        records: rows.map(({ externalId, fieldData }) => ({
          id: externalId,
          canonical: shadowToCanonical(fieldData),
        })),
      });
    }

    const identityFields = channel.identityFields ?? [];
    const normalise = (v: unknown): string =>
      typeof v === "string" ? v.toLowerCase().trim() : String(v ?? "");
    const buildKey = (r: Record<string, unknown>): string | undefined => {
      if (!identityFields.length) return undefined;
      return identityFields.map((f) => normalise(r[f])).join("\x01");
    };

    // Spec: specs/sync-engine.md § Discover — group all records by identity key
    // across all connectors. Any key with 2+ sides is a match; 1-of-N is unique.
    // This handles partial N-way matches (e.g. Alice in A+B but not C).
    const keyIndex = new Map<string, DiscoverySide[]>();
    const matched: DiscoveryMatch[] = [];
    const uniquePerSide: DiscoverySide[] = [];

    for (const side of sides) {
      for (const r of side.records) {
        const k = buildKey(r.canonical);
        if (!k) {
          uniquePerSide.push({ connectorId: side.connectorId, externalId: r.id, rawData: r.canonical });
          continue;
        }
        const existing = keyIndex.get(k) ?? [];
        existing.push({ connectorId: side.connectorId, externalId: r.id, rawData: r.canonical });
        keyIndex.set(k, existing);
      }
    }

    for (const [, keySides] of keyIndex.entries()) {
      if (keySides.length >= 2) {
        matched.push({ canonicalData: keySides[0]!.rawData, sides: keySides });
      } else {
        uniquePerSide.push(keySides[0]!);
      }
    }

    const summary: DiscoveryReport["summary"] = {};
    for (const s of sides) {
      summary[s.connectorId] = {
        total: s.records.length,
        matched: matched.filter((m) => m.sides.some((x) => x.connectorId === s.connectorId)).length,
        unique: uniquePerSide.filter((u) => u.connectorId === s.connectorId).length,
      };
    }

    return { channelId, entity, snapshotAt, matched, uniquePerSide, summary };
  }

  // ─── onboard ─────────────────────────────────────────────────────────────

  // Spec: specs/discovery.md
  // Gap 1: use snapshotAt from report as watermark (not Date.now())
  // Gap 8: route unique-per-side propagation through _processRecords
  async onboard(
    channelId: string,
    report: DiscoveryReport,
    opts?: { dryRun?: boolean },
  ): Promise<OnboardResult> {
    const dryRun = opts?.dryRun ?? false;
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Unknown channel: ${channelId}`);

    let linked = 0;
    let shadowsSeeded = 0;
    let uniqueQueued = 0;
    const ts = Date.now();

    if (dryRun) {
      for (const m of report.matched) { linked += m.sides.length; shadowsSeeded += m.sides.length; }
      uniqueQueued = report.uniquePerSide.length;
      return { linked, shadowsSeeded, uniqueQueued, inserts: [] };
    }

    // Gap 2: check circuit breaker before any writes (Gap 8 safety pipeline)
    const breaker = this._breaker(channelId);
    if (breaker.evaluate() === "OPEN") {
      throw new Error(`Circuit breaker OPEN for channel "${channelId}" — onboard() blocked`);
    }

    // Spec: specs/sync-engine.md § Onboard — per-connector entity name lookup.
    // report.entity = channel.members[0].entity, which is wrong for connectors
    // with a different entity name. Use memberByConnector for all entity lookups.
    const memberByConnector = new Map(channel.members.map((m) => [m.connectorId, m]));

    // 1. Merge matched provisional canonicals
    // Build a map of match index → final canonical ID so step 1b can propagate
    // matched records to connectors not present in match.sides.
    //
    // Spec: plans/engine/PLAN_ENGINE_USABILITY.md § 3 — pre-fetch each side's own
    // associations so the seeded shadow includes the assoc sentinel, ensuring the
    // first incremental poll sees no spurious diff for matched records.
    const matchSideAssoc = new Map<string, Association[] | undefined>(); // "connId/extId" → assoc
    for (const match of report.matched) {
      for (const side of match.sides) {
        const key = `${side.connectorId}/${side.externalId}`;
        if (matchSideAssoc.has(key)) continue;
        const sideWired = this.wired.get(side.connectorId);
        const sideMember = memberByConnector.get(side.connectorId);
        const sideEntityDef = sideWired?.entities.find((e) => e.name === sideMember?.entity);
        if (sideEntityDef?.lookup) {
          const recs = await sideEntityDef.lookup([side.externalId], sideWired!.ctx);
          matchSideAssoc.set(key, recs.find((r) => r.id === side.externalId)?.associations);
        }
      }
    }

    const matchCanonicals = new Map<number, string>();
    this.db.transaction(() => {
      for (let mi = 0; mi < report.matched.length; mi++) {
        const match = report.matched[mi]!;
        let winnerId = dbGetCanonicalId(this.db, match.sides[0].connectorId, match.sides[0].externalId);
        if (!winnerId) {
          winnerId = crypto.randomUUID();
          dbLinkIdentity(this.db, winnerId, match.sides[0].connectorId, match.sides[0].externalId);
        }
        for (let i = 1; i < match.sides.length; i++) {
          const side = match.sides[i];
          const dropId = dbGetCanonicalId(this.db, side.connectorId, side.externalId);
          if (dropId && dropId !== winnerId) dbMergeCanonicals(this.db, winnerId, dropId);
          else if (!dropId) dbLinkIdentity(this.db, winnerId, side.connectorId, side.externalId);
        }
        for (const side of match.sides) {
          const sideMember = memberByConnector.get(side.connectorId)!;
          const sideEntity = sideMember.entity;
          // Spec: plans/engine/PLAN_PREDICATE_MAPPING.md §2.3 — filter to declared predicates before storing sentinel
          const sideAssocRaw = matchSideAssoc.get(`${side.connectorId}/${side.externalId}`);
          const sideAssocFiltered = this._filterInboundAssociations(sideAssocRaw, sideMember);
          const sideAssocSentinel = sideAssocFiltered.length
            ? JSON.stringify([...sideAssocFiltered].sort((a, b) => a.predicate.localeCompare(b.predicate)))
            : undefined;
          const fd = buildFieldData(undefined, match.canonicalData, side.connectorId, ts, sideAssocSentinel);
          dbSetShadow(this.db, side.connectorId, sideEntity, side.externalId, winnerId!, fd);
          linked++;
          shadowsSeeded++;
        }
        matchCanonicals.set(mi, winnerId!);
      }
    })();

    // batchId covers both matched-record propagation (1b) and unique-per-side (2)
    // so all onboarding inserts share the same audit batch.
    const batchId = crypto.randomUUID();
    const inserts: RecordSyncResult[] = [];

    // 1b. Propagate each matched record to channel members not in match.sides.
    // This handles partial N-way matches (record in A+B but not C).
    // Spec: plans/engine/PLAN_ENGINE_USABILITY.md § 3.2 — call lookup() on the first
    // available source side so associations are included in the fanout insert.
    const matchAssocCache = new Map<string, Association[] | undefined>(); // "connId/extId" → assoc
    for (let mi = 0; mi < report.matched.length; mi++) {
      const match = report.matched[mi]!;
      const canonicalId = matchCanonicals.get(mi)!;
      const matchedConnectors = new Set(match.sides.map((s) => s.connectorId));

      // Resolve associations from the first source side that supports lookup().
      let srcAssoc: Association[] | undefined;
      let srcConnForAssoc: string | undefined;
      for (const side of match.sides) {
        const cacheKey = `${side.connectorId}/${side.externalId}`;
        if (matchAssocCache.has(cacheKey)) {
          srcAssoc = matchAssocCache.get(cacheKey);
          srcConnForAssoc = side.connectorId;
          break;
        }
        const sideWired = this.wired.get(side.connectorId);
        const sideMember = memberByConnector.get(side.connectorId);
        const sideEntityDef = sideWired?.entities.find((e) => e.name === sideMember?.entity);
        if (sideEntityDef?.lookup) {
          const looked = await sideEntityDef.lookup([side.externalId], sideWired!.ctx);
          const rec = looked.find((r) => r.id === side.externalId);
          srcAssoc = rec?.associations;
          srcConnForAssoc = side.connectorId;
          matchAssocCache.set(cacheKey, srcAssoc);
          break;
        }
      }

      for (const targetMember of channel.members) {
        if (matchedConnectors.has(targetMember.connectorId)) continue;
        if (dbGetExternalId(this.db, canonicalId, targetMember.connectorId)) continue;

        const targetWired = this.wired.get(targetMember.connectorId);
        if (!targetWired) continue;
        const targetEntityDef = targetWired.entities.find((e) => e.name === targetMember.entity);
        if (!targetEntityDef?.insert) continue;

        if (breaker.evaluate() === "OPEN") break;

        // Remap associations from source side to target (mirrors step 2 pattern).
        const remappedAssoc = srcConnForAssoc && srcAssoc?.length
          ? this._remapAssociations(srcAssoc, srcConnForAssoc, targetMember.connectorId, channelId)
          : [];
        const assocToInsert = (remappedAssoc !== null && !("error" in remappedAssoc) && remappedAssoc.length > 0)
          ? remappedAssoc
          : undefined;

        const outboundData = applyMapping(match.canonicalData, targetMember.outbound, "outbound");
        let newId: string | undefined;
        let insertError: string | undefined;

        for await (const result of targetEntityDef.insert(
          (async function* (): AsyncIterable<InsertRecord> { yield { data: outboundData, associations: assocToInsert }; })(),
          targetWired.ctx,
        )) {
          if (result.error) { insertError = result.error; }
          else { newId = result.id; }
        }

        if (newId) {
          const remappedSentinel = assocToInsert?.length
            ? JSON.stringify([...assocToInsert].sort((a, b) => a.predicate.localeCompare(b.predicate)))
            : undefined;
          const fd = buildFieldData(undefined, match.canonicalData, targetMember.connectorId, ts, remappedSentinel);
          this.db.transaction(() => {
            dbLinkIdentity(this.db, canonicalId, targetMember.connectorId, newId!);
            dbSetShadow(this.db, targetMember.connectorId, targetMember.entity, newId!, canonicalId, fd);
            dbLogTransaction(this.db, {
              batchId,
              connectorId: targetMember.connectorId,
              entityName: targetMember.entity,
              externalId: newId!,
              canonicalId,
              action: "insert",
              dataBefore: undefined,
              dataAfter: fd,
            });
            // Spec: plans/engine/PLAN_DEFERRED_ASSOCIATIONS.md §2.2 — if remap returned
            // null (identity link missing for the association target), write a deferred row
            // so the retry loop can add the association once the link is established.
            if (remappedAssoc === null && srcConnForAssoc) {
              const srcMem = memberByConnector.get(srcConnForAssoc)!;
              const srcSide = match.sides.find((s) => s.connectorId === srcConnForAssoc)!;
              dbInsertDeferred(this.db, srcConnForAssoc, srcMem.entity, srcSide.externalId, targetMember.connectorId);
            }
          })();
          // Spec: specs/sync-engine.md § OnboardResult
          inserts.push({ entity: targetMember.entity, action: "insert", sourceId: match.sides[0]!.externalId, targetConnectorId: targetMember.connectorId, targetId: newId!, after: match.canonicalData, afterAssociations: assocToInsert?.length ? assocToInsert : undefined });
          uniqueQueued++;
          breaker.recordResult(false);
        } else if (insertError) {
          breaker.recordResult(true);
        }
      }
    }

    // 2. Propagate unique-per-side records
    // Gap 8: use _processRecords for safety pipeline; but first advance shadows
    // NOTE: v9 uses direct insert() here because _processRecords would skip (diff = "skip").
    // The Gap 8 fix routes through a dedicated propagation path that checks the circuit
    // breaker and logs to transaction_log, but does not re-diff (which would skip).

    // Spec: plans/engine/PLAN_DEFERRED_ASSOCIATIONS.md §2.2
    // For each unique source record, look up its full data (incl. associations) once per
    // connector so we can attempt remap and write deferred rows where remap fails.
    const sourceAssocCache = new Map<string, Association[] | undefined>();
    for (const unique of report.uniquePerSide) {
      const sourceWired = this.wired.get(unique.connectorId);
      const sourceEntityDef = sourceWired?.entities.find((e) => e.name === memberByConnector.get(unique.connectorId)!.entity);
      if (sourceEntityDef?.lookup && !sourceAssocCache.has(unique.externalId)) {
        const records = await sourceEntityDef.lookup([unique.externalId], sourceWired!.ctx);
        const rec = records.find((r) => r.id === unique.externalId);
        sourceAssocCache.set(unique.externalId, rec?.associations);
      }
    }

    for (const unique of report.uniquePerSide) {
      const sourceCanonId = dbGetCanonicalId(this.db, unique.connectorId, unique.externalId);
      if (!sourceCanonId) continue;

      for (const targetMember of channel.members.filter((m) => m.connectorId !== unique.connectorId)) {
        if (dbGetExternalId(this.db, sourceCanonId, targetMember.connectorId)) continue;

        const targetWired = this.wired.get(targetMember.connectorId);
        if (!targetWired) continue;
        const targetEntityDef = targetWired.entities.find((e) => e.name === targetMember.entity);
        if (!targetEntityDef?.insert) continue;

        const outboundData = applyMapping(unique.rawData, targetMember.outbound, "outbound");
        let newId: string | undefined;
        let insertError: string | undefined;

        // Gap 8: circuit breaker pre-flight
        if (breaker.evaluate() === "OPEN") break;

        // Attempt to remap associations before inserting so we can include them
        const sourceAssoc = sourceAssocCache.get(unique.externalId);
        const remappedAssoc = sourceAssoc?.length
          ? this._remapAssociations(sourceAssoc, unique.connectorId, targetMember.connectorId, channelId)
          : [];

        const assocToInsert = (remappedAssoc !== null && !("error" in remappedAssoc) && remappedAssoc.length > 0)
          ? remappedAssoc
          : undefined;

        for await (const result of targetEntityDef.insert(
          (async function* (): AsyncIterable<InsertRecord> { yield { data: outboundData, associations: assocToInsert }; })(),
          targetWired.ctx,
        )) {
          if (result.error) { insertError = result.error; }
          else { newId = result.id; }
        }

        if (newId) {
          const remappedSentinel = assocToInsert?.length
            ? JSON.stringify([...assocToInsert].sort((a, b) => a.predicate.localeCompare(b.predicate)))
            : undefined;
          const fd = buildFieldData(undefined, unique.rawData, targetMember.connectorId, ts, remappedSentinel);
          this.db.transaction(() => {
            dbLinkIdentity(this.db, sourceCanonId, targetMember.connectorId, newId!);
            dbSetShadow(this.db, targetMember.connectorId, targetMember.entity, newId!, sourceCanonId, fd);
            // Gap 8: log to transaction_log so onboarding inserts are auditable
            dbLogTransaction(this.db, {
              batchId,
              connectorId: targetMember.connectorId,
              entityName: targetMember.entity,
              externalId: newId!,
              canonicalId: sourceCanonId,
              action: "insert",
              dataBefore: undefined,
              dataAfter: fd,
            });
            // Spec: plans/engine/PLAN_DEFERRED_ASSOCIATIONS.md §2.2
            // If remap returned null (identity link missing), write a deferred row so
            // the retry loop picks it up on the next ingest cycle.
            if (remappedAssoc === null) {
              dbInsertDeferred(this.db, unique.connectorId, memberByConnector.get(unique.connectorId)!.entity, unique.externalId, targetMember.connectorId);
            }
          })();
          // Spec: specs/sync-engine.md § OnboardResult
          inserts.push({ entity: targetMember.entity, action: "insert", sourceId: unique.externalId, targetConnectorId: targetMember.connectorId, targetId: newId!, after: unique.rawData, afterAssociations: assocToInsert?.length ? assocToInsert : undefined });
          uniqueQueued++;
          breaker.recordResult(false);
        } else if (insertError) {
          breaker.recordResult(true);
        }
      }
    }

    // 4. Mark channel ready
    dbSetChannelReady(this.db, channelId, report.entity);

    return { linked, shadowsSeeded, uniqueQueued, inserts };
  }

  // ─── getChannelIdentityMap ────────────────────────────────────────────────

  /**
   * Returns all canonical clusters for a channel as a Map<canonicalId, Map<connectorId, externalId>>.
   * Used by the browser demo to group records by identity.
   */
  getChannelIdentityMap(channelId: string): Map<string, Map<string, string>> {
    const channel = this.channels.get(channelId);
    if (!channel) return new Map();
    // Spec: specs/sync-engine.md — filter by entity so contacts don't leak into companies channel
    const canonicals = dbGetCanonicalsByChannelMembers(this.db, channel.members);
    const connectorIds = channel.members.map((m) => m.connectorId);
    const result = new Map<string, Map<string, string>>();
    for (const cid of canonicals) {
      const row = new Map<string, string>();
      for (const connectorId of connectorIds) {
        const externalId = dbGetExternalId(this.db, cid, connectorId);
        if (externalId !== undefined) row.set(connectorId, externalId);
      }
      result.set(cid, row);
    }
    return result;
  }

  // ─── addConnector ─────────────────────────────────────────────────────────

  // Spec: specs/discovery.md
  async addConnector(
    channelId: string,
    connectorId: string,
    opts?: AddConnectorOptions,
  ): Promise<AddConnectorReport> {
    const dryRun = opts?.dryRun ?? false;
    const missingFromJoiner = opts?.missingFromJoiner ?? "propagate";

    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Unknown channel: ${channelId}`);

    const joinerMember = channel.members.find((m) => m.connectorId === connectorId);
    if (!joinerMember) throw new Error(`"${connectorId}" not declared in channel "${channelId}"`);

    const joinerWired = this.wired.get(connectorId);
    if (!joinerWired) throw new Error(`Unknown connector: ${connectorId}`);

    const joinerEntityDef = joinerWired.entities.find((e) => e.name === joinerMember.entity);
    if (!joinerEntityDef?.insert) throw new Error(`"${connectorId}" must have insert() for "${joinerMember.entity}"`);

    const existingIds = channel.members.filter((m) => m.connectorId !== connectorId).map((m) => m.connectorId);
    const allCanonicalIds = dbGetAllCanonicals(this.db, existingIds);
    const canonicalMap = new Map<string, Record<string, unknown>>();
    for (const cid of allCanonicalIds) canonicalMap.set(cid, dbGetCanonicalFields(this.db, cid));

    const joinerRows = dbGetAllShadowForEntity(this.db, connectorId, joinerMember.entity);
    if (joinerRows.length === 0) throw new Error(`"${connectorId}" has no shadow_state. Run ingest with collectOnly first.`);

    const joinerRecords = joinerRows.map(({ externalId, fieldData }) => ({
      id: externalId,
      canonical: shadowToCanonical(fieldData),
    }));

    const identityFields = channel.identityFields ?? [];
    const normalise = (v: unknown): string => typeof v === "string" ? v.toLowerCase().trim() : String(v ?? "");
    const buildKey = (r: Record<string, unknown>): string | undefined => {
      if (!identityFields.length) return undefined;
      return identityFields.map((f) => normalise(r[f])).join("\x01");
    };

    const canonIdx = new Map<string, string>();
    for (const [cid, fields] of canonicalMap) {
      const k = buildKey(fields); if (k) canonIdx.set(k, cid);
    }

    const linkedEntries: AddConnectorReport["linked"] = [];
    const newFromJoiner: AddConnectorReport["newFromJoiner"] = [];
    const matchedCanonicals = new Set<string>();

    for (const r of joinerRecords) {
      const k = buildKey(r.canonical);
      if (k && canonIdx.has(k)) {
        const cid = canonIdx.get(k)!;
        linkedEntries.push({ canonicalId: cid, externalId: r.id, matchedOn: identityFields });
        matchedCanonicals.add(cid);
      } else {
        newFromJoiner.push({ externalId: r.id, data: r.canonical });
      }
    }

    const missingInJoiner: AddConnectorReport["missingInJoiner"] = [];
    for (const [cid, fields] of canonicalMap) {
      if (!matchedCanonicals.has(cid)) missingInJoiner.push({ canonicalId: cid, data: fields });
    }

    const report: AddConnectorReport = {
      channelId, connectorId, linked: linkedEntries, newFromJoiner, missingInJoiner,
      summary: { totalInJoiner: joinerRecords.length, linked: linkedEntries.length, newFromJoiner: newFromJoiner.length, missingInJoiner: missingInJoiner.length },
    };

    if (dryRun) return report;

    const ts = Date.now();
    const batchId = crypto.randomUUID();

    // 4. Commit links
    this.db.transaction(() => {
      for (const entry of linkedEntries) {
        if (dbGetExternalId(this.db, entry.canonicalId, connectorId)) continue;
        const provisionalId = dbGetCanonicalId(this.db, connectorId, entry.externalId);
        if (provisionalId && provisionalId !== entry.canonicalId) dbMergeCanonicals(this.db, entry.canonicalId, provisionalId);
        else if (!provisionalId) dbLinkIdentity(this.db, entry.canonicalId, connectorId, entry.externalId);
        const jr = joinerRecords.find((r) => r.id === entry.externalId)!;
        dbSetShadow(this.db, connectorId, joinerMember.entity, entry.externalId, entry.canonicalId,
          buildFieldData(undefined, jr.canonical, connectorId, ts, undefined));
      }
    })();

    // 4b. Catch-up: update joiner records that diverged during partial-onboarding
    for (const entry of linkedEntries) {
      const canonical = canonicalMap.get(entry.canonicalId);
      if (!canonical) continue;
      const jr = joinerRecords.find((r) => r.id === entry.externalId)!;
      const changed = Object.keys(canonical).some((k) => String(canonical[k] ?? "") !== String(jr.canonical[k] ?? ""));
      if (!changed) continue;
      const outbound = applyMapping(canonical, joinerMember.outbound, "outbound");
      for await (const r of joinerEntityDef.update!(
        (async function* (): AsyncIterable<UpdateRecord> { yield { id: entry.externalId, data: outbound }; })(),
        joinerWired.ctx,
      )) {
        if (!r.notFound && !r.error) {
          dbSetShadow(this.db, connectorId, joinerMember.entity, entry.externalId, entry.canonicalId,
            buildFieldData(undefined, canonical, connectorId, ts, undefined));
        }
      }
    }

    // 5. Propagate net-new joiner records to existing members
    for (const nfj of newFromJoiner) {
      const nfjCanonId = dbGetCanonicalId(this.db, connectorId, nfj.externalId);
      if (!nfjCanonId) continue;
      for (const targetMember of channel.members.filter((m) => m.connectorId !== connectorId)) {
        if (dbGetExternalId(this.db, nfjCanonId, targetMember.connectorId)) continue;
        const tw = this.wired.get(targetMember.connectorId);
        if (!tw) continue;
        const teDef = tw.entities.find((e) => e.name === targetMember.entity);
        if (!teDef?.insert) continue;
        const outbound = applyMapping(nfj.data, targetMember.outbound, "outbound");
        let newId: string | undefined;
        for await (const r of teDef.insert(
          (async function* (): AsyncIterable<InsertRecord> { yield { data: outbound }; })(),
          tw.ctx,
        )) { if (!r.error) newId = r.id; }
        if (newId) {
          this.db.transaction(() => {
            dbLinkIdentity(this.db, nfjCanonId, targetMember.connectorId, newId!);
            const fd = buildFieldData(undefined, nfj.data, targetMember.connectorId, ts, undefined);
            dbSetShadow(this.db, targetMember.connectorId, targetMember.entity, newId!, nfjCanonId, fd);
            dbLogTransaction(this.db, { batchId, connectorId: targetMember.connectorId, entityName: targetMember.entity, externalId: newId!, canonicalId: nfjCanonId, action: "insert", dataBefore: undefined, dataAfter: fd });
          })();
        }
      }
    }

    // 6. Propagate missing-in-joiner records into the joiner
    if (missingFromJoiner === "propagate") {
      for (const missing of missingInJoiner) {
        if (dbGetExternalId(this.db, missing.canonicalId, connectorId)) continue;
        const outbound = applyMapping(missing.data, joinerMember.outbound, "outbound");
        let newId: string | undefined;
        for await (const r of joinerEntityDef.insert(
          (async function* (): AsyncIterable<InsertRecord> { yield { data: outbound }; })(),
          joinerWired.ctx,
        )) { if (!r.error) newId = r.id; }
        if (newId) {
          this.db.transaction(() => {
            dbLinkIdentity(this.db, missing.canonicalId, connectorId, newId!);
            const fd = buildFieldData(undefined, missing.data, connectorId, ts, undefined);
            dbSetShadow(this.db, connectorId, joinerMember.entity, newId!, missing.canonicalId, fd);
            dbLogTransaction(this.db, { batchId, connectorId, entityName: joinerMember.entity, externalId: newId!, canonicalId: missing.canonicalId, action: "insert", dataBefore: undefined, dataAfter: fd });
          })();
        }
      }
    }

    // 7. Mark ready — watermark for the joiner was already stored by its collectOnly run.
    dbSetChannelReady(this.db, channelId, joinerMember.entity);

    return report;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private _breaker(channelId: string): CircuitBreaker {
    let b = this.breakers.get(channelId);
    if (!b) { b = new CircuitBreaker(channelId, this.db); this.breakers.set(channelId, b); }
    return b;
  }

  private _getOrCreateCanonical(connectorId: string, externalId: string): string {
    const ex = dbGetCanonicalId(this.db, connectorId, externalId);
    if (ex) return ex;
    const id = crypto.randomUUID();
    dbLinkIdentity(this.db, id, connectorId, externalId);
    return id;
  }

  private _resolveCanonical(
    connectorId: string,
    externalId: string,
    canonical: Record<string, unknown>,
    entityName: string,
    identityFields: string[] | undefined,
  ): string {
    if (identityFields?.length) {
      for (const field of identityFields) {
        const value = canonical[field];
        if (value === undefined) continue;
        const matchedId = dbFindCanonicalByField(this.db, entityName, connectorId, field, value);
        if (matchedId) {
          const ownId = dbGetCanonicalId(this.db, connectorId, externalId);
          if (ownId && ownId !== matchedId) dbMergeCanonicals(this.db, matchedId, ownId);
          if (!ownId) {
            const alreadyLinked = dbGetExternalId(this.db, matchedId, connectorId);
            if (!alreadyLinked) dbLinkIdentity(this.db, matchedId, connectorId, externalId);
            else return this._getOrCreateCanonical(connectorId, externalId);
          }
          return matchedId;
        }
      }
    }
    return this._getOrCreateCanonical(connectorId, externalId);
  }

  // Spec: plans/engine/PLAN_PREDICATE_MAPPING.md §2.4
  // Find the first channel that contains both connectors, return their ChannelMember objects.
  private _findMemberPair(fromId: string, toId: string): { fromMember: ChannelMember; toMember: ChannelMember } | undefined {
    for (const ch of this.channels.values()) {
      const fromMember = ch.members.find((m) => m.connectorId === fromId);
      const toMember = ch.members.find((m) => m.connectorId === toId);
      if (fromMember && toMember) return { fromMember, toMember };
    }
    return undefined;
  }

  // Spec: plans/engine/PLAN_PREDICATE_MAPPING.md §2.3
  // Keep only associations whose predicate is declared in member.assocMappings.
  // Absent assocMappings → no associations forwarded (strict by design).
  private _filterInboundAssociations(
    associations: Association[] | undefined,
    member: ChannelMember,
  ): Association[] {
    if (!associations?.length) return [];
    if (!member.assocMappings) return [];
    return associations.filter((a) => member.assocMappings!.some((m) => m.source === a.predicate));
  }

  // Spec: plans/engine/PLAN_DEFERRED_ASSOCIATIONS.md — translate entity name from source
  // connector namespace to target connector namespace when remapping associations.
  // Finds the channel that has fromConnectorId with entity `entityName`, then returns the
  // entity name used by toConnectorId in that same channel. Returns entityName unchanged
  // when no translation is found (safe fallback).
  //
  // Spec: plans/engine/PLAN_PREDICATE_MAPPING.md §2.4 — helpers for predicate mapping.

  /** Find the channel (optionally scoped by channelId) containing both connectors and return their ChannelMember objects. */
  private _findMemberPair(fromId: string, toId: string, channelId?: string): { fromMember: ChannelMember; toMember: ChannelMember } | undefined {
    const search: Iterable<ChannelConfig> = channelId
      ? ([this.channels.get(channelId)].filter(Boolean) as ChannelConfig[])
      : this.channels.values();
    for (const ch of search) {
      const fromMember = ch.members.find((m) => m.connectorId === fromId);
      const toMember = ch.members.find((m) => m.connectorId === toId);
      if (fromMember && toMember) return { fromMember, toMember };
    }
    return undefined;
  }

  /** Spec: plans/engine/PLAN_PREDICATE_MAPPING.md §2.3 — keep only associations whose
   * predicate is declared in member.assocMappings. Absent assocMappings → empty. */
  private _filterInboundAssociations(
    associations: Association[] | undefined,
    member: ChannelMember,
  ): Association[] {
    if (!associations?.length) return [];
    if (!member.assocMappings) return [];
    return associations.filter((a) => member.assocMappings!.some((m) => m.source === a.predicate));
  }
  // Like _remapAssociations but never returns null. Entries whose target is not yet in the
  // identity map are silently dropped rather than blocking the whole record. Returns { error }
  // only for unknown targetEntity — that is always a config mistake, not a timing issue.
  private _remapAssociationsPartial(
    associations: Association[] | undefined,
    fromId: string,
    toId: string,
    channelId?: string,
  ): Association[] | { error: string } {
    if (!associations?.length) return [];
    // Spec: plans/engine/PLAN_PREDICATE_MAPPING.md §2.4 — absent source assocMappings → no associations forwarded
    const pair = this._findMemberPair(fromId, toId, channelId);
    if (pair && !pair.fromMember.assocMappings) return [];
    const deduped = new Map<string, Association>();
    for (const a of associations) deduped.set(a.predicate, a);
    const out: Association[] = [];
    for (const assoc of deduped.values()) {
      let targetPredicate = assoc.predicate;
      if (pair?.fromMember.assocMappings) {
        const canonical = pair.fromMember.assocMappings.find((m) => m.source === assoc.predicate)?.target;
        if (canonical === undefined) continue;
        if (pair.toMember.assocMappings) {
          const local = pair.toMember.assocMappings.find((m) => m.target === canonical)?.source;
          if (local === undefined) continue;
          targetPredicate = local;
        } else {
          continue;
        }
      }
      if (!assoc.targetId) { out.push({ ...assoc, predicate: targetPredicate }); continue; }
      if (!this._entityKnownInShadow(assoc.targetEntity)) return { error: `Unknown targetEntity "${assoc.targetEntity}"` };
      const canonId = dbGetCanonicalId(this.db, fromId, assoc.targetId);
      if (!canonId) continue; // not yet in identity map — drop for now, deferred row handles the update
      const mapped = dbGetExternalId(this.db, canonId, toId);
      if (mapped === undefined) continue; // not yet in target — drop
      const translatedEntity = this._translateTargetEntity(assoc.targetEntity, fromId, toId);
      out.push({ ...assoc, predicate: targetPredicate, targetEntity: translatedEntity, targetId: mapped });
    }
    return out;
  }

  private _translateTargetEntity(entityName: string, fromConnectorId: string, toConnectorId: string): string {
    for (const ch of this.channels.values()) {
      const fromMember = ch.members.find((m) => m.connectorId === fromConnectorId && m.entity === entityName);
      if (!fromMember) continue;
      const toMember = ch.members.find((m) => m.connectorId === toConnectorId);
      if (toMember) return toMember.entity;
    }
    return entityName;
  }

  private _entityKnownInShadow(entityName: string): boolean {
    // Accept entities configured in any channel even if not yet ingested (shadow empty).
    // This prevents _remapAssociations from returning { error } for valid-but-not-yet-synced
    // entities, which would suppress the deferred-association write.
    for (const ch of this.channels.values()) {
      if (ch.members.some((m) => m.entity === entityName)) return true;
    }
    const row = this.db.prepare<{ n: number }>(
      "SELECT COUNT(*) as n FROM shadow_state WHERE entity_name = ?",
    ).get(entityName);
    return (row?.n ?? 0) > 0;
  }

  private _remapAssociations(
    associations: Association[] | undefined,
    fromId: string,
    toId: string,
    channelId?: string,
  ): Association[] | null | { error: string } {
    if (!associations?.length) return [];
    // Spec: plans/engine/PLAN_PREDICATE_MAPPING.md §2.4 — absent source assocMappings → no associations forwarded
    const pair = this._findMemberPair(fromId, toId, channelId);
    if (pair && !pair.fromMember.assocMappings) return [];
    const deduped = new Map<string, Association>();
    for (const a of associations) deduped.set(a.predicate, a);
    const out: Association[] = [];
    for (const assoc of deduped.values()) {
      let targetPredicate = assoc.predicate;
      if (pair?.fromMember.assocMappings) {
        const canonical = pair.fromMember.assocMappings.find((m) => m.source === assoc.predicate)?.target;
        if (canonical === undefined) continue; // not in source allowlist → drop
        if (pair.toMember.assocMappings) {
          const local = pair.toMember.assocMappings.find((m) => m.target === canonical)?.source;
          if (local === undefined) continue; // not mapped on target → drop
          targetPredicate = local;
        } else {
          continue; // target has no assocMappings → drop
        }
      }
      if (!assoc.targetId) { out.push({ ...assoc, predicate: targetPredicate }); continue; }
      if (!this._entityKnownInShadow(assoc.targetEntity)) return { error: `Unknown targetEntity "${assoc.targetEntity}"` };
      const canonId = dbGetCanonicalId(this.db, fromId, assoc.targetId);
      if (!canonId) return null;
      const mapped = dbGetExternalId(this.db, canonId, toId);
      if (mapped === undefined) return null;
      const translatedEntity = this._translateTargetEntity(assoc.targetEntity, fromId, toId);
      out.push({ ...assoc, predicate: targetPredicate, targetEntity: translatedEntity, targetId: mapped });
    }
    return out;
  }

  // Spec: specs/sync-engine.md § Dispatch — core fan-out
  // Gap 6: 412 retry loop
  private async _dispatchToTarget(
    targetMember: ChannelMember,
    targetWired: WiredConnectorInstance,
    resolvedCanonical: Record<string, unknown>,
    associations: Association[] | undefined,
    existingTargetId: string | undefined,
    targetShadow: FieldData | undefined,
    canonId: string,
    ingestTs: number,
    batchId: string,
    sourceMember: ChannelMember,
    sourceId: string,
  ): Promise<
    | { type: "ok"; action: "insert" | "update"; targetId: string; newFieldData: FieldData; after: Record<string, unknown>; afterAssociations?: Association[] }
    | { type: "error"; error: string }
    | { type: "skip" }
  > {
    const targetEntityDef = targetWired.entities.find((e) => e.name === targetMember.entity);
    if (!targetEntityDef?.insert || !targetEntityDef?.update) return { type: "skip" };

    const localData = applyMapping(resolvedCanonical, targetMember.outbound, "outbound");

    // ETag pre-fetch (Spec: specs/sync-engine.md § Dispatch)
    let liveVersion: string | undefined;
    let liveSnapshot: Record<string, unknown> | undefined;
    if (existingTargetId && targetEntityDef.lookup) {
      try {
        const liveRecords = await targetEntityDef.lookup([existingTargetId], targetWired.ctx);
        const live = liveRecords.find((r) => r.id === existingTargetId);
        if (live) { liveVersion = live.version; liveSnapshot = live.data as Record<string, unknown>; }
      } catch { /* non-fatal */ }
    }

    const doWrite = async (retryVersion?: string): Promise<
      | { type: "ok"; action: "insert" | "update"; targetId: string }
      | { type: "conflict" }
      | { type: "error"; error: string }
    > => {
      if (existingTargetId === undefined) {
        let newId: string | undefined;
        let err: string | undefined;
        for await (const result of targetEntityDef.insert!(
          (async function* (): AsyncIterable<InsertRecord> { yield { data: localData, associations }; })(),
          targetWired.ctx,
        )) { if (result.error) err = result.error; else newId = result.id; }
        if (err) return { type: "error", error: err };
        return { type: "ok", action: "insert", targetId: newId! };
      } else {
        let err: string | undefined;
        let notFound = false;
        for await (const result of targetEntityDef.update!(
          (async function* (): AsyncIterable<UpdateRecord> {
            yield { id: existingTargetId!, data: localData, associations, version: retryVersion ?? liveVersion, snapshot: liveSnapshot };
          })(),
          targetWired.ctx,
        )) {
          if (result.error) {
            // Gap 6: detect 412
            if (result.error.includes("412") || result.error.toLowerCase().includes("conflict")) {
              return { type: "conflict" };
            }
            err = result.error;
          }
          if (result.notFound) notFound = true;
        }
        if (notFound) return { type: "ok", action: "update", targetId: existingTargetId! };
        if (err) return { type: "error", error: err };
        return { type: "ok", action: "update", targetId: existingTargetId! };
      }
    };

    let writeResult = await doWrite();

    // Gap 6: 412 retry — re-read, update shadow version, retry once
    if (writeResult.type === "conflict" && existingTargetId && targetEntityDef.lookup) {
      try {
        const fresh = await targetEntityDef.lookup([existingTargetId], targetWired.ctx);
        const freshRecord = fresh.find((r) => r.id === existingTargetId);
        if (freshRecord) {
          liveVersion = freshRecord.version;
          liveSnapshot = freshRecord.data as Record<string, unknown>;
          writeResult = await doWrite(freshRecord.version);
        }
      } catch { /* if re-read fails, fall through to error */ }
      if (writeResult.type === "conflict") {
        return { type: "error", error: `Conflict (412) on ${existingTargetId} — persisted after retry` };
      }
    }

    if (writeResult.type === "error") return writeResult;
    if (writeResult.type !== "ok") {
      return { type: "error", error: "Unexpected state after write" };
    }

    // Spec: plans/engine/PLAN_NOOP_UPDATE_SUPPRESSION.md — store remapped assoc sentinel
    // so _resolvedMatchesTargetShadow can compare it on the next poll.
    const remappedSentinel = associations?.length
      ? JSON.stringify([...associations].sort((a, b) => a.predicate.localeCompare(b.predicate)))
      : undefined;
    const newFieldData = buildFieldData(targetShadow, resolvedCanonical, targetMember.connectorId, ingestTs, remappedSentinel);
    return { type: "ok", action: writeResult.action, targetId: writeResult.targetId, newFieldData,
      after: resolvedCanonical, afterAssociations: associations?.length ? associations : undefined };
  }

  // Spec: specs/sync-engine.md § Pipeline Steps
  private async _processRecords(
    channelId: string,
    sourceMember: ChannelMember,
    records: ReadRecord[],
    batchId: string,
    ingestTs: number,
    // Spec: plans/engine/PLAN_DEFERRED_ASSOCIATIONS.md — bypass echo detection when retrying
    // deferred records whose source shadow was already written on the first (deferred) pass.
    skipEchoFor?: Set<string>,
  ): Promise<RecordSyncResult[]> {
    const channel = this.channels.get(channelId)!;
    const breaker = this._breaker(channelId);

    // Fan-out guard: skip connectors not yet cross-linked (Spec: specs/sync-engine.md § Fan-out guard)
    const crossLinked = new Set(
      this.db.prepare<{ connector_id: string }>(
        `SELECT DISTINCT connector_id FROM identity_map WHERE canonical_id IN (
           SELECT canonical_id FROM identity_map GROUP BY canonical_id HAVING COUNT(DISTINCT connector_id) > 1)`,
      ).all().map((r) => r.connector_id),
    );

    const targets = channel.members.filter(
      (m) => m.connectorId !== sourceMember.connectorId && crossLinked.has(m.connectorId),
    );

    const results: RecordSyncResult[] = [];
    let hadErrors = false;

    for (const record of records) {
      const raw = record.data as Record<string, unknown>;
      const stripped = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("_")));
      const canonical = applyMapping(stripped, sourceMember.inbound, "inbound");

      const assocSentinel = record.associations === undefined
        ? undefined
        // Spec: plans/engine/PLAN_PREDICATE_MAPPING.md §2.3 — shadow stores only declared local predicates
        : (() => {
            const filtered = this._filterInboundAssociations(record.associations, sourceMember);
            return filtered.length
              ? JSON.stringify([...filtered].sort((a, b) => a.predicate.localeCompare(b.predicate)))
              : undefined;
          })();

      const shadowRow = dbGetShadowRow(this.db, sourceMember.connectorId, sourceMember.entity, record.id);
      const existingShadow = shadowRow?.fieldData;
      const isResurrection = shadowRow?.deletedAt != null;

      // Echo detection (Spec: specs/safety.md § Echo Prevention)
      // Bypassed for records being retried from deferred_associations: their source shadow
      // was already written on the first (deferred) pass, so the shadow matches even though
      // no target ever received the data.
      if (!isResurrection && existingShadow !== undefined && !skipEchoFor?.has(record.id)) {
        const same = this._shadowMatchesIncoming(existingShadow, canonical, assocSentinel);
        if (same) {
          results.push({ entity: sourceMember.entity, action: "skip", sourceId: record.id, targetConnectorId: "", targetId: record.id });
          continue;
        }
      }

      // Spec: specs/sync-engine.md § RecordSyncResult — one READ result per non-skip source
      // record, carrying the source data and the engine's prior shadow for diff display.
      results.push({
        entity: sourceMember.entity,
        action: "read",
        sourceId: record.id,
        targetConnectorId: "",
        targetId: record.id,
        sourceData: canonical,
        sourceShadow: existingShadow ? fieldDataToRecord(existingShadow) : undefined,
        sourceAssociations: record.associations?.length ? record.associations : undefined,
        sourceShadowAssociations: existingShadow ? parseSentinelAssociations(existingShadow) : undefined,
      });

      const canonId = this._resolveCanonical(sourceMember.connectorId, record.id, canonical, sourceMember.entity, channel.identityFields);

      type Outcome = { result: RecordSyncResult; shadowData: { connectorId: string; entity: string; externalId: string; canonId: string; fd: FieldData; action: "insert" | "update" }; txEntry: Parameters<typeof dbLogTransaction>[1] };
      const outcomes: Outcome[] = [];
      let droppedAssociation = false; // Spec: PLAN_EAGER_ASSOCIATION_MODE.md §3.4
      const deferredTargets = new Set<string>(); // targets where a deferred row was just written

      for (const targetMember of targets) {
        const tw = this.wired.get(targetMember.connectorId);
        if (!tw) continue;

        let remap = this._remapAssociations(record.associations, sourceMember.connectorId, targetMember.connectorId, channelId);
        if (remap !== null && "error" in remap) {
          results.push({ entity: sourceMember.entity, action: "error", sourceId: record.id, targetConnectorId: targetMember.connectorId, targetId: "", error: remap.error });
          hadErrors = true;
          continue;
        }
        if (remap === null) {
          // Spec: plans/engine/PLAN_EAGER_ASSOCIATION_MODE.md §3.3
          // Write deferred row so the retry loop can issue an update once the link exists.
          dbInsertDeferred(this.db, sourceMember.connectorId, sourceMember.entity, record.id, targetMember.connectorId);
          droppedAssociation = true;
          deferredTargets.add(targetMember.connectorId);
          // Fall through with partial remap — dispatch the record without the unresolvable
          // association. The deferred retry will add it once the identity link is established.
          const partial = this._remapAssociationsPartial(record.associations, sourceMember.connectorId, targetMember.connectorId, channelId);
          if ("error" in partial) {
            results.push({ entity: sourceMember.entity, action: "error", sourceId: record.id, targetConnectorId: targetMember.connectorId, targetId: "", error: partial.error });
            hadErrors = true;
            continue;
          }
          remap = partial;
        }

        const existingTargetId = dbGetExternalId(this.db, canonId, targetMember.connectorId);
        const targetShadow = existingTargetId ? dbGetShadow(this.db, targetMember.connectorId, targetMember.entity, existingTargetId) : undefined;

        const resolved = resolveConflicts(canonical, targetShadow, sourceMember.connectorId, ingestTs, this.conflictConfig);
        // Zero-key guard: suppress dispatch only when updating an *existing* target record
        // with no field changes.  When existingTargetId is undefined this is a brand-new
        // INSERT — dispatch must run even for empty canonical data so the record is created
        // and linked in identity_map.  (T46 regression)
        if (!Object.keys(resolved).length && existingTargetId !== undefined) {
          results.push({ entity: sourceMember.entity, action: "skip", sourceId: record.id, targetConnectorId: targetMember.connectorId, targetId: existingTargetId });
          continue;
        }

        // Spec: plans/engine/PLAN_NOOP_UPDATE_SUPPRESSION.md
        // Suppress dispatch when resolved values already match the target shadow.
        // Echo detection handles the source side; this guard handles the target side
        // for cases where the source shadow is absent (resurrection / cleared shadow).
        const remappedForCheck = remap.length ? remap : undefined;
        if (
          targetShadow !== undefined &&
          this._resolvedMatchesTargetShadow(resolved, targetShadow, remappedForCheck)
        ) {
          results.push({ entity: sourceMember.entity, action: "skip", sourceId: record.id, targetConnectorId: targetMember.connectorId, targetId: existingTargetId ?? "" });
          continue;
        }

        const dispatchResult = await this._dispatchToTarget(
          targetMember, tw, resolved, remap.length ? remap : undefined,
          existingTargetId, targetShadow, canonId, ingestTs, batchId, sourceMember, record.id,
        );

        if (dispatchResult.type === "error") {
          results.push({ entity: sourceMember.entity, action: "error", sourceId: record.id, targetConnectorId: targetMember.connectorId, targetId: existingTargetId ?? "", error: dispatchResult.error });
          hadErrors = true;
          continue;
        }
        if (dispatchResult.type === "skip") continue;

        // Spec: specs/sync-engine.md § RecordSyncResult — capture before/after payloads.
        const beforeData = targetShadow ? fieldDataToRecord(targetShadow) : undefined;
        const beforeAssoc = targetShadow ? parseSentinelAssociations(targetShadow) : undefined;
        outcomes.push({
          result: { entity: sourceMember.entity, action: dispatchResult.action, sourceId: record.id, targetConnectorId: targetMember.connectorId, targetId: dispatchResult.targetId, before: beforeData, beforeAssociations: beforeAssoc, after: dispatchResult.after, afterAssociations: dispatchResult.afterAssociations },
          shadowData: { connectorId: targetMember.connectorId, entity: targetMember.entity, externalId: dispatchResult.targetId, canonId, fd: dispatchResult.newFieldData, action: dispatchResult.action },
          txEntry: { batchId, connectorId: targetMember.connectorId, entityName: targetMember.entity, externalId: dispatchResult.targetId, canonicalId: canonId, action: dispatchResult.action, dataBefore: targetShadow, dataAfter: dispatchResult.newFieldData },
        });
      }

      // Atomic commit: source shadow + all target shadows + identity links + tx_log
      // + clear any deferred rows that were resolved in this pass.
      // Spec: PLAN_EAGER_ASSOCIATION_MODE.md §3.4 — when associations were partially dropped,
      // write source shadow WITHOUT the assoc sentinel so echo detection doesn't suppress the
      // deferred-retry update (which needs to see the association as "new" from the shadow's
      // perspective).
      const srcAssocSentinel = droppedAssociation ? undefined : assocSentinel;
      this.db.transaction(() => {
        const srcFd = buildFieldData(existingShadow, canonical, sourceMember.connectorId, ingestTs, srcAssocSentinel);
        dbSetShadow(this.db, sourceMember.connectorId, sourceMember.entity, record.id, canonId, srcFd);
        for (const o of outcomes) {
          if (o.shadowData.action === "insert") dbLinkIdentity(this.db, o.shadowData.canonId, o.shadowData.connectorId, o.shadowData.externalId);
          dbSetShadow(this.db, o.shadowData.connectorId, o.shadowData.entity, o.shadowData.externalId, o.shadowData.canonId, o.shadowData.fd);
          dbLogTransaction(this.db, o.txEntry);
          // Spec: plans/engine/PLAN_DEFERRED_ASSOCIATIONS.md §2.4
          // Only clear a deferred row if no new one was just written for this (record, target)
          // pair in this pass (eager dispatch writes deferred row and should not clear it).
          if (!deferredTargets.has(o.shadowData.connectorId)) {
            dbRemoveDeferred(this.db, sourceMember.connectorId, sourceMember.entity, record.id, o.shadowData.connectorId);
          }
        }
      })();

      for (const o of outcomes) results.push(o.result);
    }

    breaker.recordResult(hadErrors);
    return results;
  }

  // Spec: plans/engine/PLAN_NOOP_UPDATE_SUPPRESSION.md
  private _resolvedMatchesTargetShadow(
    resolved: Record<string, unknown>,
    targetShadow: FieldData,
    remappedAssoc: Association[] | undefined,
  ): boolean {
    for (const [k, v] of Object.entries(resolved)) {
      const e = targetShadow[k];
      if (!e) return false;
      if (JSON.stringify(e.val) !== JSON.stringify(v)) return false;
    }
    if (remappedAssoc !== undefined) {
      const newSentinel = JSON.stringify(
        [...remappedAssoc].sort((a, b) => a.predicate.localeCompare(b.predicate)),
      );
      const existingSentinel = targetShadow["__assoc__"]?.val;
      if (newSentinel !== existingSentinel) return false;
    } else {
      // No associations on incoming → target shadow must also have none
      if (targetShadow["__assoc__"] !== undefined) return false;
    }
    return true;
  }

  private _shadowMatchesIncoming(
    shadow: FieldData,
    incoming: Record<string, unknown>,
    assocSentinel: string | undefined,
  ): boolean {
    for (const [k, v] of Object.entries(incoming)) {
      const e = shadow[k]; if (!e) return false;
      if (JSON.stringify(e.val) !== JSON.stringify(v)) return false;
    }
    for (const k of Object.keys(shadow)) {
      if (k === "__assoc__") continue;
      if (!Object.prototype.hasOwnProperty.call(incoming, k)) return false;
    }
    const existingAssoc = shadow["__assoc__"]?.val;
    if (assocSentinel !== undefined) { if (existingAssoc !== assocSentinel) return false; }
    else { if (existingAssoc !== undefined) return false; }
    return true;
  }
}
