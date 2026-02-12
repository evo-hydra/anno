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
});
