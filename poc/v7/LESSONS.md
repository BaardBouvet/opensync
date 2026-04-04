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
