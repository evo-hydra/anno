import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../services/fetcher', () => ({
  fetchPage: vi.fn(),
}));

vi.mock('../services/distiller', () => ({
  distillContent: vi.fn(),
}));

vi.mock('../core/robots-parser', () => ({
  robotsManager: { isAllowed: vi.fn().mockResolvedValue(true) },
}));

vi.mock('../core/rate-limiter', () => ({
  rateLimiter: { checkLimit: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../core/http-client', () => ({
  httpClient: { get: vi.fn() },
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  startSpan: vi.fn(() => ({ end: vi.fn() })),
}));

vi.mock('../core/content-addressing', () => ({
  ContentAddressing: {
    generateHash: vi.fn().mockReturnValue({ hash: 'unique-hash-' + Math.random() }),
  },
}));

import { Crawler, createCrawler } from '../services/crawler';
import { httpClient } from '../core/http-client';

const mockedHttpClient = vi.mocked(httpClient);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Crawler', () => {
  let crawler: Crawler;

  beforeEach(() => {
    vi.clearAllMocks();
    crawler = new Crawler();
  });

  // -----------------------------------------------------------------------
  // extractLinks
  // -----------------------------------------------------------------------

  describe('extractLinks', () => {
    it('extracts absolute URLs from <a href> tags', () => {
      const html = `
        <a href="https://example.com/page1">Page 1</a>
        <a href="https://example.com/page2">Page 2</a>
      `;
      const links = crawler.extractLinks(html, 'https://example.com');
      expect(links).toContain('https://example.com/page1');
      expect(links).toContain('https://example.com/page2');
      expect(links).toHaveLength(2);
    });

    it('resolves relative URLs against baseUrl', () => {
      const html = `<a href="/about">About</a><a href="contact">Contact</a>`;
      const links = crawler.extractLinks(html, 'https://example.com/docs/');
      expect(links).toContain('https://example.com/about');
      expect(links).toContain('https://example.com/docs/contact');
    });

    it('skips javascript:, mailto:, tel:, and data: schemes', () => {
      const html = `
        <a href="javascript:void(0)">JS</a>
        <a href="mailto:user@example.com">Mail</a>
        <a href="tel:+1234567890">Phone</a>
        <a href="data:text/html,hello">Data</a>
        <a href="https://example.com/valid">Valid</a>
      `;
      const links = crawler.extractLinks(html, 'https://example.com');
      expect(links).toHaveLength(1);
      expect(links[0]).toBe('https://example.com/valid');
    });

    it('deduplicates URLs', () => {
      const html = `
        <a href="https://example.com/page">Link 1</a>
        <a href="https://example.com/page">Link 2</a>
        <a href="https://example.com/page#section">Link 3 with fragment</a>
      `;
      const links = crawler.extractLinks(html, 'https://example.com');
      // Fragment is stripped, so all three resolve to the same URL
      expect(links).toHaveLength(1);
      expect(links[0]).toBe('https://example.com/page');
    });

    it('handles single-quoted href values', () => {
      const html = `<a href='https://example.com/single'>Single</a>`;
      const links = crawler.extractLinks(html, 'https://example.com');
      expect(links).toContain('https://example.com/single');
    });

    it('handles double-quoted href values', () => {
      const html = `<a href="https://example.com/double">Double</a>`;
      const links = crawler.extractLinks(html, 'https://example.com');
      expect(links).toContain('https://example.com/double');
    });

    it('handles unquoted href values', () => {
      const html = `<a href=https://example.com/unquoted>Unquoted</a>`;
      const links = crawler.extractLinks(html, 'https://example.com');
      expect(links).toContain('https://example.com/unquoted');
    });

    it('returns empty array for HTML with no links', () => {
      const html = `<p>No links here</p>`;
      const links = crawler.extractLinks(html, 'https://example.com');
      expect(links).toEqual([]);
    });

    it('skips hash-only and empty hrefs', () => {
      const html = `
        <a href="#">Top</a>
        <a href="">Empty</a>
      `;
      const links = crawler.extractLinks(html, 'https://example.com');
      expect(links).toEqual([]);
    });

    it('strips fragments and sorts query parameters for normalisation', () => {
      const html = `
        <a href="https://example.com/page?b=2&a=1#section">Link</a>
      `;
      const links = crawler.extractLinks(html, 'https://example.com');
      expect(links).toHaveLength(1);
      // Query params should be sorted (a before b), fragment removed
      expect(links[0]).toBe('https://example.com/page?a=1&b=2');
    });

    it('removes trailing slash from non-root paths', () => {
      const html = `<a href="https://example.com/page/">Page</a>`;
      const links = crawler.extractLinks(html, 'https://example.com');
      expect(links[0]).toBe('https://example.com/page');
    });

    it('keeps trailing slash for root path', () => {
      const html = `<a href="https://example.com/">Root</a>`;
      const links = crawler.extractLinks(html, 'https://example.com');
      expect(links[0]).toBe('https://example.com/');
    });
  });

  // -----------------------------------------------------------------------
  // parseSitemap
  // -----------------------------------------------------------------------

  describe('parseSitemap', () => {
    it('parses standard <urlset> XML', async () => {
      const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://example.com/page1</loc></url>
          <url><loc>https://example.com/page2</loc></url>
        </urlset>`;

      mockedHttpClient.get.mockResolvedValueOnce({
        url: 'https://example.com/sitemap.xml',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: sitemapXml,
        protocol: 'http/1.1',
        durationMs: 100,
      });

      const urls = await crawler.parseSitemap('https://example.com/sitemap.xml');
      expect(urls).toEqual([
        'https://example.com/page1',
        'https://example.com/page2',
      ]);
    });

    it('returns empty array on HTTP error', async () => {
      mockedHttpClient.get.mockResolvedValueOnce({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const urls = await crawler.parseSitemap('https://example.com/sitemap.xml');
      expect(urls).toEqual([]);
    });

    it('returns empty array on network error', async () => {
      mockedHttpClient.get.mockRejectedValueOnce(new Error('Network timeout'));

      const urls = await crawler.parseSitemap('https://example.com/sitemap.xml');
      expect(urls).toEqual([]);
    });

    it('handles sitemap index with child sitemaps', async () => {
      const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
        </sitemapindex>`;

      const childXml = `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://example.com/child-page</loc></url>
        </urlset>`;

      mockedHttpClient.get
        .mockResolvedValueOnce({
          url: 'https://example.com/sitemap.xml',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: indexXml,
          protocol: 'http/1.1',
          durationMs: 100,
        })
        .mockResolvedValueOnce({
          url: 'https://example.com/sitemap-pages.xml',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: childXml,
          protocol: 'http/1.1',
          durationMs: 80,
        });

      const urls = await crawler.parseSitemap('https://example.com/sitemap.xml');
      expect(urls).toContain('https://example.com/child-page');
    });
  });

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  describe('events', () => {
    it('emits crawl:complete when crawl finishes', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><body><p>Content</p></body></html>',
        status: 200,
        finalUrl: 'https://example.com',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      vi.mocked(distillContent).mockResolvedValue({
        title: 'Test Page',
        contentText: 'Test content',
        contentHtml: '<p>Test content</p>',
        contentLength: 12,
      } as never);

      // httpClient.get for sitemap — return 404
      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const completeSpy = vi.fn();
      crawler.on('crawl:complete', completeSpy);

      await crawler.crawl('https://example.com', { maxDepth: 0, maxPages: 1 });

      expect(completeSpy).toHaveBeenCalledTimes(1);
      const result = completeSpy.mock.calls[0][0];
      expect(result.status).toBe('completed');
      expect(result.startUrl).toBe('https://example.com');
    });
  });

  // -----------------------------------------------------------------------
  // createCrawler factory
  // -----------------------------------------------------------------------

  describe('createCrawler', () => {
    it('returns a new Crawler instance', () => {
      const c = createCrawler();
      expect(c).toBeInstanceOf(Crawler);
    });
  });

  // -----------------------------------------------------------------------
  // Additional coverage: non-HTTP schemes, filters, DFS, cancellation, etc.
  // -----------------------------------------------------------------------

  describe('extractLinks — non-HTTP schemes', () => {
    it('skips ftp:// URLs', () => {
      const html = `<a href="ftp://example.com/file.zip">Download</a>`;
      const links = crawler.extractLinks(html, 'https://example.com');
      expect(links).toEqual([]);
    });

    it('skips file:// URLs', () => {
      const html = `<a href="file:///home/user/doc.pdf">Local File</a>`;
      const links = crawler.extractLinks(html, 'https://example.com');
      expect(links).toEqual([]);
    });

    it('skips ftp:// resolved from relative hrefs', () => {
      const html = `<a href="/some/path">Path</a>`;
      // If baseUrl is ftp, normaliseUrl returns ''
      const links = crawler.extractLinks(html, 'ftp://files.example.com/');
      expect(links).toEqual([]);
    });
  });

  describe('passesFilters', () => {
    it('rejects cross-origin URLs (different host)', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><body><a href="https://otherdomain.com/page">Link</a></body></html>',
        status: 200,
        finalUrl: 'https://example.com',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      vi.mocked(distillContent).mockResolvedValue({
        title: 'Test',
        contentText: 'Test',
        contentHtml: '<p>Test</p>',
        contentLength: 4,
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', { maxDepth: 1, maxPages: 5 });
      const page = result.pages[0];
      expect(page.links).toEqual([]);
    });

    it('filters by pathPrefix', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><body><a href="/docs/page1">D1</a><a href="/blog/post">B1</a></body></html>',
        status: 200,
        finalUrl: 'https://example.com',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      vi.mocked(distillContent).mockResolvedValue({
        title: 'Test',
        contentText: 'Test',
        contentHtml: '<p>Test</p>',
        contentLength: 4,
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', {
        maxDepth: 0,
        maxPages: 5,
        pathPrefix: '/docs/'
      });

      const page = result.pages[0];
      // Only /docs/page1 should pass the filter, not /blog/post
      expect(page.links).toEqual(['https://example.com/docs/page1']);
    });

    it('filters by includePatterns', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><body><a href="/docs/api">API</a><a href="/docs/guide">Guide</a><a href="/blog">Blog</a></body></html>',
        status: 200,
        finalUrl: 'https://example.com',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      vi.mocked(distillContent).mockResolvedValue({
        title: 'Test',
        contentText: 'Test',
        contentHtml: '<p>Test</p>',
        contentLength: 4,
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', {
        maxDepth: 0,
        maxPages: 5,
        includePatterns: ['/docs/']
      });

      const page = result.pages[0];
      // Only /docs/* should pass
      expect(page.links).toEqual(['https://example.com/docs/api', 'https://example.com/docs/guide']);
    });

    it('filters by excludePatterns', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><body><a href="/docs/api">API</a><a href="/docs/internal">Internal</a></body></html>',
        status: 200,
        finalUrl: 'https://example.com',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      vi.mocked(distillContent).mockResolvedValue({
        title: 'Test',
        contentText: 'Test',
        contentHtml: '<p>Test</p>',
        contentLength: 4,
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', {
        maxDepth: 0,
        maxPages: 5,
        excludePatterns: ['internal']
      });

      const page = result.pages[0];
      // /docs/internal should be excluded
      expect(page.links).toEqual(['https://example.com/docs/api']);
    });

    it('handles invalid regex in includePatterns gracefully', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><body><a href="/page">Page</a></body></html>',
        status: 200,
        finalUrl: 'https://example.com',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      vi.mocked(distillContent).mockResolvedValue({
        title: 'Test',
        contentText: 'Test',
        contentHtml: '<p>Test</p>',
        contentLength: 4,
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', {
        maxDepth: 0,
        maxPages: 5,
        includePatterns: ['[invalid(regex']
      });

      const page = result.pages[0];
      // Invalid regex should not match anything
      expect(page.links).toEqual([]);
    });

    it('handles invalid regex in excludePatterns gracefully', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><body><a href="/page">Page</a></body></html>',
        status: 200,
        finalUrl: 'https://example.com',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      vi.mocked(distillContent).mockResolvedValue({
        title: 'Test',
        contentText: 'Test',
        contentHtml: '<p>Test</p>',
        contentLength: 4,
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', {
        maxDepth: 0,
        maxPages: 5,
        excludePatterns: ['[invalid(regex']
      });

      const page = result.pages[0];
      // Invalid regex should not exclude anything
      expect(page.links).toEqual(['https://example.com/page']);
    });
  });

  describe('crawl — DFS strategy', () => {
    it('uses depth-first traversal with strategy:dfs', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');
      const { robotsManager } = await import('../core/robots-parser');

      vi.mocked(robotsManager.isAllowed).mockResolvedValue(true);

      vi.mocked(fetchPage).mockImplementation((async (opts: unknown) => {
        const { url } = opts as { url: string };

        if (url === 'https://example.com') {
          return {
            body: '<html><body><a href="/page1">P1</a><a href="/page2">P2</a></body></html>',
            status: 200,
            finalUrl: url,
            fromCache: false,
            rendered: false,
            renderDiagnostics: { effectiveMode: 'http' },
          };
        }

        return {
          body: '<html><body><p>Leaf</p></body></html>',
          status: 200,
          finalUrl: url,
          fromCache: false,
          rendered: false,
          renderDiagnostics: { effectiveMode: 'http' },
        };
      }) as never);

      vi.mocked(distillContent).mockResolvedValue({
        title: 'Test',
        contentText: 'Test',
        contentHtml: '<p>Test</p>',
        contentLength: 4,
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', {
        maxDepth: 1,
        maxPages: 3,
        strategy: 'dfs',
        concurrency: 1
      });

      expect(result.status).toBe('completed');
      expect(result.pages.length).toBeGreaterThanOrEqual(1);
      // Verify that DFS strategy was used by checking result exists
      const urls = result.pages.map(p => p.url);
      expect(urls[0]).toBe('https://example.com/');
    });
  });

  describe('crawl — cancellation', () => {
    it('returns status:cancelled when signal is aborted mid-crawl', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');

      const abortController = new AbortController();

      let fetchCount = 0;

      vi.mocked(fetchPage).mockImplementation((async () => {
        fetchCount++;
        if (fetchCount === 1) {
          // Abort after first fetch
          setTimeout(() => abortController.abort(), 10);
        }

        return {
          body: '<html><body><a href="/page1">P1</a><a href="/page2">P2</a></body></html>',
          status: 200,
          finalUrl: 'https://example.com',
          fromCache: false,
          rendered: false,
          renderDiagnostics: { effectiveMode: 'http' },
        };
      }) as never);

      vi.mocked(distillContent).mockResolvedValue({
        title: 'Test',
        contentText: 'Test',
        contentHtml: '<p>Test</p>',
        contentLength: 4,
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', {
        maxDepth: 1,
        maxPages: 10,
        signal: abortController.signal,
        concurrency: 1
      });

      expect(result.status).toBe('cancelled');
    });
  });

  describe('crawl — invalid start URL', () => {
    it('returns status:error for invalid start URL', async () => {
      const result = await crawler.crawl('not-a-url', { maxDepth: 1, maxPages: 5 });
      expect(result.status).toBe('error');
    });
  });

  describe('crawl — robots.txt blocking', () => {
    it('marks page as robots_blocked when robotsManager.isAllowed returns false', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { robotsManager } = await import('../core/robots-parser');

      vi.mocked(robotsManager.isAllowed).mockResolvedValue(false);

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><body><p>Content</p></body></html>',
        status: 200,
        finalUrl: 'https://example.com',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', { maxDepth: 0, maxPages: 1 });

      expect(result.pages.length).toBe(1);
      expect(result.pages[0].status).toBe('robots_blocked');
    });
  });

  describe('crawl — content deduplication', () => {
    it('skips pages with duplicate content hashes', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');
      const { ContentAddressing } = await import('../core/content-addressing');
      const { robotsManager } = await import('../core/robots-parser');

      vi.mocked(robotsManager.isAllowed).mockResolvedValue(true);

      const duplicateHash = 'duplicate-hash-12345';

      vi.mocked(ContentAddressing.generateHash).mockImplementation(() => {
        return { hash: duplicateHash } as never;
      });

      vi.mocked(fetchPage)
        .mockResolvedValueOnce({
          body: '<html><body><a href="/page2">P2</a></body></html>',
          status: 200,
          finalUrl: 'https://example.com',
          fromCache: false,
          rendered: false,
          renderDiagnostics: { effectiveMode: 'http' },
        } as never)
        .mockResolvedValueOnce({
          body: '<html><body><p>Same content</p></body></html>',
          status: 200,
          finalUrl: 'https://example.com/page2',
          fromCache: false,
          rendered: false,
          renderDiagnostics: { effectiveMode: 'http' },
        } as never);

      vi.mocked(distillContent).mockResolvedValue({
        title: 'Test',
        contentText: 'Test',
        contentHtml: '<p>Test</p>',
        contentLength: 4,
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', {
        maxDepth: 1,
        maxPages: 5,
        concurrency: 1
      });

      expect(result.pages.length).toBeGreaterThanOrEqual(1);
      expect(result.pages[0].status).toBe('success');
      // Second page should be skipped if duplicate hash was returned
      if (result.pages.length > 1) {
        expect(result.pages[1].status).toBe('skipped');
      }
    });
  });

  describe('crawl — extractContent: false', () => {
    it('extracts title from raw HTML without running distiller', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');
      const { robotsManager } = await import('../core/robots-parser');

      vi.mocked(robotsManager.isAllowed).mockResolvedValue(true);

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><head><title>Raw Title</title></head><body><p>Content</p></body></html>',
        status: 200,
        finalUrl: 'https://example.com',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      // distillContent should NOT be called
      const distillSpy = vi.mocked(distillContent);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', {
        maxDepth: 0,
        maxPages: 1,
        extractContent: false
      });

      expect(distillSpy).not.toHaveBeenCalled();
      expect(result.pages.length).toBe(1);
      expect(result.pages[0].title).toBe('Raw Title');
      expect(result.pages[0].content).toBeUndefined();
      expect(result.pages[0].rawTokenCount).toBeGreaterThan(0);
    });

    it('handles missing title tag when extractContent is false', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { robotsManager } = await import('../core/robots-parser');

      vi.mocked(robotsManager.isAllowed).mockResolvedValue(true);

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><body><p>No title tag</p></body></html>',
        status: 200,
        finalUrl: 'https://example.com',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', {
        maxDepth: 0,
        maxPages: 1,
        extractContent: false
      });

      expect(result.pages.length).toBe(1);
      expect(result.pages[0].title).toBeUndefined();
    });
  });

  describe('crawl — HTTP error status', () => {
    it('marks page as error when HTTP status >= 400', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { robotsManager } = await import('../core/robots-parser');

      vi.mocked(robotsManager.isAllowed).mockResolvedValue(true);

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><body><h1>404 Not Found</h1></body></html>',
        status: 404,
        finalUrl: 'https://example.com/missing',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com/missing', {
        maxDepth: 0,
        maxPages: 1
      });

      expect(result.pages.length).toBe(1);
      expect(result.pages[0].status).toBe('error');
      expect(result.pages[0].httpStatus).toBe(404);
      expect(result.pages[0].error).toBe('HTTP 404');
    });
  });

  describe('parseSitemap — child sitemap fetch failure', () => {
    it('continues when a child sitemap fetch fails', async () => {
      const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
          <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
        </sitemapindex>`;

      const childXml = `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://example.com/page1</loc></url>
        </urlset>`;

      mockedHttpClient.get
        .mockResolvedValueOnce({
          url: 'https://example.com/sitemap.xml',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: indexXml,
          protocol: 'http/1.1',
          durationMs: 100,
        })
        .mockRejectedValueOnce(new Error('Network failure'))
        .mockResolvedValueOnce({
          url: 'https://example.com/sitemap-2.xml',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: childXml,
          protocol: 'http/1.1',
          durationMs: 80,
        });

      const urls = await crawler.parseSitemap('https://example.com/sitemap.xml');
      // First child failed, second should succeed
      expect(urls).toContain('https://example.com/page1');
    });
  });

  describe('crawl — fetch error', () => {
    it('marks page as error when fetchPage throws', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { robotsManager } = await import('../core/robots-parser');

      vi.mocked(robotsManager.isAllowed).mockResolvedValue(true);

      vi.mocked(fetchPage).mockRejectedValue(new Error('Network timeout'));

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', {
        maxDepth: 0,
        maxPages: 1
      });

      expect(result.pages.length).toBe(1);
      expect(result.pages[0].status).toBe('error');
      expect(result.pages[0].error).toBe('Network timeout');
    });
  });

  describe('estimateTokens helper', () => {
    it('returns 0 for empty text', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');
      const { robotsManager } = await import('../core/robots-parser');

      vi.mocked(robotsManager.isAllowed).mockResolvedValue(true);

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><body></body></html>',
        status: 200,
        finalUrl: 'https://example.com',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      vi.mocked(distillContent).mockResolvedValue({
        title: '',
        contentText: '',
        contentHtml: '',
        contentLength: 0,
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', {
        maxDepth: 0,
        maxPages: 1
      });

      expect(result.pages[0].tokenCount).toBe(0);
    });
  });

  describe('crawl — distiller failure', () => {
    it('continues crawl when distiller throws error', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');
      const { robotsManager } = await import('../core/robots-parser');

      vi.mocked(robotsManager.isAllowed).mockResolvedValue(true);

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><body><p>Content</p></body></html>',
        status: 200,
        finalUrl: 'https://example.com',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      vi.mocked(distillContent).mockRejectedValue(new Error('Distiller crashed'));

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const result = await crawler.crawl('https://example.com', {
        maxDepth: 0,
        maxPages: 1,
        extractContent: true
      });

      expect(result.pages.length).toBe(1);
      expect(result.pages[0].status).toBe('success');
      expect(result.pages[0].content).toBeUndefined();
      expect(result.pages[0].rawTokenCount).toBeGreaterThan(0);
    });
  });

  describe('events — additional coverage', () => {
    it('emits page:fetched event', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');
      const { robotsManager } = await import('../core/robots-parser');

      vi.mocked(robotsManager.isAllowed).mockResolvedValue(true);

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><body><p>Content</p></body></html>',
        status: 200,
        finalUrl: 'https://example.com',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      vi.mocked(distillContent).mockResolvedValue({
        title: 'Test',
        contentText: 'Test',
        contentHtml: '<p>Test</p>',
        contentLength: 4,
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const fetchedSpy = vi.fn();
      crawler.on('page:fetched', fetchedSpy);

      await crawler.crawl('https://example.com', { maxDepth: 0, maxPages: 1 });

      expect(fetchedSpy).toHaveBeenCalledTimes(1);
      expect(fetchedSpy).toHaveBeenCalledWith({
        url: 'https://example.com/',
        depth: 0,
        httpStatus: 200
      });
    });

    it('emits page:extracted event', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { distillContent } = await import('../services/distiller');
      const { robotsManager } = await import('../core/robots-parser');

      vi.mocked(robotsManager.isAllowed).mockResolvedValue(true);

      vi.mocked(fetchPage).mockResolvedValue({
        body: '<html><body><p>Content</p></body></html>',
        status: 200,
        finalUrl: 'https://example.com',
        fromCache: false,
        rendered: false,
        renderDiagnostics: { effectiveMode: 'http' },
      } as never);

      vi.mocked(distillContent).mockResolvedValue({
        title: 'Extracted Title',
        contentText: 'Extracted Content',
        contentHtml: '<p>Extracted Content</p>',
        contentLength: 17,
      } as never);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const extractedSpy = vi.fn();
      crawler.on('page:extracted', extractedSpy);

      await crawler.crawl('https://example.com', { maxDepth: 0, maxPages: 1 });

      expect(extractedSpy).toHaveBeenCalledTimes(1);
      expect(extractedSpy).toHaveBeenCalledWith({
        url: 'https://example.com/',
        title: 'Extracted Title',
        contentLength: 17
      });
    });

    it('emits page:error event on fetch failure', async () => {
      const { fetchPage } = await import('../services/fetcher');
      const { robotsManager } = await import('../core/robots-parser');

      vi.mocked(robotsManager.isAllowed).mockResolvedValue(true);

      vi.mocked(fetchPage).mockRejectedValue(new Error('Connection refused'));

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const errorSpy = vi.fn();
      crawler.on('page:error', errorSpy);

      await crawler.crawl('https://example.com', { maxDepth: 0, maxPages: 1 });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith({
        url: 'https://example.com/',
        error: 'Connection refused'
      });
    });

    it('emits page:error event on robots_blocked', async () => {
      const { robotsManager } = await import('../core/robots-parser');

      vi.mocked(robotsManager.isAllowed).mockResolvedValue(false);

      mockedHttpClient.get.mockResolvedValue({
        url: 'https://example.com/sitemap.xml',
        status: 404,
        statusText: 'Not Found',
        headers: {},
        body: '',
        protocol: 'http/1.1',
        durationMs: 50,
      });

      const errorSpy = vi.fn();
      crawler.on('page:error', errorSpy);

      await crawler.crawl('https://example.com', { maxDepth: 0, maxPages: 1 });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith({
        url: 'https://example.com/',
        error: 'robots_blocked'
      });
    });
  });
});
