/**
 * OpenSync POC v4 — CircuitBreaker stub
 *
 * Wraps the dispatch loop in `ingest()`:
 *
 *   const state = breaker.evaluate(batchSize, errorCount);
 *   if (state === 'TRIPPED') return; // abort before dispatch
 *
 *   // ... dispatch each record ...
 *
 *   breaker.recordResult(hadErrors);
 *
 * The breaker trips when the error rate across recent batches exceeds
 * `errorThresholdRate` for at least `minSamples` batches.
 * It resets automatically after `resetAfterMs` milliseconds.
 *
 * This stub uses no DB — state is in-memory per SyncEngine instance.
 * A production breaker would persist trip events to the DB.
 */

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  /**
   * Fraction of batches that must fail to trip the breaker.
   * Default: 0.5 (50% error rate).
   */
  errorThresholdRate?: number;

  /**
   * Minimum number of batches recorded before the error rate is evaluated.
   * Default: 3.
   */
  minSamples?: number;

  /**
   * How long (ms) to wait in OPEN state before moving to HALF_OPEN.
   * Default: 10_000.
   */
  resetAfterMs?: number;
}

export class CircuitBreaker {
  private readonly errorThresholdRate: number;
  private readonly minSamples: number;
  private readonly resetAfterMs: number;

  /** Ring buffer of recent batch outcomes: true = had errors */
  private readonly samples: boolean[] = [];
  private state: BreakerState = "CLOSED";
  private tripTime: number | null = null;

  constructor(config: CircuitBreakerConfig = {}) {
    this.errorThresholdRate = config.errorThresholdRate ?? 0.5;
    this.minSamples = config.minSamples ?? 3;
    this.resetAfterMs = config.resetAfterMs ?? 10_000;
  }

  /**
   * Call before starting dispatch for a batch.
   * Returns the current breaker state.
   * If OPEN and enough time has passed, transitions to HALF_OPEN automatically.
   */
  evaluate(): BreakerState {
    if (this.state === "OPEN") {
      const elapsed = Date.now() - (this.tripTime ?? 0);
      if (elapsed >= this.resetAfterMs) {
        this.state = "HALF_OPEN";
      }
    }
    return this.state;
  }

  /**
   * Call after a batch completes (whether or not errors occurred).
   * @param hadErrors true if any records in the batch errored
   */
  recordResult(hadErrors: boolean): void {
    this.samples.push(hadErrors);
    // Keep only the last `minSamples * 2` samples to bound memory.
    if (this.samples.length > this.minSamples * 2) {
      this.samples.shift();
    }

    if (this.state === "HALF_OPEN") {
      // One successful batch in HALF_OPEN resets the breaker.
      if (!hadErrors) {
        this.state = "CLOSED";
        this.samples.length = 0;
        this.tripTime = null;
      } else {
        // Still failing — trip again.
        this.trip();
      }
      return;
    }

    if (this.state === "CLOSED" && this.samples.length >= this.minSamples) {
      const errorCount = this.samples.filter(Boolean).length;
      const rate = errorCount / this.samples.length;
      if (rate >= this.errorThresholdRate) {
        this.trip();
      }
    }
  }

  /** Manually trip the breaker (also called internally). */
  trip(): void {
    this.state = "OPEN";
    this.tripTime = Date.now();
  }

  /** Reset to CLOSED (for testing / manual recovery). */
  reset(): void {
    this.state = "CLOSED";
    this.samples.length = 0;
    this.tripTime = null;
  }

  get currentState(): BreakerState {
    return this.state;
  }
}
