# Gap Report: POC Series — Lessons Learned & Open Gaps (v0–v9)

> **Status:** reference
> **Date:** 2026-04-04

Combined lessons from all POC phases. Each section identifies what worked and what did
not. Items marked **[OPEN GAP]** are unresolved and tracked in
`plans/poc/PLAN_CLOSE_POC_GAPS.md`.

**Design plans:** `plans/poc/PLAN_POCS.md`
**Gap closure plan:** `plans/poc/PLAN_CLOSE_POC_GAPS.md`
**Source files:** `poc/vN/LESSONS.md` (v0–v9)

---


---

# v0 Lessons Learned

## What v0 was

Minimal bidirectional sync between two JSON-file connector instances (A and B).
Proved the core loop: read → identity map → insert/update, with watermarks for
incremental reads and an echo-prevention set to suppress bounce-backs.

## What worked

### The 4-step test scenario as a narrative
Building tests that tell a linear story (insert → associate → update source →
update target) caught real bugs and served as a living specification. Every
subsequent version kept this pattern.

### jsonfiles connector as a test fixture
Using real file I/O rather than mocks meant the connector's actual behaviour
(watermark comparison, patch-on-update, association serialisation) was exercised
from the start. Problems that would have been hidden by mocks surfaced early.

### Echo prevention via a per-instance set
Recording written IDs and skipping them on the next read from the same instance
prevented infinite A→B→A→... loops without needing any diffing logic.

## What broke down

### Pairwise identity map does not scale to N systems
`identityMap[entity]["A:id"] = "B-id"` is a flat key-value store. With two
systems it works. With three it becomes ambiguous: `"A:id"` can only map to one
value, so you cannot store both the B-side and C-side ID for the same source
record. This was the main reason v1 was needed.

### Echo set was not directional enough
The echo set was keyed by target instance only (`echoes["B"] = Set<id>`). This
meant that writes from A to B and writes from C to B shared the same echo bucket.
In a 3-system setup, suppressing a record written from A to B would incorrectly
also suppress a legitimate write from C to B. Fixed in v1 by keying echoes as
`echoes[target][source]`.

### Watermark key did not include the target
Watermarks were keyed `"A:customers"` rather than `"A→B:customers"`. When the
same source feeds multiple targets, each target should advance its own cursor
independently. A single shared watermark causes under-reads on one target when
the other runs first. Fixed in v1.

### State was lost between runs
The identity map was in-memory with optional JSON persistence. Restarting without
deleting data caused re-inserts of every existing record. A persistent store is
needed for production use.


---

# v1 Lessons Learned

## What v1 was

Fixed the N-system identity map problem from v0. Introduced a canonical UUID per
logical record shared across all connectors, replacing the flat pairwise map.
Extended the scenario to three connector instances (A, B, C) to validate that
N-way sync works without hardcoding pairs.

## What worked

### Canonical UUID identity map
`canonical[entity][canonicalId][connectorId] = recordId` scales correctly to any
number of connectors. Adding a third instance requires no changes to the map
structure. The `externalToCanonical` reverse index keeps lookups O(1).

### Directional echo prevention
Keying echoes as `echoes[target][source]` means A-written records in B are only
suppressed when reading B back to A — not when reading B to C. This is the
correct behaviour for cascade propagation (A change reaches C via B in the same
cycle without being blocked).

### Per-directed-pair watermarks
Keying watermarks `"A→B:customers"` rather than `"A:customers"` allows the same
source to feed multiple targets independently. Each target advances its own cursor
without interfering with sibling passes.

### State serialisation (toJSON/fromJSON)
Externalising engine state as a plain JSON-serialisable object kept the in-memory
engine simple while enabling persistence. The pattern carries forward unchanged
into v2.

## What broke down

### Hardcoded topology in run.ts
Which connectors exist, which entities are connected, and which sync pairs to run
were all written directly into `run.ts`. Adding a new connector meant editing the
runner. There was no way to express the topology declaratively. Addressed in v2.

### No field mapping
All field names passed through unchanged. Real integrations always involve name
mismatches (`name` vs `customerName` vs `fullName`). Without a mapping layer the
POC couldn't model any realistic scenario. Addressed in v2.

### Entity matching was implicit (by name)
The engine matched entities across connectors by comparing `entity.name`. This
assumed all connectors used the same name for the same concept. Addressed in v2
by explicit `entity` per channel member.

