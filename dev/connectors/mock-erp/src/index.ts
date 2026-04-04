/**
 * mock-erp connector — POC v6
 *
 * Implements three auth patterns for testing, all accessing the same mock-erp server:
 *
 *   Default export  — OAuth2 client_credentials (metadata.auth.type = 'oauth2')
 *                     employees entity with ETag threading (lookup + update with If-Match)
 *
 *   sessionConnector — prepareRequest session-token pattern (metadata.auth.type = 'none')
 *                     logs in via POST /session/login on first use, stores token in ctx.state
 *                     handles 401 by re-logging-in and retrying
 *
 *   hmacConnector   — prepareRequest HMAC signing (metadata.auth.type = 'none')
 *                     signs request body with HMAC-SHA256 before every POST
 */
import type {
  Connector,
  ConnectorContext,
  EntityDefinition,
  OAuthConfig,
  ReadRecord,
  UpdateRecord,
} from "@opensync/sdk";
import crypto from "node:crypto";

// Must match MockErpServer.MOCK_HMAC_SECRET
const HMAC_SECRET = "hmac-secret-key";

interface EmployeePayload {
  id: string;
  name: string;
  email: string;
  department?: string;
  updatedAt: string;
  [key: string]: unknown;
}

// ─── OAuth2 connector (default export) ────────────────────────────────────────

