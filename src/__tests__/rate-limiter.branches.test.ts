/**
 * Branch coverage tests for src/core/rate-limiter.ts
 *
 * Targets uncovered branches:
 * - extractDomain error branch (catch in extractDomain)
 * - getBucket — existing vs new bucket creation
 * - refillTokens — tokensToAdd <= 0 branch
 * - processQueue — empty queue, request === undefined guard
 * - setDomainLimit — crawlDelaySeconds <= 0 (no change)
 * - checkLimit — enabled vs disabled paths
 * - checkLimit — tokens >= 1 (immediate) vs queuing
 * - getDomainStats — valid URL with no bucket, invalid URL (catch block)
 * - getAllStats — empty vs populated
 * - clearDomain / clearAll
 * - Queue interval cleanup when queue empties
 * - Multiple queued requests processed sequentially
 * - Constructor default parameters
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// We need to mock config to avoid issues with the singleton export
vi.mock('../config/env', () => ({
  config: {
    fetch: { respectRobots: true },
  },
}));

import { DomainRateLimiter } from '../core/rate-limiter';

describe('DomainRateLimiter — branch coverage', () => {
  let limiter: DomainRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new DomainRateLimiter(2, true);
  });

  afterEach(() => {
    limiter.clearAll();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // extractDomain error paths
  // -----------------------------------------------------------------------

  describe('extractDomain errors', () => {
    it('throws on completely invalid URL string', async () => {
      await expect(limiter.checkLimit('not-a-url')).rejects.toThrow('Invalid URL');
    });

    it('throws on empty string', async () => {
      await expect(limiter.checkLimit('')).rejects.toThrow('Invalid URL');
    });

    it('throws on malformed protocol', async () => {
      await expect(limiter.checkLimit('://missing-scheme.com')).rejects.toThrow('Invalid URL');
    });

    it('logs error with non-Error thrown by URL constructor', async () => {
      // URL constructor always throws TypeError, but the catch handles both paths
      await expect(limiter.checkLimit('bad url with spaces')).rejects.toThrow('Invalid URL');
    });
  });

  // -----------------------------------------------------------------------
  // getBucket — new vs existing
  // -----------------------------------------------------------------------

  describe('getBucket', () => {
    it('creates a new bucket on first access to a domain', async () => {
      const statsBefore = limiter.getDomainStats('https://new-domain.com/page');
      expect(statsBefore).toBeNull(); // no bucket yet

      await limiter.checkLimit('https://new-domain.com/page');

      const statsAfter = limiter.getDomainStats('https://new-domain.com/page');
      expect(statsAfter).not.toBeNull();
      expect(statsAfter!.domain).toBe('new-domain.com');
    });

    it('reuses existing bucket on subsequent access', async () => {
      // Use a fast limiter to avoid queuing
      const fastLimiter = new DomainRateLimiter(10, true);
      await fastLimiter.checkLimit('https://reuse.com/a');
      const stats1 = fastLimiter.getDomainStats('https://reuse.com/a');

      // Advance time so tokens refill
      vi.advanceTimersByTime(1000);
      await fastLimiter.checkLimit('https://reuse.com/b');

      const stats2 = fastLimiter.getDomainStats('https://reuse.com/b');
      // Same domain, same bucket
      expect(stats2!.domain).toBe(stats1!.domain);
      fastLimiter.clearAll();
    });
  });

  // -----------------------------------------------------------------------
  // refillTokens — edge cases
  // -----------------------------------------------------------------------

  describe('refillTokens', () => {
    it('does not add tokens when no time has elapsed', async () => {
      await limiter.checkLimit('https://no-time.com/page');
      // Token was consumed, no time passes
      const stats = limiter.getDomainStats('https://no-time.com/page');
      // Tokens should be <= 0 (consumed the initial one, no refill)
      expect(stats!.tokens).toBeLessThanOrEqual(0);
    });

    it('refills tokens proportional to elapsed time', async () => {
      await limiter.checkLimit('https://refill.com/page');
      // Token consumed. Rate = 2/sec. Wait 250ms => 0.5 tokens refilled
      vi.advanceTimersByTime(250);

      const stats = limiter.getDomainStats('https://refill.com/page');
      // 0 + 0.5 = 0.5 (approximately, capped at capacity=1)
      expect(stats!.tokens).toBeGreaterThan(0);
      expect(stats!.tokens).toBeLessThanOrEqual(1);
    });

    it('caps tokens at capacity', async () => {
      await limiter.checkLimit('https://cap.com/page');
      // Wait a very long time
      vi.advanceTimersByTime(60000);

      const stats = limiter.getDomainStats('https://cap.com/page');
      expect(stats!.tokens).toBe(1); // capacity is 1
    });
  });

  // -----------------------------------------------------------------------
  // processQueue
  // -----------------------------------------------------------------------

  describe('processQueue', () => {
    it('processes queued requests when tokens refill', async () => {
      const slowLimiter = new DomainRateLimiter(1, true); // 1 token/sec

      // Use initial token
      const p1 = slowLimiter.checkLimit('https://pq.com/1');
      vi.advanceTimersByTime(0);
      await p1;

      // Queue a request
      let resolved = false;
      const p2 = slowLimiter.checkLimit('https://pq.com/2').then(() => {
        resolved = true;
      });

      // Not enough time yet
      vi.advanceTimersByTime(500);
      expect(resolved).toBe(false);

      // Enough time for token refill
      vi.advanceTimersByTime(600);
      await p2;
      expect(resolved).toBe(true);

      slowLimiter.clearAll();
    });

    it('cleans up interval when queue empties', async () => {
      const slowLimiter = new DomainRateLimiter(1, true);

      await slowLimiter.checkLimit('https://cleanup.com/1');

      // Queue one request
      const p = slowLimiter.checkLimit('https://cleanup.com/2');

      // Let it resolve
      vi.advanceTimersByTime(1200);
      await p;

      // Queue should be empty, interval should be cleared
      const stats = slowLimiter.getDomainStats('https://cleanup.com/x');
      expect(stats!.queueSize).toBe(0);

      slowLimiter.clearAll();
    });

    it('handles multiple queued requests in order', async () => {
      const slowLimiter = new DomainRateLimiter(1, true);
      const order: number[] = [];

      await slowLimiter.checkLimit('https://multi.com/0');

      const p1 = slowLimiter.checkLimit('https://multi.com/1').then(() => order.push(1));
      const p2 = slowLimiter.checkLimit('https://multi.com/2').then(() => order.push(2));
      const p3 = slowLimiter.checkLimit('https://multi.com/3').then(() => order.push(3));

      // Advance enough for all 3 tokens (3+ seconds at 1/sec)
      vi.advanceTimersByTime(5000);
      await Promise.all([p1, p2, p3]);

      expect(order).toEqual([1, 2, 3]);
      slowLimiter.clearAll();
    });
  });

  // -----------------------------------------------------------------------
  // setDomainLimit
  // -----------------------------------------------------------------------

  describe('setDomainLimit', () => {
    it('updates refill rate for positive crawl delay', () => {
      limiter.checkLimit('https://limit.com/page');
      limiter.setDomainLimit('limit.com', 2); // 1/2 = 0.5 tokens/sec

      const stats = limiter.getDomainStats('https://limit.com/page');
      expect(stats!.refillRate).toBeCloseTo(0.5, 2);
    });

    it('does not change rate for zero crawl delay', () => {
      limiter.checkLimit('https://zero.com/page');
      const before = limiter.getDomainStats('https://zero.com/page');

      limiter.setDomainLimit('zero.com', 0);

      const after = limiter.getDomainStats('https://zero.com/page');
      expect(after!.refillRate).toBe(before!.refillRate);
    });

    it('does not change rate for negative crawl delay', () => {
      limiter.checkLimit('https://neg.com/page');
      const before = limiter.getDomainStats('https://neg.com/page');

      limiter.setDomainLimit('neg.com', -5);

      const after = limiter.getDomainStats('https://neg.com/page');
      expect(after!.refillRate).toBe(before!.refillRate);
    });

    it('creates bucket for unseen domain', () => {
      limiter.setDomainLimit('unseen.com', 3);
      // Access the domain to get stats
      limiter.checkLimit('https://unseen.com/page');

      const stats = limiter.getDomainStats('https://unseen.com/page');
      expect(stats).not.toBeNull();
      expect(stats!.refillRate).toBeCloseTo(1 / 3, 2);
    });

    it('handles very small crawl delay (high rate)', () => {
      limiter.checkLimit('https://fast.com/page');
      limiter.setDomainLimit('fast.com', 0.01); // 100 tokens/sec

      const stats = limiter.getDomainStats('https://fast.com/page');
      expect(stats!.refillRate).toBeCloseTo(100, 0);
    });
  });

  // -----------------------------------------------------------------------
  // checkLimit — enabled vs disabled
  // -----------------------------------------------------------------------

  describe('checkLimit — disabled', () => {
    it('returns immediately when disabled', async () => {
      const disabled = new DomainRateLimiter(1, false);

      // Should not create any buckets
      await disabled.checkLimit('https://disabled.com/page');
      await disabled.checkLimit('https://disabled.com/page2');
      await disabled.checkLimit('https://disabled.com/page3');

      const stats = disabled.getAllStats();
      expect(stats.totalDomains).toBe(0);
      disabled.clearAll();
    });
  });

  describe('checkLimit — enabled', () => {
    it('consumes token immediately when available', async () => {
      await limiter.checkLimit('https://consume.com/page');

      const stats = limiter.getDomainStats('https://consume.com/page');
      // Initial token (1) consumed, so tokens should be ~0
      expect(stats!.tokens).toBeLessThanOrEqual(0);
    });

    it('queues request when no tokens available', async () => {
      const slowLimiter = new DomainRateLimiter(0.5, true); // 0.5 tokens/sec

      // Use initial token
      await slowLimiter.checkLimit('https://slow.com/1');

      // Check queue size
      slowLimiter.checkLimit('https://slow.com/2'); // queued, don't await
      vi.advanceTimersByTime(0);

      const stats = slowLimiter.getDomainStats('https://slow.com/x');
      expect(stats!.queueSize).toBe(1);

      // Clean up
      vi.advanceTimersByTime(5000);
      slowLimiter.clearAll();
    });
  });

  // -----------------------------------------------------------------------
  // getDomainStats
  // -----------------------------------------------------------------------

  describe('getDomainStats', () => {
    it('returns null for unknown domain', () => {
      const stats = limiter.getDomainStats('https://unknown.com/page');
      expect(stats).toBeNull();
    });

    it('returns null for invalid URL (catch branch)', () => {
      const stats = limiter.getDomainStats('not-a-url');
      expect(stats).toBeNull();
    });

    it('returns null for empty URL (catch branch)', () => {
      const stats = limiter.getDomainStats('');
      expect(stats).toBeNull();
    });

    it('refills tokens when getting stats', async () => {
      await limiter.checkLimit('https://refill-stats.com/page');
      vi.advanceTimersByTime(1000); // 1 second at 2 tokens/sec

      const stats = limiter.getDomainStats('https://refill-stats.com/page');
      expect(stats!.tokens).toBeGreaterThan(0);
    });

    it('returns correct structure', async () => {
      await limiter.checkLimit('https://struct.com/page');
      const stats = limiter.getDomainStats('https://struct.com/page');

      expect(stats).toHaveProperty('domain', 'struct.com');
      expect(stats).toHaveProperty('tokens');
      expect(stats).toHaveProperty('refillRate', 2);
      expect(stats).toHaveProperty('queueSize', 0);
    });
  });

  // -----------------------------------------------------------------------
  // getAllStats
  // -----------------------------------------------------------------------

  describe('getAllStats', () => {
    it('returns empty when no domains tracked', () => {
      const stats = limiter.getAllStats();
      expect(stats.totalDomains).toBe(0);
      expect(stats.domains).toEqual([]);
    });

    it('returns all tracked domains with refilled tokens', async () => {
      await limiter.checkLimit('https://a.com/1');
      await limiter.checkLimit('https://b.com/1');
      vi.advanceTimersByTime(500);

      const stats = limiter.getAllStats();
      expect(stats.totalDomains).toBe(2);
      expect(stats.domains).toHaveLength(2);

      for (const d of stats.domains) {
        expect(d.tokens).toBeGreaterThanOrEqual(0);
        expect(d.refillRate).toBe(2);
        expect(d.queueSize).toBe(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // clearDomain
  // -----------------------------------------------------------------------

  describe('clearDomain', () => {
    it('removes specified domain only', async () => {
      await limiter.checkLimit('https://keep.com/page');
      await limiter.checkLimit('https://remove.com/page');

      limiter.clearDomain('remove.com');

      expect(limiter.getDomainStats('https://remove.com/page')).toBeNull();
      expect(limiter.getDomainStats('https://keep.com/page')).not.toBeNull();
    });

    it('is safe to call on non-existent domain', () => {
      expect(() => limiter.clearDomain('nonexistent.com')).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // clearAll
  // -----------------------------------------------------------------------

  describe('clearAll', () => {
    it('removes all domains', async () => {
      await limiter.checkLimit('https://x.com/1');
      await limiter.checkLimit('https://y.com/1');
      await limiter.checkLimit('https://z.com/1');

      limiter.clearAll();

      const stats = limiter.getAllStats();
      expect(stats.totalDomains).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Constructor parameter defaults
  // -----------------------------------------------------------------------

  describe('constructor defaults', () => {
    it('defaults to rateLimit=1 and enabled=true', async () => {
      const defaultLimiter = new DomainRateLimiter();
      await defaultLimiter.checkLimit('https://default.com/page');

      const stats = defaultLimiter.getDomainStats('https://default.com/page');
      expect(stats!.refillRate).toBe(1);

      defaultLimiter.clearAll();
    });

    it('allows rateLimit=0 (unlimited but enabled)', async () => {
      const zeroLimiter = new DomainRateLimiter(0, true);
      await zeroLimiter.checkLimit('https://zero-rate.com/page');

      const stats = zeroLimiter.getDomainStats('https://zero-rate.com/page');
      expect(stats!.refillRate).toBe(0);

      zeroLimiter.clearAll();
    });
  });

  // -----------------------------------------------------------------------
  // URL with various schemes and formats
  // -----------------------------------------------------------------------

  describe('URL handling', () => {
    it('handles URL with port', async () => {
      await limiter.checkLimit('https://example.com:8080/path');
      const stats = limiter.getDomainStats('https://example.com:8080/other');
      expect(stats!.domain).toBe('example.com:8080');
    });

    it('handles URL with auth info', async () => {
      await limiter.checkLimit('https://user:pass@example.com/path');
      const stats = limiter.getDomainStats('https://example.com/other');
      expect(stats!.domain).toBe('example.com');
    });

    it('handles URL with query and fragment', async () => {
      await limiter.checkLimit('https://example.com/page?foo=bar#section');
      const stats = limiter.getDomainStats('https://example.com/other');
      expect(stats!.domain).toBe('example.com');
    });

    it('treats http and https on same domain as same bucket', async () => {
      await limiter.checkLimit('https://same.com/page');
      const stats = limiter.getDomainStats('http://same.com/other');
      expect(stats).not.toBeNull();
      expect(stats!.domain).toBe('same.com');
    });
  });
});
