import { cache, type CacheEntry } from './cache';
import { config } from '../config/env';
import { logger, startSpan } from '../utils/logger';
import { initRenderer, rendererManager } from './renderer';
import { recordCacheValidation, recordFetchMetrics } from './metrics';
import { robotsManager } from '../core/robots-parser';
import { rateLimiter } from '../core/rate-limiter';
import { httpClient } from '../core/http-client';

export type FetchMode = 'http' | 'rendered';

export interface FetchRequestOptions {
  url: string;
  useCache: boolean;
  mode: FetchMode;
}

export interface RenderDiagnostics {
  requestedMode: FetchMode;
  effectiveMode: FetchMode;
  attempted: boolean;
  fallbackReason?: string;
  errorMessage?: string;
  rendererStatus?: {
    initialized: boolean;
    queuePending: number;
    queueAvailable: number;
    queueMax: number;
  };
  attemptDurationMs?: number;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  fetchTimestamp: number;
  durationMs: number;
  fromCache: boolean;
  rendered: boolean;
  renderDiagnostics: RenderDiagnostics;
}

const cacheKeyFor = (url: string, mode: FetchMode): string => `fetch:${mode}:${url}`;

class RenderFetchError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = 'RenderFetchError';
  }
}

class RenderingDisabledError extends Error {
  constructor() {
    super('Rendering requested but the renderer is disabled. Enable RENDERING_ENABLED=true to allow rendered fetches.');
    this.name = 'RenderingDisabledError';
  }
}

const resolveMode = (requestedMode: FetchMode): { mode: FetchMode; attempted: boolean; fallbackReason?: string } => {
  if (requestedMode === 'rendered') {
    if (!config.rendering.enabled) {
      return { mode: 'http', attempted: false, fallbackReason: 'rendering_disabled' };
    }
    return { mode: 'rendered', attempted: true };
  }

  return { mode: 'http', attempted: false };
};

const fetchHttp = async (
  url: string,
  cachedEntry?: CacheEntry<FetchResult>
): Promise<Omit<FetchResult, 'fromCache' | 'renderDiagnostics'>> => {
  const span = startSpan('fetch-http');

  try {
    const headers: Record<string, string> = {};
    headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

    if (cachedEntry?.etag) {
      headers['If-None-Match'] = cachedEntry.etag;
      logger.debug('Adding If-None-Match header', { etag: cachedEntry.etag });
    }

    if (cachedEntry?.lastModified) {
      headers['If-Modified-Since'] = cachedEntry.lastModified;
      logger.debug('Adding If-Modified-Since header', { lastModified: cachedEntry.lastModified });
    }

    const conditionalRequest = Boolean(headers['If-None-Match'] || headers['If-Modified-Since']);

    // Use new HTTP client with protocol negotiation
    const response = await httpClient.get(url, headers);

    const { recordProtocolUsage } = await import('./metrics');
    recordProtocolUsage(response.protocol);

    if (response.status === 304 && cachedEntry) {
      logger.info('Cache validated: 304 Not Modified');
      recordCacheValidation(true);
      span.end({ status: response.status, protocol: response.protocol });

      return {
        url,
        finalUrl: cachedEntry.value.finalUrl,
        status: 304,
        headers: { ...cachedEntry.value.headers, ...response.headers },
        body: cachedEntry.value.body,
        fetchTimestamp: Date.now(),
        durationMs: response.durationMs,
        rendered: false
      };
    }

    if (conditionalRequest) {
      recordCacheValidation(false);
    }

    if (response.status >= 400) {
      logger.warn('fetch completed with error status', {
        url,
        status: response.status,
        protocol: response.protocol
      });
    }

    const body = response.body;

    span.end({ status: response.status, protocol: response.protocol });

    return {
      url,
      finalUrl: response.url,
      status: response.status,
      headers: response.headers,
      body,
      fetchTimestamp: Date.now(),
      durationMs: response.durationMs,
      rendered: false
    };
  } catch (error) {
    span.end({ error: error instanceof Error ? error.message : 'unknown' });
    throw error;
  }
};

