import type {
  Association,
  ConnectorContext,
  EntityDefinition,
  InsertRecord,
  UpdateRecord,
} from "../../packages/sdk/src/index.js";
import type { Db, FieldData } from "./db.js";
import {
  dbGetCanonicalId,
  dbGetExternalId,
  dbGetShadow,
  dbGetShadowRow,
  dbGetWatermark,
  dbLinkIdentity,
  dbLogSyncRun,
  dbLogTransaction,
  dbSetShadow,
  dbSetWatermark,
  buildFieldData,
  shadowToCanonical,
  dbFindCanonicalByField,
  dbMergeCanonicals,
} from "./db.js";
import type { ConflictConfig } from "./conflict.js";
import { resolveConflicts } from "./conflict.js";
import type { FieldDiff } from "./events.js";
import { EventBus } from "./events.js";
import { CircuitBreaker } from "./circuit-breaker.js";

// ─── Config Types ─────────────────────────────────────────────────────────────

/**
 * Describes how a single field moves between connector-local schema and canonical.
 *
 * - `source`    — connector-local field name (omit for constant injections)
 * - `target`    — canonical field name
 * - `direction` — controls which passes this mapping participates in:
 *     bidirectional  (default) — applies on both inbound AND outbound
 *     forward_only  — applied when writing TO this connector (outbound); ignored when reading back (inbound)
 *     reverse_only  — applied when reading FROM this connector (inbound); not written when dispatching TO it
 * - `expression` — constant/transform expression; preserved in config, NOT evaluated in v4
 */
export interface FieldMapping {
  source?: string;
  target: string;
  direction?: "bidirectional" | "forward_only" | "reverse_only";
  expression?: string;
}

export type FieldMappingList = FieldMapping[];

/** @deprecated Use FieldMappingList. Kept for migration reference only. */
export type RenameMap = Record<string, string>;

export interface ChannelMember {
  connectorId: string;
  entity: string;
  inbound?: FieldMappingList;
  outbound?: FieldMappingList;
}

export interface ChannelConfig {
  id: string;
  members: ChannelMember[];
  /**
   * Canonical field names used for entity matching across connectors.
   * When set, `ingest()` queries shadow_state for any existing row in another
   * connector whose identity field values match before allocating a new canonical UUID.
   */
  identityFields?: string[];
}

export interface ConnectorInstance {
  id: string;
  ctx: ConnectorContext;
  entities: EntityDefinition[];
}

export interface EngineConfig {
  connectors: ConnectorInstance[];
  channels: ChannelConfig[];
  /** Optional event bus; if omitted a local no-subscriber instance is used. */
  eventBus?: EventBus;
  /** Default conflict resolution config applied to all channels. Per-channel override TBD. */
  conflict?: ConflictConfig;
  /** Optional circuit breaker; if omitted a default instance is used. */
  circuitBreaker?: CircuitBreaker;
}

// ─── Public Types ─────────────────────────────────────────────────────────────

export type SyncAction = "insert" | "update" | "skip" | "defer" | "error";

export interface RecordSyncResult {
  entity: string;
  action: SyncAction;
  sourceId: string;
  /** targetConnectorId for insert/update; empty string for skip/defer/error */
  targetConnectorId: string;
  targetId: string;
  error?: string;
}

