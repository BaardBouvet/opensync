/**
 * MockErpServer — in-process test HTTP server for POC v6.
 *
 * Endpoints:
 *   POST /oauth/token           — client_credentials grant; returns access_token + expires_in
 *   GET  /employees?since=<iso> — requires Bearer token; returns JSON array
 *   GET  /employees/:id         — requires Bearer token; returns ETag header
 *   POST /employees             — requires Bearer token; creates employee
 *   PUT  /employees/:id         — requires Bearer; validates If-Match (returns 412 on mismatch)
 *
 *   POST /session/login         — returns { session: "<token>" }
 *   GET  /employees/legacy      — requires X-Session: <token>
 *
 *   POST /signed/employees      — requires X-Signature HMAC-SHA256
 *
 * Test-control endpoints (no auth required):
 *   POST /__expire-token        — mark current token as expired on the server side
 *   POST /__invalidate-session  — clear the current session token
 *   POST /__mutate-employee/:id — modify a field out-of-band to advance the stored ETag
 */
import crypto from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Employee {
  id: string;
  name: string;
  email: string;
  department?: string;
  updatedAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const MOCK_CLIENT_ID = "opensync-test";
export const MOCK_CLIENT_SECRET = "secret";
export const MOCK_HMAC_SECRET = "hmac-secret-key";
export const TOKEN_EXPIRES_IN = 3600; // seconds

// ─── MockErpServer ────────────────────────────────────────────────────────────

export class MockErpServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private employees = new Map<string, Employee>();
  /** etags[id] is the current ETag string for that employee */
  private etags = new Map<string, string>();
  /** Currently valid access token (null = none issued yet) */
  private currentToken: string | null = null;
  /** When the current token expires (epoch ms). Null means non-expiring for test control. */
  private tokenExpiresAt: number | null = null;
  /** Currently valid session token */
  private sessionToken: string | null = null;
  private port = 4002;

  get baseUrl(): string {
    return `http://localhost:${this.port}`;
  }

  start(port = 4002): void {
    this.port = port;
    const self = this;
    this.server = Bun.serve({
      port,
      fetch(req) {
        return self._handle(req);
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  seed(employees: Omit<Employee, "updatedAt">[]): void {
    for (const e of employees) {
      const emp: Employee = { ...e, updatedAt: new Date().toISOString() };
      this.employees.set(e.id, emp);
      this.etags.set(e.id, this._makeETag(emp));
    }
  }

  // ─── Router ────────────────────────────────────────────────────────────────

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
      const employees = this._employeesSince(since);
      return Response.json(employees);
    }

    // Bearer-authenticated endpoints
    const bearerErr = this._checkBearer(req);
    if (bearerErr) return bearerErr;

    if (method === "GET" && path === "/employees") {
      const since = url.searchParams.get("since");
      return Response.json(this._employeesSince(since));
    }

    const empMatch = path.match(/^\/employees\/([^/]+)$/);
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
      params.get("client_id") !== MOCK_CLIENT_ID ||
      params.get("client_secret") !== MOCK_CLIENT_SECRET
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

  // ─── HMAC-signed endpoint ─────────────────────────────────────────────────

  private async _handleSignedEmployees(req: Request): Promise<Response> {
    const body = await req.text();
    const sig = req.headers.get("x-signature");

    const expected = crypto
      .createHmac("sha256", MOCK_HMAC_SECRET)
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
