# Safety

Circuit breakers, echo prevention, idempotency, and soft delete detection. All in core — not optional.

## Circuit Breakers

Protect against runaway syncs, loops, and API failures.

### Three States

| State | Meaning | Behavior |
|-------|---------|----------|
| OPERATIONAL | Normal | All syncs proceed |
| DEGRADED | Specific records blocked | Individual records with detected loops are paused, rest continues |
| TRIPPED | Channel frozen | No syncs for this channel until manually reset |

### Three Triggers

**Volume threshold**: If more than X records change in a single sync cycle, trip the breaker. Catches mass deletions, bulk imports gone wrong, or rogue scripts.

```typescript
interface CircuitBreakerConfig {
  volumeThreshold: number;           // e.g. 100
  errorRateThreshold: number;        // e.g. 0.3 (30%)
  loopDetection: {
    maxOscillations: number;         // e.g. 5
    windowMinutes: number;           // e.g. 10
  };
  cooldownMinutes: number;           // auto-reset timer (0 = manual only)
}
```

**Loop detection (oscillation)**: If the same field on the same record flip-flops more than N times in M minutes, it's a loop. Common cause: two systems normalizing data differently (e.g. phone format). First goes to DEGRADED (just that record blocked), escalates to TRIPPED if multiple records loop.

**Error rate**: If more than X% of API calls in a cycle return 4xx/5xx, trip the breaker. Protects API quotas and prevents corrupt data from partial syncs.

### API

```typescript
class CircuitBreaker {
  evaluate(batchSize: number, errorCount: number): Promise<CircuitState>;
  recordOscillation(entityId: string, field: string): Promise<void>;
  trip(reason: string): Promise<void>;
  reset(): Promise<void>;
  getState(): Promise<CircuitState>;
}
```

The breaker is checked before processing each batch (pre-flight) and after dispatch (post-flight). State is persisted in the `sync_channels` table.

## Echo/Loop Prevention

The most common source of infinite loops: System A updates System B → B sends a webhook → engine sees "change" in B → pushes to A → A sends webhook → repeat forever.

### How Echo Detection Works

The engine uses **shadow-state comparison** rather than a short-lived hash log. After every successful write to a target connector, the engine stores the canonical form of what it wrote in `shadow_state`. On the next read from that same connector, the engine compares the incoming canonical record against the stored shadow. If they match, the record is the engine's own write bouncing back — it is suppressed as an echo.

```
Engine writes { customerName: "Alice Smith" } to connector B
  → shadow_state for (B, customers, aliceBId) updated with those values

[next poll of B]
B.read() returns { customerName: "Alice Smith" }
  → canonical after inbound mappings: { customerName: "Alice Smith" }
  → matches shadow_state → skip (echo)

[user edits customerName in B to "Alicia Smith"]
B.read() returns { customerName: "Alicia Smith" }
  → canonical: { customerName: "Alicia Smith" }
  → does not match shadow_state → propagate (genuine change)
```

**Why shadow-state comparison is better than TTL hashes:**

The earlier design stored `{ entityId, targetInstanceId, hash, timestamp }` entries with a 5-minute TTL window. This had two failure modes:

1. **False negatives on slow cycles**: If the reverse pass ran more than 5 minutes after the forward pass (slow API, large batch, scheduled delay), the TTL entry expired and the echo was propagated as a genuine change — causing a loop.
2. **False positives on identical legitimate edits**: If a user made the identical change to what the engine had already written (e.g. correcting a typo to the same value the engine set), the hash still matched and the genuine change was suppressed.

Shadow-state comparison has neither problem: entries never expire (they are overwritten on the next write), and comparison is against the full canonical record — so a user reverting a field to the engine's value is correctly detected as "no change from canonical" and suppressed, which is the correct outcome (the canonical record already has the right value).

### Three Layers of Protection

| Layer | What it catches |
|-------|----------------|
| L1: Shadow-state match | Engine's own writes bouncing back (any delay, any number of cycles) |
| L2: State-equality check | Incoming value equals current shadow value, regardless of source (no actual change) |
| L3: Idempotency key | Duplicate processing of the same webhook or job within TTL window |

L1 is the primary echo guard. L2 and L3 are independent safety nets that also suppress unnecessary writes even when L1 doesn't apply.

## Idempotency

Prevents duplicate processing of the same event (e.g. webhook delivered twice, or job retried after crash).

```typescript
class IdempotencyStore {
  computeKey(connectorInstanceId: string, externalId: string, dataHash: string): string;
  isDuplicate(key: string): Promise<boolean>;
  markProcessed(key: string, ttlMinutes?: number): Promise<void>;
  prune(): Promise<number>;   // cleanup expired entries
}
```

Key formula: `sha256(connectorInstanceId + externalId + JSON.stringify(sortedData))`

Stored in `idempotency_keys` table with TTL-based expiry. Default TTL: 60 minutes.

Checked at the start of the pipeline — before any processing happens.

## Soft Delete Detection

Detecting deletions in systems that don't have a "deleted items" API.

### Mark-and-Sweep Algorithm

Only runs during **full syncs** (no `since` filter):

1. Before sync: get all known entity_link_ids for this connector + entity type
2. During sync: track which external IDs appear in the fetch results
3. After sync: any entity_link_id not seen → mark as soft-deleted (`deleted_at` timestamp)

```typescript
class SoftDeleteDetector {
  detectDeletions(connectorInstanceId: string, entityType: string, fetchedExternalIds: Set<string>): Promise<string[]>;
  markDeleted(entityLinkIds: string[]): Promise<void>;
}
```

