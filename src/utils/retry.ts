/**
 * Generic retry utility with exponential backoff and jitter.
 *
 * @module utils/retry
 */

import { logger } from './logger';

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds before first retry (default: 200) */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds (default: 5000) */
  maxDelayMs?: number;
  /** Predicate to decide if an error is retryable. Return true to retry. */
  retryOn?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 5000,
  retryOn: defaultRetryOn,
};

/**
 * Default retry predicate: retry on network errors and HTTP 5xx responses.
 * Do not retry on 4xx errors or SSRF-blocked errors.
 */
function defaultRetryOn(error: unknown): boolean {
  if (error instanceof Error) {
    // Don't retry SSRF blocks
    if ('code' in error && (error as { code: string }).code === 'ssrf_blocked') {
      return false;
    }
    if (error.name === 'AppError' && 'code' in error && (error as { code: string }).code === 'ssrf_blocked') {
      return false;
    }

    // Don't retry abort/timeout errors
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return false;
    }

    // Retry on network/fetch errors (e.g., ECONNREFUSED, ECONNRESET, UND_ERR_SOCKET)
    const networkErrorPatterns = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'UND_ERR',
      'fetch failed',
      'network',
    ];
    const msg = error.message.toLowerCase();
    if (networkErrorPatterns.some((p) => msg.includes(p.toLowerCase()))) {
      return true;
    }

    // Retry on HTTP 5xx status codes (conveyed via error message or status property)
    if ('status' in error) {
      const status = (error as { status: number }).status;
      if (status >= 500 && status < 600) return true;
      if (status >= 400 && status < 500) return false;
    }

    // Check message for status code hints
    const statusMatch = error.message.match(/\b(5\d{2})\b/);
    if (statusMatch) return true;

    const clientStatusMatch = error.message.match(/\b(4\d{2})\b/);
    if (clientStatusMatch) return false;
  }

  // Unknown errors: retry by default
  return true;
}

/**
 * Compute delay for a given attempt using exponential backoff with jitter.
 * Formula: min(baseDelay * 2^attempt + random_jitter, maxDelay)
 */
export function computeDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic and exponential backoff.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration options
 * @returns The result of the function call
 * @throws The last error encountered after all retries are exhausted
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // If we've exhausted all retries, throw
      if (attempt >= opts.maxRetries) {
        break;
      }

      // Check if the error is retryable
      if (!opts.retryOn(error)) {
        throw error;
      }

      const delay = computeDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);

      logger.warn('Retrying after transient error', {
        attempt: attempt + 1,
        maxRetries: opts.maxRetries,
        delayMs: Math.round(delay),
        error: error instanceof Error ? error.message : String(error),
      });

      await sleep(delay);
    }
  }

  throw lastError;
}
