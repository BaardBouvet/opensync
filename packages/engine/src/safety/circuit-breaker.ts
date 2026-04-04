// Spec: specs/safety.md § Circuit Breakers
// Spec: plans/engine/PLAN_PRODUCTION_ENGINE_M2.md §7 — Gap 2: persist trip state to DB

import type { Db } from "../db/index.js";
import { dbLogCircuitBreakerEvent, dbGetRecentCircuitBreakerEvents } from "../db/queries.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  errorRateThreshold?: number; // 0..1, default 0.5
  minSamples?: number;         // minimum batches before evaluating, default 3
  resetAfterMs?: number;       // ms before OPEN → HALF_OPEN, default 10_000
}

/** Per-channel persisted circuit breaker.
 *  Trip events are written to circuit_breaker_events table so state survives restarts.
 *  Spec: plans/engine/PLAN_PRODUCTION_ENGINE_M2.md §7 (Gap 2) */
export class CircuitBreaker {
  private readonly errorRateThreshold: number;
  private readonly minSamples: number;
  private readonly resetAfterMs: number;
  private readonly channelId: string;
  private readonly db: Db;

  // In-memory ring buffer (results from the current run since last reset)
  private results: boolean[] = []; // true = error
  private state: CircuitState = "CLOSED";
  private openedAt: number | undefined;

  constructor(channelId: string, db: Db, config?: CircuitBreakerConfig) {
    this.channelId = channelId;
    this.db = db;
    this.errorRateThreshold = config?.errorRateThreshold ?? 0.5;
    this.minSamples = config?.minSamples ?? 3;
    this.resetAfterMs = config?.resetAfterMs ?? 10_000;

    // Spec: plans/engine/PLAN_PRODUCTION_ENGINE_M2.md §7.2 — restore state on construction
    this._restoreFromDb();
  }

  /** Check current state. Call at the start of ingest() before any I/O. */
  evaluate(): CircuitState {
    if (this.state === "OPEN") {
      const elapsed = Date.now() - (this.openedAt ?? 0);
      if (elapsed >= this.resetAfterMs) {
        this.state = "HALF_OPEN";
        dbLogCircuitBreakerEvent(this.db, this.channelId, "half_open");
      }
    }
    return this.state;
  }

  /** Record the outcome of a batch. Call after ingest() or _processRecords(). */
  recordResult(hadErrors: boolean): void {
    if (this.state === "OPEN") return; // absorb — don't change ring buffer while open

    this.results.push(hadErrors);
    if (this.results.length > 20) this.results.shift(); // cap the ring buffer

    if (this.state === "HALF_OPEN") {
      if (hadErrors) {
        this._trip("half-open probe failed");
      } else {
        this.state = "CLOSED";
        this.results = [];
        dbLogCircuitBreakerEvent(this.db, this.channelId, "reset");
      }
      return;
    }

    // CLOSED — evaluate error rate
    if (this.results.length >= this.minSamples) {
      const errorRate = this.results.filter(Boolean).length / this.results.length;
      if (errorRate >= this.errorRateThreshold) {
        this._trip(`error rate ${(errorRate * 100).toFixed(0)}% exceeded threshold`);
      }
    }
  }

  /** Manually trip the breaker (e.g. volume threshold exceeded). */
  trip(reason: string): void {
    this._trip(reason);
  }

  /** Manually reset the breaker. */
  reset(): void {
    this.state = "CLOSED";
    this.results = [];
    this.openedAt = undefined;
    dbLogCircuitBreakerEvent(this.db, this.channelId, "reset", "manual reset");
  }

  get currentState(): CircuitState {
    return this.state;
  }

  private _trip(reason: string): void {
    this.state = "OPEN";
    this.openedAt = Date.now();
    dbLogCircuitBreakerEvent(this.db, this.channelId, "trip", reason);
  }

  /** Replay recent circuit_breaker_events to restore state after a restart.
   *  Spec: plans/engine/PLAN_PRODUCTION_ENGINE_M2.md §7.2 */
  private _restoreFromDb(): void {
    const since = Date.now() - this.resetAfterMs * 10; // look back up to 10x the reset window
    const events = dbGetRecentCircuitBreakerEvents(this.db, this.channelId, since);
    if (events.length === 0) return;

    const latest = events[0]; // most recent first
    if (latest.event === "trip") {
      this.state = "OPEN";
      this.openedAt = new Date(latest.occurred_at).getTime();

      // Maybe it's already past the reset window
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.resetAfterMs) {
        this.state = "HALF_OPEN";
      }
    } else if (latest.event === "reset") {
      this.state = "CLOSED";
    } else if (latest.event === "half_open") {
      this.state = "HALF_OPEN";
    }
  }
}
