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

### The Echo Guard

Maintains a short-lived log of outbound pushes. When an inbound change arrives, compares against recent outbound data.

```typescript
class EchoGuard {
  isEcho(entityLinkId: string, incomingData: Record<string, unknown>, sourceInstanceId: string): boolean;
  recordOutbound(entityLinkId: string, data: Record<string, unknown>, targetInstanceId: string): void;
}
```

**Algorithm**:
1. After every successful push, hash the written field values and store: `{ entityLinkId, targetInstanceId, hash, timestamp }`
2. When a change arrives from a system, hash the incoming values
3. If the hash matches a recent outbound push to that same system (within TTL window, default 5 min) → it's an echo, suppress it
4. Additionally: compare incoming values against shadow state. If `incoming.val === shadow.val`, nothing actually changed → suppress

### Three Layers of Protection

| Layer | What it catches |
|-------|----------------|
| L1: Echo filter | Changes the engine just pushed (own footprint) |
| L2: Hash lock | Identical payloads arriving in rapid succession (duplicate webhooks) |
| L3: State compare | Incoming value equals shadow state value (no actual change) |

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

Failed records are moved to a dead letter state after exhausting retry attempts:
- The sync job for that record is marked `failed` with the error message
- Other records in the same batch continue processing
- Dead-lettered records can be inspected via `opensync inspect` and retried manually

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