**Never hard-delete shadow state** — the data is preserved for undo and audit trail.

### Propagation

When a soft delete is detected, the engine does NOT automatically delete in other systems. Instead:
- The record is flagged in shadow state
- A notification/log entry is created
- The user (or config) decides whether to propagate deletions

This prevents accidental mass-deletion cascades (the circuit breaker also catches this).

## External Change Detection

When the engine polls a system and finds changes that don't match its outbound log or shadow state, it means something else modified the data — a user, another integration ("shadow IT"), or a bulk import.

Detection logic (the "triple check"):
1. **Shadow state says**: field = "123"
2. **System says**: field = "999"
3. **Outbound log says**: "I haven't touched this field recently"
4. **Conclusion**: external change detected

External changes are logged and can be:
- **Adopted**: update shadow state, propagate to other systems
- **Flagged**: mark for review without propagating
- **Reverted**: if the field has a master, write the master's value back

### Pattern Detection (future)

With enough history, the engine can detect patterns in external changes:
- "Every Tuesday at 02:00, 500 addresses change" → probably a batch job
- "Phone numbers keep getting reformatted" → probably another integration with different normalization

## Dead Letter Queue

When a record fails processing repeatedly (e.g. validation error in the target system, malformed data), it gets "parked" so it doesn't block the rest of the batch.

After exhausting retry attempts (default: 3, configurable per connector instance), the record is moved to the `dead_letter` table:

```sql
CREATE TABLE dead_letter (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  external_id TEXT NOT NULL,
  canonical_id TEXT,
  action TEXT NOT NULL,     -- 'insert', 'update', 'delete'
  payload TEXT NOT NULL,    -- JSONB: the record or ID that failed
  error TEXT NOT NULL,      -- last error message
  attempts INTEGER NOT NULL DEFAULT 0,
  first_failed_at TEXT NOT NULL,
  last_failed_at TEXT NOT NULL
);
```

- The sync job for the batch continues processing remaining records — one bad record does not stall the channel.
- Dead-lettered records can be inspected via `opensync dlq list` and retried manually via `opensync dlq retry`.
- See [cli.md](cli.md) for the full DLQ command reference.

This prevents one bad record (e.g. a contact with an invalid email format that the target API rejects) from stalling the entire sync channel.

## Retry Logic

Exponential backoff with jitter for transient failures.

```typescript
interface RetryConfig {
  maxAttempts: number;           // default 3
  baseDelayMs: number;           // default 1000
  maxDelayMs: number;            // default 30000
  backoffMultiplier: number;     // default 2
  retryableStatuses: number[];   // [429, 500, 502, 503, 504]
}

function withRetry<T>(fn: () => Promise<T>, config: RetryConfig): Promise<T>;
```

### Backoff calculation

```
delay = min(baseDelayMs * backoffMultiplier^attempt, maxDelayMs) + random_jitter
```

Jitter is a random value between 0 and `baseDelayMs` — prevents thundering herd when multiple workers retry simultaneously.

### Retry-After support

For 429 (Rate Limit) responses, the engine checks the `Retry-After` header:
- If present as seconds: wait that many seconds
- If present as HTTP date: wait until that time
- If absent: fall back to exponential backoff

### Integration

Integrated into `ctx.http` — connectors get automatic retry without any code. The retry config can be overridden per connector instance in the YAML config.

## Optimistic Locking (ETag threading)

Prevents lost-update races when an external system modifies a record between the engine's read and write.

### How it works

When a connector's `read()` returns a `version` field on a record, the engine stores it in `shadow_state.version`. When the engine later dispatches an update to the same connector, it passes that stored version back in `UpdateRecord.version`. The connector can then send `If-Match: <version>` (or equivalent) and receive a `412 Precondition Failed` if the record changed externally since it was last read.

```
Engine reads record from connector A
  → ReadRecord { id: "a1", data: {...}, version: "etag-xyz" }
  → shadow_state row written with version = "etag-xyz"

[External system modifies the record in A]

Engine dispatches update to connector A
  → UpdateRecord { id: "a1", data: {...}, version: "etag-xyz" }
  → Connector sends: PUT /contacts/a1 with If-Match: etag-xyz
  → API returns 412 Precondition Failed (version mismatch)
```

### 412 retry loop

When a connector receives a 412, it should throw `ConflictError`. The engine handles this by:

1. Re-reading the current record from the connector (`entity.lookup([id])`).
2. Updating `shadow_state` with the fresh record and its new version.
3. Re-computing the canonical diff against the original source.
4. If the diff still exists (i.e. the external change did not already incorporate it), retrying the update with the new version.

The retry loop runs at most once by default (configurable). If the conflict persists after retry, the record is moved to the dead letter queue with `action = 'conflict'`.

### Connector contract

- `ReadRecord.version` is optional. If the connector does not return a version, the engine skips ETag threading entirely — optimistic locking is connector-opt-in.
- `UpdateRecord.version` is only set when `shadow_state.version` is non-null for that record.
- The connector is responsible for sending the correct header and interpreting the 412. The engine supplies the version; the connector decides how to use it.

### Spec reference

Validated in POC v6. The `version` field flow (read → shadow → update) was confirmed working. The 412 retry loop is a known gap from v6 (engine did not implement the re-read + retry; it let the error propagate to the dead letter queue instead). This section specifies the production behaviour.

```typescript
// Thrown by connector when remote returns 412 Precondition Failed
class ConflictError extends ConnectorError {
  constructor(message: string, public readonly currentVersion?: string) {
    super(message, 'CONFLICT', false);  // not retryable via backoff — handled by re-read loop
  }
}
```
