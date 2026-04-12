# CLI

The primary interface for developers. No UI — everything is a command.

> **Distribution status:** the `opensync` binary is not yet packaged or distributed. The
> commands below document the intended interface. The engine API (`SyncEngine` class and
> `loadConfig` from `@opensync/engine`) is the current programmatic entry point. See
> [specs/overview.md](overview.md) for the data flow.

## One binary, two modes

There is a single `opensync` binary. It does not require a running daemon for most operations.
SQLite is the shared state layer — commands like `status` and `inspect` open the database
directly, the same way `git log` reads `.git/` without needing a git server.

`opensync run` starts the polling loop. Everything else can run independently of it.

---

## Commands

### opensync init

Scaffold a new project in the current directory.

```
$ opensync init
Created openlink.json
Created mappings/channels.yaml
Ready. Edit openlink.json to add your connectors.
```

### opensync create-connector \<name\>

Scaffold a new connector plugin. Generates a complete, compilable TypeScript project that can be
loaded by the engine immediately. Designed for both humans and AI agents.

```
$ opensync create-connector my-saas
Created connectors/my-saas/package.json
Created connectors/my-saas/src/index.ts
Created connectors/my-saas/src/index.test.ts
Done. Edit connectors/my-saas/src/index.ts to implement your connector.
```

The generated `index.ts` includes `metadata`, stubbed `getEntities()`, and typed imports from
`@opensync/sdk`. An agent can fill in the real API logic from this template in one shot.

Registering the connector is just adding an entry to `openlink.json` — no separate command needed.

### opensync run

Start the polling loop. Reads `openlink.json` + `mappings/` from the project root, loads plugins,
and polls all channels in a continuous loop.

```
$ opensync run
Root: /my-project
Loading 2 connector plugin(s)…
============================================================
  OpenSync — polling every 2000ms  |  Stop with Ctrl+C
  Channels: contacts [hubspot, fiken]  |  orders [hubspot, fiken]
  Pairs: 4 directed
============================================================

  [10:00:01] hubspot→fiken [contacts]  INSERT  contacts  a1b2c3d4… → ?…
  [10:00:01] hubspot→fiken [contacts]  INSERT  contacts  e5f6a7b8… → ?…
```

```
# Explicit project root
$ opensync run --root /path/to/my-project

# One-shot: run one full cycle then exit
$ opensync run --once
```

The engine writes to `data/state.json` (or SQLite in the real engine) on every cycle. This is the
shared state read by all other commands.

### opensync sync

Trigger one sync cycle without starting the poll loop. Useful in CI or cron jobs.

```
$ opensync sync
Syncing all channels…
  contacts  hubspot→fiken  INSERT 3  UPDATE 1
  orders    hubspot→fiken  (no changes)
Done.

$ opensync sync --channel contacts
$ opensync sync --channel contacts --full    # ignore watermarks, re-sync everything
```

### opensync status

Show the current state of all channels and connectors. Reads state directly from the database —
the daemon does not need to be running.

```
$ opensync status
Channels:
  contacts    CLOSED    last sync: 2 min ago    queue: 0 pending
  orders      OPEN      reason: error rate 62% > 50% threshold

Connectors:
  hubspot     active    last sync: 2 min ago
  fiken       active    last sync: 2 min ago
```

### opensync inspect \<entity-id\>

Show everything about a specific entity: identity links, shadow state, transaction history.
Reads directly from the database.

```
$ opensync inspect uuid-123
Entity: uuid-123 (contacts)

Links:
  hubspot    hs_contact_99
  fiken      fiken_customer_44

Shadow State:
  customerName    Ola Nordmann    src: hubspot    ts: 2026-04-01T10:00:00Z
  email           ola@test.no     src: fiken      ts: 2026-04-01T10:05:00Z

Transaction History:
  2026-04-01 10:05  UPDATE  fiken    email: old@test.no → ola@test.no
  2026-04-01 09:30  INSERT  hubspot  {customerName: "Ola Nordmann", …}
```

### opensync match \<source\> \<target\> --entity \<type\>

Run the match engine for onboarding — find records that exist in both systems but haven't been
linked yet.

```
$ opensync match hubspot fiken --entity contacts
Fetching contacts from hubspot… 1000 records
Fetching customers from fiken… 800 records

  600 exact matches (email)
   12 partial matches (name similarity > 85%) — review recommended
  200 unique in hubspot
   50 unique in fiken

Run `opensync link hubspot fiken --entity contacts` to create identity links.
```

### opensync link \<source\> \<target\> --entity \<type\>

Create identity links from match results. Populates shadow state to prevent an echo storm on the
next sync.

```
$ opensync link hubspot fiken --entity contacts
Linking 600 matched records…
Populating shadow state…
Done. 600 linked, 12 partial matches skipped (use --include-partial to link those too).
```

### opensync rollback \<batch-id\>

Undo all writes from a specific sync cycle.

```
$ opensync rollback batch-abc123
Rolling back 45 operations…
  42 reverted
   3 skipped (fiken cannot delete records)
Done.
```

### opensync rollback --full \<channel-id\>

Full rollback — remove all traces of the engine's involvement in a channel.

```
$ opensync rollback --full contacts
WARNING: This will revert ALL changes ever made by this channel.
Continue? [y/N] y
Processing 1,240 operations…
  1,180 reverted
     60 skipped (target cannot delete)
Cleaning up identity links and shadow state…
Done.
```

---

## Packaging

- `@opensync/sdk` — published to npm, used by connector authors. Zero runtime dependencies.
- `@opensync/engine` — published to npm, includes the `opensync` CLI binary.

```json
{
  "bin": {
    "opensync": "./dist/cli/index.js"
  }
}
```

Install globally or use via `npx`:

```
npm install -g @opensync/engine
opensync init
```