### Echo consumption required running all reverse passes
After each write pass, the reverse pass must be run in the same cycle to consume
the echo entries before they accumulate. This was not obvious from the API. The
v1 tests initially ran only forward passes and then had flaky failures in later
steps. The fix (run all directed pairs every cycle) is now documented as a
requirement in v2.

### Tests used `engine.sync(from, to)` tightly coupled to ConnectedSystem
The `sync` method took two `ConnectedSystem` objects, mixing topology (which
connectors) with the engine call. Moving topology into config (v2) required
changing the signature to `sync(channelId, fromId, toId)`.


---

# v2 Lessons Learned

## What v2 was

Introduced declarative configuration (`EngineConfig`) and a canonical field
mapping model. Topology (which connectors, which entities, which pairs to sync)
moved out of `run.ts` into a config object. Each channel member declares
`inbound` and `outbound` rename maps; the engine routes all data through an
ephemeral canonical representation.

## What worked

### Canonical field model scales linearly with N connectors
Each member only needs to know the canonical field names, not the field names of
every other connector. Adding a fourth connector requires one new `ChannelMember`
entry, not N new directed-pair mappings. The alternative (per-pair mappings) would
have scaled as N×(N-1).

### Canonical form is ephemeral — no central store needed
The canonical record exists only in memory during a single sync pass. Each
connector keeps its own data in its own format. The identity map and watermarks
from v1 are the only persistent engine state needed. This avoids a central
database while still enabling consistent N-way sync.

### Patch semantics make field ownership safe
Sending only the fields that were present in the source read — and having the
connector merge them into the existing record — means connectors can own disjoint
field sets on the same logical record without overwriting each other. The
jsonfiles connector already did this (spread existing first, incoming on top).
This turned out to be a load-bearing contract, not an implementation detail.

### applyRename as a pure function
Isolating the rename step as a pure function (`applyRename(data, map)`) made it
trivially testable in isolation before wiring it into the engine. Six unit tests
caught edge cases (empty map, undefined map, no mutation) before the integration
tests ran.

### sync(channelId, fromId, toId) is a cleaner API
Explicitly naming the channel and connector IDs rather than passing object
references makes it obvious what is being synced and why. The test setup became
more readable, and the poll loop in `run.ts` is a simple list of `[channel, from, to]`
tuples rather than nested object references.

## What broke down

### Echo consumption still requires running all passes every cycle
This was inherited from v1 and not resolved in v2. After A→B inserts a record,
the echo entry for B is only consumed when the B→A pass runs. If the test (or
caller) skips the reverse pass, the echo persists and suppresses a genuine update
from B on the next cycle. The fix — always run all directed pairs each cycle — is
correct but not enforced by the API. A future version could auto-consume echoes
that are older than one cycle.

### No conflict resolution
When two connectors update the same canonical field in the same cycle, the last
write wins — whichever sync pass runs second overwrites the first. This is
acceptable for the POC but not for production. Proper conflict resolution requires
a persistent shadow state (field-level last-known values with provenance) and is
the main thing v3 needs to add.

### RenameMap only — no split or merge
A field named `name` in one connector and `{ firstName, lastName }` in another
cannot be mapped. Only 1:1 renames are supported. Split and merge mappings would
require a transform function, which was deliberately excluded to keep scope tight.
The canonical model still applies — the `inbound`/`outbound` structure works for
any bijective transform, not just renames.

### Entity name aliasing not supported
If connector A calls an entity `contacts` and connector B calls it `customers`,
there is no way to wire them into the same channel. The `entity` field on
`ChannelMember` is the single name the connector exposes. A `remoteEntity` alias
was considered and dropped. A future version could add it.

### In-memory state still lost on restart
Same limitation as v0 and v1. The `toJSON/fromJSON` mechanism persists state to a
file in `run.ts`, but the tests always start fresh. A real implementation needs
the engine's identity map and watermarks to survive process restarts reliably.


---

# v3 Lessons Learned

## What v3 was

Replaced the v2 echo *set* (consume-on-sight, requires all passes in same cycle) with a
`lastWritten` *store* (compare-on-read, pass-order independent). This eliminated the most
fragile constraint inherited from v0: that the caller must run all directed pairs in a
single cycle or echoes accumulate silently.

All other v2 mechanics (declarative config, canonical field model, N-way channels,
patch semantics, rename maps) carried forward unchanged.

## What worked

