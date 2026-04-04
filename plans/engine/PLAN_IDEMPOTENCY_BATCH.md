# Plan: Batch Actions & Action Idempotency

**Status:** `backlog`
**Date:** 2026-04-04
**Spec:** [specs/actions.md](../../specs/actions.md)

## Goal

Make `ActionDefinition.execute` batch-native — `AsyncIterable<ActionPayload>` in,
`AsyncIterable<ActionResult>` out — so connectors backed by bulk APIs (e.g. SendGrid batch
send, Twilio bulk SMS) can process many payloads in a single HTTP call, and the interface is
fully symmetric with `insert`, `update`, and `delete`.

Idempotency keys belong on `ActionPayload` only. For CRUD writes the engine's identity map
provides crash-recovery: if a write result was never committed the engine re-reconciles next
cycle and can recover via `lookup()`. Actions have no equivalent — there is no identity map for
side effects — so a stable per-invocation key is necessary at the action layer.

The change is additive. No existing connector, engine behaviour, or type is removed.

---

## Problem

`ActionDefinition.execute()` is 1:1: one payload in, one `ActionResult` out. When the engine
fires 500 trigger events during an initial sync, it calls `execute` 500 times serially. APIs like
SendGrid (`POST /v3/mail/send` with `personalizations[]`) or Twilio bulk messaging accept all 500
in a single HTTP call, but the current interface prevents the connector from doing that.

## Solution

Replace the 1:1 `execute` signature with the same streaming contract used by `insert`, `update`,
and `delete`: `AsyncIterable` in, `AsyncIterable` of results out. There is no separate
`executeBatch` — the method is batch-native from the start.

A connector that wants serial behaviour simply calls its API once per item as it iterates. A
connector backed by a bulk API accumulates via `chunk()` (from SDK helpers) and calls the bulk
endpoint, yielding one result per input in positional order. The engine sees the same interface
either way.

## Idempotency for Action Payloads

The same crash window exists for actions. An `ActionPayload` wrapper carries an engine-assigned
`idempotencyKey`:

```
sha256(triggerRuleId + eventId + payloadIndex)
```

The connector can forward this as a per-message ID inside the bulk request body (e.g. the
`customArgs` field in a SendGrid `personalization`, or the `StatusCallback` tag in Twilio). For
serial connectors, it can be forwarded as an idempotency header on each individual request.

Note: messaging and email APIs are less consistent about idempotency than payment APIs. SendGrid
has a `batch_id` concept but it is scoped to scheduling/cancellation, not dedup on retry. When no
native dedup mechanism exists, the best practice is for the connector to check via a lookup before
re-sending ("did this message already go out?") using `ctx.state` keyed by the `idempotencyKey`.

## Type Changes

```typescript
/** An action payload decorated with an engine-assigned idempotency key. */
export interface ActionPayload {
  /** Engine-assigned deterministic key for this action invocation.
   *  Stable across retries. Forward to the target API as a per-message dedup key where supported. */
  idempotencyKey: string;
  data: Record<string, unknown>;
}

export interface ActionDefinition {
  name: string;
  description?: string;
  schema?: Record<string, FieldDescriptor>;
  scopes?: string[];

  /** Execute one or more action payloads.
   *
   *  Receives an AsyncIterable<ActionPayload> and yields one ActionResult per input in the
   *  same positional order. Mirrors the insert/update/delete contract exactly.
   *
   *  Serial connectors iterate and call their API once per item.
   *  Bulk connectors use chunk() to accumulate and call a batch endpoint.
   *  Throw to abort the entire run; yield ActionResult with error set for per-item failures. */
  execute(
    payloads: AsyncIterable<ActionPayload>,
    ctx: ConnectorContext
  ): AsyncIterable<ActionResult>;
}
```

## ActionResult Contract

Symmetric with `InsertResult`, `UpdateResult`, and `DeleteResult` — absent `error` means success,
present `error` means failure. No `status` discriminant.

```typescript
export interface ActionResult {
  /** Raw response from the external system, if any. */
  data?: Record<string, unknown>;

  /** Present means this action invocation failed. Absent means success.
   *  Yield with error set for per-item failures; throw only to abort the entire run. */
  error?: string;
}
```

There is no `id` field: actions do not produce a target-system ID that the engine needs to track
in the identity map.

## Engine Responsibilities

- Accumulate all pending `ActionPayload` items for the same `(actionConnector, actionName)` pair
  within a sync cycle into a single `AsyncIterable` and pass it to `execute()`.
- Consume results as they are yielded — no need to buffer the full output.
- On per-item failure (`error` present), retry that item using a new `ActionPayload` (same
  `idempotencyKey`) on the next cycle.
- A connector that throws aborts the entire action run for that `(connector, action)` pair;
  all pending items are retried next cycle.

---

## Work Items

| # | Task | Touches |
|---|------|---------|
| 1 | Change `ActionResult` to `{ data?, error? }` interface in `types.ts` | `packages/sdk/src/types.ts` |
| 2 | Add `ActionPayload` interface to `types.ts` | `packages/sdk/src/types.ts` |
| 3 | Change `ActionDefinition.execute` to `(AsyncIterable<ActionPayload>, ctx) => AsyncIterable<ActionResult>` | `packages/sdk/src/types.ts` |
| 4 | Engine: accumulate action payloads per `(connector, action)` pair and pass as `AsyncIterable` | engine internals |
| 5 | Engine: generate idempotency keys for action payloads | engine internals |
| 6 | Engine: store action idempotency keys in the transaction log | engine internals |
| 7 | Update `specs/actions.md` to reflect new contracts | specs |
| 8 | Update any example connectors that reference `ActionResult` | connectors/ |
