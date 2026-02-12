import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../core/url-validator', () => ({
  validateUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config/env', () => ({
  config: {
    fetch: {
      userAgent: 'TestBot/1.0',
      respectRobots: true,
    },
  },
}));

import { RobotsManager } from '../core/robots-parser';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RobotsManager', () => {
  let manager: RobotsManager;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // -----------------------------------------------------------------------
  // isAllowed
  // -----------------------------------------------------------------------

  it('returns true when respectRobots is false', async () => {
    manager = new RobotsManager('TestBot/1.0', false);

    const allowed = await manager.isAllowed('https://example.com/secret');
    expect(allowed).toBe(true);
  });

  it('fetches and caches robots.txt', async () => {
    manager = new RobotsManager('TestBot/1.0', true);

    const robotsTxt = `User-agent: *\nAllow: /\n`;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(robotsTxt, { status: 200 })
    );

    const allowed1 = await manager.isAllowed('https://example.com/page');
    const allowed2 = await manager.isAllowed('https://example.com/other');

    expect(allowed1).toBe(true);
    expect(allowed2).toBe(true);
    // fetch should have been called only once (cached after first call)
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('blocks disallowed URLs', async () => {
    manager = new RobotsManager('TestBot/1.0', true);

    const robotsTxt = `User-agent: *\nDisallow: /private/\n`;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(robotsTxt, { status: 200 })
    );

    const allowed = await manager.isAllowed('https://example.com/private/secret');
    expect(allowed).toBe(false);
  });

  it('allows allowed URLs when other paths are disallowed', async () => {
    manager = new RobotsManager('TestBot/1.0', true);

    const robotsTxt = `User-agent: *\nDisallow: /admin/\nAllow: /\n`;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(robotsTxt, { status: 200 })
    );

    const allowed = await manager.isAllowed('https://example.com/public/page');
    expect(allowed).toBe(true);
  });

  it('returns true on fetch error (permissive fallback)', async () => {
    manager = new RobotsManager('TestBot/1.0', true);

    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const allowed = await manager.isAllowed('https://example.com/page');
    expect(allowed).toBe(true);
  });

  it('returns true when robots.txt returns 404', async () => {
    manager = new RobotsManager('TestBot/1.0', true);

    global.fetch = vi.fn().mockResolvedValue(
      new Response('Not Found', { status: 404 })
    );

    const allowed = await manager.isAllowed('https://example.com/page');
    expect(allowed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // getCrawlDelay
  // -----------------------------------------------------------------------

  it('returns 0 crawl delay when none specified', async () => {
    manager = new RobotsManager('TestBot/1.0', true);

    const robotsTxt = `User-agent: *\nAllow: /\n`;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(robotsTxt, { status: 200 })
    );

    const delay = await manager.getCrawlDelay('https://example.com/page');
    expect(delay).toBe(0);
  });

  it('returns 0 crawl delay when respectRobots is false', async () => {
    manager = new RobotsManager('TestBot/1.0', false);

    const delay = await manager.getCrawlDelay('https://example.com/page');
    expect(delay).toBe(0);
  });

  // -----------------------------------------------------------------------
  // clearCache
  // -----------------------------------------------------------------------

  it('clearCache clears all entries', async () => {
    manager = new RobotsManager('TestBot/1.0', true);

    const robotsTxt = `User-agent: *\nAllow: /\n`;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(robotsTxt, { status: 200 })
    );

    await manager.isAllowed('https://example.com/page');
    expect(manager.getCacheStats().domains).toBe(1);

    manager.clearCache();
    expect(manager.getCacheStats().domains).toBe(0);
  });

  it('clearCache with domain clears only that domain', async () => {
    manager = new RobotsManager('TestBot/1.0', true);

    const robotsTxt = `User-agent: *\nAllow: /\n`;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(robotsTxt, { status: 200 })
    );

    await manager.isAllowed('https://a.com/page');
    await manager.isAllowed('https://b.com/page');
    expect(manager.getCacheStats().domains).toBe(2);

    manager.clearCache('https://a.com');
    expect(manager.getCacheStats().domains).toBe(1);
    expect(manager.getCacheStats().entries).toContain('https://b.com');
  });

  // -----------------------------------------------------------------------
  // getCacheStats
  // -----------------------------------------------------------------------

  it('getCacheStats returns correct counts', async () => {
    manager = new RobotsManager('TestBot/1.0', true);

    const stats = manager.getCacheStats();
    expect(stats.domains).toBe(0);
    expect(stats.entries).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // checkAndEnforce
  // -----------------------------------------------------------------------

  it('checkAndEnforce throws for disallowed URLs', async () => {
    manager = new RobotsManager('TestBot/1.0', true);

    const robotsTxt = `User-agent: *\nDisallow: /blocked/\n`;
    global.fetch = vi.fn().mockResolvedValue(
      new Response(robotsTxt, { status: 200 })
    );

    await expect(
      manager.checkAndEnforce('https://example.com/blocked/page')
    ).rejects.toThrow('Blocked by robots.txt');
  });
});
