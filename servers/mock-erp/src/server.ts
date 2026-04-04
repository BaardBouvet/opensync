/**
 * MockErpServer — standalone mock HTTP server for connector tests.
 *
 * Extracted from poc/v6/mock-erp-server.ts. Adds env-var configuration
 * and a /__reset test-helper endpoint.
 *
 * Endpoints:
 *   POST /oauth/token              — client_credentials grant; returns access_token
 *   GET  /employees?since=<iso>    — list employees (Bearer auth)
 *   GET  /employees/:id            — fetch employee with ETag header (Bearer auth)
 *   POST /employees                — create employee (Bearer auth)
 *   PUT  /employees/:id            — update employee; validates If-Match (Bearer auth)
 *   POST /session/login            — returns { session: "<token>" }
 *   GET  /employees/legacy         — list employees (X-Session auth)
 *   POST /signed/employees         — create employee (X-Signature HMAC-SHA256)
 *   POST /__expire-token           — test helper: expire current OAuth token
 *   POST /__invalidate-session     — test helper: clear session token
 *   POST /__mutate-employee/:id    — test helper: out-of-band mutation (advances ETag)
 *   POST /__reset                  — test helper: clear all state
 *
 * Environment variables (read by main.ts; tests pass values directly):
 *   MOCK_ERP_PORT          — listening port (default: 4002)
 *   MOCK_ERP_CLIENT_ID     — OAuth2 client ID (default: opensync-test)
 *   MOCK_ERP_CLIENT_SECRET — OAuth2 client secret (default: secret)
 *   MOCK_ERP_HMAC_SECRET   — HMAC signing key (default: hmac-secret-key)
 */
