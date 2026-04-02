# Actions & Workflows

Beyond data mirroring — trigger side effects when data changes. Send an email when a deal closes, create an invoice when a subscription activates, post to Slack when a contact is created.

## Event Bus

The engine emits events as data flows through the pipeline.

```typescript
type SyncEvent = {
  type: 'record.created' | 'record.updated' | 'record.deleted' | 'sync.completed' | 'sync.failed';
  entityType: string;
  entityId: string;
  channelId: string;
  sourceInstanceId: string;
  data: Record<string, unknown>;
  changes?: FieldDiff[];        // for record.updated: which fields changed
  timestamp: number;
};

class EventBus {
  on(eventType: string, handler: (event: SyncEvent) => Promise<void>): void;
  off(eventType: string, handler: Function): void;
  emit(event: SyncEvent): Promise<void>;
}
```

Events are emitted after successful dispatch. If dispatch fails, no event fires (preventing actions on failed syncs).

## Action Connectors

A simplified connector type — push-only, no fetch. For systems that receive data but don't produce it.

```typescript
interface ActionConnector {
  metadata: { name: string; version: string; type: 'action' };
  getActions(ctx: SyncContext): ActionDefinition[];
}

interface ActionDefinition {
  name: string;                               // e.g. 'send-email', 'post-message'
  description?: string;
  payloadSchema?: Record<string, ConfigField>; // optional input schema for validation/UI prompts
  execute(payload: Record<string, unknown>, ctx: SyncContext): Promise<ActionResult>;
}

interface ActionResult {
  status: 'success' | 'failed';
  data?: Record<string, unknown>;
}
```

This allows one connector to implement multiple actions (e.g. Slack: `post-message`, `open-dm`, `create-channel`) instead of creating a separate connector for each operation.

Examples: email sender, SMS gateway, Slack poster, invoice generator.

Action connectors get the same `SyncContext` as regular connectors — `ctx.http` for auto-logged HTTP calls, `ctx.state` for persistent state, `ctx.config` for credentials.

## Trigger Rules

Declarative rules that connect sync events to actions.

```typescript
interface TriggerRule {
  id: string;
  name: string;
  event: string;                              // e.g. 'record.updated'
  entityType: string;                         // e.g. 'deal'
  condition: TriggerCondition;
  actionConnector: string;                    // action connector name (e.g. 'slack')
  actionName: string;                         // named action exposed by that connector (e.g. 'post-message')
  actionPayloadTemplate: Record<string, unknown>;  // template with {{field}} references
}

interface TriggerCondition {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'contains' | 'changed_to';
  value: unknown;
}
```

### YAML Config

```yaml
triggers:
  - name: "Deal Won Notification"
    event: record.updated
    entity: deal
    condition:
      field: status
      operator: changed_to
      value: won
    actionConnector: email
    actionName: send-email
    payload:
      to: "{{email}}"
      subject: "Deal won: {{dealName}}"
      body: "Congratulations! Deal {{dealName}} worth {{amount}} was just closed."

  - name: "New Contact Alert"
    event: record.created
    entity: contact
    condition:
      field: source
      operator: eq
      value: website
    actionConnector: slack
    actionName: post-message
    payload:
      channel: "#new-leads"
      message: "New lead from website: {{firstName}} {{lastName}} ({{email}})"
```

### Trigger Engine

```typescript
class TriggerEngine {
  registerRule(rule: TriggerRule): void;
  removeRule(ruleId: string): void;
}
```

Listens on the event bus. When an event matches a rule's event type + entity type + condition, it:
1. Resolves the payload template (replace `{{field}}` with actual values)
2. Generates an idempotency key (prevents double-sends on retry)
3. Resolves `actionName` to an `ActionDefinition` from `actionConnector.getActions(ctx)`
4. Validates payload against the selected action's `payloadSchema` if provided
5. Calls the selected action's `execute(payload, ctx)` method

## Idempotency for Actions

Actions use the same idempotency store as the sync pipeline. The dedup key is:

```
sha256(triggerRuleId + entityId + eventTimestamp)
```

If a webhook is delivered twice, or a sync job retries, the action only fires once.

## Relationship to Sync

Actions are side effects of sync — they don't modify the sync pipeline. The event bus is fire-and-forget from the pipeline's perspective:
- Pipeline completes → events emitted → actions fire asynchronously
- Action failure does NOT roll back the sync
- Action failure IS logged and can be retried
