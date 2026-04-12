# Safety

Circuit breakers, echo prevention, idempotency, and soft delete detection. All in core — not optional.

## Circuit Breakers

Protect against runaway syncs, loops, and API failures.

### States

The circuit breaker uses the standard three-state model:

| State | Meaning | Behavior |
|-------|---------|----------|
| CLOSED | Normal | All syncs proceed |
| OPEN | Channel paused | `ingest()` aborts before any connector I/O |
| HALF_OPEN | Recovery probe | One test batch is allowed through; success → CLOSED, failure → OPEN |

**Why three states, not two?** A binary OPEN/CLOSED model would require manual intervention every time a transient failure trips the breaker. HALF_OPEN enables automatic recovery: after the reset window elapses, the engine allows one test batch. If the batch succeeds, the channel heals itself. If it fails again, the breaker re-opens — protecting against flapping without operator involvement.

### Triggers

**Error-rate threshold**: if more than `errorRateThreshold` (default 50%) of recent batches fail, transition CLOSED → OPEN. Triggers after at least `minSamples` (default 3) batches.

**Reset window**: after `resetAfterMs` (default 10 000 ms) elapses in OPEN state, transition to HALF_OPEN.

```typescript
interface CircuitBreakerConfig {
  errorRateThreshold: number;  // 0–1, default 0.5
  minSamples:         number;  // default 3
  resetAfterMs:       number;  // default 10000
}
```

The breaker is in-memory, per-`SyncEngine` instance. State is not persisted — a process restart resets all breakers to CLOSED. This is intentional: the most common reason a breaker trips is a transient API outage; not persisting means no manual reset is needed after the service recovers and the engine restarts.

### API

```typescript
class CircuitBreaker {
  record(outcome: 'success' | 'failure'): void;
  getState(): 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  reset(): void;
}
```

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

L1 is the primary echo guard. L2 and L3 are independent safety nets.

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

The `version` field flow (read → shadow → update) is validated. The 412 retry loop is the specified production behaviour:

```typescript
// Thrown by connector when remote returns 412 Precondition Failed
class ConflictError extends ConnectorError {
  constructor(message: string, public readonly currentVersion?: string) {
    super(message, 'CONFLICT', false);  // not retryable via backoff — handled by re-read loop
  }
}
```