import crypto from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Employee {
  id: string;
  name: string;
  email: string;
  department?: string;
  updatedAt: string;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_CLIENT_ID = "opensync-test";
export const DEFAULT_CLIENT_SECRET = "secret";
export const DEFAULT_HMAC_SECRET = "hmac-secret-key";
export const TOKEN_EXPIRES_IN = 3600; // seconds

// ─── MockErpServer ────────────────────────────────────────────────────────────

export class MockErpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private employees = new Map<string, Employee>();
  private etags = new Map<string, string>();
  private currentToken: string | null = null;
  private tokenExpiresAt: number | null = null;
  private sessionToken: string | null = null;
  private _port = 0;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly hmacSecret: string;

  constructor(opts: {
    clientId?: string;
    clientSecret?: string;
    hmacSecret?: string;
  } = {}) {
    this.clientId = opts.clientId ?? DEFAULT_CLIENT_ID;
    this.clientSecret = opts.clientSecret ?? DEFAULT_CLIENT_SECRET;
    this.hmacSecret = opts.hmacSecret ?? DEFAULT_HMAC_SECRET;
  }

  get port(): number { return this._port; }
  get baseUrl(): string { return `http://localhost:${this._port}`; }

  start(port = 0): void {
    this._port = port;
    const self = this;
    this.server = Bun.serve({
      port,
      fetch(req) {
        return self._handle(req);
      },
    });
    this._port = this.server.port;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
    this._reset();
  }

  seed(employees: Omit<Employee, "updatedAt">[]): void {
    for (const e of employees) {
      const emp: Employee = { ...e, updatedAt: new Date().toISOString() };
      this.employees.set(e.id, emp);
      this.etags.set(e.id, this._makeETag(emp));
    }
  }

  private _reset(): void {
    this.employees.clear();
    this.etags.clear();
    this.currentToken = null;
    this.tokenExpiresAt = null;
    this.sessionToken = null;
  }

  // ─── Router ──────────────────────────────────────────────────────────────────

  private async _handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Test-control endpoints
    if (method === "POST" && path === "/__expire-token") {
      this.tokenExpiresAt = Date.now() - 1000;
      return Response.json({ expired: true });
    }
    if (method === "POST" && path === "/__invalidate-session") {
      this.sessionToken = null;
      return Response.json({ invalidated: true });
    }
    if (method === "POST" && path === "/__reset") {
      this._reset();
      return Response.json({ ok: true });
    }
    if (method === "POST" && path.startsWith("/__mutate-employee/")) {
      const id = decodeURIComponent(path.slice("/__mutate-employee/".length));
      const emp = this.employees.get(id);
      if (!emp) return new Response("not found", { status: 404 });
      const body = await req.json() as Partial<Employee>;
      const updated: Employee = { ...emp, ...body, updatedAt: new Date().toISOString() };
      this.employees.set(id, updated);
      this.etags.set(id, this._makeETag(updated));
      return Response.json(updated);
    }

    // OAuth token endpoint
    if (method === "POST" && path === "/oauth/token") {
      return this._handleToken(req);
    }

    // Session login
    if (method === "POST" && path === "/session/login") {
      return this._handleSessionLogin(req);
    }

    // HMAC-signed endpoint
    if (method === "POST" && path === "/signed/employees") {
      return this._handleSignedEmployees(req);
    }

    // Legacy session endpoint
    if (method === "GET" && path === "/employees/legacy") {
      const sessionHeader = req.headers.get("x-session");
      if (!sessionHeader || sessionHeader !== this.sessionToken) {
        return new Response("Unauthorized", { status: 401 });
      }
      const since = url.searchParams.get("since");
      return Response.json(this._employeesSince(since));
    }

    // Bearer-authenticated endpoints
    const bearerErr = this._checkBearer(req);
    if (bearerErr) return bearerErr;

    if (method === "GET" && path === "/employees") {
      const since = url.searchParams.get("since");
      return Response.json(this._employeesSince(since));
    }

    const empMatch = /^\/employees\/([^/]+)$/.exec(path);
    if (empMatch) {
      const id = decodeURIComponent(empMatch[1]);
      if (method === "GET") return this._getEmployee(id);
      if (method === "PUT") return this._putEmployee(id, req);
    }

    if (method === "POST" && path === "/employees") {
      return this._postEmployee(req);
    }

    return new Response("not found", { status: 404 });
  }

  // ─── OAuth ────────────────────────────────────────────────────────────────

  private async _handleToken(req: Request): Promise<Response> {
    const text = await req.text();
    const params = new URLSearchParams(text);

    if (
      params.get("client_id") !== this.clientId ||
      params.get("client_secret") !== this.clientSecret
    ) {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    if (params.get("grant_type") !== "client_credentials") {
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }

    const token = `tok_${crypto.randomUUID()}`;
    this.currentToken = token;
    this.tokenExpiresAt = Date.now() + TOKEN_EXPIRES_IN * 1000;

    return Response.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: TOKEN_EXPIRES_IN,
      scope: params.get("scope") ?? "",
    });
  }

  private _checkBearer(req: Request): Response | null {
    const auth = req.headers.get("authorization");
    if (!auth?.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }
    const token = auth.slice("Bearer ".length);
    if (token !== this.currentToken) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (this.tokenExpiresAt !== null && Date.now() > this.tokenExpiresAt) {
      return new Response("Unauthorized — token expired", { status: 401 });
    }
    return null;
  }

  // ─── Session ──────────────────────────────────────────────────────────────

  private async _handleSessionLogin(req: Request): Promise<Response> {
    const body = await req.json() as { username?: string; password?: string };
    if (body.username === "admin" && body.password === "pass") {
      this.sessionToken = `sess_${crypto.randomUUID()}`;
      return Response.json({ session: this.sessionToken });
    }
    return new Response("Unauthorized", { status: 401 });
  }

  // ─── HMAC-signed endpoint ────────────────────────────────────────────────

  private async _handleSignedEmployees(req: Request): Promise<Response> {
    const body = await req.text();
    const sig = req.headers.get("x-signature");

    const expected = crypto
      .createHmac("sha256", this.hmacSecret)
      .update(body)
      .digest("hex");

    if (sig !== expected) {
      return new Response("Bad Signature", { status: 401 });
    }

    const data = JSON.parse(body) as Omit<Employee, "updatedAt">;
    const id = crypto.randomUUID();
    const emp: Employee = { ...data, id, updatedAt: new Date().toISOString() };
    this.employees.set(id, emp);
    this.etags.set(id, this._makeETag(emp));
    return Response.json(emp, { status: 201 });
  }

  // ─── Employee CRUD ────────────────────────────────────────────────────────

  private _getEmployee(id: string): Response {
    const emp = this.employees.get(id);
    if (!emp) return new Response("not found", { status: 404 });
    const etag = this.etags.get(id)!;
    return Response.json(emp, { headers: { ETag: etag } });
  }

  private async _postEmployee(req: Request): Promise<Response> {
    const data = await req.json() as Omit<Employee, "id" | "updatedAt">;
    const id = crypto.randomUUID();
    const emp: Employee = { ...data, id, updatedAt: new Date().toISOString() };
    this.employees.set(id, emp);
    this.etags.set(id, this._makeETag(emp));
    return Response.json(emp, { status: 201 });
  }

  private async _putEmployee(id: string, req: Request): Promise<Response> {
    const emp = this.employees.get(id);
    if (!emp) return new Response("not found", { status: 404 });

    const ifMatch = req.headers.get("if-match");
    const currentETag = this.etags.get(id)!;
    if (ifMatch && ifMatch !== currentETag) {
      return new Response("Precondition Failed", { status: 412 });
    }

    const data = await req.json() as Partial<Employee>;
    const updated: Employee = { ...emp, ...data, id, updatedAt: new Date().toISOString() };
    this.employees.set(id, updated);
    this.etags.set(id, this._makeETag(updated));
    return Response.json(updated, { headers: { ETag: this.etags.get(id)! } });
  }

  private _employeesSince(since: string | null): Employee[] {
    const all = Array.from(this.employees.values());
    if (!since) return all;
    const cutoff = new Date(since).getTime();
    return all.filter((e) => new Date(e.updatedAt).getTime() > cutoff);
  }

  private _makeETag(emp: Employee): string {
    return `"${crypto.createHash("md5").update(JSON.stringify(emp)).digest("hex")}"`;
  }
}