const fetchRendered = async (url: string): Promise<{
  result: Omit<FetchResult, 'fromCache' | 'renderDiagnostics'>;
  rendererStatus: RenderDiagnostics['rendererStatus'];
}> => {
  await initRenderer();

  const startedAt = Date.now();

  try {
    const { result, status } = await rendererManager.withPage(async (page) => {
      let response;
      try {
        response = await page.goto(url, {
          waitUntil: config.rendering.waitUntil,
          timeout: config.rendering.timeoutMs
        });
      } catch (error) {
        throw new RenderFetchError('navigation_error', (error as Error).message);
      }

      const content = await page.content();
      const headers = response ? response.headers() : {};

      return {
        url,
        finalUrl: response?.url() ?? page.url(),
        status: response?.status() ?? 0,
        headers,
        body: content,
        fetchTimestamp: Date.now(),
        durationMs: Date.now() - startedAt,
        rendered: true
      } satisfies Omit<FetchResult, 'fromCache' | 'renderDiagnostics'>;
    });

    return {
      result,
      rendererStatus: {
        initialized: status.initialized,
        queuePending: status.concurrency.pending,
        queueAvailable: status.concurrency.available,
        queueMax: status.concurrency.max
      }
    };
  } catch (error) {
    if (error instanceof RenderFetchError) {
      throw error;
    }

    const message = (error as Error).message;
    const reason = message === 'renderer unavailable' ? 'renderer_unavailable' : 'render_runtime_error';
    throw new RenderFetchError(reason, message);
  }
};

