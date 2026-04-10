# Engine API Ergonomics for Embedded Use

**Status:** draft  
**Date:** 2026-04-07  
**Effort:** M  
**Domain:** Engine API  
**Scope:** `packages/engine/src/`, `specs/sync-engine.md`, `specs/observability.md`  
**Depends on:** `plans/engine/PLAN_ENGINE_USABILITY.md` (superseded — §§ 4b.1–4b.2 absorbed here)

---

## § 1 Problem Statement

`SyncEngine` is designed to be embedded in a JavaScript application.  The current
`ResolvedConfig` type surface makes a simple two-connector hello-world more
verbose than necessary, and has several rough edges observed by callers building on
top of the engine:

1. **`batchIdRef` and `triggerRef` are required on `ConnectorInstance`** — two
   mutable boxes the engine writes to internally for request-journal correlation.
   Callers must supply them as `{ current: undefined }` at construction and must
   never touch them again.  They are implementation detail that leaks into the public
   type.

2. **`auth: {}` required even for `auth.type: 'none'` connectors** — callers are
   forced to pass an empty object even when the connector declares it needs no auth.

3. **`conflict` is engine-wide, not per-channel** — there is no way to configure
   different conflict strategies for different channels.  Every channel shares the
   same `ConflictConfig` even when the use case demands otherwise.

4. **`readTimeoutMs` has no per-call override** — the only way to give one
   connector a longer timeout is to change the global value, affecting all
   connectors in the same poll loop.

5. **No `bootChannel()` high-level helper** — the three-step
   `ingest→discover→onboard` sequence must be assembled manually.
   `PLAN_ENGINE_USABILITY.md § 1` documents this gap; it is relevant here because
   fixing `ResolvedConfig` noise makes the hello-world smaller only if boot is also
   simpler.

6. **No engine-level `SyncEvent` callback** — `PLAN_ENGINE_SYNC_EVENTS.md`
   extended `RecordSyncResult` with payload fields (`sourceData`, `sourceShadow`,
   `before`, `after`).  It did _not_ add a shared `SyncEvent` type or a way to
   register a listener on the engine.  As a result:
   - The playground defines its own `SyncEvent` type and `emitEvents()` function.
   - The demo CLI re-derives the same projection ad hoc from raw `RecordSyncResult`
     fields.
   - Every embedded caller who wants to react to sync activity must either iterate
     `IngestResult.records` themselves or copy the playground's `emitEvents()`
     glue.
   The correct model is a push callback registered on the engine.  Callers who do
   not care about events do not register one and see no overhead.

---

## § 2 Proposed Changes

### § 2.1 Optional `batchIdRef`, `triggerRef`, and `auth` on `ConnectorInstance`

Make the three fields optional in the `ConnectorInstance` type.  The engine fills
in the defaults at construction time when absent:

```typescript
interface ConnectorInstance {
  id:          string;
  connector:   Connector;
  config:      Record<string, unknown>;
  auth?:       Record<string, unknown>;              // defaults to {}
  batchIdRef?: { current: string | undefined };      // defaults to { current: undefined }
  triggerRef?: { current: string | undefined };      // defaults to { current: undefined }
}
```

No factory function is needed.  A minimal connector declaration shrinks to:

```typescript
{ id: 'my-system', connector: mySystemConnector, config: { apiUrl: 'https://api.example.com' } }
```

Callers who previously built the config object via `loadConfig()` are unaffected —
the loader already supplies all fields.  Test fixtures supply them explicitly and
continue to work unchanged.

### § 2.2 Optional `conflict` and `readTimeoutMs` on `ResolvedConfig`

Both fields become optional with defaults applied at `SyncEngine` construction:

```typescript
interface ResolvedConfig {
  connectors:     ConnectorInstance[];
  channels:       ChannelConfig[];
  conflict?:      ConflictConfig;   // default: { strategy: 'lww' }
  readTimeoutMs?: number;           // default: 30_000
}
```

`readTimeoutMs` is kept here for the `loadConfig()` / CLI path, where the
timeout is set once in `opensync.json` and applies to all connectors.  In the
embedded path callers that want per-call control use the `timeoutMs` opt on
`ingest()` instead — see § 2.4.

No behaviour change when either field is supplied.

### § 2.3 Per-channel `conflict` override

Add an optional `conflict` field to `ChannelConfig`:

```typescript
interface ChannelConfig {
  id:               string;
  members:          ChannelMember[];
  identityFields?:  string[];
  identityGroups?:  IdentityGroup[];
  conflict?:        ConflictConfig;   // overrides ResolvedConfig.conflict for this channel
}
```

The engine looks up `channel.conflict ?? engineConfig.conflict ?? { strategy: 'lww' }`
before calling `resolveConflicts()` for any record in that channel.

### § 2.4 `timeoutMs` option on `ingest()`

Add `timeoutMs?` to the `ingest()` opts object:

```typescript
engine.ingest(
  channelId: string,
  connectorId: string,
  opts?: { collectOnly?: boolean; fullSync?: boolean; timeoutMs?: number },
): Promise<IngestResult>
```

