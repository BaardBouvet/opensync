/**
 * OpenSync POC v5 — sync engine with HTTP surface, request journal, and webhooks.
 *
 * Adds on top of v4:
 *   - ctx.http: TrackedFetch — auth injection + request journal logging
 *   - Connector interface — getEntities + lifecycle hooks (onEnable/onDisable/handleWebhook)
 *   - WebhookServer — in-process Bun.serve receiver → webhook_queue
 *   - SyncEngine.processWebhookQueue() — dequeue → handleWebhook → sync pipeline
 *   - SyncEngine.onEnable() / onDisable() — call connector lifecycle methods
 *   - batch_id propagated into request_journal for write-call correlation
 */
import type {
  Association,
  AuthConfig,
  Connector,
  ConnectorContext,
  EntityDefinition,
  InsertRecord,
  ReadRecord,
  UpdateRecord,
  WebhookBatch,
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
  makeConnectorState,
  dbLogRequestJournal,
  dbEnqueueWebhook,
  dbGetPendingWebhooks,
  dbMarkWebhookCompleted,
  dbMarkWebhookFailed,
  dbMarkWebhookProcessing,
} from "./db.js";
import type { ConflictConfig } from "../v4/conflict.js";
import { resolveConflicts } from "../v4/conflict.js";
import type { FieldDiff } from "../v4/events.js";
import { EventBus } from "../v4/events.js";
import { CircuitBreaker } from "../v4/circuit-breaker.js";

// AuthConfig, Connector, and WebhookBatch are imported from the SDK above.

// ─── Credential masking ───────────────────────────────────────────────────────

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

function maskHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers.entries()) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}

// ─── makeTrackedFetch ─────────────────────────────────────────────────────────

/**
 * Build a ctx.http implementation for a single connector instance.
 *
 * The returned function wraps native `fetch()` and:
 *   1. Injects auth headers from `config` according to `auth` metadata.
 *   2. Logs each call to the `request_journal` table (credentials masked).
 *   3. Truncates response bodies at 64 KB.
 *   4. Propagates the current `batchIdRef.current` into the journal row so
 *      HTTP calls can be correlated with the transaction_log writes they produce.
 */
/**
 * Extract an inject-ready { header, value } pair from the SDK AuthConfig for v5's
 * supported auth type (api-key / apiKey). Returns undefined when no injection is needed.
 */
function resolveAuthHeader(
  auth: AuthConfig | undefined,
  config: Record<string, unknown>,
): { header: string; value: string } | undefined {
  if (!auth) return undefined;
  if (auth.type === "api-key") {
    const token = config["apiKey"];
    if (typeof token !== "string") return undefined;
    const header = auth.header ?? "Authorization";
    return { header, value: `Bearer ${token}` };
  }
  return undefined;
}

export function makeTrackedFetch(
  connectorId: string,
  auth: AuthConfig | undefined,
  config: Record<string, unknown>,
  db: Db,
  batchIdRef: { current: string | undefined },
  triggerRef: { current: JournalTrigger | undefined },
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async function trackedFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    // Resolve method and URL for logging
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method =
      typeof input === "object" && input instanceof Request && !init?.method
        ? input.method
        : (init?.method ?? "GET").toUpperCase();

    // Serialize request body for journal (before mutating init)
    let requestBodyForLog: string | null = null;
    if (init?.body != null) {
      requestBodyForLog = typeof init.body === "string"
        ? init.body
        : JSON.stringify(init.body);
    }

    // Build merged Headers with auth injection
    const merged = new Headers(
      typeof input === "object" && input instanceof Request
        ? input.headers
        : undefined,
    );
    if (init?.headers) {
      const h = new Headers(init.headers);
      for (const [k, v] of h.entries()) merged.set(k, v);
    }
    const injected = resolveAuthHeader(auth, config);
    if (injected) merged.set(injected.header, injected.value);

    const maskedHeadersForLog = JSON.stringify(maskHeaders(merged));

    const t0 = Date.now();
    let response: Response;
    try {
      response = await fetch(input, { ...init, headers: merged });
    } catch (err) {
      // Network-level error — log with status -1 and rethrow
      dbLogRequestJournal(db, {
        connectorId,
        batchId: batchIdRef.current,
        trigger: triggerRef.current,
        method,
        url,
        requestBody: requestBodyForLog,
        requestHeaders: maskedHeadersForLog,
        responseStatus: -1,
        responseBody: String(err),
        durationMs: Date.now() - t0,
      });
      throw err;
    }

    const durationMs = Date.now() - t0;

    // Clone response so we can read the body without consuming the original
    let responseBody: string | null = null;
    try {
      const text = await response.clone().text();
      responseBody = text.length > 65_536 ? text.slice(0, 65_536) : text;
    } catch {
      // ignore body read errors for journaling
    }

    dbLogRequestJournal(db, {
      connectorId,
      batchId: batchIdRef.current,
      trigger: triggerRef.current,
      method,
      url,
      requestBody: requestBodyForLog,
      requestHeaders: maskedHeadersForLog,
      responseStatus: response.status,
      responseBody,
      durationMs,
    });

    return response;
  };
}