### Content-based comparison is correct and robust

Comparing canonical field values rather than record IDs is strictly better:
- Works across any number of poll cycles (entries are overwritten, never deleted)
- Handles delayed passes and crashes between passes — the stored entry persists
- Correctly ignores connector-added metadata (ETags, audit fields) that appear after
  outbound renames but not in canonical form

The key insight: because we always store the **canonical** representation (before outbound
renames, after inbound renames), connector-local metadata never causes false positives.

### No pass-ordering constraint

v2 tests failed when only one direction of a pair was run. v3 tests pass regardless of
pass ordering. Running B→A without first running A→B is safe — the stored `lastWritten`
entry from the previous full cycle still correctly identifies echoes.

### `lastWritten` doubles as shadow state

The store encodes "what the engine last wrote here" per record per connector per entity.
This is the same concept as shadow state in the architecture spec — v3 proved that this
is the right primitive before the SQLite migration in v4.

## What broke down

### State file grows without bound

`lastWritten` entries are never garbage collected. Every record ever written to any
connector accumulates an entry. For long-running sync with high churn, the state file
becomes large. Not a problem for the POC; needs a cleanup pass in production.

### In-memory state JSON still not queryable

Same limitation as v0–v2. The state blob must be loaded in full on every engine start.
No way to query "show me the last written value for this specific record" without
reading the entire blob. Fixed in v4 with SQLite.

### Watermarks still per directed pair (`"A→B:entity"`)

v3 kept the directed-pair watermark key from v2. v4 changed this to per-source
(`"connectorId:entity"`) once the fan-out model replaced the directed-pair loop.
Directed-pair watermarks are wasteful when a source feeds many targets.

### No conflict resolution

Last write wins across passes. Content-based echo detection prevents our own writes
from being mistaken for updates, but it does not detect *external* writes to the same
field from two different connectors in the same cycle. Addressed in v4.


---

# v4 Lessons Learned

## What v4 was

Replaced the in-memory JSON state blob with a real SQLite database via a Drizzle adapter.
Established the minimal four-table schema: `identity_map`, `watermarks`, `shadow_state`,
`connector_state`. Introduced circuit breakers, conflict resolution, and an event bus.
Shifted the sync loop from directed-pair iteration to per-source fan-out (`ingest()`).

## What worked

### The `shadow_state` table is the right central abstraction

Storing every record's last-known canonical form in a SQLite table rather than a JSON
blob proved the hub-and-spoke architecture works in practice. Key benefits realised:

- **Queryable** — `SELECT * FROM shadow_state WHERE connector_id = ?` is instant
- **Fan-out becomes simple** — `ingest()` reads source, diffs against `shadow_state`,
  dispatches deltas to all other members
- **`lastWritten` replaced** — shadow state serves the same purpose as v3's `lastWritten`
  with the added property that it's persisted in a queryable form

### Per-source watermarks (`connectorId:entity`) replace directed-pair keys

Changing from `"A→B:customers"` to `"A:customers"` means a source connector is read
once per cycle regardless of how many targets it feeds. The old directed-pair key
caused redundant reads when multiple targets existed.

### Drizzle adapter pattern works

The engine types against Drizzle's `BaseSQLiteDatabase` interface. The concrete
driver (`better-sqlite3` vs `bun:sqlite`) is injected at startup via `openDb()`.
No engine code changed when switching drivers. This is the correct abstraction.

### Circuit breaker as a stateless wrapper

The circuit breaker wraps the dispatch loop, not the connector. It evaluates the
error rate across recent batches and trips before dispatching when the rate exceeds
the threshold. Stateless per-engine-instance design is correct for the POC; the
only known production gap is that trip events aren't persisted to the DB (so a
restart clears a tripped breaker).

## What broke down

### `conflict` module introduced complexity without production-ready resolution

v4 added a `resolveConflicts` function that applies per-field conflict rules (last-write-wins,
source-wins, merge). The interface was correct but the rules engine was thin — it couldn't
express "if both sides changed, prefer CRM" without hardcoded logic. The spec
(`specs/safety.md`) defines the full resolution model; v4 only validated the hookup points.

### Event bus is fire-and-forget

The event bus emitted field diff events but nothing consumed them in v4 beyond logging.
The production use case — triggering action connectors — was not validated until v7.

### No webhook receiver yet

v4's engine internals were ready to receive webhooks (the queue model was designed)
but there was no HTTP server to receive them. Validated in v5.

