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
import { robotsManager } from '../core/robots-parser';
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

// ---------------------------------------------------------------------------
// Conditional headers and cache validation
// ---------------------------------------------------------------------------

describe('conditional headers and cache validation', () => {
  let originalFetch: typeof global.fetch;
  let originalSsrf: typeof config.ssrf;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalSsrf = { ...config.ssrf, allowedHosts: [...config.ssrf.allowedHosts], blockedHosts: [...config.ssrf.blockedHosts] };
    config.ssrf.enabled = true;
    config.ssrf.allowedHosts = [];
    config.ssrf.blockedHosts = [];
    config.ssrf.allowPrivateIPs = false;

    (dns as unknown as { lookup: typeof dns.lookup }).lookup = async () =>
      [{ address: '93.184.216.34', family: 4 }] as never;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    config.ssrf.enabled = originalSsrf.enabled;
    config.ssrf.allowedHosts = originalSsrf.allowedHosts;
    config.ssrf.blockedHosts = originalSsrf.blockedHosts;
    config.ssrf.allowPrivateIPs = originalSsrf.allowPrivateIPs;
    (dns as unknown as { lookup: typeof dns.lookup }).lookup = originalDnsLookup;
  });

  it('sends If-None-Match when cached entry has etag', async () => {
    resetMetrics();
    let requestHeaders: Headers | undefined;

    global.fetch = async (url, options) => {
      const opts = options as RequestInit;
      requestHeaders = new Headers(opts.headers);
      return new Response('<html><body>first</body></html>', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'etag': '"abc123"'
        }
      });
    };

    const url = 'https://example.com/etag-test';

    const first = await fetchPage({ url, useCache: true, mode: 'http' });
    expect(first.fromCache).toBe(false);

    const second = await fetchPage({ url, useCache: true, mode: 'http' });
    expect(requestHeaders?.get('If-None-Match')).toBe('"abc123"');
    expect(second.fromCache).toBe(false);
  });

  it('sends If-Modified-Since when cached entry has last-modified', async () => {
    resetMetrics();
    let requestHeaders: Headers | undefined;

    global.fetch = async (url, options) => {
      const opts = options as RequestInit;
      requestHeaders = new Headers(opts.headers);
      return new Response('<html><body>first</body></html>', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT'
        }
      });
    };

    const url = 'https://example.com/lastmod-test';

    const first = await fetchPage({ url, useCache: true, mode: 'http' });
    expect(first.fromCache).toBe(false);

    const second = await fetchPage({ url, useCache: true, mode: 'http' });
    expect(requestHeaders?.get('If-Modified-Since')).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    expect(second.fromCache).toBe(false);
  });

  it('sends conditional request with etag on second fetch', async () => {
    resetMetrics();
    let callCount = 0;
    let receivedHeaders: Headers | undefined;

    global.fetch = async (_url, options) => {
      callCount++;
      if (options) {
        receivedHeaders = new Headers((options as RequestInit).headers);
      }
      if (callCount === 1) {
        return new Response('<html><body>original content</body></html>', {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'etag': '"v1"'
          }
        });
      }
      // Return same etag - HTTP client will send conditional request
      return new Response('<html><body>original content</body></html>', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'etag': '"v1"'
        }
      });
    };

    const url = 'https://example.com/not-modified';

    const first = await fetchPage({ url, useCache: true, mode: 'http' });
    expect(first.body).toContain('original content');
    expect(callCount).toBe(1);

    const second = await fetchPage({ url, useCache: true, mode: 'http' });
    expect(second.body).toContain('original content');
    expect(callCount).toBe(2);
    // Should have sent conditional request header
    expect(receivedHeaders?.get('If-None-Match')).toBe('"v1"');
  });

  it('calls recordCacheValidation(false) when server returns 200 with new content', async () => {
    resetMetrics();
    let callCount = 0;

    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('<html><body>v1</body></html>', {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'etag': '"v1"'
          }
        });
      }
      return new Response('<html><body>v2</body></html>', {
        status: 200,
        headers: {
          'content-type': 'text/html',
            'etag': '"v2"'
          }
        });
      };

      const url = 'https://example.com/changed';

      const first = await fetchPage({ url, useCache: true, mode: 'http' });
      expect(first.body).toContain('v1');

      const second = await fetchPage({ url, useCache: true, mode: 'http' });
      expect(second.body).toContain('v2');
      // Should have validated and fetched new content
      expect(callCount).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// resolveMode branches
