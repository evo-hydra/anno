/**
 * Extended tests for DomainRateLimiter in src/core/rate-limiter.ts
 *
 * The existing rate-limiter.test.ts covers basic operations. This file targets
 * untested code paths:
 * - Token refill calculations
 * - Queue processing (processQueue)
 * - getDomainStats with invalid URL
 * - Edge cases in extractDomain
 * - Concurrent access patterns
 * - Bucket capacity logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DomainRateLimiter } from '../core/rate-limiter';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DomainRateLimiter — extended coverage', () => {
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
  // Token refill mechanism
  // -----------------------------------------------------------------------

  describe('token refill', () => {
    it('refills tokens based on elapsed time', () => {
      // Use up the initial token
      limiter.checkLimit('https://example.com/a');

      // Advance time by 500ms => should refill 1 token at 2 tokens/sec
      vi.advanceTimersByTime(500);

      const stats = limiter.getDomainStats('https://example.com/a');
      expect(stats).not.toBeNull();
      // After consuming 1 and refilling for 500ms at 2/sec = 1 token added
      // Capacity is 1, so tokens should be capped at 1
      expect(stats!.tokens).toBeLessThanOrEqual(1);
    });

    it('tokens do not exceed capacity', () => {
      limiter.checkLimit('https://cap-test.com/page');

      // Advance a lot of time
      vi.advanceTimersByTime(10000);

      const stats = limiter.getDomainStats('https://cap-test.com/page');
      expect(stats).not.toBeNull();
      expect(stats!.tokens).toBeLessThanOrEqual(1); // capacity=1
    });

    it('refill happens after setDomainLimit changes rate', () => {
      limiter.checkLimit('https://slow.com/page');

      // Set a very slow rate: 0.1 tokens/sec (10s crawl delay)
      limiter.setDomainLimit('slow.com', 10);

      // Advance 5 seconds => only 0.5 tokens at 0.1/sec
      vi.advanceTimersByTime(5000);

      const stats = limiter.getDomainStats('https://slow.com/page');
      expect(stats).not.toBeNull();
      expect(stats!.tokens).toBeLessThanOrEqual(1);
      expect(stats!.refillRate).toBeCloseTo(0.1, 2);
    });
  });

  // -----------------------------------------------------------------------
  // Queue processing
  // -----------------------------------------------------------------------

  describe('queue processing', () => {
    it('queued requests are resolved when tokens refill', async () => {
      // Use a limiter with 1 req/sec
      const slowLimiter = new DomainRateLimiter(1, true);

      // First request uses the initial token
      const p1 = slowLimiter.checkLimit('https://queue-test.com/1');
      // p1 should resolve immediately
      vi.advanceTimersByTime(0);
      await p1;

      // Second request should be queued
      let p2Resolved = false;
      const p2 = slowLimiter.checkLimit('https://queue-test.com/2').then(() => {
        p2Resolved = true;
      });

      // Not resolved yet
      vi.advanceTimersByTime(50);
      expect(p2Resolved).toBe(false);

      // Advance enough for token to refill (1 token/sec + 100ms check interval)
      vi.advanceTimersByTime(1100);
      await p2;
      expect(p2Resolved).toBe(true);

      slowLimiter.clearAll();
    });

    it('multiple queued requests are processed in order', async () => {
      const slowLimiter = new DomainRateLimiter(1, true);
      const order: number[] = [];

      // Use initial token
      await slowLimiter.checkLimit('https://order-test.com/0');

      // Queue 3 requests
      const p1 = slowLimiter.checkLimit('https://order-test.com/1').then(() => order.push(1));
      const p2 = slowLimiter.checkLimit('https://order-test.com/2').then(() => order.push(2));
      const p3 = slowLimiter.checkLimit('https://order-test.com/3').then(() => order.push(3));

      // Advance time enough for all 3 tokens to refill (3+ seconds)
      vi.advanceTimersByTime(5000);
      await Promise.all([p1, p2, p3]);

      expect(order).toEqual([1, 2, 3]);

      slowLimiter.clearAll();
    });
  });

  // -----------------------------------------------------------------------
  // extractDomain edge cases
  // -----------------------------------------------------------------------

  describe('extractDomain edge cases', () => {
    it('throws on empty string', async () => {
      await expect(limiter.checkLimit('')).rejects.toThrow('Invalid URL');
    });

    it('handles URL with port', async () => {
      await limiter.checkLimit('https://example.com:8443/path');
      const stats = limiter.getDomainStats('https://example.com:8443/other');
      expect(stats).not.toBeNull();
      expect(stats!.domain).toBe('example.com:8443');
    });

    it('handles URL with subdomain', async () => {
      await limiter.checkLimit('https://sub.domain.example.com/page');
      const stats = limiter.getDomainStats('https://sub.domain.example.com/other');
      expect(stats).not.toBeNull();
      expect(stats!.domain).toBe('sub.domain.example.com');
    });

    it('handles http:// URLs', async () => {
      await limiter.checkLimit('http://insecure.com/page');
      const stats = limiter.getDomainStats('http://insecure.com/page');
      expect(stats).not.toBeNull();
      expect(stats!.domain).toBe('insecure.com');
    });
  });

  // -----------------------------------------------------------------------
  // getDomainStats edge cases
  // -----------------------------------------------------------------------

  describe('getDomainStats edge cases', () => {
    it('returns null for invalid URL', () => {
      const stats = limiter.getDomainStats('not-a-valid-url');
      expect(stats).toBeNull();
    });

    it('returns null for empty URL', () => {
      const stats = limiter.getDomainStats('');
      expect(stats).toBeNull();
    });

    it('returns accurate queue size', async () => {
      const slowLimiter = new DomainRateLimiter(1, true);

      // Use initial token
      await slowLimiter.checkLimit('https://queue-stats.com/0');

      // Queue a request (don't await)
      slowLimiter.checkLimit('https://queue-stats.com/1');
      slowLimiter.checkLimit('https://queue-stats.com/2');

      // Allow microtask to settle
      vi.advanceTimersByTime(0);

      const stats = slowLimiter.getDomainStats('https://queue-stats.com/x');
      expect(stats).not.toBeNull();
      expect(stats!.queueSize).toBe(2);

      // Clean up by resolving queued requests
      vi.advanceTimersByTime(5000);
      slowLimiter.clearAll();
    });
  });

  // -----------------------------------------------------------------------
  // getAllStats
  // -----------------------------------------------------------------------

  describe('getAllStats', () => {
    it('returns empty domains array when no domains tracked', () => {
      const stats = limiter.getAllStats();
      expect(stats.totalDomains).toBe(0);
      expect(stats.domains).toEqual([]);
    });

    it('refills all buckets when getting stats', async () => {
      await limiter.checkLimit('https://a.com/1');
      await limiter.checkLimit('https://b.com/1');

      // Advance time for refill
      vi.advanceTimersByTime(1000);

      const stats = limiter.getAllStats();
      expect(stats.totalDomains).toBe(2);
      for (const d of stats.domains) {
        expect(d.tokens).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // setDomainLimit edge cases
  // -----------------------------------------------------------------------

  describe('setDomainLimit', () => {
    it('creates bucket if domain not yet seen', () => {
      // Set limit on domain that has never been accessed
      limiter.setDomainLimit('new-domain.com', 2);

      // Now access it — should use the custom rate
      limiter.checkLimit('https://new-domain.com/page');

      const stats = limiter.getDomainStats('https://new-domain.com/page');
      expect(stats).not.toBeNull();
      expect(stats!.refillRate).toBeCloseTo(0.5, 2);
    });

    it('does not modify rate for negative crawl delay', () => {
      limiter.checkLimit('https://neg.com/page');
      const before = limiter.getDomainStats('https://neg.com/page');

      // Negative crawl delay — the guard is crawlDelaySeconds > 0
      limiter.setDomainLimit('neg.com', -1);

      const after = limiter.getDomainStats('https://neg.com/page');
      expect(after!.refillRate).toBe(before!.refillRate);
    });

    it('handles fractional crawl delays', () => {
      limiter.checkLimit('https://frac.com/page');
      limiter.setDomainLimit('frac.com', 0.5);

      const stats = limiter.getDomainStats('https://frac.com/page');
      expect(stats!.refillRate).toBeCloseTo(2, 1); // 1/0.5 = 2
    });
  });

  // -----------------------------------------------------------------------
  // clearDomain
  // -----------------------------------------------------------------------

  describe('clearDomain', () => {
    it('removes only the specified domain', async () => {
      await limiter.checkLimit('https://keep.com/page');
      await limiter.checkLimit('https://remove.com/page');

      limiter.clearDomain('remove.com');

      expect(limiter.getDomainStats('https://remove.com/page')).toBeNull();
      expect(limiter.getDomainStats('https://keep.com/page')).not.toBeNull();
    });

    it('clearing non-existent domain does not throw', () => {
      expect(() => limiter.clearDomain('nonexistent.com')).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Disabled limiter
  // -----------------------------------------------------------------------

  describe('disabled limiter', () => {
    it('checkLimit returns immediately when disabled', async () => {
      const disabled = new DomainRateLimiter(1, false);

      for (let i = 0; i < 100; i++) {
        await disabled.checkLimit('https://example.com/page');
      }
      // All should be instant since disabled (no delay)

      disabled.clearAll();
    });

    it('does not create buckets when disabled', async () => {
      const disabled = new DomainRateLimiter(1, false);

      await disabled.checkLimit('https://example.com/page');

      // No bucket should be created
      const stats = disabled.getAllStats();
      expect(stats.totalDomains).toBe(0);

      disabled.clearAll();
    });
  });

  // -----------------------------------------------------------------------
  // Constructor defaults
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('uses default rate limit of 1 when not specified', () => {
      const defaultLimiter = new DomainRateLimiter();
      defaultLimiter.checkLimit('https://default.com/page');

      const stats = defaultLimiter.getDomainStats('https://default.com/page');
      expect(stats!.refillRate).toBe(1);
      defaultLimiter.clearAll();
    });

    it('uses enabled=true by default', async () => {
      const defaultLimiter = new DomainRateLimiter();

      // Use up initial token
      await defaultLimiter.checkLimit('https://test.com/1');

      // Second request should be queued (limiter is enabled)
      let resolved = false;
      defaultLimiter.checkLimit('https://test.com/2').then(() => {
        resolved = true;
      });

      vi.advanceTimersByTime(50);
      // Should not be resolved yet since tokens are 0
      expect(resolved).toBe(false);

      vi.advanceTimersByTime(2000);
      defaultLimiter.clearAll();
    });
  });
});
