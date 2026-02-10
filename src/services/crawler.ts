/**
 * Crawler Service
 *
 * Real link-based web crawler that discovers pages by parsing links from
 * rendered (or HTTP-fetched) pages. Supports BFS/DFS traversal, sitemap
 * parsing, robots.txt compliance, rate limiting, and content extraction.
 *
 * @module crawler
 */

import { EventEmitter } from 'events';
import { logger, startSpan } from '../utils/logger';
import { fetchPage, type FetchMode } from './fetcher';
import { distillContent } from './distiller';
import { robotsManager } from '../core/robots-parser';
import { rateLimiter } from '../core/rate-limiter';
import { ContentAddressing } from '../core/content-addressing';
import { httpClient } from '../core/http-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrawlOptions {
  /** Maximum link-follow depth from the start URL. Default 2. */
  maxDepth?: number;
  /** Maximum number of pages to fetch. Default 20. */
  maxPages?: number;
  /** Only follow links whose pathname starts with this prefix (e.g. '/docs/'). */
  pathPrefix?: string;
  /** Regex patterns — a URL must match at least one to be included. */
  includePatterns?: string[];
  /** Regex patterns — a URL matching any of these is excluded. */
  excludePatterns?: string[];
  /** Honour robots.txt directives. Default true. */
  respectRobots?: boolean;
  /** Use Playwright for JS rendering. Default false (plain HTTP). */
  renderJs?: boolean;
  /** Run distiller on each fetched page. Default true. */
  extractContent?: boolean;
  /** Number of pages fetched concurrently. Default 2. */
  concurrency?: number;
  /** Traversal order. Default 'bfs'. */
  strategy?: 'bfs' | 'dfs';
  /** Override automatic sitemap discovery with a specific URL. */
  sitemapUrl?: string;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface CrawlPage {
  url: string;
  depth: number;
  status: 'success' | 'error' | 'skipped' | 'robots_blocked';
  httpStatus?: number;
  title?: string;
  content?: string;
  links: string[];
  tokenCount?: number;
  rawTokenCount?: number;
  error?: string;
  fetchDuration: number;
}

export interface CrawlResult {
  startUrl: string;
  options: CrawlOptions;
  status: 'running' | 'completed' | 'cancelled' | 'error';
  pages: CrawlPage[];
  stats: {
    totalPages: number;
    successPages: number;
    errorPages: number;
    skippedPages: number;
    totalTokens: number;
    totalRawTokens: number;
    tokenSavingsPercent: number;
    totalDuration: number;
    uniqueDomains: number;
  };
}

interface QueueEntry {
  url: string;
  depth: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Rough token estimate: ~4 characters per token for English text.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

/**
 * Link-following web crawler with content extraction.
 *
 * Emits the following events:
 * - `page:fetched`   — { url, depth, httpStatus }
 * - `page:extracted`  — { url, title, contentLength }
 * - `page:error`      — { url, error }
 * - `crawl:complete`  — CrawlResult
 */
export class Crawler extends EventEmitter {

  // -----------------------------------------------------------------------
  // Link extraction
  // -----------------------------------------------------------------------

  /**
   * Extract and normalise all `<a href>` links from an HTML document.
   *
   * @param html      - Raw HTML string
   * @param baseUrl   - The URL of the page (used to resolve relative hrefs)
   * @returns Array of unique, normalised absolute URLs
   */
  extractLinks(html: string, baseUrl: string): string[] {
    const seen = new Set<string>();
    const results: string[] = [];

    // Use a regex-based approach to avoid spinning up a full JSDOM for every
    // page.  The pattern handles single-quoted, double-quoted, and unquoted
    // href values.
    const hrefRegex = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi;

    let match: RegExpExecArray | null;
    while ((match = hrefRegex.exec(html)) !== null) {
      const raw = match[1] ?? match[2] ?? match[3];
      if (!raw) continue;

      // Skip non-HTTP schemes
      const trimmed = raw.trim();
      if (
        trimmed.startsWith('javascript:') ||
        trimmed.startsWith('mailto:') ||
        trimmed.startsWith('tel:') ||
        trimmed.startsWith('data:') ||
        trimmed === '#' ||
        trimmed === ''
      ) {
        continue;
      }

      try {
        const resolved = new URL(trimmed, baseUrl);
        const normalised = this.normaliseUrl(resolved);
        if (normalised && !seen.has(normalised)) {
          seen.add(normalised);
          results.push(normalised);
        }
      } catch {
        // Malformed URL — skip silently
      }
    }

    return results;
  }