The engine uses `opts.timeoutMs ?? config.readTimeoutMs ?? 30_000` for the
`Promise.race` in that call.  Different connectors in a poll loop can receive
different timeouts at the call site without any config change:

```typescript
await engine.ingest(ch.id, 'slow-connector', { timeoutMs: 120_000 });
await engine.ingest(ch.id, 'fast-connector', { timeoutMs: 5_000 });
```

### § 2.5 `bootChannel()` high-level method

Documented in `PLAN_ENGINE_USABILITY.md § 1.2`.  Summarised here for reference:

```typescript
// Encapsulates: collect × N → discover → onboard
// Returns OnboardResult for logging; no-ops if channel status !== 'uninitialized'.
engine.bootChannel(channel: ChannelConfig): Promise<OnboardResult>
```

Boot sequence collapses to:

```typescript
for (const ch of config.channels) {
  await engine.bootChannel(ch);
}
```

### § 2.6 Engine-level `SyncEvent` callback

Add an optional `onEvent` callback to the `SyncEngine` constructor options.  The
engine calls it after each non-skip result, both during normal `ingest()` and
during `bootChannel()` (onboarding fanout inserts).

```typescript
// Constructor gains an optional third argument
new SyncEngine(config: ResolvedConfig, db: Db, opts?: SyncEngineOptions)

interface SyncEngineOptions {
  webhookBaseUrl?: string;
  onEvent?: (event: SyncEvent) => void;
}
```

The `SyncEvent` type is exported from `@opensync/engine`:

```typescript
export interface SyncEvent {
  phase:           'onboard' | 'poll' | 'webhook';
  channel:         string;
  sourceConnector: string;
  targetConnector: string;
  entity:          string;
  action:          'read' | 'insert' | 'update' | 'defer' | 'error';
  sourceId:        string;
  targetId:        string;
  // Field payloads — mirrors RecordSyncResult
  data?:                     Record<string, unknown>;
  before?:                   Record<string, unknown>;
  after?:                    Record<string, unknown>;
  sourceAssociations?:       Association[];
  sourceShadowAssociations?: Association[];
  beforeAssociations?:       Association[];
  afterAssociations?:        Association[];
}
```

The engine constructs a `SyncEvent` from each `RecordSyncResult` internally —
callers never see `RecordSyncResult` unless they specifically want the lower-level
type (which remains exported).  The playground and demo CLI delete their own
bespoke projections and switch to the engine-constructed events.

Callers that do not register `onEvent` see no change in behaviour.

### § 2.7 `pollChannel()` high-level method

Mirrors `bootChannel()` at poll time.  Hides the member-iteration loop and
error-isolation boilerplate that every caller currently writes themselves:

```typescript
// Calls ingest() for every channel member in series.
// Catches per-member errors and surfaces them via onEvent({ action: 'error', ... })
// rather than letting one failing member abort the rest.
// Returns the flat list of all RecordSyncResult entries across all members.
engine.pollChannel(channel: ChannelConfig, opts?: { timeoutMs?: number }): Promise<RecordSyncResult[]>
```

The current poll loop:

```typescript
for (const ch of config.channels) {
  for (const m of ch.members) {
    try { await engine.ingest(ch.id, m.connectorId); }
    catch (err) { console.error(`[error] ${m.connectorId}:`, err); }
  }
}
```

becomes:

```typescript
for (const ch of config.channels) {
  await engine.pollChannel(ch);
}
```

The finer-grained `ingest(channelId, connectorId, opts?)` call remains available
for callers that need per-member control (different timeouts, selective members,
manual ordering).  The routing abstraction question — whether `ingest()` should
address a `(connectorId, entity)` pair instead of a `(channelId, connectorId)`
pair — is tracked separately and does not block this change.

### § 2.8 `start()` / `stop()` autonomous mode

For callers who want fire-and-forget operation, add `start()` and `stop()` to
`SyncEngine`.  `start()` boots all channels then runs the poll loop at a
configured interval until `stop()` is called:

```typescript
interface SyncEngineOptions {
  webhookBaseUrl?: string;
  onEvent?:        (event: SyncEvent) => void;
  pollIntervalMs?: number;   // default: 30_000; used only by start()
}

engine.start(): void   // boots all channels, then polls on interval
engine.stop():  void   // stops the interval; in-flight ingest() calls complete normally
```

`pollIntervalMs` belongs in `SyncEngineOptions` rather than `ResolvedConfig`
because it is a runtime concern, not a data-topology concern.  `opensync.json`
does not need a field for it — the CLI / demo set it at startup.

The simplest possible embedding becomes:

```typescript
const engine = new SyncEngine(config, db, { onEvent: ev => { if (ev.action === 'error') console.error(ev); } });
engine.start();
process.on('SIGINT', () => { engine.stop(); db.close(); });
```

`bootChannel()` and `pollChannel()` remain available for callers that need
manual control over the lifecycle (tests, batch jobs, selective polling).

---

## § 3 Hello-world Target

After these changes, three levels of embedding are possible:

**Level 1 — autonomous (fire-and-forget):**