### Circuit breaker state lost on restart

As noted above, trip events live in memory. A crash during a tripped state means the
engine starts clean on restart and may re-attempt bad batches before accumulating
enough failures to trip again. Production fix: persist `circuit_breaker_events` to DB.


---

# v5 Lessons Learned

## What v5 was

First POC to touch a network. Introduced `ctx.http` (a tracked fetch wrapper with auth
injection and request journal logging), connector lifecycle hooks (`onEnable`/`onDisable`/
`handleWebhook`), an in-process webhook receiver backed by a `webhook_queue`, and a local
mock CRM HTTP server to exercise all of this without external dependencies.

## What worked

### `ctx.http` is the right boundary for auth + observability

Injecting a tracked fetch wrapper into every connector call means:
- Auth headers are applied once in the engine, not duplicated in each connector
- Every outbound HTTP call appears in `request_journal` automatically
- Credential masking (keys and tokens never logged in plain text) is enforced centrally
- Connector authors never import `fetch` directly — they call `ctx.http()` which has
  the same signature

The interface felt natural for connector authors. Adding a new connector with API-key
auth required only declaring `metadata.auth.type = 'api-key'` — the header injection
happened automatically.

### Webhook queue decouples receive from process

The in-process receiver writes to `webhook_queue` immediately (fast, no blocking).
`processWebhookQueue()` dequeues and runs each payload through the connector's
`handleWebhook` hook followed by the normal sync pipeline. This separation means:
- Webhook delivery never blocks the poll loop
- Failed processing leaves the row in the queue for retry
- The queue is observable — you can see unprocessed events

### Mock server pattern for HTTP connectors

Running a real in-process HTTP server (`mock-crm-server.ts`) rather than using mocks
exercised the actual connector read/write code paths including pagination, error
responses, and webhook delivery. Problems that would have been hidden by mocks
surfaced immediately (e.g. the server returning 201 on create but 200 on update — the
connector had to handle both).

### `batch_id` correlation in request journal

Tagging every request journal row with the `batch_id` of the ingest cycle that
triggered it made it possible to answer "which HTTP calls did this sync batch make?"
This is the traceability model that carries into production.

## What broke down

### `onEnable`/`onDisable` semantics were underspecified

The hooks were called correctly but the contract was unclear: should `onEnable` wait
for webhook subscription to succeed before returning? What happens if the webhook
endpoint is unreachable? The hooks returned `void`; production needs them to be
async and to surface errors into the engine's error channel.

### Webhook replay on startup not tested

If the engine restarts with unprocessed rows in `webhook_queue`, they should be
processed on startup. This was not validated in v5 — the queue was always empty at
test startup. The production engine needs an explicit drain-on-boot step.

### No retry on failed webhook processing

A connector's `handleWebhook` throwing an error left the row in `webhook_queue`
unprocessed, with no retry or dead-letter logic. The spec (`specs/webhooks.md`)
defines the retry model; v5 only validated the happy path.

### Auth injection tested for API key only

OAuth2 and `prepareRequest` were designed but not validated in v5. The full auth
matrix (API key ✅, OAuth2 ⬜, prepareRequest ⬜) was completed in v6.


---

# v6 Lessons Learned

## What v6 was

Validated the two remaining auth patterns (OAuth2 client-credentials and `prepareRequest`
bespoke auth) and the ETag threading model (`ReadRecord.version` → `UpdateRecord.version`).
Extended the v5 mock server to expose a token endpoint, signature-based auth, and ETag
headers on read/write. After v6, the full `ctx.http` auth matrix was proven.

## What worked

### OAuth2 token lifecycle is fully engine-managed

The connector declares `metadata.auth.type = 'oauth2'` and implements `getOAuthConfig()`.
The engine handles everything else: initial token acquisition, storing in `oauth_tokens`,
injecting the Bearer header, and transparent refresh before expiry. The connector never
sees credentials — it only sees successful HTTP calls. This is the correct separation.

The lock mechanism (preventing concurrent refresh races when multiple parallel reads
fire at token expiry) worked correctly in tests. The `oauth_tokens` table with a
`locked_until` column is the right pattern.

### `prepareRequest` correctly short-circuits engine-managed auth

