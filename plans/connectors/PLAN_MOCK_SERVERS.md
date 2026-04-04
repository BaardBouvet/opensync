# PLAN — Mock System Servers

> Status: done
> Relevant milestone: Milestone 1 (connector tests), Milestone 2 (integration tests)

---

## Problem

The `mock-crm` and `mock-erp` connectors exist in `connectors/` but the HTTP services
they connect to only exist as in-process test helpers buried inside the POC directories:

| Server class | Current location | Used by |
|---|---|---|
| `MockCrmServer` | `poc/v5/mock-crm-server.ts` | `poc/v5/`, `poc/v6/` tests |
| `MockErpServer` | `poc/v6/mock-erp-server.ts` | `poc/v6/` tests |

Consequences:
- `connectors/mock-crm` and `connectors/mock-erp` have no test files — they cannot be
  tested without importing from the POC directory, which breaks package isolation.
- Milestone 2 integration tests need both services running as real HTTP endpoints.
- The POC servers cannot be versioned or published independently.

---

## Goal

Extract each mock server into a standalone package under a new top-level `servers/`
directory. Each package:

1. Exports a class (`MockCrmServer`, `MockErpServer`) for programmatic start/stop in tests.
2. Provides a `main.ts` entrypoint so the server can be started as a long-running process.
3. Is configured entirely by environment variables — no hard-coded ports or secrets.
4. Has its own `package.json` and `tsconfig.json` under the workspace monorepo.

The connector packages then depend on their respective server package in `devDependencies`
and use it in their test files.

---

## Proposed layout

```
servers/
  mock-crm/
    package.json          (@opensync/server-mock-crm, private: true)
    tsconfig.json
    src/
      server.ts           — MockCrmServer class (extracted + cleaned up from poc/v5)
      main.ts             — process entrypoint (reads env vars, starts server)
  mock-erp/
    package.json          (@opensync/server-mock-erp, private: true)
    tsconfig.json
    src/
      server.ts           — MockErpServer class (extracted + cleaned up from poc/v6)
      main.ts             — process entrypoint (reads env vars, starts server)
connectors/
  mock-crm/
    src/
      index.ts            — unchanged connector
      index.test.ts       — NEW: imports MockCrmServer from @opensync/server-mock-crm
  mock-erp/
    src/
      index.ts            — unchanged connector
      index.test.ts       — NEW: imports MockErpServer from @opensync/server-mock-erp
```

---

## Mock CRM server contract

Derived from `poc/v5/mock-crm-server.ts`. The extracted server preserves all existing
behaviour and adds env-var configuration.

**Endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/contacts` | Bearer | List contacts; accepts `?since=<iso>` |
| `POST` | `/contacts` | Bearer | Create a contact |
| `PUT` | `/contacts/:id` | Bearer | Update a contact |
| `GET` | `/contacts/:id` | Bearer | Fetch a single contact |
| `POST` | `/webhooks/subscribe` | Bearer | Register webhook URL; returns `{ subscriptionId }` |
| `DELETE` | `/webhooks/:id` | Bearer | Deregister webhook |
| `POST` | `/__trigger` | none | Test helper: fire webhook to all subscribers |
| `POST` | `/__reset` | none | Test helper: clear all state |

**Auth**: `Authorization: Bearer <API_KEY>` — key configurable via `MOCK_CRM_API_KEY`
(default: `test-api-key-secret` for local dev convenience).

**Environment variables**

| Variable | Default | Purpose |
|---|---|---|
| `MOCK_CRM_PORT` | `4001` | Listening port |
| `MOCK_CRM_API_KEY` | `test-api-key-secret` | Bearer token to accept |

---

## Mock ERP server contract

Derived from `poc/v6/mock-erp-server.ts`. Preserves the three auth patterns (OAuth2,
session token, HMAC) that the connector tests exercise.

**Endpoints**

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/oauth/token` | client credentials | Issue access token |
| `GET` | `/employees` | Bearer | List employees; accepts `?since=<iso>` |
| `GET` | `/employees/:id` | Bearer | Fetch employee; returns `ETag` |
| `POST` | `/employees` | Bearer | Create employee |
| `PUT` | `/employees/:id` | Bearer + `If-Match` | Update employee; returns `412` on mismatch |
| `POST` | `/session/login` | none | Issue session token |
| `GET` | `/employees/legacy` | `X-Session` | Legacy session-auth read |
| `POST` | `/signed/employees` | `X-Signature` HMAC | HMAC-signed write |
| `POST` | `/__expire-token` | none | Test helper: expire current OAuth token |
| `POST` | `/__invalidate-session` | none | Test helper: clear session |
| `POST` | `/__mutate-employee/:id` | none | Test helper: out-of-band mutation (advances ETag) |
| `POST` | `/__reset` | none | Test helper: clear all state |

**Environment variables**

| Variable | Default | Purpose |
|---|---|---|
| `MOCK_ERP_PORT` | `4002` | Listening port |
| `MOCK_ERP_CLIENT_ID` | `opensync-test` | OAuth2 client ID |
| `MOCK_ERP_CLIENT_SECRET` | `secret` | OAuth2 client secret |
| `MOCK_ERP_HMAC_SECRET` | `hmac-secret-key` | HMAC signing key |

---

## Connector test coverage

Each connector test file (`index.test.ts`) must cover, at minimum:

**mock-crm**
- `read()` returns all contacts when no watermark is given
- `read()` returns only contacts updated after `since`
- `insert()` creates a contact and returns the assigned ID
- `update()` modifies an existing contact
- `onEnable()` registers a webhook; `onDisable()` removes it
- `handleWebhook()` thick mode: returns records from payload without extra HTTP call
- `handleWebhook()` thin mode: fetches full record via `ctx.http`

**mock-erp (default / OAuth2 connector)**
- `read()` returns all employees on first call
- `read()` honours `since` watermark
- `lookup()` returns an employee with its current `ETag` as `version`
- `insert()` creates an employee
- `update()` succeeds when `If-Match` matches; returns error when stale

---

## Migration notes

- The POC server files (`poc/v5/mock-crm-server.ts`, `poc/v6/mock-erp-server.ts`) are
  **not deleted** — they remain as historical artefacts. The new server packages are
  de-duplicated copies, not renames.
- The POC test files (`poc/v5/engine.test.ts`, `poc/v6/engine.test.ts`) continue to
  import from their local paths; they are not touched by this plan.
- The server packages use `Bun.serve()` (global, not a `bun:*` import), consistent with
  the rest of the test infrastructure. The restriction in `AGENTS.md §3` applies only to
  `bun:*` namespace imports.

---

## Acceptance criteria

- [ ] `servers/mock-crm/` package exists; `bun run servers/mock-crm/src/main.ts` starts a
      server that accepts HTTP requests on `MOCK_CRM_PORT`
- [ ] `servers/mock-erp/` package exists; `bun run servers/mock-erp/src/main.ts` starts a
      server that accepts HTTP requests on `MOCK_ERP_PORT`
- [ ] `connectors/mock-crm/src/index.test.ts` exists and passes with `bun test`
- [ ] `connectors/mock-erp/src/index.test.ts` exists and passes with `bun test`
- [ ] `bun run tsc --noEmit` passes across all packages
- [ ] No import of POC paths from any file outside `poc/`
