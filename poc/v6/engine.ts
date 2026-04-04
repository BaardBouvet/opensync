/**
 * OpenSync POC v6 — OAuth2 client-credentials, prepareRequest, and ETag threading.
 *
 * Adds on top of v5:
 *   - OAuthTokenManager: acquire/refresh/lock cycle for OAuth2 connectors
 *   - ctx.http OAuth2 path: auto-inject Bearer token, refresh on expiry
 *   - ctx.http prepareRequest path: connector-managed signing/session-token auth
 *   - Non-recursion guard: ctx.http calls inside prepareRequest skip the hook
 *   - ETag threading: version from lookup() → UpdateRecord.version in dispatch loop
 *   - UpdateRecord.snapshot: live lookup data forwarded to connector for full-replace PUT
 */
import type {
  Association,
  AuthConfig,
  Connector,
  ConnectorContext,
  EntityDefinition,
  InsertRecord,
  OAuthConfig,
  ReadRecord,
  UpdateRecord,
  WebhookBatch,
} from "../../packages/sdk/src/index.js";
import type { Db, FieldData, OAuthTokenRow } from "./db.js";
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
  dbGetOAuthToken,
  dbUpsertOAuthToken,
  dbAcquireOAuthLock,
  dbReleaseOAuthLock,
} from "./db.js";
import type { ConflictConfig } from "../v4/conflict.js";
import { resolveConflicts } from "../v4/conflict.js";
import type { FieldDiff } from "../v4/events.js";
import { EventBus } from "../v4/events.js";
import { CircuitBreaker } from "../v4/circuit-breaker.js";

// AuthConfig, Connector, OAuthConfig, and WebhookBatch are imported from the SDK above.

// ─── Credential masking ───────────────────────────────────────────────────────

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-signature",
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

// ─── OAuthTokenManager ────────────────────────────────────────────────────────

/**
 * Manages the OAuth2 Client Credentials flow for a single connector instance.
 *
 * Responsibilities:
 *   - Acquire a token on first use (lazy — no request at engine startup).
 *   - Refresh the token when it is within TOKEN_EXPIRY_BUFFER_MS of expiry.
 *   - Serialise concurrent refreshes via a SQLite lock so only one request is
 *     made to the token endpoint even when multiple async tasks race.
 */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // refresh within 5 min of expiry
const LOCK_WAIT_MS = 500; // how long to wait before re-reading after losing lock race
const LOCK_WAIT_RETRIES = 20; // max retries × LOCK_WAIT_MS = 10s total

export class OAuthTokenManager {
  constructor(
    private readonly connectorId: string,
    private readonly oauthConfig: OAuthConfig,
    private readonly scopes: string[],
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly db: Db,
    private readonly batchIdRef?: { current: string | undefined },
    private readonly triggerRef?: { current: JournalTrigger | undefined },
  ) {}

  /** Return a valid access token, fetching or refreshing as needed. */
  async getAccessToken(): Promise<string> {
    const row = dbGetOAuthToken(this.db, this.connectorId);

    if (row && this._isValid(row)) {
      return row.access_token;
    }

    // Token missing or about to expire — try to acquire the refresh lock.
    if (row) {
      const won = dbAcquireOAuthLock(this.db, this.connectorId);
      if (!won) {
        // Another task is refreshing. Wait for it.
        return this._waitForRefresh();
      }
    }

    // Either no token exists (first call) or we won the lock — do the fetch.
    try {
      return await this._fetchAndStore();
    } finally {
      dbReleaseOAuthLock(this.db, this.connectorId);
    }
  }

  private _isValid(row: OAuthTokenRow): boolean {
    if (!row.expires_at) return true; // non-expiring token
    const expiresMs = new Date(row.expires_at).getTime();
    return expiresMs - Date.now() > TOKEN_EXPIRY_BUFFER_MS;
  }

