/**
 * Base class for all connector errors.
 * The engine uses error type to decide retry strategy and health status.
 */
export class ConnectorError extends Error {
  /** Short machine-readable error code (e.g. 'FETCH_FAILED', 'INVALID_RESPONSE'). */
  readonly code: string;

  /** Whether the engine should retry this operation with backoff.
   *  Set true for transient failures (network, 5xx). Set false for permanent ones (bad config). */
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable = true) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Thrown when the external API responds with 429 Too Many Requests.
 * The engine pauses and retries after retryAfterMs (or uses exponential backoff if unset).
 */
export class RateLimitError extends ConnectorError {
  /** Milliseconds to wait before retrying, if provided by the API (e.g. Retry-After header). */
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message, "RATE_LIMITED", true);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Thrown when credentials are invalid or expired (401/403).
 * The engine pauses the run, attempts a token refresh, retries once,
 * then marks the instance unhealthy if it still fails.
 */
export class AuthError extends ConnectorError {
  constructor(message: string) {
    super(message, "AUTH_FAILED", false);
    this.name = "AuthError";
  }
}

/**
 * Thrown when input data is structurally invalid (bad payload shape, missing fields, etc.).
 * The engine skips the offending record, logs the error, and continues.
 * Use status: 'error' on write results for per-record validation failures instead of throwing.
 */
export class ValidationError extends ConnectorError {
  constructor(message: string) {
    super(message, "VALIDATION_FAILED", false);
    this.name = "ValidationError";
  }
}