export const fetchPage = async ({ url, useCache, mode }: FetchRequestOptions): Promise<FetchResult> => {
  if (mode === 'rendered' && !config.rendering.enabled) {
    logger.error('Rendering requested but renderer disabled', { url });
    recordFetchMetrics({
      requestedMode: mode,
      effectiveMode: 'http',
      attempted: false,
      rendered: false,
      fromCache: false,
      fallbackReason: 'rendering_disabled'
    });
    throw new RenderingDisabledError();
  }

  // Check robots.txt compliance first
  try {
    await robotsManager.checkAndEnforce(url);
  } catch (error) {
    if (error instanceof Error && error.name === 'RobotsBlockedError') {
      logger.warn('Fetch blocked by robots.txt', { url });
      // Record blocked request in metrics
      const { recordRobotsBlocked } = await import('./metrics');
      recordRobotsBlocked();
      throw error;
    }
    // Other errors, log but continue
    logger.warn('Error checking robots.txt, continuing', { url, error });
  }

  // Get crawl-delay and update rate limiter
  const crawlDelay = await robotsManager.getCrawlDelay(url);
  if (crawlDelay > 0) {
    const domain = new URL(url).host;
    rateLimiter.setDomainLimit(domain, crawlDelay / 1000); // Convert ms to seconds
  }

  // Wait for rate limit clearance
  const rateLimitStart = Date.now();
  await rateLimiter.checkLimit(url);
  const rateLimitWait = Date.now() - rateLimitStart;
  if (rateLimitWait > 0) {
    logger.debug('Rate limited', { url, waitMs: rateLimitWait });
    const { recordRateLimited } = await import('./metrics');
    recordRateLimited(rateLimitWait);
  }

  const resolution = resolveMode(mode);
  const cacheKey = cacheKeyFor(url, resolution.mode);
  let cachedEntry: CacheEntry<FetchResult> | undefined;

  if (useCache) {
    cachedEntry = await cache.get<FetchResult>(cacheKey);
    if (cachedEntry) {
      logger.debug('fetch cache hit', { url, mode: resolution.mode });

      const hasValidationMetadata = Boolean(cachedEntry.etag || cachedEntry.lastModified);
      const shouldValidateConditionally = hasValidationMetadata && resolution.mode === 'http';
      if (!shouldValidateConditionally) {
        recordFetchMetrics({
          requestedMode: cachedEntry.value.renderDiagnostics.requestedMode,
          effectiveMode: cachedEntry.value.renderDiagnostics.effectiveMode,
          attempted: false,
          rendered: cachedEntry.value.rendered,
          fromCache: true
        });
        return { ...cachedEntry.value, fromCache: true };
      }

      logger.debug('fetch cache conditional request', {
        url,
        mode: resolution.mode,
        etag: cachedEntry.etag,
        lastModified: cachedEntry.lastModified
      });
    }
  }

  if (!cachedEntry) {
    logger.debug('fetch cache miss', { url, mode: resolution.mode });
  }

  let result: Omit<FetchResult, 'fromCache' | 'renderDiagnostics'>;
  let renderDiagnostics: RenderDiagnostics = {
    requestedMode: mode,
    effectiveMode: resolution.mode,
    attempted: resolution.attempted,
    fallbackReason: resolution.fallbackReason
  };

  let attemptDurationMs: number | undefined;

  if (resolution.mode === 'rendered') {
    const renderAttemptStartedAt = Date.now();
    try {
      const rendered = await fetchRendered(url);
      result = rendered.result;
      attemptDurationMs = Date.now() - renderAttemptStartedAt;
      renderDiagnostics = {
        requestedMode: mode,
        effectiveMode: 'rendered',
        attempted: true,
        rendererStatus: rendered.rendererStatus,
        attemptDurationMs
      };
    } catch (error) {
      const reason = error instanceof RenderFetchError ? error.reason : 'render_unknown_error';
      const message = (error as Error).message;
      logger.error('render fetch failed, falling back to http', {
        url,
        reason,
        message
      });

      attemptDurationMs = Date.now() - renderAttemptStartedAt;
      const httpValidationEntry = useCache
        ? await cache.get<FetchResult>(cacheKeyFor(url, 'http'))
        : undefined;
      result = await fetchHttp(url, httpValidationEntry);
      const statusSnapshot = rendererManager.getStatus();
      renderDiagnostics = {
        requestedMode: mode,
        effectiveMode: 'http',
        attempted: true,
        fallbackReason: reason,
        errorMessage: message,
        rendererStatus: statusSnapshot
          ? {
              initialized: statusSnapshot.initialized,
              queuePending: statusSnapshot.concurrency.pending,
              queueAvailable: statusSnapshot.concurrency.available,
              queueMax: statusSnapshot.concurrency.max
            }
          : undefined
      };
      renderDiagnostics.attemptDurationMs = attemptDurationMs;
    }
  } else {
    const validationEntry = useCache ? cachedEntry : undefined;
    result = await fetchHttp(url, validationEntry);
  }

  const servedFromCache = result.status === 304;
  const finalResult: FetchResult = { ...result, fromCache: servedFromCache, renderDiagnostics };

  if (useCache && result.status >= 200 && result.status < 400) {
    const finalMode: FetchMode = finalResult.rendered ? 'rendered' : 'http';

    // Store with cache validation metadata
    const cacheMetadata = {
      etag: result.headers['etag'],
      lastModified: result.headers['last-modified'],
      contentHash: undefined // Could add hash of body here
    };

    await cache.set(cacheKeyFor(url, finalMode), finalResult, cacheMetadata);

    if (resolution.mode === 'rendered' && finalMode === 'http') {
      await cache.set(cacheKey, finalResult, cacheMetadata);
    }
  }

  recordFetchMetrics({
    requestedMode: finalResult.renderDiagnostics.requestedMode,
    effectiveMode: finalResult.renderDiagnostics.effectiveMode,
    attempted: finalResult.renderDiagnostics.attempted,
    rendered: finalResult.rendered,
    fromCache: finalResult.fromCache,
    fallbackReason: finalResult.renderDiagnostics.fallbackReason,
    errorMessage: finalResult.renderDiagnostics.errorMessage,
    renderDurationSeconds: finalResult.rendered ? finalResult.durationMs / 1000 : undefined,
    renderFallbackSeconds:
      !finalResult.rendered && attemptDurationMs !== undefined
        ? attemptDurationMs / 1000
        : undefined
  });

  return finalResult;
};