export interface IngestResult {
  channelId: string;
  connectorId: string;
  records: RecordSyncResult[];
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Apply a FieldMappingList to a data record.
 *
 * pass = "inbound"  (reading from connector → canonical):
 *   For each mapping, read `source` from data and write to `target`.
 *   Skip `forward_only` mappings (injected constants must not flow back as canonical).
 *
 * pass = "outbound" (writing from canonical → connector-local):
 *   For each mapping, read `target` from data (canonical) and write to `source`.
 *   Skip `reverse_only` mappings (reverse-only fields don't get dispatched forward).
 *   Skip constants (no `source`) — expression injection is deferred.
 *
 * When mappings is empty/undefined the entire data object is passed through unchanged
 * (whitelist only applies when at least one mapping is declared).
 */
export function applyRename(
  data: Record<string, unknown>,
  mappings: FieldMappingList | undefined,
  pass: "inbound" | "outbound" = "inbound",
): Record<string, unknown> {
  if (!mappings || mappings.length === 0) return { ...data };
  const result: Record<string, unknown> = {};
  for (const m of mappings) {
    const dir = m.direction ?? "bidirectional";
    if (pass === "inbound") {
      if (dir === "forward_only") continue; // injected going forward; ignore on read-back
      if (!m.source) continue;              // constant with no source field to read
      if (Object.prototype.hasOwnProperty.call(data, m.source)) {
        result[m.target] = data[m.source];
      }
    } else {
      if (dir === "reverse_only") continue; // flows the other direction; skip on outbound
      if (!m.source) continue;              // constant — expression deferred, nothing to write
      if (Object.prototype.hasOwnProperty.call(data, m.target)) {
        result[m.source] = data[m.target];
      }
    }
  }
  return result;
}

export function canonicalEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const stable = (o: Record<string, unknown>) =>
    JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
  return stable(a) === stable(b);
}

/**
 * Compare incoming canonical data + associations against an existing FieldData shadow.
 * Returns true if nothing changed (all field values match and associations match).
 * This replaces the old buildFingerprint approach — FieldData carries `.val` per field.
 */
export function shadowMatchesIncoming(
  existing: FieldData,
  incoming: Record<string, unknown>,
  assocSentinel: string | undefined,
): boolean {
  // Check every incoming field against existing shadow
  for (const [k, v] of Object.entries(incoming)) {
    const entry = existing[k];
    if (!entry) return false;
    if (JSON.stringify(entry.val) !== JSON.stringify(v)) return false;
  }
  // Check fields in shadow that are not in incoming (would represent a deletion — counts as change)
  for (const k of Object.keys(existing)) {
    if (k === "__assoc__") continue;
    if (!Object.prototype.hasOwnProperty.call(incoming, k)) return false;
  }
  // Check associations via sentinel
  const existingAssoc = existing["__assoc__"]?.val;
  if (assocSentinel !== undefined) {
    if (existingAssoc !== assocSentinel) return false;
  } else {
    // No associations on incoming — if shadow has __assoc__ it's a change
    if (existingAssoc !== undefined) return false;
  }
  return true;
}

/**
 * Build FieldDiff[] by comparing incoming canonical values against a FieldData shadow.
 * Only fields that actually changed are included.
 */
export function computeFieldDiffs(
  incoming: Record<string, unknown>,
  existingShadow: FieldData | undefined,
  newSrc: string,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const [field, newValue] of Object.entries(incoming)) {
    const existing = existingShadow?.[field];
    const oldValue = existing?.val ?? null;
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      diffs.push({
        field,
        oldValue,
        newValue,
        prevSrc: existing?.src ?? null,
        newSrc,
      });
    }
  }
  return diffs;
}

// ─── SyncEngine ───────────────────────────────────────────────────────────────

/**
 * Bidirectional sync engine — v4.
 *
 * Architectural shift from v3: hub-and-spoke ingest model.
 *
 * v3: sync(channelId, from, to) — each source read once per target (N×(N-1) reads/cycle)
 * v4: ingest(channelId, connectorId) — each source read once, Δ fanned out to all targets
 *
 * State is persisted in SQLite via the Db handle rather than an in-memory JSON blob.
 * Shadow state replaces lastWritten: the local copy of every record as seen from each
 * source is the single store for both echo detection and the queryable data layer.
 *
 * Other changes from v3:
 * - batch_id groups all writes in one ingest() call for transaction log correlation
 * - ctx.state is backed by the connector_state table
 * - Per-record error recovery: connector throws are caught, logged, cycle continues
 */