When a connector implements `prepareRequest`, it receives the raw `Request` object and
returns a modified one. The engine injects this before any auth logic. Connectors using
HMAC signatures, session cookies, or multi-step auth flows can implement any scheme
they need without engine changes. The priority order (`prepareRequest` first, then
OAuth2, then API key) is correct.

### ETag threading through the dispatch loop

`ReadRecord.version` is stored in `shadow_state.version` when a record is ingested.
When the engine dispatches an update to a connector, it includes `version` in
`UpdateRecord`. The connector can then send `If-Match: <etag>` and handle 412. This
proves the connector contract is right for optimistic locking — the engine doesn't
need to know what the version field means, only that it exists and flows through.

### Auth tested end-to-end with no external services

All three auth paths (API key from v5, OAuth2, prepareRequest) were validated against
in-process mock servers. Zero external credentials, zero network dependency, fully
deterministic tests.

## What broke down

### 412 retry machinery not implemented

The POC proved that `version` flows correctly to the connector, but when the connector
gets a 412 (ETag mismatch — the record was updated externally since last read), the
engine has no retry-after-re-read loop. The connector throws an error and the batch
fails. Production needs: receive 412 → re-read the record → update shadow state →
retry the dispatch. Specified in `specs/safety.md`; not implemented yet.

### OAuth2 scope handling not tested

`getOAuthConfig()` can return a `scopes` array, but all token requests in v6 used
no-scope client credentials. A connector requiring specific scopes (e.g. Google APIs)
was not validated. The token manager implementation should handle scope in the request
but this was not confirmed.

### `prepareRequest` async error path not fully handled

If `prepareRequest` throws (e.g. signature generation fails), the error propagated
correctly but was not attributed to the connector in the request journal. The request
journal row showed a generic error rather than indicating which connector's
`prepareRequest` failed.

### No token revocation on `onDisable`

When a connector is disabled, its OAuth tokens remain in `oauth_tokens`. The engine
does not call a revocation endpoint. For connectors that issue long-lived tokens, this
is a security gap. The spec (`specs/auth.md`) documents the expected cleanup behaviour.




---

# v7 Lessons Learned

## What v7 was

Introduced the discover/onboard pattern to prevent first-sync duplicates. Without it,
restoring a wiped database and running a normal ingest would create duplicate records in
every system. v7 added `engine.discover()` to identify which records already exist on
both sides, and `engine.onboard()` to commit identity links and seed shadow state before
any fan-out runs.

## What worked

### The ingest guard prevents the duplicate-creation class of bugs

Adding `OnboardingRequiredError` — thrown by `ingest()` before reading if the target
has records but the channel has no shadow state — makes the failure visible rather than
silent. The class of bug it prevents (DB wipe + blind re-sync = duplicates everywhere)
is otherwise impossible to diagnose after the fact. The escape hatch
(`skipOnboardingCheck: true`) lets tests exercise the failure deliberately.

### `discover()` + `onboard()` as a two-phase commitment

Separating discovery (read-only, produces a report) from onboarding (writes identity
links) lets an operator inspect the match report before committing. The `dryRun` option
on `onboard()` reinforces this. This inspect-before-commit pattern carries into v9 as
the foundational model.

### `propagateUnique` flag makes onboarding explicit about intent

Records unique to one side (not present in the other) are ambiguous: should they be
propagated (the default) or held back? Making this a named option rather than an
implicit behaviour forces the caller to acknowledge the choice and documents it in code.

### Two-state channel status is clear enough for v7 scope

`"uninitialized"` and `"ready"` are sufficient when every channel starts with two
connectors. Adding a third connector (v8) immediately breaks this — `"ready"` becomes
ambiguous when a new connector is added to the config but not yet onboarded. This
limitation was anticipated but punted to v8.

## What broke down

### `discover()` makes live connector calls — not repeatable

v7's `discover()` called `entity.read()` on every channel member to build the match
report. This means two calls to `discover()` in quick succession could produce different
reports if the source data changed between them. A dry-run inspect followed by an
immediate `onboard()` is theoretically safe but is not guaranteed to be consistent — the
data could change between the two calls. Fixed in v9 by reading from `shadow_state`
instead of live connectors.

### Watermark advancement after onboarding is a subtle hazard

`onboard()` advances watermarks to `now`. Any records written to the source systems
between the `discover()` call (which does a full read with no watermark) and the
`onboard()` call will not be picked up by the next incremental sync — they fall in the
gap between the full-read snapshot time and the new watermark. In practice, this window
is seconds, but it is a correctness gap. v9 addresses this by anchoring the watermark
to the time of the `collectOnly` ingest, not to `now`.

