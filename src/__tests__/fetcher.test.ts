import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { promises as dns } from 'dns';
import { fetchPage } from '../services/fetcher';
import {
  resetMetrics,
  getMetricsSnapshot,
  renderPrometheusMetrics,
  getLatencySummary
} from '../services/metrics';
import { config } from '../config/env';
import { rendererManager } from '../services/renderer';
import type { RendererStatus } from '../services/renderer';
import type { Page, BrowserContext } from 'playwright-core';
import { rateLimiter } from '../core/rate-limiter';
import { ErrorCode } from '../middleware/error-handler';

const originalRateLimiter = {
  checkLimit: rateLimiter.checkLimit.bind(rateLimiter),
  setDomainLimit: rateLimiter.setDomainLimit.bind(rateLimiter)
};

const stubRateLimiter = ({ waitMs = 0 }: { waitMs?: number } = {}): void => {
  (rateLimiter as unknown as { setDomainLimit: typeof rateLimiter.setDomainLimit }).setDomainLimit = () => {};
  (rateLimiter as unknown as { checkLimit: typeof rateLimiter.checkLimit }).checkLimit = async () => {
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  };
};

const restoreRateLimiter = (): void => {
  (rateLimiter as unknown as { setDomainLimit: typeof rateLimiter.setDomainLimit }).setDomainLimit = originalRateLimiter.setDomainLimit;
  (rateLimiter as unknown as { checkLimit: typeof rateLimiter.checkLimit }).checkLimit = originalRateLimiter.checkLimit;
};

beforeEach(() => {
  stubRateLimiter();
});

afterEach(() => {
  restoreRateLimiter();
});

const buildMockResponse = (body: string) =>
  new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8'
    }
  });

