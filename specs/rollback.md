# Undo & Rollback

Every outbound mutation is logged. Any change can be undone — a single field, a batch, or everything the engine ever did.

## Transaction Log

Every time the engine pushes a change to a target system, it logs:

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Log entry ID |
| entity_link_id | FK | Which record was changed |
| action | text | 'create', 'update', 'delete' |
| target_instance_id | FK | Which system was changed |
| data_before | jsonb | State before the change (null for creates) |
| data_after | jsonb | State after the change |
| batch_id | text | Groups operations from the same sync cycle |
| timestamp | datetime | When it happened |

This is written by the Dispatcher — every `connector.upsert()` or `connector.delete()` call is automatically logged.

## Undo Levels

### Single Record Undo

Revert the last change to a specific record in a specific system.

```typescript
async undoRecord(entityLinkId: string, targetInstanceId: string): Promise<UndoResult>;
```

Logic:
1. Find the most recent transaction_log entry for this entity_link + target
2. If action was 'update': push `data_before` back to the target system
3. If action was 'create': call `connector.delete()` (if supported)
4. If action was 'delete': call `connector.upsert()` with `data_before`
5. Update shadow state to reflect the reverted values

### Batch Undo

Undo all changes from a specific sync cycle (identified by `batch_id`).

```typescript
async undoBatch(batchId: string): Promise<UndoResult[]>;
```

Processes all transaction_log entries for the batch in reverse order (last-written first).

### Full Rollback

Remove all traces of the engine's involvement — as if the integration was never turned on.

```typescript
async fullRollback(channelId: string): Promise<RollbackResult>;
```

Logic:
1. Find all transaction_log entries for this channel
2. Process in reverse chronological order
3. For creates: delete the created records (if supported)
4. For updates: revert to `data_before`
5. Clean up: remove identity links, shadow state, stream state for this channel

```typescript
interface UndoResult {
  entityLinkId: string;
  targetInstanceId: string;
  action: 'reverted' | 'skipped' | 'failed';
  reason?: string;
}

interface RollbackResult {
  total: number;
  reverted: number;
  skipped: number;
  failed: number;
  details: UndoResult[];
}
```

## Capability-Aware Rollback

Not all systems support all undo operations.

| Situation | Engine behavior |
|-----------|----------------|
| Target `canDelete: false`, action was 'create' | Skip, log reason: "target system cannot delete" |
| Target has `immutableFields`, action was 'update' on those fields | Skip those fields, revert the rest |
| Target API returns error during revert | Mark as failed, continue with other records |

The engine warns upfront (pre-flight checks) if a target can't support full rollback.

## Rollback is Itself Logged

Rollback operations are mutations — they're written to the transaction log too. This means you can undo an undo (though this gets philosophically questionable).

## Pre-flight Snapshots

Before a user tests a new integration or mapping change, the engine can tag the current state with a snapshot ID. If the test doesn't work out:

```
opensync rollback --snapshot <snapshot-id>
```

This reverts everything that happened after the snapshot was created.

## Use Case: "Safe Testing"

1. User sets up a new sync between HubSpot and Fiken
2. Engine takes a pre-flight snapshot
3. User runs `opensync sync --full` — data flows
4. User inspects results, finds the mapping is wrong
5. User runs `opensync rollback --snapshot <id>`
6. All created records in Fiken are deleted, all updated records reverted
7. System is back to pre-test state

This drastically lowers the bar for trying integrations — no fear of data pollution.