### Exact-only identity matching is a hard prerequisite for connector authors

`identityFields` must be declared in the channel config, and matching is exact
(modulo case/whitespace normalisation). If a connector stores emails as
`"BOB@EXAMPLE.COM"` and the canonical is `"bob@example.com"`, they match. But if the
connector stores `"Bob Martin <bob@example.com>"` and the canonical has `"bob@example.com"`,
they don't match — the record appears as a unique-per-side even though it represents the
same person. Fuzzy matching remains out of scope.

### N-way discover is pairwise under the hood — semantics change for N > 2

v7's `discover()` compares side 0 against all other sides independently. With two
sides this produces the right result. With three sides it does not automatically do
three-way matching — a record unique to side 2 but present on sides 0 and 1 requires a
different algorithm. This limitation drove the design of `addConnector` in v8 (matching
against the canonical layer, not pairwise).


---

# v8 Lessons Learned

## What v8 was

Extended the discover/onboard pattern to handle a third connector joining a live channel.
After v7, A and B were already synced. v8 answered the question: when C joins with pre-existing
data, how do you match C's records against the canonical layer (not against A or B directly),
propagate net-new C records to A and B, and propagate canonical-only records into C — all
without creating duplicates?

## What worked

### Match against the canonical layer, not against peers

The key architectural insight of v8: `addConnector` matches C's records against the
existing canonical dataset, not pairwise against A or B. This is correct because A and B
may disagree on field values after live sync — the canonical layer is the single source
of truth. The match report expresses `"C record → canonical"` rather than `"C record → B record"`,
which is the right level of abstraction.

### `addConnector` as a first-class engine operation

Making this a named method rather than a special mode of `onboard()` keeps the API
surfaces clean. Each operation has a clear precondition: `discover()` + `onboard()` = initial
two-party setup; `addConnector()` = joining an already-live channel. The precondition
checking ("channel must be ready", "connector must not already be linked") prevents
calling them in the wrong order.

### Dry-run without side effects validates the match report

`addConnector(..., { dryRun: true })` fetches live and matches but makes no DB writes.
This proved essential in the runner—operators can inspect the `linked/newFromJoiner/
missingInJoiner` counts before committing. The pattern is consistently available on all
mutating engine operations (onboard and addConnector both have dryRun).

### `'partially-onboarded'` channel status represents real observable state

When C is declared in the channel config but has not yet gone through `addConnector`,
the channel is genuinely in an intermediate state. Adding this status made the engine's
behaviour predictable: `ingest()` is allowed for already-linked members but blocked for
the joining connector. Without this, it would be easy to accidentally call `ingest(C)`
before `addConnector(C)` and create duplicates.

## What broke down

### `addConnector` still makes a live connector call

v8's `addConnector` fetched C's records live (calling `entity.read()`) to build the match
report. This is the same problem as v7's `discover()`: if `addConnector` is called with
`dryRun: true` and then called again in live mode, two separate live reads happen. For
large datasets this is expensive. More importantly, the records that were read for the
dry-run may differ from those read on the live call. Fixed in v9 by requiring a
`collectOnly` ingest first.

### Watermark for the joining connector requires a `snapshot_at` anchor

`addConnector` advances C's watermark to `now` on completion. Any records written to C
between the start of the live fetch and the end of the `addConnector` call fail into the
gap. This is the same timing gap as v7's onboard watermark advance — the correct fix is
to anchor to the start of the bulk read timestamp (`snapshot_at`), not to `now`. Not
done in v8; fixed in v9.

### Conflict resolution on join is deferred and undocumented

When C's version of Alice has a different `phone` than the canonical (because A and B
agreed on a value after their initial sync), `addConnector` silently uses the canonical
value and discards C's value. This is the correct default but it is not documented in the
code or surfaced to the caller. The `AddConnectorReport` has no field indicating which
records had value conflicts on join. A future version should expose this so operators can
audit what was overwritten.

### Identity field normalisation was confirmed necessary but scope-limited

Lowercasing and trimming emails before comparison is mandatory for real-world data (case
differences in email addresses are common). v8 is where this was first enforced in test
coverage. However, normalisation is only applied to the fields listed in `identityFields`.
Non-identity fields can still cause false negatives if compared without normalisation in
other contexts.


---