describe('fetchPage', () => {
  it('rejects when rendering is disabled', async () => {
    resetMetrics();
    const originalEnabled = config.rendering.enabled;

    try {
      config.rendering.enabled = false;

      await expect(
        fetchPage({
          url: 'https://example.com/article',
          useCache: false,
          mode: 'rendered'
        })
      ).rejects.toMatchObject({
        name: 'RenderingDisabledError'
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.renderDisabled).toBe(1);
      expect(snapshot.fetch.renderFallbacks).toBe(1);
      expect(snapshot.fetch.totalRequests).toBe(1);
    } finally {
      config.rendering.enabled = originalEnabled;
    }
  });
});

describe('metrics', () => {
  it('captures cache hits for HTTP mode', async () => {
    resetMetrics();
    const originalFetch = global.fetch;

    try {
      global.fetch = async () => buildMockResponse('<html><body>metrics</body></html>');

      await fetchPage({
        url: 'https://example.com/metrics',
        useCache: true,
        mode: 'http'
      });

      let snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.totalRequests).toBe(1);
      expect(snapshot.fetch.cacheMisses).toBe(1);
      expect(snapshot.fetch.cacheHits).toBe(0);

      await fetchPage({
        url: 'https://example.com/metrics',
        useCache: true,
        mode: 'http'
      });

      snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.totalRequests).toBe(2);
      expect(snapshot.fetch.totalFromCache).toBe(1);
      expect(snapshot.fetch.cacheHits).toBe(1);
      expect(snapshot.fetch.renderFallbacks).toBe(0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('records rate limiter wait time in metrics snapshot', async () => {
    resetMetrics();
    stubRateLimiter({ waitMs: 5 });

    const originalFetch = global.fetch;

    try {
      global.fetch = async () => buildMockResponse('<html><body>rate limit</body></html>');

      await fetchPage({
        url: 'https://example.com/rate-limit',
        useCache: false,
        mode: 'http'
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.rateLimitedRequests >= 1).toBe(true);
      expect(snapshot.fetch.rateLimitWaitMs.length >= 1).toBe(true);
    } finally {
      global.fetch = originalFetch;
      stubRateLimiter();
    }
  });

  it('records render fallback duration on failure', async () => {
    resetMetrics();

    const originalFetch = global.fetch;
    const originalEnabled = config.rendering.enabled;
    const originalInit = rendererManager.init.bind(rendererManager);
    const originalWithPage = rendererManager.withPage.bind(rendererManager);

    try {
      config.rendering.enabled = true;

      global.fetch = async () => buildMockResponse('<html><body>fallback</body></html>');

      (rendererManager as unknown as { init: () => Promise<void> }).init = async () => Promise.resolve();
      (rendererManager as unknown as {
        withPage: typeof rendererManager.withPage;
      }).withPage = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('render boom');
      };

      await fetchPage({
        url: 'https://example.com/render-fallback',
        useCache: false,
        mode: 'rendered'
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.renderFallbacks).toBe(1);
      expect(snapshot.fetch.renderErrors).toBe(1);
      expect(snapshot.fetch.renderFallbackSecondsCount).toBe(1);

      const metricsOutput = renderPrometheusMetrics();
      expect(metricsOutput.includes('anno_render_fallback_seconds_count 1')).toBe(true);
      expect(metricsOutput.includes('anno_render_fallback_seconds_bucket{le="0.1"} 1')).toBe(true);

      const fallbackSummary = getLatencySummary();
      expect(fallbackSummary.fallback.p50Seconds).not.toBeNull();
      expect(fallbackSummary.fallback.p95Seconds).not.toBeNull();
    } finally {
      global.fetch = originalFetch;
      config.rendering.enabled = originalEnabled;
      (rendererManager as unknown as { init: () => Promise<void> }).init = originalInit;
      (rendererManager as unknown as { withPage: typeof rendererManager.withPage }).withPage = originalWithPage;
    }
  });

  it('updates metrics and cache on render success', async () => {
    resetMetrics();

    const originalFetch = global.fetch;
    const originalEnabled = config.rendering.enabled;
    const originalMaxPages = config.rendering.maxPages;
    const originalInit = rendererManager.init.bind(rendererManager);
    const originalWithPage = rendererManager.withPage.bind(rendererManager);

    try {
      config.rendering.enabled = true;
      config.rendering.maxPages = 2;

      global.fetch = async () => {
        throw new Error('HTTP fetch should not be used when render succeeds');
      };

      (rendererManager as unknown as { init: () => Promise<void> }).init = async () => Promise.resolve();

      const fakeRenderedBody = '<html><body>render success</body></html>';
      const baseUrl = 'https://example.com/render-success';

      (rendererManager as unknown as {
        withPage: <T>(handler: (page: Page, context: BrowserContext) => Promise<T>) => Promise<{ result: T; status: RendererStatus }>;
      }).withPage = async <T>(handler: (page: Page, context: BrowserContext) => Promise<T>) => {
        const fakeResponse = {
          url: () => baseUrl,
          status: () => 200,
          headers: () => ({})
        };

        const fakePage = {
          goto: async () => fakeResponse,
          content: async () => fakeRenderedBody,
          url: () => baseUrl
        } as unknown as Page;

        const fakeContext = {} as BrowserContext;

        const result = await handler(fakePage, fakeContext);
        return {
          result,
          status: {
            enabled: true,
            initialized: true,
            concurrency: { available: 1, pending: 0, max: 2 }
          }
        };
      };

      const result = await fetchPage({
        url: baseUrl,
        useCache: true,
        mode: 'rendered'
      });

      expect(result.rendered).toBe(true);
      expect(result.renderDiagnostics.effectiveMode).toBe('rendered');
      expect(result.renderDiagnostics.fallbackReason).toBeUndefined();
      expect(result.body.includes('render success')).toBe(true);

      let snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.totalRequests).toBe(1);
      expect(snapshot.fetch.cacheMisses).toBe(1);
      expect(snapshot.fetch.renderSuccess).toBe(1);
      expect(snapshot.fetch.renderFallbacks).toBe(0);

      const cached = await fetchPage({
        url: baseUrl,
        useCache: true,
        mode: 'rendered'
      });

      expect(cached.fromCache).toBe(true);
      expect(cached.rendered).toBe(true);

      snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.totalRequests).toBe(2);
      expect(snapshot.fetch.totalFromCache).toBe(1);
      expect(snapshot.fetch.cacheHits).toBe(1);
      expect(snapshot.fetch.renderSuccess).toBe(2);
      expect(snapshot.fetch.renderFallbacks).toBe(0);
      const expectedSum = snapshot.fetch.renderDurationSecondsSum;
      const expectedCount = snapshot.fetch.renderDurationSecondsCount;
      const expectedBucket = snapshot.fetch.renderDurationSecondsBuckets[0.1];

      const metricsOutput = renderPrometheusMetrics();
      expect(
        metricsOutput.includes(`anno_render_duration_seconds_sum ${expectedSum}`)
      ).toBe(true);
      expect(
        metricsOutput.includes(`anno_render_duration_seconds_count ${expectedCount}`)
      ).toBe(true);
      expect(
        metricsOutput.includes(
          `anno_render_duration_seconds_bucket{le="0.1"} ${expectedBucket}`
        )
      ).toBe(true);

      const renderSummary = getLatencySummary();
      expect(renderSummary.render.p50Seconds).not.toBeNull();
      expect(renderSummary.render.p95Seconds).not.toBeNull();
    } finally {
      global.fetch = originalFetch;
      config.rendering.enabled = originalEnabled;
      config.rendering.maxPages = originalMaxPages;
      (rendererManager as unknown as { init: () => Promise<void> }).init = originalInit;
      (rendererManager as unknown as { withPage: typeof rendererManager.withPage }).withPage = originalWithPage;
    }
  });

  it('emits expected counters in renderPrometheusMetrics', () => {
    resetMetrics();
    const output = renderPrometheusMetrics();
    expect(output.includes('anno_fetch_total')).toBe(true);
    expect(output.includes('# TYPE anno_fetch_total counter')).toBe(true);
    expect(output.includes('anno_last_request_timestamp')).toBe(true);
    expect(output.includes('anno_render_duration_seconds_bucket{le="0.1"} 0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

const originalDnsLookup = dns.lookup;

describe('fetchPage SSRF protection', () => {
  let originalSsrf: typeof config.ssrf;

  beforeEach(() => {
    originalSsrf = { ...config.ssrf, allowedHosts: [...config.ssrf.allowedHosts], blockedHosts: [...config.ssrf.blockedHosts] };
    config.ssrf.enabled = true;
    config.ssrf.allowedHosts = [];
    config.ssrf.blockedHosts = [];
    config.ssrf.allowPrivateIPs = false;
  });

  afterEach(() => {
    config.ssrf.enabled = originalSsrf.enabled;
    config.ssrf.allowedHosts = originalSsrf.allowedHosts;
    config.ssrf.blockedHosts = originalSsrf.blockedHosts;
    config.ssrf.allowPrivateIPs = originalSsrf.allowPrivateIPs;
    (dns as unknown as { lookup: typeof dns.lookup }).lookup = originalDnsLookup;
  });

  it('rejects fetch to private IP address', async () => {
    await expect(
      fetchPage({ url: 'http://127.0.0.1/secret', useCache: false, mode: 'http' })
    ).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
  });

  it('rejects fetch with hostname resolving to private IP', async () => {
    (dns as unknown as { lookup: typeof dns.lookup }).lookup = async () =>
      [{ address: '10.0.0.1', family: 4 }] as never;

    await expect(
      fetchPage({ url: 'http://evil.internal/admin', useCache: false, mode: 'http' })
    ).rejects.toMatchObject({ code: ErrorCode.SSRF_BLOCKED });
  });

  it('allows fetch to public URL (existing behavior preserved)', async () => {
    (dns as unknown as { lookup: typeof dns.lookup }).lookup = async () =>
      [{ address: '93.184.216.34', family: 4 }] as never;

    const originalFetchFn = global.fetch;
    global.fetch = async () =>
      new Response('<html><body>public content</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });

    try {
      const result = await fetchPage({
        url: 'https://example.com/page',
        useCache: false,
        mode: 'http',
      });
      expect(result.status).toBe(200);
      expect(result.body).toContain('public content');
    } finally {
      global.fetch = originalFetchFn;
    }
  });
});