export class SyncEngine {
  private readonly connectors: Map<string, ConnectorInstance>;
  private readonly channels: Map<string, ChannelConfig>;
  private readonly db: Db;
  private readonly eventBus: EventBus;
  private readonly conflictConfig: ConflictConfig;
  private readonly breaker: CircuitBreaker;

  constructor(config: EngineConfig, db: Db) {
    this.connectors = new Map(config.connectors.map((c) => [c.id, c]));
    this.channels = new Map(config.channels.map((ch) => [ch.id, ch]));
    this.db = db;
    this.eventBus = config.eventBus ?? new EventBus();
    this.conflictConfig = config.conflict ?? { strategy: "lww" };
    this.breaker = config.circuitBreaker ?? new CircuitBreaker();
  }

  // ─── Public helpers ─────────────────────────────────────────────────────

  lookupTargetId(
    entityName: string,
    sourceConnectorId: string,
    sourceRecordId: string,
    targetConnectorId: string,
  ): string | undefined {
    const canonId = dbGetCanonicalId(this.db, sourceConnectorId, sourceRecordId);
    if (!canonId) return undefined;
    return dbGetExternalId(this.db, canonId, targetConnectorId);
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private _getOrCreateCanonical(
    connectorId: string,
    externalId: string,
  ): string {
    const existing = dbGetCanonicalId(this.db, connectorId, externalId);
    if (existing) return existing;
    const canonId = crypto.randomUUID();
    dbLinkIdentity(this.db, canonId, connectorId, externalId);
    return canonId;
  }

  /**
   * Resolve the canonical UUID for a record, using identity field matching when configured.
   *
   * If `identityFields` is set on the channel, each field value in `canonical` is queried
   * against shadow_state for other connectors. The first match wins (no new UUID allocated).
   * If this connector already has a *different* canonical UUID for this externalId, the two
   * are merged (all identity_map + shadow_state rows for the dropped UUID are repointed).
   */
  private _resolveCanonical(
    connectorId: string,
    externalId: string,
    canonical: Record<string, unknown>,
    entityName: string,
    identityFields: string[] | undefined,
  ): string {
    if (identityFields && identityFields.length > 0) {
      for (const field of identityFields) {
        const value = canonical[field];
        if (value === undefined) continue;
        const matchedId = dbFindCanonicalByField(this.db, entityName, connectorId, field, value);
        if (matchedId) {
          const ownId = dbGetCanonicalId(this.db, connectorId, externalId);
          if (ownId && ownId !== matchedId) {
            // Two canonical UUIDs discovered to be the same entity — merge them
            dbMergeCanonicals(this.db, matchedId, ownId);
          }
          if (!ownId) {
            dbLinkIdentity(this.db, matchedId, connectorId, externalId);
          }
          return matchedId;
        }
      }
    }
    return this._getOrCreateCanonical(connectorId, externalId);
  }

  private _entityKnown(entityName: string): boolean {
    // An entity namespace is "known" if there is at least one shadow_state row for it
    // (i.e. at least one record from any connector has been seen under this entity name).
    const row = this.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) as n FROM shadow_state WHERE entity_name = ?",
      )
      .get(entityName);
    return (row?.n ?? 0) > 0;
  }

  private _remapAssociations(
    associations: Association[] | undefined,
    fromConnectorId: string,
    toConnectorId: string,
  ): Association[] | null | { error: string } {
    if (!associations || associations.length === 0) return [];

    const deduped = new Map<string, Association>();
    for (const assoc of associations) deduped.set(assoc.predicate, assoc);

    const remapped: Association[] = [];
    for (const assoc of deduped.values()) {
      if (!assoc.targetId) {
        remapped.push({ ...assoc });
        continue;
      }
      if (!this._entityKnown(assoc.targetEntity)) {
        return { error: `Unknown targetEntity "${assoc.targetEntity}" in predicate "${assoc.predicate}"` };
      }
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

  // ─── Core: ingest one source, fan out to all other members ──────────────

  /**
   * Read connector `connectorId` for channel `channelId`, diff against shadow state,
   * and propagate all changes to every other channel member.
   *
   * Pipeline stages per record:
   *   read → diff (shadowMatchesIncoming) → resolveConflicts → dispatchWrite
   *   → emit event → update shadow
   *
   * Writes are wrapped in a single db.transaction() per record so that source
   * shadow, target shadow, transaction log, and watermark advance are atomic.
   *
   * Wrapped in CircuitBreaker pre/post-flight. If the breaker is OPEN,
   * returns immediately with an empty result.
   */
  async ingest(
    channelId: string,
    connectorId: string,
    opts: { batchId: string; fullSync?: boolean },
  ): Promise<IngestResult> {
    const startedAt = new Date().toISOString();
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Unknown channel: ${channelId}`);

    const sourceMember = channel.members.find((m) => m.connectorId === connectorId);
    if (!sourceMember) throw new Error(`${connectorId} is not a member of channel ${channelId}`);

    const source = this.connectors.get(connectorId);
    if (!source) throw new Error(`Unknown connector: ${connectorId}`);

    const sourceEntity = source.entities.find((e) => e.name === sourceMember.entity);
    if (!sourceEntity?.read) {
      return { channelId, connectorId, records: [] };
    }

    // ── Circuit breaker pre-flight ─────────────────────────────────────────

    const breakerState = this.breaker.evaluate();
    if (breakerState === "OPEN") {
      return { channelId, connectorId, records: [] };
    }

    const targets = channel.members.filter((m) => m.connectorId !== connectorId);
    const results: RecordSyncResult[] = [];
    const ingestTs = Date.now();

    // ── 1. Read source, diff against field-level shadow state ──────────────

    const since = opts.fullSync
      ? undefined
      : dbGetWatermark(this.db, connectorId, sourceMember.entity);

    const pending: Array<{
      sourceId: string;
      canonical: Record<string, unknown>;
      associations: Association[] | undefined;
      assocSentinel: string | undefined;
    }> = [];

    let newWatermark: string | undefined;

    for await (const batch of sourceEntity.read(source.ctx, since)) {
      for (const record of batch.records) {
        const rawData = record.data as Record<string, unknown>;
        const strippedData = Object.fromEntries(
          Object.entries(rawData).filter(([k]) => !k.startsWith("_")),
        );
        const canonical = applyRename(strippedData, sourceMember.inbound, "inbound");

        const assocSentinel = record.associations === undefined
          ? undefined
          : JSON.stringify([...record.associations].sort((a, b) => a.predicate.localeCompare(b.predicate)));

        const existingShadowRow = dbGetShadowRow(this.db, connectorId, sourceMember.entity, record.id);
        const existingShadow = existingShadowRow?.fieldData;

        // Resurrection check: if the row existed but was soft-deleted, treat as update.
        const isResurrection = existingShadowRow?.deletedAt != null;

        if (!isResurrection && existingShadow !== undefined && shadowMatchesIncoming(existingShadow, canonical, assocSentinel)) {
          results.push({
            entity: sourceMember.entity,
            action: "skip",
            sourceId: record.id,
            targetConnectorId: "",
            targetId: record.id,
          });
          continue;
        }

        pending.push({ sourceId: record.id, canonical, associations: record.associations, assocSentinel });
      }
      if (batch.since) newWatermark = batch.since;
    }

    // ── 2. Fan out each changed record to all targets ──────────────────────

    let batchHadErrors = false;

    for (const record of pending) {
      const canonId = this._resolveCanonical(
        connectorId, record.sourceId, record.canonical,
        sourceMember.entity, channel.identityFields,
      );

      const existingSourceShadow = dbGetShadow(this.db, connectorId, sourceMember.entity, record.sourceId);

      // Collect all dispatch results so we can write them inside the transaction.
      const dispatchOutcomes: Array<{
        result: RecordSyncResult;
        shadowConnectorId: string;
        shadowEntityName: string;
        shadowExternalId: string;
        shadowCanonId: string;
        shadowFieldData: FieldData;
        txEntry: Parameters<typeof dbLogTransaction>[1];
        event: Parameters<typeof this.eventBus.emit>[0] | null;
      }> = [];

      for (const targetMember of targets) {
        const target = this.connectors.get(targetMember.connectorId);
        if (!target) continue;
        const targetEntity = target.entities.find((e) => e.name === targetMember.entity);
        if (!targetEntity?.insert || !targetEntity?.update) continue;

        const remapResult = this._remapAssociations(
          record.associations,
          connectorId,
          targetMember.connectorId,
        );

        if (remapResult !== null && "error" in remapResult) {
          results.push({
            entity: sourceMember.entity,
            action: "error",
            sourceId: record.sourceId,
            targetConnectorId: targetMember.connectorId,
            targetId: "",
            error: remapResult.error,
          });
          batchHadErrors = true;
          continue;
        }

        if (remapResult === null) {
          results.push({
            entity: sourceMember.entity,
            action: "defer",
            sourceId: record.sourceId,
            targetConnectorId: targetMember.connectorId,
            targetId: "",
          });
          continue;
        }

        const associationsPayload: Association[] | undefined =
          record.associations === undefined ? undefined : remapResult;

        const existingTargetId = dbGetExternalId(this.db, canonId, targetMember.connectorId);
        const targetShadow = existingTargetId !== undefined
          ? dbGetShadow(this.db, targetMember.connectorId, targetMember.entity, existingTargetId)
          : undefined;

        const resolvedCanonical = resolveConflicts(
          record.canonical,
          targetShadow,
          connectorId,
          ingestTs,
          this.conflictConfig,
        );

        if (Object.keys(resolvedCanonical).length === 0) {
          results.push({
            entity: sourceMember.entity,
            action: "skip",
            sourceId: record.sourceId,
            targetConnectorId: targetMember.connectorId,
            targetId: existingTargetId ?? "",
          });
          continue;
        }

        const localData = applyRename(resolvedCanonical, targetMember.outbound, "outbound");
        const shadowSeedCanonical = applyRename(localData, targetMember.inbound, "inbound");

        // ── dispatchWrite: call the connector, collect outcome ────────────
        const dispatchResult = await dispatchWrite({
          db: this.db,
          batchId: opts.batchId,
          channelId,
          sourceMember,
          targetMember,
          target,
          targetEntity,
          existingTargetId,
          localData,
          associationsPayload,
          resolvedCanonical,
          shadowSeedCanonical,
          targetShadow,
          canonId,
          connectorId,
          ingestTs,
        });

        if (dispatchResult.type === "error") {
          batchHadErrors = true;
          results.push({
            entity: sourceMember.entity,
            action: "error",
            sourceId: record.sourceId,
            targetConnectorId: targetMember.connectorId,
            targetId: existingTargetId ?? "",
            error: dispatchResult.error,
          });
          continue;
        }

        dispatchOutcomes.push({
          result: {
            entity: sourceMember.entity,
            action: dispatchResult.action,
            sourceId: record.sourceId,
            targetConnectorId: targetMember.connectorId,
            targetId: dispatchResult.targetId,
          },
          shadowConnectorId: targetMember.connectorId,
          shadowEntityName: targetMember.entity,
          shadowExternalId: dispatchResult.targetId,
          shadowCanonId: canonId,
          shadowFieldData: dispatchResult.newTargetFieldData,
          txEntry: dispatchResult.txEntry,
          event: dispatchResult.event,
        });
      }

      // ── Atomic commit: source shadow + all target shadows + tx-log entries ──
      //
      // The watermark advance for this record's source is included here.
      // If any DB write throws, the entire block rolls back — no record is
      // partially committed and the watermark does not advance past uncommitted data.
      this.db.transaction(() => {
        // Source shadow
        const sourceFieldData = buildFieldData(existingSourceShadow, record.canonical, connectorId, ingestTs, record.assocSentinel);
        dbSetShadow(this.db, connectorId, sourceMember.entity, record.sourceId, canonId, sourceFieldData);

        // All target outcomes collected above
        for (const outcome of dispatchOutcomes) {
          // Insert needs identity_map link (safe to call inside txn)
          if (outcome.result.action === "insert") {
            dbLinkIdentity(this.db, outcome.shadowCanonId, outcome.shadowConnectorId, outcome.shadowExternalId);
          }
          dbSetShadow(
            this.db,
            outcome.shadowConnectorId,
            outcome.shadowEntityName,
            outcome.shadowExternalId,
            outcome.shadowCanonId,
            outcome.shadowFieldData,
          );
          dbLogTransaction(this.db, outcome.txEntry);
        }
      })();

      // Push results and fire events outside the transaction (events are async/side-effectful)
      for (const outcome of dispatchOutcomes) {
        results.push(outcome.result);
        if (outcome.event) await this.eventBus.emit(outcome.event);
      }
    }

    // ── Circuit breaker post-flight ────────────────────────────────────────
    this.breaker.recordResult(batchHadErrors);

    // ── 3. Advance watermark ───────────────────────────────────────────────
    // Watermark is advanced after all records in this read batch have been
    // committed. It is written outside the per-record transaction so that a
    // crash mid-batch re-processes all pending records rather than skipping them.

    if (newWatermark && !opts.fullSync) {
      dbSetWatermark(this.db, connectorId, sourceMember.entity, newWatermark);
    }

    // ── 4. Log sync run ────────────────────────────────────────────────────

    const counts = { inserted: 0, updated: 0, skipped: 0, deferred: 0, errors: 0 };
    for (const r of results) {
      if (r.action === "insert") counts.inserted++;
      else if (r.action === "update") counts.updated++;
      else if (r.action === "skip") counts.skipped++;
      else if (r.action === "defer") counts.deferred++;
      else if (r.action === "error") counts.errors++;
    }

    dbLogSyncRun(this.db, {
      batchId: opts.batchId,
      channelId,
      connectorId,
      ...counts,
      startedAt,
      finishedAt: new Date().toISOString(),
    });

    return { channelId, connectorId, records: results };
  }
}

// ─── dispatchWrite ────────────────────────────────────────────────────────────
//
// Named seam for the connector write call. Extracted from ingest() so that
// pre-flight read guards (write-anomaly protection) and per-record write
// ordering can be inserted here without touching the ingest loop.
//
// Returns a discriminated union:
//   { type: "ok"; action; targetId; newTargetFieldData; txEntry; event }
//   { type: "error"; error }
//
// Shadow state and transaction log are NOT written here — that happens inside
// the db.transaction() block in ingest() so they are atomic with the source shadow.

type DispatchWriteOk = {
  type: "ok";
  action: "insert" | "update";
  targetId: string;
  newTargetFieldData: FieldData;
  txEntry: Parameters<typeof dbLogTransaction>[1];
  event: Parameters<EventBus["emit"]>[0];
};

type DispatchWriteError = {
  type: "error";
  error: string;
};

async function dispatchWrite(p: {
  db: Db;
  batchId: string;
  channelId: string;
  sourceMember: ChannelMember;
  targetMember: ChannelMember;
  target: ConnectorInstance;
  targetEntity: EntityDefinition;
  existingTargetId: string | undefined;
  localData: Record<string, unknown>;
  associationsPayload: Association[] | undefined;
  resolvedCanonical: Record<string, unknown>;
  shadowSeedCanonical: Record<string, unknown>;
  targetShadow: FieldData | undefined;
  canonId: string;
  connectorId: string;
  ingestTs: number;
}): Promise<DispatchWriteOk | DispatchWriteError> {
  const targetAssocSentinel = p.associationsPayload === undefined
    ? undefined
    : JSON.stringify([...p.associationsPayload].sort((a, b) => a.predicate.localeCompare(b.predicate)));

  if (p.existingTargetId !== undefined) {
    // ── Update ──────────────────────────────────────────────────────────────
    try {
      for await (const r of p.targetEntity.update!(
        oneRecord<UpdateRecord>({ id: p.existingTargetId, data: p.localData, associations: p.associationsPayload }),
        p.target.ctx,
      )) {
        if (!r.notFound && !r.error) {
          const diffs = computeFieldDiffs(p.resolvedCanonical, p.targetShadow, p.connectorId);
          const newTargetFieldData = buildFieldData(p.targetShadow, p.shadowSeedCanonical, p.connectorId, p.ingestTs, targetAssocSentinel);
          return {
            type: "ok",
            action: "update",
            targetId: p.existingTargetId,
            newTargetFieldData,
            txEntry: {
              batchId: p.batchId,
              connectorId: p.targetMember.connectorId,
              entityName: p.targetMember.entity,
              externalId: p.existingTargetId,
              canonicalId: p.canonId,
              action: "update",
              dataBefore: p.targetShadow,
              dataAfter: newTargetFieldData,
            },
            event: {
              type: "record.updated",
              channelId: p.channelId,
              entityName: p.sourceMember.entity,
              canonicalId: p.canonId,
              sourceConnectorId: p.connectorId,
              targetConnectorId: p.targetMember.connectorId,
              batchId: p.batchId,
              data: p.resolvedCanonical,
              changes: diffs,
            },
          };
        }
      }
      // notFound or connector returned no result — treat as no-op
      return { type: "error", error: "update returned notFound or no result" };
    } catch (err) {
      return { type: "error", error: String(err) };
    }
  } else {
    // ── Insert ──────────────────────────────────────────────────────────────
    try {
      for await (const r of p.targetEntity.insert!(
        oneRecord<InsertRecord>({ data: p.localData, associations: p.associationsPayload }),
        p.target.ctx,
      )) {
        if (!r.error && r.id) {
          const diffs = computeFieldDiffs(p.resolvedCanonical, undefined, p.connectorId);
          const newTargetFieldData = buildFieldData(undefined, p.shadowSeedCanonical, p.connectorId, p.ingestTs, targetAssocSentinel);
          return {
            type: "ok",
            action: "insert",
            targetId: r.id,
            newTargetFieldData,
            txEntry: {
              batchId: p.batchId,
              connectorId: p.targetMember.connectorId,
              entityName: p.targetMember.entity,
              externalId: r.id,
              canonicalId: p.canonId,
              action: "insert",
              dataBefore: undefined,
              dataAfter: newTargetFieldData,
            },
            event: {
              type: "record.created",
              channelId: p.channelId,
              entityName: p.sourceMember.entity,
              canonicalId: p.canonId,
              sourceConnectorId: p.connectorId,
              targetConnectorId: p.targetMember.connectorId,
              batchId: p.batchId,
              data: p.resolvedCanonical,
              changes: diffs,
            },
          };
        }
      }
      return { type: "error", error: "insert returned no id" };
    } catch (err) {
      return { type: "error", error: String(err) };
    }
  }
}

// ─── Internal helper ──────────────────────────────────────────────────────────

async function* oneRecord<T>(item: T): AsyncIterable<T> {
  yield item;
}

export type { ConnectorContext, EntityDefinition, InsertRecord, UpdateRecord };
export type { FieldDiff } from "./events.js";
export type { ConflictConfig } from "./conflict.js";
export { EventBus } from "./events.js";
export { CircuitBreaker } from "./circuit-breaker.js";
