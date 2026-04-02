# CLI

The primary interface for developers. No UI — everything is a command.

## Commands

### opensync init

Create config directory and initialize the SQLite database.

```
$ opensync init
Created opensync.yaml
Created opensync.db
Ready. Add connectors with: opensync add-connector <name>
```

### opensync create-connector \<name\>

Scaffold a new connector project. Generates a working template that compiles and can be loaded by the engine immediately. Designed for both humans and AI agents.

```
$ opensync create-connector my-saas
Created connectors/my-saas/package.json
Created connectors/my-saas/src/index.ts          # template with all methods stubbed
Created connectors/my-saas/src/__tests__/index.test.ts
Done. Edit connectors/my-saas/src/index.ts to implement your connector.
```

The generated `index.ts` includes:
- `metadata` with placeholder values
- `getStreams()` returning one example stream
- `upsert()` with a TODO comment
- Typed imports from `@opensync/sdk`

An agent can take this template and fill in the real API logic in one shot.

### opensync add-connector \<name\>

Register a connector instance. Prompts for config interactively or accepts `--config <path>`.

```
$ opensync add-connector mock-crm --instance crm-prod --config ./crm-config.json
Connector 'mock-crm' registered as 'crm-prod'.
```

### opensync sync

Run a sync cycle. Processes all pending jobs or triggers a new poll.

```
$ opensync sync
Syncing channel "Contact Sync"...
  Fetched 15 records from crm-prod (3 new, 12 unchanged)
  Pushed 3 records to erp-prod (2 created, 1 updated)
Done. 3 processed, 0 conflicts, 0 errors.

$ opensync sync --channel "Contact Sync" --full
Running full sync (all records)...
  Fetched 1200 records from crm-prod
  Detected 3 deletions (soft-deleted in shadow state)
  Pushed 45 changes to erp-prod
Done.
```

### opensync status

Show current state of all channels, circuit breakers, and job queue.

```
$ opensync status
Channels:
  Contact Sync    OPERATIONAL    last sync: 2 min ago    queue: 0 pending
  Deal Sync       TRIPPED        reason: volume threshold exceeded (532 > 100)

Connectors:
  crm-prod        active    last sync: 2 min ago
  erp-prod        active    last sync: 2 min ago

Webhooks:
  crm-prod        last received: 30s ago    health: OK
  erp-prod        no webhooks configured
```

### opensync inspect \<entity-id\>

Show everything about a specific entity: identity links, shadow state, transaction history.

```
$ opensync inspect uuid-123
Entity: uuid-123 (contact)

Links:
  crm-prod    hs_contact_99
  erp-prod    fiken_customer_44

Shadow State (crm-prod):
  email    ola@test.no    (prev: old@test.no)    src: crm-prod    ts: 2026-04-01T10:00:00Z
  phone    99887766       (prev: null)            src: erp-prod    ts: 2026-04-01T10:05:00Z

Transaction History:
  2026-04-01 10:00  UPDATE  erp-prod  email: old@test.no → ola@test.no
  2026-04-01 09:30  CREATE  erp-prod  {fullName: "Ola Nordmann", ...}
```

### opensync match \<source\> \<target\> --entity \<type\>

Run the match engine for onboarding/discovery.

```
$ opensync match crm-prod erp-prod --entity contact
Fetching all contacts from crm-prod... 1000 records
Fetching all customers from erp-prod... 800 records

Match Results:
  600 exact matches (email)
  12 partial matches (name similarity > 85%) — review recommended
  200 unique in crm-prod
  50 unique in erp-prod

Run `opensync link crm-prod erp-prod --entity contact` to create identity links.
```

### opensync link \<source\> \<target\> --entity \<type\>

Create identity links from match results. Populates shadow state to prevent echo storm.

```
$ opensync link crm-prod erp-prod --entity contact
Linking 600 matched records...
Populating shadow state...
Done. 600 linked, 12 partial matches skipped (use --include-partial to link those too).
```

### opensync rollback \<batch-id\>

Undo all changes from a specific sync cycle.

```
$ opensync rollback batch-abc123
Rolling back 45 operations...
  42 reverted
  3 skipped (erp-prod cannot delete records)
Done.
```

### opensync rollback --full \<channel-id\>

Full rollback — remove all traces of the engine's involvement in a channel.

```
$ opensync rollback --full "Contact Sync"
WARNING: This will revert ALL changes ever made by this channel.
Continue? [y/N] y
Processing 1,240 operations...
  1,180 reverted
  60 skipped (target cannot delete)
Cleaning up identity links and shadow state...
Done.
```

## Packaging

### npm packages

- `@opensync/sdk` — published to npm, used by connector authors. Zero dependencies beyond zod.
- `@opensync/engine` — published to npm, includes CLI binary.

### CLI binary

The engine package has a `bin` field in `package.json`:
```json
{
  "bin": {
    "opensync": "./dist/cli/index.js"
  }
}
```

After `npm install @opensync/engine`, the `opensync` command is available.

### Running connectors

Connectors are loaded dynamically from a `connectors/` directory or from npm packages. The engine resolves them by name from the YAML config.

```yaml
# In opensync.yaml:
connectors:
  - name: hubspot          # looks for @opensync/connector-hubspot or ./connectors/hubspot/
    instance: hubspot-prod
```

Resolution order:
1. `./connectors/<name>/` (local directory)
2. `@opensync/connector-<name>` (npm package)
3. `<name>` (bare npm package name)
