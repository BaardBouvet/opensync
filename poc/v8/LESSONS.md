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