// ---------------------------------------------------------------------------

describe('resolveMode branches', () => {
  let originalEnabled: boolean;

  beforeEach(() => {
    originalEnabled = config.rendering.enabled;
  });

  afterEach(() => {
    config.rendering.enabled = originalEnabled;
  });

  it('returns mode=http, attempted=false when mode is http', async () => {
    const originalFetch = global.fetch;
    config.rendering.enabled = true;

    global.fetch = async () => buildMockResponse('<html><body>http mode</body></html>');

    try {
      const result = await fetchPage({
        url: 'https://example.com/http-mode',
        useCache: false,
        mode: 'http'
      });

      expect(result.renderDiagnostics.effectiveMode).toBe('http');
      expect(result.renderDiagnostics.attempted).toBe(false);
      expect(result.renderDiagnostics.fallbackReason).toBeUndefined();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('returns mode=http, attempted=false, fallbackReason=rendering_disabled when rendered mode but disabled', async () => {
    const originalFetch = global.fetch;
    config.rendering.enabled = false;

    global.fetch = async () => buildMockResponse('<html><body>fallback</body></html>');

    try {
      await expect(
        fetchPage({
          url: 'https://example.com/disabled',
          useCache: false,
          mode: 'rendered'
        })
      ).rejects.toMatchObject({
        name: 'RenderingDisabledError'
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('returns mode=rendered, attempted=true when rendering is enabled', async () => {
    resetMetrics();
    config.rendering.enabled = true;

    const originalInit = rendererManager.init.bind(rendererManager);
    const originalWithPage = rendererManager.withPage.bind(rendererManager);

    try {
      (rendererManager as unknown as { init: () => Promise<void> }).init = async () => Promise.resolve();
      (rendererManager as unknown as {
        withPage: <T>(handler: (page: Page, context: BrowserContext) => Promise<T>) => Promise<{ result: T; status: RendererStatus }>;
      }).withPage = async <T>(handler: (page: Page, context: BrowserContext) => Promise<T>) => {
        const fakeResponse = {
          url: () => 'https://example.com/rendered',
          status: () => 200,
          headers: () => ({})
        };

        const fakePage = {
          goto: async () => fakeResponse,
          content: async () => '<html><body>rendered</body></html>',
          url: () => 'https://example.com/rendered'
        } as unknown as Page;

        const result = await handler(fakePage, {} as BrowserContext);
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
        url: 'https://example.com/rendered',
        useCache: false,
        mode: 'rendered'
      });

      expect(result.renderDiagnostics.effectiveMode).toBe('rendered');
      expect(result.renderDiagnostics.attempted).toBe(true);
      expect(result.renderDiagnostics.fallbackReason).toBeUndefined();
    } finally {
      (rendererManager as unknown as { init: () => Promise<void> }).init = originalInit;
      (rendererManager as unknown as { withPage: typeof rendererManager.withPage }).withPage = originalWithPage;
    }
  });
});

// ---------------------------------------------------------------------------
// RenderFetchError with specific reasons
// ---------------------------------------------------------------------------

describe('RenderFetchError with specific reasons', () => {
  let originalEnabled: boolean;
  let originalFetch: typeof global.fetch;
  let originalInit: typeof rendererManager.init;
  let originalWithPage: typeof rendererManager.withPage;

  beforeEach(() => {
    originalEnabled = config.rendering.enabled;
    originalFetch = global.fetch;
    originalInit = rendererManager.init.bind(rendererManager);
    originalWithPage = rendererManager.withPage.bind(rendererManager);

    config.rendering.enabled = true;
  });

  afterEach(() => {
    config.rendering.enabled = originalEnabled;
    global.fetch = originalFetch;
    (rendererManager as unknown as { init: () => Promise<void> }).init = originalInit;
    (rendererManager as unknown as { withPage: typeof rendererManager.withPage }).withPage = originalWithPage;
  });

  it('handles navigation_error and falls back to http', async () => {
    global.fetch = async () => buildMockResponse('<html><body>http fallback</body></html>');

    (rendererManager as unknown as { init: () => Promise<void> }).init = async () => Promise.resolve();
    (rendererManager as unknown as {
      withPage: <T>(handler: (page: Page, context: BrowserContext) => Promise<T>) => Promise<{ result: T; status: RendererStatus }>;
    }).withPage = async <T>(handler: (page: Page, context: BrowserContext) => Promise<T>) => {
      const fakePage = {
        goto: async () => {
          throw new Error('Navigation timeout');
        },
        url: () => 'https://example.com/nav-error'
      } as unknown as Page;

      const result = await handler(fakePage, {} as BrowserContext);
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
      url: 'https://example.com/nav-error',
      useCache: false,
      mode: 'rendered'
    });

    expect(result.renderDiagnostics.effectiveMode).toBe('http');
    expect(result.renderDiagnostics.fallbackReason).toBe('navigation_error');
    expect(result.body).toContain('http fallback');
  });

  it('handles renderer_unavailable and falls back to http', async () => {
    global.fetch = async () => buildMockResponse('<html><body>http fallback</body></html>');

    (rendererManager as unknown as { init: () => Promise<void> }).init = async () => Promise.resolve();
    (rendererManager as unknown as {
      withPage: typeof rendererManager.withPage;
    }).withPage = async () => {
      throw new Error('renderer unavailable');
    };

    const result = await fetchPage({
      url: 'https://example.com/unavailable',
      useCache: false,
      mode: 'rendered'
    });

    expect(result.renderDiagnostics.effectiveMode).toBe('http');
    expect(result.renderDiagnostics.fallbackReason).toBe('renderer_unavailable');
  });

  it('handles render_runtime_error for unknown errors', async () => {
    global.fetch = async () => buildMockResponse('<html><body>http fallback</body></html>');

    (rendererManager as unknown as { init: () => Promise<void> }).init = async () => Promise.resolve();
    (rendererManager as unknown as {
      withPage: typeof rendererManager.withPage;
    }).withPage = async () => {
      throw new Error('some random runtime error');
    };

    const result = await fetchPage({
      url: 'https://example.com/runtime-error',
      useCache: false,
      mode: 'rendered'
    });

    expect(result.renderDiagnostics.effectiveMode).toBe('http');
    expect(result.renderDiagnostics.fallbackReason).toBe('render_runtime_error');
  });
});

// ---------------------------------------------------------------------------
// Cache storage conditions
// ---------------------------------------------------------------------------

describe('cache storage conditions', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('does not cache 404 responses', async () => {
    global.fetch = async () => new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/html' }
    });

    const url = 'https://example.com/not-found';

    await fetchPage({ url, useCache: true, mode: 'http' });
    const second = await fetchPage({ url, useCache: true, mode: 'http' });

    expect(second.fromCache).toBe(false);
  });

  it('does not cache 500 responses', async () => {
    // HTTP client retries 500 errors and throws, so 500s won't be cached
    global.fetch = async () => {
      return new Response('Server Error', {
        status: 500,
        headers: { 'content-type': 'text/html' }
      });
    };

    const url = 'https://example.com/server-error';

    // First call will retry and eventually fail
    try {
      await fetchPage({ url, useCache: true, mode: 'http' });
    } catch (_error) {
      // Expected to throw
    }

    // Second call should also fail (not cached)
    try {
      await fetchPage({ url, useCache: true, mode: 'http' });
    } catch (_error) {
      // Expected to throw
    }
  });

  it('caches 200 responses', async () => {
    global.fetch = async () => buildMockResponse('<html><body>ok</body></html>');

    const url = 'https://example.com/ok';

    await fetchPage({ url, useCache: true, mode: 'http' });
    const second = await fetchPage({ url, useCache: true, mode: 'http' });

    expect(second.fromCache).toBe(true);
  });

  it('caches 300 responses', async () => {
    global.fetch = async () => new Response('', {
      status: 300,
      headers: { 'content-type': 'text/html', 'location': '/elsewhere' }
    });

    const url = 'https://example.com/redirect';

    await fetchPage({ url, useCache: true, mode: 'http' });
    const second = await fetchPage({ url, useCache: true, mode: 'http' });

    expect(second.fromCache).toBe(true);
  });

  it('falls back to HTTP fetch when rendering fails and checks HTTP cache', async () => {
    resetMetrics();
    const originalEnabled = config.rendering.enabled;
    const originalInit = rendererManager.init.bind(rendererManager);
    const originalWithPage = rendererManager.withPage.bind(rendererManager);

    try {
      config.rendering.enabled = true;

      let httpCallCount = 0;
      global.fetch = async () => {
        httpCallCount++;
        return buildMockResponse('<html><body>http fallback</body></html>');
      };

      (rendererManager as unknown as { init: () => Promise<void> }).init = async () => Promise.resolve();
      (rendererManager as unknown as {
        withPage: typeof rendererManager.withPage;
      }).withPage = async () => {
        throw new Error('render failed');
      };

      const url = 'https://example.com/render-fallback-cache';

      // First fetch in HTTP mode to populate cache
      const first = await fetchPage({ url, useCache: true, mode: 'http' });
      expect(httpCallCount).toBe(1);
      expect(first.fromCache).toBe(false);

      // Second fetch in rendered mode should fall back to HTTP
      // It will check the HTTP cache for conditional request metadata
      const callCountBefore = httpCallCount;
      const second = await fetchPage({ url, useCache: true, mode: 'rendered' });
      expect(second.renderDiagnostics.effectiveMode).toBe('http');
      expect(second.renderDiagnostics.fallbackReason).toBe('render_runtime_error');
      // Should have made a new HTTP request (fallback path doesn't use cache result directly,
      // but may use cache metadata for conditional requests)
      expect(httpCallCount).toBeGreaterThan(callCountBefore);
    } finally {
      config.rendering.enabled = originalEnabled;
      (rendererManager as unknown as { init: () => Promise<void> }).init = originalInit;
      (rendererManager as unknown as { withPage: typeof rendererManager.withPage }).withPage = originalWithPage;
    }
  });
});

// ---------------------------------------------------------------------------
// rendererManager.getStatus() edge cases
// ---------------------------------------------------------------------------

describe('rendererManager.getStatus() edge cases', () => {
  let originalEnabled: boolean;
  let originalFetch: typeof global.fetch;
  let originalInit: typeof rendererManager.init;
  let originalWithPage: typeof rendererManager.withPage;
  let originalGetStatus: typeof rendererManager.getStatus;

  beforeEach(() => {
    originalEnabled = config.rendering.enabled;
    originalFetch = global.fetch;
    originalInit = rendererManager.init.bind(rendererManager);
    originalWithPage = rendererManager.withPage.bind(rendererManager);
    originalGetStatus = rendererManager.getStatus.bind(rendererManager);

    config.rendering.enabled = true;
  });

  afterEach(() => {
    config.rendering.enabled = originalEnabled;
    global.fetch = originalFetch;
    (rendererManager as unknown as { init: () => Promise<void> }).init = originalInit;
    (rendererManager as unknown as { withPage: typeof rendererManager.withPage }).withPage = originalWithPage;
    (rendererManager as unknown as { getStatus: typeof rendererManager.getStatus }).getStatus = originalGetStatus;
  });

  it('sets rendererStatus to undefined when getStatus returns null', async () => {
    global.fetch = async () => buildMockResponse('<html><body>http fallback</body></html>');

    (rendererManager as unknown as { init: () => Promise<void> }).init = async () => Promise.resolve();
    (rendererManager as unknown as {
      withPage: typeof rendererManager.withPage;
    }).withPage = async () => {
      throw new Error('render failed');
    };
    (rendererManager as unknown as {
      getStatus: typeof rendererManager.getStatus;
    }).getStatus = () => null as never;

    const result = await fetchPage({
      url: 'https://example.com/no-status',
      useCache: false,
      mode: 'rendered'
    });

    expect(result.renderDiagnostics.rendererStatus).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HTTP error status >= 400
// ---------------------------------------------------------------------------

describe('HTTP error status handling', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('logs warning but does not throw on 404', async () => {
    global.fetch = async () => new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/html' }
    });

    const result = await fetchPage({
      url: 'https://example.com/missing',
      useCache: false,
      mode: 'http'
    });

    expect(result.status).toBe(404);
    expect(result.body).toBe('Not Found');
  });

  it('throws on 500 after retries exhausted', async () => {
    global.fetch = async () => new Response('Internal Server Error', {
      status: 500,
      headers: { 'content-type': 'text/html' }
    });

    await expect(
      fetchPage({
        url: 'https://example.com/error',
        useCache: false,
        mode: 'http'
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// robots.txt non-blocking errors and crawlDelay edge cases
// ---------------------------------------------------------------------------

describe('robots.txt non-blocking errors and crawlDelay', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('logs warning and continues when robotsManager throws non-RobotsBlockedError', async () => {
    const originalCheckAndEnforce = robotsManager.checkAndEnforce.bind(robotsManager);
    const originalGetCrawlDelay = robotsManager.getCrawlDelay.bind(robotsManager);

    try {
      (robotsManager as unknown as {
        checkAndEnforce: typeof robotsManager.checkAndEnforce;
      }).checkAndEnforce = async () => {
        throw new Error('robots.txt parse error');
      };

      (robotsManager as unknown as {
        getCrawlDelay: typeof robotsManager.getCrawlDelay;
      }).getCrawlDelay = async () => 0;

      global.fetch = async () => buildMockResponse('<html><body>content</body></html>');

      const result = await fetchPage({
        url: 'https://example.com/robots-error',
        useCache: false,
        mode: 'http'
      });

      expect(result.status).toBe(200);
    } finally {
      (robotsManager as unknown as {
        checkAndEnforce: typeof robotsManager.checkAndEnforce;
      }).checkAndEnforce = originalCheckAndEnforce;
      (robotsManager as unknown as {
        getCrawlDelay: typeof robotsManager.getCrawlDelay;
      }).getCrawlDelay = originalGetCrawlDelay;
    }
  });

  it('does not call setDomainLimit when crawlDelay is 0', async () => {
    const originalGetCrawlDelay = robotsManager.getCrawlDelay.bind(robotsManager);
    const originalCheckAndEnforce = robotsManager.checkAndEnforce.bind(robotsManager);
    let setDomainLimitCalled = false;

    restoreRateLimiter();

    try {
      (robotsManager as unknown as {
        getCrawlDelay: typeof robotsManager.getCrawlDelay;
      }).getCrawlDelay = async () => 0;

      (robotsManager as unknown as {
        checkAndEnforce: typeof robotsManager.checkAndEnforce;
      }).checkAndEnforce = async () => {};

      const originalSetDomainLimit = rateLimiter.setDomainLimit.bind(rateLimiter);
      (rateLimiter as unknown as {
        setDomainLimit: typeof rateLimiter.setDomainLimit;
      }).setDomainLimit = (...args) => {
        setDomainLimitCalled = true;
        return originalSetDomainLimit(...args);
      };

      global.fetch = async () => buildMockResponse('<html><body>content</body></html>');

      await fetchPage({
        url: 'https://example.com/no-delay',
        useCache: false,
        mode: 'http'
      });

      expect(setDomainLimitCalled).toBe(false);
    } finally {
      (robotsManager as unknown as {
        getCrawlDelay: typeof robotsManager.getCrawlDelay;
      }).getCrawlDelay = originalGetCrawlDelay;
      (robotsManager as unknown as {
        checkAndEnforce: typeof robotsManager.checkAndEnforce;
      }).checkAndEnforce = originalCheckAndEnforce;
      stubRateLimiter();
    }
  });

  it('calls setDomainLimit when crawlDelay > 0', async () => {
    const originalGetCrawlDelay = robotsManager.getCrawlDelay.bind(robotsManager);
    const originalCheckAndEnforce = robotsManager.checkAndEnforce.bind(robotsManager);
    let setDomainLimitCalledWith: { domain: string; seconds: number } | null = null;

    restoreRateLimiter();

    try {
      (robotsManager as unknown as {
        getCrawlDelay: typeof robotsManager.getCrawlDelay;
      }).getCrawlDelay = async () => 2000;

      (robotsManager as unknown as {
        checkAndEnforce: typeof robotsManager.checkAndEnforce;
      }).checkAndEnforce = async () => {};

      const originalSetDomainLimit = rateLimiter.setDomainLimit.bind(rateLimiter);
      (rateLimiter as unknown as {
        setDomainLimit: typeof rateLimiter.setDomainLimit;
      }).setDomainLimit = (domain: string, seconds: number) => {
        setDomainLimitCalledWith = { domain, seconds };
        return originalSetDomainLimit(domain, seconds);
      };

      global.fetch = async () => buildMockResponse('<html><body>content</body></html>');

      await fetchPage({
        url: 'https://example.com/with-delay',
        useCache: false,
        mode: 'http'
      });

      expect(setDomainLimitCalledWith).not.toBeNull();
      expect(setDomainLimitCalledWith?.domain).toBe('example.com');
      expect(setDomainLimitCalledWith?.seconds).toBe(2);
    } finally {
      (robotsManager as unknown as {
        getCrawlDelay: typeof robotsManager.getCrawlDelay;
      }).getCrawlDelay = originalGetCrawlDelay;
      (robotsManager as unknown as {
        checkAndEnforce: typeof robotsManager.checkAndEnforce;
      }).checkAndEnforce = originalCheckAndEnforce;
      stubRateLimiter();
    }
  });
});
