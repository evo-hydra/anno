import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DomainRateLimiter } from '../core/rate-limiter';

// ---------------------------------------------------------------------------
// Mock logger to prevent console output during tests
// ---------------------------------------------------------------------------

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

// We do NOT mock config here because we construct DomainRateLimiter directly
// with explicit parameters.

describe('DomainRateLimiter', () => {
  let limiter: DomainRateLimiter;

  beforeEach(() => {
    // Create a limiter with 2 requests/sec, enabled
    limiter = new DomainRateLimiter(2, true);
  });

  afterEach(() => {
    limiter.clearAll();
  });

  // -----------------------------------------------------------------------
  // Basic operations
  // -----------------------------------------------------------------------

  it('allows first request immediately', async () => {
    const start = Date.now();
    await limiter.checkLimit('https://example.com/page1');
    const elapsed = Date.now() - start;

    // Should complete in under 50ms (essentially instant)
    expect(elapsed).toBeLessThan(50);
  });

  it('allows requests within rate limit', async () => {
    // With refillRate=2, capacity=1, the first request uses the initial token.
    // After that, tokens refill at 2/sec. A short wait should allow the next request.
    await limiter.checkLimit('https://example.com/a');

    // Wait enough for one token to refill at 2 tokens/sec (500ms)
    await new Promise((r) => setTimeout(r, 600));

    const start = Date.now();
    await limiter.checkLimit('https://example.com/b');
    const elapsed = Date.now() - start;

    // Should be nearly immediate because a token has refilled
    expect(elapsed).toBeLessThan(200);
  });

  // -----------------------------------------------------------------------
  // setDomainLimit
  // -----------------------------------------------------------------------

  it('setDomainLimit() changes the limit for a domain', () => {
    limiter.checkLimit('https://slow-site.com/page');

    // Set crawl-delay of 5 seconds (refillRate = 1/5 = 0.2 tokens/sec)
    limiter.setDomainLimit('slow-site.com', 5);

    const stats = limiter.getDomainStats('https://slow-site.com/anything');
    expect(stats).not.toBeNull();
    expect(stats!.refillRate).toBeCloseTo(0.2, 1);
  });

  it('setDomainLimit() with 0 crawl-delay does not change rate', () => {
    limiter.checkLimit('https://example.com/page');

    const statsBefore = limiter.getDomainStats('https://example.com/page');
    const rateBefore = statsBefore!.refillRate;

    // 0 crawl-delay should be ignored
    limiter.setDomainLimit('example.com', 0);

    const statsAfter = limiter.getDomainStats('https://example.com/page');
    expect(statsAfter!.refillRate).toBe(rateBefore);
  });

  // -----------------------------------------------------------------------
  // Independent domain limits
  // -----------------------------------------------------------------------

  it('different domains have independent limits', async () => {
    await limiter.checkLimit('https://domain-a.com/page1');
    await limiter.checkLimit('https://domain-b.com/page1');

    const statsA = limiter.getDomainStats('https://domain-a.com/something');
    const statsB = limiter.getDomainStats('https://domain-b.com/something');

    expect(statsA).not.toBeNull();
    expect(statsB).not.toBeNull();
    expect(statsA!.domain).toBe('domain-a.com');
    expect(statsB!.domain).toBe('domain-b.com');
  });

  it('consuming tokens on one domain does not affect another', async () => {
    // Use up domain-a's token
    await limiter.checkLimit('https://domain-a.com/page');

    // domain-b should still have its initial token
    const start = Date.now();
    await limiter.checkLimit('https://domain-b.com/page');
    const elapsed = Date.now() - start;

    // domain-b's first request should be instant
    expect(elapsed).toBeLessThan(50);
  });

  // -----------------------------------------------------------------------
  // Rapid sequential requests
  // -----------------------------------------------------------------------

  it('handles rapid sequential requests by queuing', async () => {
    // Use a slow limiter (1 req/sec) for this test
    const slowLimiter = new DomainRateLimiter(1, true);

    // First request: immediate (uses the initial token)
    await slowLimiter.checkLimit('https://example.com/1');

    // Second request: should be queued and delayed
    const start = Date.now();
    await slowLimiter.checkLimit('https://example.com/2');
    const elapsed = Date.now() - start;

    // Should have waited for at least some time (token refill)
    // At 1 token/sec with 100ms check interval, it should wait ~1000ms
    // but we'll be lenient with timing
    expect(elapsed).toBeGreaterThanOrEqual(50);

    slowLimiter.clearAll();
  });

  // -----------------------------------------------------------------------
  // Disabled limiter
  // -----------------------------------------------------------------------

  it('disabled limiter allows all requests immediately', async () => {
    const disabledLimiter = new DomainRateLimiter(1, false);

    const start = Date.now();
    // Rapid-fire 10 requests
    for (let i = 0; i < 10; i++) {
      await disabledLimiter.checkLimit('https://example.com/page');
    }
    const elapsed = Date.now() - start;

    // All should be instant
    expect(elapsed).toBeLessThan(100);

    disabledLimiter.clearAll();
  });

  // -----------------------------------------------------------------------
  // Invalid URLs
  // -----------------------------------------------------------------------

  it('throws on invalid URL', async () => {
    await expect(limiter.checkLimit('not-a-url')).rejects.toThrow('Invalid URL');
  });

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  it('getDomainStats returns null for unknown domain', () => {
    const stats = limiter.getDomainStats('https://never-seen.com/page');
    expect(stats).toBeNull();
  });

  it('getDomainStats returns correct structure after request', async () => {
    await limiter.checkLimit('https://stats-test.com/page');

    const stats = limiter.getDomainStats('https://stats-test.com/anything');
    expect(stats).not.toBeNull();
    expect(stats!.domain).toBe('stats-test.com');
    expect(typeof stats!.tokens).toBe('number');
    expect(typeof stats!.refillRate).toBe('number');
    expect(typeof stats!.queueSize).toBe('number');
    expect(stats!.refillRate).toBe(2); // matches constructor param
  });

  it('getAllStats returns info on all tracked domains', async () => {
    await limiter.checkLimit('https://d1.com/a');
    await limiter.checkLimit('https://d2.com/b');
    await limiter.checkLimit('https://d3.com/c');

    const all = limiter.getAllStats();
    expect(all.totalDomains).toBe(3);
    expect(all.domains).toHaveLength(3);

    const domainNames = all.domains.map((d) => d.domain).sort();
    expect(domainNames).toEqual(['d1.com', 'd2.com', 'd3.com']);
  });

  // -----------------------------------------------------------------------
  // clearDomain / clearAll
  // -----------------------------------------------------------------------

  it('clearDomain removes a single domain bucket', async () => {
    await limiter.checkLimit('https://to-clear.com/page');
    expect(limiter.getDomainStats('https://to-clear.com/page')).not.toBeNull();

    limiter.clearDomain('to-clear.com');
    expect(limiter.getDomainStats('https://to-clear.com/page')).toBeNull();
  });

  it('clearAll removes all domain buckets', async () => {
    await limiter.checkLimit('https://a.com/page');
    await limiter.checkLimit('https://b.com/page');

    limiter.clearAll();

    const all = limiter.getAllStats();
    expect(all.totalDomains).toBe(0);
    expect(all.domains).toHaveLength(0);
  });
});