// ─── WebhookServer ────────────────────────────────────────────────────────────

/**
 * Lightweight in-process HTTP server that receives webhook POSTs from external systems.
 *
 * Route: `POST /webhooks/:connectorId`
 * On receipt it writes the raw payload to `webhook_queue` and responds 200 immediately.
 * Processing happens separately via `SyncEngine.processWebhookQueue()`.
 */
export class WebhookServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(
    private readonly port: number,
    private readonly db: Db,
  ) {}

  start(): void {
    const db = this.db;
    this.server = Bun.serve({
      port: this.port,
      fetch(req) {
        const url = new URL(req.url);
        const match = /^\/webhooks\/([^/]+)$/.exec(url.pathname);
        if (!match || req.method !== "POST") {
          return new Response("Not Found", { status: 404 });
        }
        const connectorId = decodeURIComponent(match[1]);
        // Read body async then enqueue — responding after the write is fine for POC
        return req.text().then((body) => {
          dbEnqueueWebhook(db, connectorId, body);
          return new Response(null, { status: 200 });
        });
      },
    });
  }

  get baseUrl(): string {
    return `http://localhost:${this.port}`;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }
}

// ─── Config types ─────────────────────────────────────────────────────────────

export interface FieldMapping {
  source?: string;
  target: string;
  direction?: "bidirectional" | "forward_only" | "reverse_only";
  expression?: string;
}

export type FieldMappingList = FieldMapping[];

/** @deprecated Use FieldMappingList. */
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
  identityFields?: string[];
}

export interface ConnectorInstance {
  id: string;
  ctx: ConnectorContext;
  entities: EntityDefinition[];
  connector?: Connector;
  batchIdRef?: { current: string | undefined };
  triggerRef?: { current: JournalTrigger | undefined };
}

export interface EngineConfig {
  connectors: ConnectorInstance[];
  channels: ChannelConfig[];
  eventBus?: EventBus;
  conflict?: ConflictConfig;
  circuitBreaker?: CircuitBreaker;
  /** Port for the in-process webhook server. Omit to disable. Hardcoded to 4001 for the POC. */
  webhookPort?: number;
  /**
   * Maximum milliseconds allowed for the full read phase of a single `ingest()` call.
   * If the connector's `read()` generator doesn't complete within this window the
   * `ingest()` call rejects with a timeout error and the circuit breaker records the
   * failure.  The underlying generator is abandoned (not cancelled — cancellation
   * requires threading AbortSignal into the SDK read() signature, deferred to a
   * future engine rewrite).
   * Defaults to 30 000 ms.
   */
  readTimeoutMs?: number;
}

// ─── Public result types ──────────────────────────────────────────────────────

export type SyncAction = "insert" | "update" | "skip" | "defer" | "error";

export interface RecordSyncResult {
  entity: string;
  action: SyncAction;
  sourceId: string;
  targetConnectorId: string;
  targetId: string;
  error?: string;
}

export interface IngestResult {
  channelId: string;
  connectorId: string;
  records: RecordSyncResult[];
}

// ─── Factory helper ───────────────────────────────────────────────────────────

/**
 * Build a fully wired `ConnectorInstance` from a plugin + config.
 *
 * Creates:
 *   - `batchIdRef` holder (engine updates `.current` before each sync cycle)
 *   - `ctx.http` via `makeTrackedFetch` (auth injection + request journal)
 *   - `ctx.state` backed by connector_state table
 *   - `ctx.webhookUrl` pointing at the engine's webhook server
 */
