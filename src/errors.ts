import { redactString, sanitize } from "./sanitize.js";

/**
 * Every error this package throws is a LinkedInError with an `outcome`, so a
 * publisher can tell whether a write may have happened:
 *
 * - "not_sent": nothing reached LinkedIn (configuration, missing or expired token);
 * - "rejected": LinkedIn answered and refused it: nothing was created, fix the cause and retry;
 * - "unknown":  the request may have been processed (network failure, timeout, 5xx,
 *               or a success without the expected id): look for the post before retrying.
 *
 * Messages are redacted when the error is created.
 */

export type Outcome = "not_sent" | "rejected" | "unknown";

export interface ErrorDetails {
  status?: number;
  /** LinkedIn's serviceErrorCode / code from the error body, when present */
  serviceErrorCode?: number;
  code?: string;
}

export class LinkedInError extends Error {
  readonly outcome: Outcome;
  readonly status?: number;
  readonly serviceErrorCode?: number;
  readonly code?: string;

  constructor(message: string, outcome: Outcome, details: ErrorDetails = {}) {
    super(redactString(message));
    this.name = "LinkedInError";
    this.outcome = outcome;
    this.status = details.status;
    this.serviceErrorCode = details.serviceErrorCode;
    this.code = details.code;
  }

  toJSON() {
    return sanitize({
      error: this.name,
      message: this.message,
      outcome: this.outcome,
      http_status: this.status,
      service_error_code: this.serviceErrorCode,
      code: this.code,
    });
  }
}

/** Missing or invalid configuration. Never reaches LinkedIn. */
export class ConfigError extends LinkedInError {
  constructor(message: string) {
    super(message, "not_sent");
    this.name = "ConfigError";
  }
}

/**
 * No usable token, a token without the needed scope, or HTTP 401.
 * `reauthorize`: the owner must run `npm run auth` again.
 */
export class AuthError extends LinkedInError {
  readonly reauthorize: boolean;

  constructor(message: string, outcome: Outcome, details: ErrorDetails & { reauthorize?: boolean } = {}) {
    super(message, outcome, details);
    this.name = "AuthError";
    this.reauthorize = details.reauthorize ?? true;
  }
}

/** LinkedIn answered 4xx (other than 401 and 429): a confirmed refusal, nothing was created. */
export class ApiRefusalError extends LinkedInError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, "rejected", details);
    this.name = "ApiRefusalError";
  }
}

/** HTTP 429. Limits reset daily at midnight UTC; LinkedIn documents no Retry-After, but it is passed on when sent. */
export class RateLimitError extends LinkedInError {
  readonly retryAfterSeconds?: number;

  constructor(message: string, details: ErrorDetails & { retryAfterSeconds?: number } = {}) {
    super(message, "rejected", details);
    this.name = "RateLimitError";
    this.retryAfterSeconds = details.retryAfterSeconds;
  }

  override toJSON() {
    return { ...super.toJSON(), retry_after_seconds: this.retryAfterSeconds };
  }
}

/** HTTP 5xx: LinkedIn failed; a write may or may not have been applied. */
export class ServerError extends LinkedInError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, "unknown", details);
    this.name = "ServerError";
  }
}

/** The request may not have reached LinkedIn, or its answer was lost (incl. timeouts). */
export class NetworkError extends LinkedInError {
  constructor(message: string) {
    super(message, "unknown");
    this.name = "NetworkError";
  }
}

/** A 2xx answer that doesn't match the documented contract (bad JSON, missing id or fields). */
export class InvalidResponseError extends LinkedInError {
  constructor(message: string, details: ErrorDetails = {}) {
    super(message, "unknown", details);
    this.name = "InvalidResponseError";
  }
}
