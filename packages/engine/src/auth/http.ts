// Spec: specs/sync-engine.md § Context & Auth, specs/auth.md
// Tracked fetch: logs every outbound HTTP call to request_journal, injects auth headers.

import type { ConnectorContext, TrackedFetch, AuthConfig, OAuthConfig } from "@opensync/sdk";
import type { Db } from "../db/index.js";
import { dbLogRequestJournal, type JournalTrigger } from "../db/queries.js";

// ─── Credential masking ───────────────────────────────────────────────────────

const SENSITIVE_HEADER_PATTERNS = /authorization|x-api-key|x-signature|cookie|proxy-authorization|token|secret|key/i;

function maskHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = SENSITIVE_HEADER_PATTERNS.test(k) ? "[REDACTED]" : v;
  });
  return out;
}

// ─── OAuthTokenManager ────────────────────────────────────────────────────────

// Spec: specs/auth.md § OAuth2
import {
  dbGetOAuthToken,
  dbUpsertOAuthToken,
  dbAcquireOAuthLock,
  dbReleaseOAuthLock,
} from "../db/queries.js";

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const LOCK_WAIT_MS = 500;
const LOCK_WAIT_RETRIES = 20;

export class OAuthTokenManager {
  constructor(
    private readonly connectorId: string,
    private readonly oauthConfig: OAuthConfig,
    private readonly scopes: string[],
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly db: Db,
    private readonly batchIdRef: { current: string | undefined },
  ) {}

  async getAccessToken(): Promise<string> {
    const row = dbGetOAuthToken(this.db, this.connectorId);

    if (row && this._isValid(row)) {
      return row.access_token;
    }

    if (row) {
      const won = dbAcquireOAuthLock(this.db, this.connectorId);
      if (!won) {
        return this._waitForRefresh();
      }
    }

    try {
      return await this._fetchAndStore();
    } finally {
      dbReleaseOAuthLock(this.db, this.connectorId);
    }
  }

  private _isValid(row: { expires_at: string | null }): boolean {
    if (!row.expires_at) return true;
    const expiresMs = new Date(row.expires_at).getTime();
    return expiresMs - Date.now() > TOKEN_EXPIRY_BUFFER_MS;
  }

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

    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(this.oauthConfig.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (err) {
      dbLogRequestJournal(this.db, {
        connectorId: this.connectorId,
        batchId: this.batchIdRef.current,
        trigger: "oauth_refresh",
        method: "POST",
        url: this.oauthConfig.tokenUrl,
        requestBody: "[credentials redacted]",
        requestHeaders: JSON.stringify({ "content-type": "application/x-www-form-urlencoded" }),
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
      responseBody = text.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[REDACTED]"');
    } catch { /* ignore */ }

    dbLogRequestJournal(this.db, {
      connectorId: this.connectorId,
      batchId: this.batchIdRef.current,
      trigger: "oauth_refresh",
      method: "POST",
      url: this.oauthConfig.tokenUrl,
      requestBody: "[credentials redacted]",
      requestHeaders: JSON.stringify({ "content-type": "application/x-www-form-urlencoded" }),
      responseStatus: res.status,
      responseBody,
      durationMs,
    });

    if (!res.ok) {
      throw new Error(`OAuth token request failed for ${this.connectorId}: ${res.status} ${responseBody ?? ""}`);
    }

    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
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

// Spec: specs/sync-engine.md § Context & Auth — auth priority order
function resolveStaticAuthHeader(
  auth: AuthConfig | undefined,
  config: Record<string, unknown>,
): { header: string; value: string } | undefined {
  if (!auth || auth.type !== "api-key") return undefined;
  const key = config["apiKey"] ?? config["api_key"] ?? config["accessToken"];
  if (typeof key !== "string") return undefined;
  const header = auth.header ?? "Authorization";
  return { header, value: `Bearer ${key}` };
}

export interface TrackedFetchOptions {
  oauthManager?: OAuthTokenManager;
  prepareRequest?: (req: Request, ctx: ConnectorContext) => Promise<Request>;
  ctxRef?: { current: ConnectorContext | undefined };
}

export function makeTrackedFetch(
  connectorId: string,
  auth: AuthConfig | undefined,
  config: Record<string, unknown>,
  db: Db,
  batchIdRef: { current: string | undefined },
  triggerRef: { current: JournalTrigger | undefined },
  opts?: TrackedFetchOptions,
): TrackedFetch {
  const { oauthManager, prepareRequest: prepareHook, ctxRef } = opts ?? {};

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
      input instanceof Request && !init?.method
        ? input.method
        : ((init?.method ?? "GET").toUpperCase());

    let requestBodyForLog: string | null = null;
    if (init?.body != null) {
      requestBodyForLog =
        typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    }

    const baseHeaders = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => baseHeaders.set(k, v));
    }

    let req = new Request(
      typeof input === "string" || input instanceof URL ? input : input.url,
      { method, headers: baseHeaders, body: init?.body },
    );

    // Auth priority order (Spec: specs/sync-engine.md § Context & Auth)
    if (!skipPrepare && prepareHook && ctxRef?.current) {
      // 1. prepareRequest — connector-custom auth; skip recursion inside hook
      const safeHttp: TrackedFetch = (i, ii) => rawFetch(i, ii, true);
      const safeCtx = { ...ctxRef.current, http: safeHttp };
      req = await prepareHook(req, safeCtx);
    } else if (!skipPrepare && oauthManager) {
      // 2. OAuth2
      const token = await oauthManager.getAccessToken();
      req.headers.set("Authorization", `Bearer ${token}`);
    } else {
      // 3. API key / none
      const injected = resolveStaticAuthHeader(auth, config);
      if (injected) req.headers.set(injected.header, injected.value);
    }

    const maskedHeadersLog = JSON.stringify(maskHeaders(req.headers));

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
        requestHeaders: maskedHeadersLog,
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
      requestHeaders: maskedHeadersLog,
      responseStatus: response.status,
      responseBody,
      durationMs,
    });

    return response;
  }

  return (input, init) => rawFetch(input, init, false);
}