  /**
   * Normalise a URL: lowercase scheme + host, remove fragment, sort query
   * parameters, remove trailing slash on path (except root `/`).
   */
  private normaliseUrl(parsed: URL): string {
    // Only crawl http(s)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }

    // Remove fragment
    parsed.hash = '';

    // Sort query params for deterministic comparison
    const params = new URLSearchParams(parsed.searchParams);
    const sortedParams = new URLSearchParams([...params.entries()].sort());
    parsed.search = sortedParams.toString() ? `?${sortedParams.toString()}` : '';

    // Lowercase scheme + host (URL constructor already lowercases host)
    let href = parsed.href;

    // Remove trailing slash (keep root '/')
    if (href.endsWith('/') && parsed.pathname !== '/') {
      href = href.slice(0, -1);
    }

    return href;
  }

  /**
   * Check whether a URL passes the include/exclude/pathPrefix filters.
   */
  private passesFilters(url: string, baseUrl: string, options: CrawlOptions): boolean {
    let parsed: URL;
    let baseParsed: URL;
    try {
      parsed = new URL(url);
      baseParsed = new URL(baseUrl);
    } catch {
      return false;
    }

    // Same-origin enforcement (always — we only follow links on the same host)
    if (parsed.host !== baseParsed.host) {
      return false;
    }

    // Path prefix filter
    if (options.pathPrefix && !parsed.pathname.startsWith(options.pathPrefix)) {
      return false;
    }

    // Include patterns (at least one must match)
    if (options.includePatterns && options.includePatterns.length > 0) {
      const included = options.includePatterns.some((pat) => {
        try {
          return new RegExp(pat).test(url);
        } catch {
          return false;
        }
      });
      if (!included) return false;
    }

    // Exclude patterns (none must match)
    if (options.excludePatterns && options.excludePatterns.length > 0) {
      const excluded = options.excludePatterns.some((pat) => {
        try {
          return new RegExp(pat).test(url);
        } catch {
          return false;
        }
      });
      if (excluded) return false;
    }

    return true;
  }

  // -----------------------------------------------------------------------
  // Sitemap support
  // -----------------------------------------------------------------------

  /**
   * Fetch and parse a sitemap.xml (or sitemap index) and return discovered URLs.
   *
   * Handles:
   * - Standard `<urlset>` with `<url><loc>…</loc></url>` entries
   * - Sitemap index `<sitemapindex>` with `<sitemap><loc>…</loc></sitemap>`
   *   (recurses one level for nested sitemaps)
   *
   * @param sitemapUrl - Full URL to the sitemap.xml
   * @returns Array of page URLs found in the sitemap
   */
  async parseSitemap(sitemapUrl: string): Promise<string[]> {
    const span = startSpan('crawler-parse-sitemap');
    const urls: string[] = [];

    try {
      logger.info('Crawler: fetching sitemap', { url: sitemapUrl });

      const response = await httpClient.get(sitemapUrl);
      if (response.status !== 200) {
        logger.debug('Crawler: sitemap returned non-200', { url: sitemapUrl, status: response.status });
        span.end({ status: response.status });
        return [];
      }

      const xml = response.body;

      // Check for sitemap index
      if (xml.includes('<sitemapindex')) {
        const locRegex = /<sitemap>\s*<loc>\s*(.*?)\s*<\/loc>/gi;
        const childSitemaps: string[] = [];
        let locMatch: RegExpExecArray | null;
        while ((locMatch = locRegex.exec(xml)) !== null) {
          if (locMatch[1]) {
            childSitemaps.push(locMatch[1].trim());
          }
        }

        logger.info('Crawler: sitemap index found', { childCount: childSitemaps.length });

        // Recurse into child sitemaps (one level only)
        for (const childUrl of childSitemaps) {
          try {
            const childResponse = await httpClient.get(childUrl);
            if (childResponse.status === 200) {
              const childUrls = this.extractSitemapUrls(childResponse.body);
              urls.push(...childUrls);
            }
          } catch (err) {
            logger.warn('Crawler: failed to fetch child sitemap', {
              url: childUrl,
              error: err instanceof Error ? err.message : 'unknown'
            });
          }
        }
      } else {
        // Standard <urlset>
        urls.push(...this.extractSitemapUrls(xml));
      }

      logger.info('Crawler: sitemap parsed', { urlCount: urls.length, sitemapUrl });
      span.end({ urlCount: urls.length });
    } catch (error) {
      logger.warn('Crawler: sitemap fetch failed', {
        url: sitemapUrl,
        error: error instanceof Error ? error.message : 'unknown'
      });
      span.end({ error: error instanceof Error ? error.message : 'unknown' });
    }

    return urls;
  }