  /** Poll until the lock holder has stored a fresh token (or we time out). */
  private async _waitForRefresh(): Promise<string> {
    for (let i = 0; i < LOCK_WAIT_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, LOCK_WAIT_MS));
      const row = dbGetOAuthToken(this.db, this.connectorId);
      if (row && this._isValid(row)) return row.access_token;
    }
    throw new Error(`OAuth token refresh timeout for connector ${this.connectorId}`);
  }

  private async _fetchAndStore(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: this.scopes.join(" "),
    });

    const requestBody = body.toString();
    const requestHeaders = JSON.stringify({ "content-type": "application/x-www-form-urlencoded" });
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(this.oauthConfig.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: requestBody,
      });
    } catch (err) {
      dbLogRequestJournal(this.db, {
        connectorId: this.connectorId,
        batchId: this.batchIdRef?.current,
        trigger: "oauth_refresh",
        method: "POST",
        url: this.oauthConfig.tokenUrl,
        requestBody: "[credentials redacted]",
        requestHeaders,
        responseStatus: -1,
        responseBody: String(err),
        durationMs: Date.now() - t0,
      });
      throw err;
    }

    const durationMs = Date.now() - t0;
    let responseBody: string | null = null;
    try {
      const text = await res.clone().text();
      // Mask the access_token in the logged body
      responseBody = text.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[REDACTED]"');
    } catch { /* ignore */ }

    dbLogRequestJournal(this.db, {
      connectorId: this.connectorId,
      batchId: this.batchIdRef?.current,
      trigger: "oauth_refresh",
      method: "POST",
      url: this.oauthConfig.tokenUrl,
      requestBody: "[credentials redacted]",
      requestHeaders,
      responseStatus: res.status,
      responseBody,
      durationMs,
    });

    if (!res.ok) {
      const text = responseBody ?? await res.text();
      throw new Error(
        `OAuth token request failed for ${this.connectorId}: ${res.status} ${text}`,
      );
    }

    const json = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };

    const expiresAt = json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : undefined;

    dbUpsertOAuthToken(this.db, this.connectorId, {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt,
    });

    return json.access_token;
  }
}

// ─── makeTrackedFetch ─────────────────────────────────────────────────────────

/**
 * Build a ctx.http implementation for a single connector instance.
 *
 * Auth priority order (v6):
 *   1. connector has prepareRequest? → call it, skip everything else.
 *      Calls made via ctx.http *inside* prepareRequest skip the hook (no recursion).
 *   2. metadata.auth.type === 'oauth2' → inject Bearer token (acquire/refresh via OAuthTokenManager).
 *   3. metadata.auth.type === 'api-key' → inject static key as Bearer header.
 *   4. metadata.auth.type === 'none'   → no auth header.
 *
 * Also logs each call to the `request_journal` table (credentials masked).
 */
function resolveAuthHeader(
  auth: AuthConfig | undefined,
  credentials: Record<string, unknown>,
): { header: string; value: string } | undefined {
  if (!auth) return undefined;
  if (auth.type === "api-key") {
    const token = credentials["apiKey"];
    if (typeof token !== "string") return undefined;
    const header = auth.header ?? "Authorization";
    return { header, value: `Bearer ${token}` };
  }
  return undefined;
}