export function makeConnectorInstance(
  id: string,
  connector: Connector,
  config: Record<string, unknown>,
  db: Db,
  webhookBaseUrl: string,
): ConnectorInstance {
  const batchIdRef: { current: string | undefined } = { current: undefined };
  const triggerRef: { current: JournalTrigger | undefined } = { current: undefined };

  const stateStore = makeConnectorState(db, id);
  // Wrap sync connector_state methods as async StateStore for the SDK interface
  const state: ConnectorContext["state"] = {
    async get<T>(key: string): Promise<T | undefined> {
      return stateStore.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      stateStore.set(key, value);
    },
    async delete(key: string): Promise<void> {
      stateStore.delete(key);
    },
    async update<T>(
      key: string,
      fn: (current: T | undefined) => T | Promise<T>,
    ): Promise<T> {
      const current = stateStore.get(key) as T | undefined;
      const next = await fn(current);
      stateStore.set(key, next);
      return next;
    },
  };

  const ctx: ConnectorContext = {
    config,
    state,
    logger: {
      info(msg, meta) { console.log(`[${id}] INFO  ${msg}`, meta ?? ""); },
      warn(msg, meta) { console.warn(`[${id}] WARN  ${msg}`, meta ?? ""); },
      error(msg, meta) { console.error(`[${id}] ERROR ${msg}`, meta ?? ""); },
      debug(msg, meta) { console.debug(`[${id}] DEBUG ${msg}`, meta ?? ""); },
    },
    http: makeTrackedFetch(id, connector.metadata.auth, config, db, batchIdRef, triggerRef),
    webhookUrl: `${webhookBaseUrl}/webhooks/${encodeURIComponent(id)}`,
  };

  return {
    id,
    ctx,
    entities: connector.getEntities(ctx),
    connector,
    batchIdRef,
    triggerRef,
  };
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

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
      if (dir === "forward_only") continue;
      if (!m.source) continue;
      if (Object.prototype.hasOwnProperty.call(data, m.source)) {
        result[m.target] = data[m.source];
      }
    } else {
      if (dir === "reverse_only") continue;
      if (!m.source) continue;
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

export function shadowMatchesIncoming(
  existing: FieldData,
  incoming: Record<string, unknown>,
  assocSentinel: string | undefined,
): boolean {
  for (const [k, v] of Object.entries(incoming)) {
    const entry = existing[k];
    if (!entry) return false;
    if (JSON.stringify(entry.val) !== JSON.stringify(v)) return false;
  }
  for (const k of Object.keys(existing)) {
    if (k === "__assoc__") continue;
    if (!Object.prototype.hasOwnProperty.call(incoming, k)) return false;
  }
  const existingAssoc = existing["__assoc__"]?.val;
  if (assocSentinel !== undefined) {
    if (existingAssoc !== assocSentinel) return false;
  } else {
    if (existingAssoc !== undefined) return false;
  }
  return true;
}

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
 * Bidirectional sync engine — v5.
 *
 * v5 adds on top of v4:
 *   - ctx.http with auth injection and request_journal logging
 *   - WebhookServer + webhook_queue + processWebhookQueue()
 *   - onEnable() / onDisable() connector lifecycle
 *   - batch_id propagation into request_journal rows for correlation
 */
export class SyncEngine {
  private readonly connectors: Map<string, ConnectorInstance>;
  private readonly channels: Map<string, ChannelConfig>;
  private readonly db: Db;
  private readonly eventBus: EventBus;
  private readonly conflictConfig: ConflictConfig;
  private readonly breaker: CircuitBreaker;
  private readonly readTimeoutMs: number;
  private webhookServer: WebhookServer | undefined;

  constructor(config: EngineConfig, db: Db) {
    this.connectors = new Map(config.connectors.map((c) => [c.id, c]));
    this.channels = new Map(config.channels.map((ch) => [ch.id, ch]));
    this.db = db;
    this.eventBus = config.eventBus ?? new EventBus();
    this.conflictConfig = config.conflict ?? { strategy: "lww" };
    this.breaker = config.circuitBreaker ?? new CircuitBreaker();
    this.readTimeoutMs = config.readTimeoutMs ?? 30_000;
    if (config.webhookPort) {
      this.webhookServer = new WebhookServer(config.webhookPort, db);
    }
  }

  // ─── Webhook server lifecycle ────────────────────────────────────────────

  startWebhookServer(): void {
    this.webhookServer?.start();
  }

  stopWebhookServer(): void {
    this.webhookServer?.stop();
  }

  get webhookBaseUrl(): string | undefined {
    return this.webhookServer?.baseUrl;
  }

  // ─── Connector lifecycle ─────────────────────────────────────────────────

  async onEnable(connectorId: string): Promise<void> {
    const instance = this.connectors.get(connectorId);
    if (!instance?.connector?.onEnable) return;
    if (instance.triggerRef) instance.triggerRef.current = "on_enable";
    try {
      await instance.connector.onEnable(instance.ctx);
    } finally {
      if (instance.triggerRef) instance.triggerRef.current = undefined;
    }
  }

  async onDisable(connectorId: string): Promise<void> {
    const instance = this.connectors.get(connectorId);
    if (!instance?.connector?.onDisable) return;
    if (instance.triggerRef) instance.triggerRef.current = "on_disable";
    try {
      await instance.connector.onDisable(instance.ctx);
    } finally {
      if (instance.triggerRef) instance.triggerRef.current = undefined;
    }
  }

  // ─── Public helpers ──────────────────────────────────────────────────────

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

  // ─── Private helpers ─────────────────────────────────────────────────────

  private _getOrCreateCanonical(connectorId: string, externalId: string): string {
    const existing = dbGetCanonicalId(this.db, connectorId, externalId);
    if (existing) return existing;
    const canonId = crypto.randomUUID();
    dbLinkIdentity(this.db, canonId, connectorId, externalId);
    return canonId;
  }

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

  // ─── Core: diff + fan-out for a batch of pre-read records ───────────────

  /**
   * Given a set of already-read `ReadRecord[]` for a single `(channelId, sourceMember)`,
   * diff each record against shadow state, resolve conflicts, and fan out writes to all
   * other channel members.
   *
   * Called by both `ingest()` (polled records) and `processWebhookQueue()` (webhook records).
   * Both paths share the same pipeline — the only difference is how the records arrive.
   */
  private async _processRecords(
    channelId: string,
    sourceMember: ChannelMember,
    records: ReadRecord[],
    batchId: string,
    ingestTs: number,
  ): Promise<RecordSyncResult[]> {
    const channel = this.channels.get(channelId)!;
    const targets = channel.members.filter((m) => m.connectorId !== sourceMember.connectorId);
    const results: RecordSyncResult[] = [];

    // ── 1. Diff incoming records against shadow state ─────────────────────

    const pending: Array<{
      sourceId: string;
      canonical: Record<string, unknown>;
      associations: Association[] | undefined;
      assocSentinel: string | undefined;
    }> = [];

    for (const record of records) {
      const rawData = record.data as Record<string, unknown>;
      const strippedData = Object.fromEntries(
        Object.entries(rawData).filter(([k]) => !k.startsWith("_")),
      );
      const canonical = applyRename(strippedData, sourceMember.inbound, "inbound");

      const assocSentinel =
        record.associations === undefined
          ? undefined
          : JSON.stringify(
              [...record.associations].sort((a, b) => a.predicate.localeCompare(b.predicate)),
            );

      const existingShadowRow = dbGetShadowRow(
        this.db,
        sourceMember.connectorId,
        sourceMember.entity,
        record.id,
      );
      const existingShadow = existingShadowRow?.fieldData;
      const isResurrection = existingShadowRow?.deletedAt != null;

      if (
        !isResurrection &&
        existingShadow !== undefined &&
        shadowMatchesIncoming(existingShadow, canonical, assocSentinel)
      ) {
        results.push({
          entity: sourceMember.entity,
          action: "skip",
          sourceId: record.id,
          targetConnectorId: "",
          targetId: record.id,
        });
        continue;
      }

      pending.push({
        sourceId: record.id,
        canonical,
        associations: record.associations,
        assocSentinel,
      });
    }

    // ── 2. Fan out each changed record to all targets ─────────────────────

    let batchHadErrors = false;

    for (const record of pending) {
      const canonId = this._resolveCanonical(
        sourceMember.connectorId,
        record.sourceId,
        record.canonical,
        sourceMember.entity,
        channel.identityFields,
      );

      const existingSourceShadow = dbGetShadow(
        this.db,
        sourceMember.connectorId,
        sourceMember.entity,
        record.sourceId,
      );

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
          sourceMember.connectorId,
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
        const targetShadow =
          existingTargetId !== undefined
            ? dbGetShadow(this.db, targetMember.connectorId, targetMember.entity, existingTargetId)
            : undefined;

        const resolvedCanonical = resolveConflicts(
          record.canonical,
          targetShadow,
          sourceMember.connectorId,
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

        const dispatchResult = await dispatchWrite({
          db: this.db,
          batchId,
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
          connectorId: sourceMember.connectorId,
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

      // ── Atomic commit ─────────────────────────────────────────────────────
      this.db.transaction(() => {
        const sourceFieldData = buildFieldData(
          existingSourceShadow,
          record.canonical,
          sourceMember.connectorId,
          ingestTs,
          record.assocSentinel,
        );
        dbSetShadow(
          this.db,
          sourceMember.connectorId,
          sourceMember.entity,
          record.sourceId,
          canonId,
          sourceFieldData,
        );

        for (const outcome of dispatchOutcomes) {
          if (outcome.result.action === "insert") {
            dbLinkIdentity(
              this.db,
              outcome.shadowCanonId,
              outcome.shadowConnectorId,
              outcome.shadowExternalId,
            );
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

      for (const outcome of dispatchOutcomes) {
        results.push(outcome.result);
        if (outcome.event) await this.eventBus.emit(outcome.event);
      }
    }

    this.breaker.recordResult(batchHadErrors);
    return results;
  }

  // ─── ingest ───────────────────────────────────────────────────────────────

  /**
   * Read connector `connectorId` for channel `channelId`, diff against shadow state,
   * and propagate all changes to every other channel member.
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

    const breakerState = this.breaker.evaluate();
    if (breakerState === "OPEN") {
      return { channelId, connectorId, records: [] };
    }

    // Propagate batch_id and trigger into ctx.http so journal rows can be correlated
    if (source.batchIdRef) source.batchIdRef.current = opts.batchId;
    if (source.triggerRef) source.triggerRef.current = "poll";

    const ingestTs = Date.now();
    const since = opts.fullSync
      ? undefined
      : dbGetWatermark(this.db, connectorId, sourceMember.entity);

    // ── Read all records from the source ──────────────────────────────────
    //
    // Raced against a deadline. If the connector's read() generator stalls the
    // ingest() call rejects after readTimeoutMs. The generator itself is not
    // cancelled (no AbortSignal threading yet — deferred to a future engine
    // rewrite); it is simply abandoned.

    const allRecords: ReadRecord[] = [];
    let newWatermark: string | undefined;

    const readTimeoutMs = this.readTimeoutMs;
    await Promise.race([
      (async () => {
        for await (const batch of sourceEntity.read(source.ctx, since)) {
          allRecords.push(...batch.records);
          if (batch.since) newWatermark = batch.since;
        }
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(
            `ingest() read timed out after ${readTimeoutMs}ms` +
            ` (connector: ${connectorId}, entity: ${sourceMember.entity})`,
          )),
          readTimeoutMs,
        )
      ),
    ]);

    // ── Diff + fan-out ────────────────────────────────────────────────────

    const results = await this._processRecords(
      channelId,
      sourceMember,
      allRecords,
      opts.batchId,
      ingestTs,
    );

    // ── Advance watermark ─────────────────────────────────────────────────

    if (newWatermark && !opts.fullSync) {
      dbSetWatermark(this.db, connectorId, sourceMember.entity, newWatermark);
    }

    // ── Log sync run ──────────────────────────────────────────────────────

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

  // ─── processWebhookQueue ─────────────────────────────────────────────────

  /**
   * Drain the `webhook_queue` for all connector members of `channelId`.
   *
   * For each pending row:
   *   1. Mark as processing.
   *   2. Set batchIdRef so ctx.http calls inside handleWebhook get correlated.
   *   3. Call `connector.handleWebhook(req, ctx)` → `{ entity, records }[]`.
   *   4. Feed each batch through `_processRecords()` (same pipeline as polled).
   *   5. Mark completed or failed.
   *
   * Returns a map of connectorId → number of webhooks processed.
   */
  async processWebhookQueue(
    channelId: string,
  ): Promise<Map<string, number>> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Unknown channel: ${channelId}`);

    const connectorIds = channel.members.map((m) => m.connectorId);
    const pendingRows = dbGetPendingWebhooks(this.db, connectorIds);

    const counts = new Map<string, number>();

    for (const row of pendingRows) {
      const batchId = crypto.randomUUID();
      dbMarkWebhookProcessing(this.db, row.id, batchId);

      const instance = this.connectors.get(row.connector_id);
      if (!instance?.connector?.handleWebhook) {
        dbMarkWebhookFailed(this.db, row.id, "connector has no handleWebhook");
        continue;
      }

      // Propagate batchId into this connector's ctx.http
      if (instance.batchIdRef) instance.batchIdRef.current = batchId;
      if (instance.triggerRef) instance.triggerRef.current = "webhook";

      try {
        const startedAt = new Date().toISOString();
        const req = new Request("http://internal/webhook", {
          method: "POST",
          body: row.raw_payload,
          headers: { "content-type": "application/json" },
        });

        const batches: WebhookBatch[] = await instance.connector.handleWebhook(req, instance.ctx);

        const runCounts = { inserted: 0, updated: 0, skipped: 0, deferred: 0, errors: 0 };

        for (const { entity, records } of batches) {
          const sourceMember = channel.members.find(
            (m) => m.connectorId === row.connector_id && m.entity === entity,
          );
          if (!sourceMember) continue;

          const results = await this._processRecords(
            channelId,
            sourceMember,
            records,
            batchId,
            Date.now(),
          );
          for (const r of results) {
            if (r.action === "insert") runCounts.inserted++;
            else if (r.action === "update") runCounts.updated++;
            else if (r.action === "skip") runCounts.skipped++;
            else if (r.action === "defer") runCounts.deferred++;
            else if (r.action === "error") runCounts.errors++;
          }
        }

        dbLogSyncRun(this.db, {
          batchId,
          channelId,
          connectorId: row.connector_id,
          ...runCounts,
          startedAt,
          finishedAt: new Date().toISOString(),
        });

        dbMarkWebhookCompleted(this.db, row.id);
        counts.set(row.connector_id, (counts.get(row.connector_id) ?? 0) + 1);
      } catch (err) {
        dbMarkWebhookFailed(this.db, row.id, String(err));
      } finally {
        if (instance.triggerRef) instance.triggerRef.current = undefined;
      }
    }

    return counts;
  }
}

// ─── dispatchWrite ────────────────────────────────────────────────────────────

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
  const targetAssocSentinel =
    p.associationsPayload === undefined
      ? undefined
      : JSON.stringify(
          [...p.associationsPayload].sort((a, b) => a.predicate.localeCompare(b.predicate)),
        );

  if (p.existingTargetId !== undefined) {
    try {
      for await (const r of p.targetEntity.update!(
        oneRecord<UpdateRecord>({
          id: p.existingTargetId,
          data: p.localData,
          associations: p.associationsPayload,
        }),
        p.target.ctx,
      )) {
        if (!r.notFound && !r.error) {
          const diffs = computeFieldDiffs(
            p.resolvedCanonical,
            p.targetShadow,
            p.connectorId,
          );
          const newTargetFieldData = buildFieldData(
            p.targetShadow,
            p.shadowSeedCanonical,
            p.connectorId,
            p.ingestTs,
            targetAssocSentinel,
          );
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
      return { type: "error", error: "update returned notFound or no result" };
    } catch (err) {
      return { type: "error", error: String(err) };
    }
  } else {
    try {
      for await (const r of p.targetEntity.insert!(
        oneRecord<InsertRecord>({
          data: p.localData,
          associations: p.associationsPayload,
        }),
        p.target.ctx,
      )) {
        if (!r.error && r.id) {
          const diffs = computeFieldDiffs(p.resolvedCanonical, undefined, p.connectorId);
          const newTargetFieldData = buildFieldData(
            undefined,
            p.shadowSeedCanonical,
            p.connectorId,
            p.ingestTs,
            targetAssocSentinel,
          );
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
      return { type: "error", error: "insert returned error or no id" };
    } catch (err) {
      return { type: "error", error: String(err) };
    }
  }
}

// ─── Internal helper ─────────────────────────────────────────────────────────

async function* oneRecord<T>(item: T): AsyncIterable<T> {
  yield item;
}

export type { AuthConfig, Connector, ConnectorContext, EntityDefinition, InsertRecord, UpdateRecord, ReadRecord, WebhookBatch };
export type { FieldDiff } from "../v4/events.js";
export type { ConflictConfig } from "../v4/conflict.js";
export { EventBus } from "../v4/events.js";
export { CircuitBreaker } from "../v4/circuit-breaker.js";
