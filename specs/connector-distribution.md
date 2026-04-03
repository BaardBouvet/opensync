# Connector Distribution

How connectors are packaged, published, and consumed across OpenSync installations.

---

## Package Format

A connector is a standard npm package with a single entry point that default-exports a `Connector` object.

### Naming Convention

| Scope | Package name pattern | Example |
|-------|---------------------|---------|
| Official (maintained by OpenSync) | `@opensync/connector-<name>` | `@opensync/connector-hubspot` |
| Community / third-party | `opensync-connector-<name>` | `opensync-connector-acme-erp` |
| Private / internal | any valid name | `@acme/opensync-crm` |

The engine does not care about the package name. The convention exists so connectors are discoverable on npm.

### Package structure

```
connector-hubspot/
├── package.json        # name, version, main, types, peerDependencies
├── dist/
│   ├── index.js        # compiled ESM entry point
│   ├── index.d.ts      # type declarations
│   └── bundle.js       # self-contained bundle for isolated execution
└── src/
    └── index.ts        # source (published for auditability)
```

### `package.json` requirements

```json
{
  "name": "@opensync/connector-hubspot",
  "version": "1.2.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "peerDependencies": {
    "@opensync/sdk": ">=0.1.0"
  },
  "opensync": {
    "bundle": "./dist/bundle.js"
  }
}
```

`@opensync/sdk` is a peer dependency — the engine owns the SDK version; the connector defers to it. This prevents two copies of the SDK in the same process with mismatched types.

The `opensync.bundle` field is optional but strongly recommended. When present, the engine uses the pre-built bundle for isolated execution rather than running a bundling step itself.

---

## Distribution Channels

### npm (public)

The primary distribution channel for official and community connectors.

```
$ npm publish --access public
```

Users install like any npm package:

```bash
npm install @opensync/connector-hubspot
```

### Private npm registry

Organizations with internal connectors use a private registry (Verdaccio, Artifactory, GitHub Packages).

```bash
npm install @acme/opensync-crm --registry https://npm.acme.com
```

`.npmrc` in the project handles scoped registry routing:

```ini
@acme:registry=https://npm.acme.com
```

### Git URL

For connectors still in development, or for pinning to a specific commit:

```bash
npm install github:acme/opensync-crm-connector#v1.2.0
```

### Local path

For connectors in a monorepo or during active development:

```json
{
  "dependencies": {
    "@acme/opensync-crm": "workspace:*"
  }
}
```

Or via `opensync.yaml`:

```yaml
connectors:
  - name: my-connector
    path: ./connectors/my-connector   # resolved relative to opensync.yaml
```

---

## Engine Resolution

When the engine encounters a connector reference in config, it resolves the implementation in this order:

```
1. path:   config entry has a `path` field → load from filesystem
2. local:  node_modules/<name>/dist/index.js exists → use installed package
3. remote: connector not found locally → error (never auto-installs at runtime)
```

**The engine never runs `npm install` at sync time.** Connectors must be installed before the engine starts. This prevents supply-chain substitution attacks and makes deployments reproducible.

### Loading the connector

The engine dynamically imports the package entry point and expects a default export of type `Connector`:

```typescript
const mod = await import(resolvedPath);
const connector: Connector = mod.default;

if (!connector.getEntities && !connector.getActions) {
  throw new Error(`Connector '${name}' exports neither getEntities nor getActions`);
}
```

---

## Config Reference

### Installed npm package

```yaml
connectors:
  - name: "@opensync/connector-hubspot"
    instance: hubspot-prod
    config:
      portalId: "12345"
```

The `name` field is the npm package name. The engine resolves it from `node_modules`.

### Local path

```yaml
connectors:
  - name: my-local-connector
    path: ./connectors/my-local-connector
    instance: local-dev
    config:
      apiKey: "${MY_API_KEY}"
```

`path` takes precedence over `name` resolution. Useful during development — no need to publish or symlink.

### Pinning a version

Version pinning is handled by `package.json`/`package-lock.json` (or `bun.lockb`), not by `opensync.yaml`. The config only names the connector; version selection is an install-time concern.

---

## Building and Publishing

### Build script

Every connector must have these npm scripts:

```json
{
  "scripts": {
    "build":  "tsc --build",
    "bundle": "esbuild src/index.ts --bundle --platform=browser --format=esm --outfile=dist/bundle.js --external:@opensync/sdk",
    "pub":    "npm run build && npm run bundle && npm publish"
  }
}
```

`bundle` externalizes `@opensync/sdk` — the engine provides the SDK at runtime; bundling it would produce two copies with incompatible object identities.

For connectors that use Node.js native libraries (Kafka, Postgres):

```bash
esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/bundle.js --external:@opensync/sdk
```

### CI workflow (GitHub Actions)

```yaml
# .github/workflows/publish.yml
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run build
      - run: bun run bundle
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

## Versioning

Connectors follow semver. The engine does not enforce version compatibility at load time — the TypeScript compiler and SDK peer dependency range serve as the compatibility contract.

| Change | Version bump |
|--------|-------------|
| New entity, new action | minor |
| Bug fix, internal change | patch |
| Removed entity / changed record shape | major |
| Changed required `config` fields | major |
| Added optional `config` field | minor |

Breaking changes in `config` are especially disruptive because they require updating `opensync.yaml`. Document them clearly in the changelog.

---

## Security Considerations

### Supply-chain

- Pin connector versions in `package-lock.json` / `bun.lockb`. Never use `latest` in production.
- For official connectors, verify the npm provenance attestation (`npm audit signatures`).
- Review `allowedHosts` in `ConnectorMetadata` before installation. A connector that declares `allowedHosts: ['*']` warrants scrutiny.

### Credential handling

- Connectors never have access to `process.env`. Secrets are injected by the engine via `ctx.config`.
- The engine masks values from `ctx.config` in the request journal automatically.
- A connector that accepts credentials as config fields (API keys, OAuth tokens) must not log them. Use `ctx.http` — it handles masking.

### Code review checklist for third-party connectors

Before adding an unfamiliar connector to a production deployment:

1. Check `allowedHosts` — does it only list the expected API domains?
2. Check `dependencies` — are there unexpected packages (e.g. `node:child_process` wrappers)?
3. Check `bundle` script — is `@opensync/sdk` externalized?
4. Audit the source (published `src/`) for direct `fetch()` calls that bypass `ctx.http`.
5. Confirm the npm package has provenance or is from a trusted publisher.

---

## Discovery

### opensync search (CLI)

```
$ opensync search crm
@opensync/connector-hubspot       1.4.2   HubSpot CRM — contacts, companies, deals
@opensync/connector-salesforce    2.1.0   Salesforce — accounts, contacts, opportunities
opensync-connector-pipedrive      0.9.1   Pipedrive — persons, organizations, deals (community)
```

`opensync search` queries the npm registry with the `opensync-connector` keyword. Connectors are discoverable if they include `"opensync-connector"` in their `keywords` array.

### `package.json` keywords

```json
{
  "keywords": ["opensync-connector", "crm", "hubspot", "contacts"]
}
```

---

## Monorepo Connectors

Organizations maintaining many connectors in one repo use npm workspaces (or Bun workspaces):

```
/company-integrations
├── package.json              # workspace root
├── connectors/
│   ├── acme-crm/
│   │   ├── package.json      # @acme/opensync-crm
│   │   └── src/index.ts
│   └── acme-erp/
│       ├── package.json      # @acme/opensync-erp
│       └── src/index.ts
└── opensync.yaml
```

```json
{
  "workspaces": ["connectors/*"]
}
```

```yaml
# opensync.yaml — references workspace packages directly
connectors:
  - name: "@acme/opensync-crm"
    instance: crm-prod
    config:
      baseUrl: "${CRM_BASE_URL}"
  - name: "@acme/opensync-erp"
    instance: erp-prod
    config:
      baseUrl: "${ERP_BASE_URL}"
```

Workspace resolution means no publishing step is needed during development. Run `bun install` once from the root and all connectors are available to the engine.

---

## Relationship to Other Specs

- **connector-sdk.md** — the `Connector` interface a package must implement
- **connector-isolation.md** — bundling requirements, `allowedHosts`, the future worker model
- **cli.md** — `opensync create-connector`, `opensync add-connector`, `opensync search`
- **config.md** — full `connectors:` config block schema
