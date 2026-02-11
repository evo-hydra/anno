import { describe, it, expect, vi } from 'vitest';
import { withRetry, computeDelay } from '../utils/retry';

// Mock the logger to avoid noise in test output
vi.mock('../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('withRetry', () => {
  it('succeeds on first try without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const result = await withRetry(fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 5 });

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries and throws last error', async () => {
    const error = new Error('ECONNREFUSED');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 })
    ).rejects.toThrow('ECONNREFUSED');

    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('respects maxRetries option', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fetch failed'));

    await expect(
      withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 })
    ).rejects.toThrow('fetch failed');

    expect(fn).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });

  it('does not retry when retryOn returns false', async () => {
    const error = new Error('not retryable');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, { retryOn: () => false })
    ).rejects.toThrow('not retryable');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 4xx errors by default', async () => {
    const error = Object.assign(new Error('HTTP 404: Not Found'), { status: 404 });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn)).rejects.toThrow('HTTP 404');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry on SSRF errors', async () => {
    const error = Object.assign(new Error('SSRF blocked'), {
      name: 'AppError',
      code: 'ssrf_blocked',
    });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn)).rejects.toThrow('SSRF blocked');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('applies exponential backoff (verify delays increase)', async () => {
    const timestamps: number[] = [];
    let callCount = 0;

    const fn = vi.fn().mockImplementation(async () => {
      timestamps.push(Date.now());
      callCount++;
      if (callCount <= 3) {
        throw new Error('ECONNRESET');
      }
      return 'ok';
    });

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 5000 });

    expect(result).toBe('ok');
    expect(timestamps.length).toBe(4); // 1 initial + 3 retries, succeeds on 4th

    // Verify delays increase (exponential backoff)
    const delays: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      delays.push(timestamps[i] - timestamps[i - 1]);
    }

    // delay[0]: ~50ms (50 * 2^0 + jitter), delay[1]: ~100ms (50 * 2^1 + jitter), delay[2]: ~200ms (50 * 2^2 + jitter)
    // Each subsequent delay should be larger than the previous (with some tolerance for jitter)
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
  });

  it('respects maxDelayMs cap', async () => {
    const timestamps: number[] = [];
    let callCount = 0;

    const fn = vi.fn().mockImplementation(async () => {
      timestamps.push(Date.now());
      callCount++;
      if (callCount <= 5) {
        throw new Error('ECONNRESET');
      }
      return 'ok';
    });

    // maxDelayMs of 20ms should cap all delays
    const result = await withRetry(fn, { maxRetries: 5, baseDelayMs: 10, maxDelayMs: 20 });

    expect(result).toBe('ok');

    // All delays should be <= maxDelayMs (with some tolerance for timer imprecision)
    for (let i = 1; i < timestamps.length; i++) {
      const delay = timestamps[i] - timestamps[i - 1];
      // Allow 50ms tolerance for timer imprecision in CI
      expect(delay).toBeLessThanOrEqual(70);
    }
  });
});

describe('computeDelay', () => {
  it('applies exponential backoff (verify delays increase)', () => {
    const delay0 = computeDelay(0, 200, 5000); // 200 * 2^0 + jitter = 200 + [0, 200)
    const delay1 = computeDelay(1, 200, 5000); // 200 * 2^1 + jitter = 400 + [0, 200)
    const delay2 = computeDelay(2, 200, 5000); // 200 * 2^2 + jitter = 800 + [0, 200)

    // delay0: [200, 400), delay1: [400, 600), delay2: [800, 1000)
    expect(delay0).toBeGreaterThanOrEqual(200);
    expect(delay0).toBeLessThan(400);
    expect(delay1).toBeGreaterThanOrEqual(400);
    expect(delay1).toBeLessThan(600);
    expect(delay2).toBeGreaterThanOrEqual(800);
    expect(delay2).toBeLessThan(1000);
  });

  it('respects maxDelayMs cap', () => {
    const delay = computeDelay(20, 200, 5000);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it('returns value within expected range for first attempt', () => {
    const delay = computeDelay(0, 100, 10000);
    // 100 * 2^0 + jitter where jitter in [0, 100)
    expect(delay).toBeGreaterThanOrEqual(100);
    expect(delay).toBeLessThan(200);
  });
});