```typescript
import { SyncEngine, openDb } from '@opensync/engine';
import myConnector    from './my-connector.js';
import otherConnector from './other-connector.js';

const engine = new SyncEngine(
  {
    connectors: [
      { id: 'my-system',    connector: myConnector,    config: { apiUrl: 'https://api.example.com' } },
      { id: 'other-system', connector: otherConnector, config: { apiUrl: 'https://api.other.com' } },
    ],
    channels: [{
      id: 'contacts',
      members: [
        { connectorId: 'my-system',    entity: 'contact' },
        { connectorId: 'other-system', entity: 'contact' },
      ],
      identityFields: ['email'],
    }],
  },
  openDb('sync-state.db'),
  { onEvent: ev => { if (ev.action === 'error') console.error('[sync error]', ev); } },
);

engine.start();
process.on('SIGINT', () => { engine.stop(); });
```

**Level 2 — controlled poll loop:**

```typescript
for (const ch of config.channels) await engine.bootChannel(ch);

const poll = () => Promise.all(config.channels.map(ch => engine.pollChannel(ch)));
setInterval(poll, 30_000);
await poll();
```

**Level 3 — per-member control** (tests, selective polling, custom timeouts):

```typescript
await engine.ingest('contacts', 'slow-connector', { timeoutMs: 120_000 });
await engine.ingest('contacts', 'fast-connector', { timeoutMs: 5_000 });
```

Callers that want to react to inserts/updates register a more detailed `onEvent`;
callers that only care about errors register only an error path; callers that just
want data to flow register nothing.

---

## § 4 Out of Scope

- Per-entity `timeoutMs` — per-call is already fine-grained enough.
- `field_master` conflict config ergonomics — the `fieldMasters` map is already
  usable; simplifying or visualising field ownership is a separate concern.
- Async/push event bus (Observables, EventEmitter, etc.) — a synchronous callback
  called inline after each ingest result covers the observation need.  A fully
  decoupled async bus is a future addition if needed.

---

## § 4b Additional Gaps (absorbed from PLAN_ENGINE_USABILITY.md)

The following two items were catalogued in the usability gap analysis and are not covered
by §§ 2.1–2.8 above.

### § 4b.1 Global fan-out guard

#### § 4b.1.1 Problem

`_processRecords()` builds the `crossLinked` set by querying ALL canonicals in
`identity_map`, not just those belonging to the current channel:

```sql
SELECT DISTINCT connector_id FROM identity_map
WHERE canonical_id IN (
  SELECT canonical_id FROM identity_map
  GROUP BY canonical_id HAVING COUNT(DISTINCT connector_id) > 1)
```

In a multi-channel setup, once **any** channel has cross-linked records, all connectors
become "cross-linked in the global map", even for channels that have no linked records yet.
This can cause premature fan-out before a channel is properly onboarded.

#### § 4b.1.2 Proposed fix

Scope the `crossLinked` query to the current channel's entity/connector pairs, matching
the pattern already used by `channelStatus()`.  No public API change — internal only.

Add `specs/sync-engine.md` note: the fan-out guard is channel-scoped.

---

### § 4b.2 Implicit channel ordering dependency

#### § 4b.2.1 Problem

When two channels share connectors (e.g. `companies` and `contacts` both use crm/erp/hr),
onboarding order matters: `contacts` with company associations must be onboarded **after**
`companies` so `_remapAssociations()` can resolve identity links. Nothing enforces or
communicates this — wrong YAML order causes deferred associations and one extra poll cycle.

#### § 4b.2.2 Proposed fix

Either:

a. **Topological sort** — detect association entity dependencies at onboarding time and
   auto-sort channels before the boot loop. Safest for callers; requires the engine to
   inspect each channel's `identityFields` / `identityGroups` for cross-channel entity
   references.
b. **Config validation** — surface ordering violations as a startup error with a clear
   message, e.g. `"Channel 'contacts' references entity 'companies' but 'companies' channel
   is listed after 'contacts' in config"`.

Option (a) is preferred; option (b) is an acceptable interim if (a) proves complex.
`bootChannel()` (§ 2.5) must honour the sorted order when called via `start()`.

---

## § 5 Spec Changes Planned

| Spec file | Section(s) to add or modify |
|-----------|---------------------------|
| `specs/sync-engine.md` | § Setup — mark `auth`, `batchIdRef`, `triggerRef` optional on `ConnectorInstance`; mark `conflict` and `readTimeoutMs` optional on `ResolvedConfig` |
| `specs/sync-engine.md` | § Setup — add `conflict?` to `ChannelConfig`; document channel-level override semantics |
| `specs/sync-engine.md` | § Public API — add `timeoutMs?` to `ingest()` opts; add `pollChannel()`, `bootChannel()`, `start()`, `stop()`; update `SyncEngine` constructor signature with `SyncEngineOptions` (including `pollIntervalMs`) |
| `specs/sync-engine.md` | § Ingest Loop — document that `crossLinked` query is scoped to current channel's entity/connector pairs |
| `specs/observability.md` | New section: § SyncEvent — define the `SyncEvent` type, the `onEvent` callback, `phase` field semantics, and mapping to `RecordSyncResult`; document that the playground and demo CLI use this |
