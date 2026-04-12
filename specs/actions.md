# Actions

Connectors that trigger side effects (send an email, post to Slack, create an invoice) expose
named **actions** via `getActions()`. An action connector is push-only — it receives data from
the engine but has no `read()` method.

## Why a separate connector type

Sync and side effects have fundamentally different requirements:

- **Sync writes** must be idempotent, diffed, conflict-resolved, and rolled back. They manage
  a shared canonical record.
- **Action invocations** are fire-and-forget. They don't produce a record the engine tracks.
  They may be irreversible (sent email, posted Slack message). They must be deduplicated
  across retries but not rolled back.

Keeping them separate means the sync pipeline can apply its full safety machinery without
special-casing side effects, and action connectors stay simple — they only implement
`execute()`.

## SDK types

```typescript
interface ActionPayload {
  /** Engine-assigned deterministic key for this action invocation. Stable across retries.
   *  Forward to the target API as a per-message dedup key where supported. */
  idempotencyKey: string;
  data: Record<string, unknown>;
}

interface ActionDefinition {
  name: string;                                        // e.g. 'send-email', 'post-message'
  description?: string;
  schema?: Record<string, FieldDescriptor>;            // optional — required fields validated before execute() is called
  scopes?: string[];                                   // OAuth scopes required to execute this action

  /** Streaming batch execute — mirrors insert/update/delete contract.
   *  Yields one ActionResult per input payload in the same positional order.
   *  Serial connectors iterate one-at-a-time; bulk connectors chunk and batch. */
  execute(payloads: AsyncIterable<ActionPayload>, ctx: ConnectorContext): AsyncIterable<ActionResult>;
}

interface ActionResult {
  data?: Record<string, unknown>;  // response from the external system, if any
  error?: string;                  // present = this item failed; absent = success
}
```

`schema` uses the same `FieldDescriptor` type as entity fields. If provided, the engine
validates that all `required: true` fields are present in each payload before calling
`execute()`. This lets the engine reject malformed payloads at the boundary without the
connector needing defensive validation inside `execute()`.

`idempotencyKey` is computed by the engine as `sha256(triggerRuleId + eventId + payloadIndex)`.
It is stable across retries — if the engine crashes between generating the payload and
receiving the result, re-running produces the same key. Connectors that forward this to the
target API (e.g. as a `customArgs` field in SendGrid or a `StatusCallback` tag in Twilio)
get end-to-end deduplication with no connector-side state needed.

## execute() contract

`execute()` mirrors the `insert()` / `update()` / `delete()` contract exactly:

- Receives an `AsyncIterable<ActionPayload>` — pull at whatever rate suits the API.
- Yields one `ActionResult` per input, in the same positional order.
- Yield `{ error: message }` for per-item failures; throw to abort the entire run.
- Actions get the full `ConnectorContext` — `ctx.http`, `ctx.state`, `ctx.config`, `ctx.logger`.

There is no `id` on `ActionResult` — actions do not produce a record the engine needs to
track in the identity map.

This allows one connector to implement multiple actions (e.g. Slack: `post-message`,
`open-dm`, `create-channel`) instead of requiring a separate connector per operation.

## Connector declaration

A pure action connector omits `getEntities` and implements only `getActions`:

```typescript
export default {
  metadata: { name: 'slack', version: '1.0.0', auth: { type: 'api-key' } },
  getActions(ctx) {
    return [
      {
        name: 'post-message',
        schema: {
          channel:  { type: 'string', required: true, description: 'Channel name, e.g. #general' },
          message:  { type: 'string', required: true, description: 'Message text' },
        },
        async *execute(payloads, ctx) {
          for await (const payload of payloads) {
            const res = await ctx.http('https://slack.com/api/chat.postMessage', {
              method: 'POST',
              body: JSON.stringify({ channel: payload.data.channel, text: payload.data.message }),
            });
            const json = await res.json();
            yield json.ok ? {} : { error: json.error };
          }
        },
      },
    ];
  },
} satisfies Connector;
```

A connector that both reads and dispatches side effects implements both `getEntities` and
`getActions` in the same file.
