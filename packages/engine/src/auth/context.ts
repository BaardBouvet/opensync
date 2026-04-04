// Spec: specs/sync-engine.md § Context & Auth
// Wires up the ConnectorContext for a single connector instance.

import type { Connector, ConnectorContext, EntityDefinition, StateStore } from "@opensync/sdk";
import type { Db } from "../db/index.js";
import type { ConnectorInstance } from "../config/loader.js";
import type { JournalTrigger } from "../db/queries.js";
import { makeConnectorState } from "../db/queries.js";
import { makeTrackedFetch, OAuthTokenManager } from "./http.js";

export interface WiredConnectorInstance {
  id: string;
  ctx: ConnectorContext;
  entities: EntityDefinition[];
  connector: Connector;
  batchIdRef: { current: string | undefined };
  triggerRef: { current: JournalTrigger | undefined };
}

/** Wire up a ConnectorInstance with a live ConnectorContext backed by the engine DB. */
export function makeWiredInstance(
  instance: ConnectorInstance,
  db: Db,
  webhookBaseUrl: string,
): WiredConnectorInstance {
  const { id, connector, config, auth } = instance;

  const batchIdRef: { current: string | undefined } = { current: undefined };
  const triggerRef: { current: JournalTrigger | undefined } = { current: undefined };
  const ctxRef: { current: ConnectorContext | undefined } = { current: undefined };

  // ctx.state — backed by connector_state table
  const stateStore = makeConnectorState(db, id);
  const state: StateStore = {
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

  // Build OAuthTokenManager if needed
  // Spec: specs/auth.md §Credentials in opensync.json — credentials live in auth, not config
  let oauthManager: OAuthTokenManager | undefined;
  if (connector.metadata.auth.type === "oauth2" && connector.getOAuthConfig) {
    const oauthCfg = connector.getOAuthConfig(config);
    const scopes = connector.metadata.auth.scopes ?? [];
    const clientId = (auth["clientId"] ?? auth["client_id"]) as string;
    const clientSecret = (auth["clientSecret"] ?? auth["client_secret"]) as string;
    oauthManager = new OAuthTokenManager(
      id,
      oauthCfg,
      scopes,
      clientId,
      clientSecret,
      db,
      batchIdRef,
    );
  }

  const http = makeTrackedFetch(
    id,
    connector.metadata.auth,
    auth,
    config,
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