# v9 Lessons Learned

## What v9 was

Resolved the live-I/O coupling that plagued v7 and v8's discover and addConnector
operations. The central insight: separate data collection (ingest into shadow_state) from
identity resolution (discover/onboard/addConnector). After v9, discover() and addConnector()
are pure DB queries — no live connector calls after the initial collectOnly ingest. This
makes the inspect-before-commit workflow repeatable and deterministic.

## What worked

### `collectOnly` ingest as a first-class operation

Making data collection an explicit named mode (`{ collectOnly: true }`) rather than an
implicit first phase of onboarding makes the full flow legible: ingest (collect) → discover
(match report) → onboard (commit links) → ingest (normal sync). Each step has a clear
input and output. Operators understand what to run and in what order. The engine enforces
the order with useful error messages at each step.

### Provisional canonicals make `dbMergeCanonicals` the clean abstraction

Rather than creating fresh UUIDs during onboarding (as v7 and v8 did), v9 writes a
provisional self-only canonical for each record during `collectOnly`. When `onboard()` runs,
it merges the matched provisional canonicals — one side's UUID is kept, the other is
redirected. `dbMergeCanonicals` is a single atomic operation that updates both
`identity_map` and `shadow_state.canonical_id`. The merge-not-create pattern avoids a
whole class of ID proliferation bugs.

### Collected-but-not-linked connectors are invisible to channel status and fan-out

A connector that has been collected but not yet linked via `addConnector` does not
downgrade the channel from `"ready"` — it is simply not a member yet. This allows A and B
to continue syncing normally while C is being onboarded. The fan-out guard
(`crossLinkedConnectors`) skips C on every A and B ingest until `addConnector` commits the
links. This is the correct invisible-until-linked semantics and proved clean to implement.

### `addConnector` catches C up from canonical state — not from re-reading A or B

After `addConnector` commits C's links, it compares C's collected snapshot against the
current canonical field values in shadow_state. Where they diverge (because A or B changed
during the collection window), it calls `C.update()` immediately. C is fully current before
`addConnector` returns; the first normal ingest is a no-op. This catch-up-on-link design
is better than deferring to the next ingest cycle because it makes the committed state
consistent at a single point in time.

### `discover()` is now free to call multiple times with identical results

Because it reads only from `shadow_state`, calling `discover()` twice returns the same
report (until the next `collectOnly` ingest re-runs). This makes dry-run usage safe:
operators can call `onboard(…, { dryRun: true })` repeatedly and the report is always a
snapshot of the collected state, not of live data that may have changed between calls.

## What broke down

### Two engine instances needed for the partial-onboarding scenario

The tests show a pattern where `engineAB` (two-member channel) is used for the initial
onboard, then `engineABC` (three-member channel) is created for the `addConnector` phase.
This is an artefact of the test setup, but it exposes a real concern: the engine's channel
membership is currently baked into its constructor config. In production, adding a connector
to a live channel requires hot-reconfiguring the engine without restarting it. The current
design does not support this — the channel config is static at engine creation time.

### `snapshot_at` anchor is still not implemented — watermark gap persists

v9 acknowledges the watermark timing gap (any records written to the source after the
`collectOnly` ingest but before `onboard()` commits are missed until the next full sync)
but does not fully solve it. The correct fix is to record the exact timestamp at which
`collectOnly` started reading and use that as the new watermark — not `now`. The current
code still advances to `now` on completion, which carries the same gap risk as v7 and v8.
This is the most concrete open production gap from the POC series.

### Unique-per-side propagation bypasses the normal diff pipeline

When `onboard()` propagates a record unique to one side to the other, it calls
`entity.insert()` directly rather than going through `_processRecords`. This means the
normal pipeline (conflict check, idempotency guard, circuit breaker pre-flight) is not
applied to onboarding inserts. For the POC scale this is fine. For production, onboarding
inserts should pass through the same safety checks as normal ingest inserts.

### Entity-level scope union for OAuth2 is deferred

The `OAuthTokenManager` in v9 (inherited from v5/v6) comments that entity-level scope
union is deferred. In practice this means that if one entity in a connector requires
`scope: ["read:contacts"]` and another requires `scope: ["read:orders"]`, all token
requests use only the base scopes declared in the connector's `metadata.auth.oauth2`
config. This can cause silent permission failures for multi-entity connectors. The
union of all entity-required scopes should be used when requesting tokens.