  /**
   * Extract `<loc>` URLs from a `<urlset>` XML body.
   */
  private extractSitemapUrls(xml: string): string[] {
    const urls: string[] = [];
    const locRegex = /<url>\s*<loc>\s*(.*?)\s*<\/loc>/gi;
    let match: RegExpExecArray | null;
    while ((match = locRegex.exec(xml)) !== null) {
      if (match[1]) {
        urls.push(match[1].trim());
      }
    }
    return urls;
  }

  // -----------------------------------------------------------------------
  // Main crawl orchestration
  // -----------------------------------------------------------------------

  /**
   * Crawl starting from `startUrl`, discovering pages via link extraction.
   *
   * @param startUrl - The seed URL to begin crawling from
   * @param options  - Crawl configuration
   * @returns The complete CrawlResult when finished
   */
  async crawl(startUrl: string, options: CrawlOptions = {}): Promise<CrawlResult> {
    const span = startSpan('crawler-crawl');
    const crawlStart = Date.now();

    // Merge defaults
    const opts: Required<Omit<CrawlOptions, 'pathPrefix' | 'includePatterns' | 'excludePatterns' | 'sitemapUrl' | 'signal'>> & CrawlOptions = {
      maxDepth: options.maxDepth ?? 2,
      maxPages: options.maxPages ?? 20,
      respectRobots: options.respectRobots ?? true,
      renderJs: options.renderJs ?? false,
      extractContent: options.extractContent ?? true,
      concurrency: options.concurrency ?? 2,
      strategy: options.strategy ?? 'bfs',
      pathPrefix: options.pathPrefix,
      includePatterns: options.includePatterns,
      excludePatterns: options.excludePatterns,
      sitemapUrl: options.sitemapUrl,
      signal: options.signal
    };

    logger.info('Crawler: starting crawl', {
      startUrl,
      maxDepth: opts.maxDepth,
      maxPages: opts.maxPages,
      strategy: opts.strategy,
      renderJs: opts.renderJs,
      concurrency: opts.concurrency
    });

    // State
    const visited = new Set<string>();
    const contentHashes = new Set<string>();
    const queue: QueueEntry[] = [];
    const pages: CrawlPage[] = [];
    const domains = new Set<string>();

    const result: CrawlResult = {
      startUrl,
      options: opts,
      status: 'running',
      pages,
      stats: {
        totalPages: 0,
        successPages: 0,
        errorPages: 0,
        skippedPages: 0,
        totalTokens: 0,
        totalRawTokens: 0,
        tokenSavingsPercent: 0,
        totalDuration: 0,
        uniqueDomains: 0
      }
    };

    // Helper: check cancellation
    const isCancelled = (): boolean => {
      return opts.signal?.aborted === true;
    };

    // Normalise the start URL and seed the queue
    let normalisedStart: string;
    try {
      normalisedStart = this.normaliseUrl(new URL(startUrl));
    } catch {
      result.status = 'error';
      span.end({ error: 'invalid start URL' });
      return result;
    }

    // Attempt sitemap discovery before BFS
    try {
      const baseParsed = new URL(normalisedStart);
      const sitemapUrl = opts.sitemapUrl || `${baseParsed.protocol}//${baseParsed.host}/sitemap.xml`;

      const sitemapUrls = await this.parseSitemap(sitemapUrl);
      for (const sUrl of sitemapUrls) {
        try {
          const normalised = this.normaliseUrl(new URL(sUrl));
          if (normalised && !visited.has(normalised) && this.passesFilters(normalised, normalisedStart, opts)) {
            // Sitemap URLs go in at depth 1 (they are one hop from root)
            queue.push({ url: normalised, depth: 1 });
            visited.add(normalised);
          }
        } catch {
          // Skip malformed sitemap URLs
        }
      }

      if (sitemapUrls.length > 0) {
        logger.info('Crawler: seeded queue from sitemap', { count: queue.length });
      }
    } catch {
      // Sitemap fetch failure is non-fatal
    }

    // Ensure the start URL itself is first in the queue
    if (!visited.has(normalisedStart)) {
      queue.unshift({ url: normalisedStart, depth: 0 });
      visited.add(normalisedStart);
    } else {
      // It was found in the sitemap — make sure it's at depth 0 and at the front
      const idx = queue.findIndex((e) => e.url === normalisedStart);
      if (idx >= 0) {
        queue.splice(idx, 1);
      }
      queue.unshift({ url: normalisedStart, depth: 0 });
    }

    // Concurrency control — simple semaphore using a counter + promises
    let inflight = 0;
    const inflightResolvers: Array<() => void> = [];

    const acquireSlot = async (): Promise<void> => {
      if (inflight < opts.concurrency) {
        inflight++;
        return;
      }
      await new Promise<void>((resolve) => {
        inflightResolvers.push(resolve);
      });
      inflight++;
    };

    const releaseSlot = (): void => {
      inflight--;
      if (inflightResolvers.length > 0) {
        const resolve = inflightResolvers.shift()!;
        resolve();
      }
    };

    /**
     * Process a single queue entry — fetch, extract content, discover links.
     */
    const processEntry = async (entry: QueueEntry): Promise<void> => {
      if (isCancelled()) return;
      if (pages.length >= opts.maxPages) return;

      const { url, depth } = entry;
      const pageStart = Date.now();

      try {
        domains.add(new URL(url).host);
      } catch {
        // ignore
      }

      // Robots check
      if (opts.respectRobots) {
        try {
          const allowed = await robotsManager.isAllowed(url);
          if (!allowed) {
            const page: CrawlPage = {
              url,
              depth,
              status: 'robots_blocked',
              links: [],
              fetchDuration: Date.now() - pageStart
            };
            pages.push(page);
            logger.info('Crawler: blocked by robots.txt', { url });
            this.emit('page:error', { url, error: 'robots_blocked' });
            return;
          }
        } catch {
          // On error checking robots, proceed anyway
        }
      }

      // Rate limiting
      try {
        await rateLimiter.checkLimit(url);
      } catch {
        // Non-fatal
      }

      // Fetch
      const fetchMode: FetchMode = opts.renderJs ? 'rendered' : 'http';

      let htmlBody: string;
      let httpStatus: number;
      let finalUrl: string;
      try {
        const fetchResult = await fetchPage({
          url,
          useCache: true,
          mode: fetchMode
        });

        htmlBody = fetchResult.body;
        httpStatus = fetchResult.status;
        finalUrl = fetchResult.finalUrl;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'fetch failed';
        const page: CrawlPage = {
          url,
          depth,
          status: 'error',
          links: [],
          error: errMsg,
          fetchDuration: Date.now() - pageStart
        };
        pages.push(page);
        logger.warn('Crawler: fetch error', { url, error: errMsg });
        this.emit('page:error', { url, error: errMsg });
        return;
      }

      this.emit('page:fetched', { url, depth, httpStatus });

      // Content dedup via content addressing
      const contentHash = ContentAddressing.generateHash(htmlBody, { url: finalUrl });
      if (contentHashes.has(contentHash.hash)) {
        const page: CrawlPage = {
          url,
          depth,
          status: 'skipped',
          httpStatus,
          links: [],
          fetchDuration: Date.now() - pageStart
        };
        pages.push(page);
        logger.debug('Crawler: duplicate content skipped', { url, hash: contentHash.hash.slice(0, 16) });
        return;
      }
      contentHashes.add(contentHash.hash);

      // Extract links (regardless of extractContent flag — we need them for crawling)
      const discoveredLinks = this.extractLinks(htmlBody, finalUrl);
      const filteredLinks = discoveredLinks.filter((link) =>
        this.passesFilters(link, normalisedStart, opts)
      );

      // Enqueue newly discovered links if within depth budget
      if (depth < opts.maxDepth) {
        for (const link of filteredLinks) {
          if (!visited.has(link)) {
            visited.add(link);
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      }

      // Content extraction
      let title: string | undefined;
      let content: string | undefined;
      let tokenCount: number | undefined;
      let rawTokenCount: number | undefined;

      if (opts.extractContent) {
        try {
          const distilled = await distillContent(htmlBody, finalUrl);
          title = distilled.title;
          content = distilled.contentText;
          tokenCount = estimateTokens(content);
          rawTokenCount = estimateTokens(htmlBody);

          this.emit('page:extracted', {
            url,
            title,
            contentLength: content.length
          });
        } catch (err) {
          logger.warn('Crawler: content extraction failed', {
            url,
            error: err instanceof Error ? err.message : 'unknown'
          });
          // Still count as success for fetching — just no extracted content
          rawTokenCount = estimateTokens(htmlBody);
        }
      } else {
        // Without extraction, provide raw token estimate
        rawTokenCount = estimateTokens(htmlBody);

        // Still try to get the title from the raw HTML
        try {
          const titleMatch = htmlBody.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          if (titleMatch && titleMatch[1]) {
            title = titleMatch[1].trim();
          }
        } catch {
          // ignore
        }
      }

      const page: CrawlPage = {
        url,
        depth,
        status: httpStatus >= 200 && httpStatus < 400 ? 'success' : 'error',
        httpStatus,
        title,
        content,
        links: filteredLinks,
        tokenCount,
        rawTokenCount,
        fetchDuration: Date.now() - pageStart
      };

      if (httpStatus >= 400) {
        page.error = `HTTP ${httpStatus}`;
      }

      pages.push(page);
    };

    // -----------------------------------------------------------------------
    // Main loop
    // -----------------------------------------------------------------------

    try {
      while (queue.length > 0 && pages.length < opts.maxPages && !isCancelled()) {
        // Take the next entry according to strategy
        const entry = opts.strategy === 'dfs' ? queue.pop()! : queue.shift()!;

        await acquireSlot();

        // Fire and forget (with slot release), but collect in-flight promises
        // so we can wait for the batch to complete before finishing.
        processEntry(entry)
          .catch((err) => {
            logger.error('Crawler: unexpected error in processEntry', {
              url: entry.url,
              error: err instanceof Error ? err.message : 'unknown'
            });
          })
          .finally(() => {
            releaseSlot();
          });

        // If the queue is temporarily empty but work is still in flight,
        // wait briefly for new links to be discovered.
        if (queue.length === 0 && inflight > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }

      // Wait for all in-flight work to finish
      while (inflight > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }

      result.status = isCancelled() ? 'cancelled' : 'completed';
    } catch (error) {
      result.status = 'error';
      logger.error('Crawler: crawl loop error', {
        error: error instanceof Error ? error.message : 'unknown'
      });
    }

    // Compute stats
    const successPages = pages.filter((p) => p.status === 'success');
    const errorPages = pages.filter((p) => p.status === 'error');
    const skippedPages = pages.filter((p) => p.status === 'skipped' || p.status === 'robots_blocked');
    const totalTokens = pages.reduce((sum, p) => sum + (p.tokenCount ?? 0), 0);
    const totalRawTokens = pages.reduce((sum, p) => sum + (p.rawTokenCount ?? 0), 0);
    const totalDuration = Date.now() - crawlStart;

    result.stats = {
      totalPages: pages.length,
      successPages: successPages.length,
      errorPages: errorPages.length,
      skippedPages: skippedPages.length,
      totalTokens,
      totalRawTokens,
      tokenSavingsPercent: totalRawTokens > 0
        ? Math.round(((totalRawTokens - totalTokens) / totalRawTokens) * 100)
        : 0,
      totalDuration,
      uniqueDomains: domains.size
    };

    logger.info('Crawler: crawl complete', {
      startUrl,
      status: result.status,
      pagesTotal: result.stats.totalPages,
      pagesSuccess: result.stats.successPages,
      pagesError: result.stats.errorPages,
      durationMs: totalDuration
    });

    span.end({
      status: result.status,
      pages: result.stats.totalPages,
      durationMs: totalDuration
    });

    this.emit('crawl:complete', result);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Factory / singleton
// ---------------------------------------------------------------------------

/**
 * Create a new Crawler instance.
 *
 * Each crawl operation should generally use its own Crawler so that event
 * listeners are scoped to a single crawl job.
 */
export function createCrawler(): Crawler {
  return new Crawler();
}