function makeEmployeesEntity(): EntityDefinition {
  return {
    name: "employees",

    async *read(ctx: ConnectorContext, since?: string) {
      const base = ctx.config.baseUrl as string;
      const url = since ? `${base}/employees?since=${encodeURIComponent(since)}` : `${base}/employees`;
      const res = await ctx.http(url);
      if (!res.ok) throw new Error(`GET /employees failed: ${res.status}`);
      const employees = await res.json() as EmployeePayload[];
      const watermark = employees.length > 0
        ? employees.reduce((max, e) => e.updatedAt > max ? e.updatedAt : max, employees[0].updatedAt)
        : since;
      yield {
        records: employees.map((e) => ({
          id: e.id,
          data: { name: e.name, email: e.email, department: e.department, updatedAt: e.updatedAt },
        })),
        since: watermark,
      };
    },

    async lookup(ids: string[], ctx: ConnectorContext): Promise<ReadRecord[]> {
      const base = ctx.config.baseUrl as string;
      const results: ReadRecord[] = [];
      for (const id of ids) {
        const res = await ctx.http(`${base}/employees/${id}`);
        if (!res.ok) continue; // skip not-found; engine handles absent records
        const etag = res.headers.get("ETag") ?? undefined;
        const emp = await res.json() as EmployeePayload;
        results.push({
          id: emp.id,
          data: { name: emp.name, email: emp.email, department: emp.department, updatedAt: emp.updatedAt },
          version: etag,
        });
      }
      return results;
    },

    async *insert(records, ctx: ConnectorContext) {
      const base = ctx.config.baseUrl as string;
      for await (const record of records) {
        const res = await ctx.http(`${base}/employees`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(record.data),
        });
        if (!res.ok) {
          yield { id: "", error: `POST /employees failed: ${res.status}` };
          continue;
        }
        const created = await res.json() as EmployeePayload;
        yield { id: created.id, data: created };
      }
    },

    async *update(records: AsyncIterable<UpdateRecord>, ctx: ConnectorContext) {
      const base = ctx.config.baseUrl as string;
      for await (const record of records) {
        // Merge delta into snapshot if available, otherwise fetch current record
        let existing: Record<string, unknown> = {};
        if (record.snapshot) {
          existing = record.snapshot;
        } else {
          const fetchRes = await ctx.http(`${base}/employees/${record.id}`);
          if (fetchRes.ok) {
            existing = await fetchRes.json() as Record<string, unknown>;
          }
        }

        const merged = { ...existing, ...record.data };
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (record.version) headers["if-match"] = record.version;

        const res = await ctx.http(`${base}/employees/${record.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify(merged),
        });

        if (res.status === 412) {
          yield { id: record.id, error: "412 Precondition Failed — record modified concurrently" };
          continue;
        }
        if (!res.ok) {
          yield { id: record.id, error: `PUT /employees/${record.id} failed: ${res.status}` };
          continue;
        }
        yield { id: record.id };
      }
    },
  };
}

const mockErpConnector: Connector = {
  metadata: {
    name: "mock-erp",
    version: "0.1.0",
    auth: {
      type: "oauth2",
      scopes: ["employees:read", "employees:write"],
    },
  },

  getOAuthConfig(config: Record<string, unknown>): OAuthConfig {
    const base = config["baseUrl"] as string;
    return {
      authorizationUrl: `${base}/oauth/authorize`,
      tokenUrl: `${base}/oauth/token`,
    };
  },

  getEntities(_ctx: ConnectorContext): EntityDefinition[] {
    return [makeEmployeesEntity()];
  },
};

export default mockErpConnector;

// ─── prepareRequest: session-token connector ──────────────────────────────────

export const sessionConnector: Connector = {
  metadata: {
    name: "mock-erp-session",
    version: "0.1.0",
    auth: { type: "none" },
  },

  async prepareRequest(req: Request, ctx: ConnectorContext): Promise<Request> {
    const base = ctx.config.baseUrl as string;
    let session = await ctx.state.get<string>("session");

    if (!session) {
      session = await _doLogin(base, ctx);
    }

    // Clone request and inject X-Session header
    const headers = new Headers(req.headers);
    headers.set("x-session", session);
    return new Request(req, { headers });
  },

  getEntities(_ctx: ConnectorContext): EntityDefinition[] {
    return [
      {
        name: "employees",
        async *read(ctx: ConnectorContext, since?: string) {
          const base = ctx.config.baseUrl as string;
          const url = since
            ? `${base}/employees/legacy?since=${encodeURIComponent(since)}`
            : `${base}/employees/legacy`;
          const res = await ctx.http(url);
          if (res.status === 401) {
            // Session expired — refresh and retry once
            await _doLogin(base, ctx);
            const retry = await ctx.http(url);
            if (!retry.ok) throw new Error(`GET /employees/legacy failed after re-login: ${retry.status}`);
            const employees = await retry.json() as EmployeePayload[];
            yield { records: employees.map((e) => ({ id: e.id, data: e })) };
            return;
          }
          if (!res.ok) throw new Error(`GET /employees/legacy failed: ${res.status}`);
          const employees = await res.json() as EmployeePayload[];
          yield { records: employees.map((e) => ({ id: e.id, data: e })) };
        },
      },
    ];
  },
};

async function _doLogin(base: string, ctx: ConnectorContext): Promise<string> {
  const res = await ctx.http(`${base}/session/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pass" }),
  });
  if (!res.ok) throw new Error(`Session login failed: ${res.status}`);
  const { session } = await res.json() as { session: string };
  await ctx.state.set("session", session);
  return session;
}

// ─── prepareRequest: HMAC signing connector ───────────────────────────────────

export const hmacConnector: Connector = {
  metadata: {
    name: "mock-erp-hmac",
    version: "0.1.0",
    auth: { type: "none" },
  },

  async prepareRequest(req: Request, _ctx: ConnectorContext): Promise<Request> {
    // Read body without consuming the original stream
    const body = await req.clone().text();
    const sig = crypto
      .createHmac("sha256", HMAC_SECRET)
      .update(body)
      .digest("hex");

    const headers = new Headers(req.headers);
    headers.set("x-signature", sig);
    return new Request(req, { headers });
  },

  getEntities(_ctx: ConnectorContext): EntityDefinition[] {
    return [
      {
        name: "employees",
        async *insert(records, ctx: ConnectorContext) {
          const base = ctx.config.baseUrl as string;
          for await (const record of records) {
            const res = await ctx.http(`${base}/signed/employees`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(record.data),
            });
            if (!res.ok) {
              yield { id: "", error: `POST /signed/employees failed: ${res.status}` };
              continue;
            }
            const created = await res.json() as EmployeePayload;
            yield { id: created.id, data: created };
          }
        },
      },
    ];
  },
};
