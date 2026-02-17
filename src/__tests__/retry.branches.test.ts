/**
 * Branch coverage tests for src/utils/retry.ts
 *
 * Targets uncovered branches in defaultRetryOn:
 * - SSRF blocked via code property (without AppError name)
 * - AbortError / TimeoutError names
 * - Various network error patterns
 * - HTTP 5xx via status property
 * - HTTP 4xx via status property
 * - 5xx in error message (statusMatch)
 * - 4xx in error message (clientStatusMatch)
 * - Non-Error thrown (unknown errors)
 * - error.message with no matching patterns (falls through to return true)
 * - computeDelay edge: delay exceeds maxDelayMs (capped)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry, computeDelay } from '../utils/retry';

vi.mock('../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('retry — branch coverage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // defaultRetryOn branches
  // -----------------------------------------------------------------------

  describe('defaultRetryOn — SSRF blocked via code (not AppError)', () => {
    it('does not retry when error has code=ssrf_blocked but is a plain Error', async () => {
      const err = Object.assign(new Error('blocked'), { code: 'ssrf_blocked' });
      const fn = vi.fn().mockRejectedValue(err);

      await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow('blocked');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('defaultRetryOn — AbortError', () => {
    it('does not retry on AbortError', async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      const fn = vi.fn().mockRejectedValue(err);

      await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow('aborted');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('defaultRetryOn — TimeoutError', () => {
    it('does not retry on TimeoutError', async () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      const fn = vi.fn().mockRejectedValue(err);

      await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow('timed out');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('defaultRetryOn — network error patterns', () => {
    const patterns = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'UND_ERR_SOCKET',
      'fetch failed',
      'network error',
    ];

    for (const pattern of patterns) {
      it(`retries on "${pattern}" in error message`, async () => {
        const fn = vi.fn()
          .mockRejectedValueOnce(new Error(`Something ${pattern} happened`))
          .mockResolvedValue('ok');

        const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 });
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
      });
    }
  });

  describe('defaultRetryOn — HTTP status via error.status', () => {
    it('retries on 500 status', async () => {
      const err = Object.assign(new Error('Server Error'), { status: 500 });
      const fn = vi.fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValue('recovered');

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 });
      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries on 503 status', async () => {
      const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
      const fn = vi.fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValue('ok');

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 });
      expect(result).toBe('ok');
    });

    it('does not retry on 400 status', async () => {
      const err = Object.assign(new Error('Bad Request'), { status: 400 });
      const fn = vi.fn().mockRejectedValue(err);

      await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow('Bad Request');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not retry on 404 status', async () => {
      const err = Object.assign(new Error('Not Found'), { status: 404 });
      const fn = vi.fn().mockRejectedValue(err);

      await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow('Not Found');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not retry on 429 status', async () => {
      const err = Object.assign(new Error('Too Many Requests'), { status: 429 });
      const fn = vi.fn().mockRejectedValue(err);

      await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('defaultRetryOn — status code in error message', () => {
    it('retries when message contains 5xx status code', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('HTTP response 502 Bad Gateway'))
        .mockResolvedValue('ok');

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('does not retry when message contains 4xx status code', async () => {
      // Make sure there is no network pattern and no 5xx
      const err = new Error('received status 403 from server');
      const fn = vi.fn().mockRejectedValue(err);

      await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on 500 in message even without status property', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('got 500 from upstream'))
        .mockResolvedValue('fine');

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 });
      expect(result).toBe('fine');
    });
  });

  describe('defaultRetryOn — non-Error values', () => {
    it('retries when a string is thrown (unknown error)', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce('random string error')
        .mockResolvedValue('ok');

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries when a number is thrown', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(42)
        .mockResolvedValue('ok');

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 });
      expect(result).toBe('ok');
    });

    it('retries when null is thrown', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(null)
        .mockResolvedValue('ok');

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 });
      expect(result).toBe('ok');
    });

    it('throws non-Error value after exhausting retries', async () => {
      const fn = vi.fn().mockRejectedValue('persistent string error');

      await expect(
        withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 })
      ).rejects.toBe('persistent string error');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('defaultRetryOn — Error with no matching pattern', () => {
    it('retries generic Error with unrecognized message (falls through to return true)', async () => {
      // An Error that doesn't match any network pattern, has no status, no 4xx/5xx in message
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('something unexpected'))
        .mockResolvedValue('ok');

      // defaultRetryOn returns true for Error instances that don't match any exclusion
      // Actually — it falls through: no network pattern match, no status, no status in msg
      // Then it reaches the end and returns true (unknown errors retry)
      // Wait — let me re-read: after checking network patterns (no match), status (not present),
      // statusMatch (no 5xx in msg), clientStatusMatch (no 4xx in msg), it exits the
      // `if (error instanceof Error)` block and returns true.
      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // withRetry — other branch coverage
  // -----------------------------------------------------------------------

  describe('withRetry options merging', () => {
    it('uses defaults when no options provided', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const result = await withRetry(fn);
      expect(result).toBe('ok');
    });

    it('uses partial options, filling rest with defaults', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue('ok');

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1 });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('withRetry — maxRetries = 0', () => {
    it('does not retry at all when maxRetries is 0', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow('fail');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('withRetry — retryOn predicate interaction', () => {
    it('custom retryOn can override default and allow 4xx retries', async () => {
      const err = Object.assign(new Error('conflict'), { status: 409 });
      const fn = vi.fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValue('resolved');

      const result = await withRetry(fn, {
        maxRetries: 1,
        baseDelayMs: 1,
        maxDelayMs: 5,
        retryOn: () => true,
      });
      expect(result).toBe('resolved');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('custom retryOn can reject normally-retryable errors', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

      await expect(
        withRetry(fn, { maxRetries: 3, baseDelayMs: 1, retryOn: () => false })
      ).rejects.toThrow('ECONNRESET');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // computeDelay — branch coverage
  // -----------------------------------------------------------------------

  describe('computeDelay — cap branch', () => {
    it('caps delay at maxDelayMs when exponential + jitter exceeds it', () => {
      // attempt=10 with baseDelay=200 => 200 * 2^10 = 204800 >> maxDelayMs=5000
      const delay = computeDelay(10, 200, 5000);
      expect(delay).toBe(5000);
    });

    it('does not cap when delay is under maxDelayMs', () => {
      // attempt=0, base=100, max=10000 => 100 * 1 + jitter(0-100) = [100, 200)
      const delay = computeDelay(0, 100, 10000);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThan(10000);
    });
  });

  // -----------------------------------------------------------------------
  // SSRF blocked via AppError name + code
  // -----------------------------------------------------------------------

  describe('defaultRetryOn — AppError with ssrf_blocked', () => {
    it('does not retry AppError with ssrf_blocked code', async () => {
      const err = Object.assign(new Error('SSRF'), {
        name: 'AppError',
        code: 'ssrf_blocked',
      });
      const fn = vi.fn().mockRejectedValue(err);

      await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow('SSRF');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries AppError with non-ssrf code', async () => {
      const err = Object.assign(new Error('some app error'), {
        name: 'AppError',
        code: 'something_else',
      });
      const fn = vi.fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValue('ok');

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 });
      expect(result).toBe('ok');
    });
  });

  // -----------------------------------------------------------------------
  // Edge: error with status >= 600 (not 4xx or 5xx)
  // -----------------------------------------------------------------------

  describe('defaultRetryOn — status outside 4xx/5xx', () => {
    it('does not match 5xx or 4xx branch for status 200', async () => {
      // Has status property but it is 200 — neither 4xx nor 5xx
      // Falls through to message pattern checks, then to return true
      const err = Object.assign(new Error('weird error with status'), { status: 200 });
      const fn = vi.fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValue('ok');

      const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 });
      expect(result).toBe('ok');
    });
  });
});