export function makeTrackedFetch(
  connectorId: string,
  auth: AuthConfig | undefined,
  credentials: Record<string, unknown>,
  db: Db,
  batchIdRef: { current: string | undefined },
  triggerRef: { current: JournalTrigger | undefined },
  opts?: {
    oauthManager?: OAuthTokenManager;
    /** The connector's prepareRequest hook, if any. */
    prepareRequest?: (req: Request, ctx: ConnectorContext) => Promise<Request>;
    /** Ref to the ConnectorContext — needed so prepareRequest receives ctx. */
    ctxRef?: { current: ConnectorContext | undefined };
  },
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const oauthManager = opts?.oauthManager;
  const prepareRequestHook = opts?.prepareRequest;
  const ctxRef = opts?.ctxRef;

  /** Inner raw fetch — bypasses prepareRequest (used for token endpoint calls and
   *  for ctx.http calls *inside* prepareRequest to prevent recursion). */
  async function rawFetch(
    input: string | URL | Request,
    init?: RequestInit,
    skipPrepare = false,
  ): Promise<Response> {
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

    let requestBodyForLog: string | null = null;
    if (init?.body != null) {
      requestBodyForLog = typeof init.body === "string"
        ? init.body
        : JSON.stringify(init.body);
    }

    // Build the base request merged with caller init headers
    const baseHeaders = new Headers(
      typeof input === "object" && input instanceof Request ? input.headers : undefined,
    );
    if (init?.headers) {
      const h = new Headers(init.headers);
      for (const [k, v] of h.entries()) baseHeaders.set(k, v);
    }

    let req = new Request(
      typeof input === "string" || input instanceof URL ? input : input.url,
      { method, headers: baseHeaders, body: init?.body },
    );

    // 1. prepareRequest hook (skipped when called from inside the hook itself)
    if (!skipPrepare && prepareRequestHook && ctxRef?.current) {
      // Build a non-recursive ctx.http for use inside prepareRequest
      const safeHttp = (i: string | URL | Request, ii?: RequestInit) => rawFetch(i, ii, true);
      const safeCtx = { ...ctxRef.current, http: safeHttp as ConnectorContext["http"] };
      req = await prepareRequestHook(req, safeCtx);
    } else {
      // 2. OAuth2 token injection
      if (!skipPrepare && oauthManager) {
        const token = await oauthManager.getAccessToken();
        req.headers.set("Authorization", `Bearer ${token}`);
      } else {
        // 3. api-key static injection
        const injected = resolveAuthHeader(auth, credentials);
        if (injected) req.headers.set(injected.header, injected.value);
      }
    }

    // Log the request as-seen before sending (pre-prepareRequest for non-hook path,
    // post-prepareRequest for hook path — logs what was actually sent on the wire
    // minus the original intent; the design doc notes this as a known trade-off).
    const maskedHeadersForLog = JSON.stringify(maskHeaders(req.headers));

    const t0 = Date.now();
    let response: Response;
    try {
      response = await fetch(req);
    } catch (err) {
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
    let responseBody: string | null = null;
    try {
      const text = await response.clone().text();
      responseBody = text.length > 65_536 ? text.slice(0, 65_536) : text;
    } catch { /* ignore */ }

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
  }

  return (input, init) => rawFetch(input, init, false);
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
 * v6 additions over v5:
 *   - If metadata.auth.type === 'oauth2', creates an OAuthTokenManager and wires it
 *     into ctx.http for automatic token acquisition + refresh.
 *   - If connector.prepareRequest is defined, wires it into ctx.http with a
 *     non-recursive safeHttp so calls inside the hook don't re-trigger the hook.
 */
export function makeConnectorInstance(
  id: string,
  connector: Connector,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
  db: Db,
  webhookBaseUrl: string,
): ConnectorInstance {
  const batchIdRef: { current: string | undefined } = { current: undefined };
  const triggerRef: { current: JournalTrigger | undefined } = { current: undefined };
  // ctxRef lets prepareRequest receive the live ctx (filled in after ctx is created)
  const ctxRef: { current: ConnectorContext | undefined } = { current: undefined };

  const stateStore = makeConnectorState(db, id);
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

  // Build OAuthTokenManager if this connector uses OAuth2
  let oauthManager: OAuthTokenManager | undefined;
  if (connector.metadata.auth.type === "oauth2" && connector.getOAuthConfig) {
    const oauthCfg = connector.getOAuthConfig(config);
    const scopes = [
      ...(connector.metadata.auth.scopes ?? []),
      // Entity-level scope union deferred to full engine; POC uses base scopes only
    ];
    oauthManager = new OAuthTokenManager(
      id,
      oauthCfg,
      scopes,
      credentials["clientId"] as string,
      credentials["clientSecret"] as string,
      db,
      batchIdRef,
    );
  }

  const http = makeTrackedFetch(
    id,
    connector.metadata.auth,
    credentials,
    db,
    batchIdRef,
    triggerRef,
    {
      oauthManager,
      prepareRequest: connector.prepareRequest?.bind(connector),
      ctxRef,
    },
  );

  const ctx: ConnectorContext = {
    config,
    state,
    logger: {
      info(msg, meta) { console.log(`[${id}] INFO  ${msg}`, meta ?? ""); },
      warn(msg, meta) { console.warn(`[${id}] WARN  ${msg}`, meta ?? ""); },
      error(msg, meta) { console.error(`[${id}] ERROR ${msg}`, meta ?? ""); },
      debug(msg, meta) { console.debug(`[${id}] DEBUG ${msg}`, meta ?? ""); },
    },
    http,
    webhookUrl: `${webhookBaseUrl}/webhooks/${encodeURIComponent(id)}`,
  };
  ctxRef.current = ctx;

  return {
    id,
    ctx,
    entities: connector.getEntities ? connector.getEntities(ctx) : [],
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

        // ── ETag pre-fetch (v6) ─────────────────────────────────────────────
        // If the target entity provides lookup() and we have an existing target ID,
        // fetch the live record now so we can thread version → UpdateRecord.version
        // and snapshot → UpdateRecord.snapshot.  This spares the connector a second
        // GET on full-replace PUT APIs that need the full existing record to merge into.
        let liveVersion: string | undefined;
        let liveSnapshot: Record<string, unknown> | undefined;
        if (existingTargetId !== undefined && targetEntity.lookup) {
          try {
            const liveRecords = await targetEntity.lookup([existingTargetId], target.ctx);
            const live = liveRecords.find((r) => r.id === existingTargetId);
            if (live) {
              liveVersion = live.version;
              liveSnapshot = live.data as Record<string, unknown>;
            }
          } catch {
            // lookup failure is non-fatal — proceed without version/snapshot
          }
        }

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
          liveVersion,
          liveSnapshot,
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

    // Propagate batch_id and trigger into ctx.http so journal rows can be correlated.
    // Both the source connector and every target connector need the refs set so that
    // all HTTP calls made during the ingest (reads from source, writes to targets) are
    // attributed to this poll batch.
    const pollTargets = channel.members
      .filter((m) => m.connectorId !== connectorId)
      .flatMap((m) => { const inst = this.connectors.get(m.connectorId); return inst ? [inst] : []; });

    if (source.batchIdRef) source.batchIdRef.current = opts.batchId;
    if (source.triggerRef) source.triggerRef.current = "poll";
    for (const t of pollTargets) {
      if (t.batchIdRef) t.batchIdRef.current = opts.batchId;
      if (t.triggerRef) t.triggerRef.current = "poll";
    }

    try {
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
    } finally {
      if (source.triggerRef) source.triggerRef.current = undefined;
      for (const t of pollTargets) {
        if (t.triggerRef) t.triggerRef.current = undefined;
      }
    }
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

      // Propagate batchId and trigger into this connector's ctx.http and all target connectors
      const webhookTargets = channel.members
        .filter((m) => m.connectorId !== row.connector_id)
        .flatMap((m) => { const inst = this.connectors.get(m.connectorId); return inst ? [inst] : []; });

      if (instance.batchIdRef) instance.batchIdRef.current = batchId;
      if (instance.triggerRef) instance.triggerRef.current = "webhook";
      for (const t of webhookTargets) {
        if (t.batchIdRef) t.batchIdRef.current = batchId;
        if (t.triggerRef) t.triggerRef.current = "webhook";
      }

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
        for (const t of webhookTargets) {
          if (t.triggerRef) t.triggerRef.current = undefined;
        }
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
  /** ETag / opaque version from the most recent lookup() on the target record. */
  liveVersion?: string;
  /** Full live record snapshot from lookup() — for full-replace PUT connectors. */
  liveSnapshot?: Record<string, unknown>;
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
          version: p.liveVersion,
          snapshot: p.liveSnapshot,
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
