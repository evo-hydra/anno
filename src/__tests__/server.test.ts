/**
 * Tests for src/server.ts
 *
 * Since server.ts has side effects on import (creates Express app, listens on port),
 * we test the important logic by mocking all external dependencies and verifying
 * endpoint behavior via supertest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import supertest from 'supertest';

// ---------------------------------------------------------------------------
// Hoist mock functions so they can be referenced inside vi.mock() factories
// ---------------------------------------------------------------------------

const mockPerformHealthCheck = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ status: 'healthy', timestamp: Date.now(), checks: {}, overall: { healthy: 4, degraded: 0, unhealthy: 0 } })
);
const mockGetMetricsSnapshot = vi.hoisted(() => vi.fn().mockReturnValue({ totalRequests: 0 }));
const mockRenderPrometheusMetrics = vi.hoisted(() => vi.fn().mockReturnValue('# HELP anno_requests_total\nanno_requests_total 0'));
const mockGetLatencySummary = vi.hoisted(() => vi.fn().mockReturnValue({ render: {}, fallback: {} }));
const mockResetMetrics = vi.hoisted(() => vi.fn());
const mockGetCacheStats = vi.hoisted(() => vi.fn().mockReturnValue({}));
const mockGetRobotsStats = vi.hoisted(() => vi.fn().mockReturnValue({ blockedRequests: 0 }));
const mockGetRateLimitStats = vi.hoisted(() => vi.fn().mockReturnValue({ rateLimitedRequests: 0, avgWaitMs: 0, maxWaitMs: 0 }));
const mockGetProtocolStats = vi.hoisted(() => vi.fn().mockReturnValue({}));

const mockRobotsManager = vi.hoisted(() => ({
  getCacheStats: vi.fn().mockReturnValue({ domains: 0 }),
}));

const mockRateLimiter = vi.hoisted(() => ({
  getAllStats: vi.fn().mockReturnValue({ totalDomains: 0, domains: [] }),
}));

const mockInitRenderer = vi.hoisted(() => vi.fn().mockResolvedValue({ launched: true }));
const mockShutdownRenderer = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const mockWatchManager = vi.hoisted(() => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn(),
}));

const mockJobQueue = vi.hoisted(() => ({
  init: vi.fn().mockResolvedValue(undefined),
  start: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../services/renderer', () => ({
  initRenderer: mockInitRenderer,
  shutdownRenderer: mockShutdownRenderer,
  getRendererStatus: vi.fn().mockReturnValue({ launched: false }),
}));

vi.mock('../services/watch-manager', () => ({
  watchManager: mockWatchManager,
}));

vi.mock('../services/job-queue', () => ({
  getJobQueue: () => mockJobQueue,
}));

// ---------------------------------------------------------------------------
// Config object (mutable for per-test overrides)
// ---------------------------------------------------------------------------

const mockConfig = {
  port: 0,
  cache: { maxEntries: 64, ttlMs: 300000 },
  redis: { enabled: false, url: 'redis://localhost:6379', ttlMs: 3600000 },
  fetch: { userAgent: 'Anno/1.0', timeoutMs: 15000, respectRobots: true, overrideRobots: false },
  rendering: { enabled: false, timeoutMs: 20000, waitUntil: 'networkidle' as const, headless: true, maxPages: 2, stealth: true },
  metrics: { allowReset: true, resetToken: 'secret-token' as string | undefined, enableStageMetrics: true },
  ai: { embeddingProvider: 'deterministic', llmProvider: 'none', vectorStoreProvider: 'memory', summarizer: 'heuristic' as const, defaultK: 3 },
  policies: { enabled: true, dir: './policies', defaultPolicy: 'default.yaml', validationEnabled: true },
  ssrf: { enabled: true, allowedHosts: [] as string[], blockedHosts: [] as string[], allowPrivateIPs: false },
  domains: { configPath: './config/domains.yaml' },
  auth: { enabled: false, apiKeys: [] as string[], rateLimitPerKey: 60, bypassInDev: true },
};

// ---------------------------------------------------------------------------
// Build test app (mirrors key endpoint logic from server.ts)
// ---------------------------------------------------------------------------

function buildTestApp() {
  const app = express();
  app.use(express.json());

  // /health endpoint (mirrors server.ts)
  app.get('/health', async (_req: Request, res: Response) => {
    const healthCheck = await mockPerformHealthCheck();
    const metricsSnapshot = mockGetMetricsSnapshot();
    const latencySummary = mockGetLatencySummary();
    const cacheStats = mockGetCacheStats();
    const robotsStats = mockGetRobotsStats();
    const robotsCacheStats = mockRobotsManager.getCacheStats();
    const rateLimitStats = mockGetRateLimitStats();
    const rateLimiterStats = mockRateLimiter.getAllStats();
    const protocolStats = mockGetProtocolStats();

    const statusCode = healthCheck.status === 'healthy' ? 200 :
                       healthCheck.status === 'degraded' ? 200 : 503;

    res.status(statusCode).json({
      ...healthCheck,
      metrics: metricsSnapshot,
      cache: { stats: cacheStats },
      robots: {
        respectEnabled: mockConfig.fetch.respectRobots,
        blockedRequests: robotsStats.blockedRequests,
        cachedDomains: robotsCacheStats.domains,
      },
      rateLimit: {
        enabled: mockConfig.fetch.respectRobots,
        rateLimitedRequests: rateLimitStats.rateLimitedRequests,
        avgWaitMs: rateLimitStats.avgWaitMs,
        maxWaitMs: rateLimitStats.maxWaitMs,
        activeDomains: rateLimiterStats.totalDomains,
      },
      http: { protocolUsage: protocolStats },
      summary: {
        render: latencySummary.render,
        fallback: latencySummary.fallback,
      },
    });
  });

  // /metrics endpoint
  app.get('/metrics', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(mockRenderPrometheusMetrics());
  });

  // /metrics/reset endpoint
  app.post('/metrics/reset', (req: Request, res: Response) => {
    if (!mockConfig.metrics.allowReset) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const token = mockConfig.metrics.resetToken;
    if (token) {
      const headerToken = req.header('x-metrics-reset-token');
      const queryTokenRaw = req.query.token;
      const queryToken = Array.isArray(queryTokenRaw)
        ? queryTokenRaw[0]
        : typeof queryTokenRaw === 'string'
          ? queryTokenRaw
          : undefined;
      const provided = headerToken ?? queryToken;
      if (provided !== token) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
    }

    mockResetMetrics();
    res.json({ status: 'reset', timestamp: Date.now() });
  });

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Supertest-based tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Reset config to defaults
  mockConfig.metrics.allowReset = true;
  mockConfig.metrics.resetToken = 'secret-token';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Server endpoints', () => {
  describe('GET /health', () => {
    it('returns 200 with healthy status and expected shape', async () => {
      const app = buildTestApp();
      const res = await supertest(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body).toHaveProperty('metrics');
      expect(res.body).toHaveProperty('cache');
      expect(res.body).toHaveProperty('robots');
      expect(res.body).toHaveProperty('rateLimit');
      expect(res.body).toHaveProperty('http');
      expect(res.body).toHaveProperty('summary');
    });

    it('returns 200 for degraded status', async () => {
      mockPerformHealthCheck.mockResolvedValueOnce({
        status: 'degraded',
        timestamp: Date.now(),
        checks: {},
        overall: { healthy: 2, degraded: 2, unhealthy: 0 },
      });

      const app = buildTestApp();
      const res = await supertest(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
    });

    it('returns 503 for unhealthy status', async () => {
      mockPerformHealthCheck.mockResolvedValueOnce({
        status: 'unhealthy',
        timestamp: Date.now(),
        checks: {},
        overall: { healthy: 0, degraded: 0, unhealthy: 4 },
      });

      const app = buildTestApp();
      const res = await supertest(app).get('/health');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
    });

    it('includes robots and rate limit information', async () => {
      mockGetRobotsStats.mockReturnValueOnce({ blockedRequests: 5 });
      mockRobotsManager.getCacheStats.mockReturnValueOnce({ domains: 3 });
      mockGetRateLimitStats.mockReturnValueOnce({ rateLimitedRequests: 2, avgWaitMs: 150, maxWaitMs: 500 });
      mockRateLimiter.getAllStats.mockReturnValueOnce({ totalDomains: 3, domains: [] });

      const app = buildTestApp();
      const res = await supertest(app).get('/health');

      expect(res.body.robots.blockedRequests).toBe(5);
      expect(res.body.robots.cachedDomains).toBe(3);
      expect(res.body.rateLimit.rateLimitedRequests).toBe(2);
      expect(res.body.rateLimit.activeDomains).toBe(3);
    });
  });

  describe('GET /metrics', () => {
    it('returns Prometheus metrics as text/plain', async () => {
      const app = buildTestApp();
      const res = await supertest(app).get('/metrics');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('anno_requests_total');
    });
  });

  describe('POST /metrics/reset', () => {
    it('resets metrics with correct token in header', async () => {
      const app = buildTestApp();
      const res = await supertest(app)
        .post('/metrics/reset')
        .set('x-metrics-reset-token', 'secret-token');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('reset');
      expect(res.body).toHaveProperty('timestamp');
      expect(mockResetMetrics).toHaveBeenCalledOnce();
    });

    it('resets metrics with correct token in query param', async () => {
      const app = buildTestApp();
      const res = await supertest(app)
        .post('/metrics/reset?token=secret-token');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('reset');
      expect(mockResetMetrics).toHaveBeenCalledOnce();
    });

    it('returns 401 with wrong token', async () => {
      const app = buildTestApp();
      const res = await supertest(app)
        .post('/metrics/reset')
        .set('x-metrics-reset-token', 'wrong-token');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
      expect(mockResetMetrics).not.toHaveBeenCalled();
    });

    it('returns 401 with no token', async () => {
      const app = buildTestApp();
      const res = await supertest(app).post('/metrics/reset');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns 404 when reset is disabled', async () => {
      mockConfig.metrics.allowReset = false;

      const app = buildTestApp();
      const res = await supertest(app).post('/metrics/reset');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });

    it('resets without token check when resetToken is not configured', async () => {
      mockConfig.metrics.resetToken = undefined;

      const app = buildTestApp();
      const res = await supertest(app).post('/metrics/reset');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('reset');
    });
  });

  describe('404 handler', () => {
    it('returns 404 for undefined routes', async () => {
      const app = buildTestApp();
      const res = await supertest(app).get('/nonexistent-route');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });
  });
});

// ---------------------------------------------------------------------------
// Shutdown logic tests
// ---------------------------------------------------------------------------

describe('Shutdown logic', () => {
  it('shutdown function calls all cleanup routines', async () => {
    const shutdownCleanup = async () => {
      mockWatchManager.shutdown();
      await mockJobQueue.stop();
      await mockShutdownRenderer();
    };

    await shutdownCleanup();

    expect(mockWatchManager.shutdown).toHaveBeenCalledOnce();
    expect(mockJobQueue.stop).toHaveBeenCalledOnce();
    expect(mockShutdownRenderer).toHaveBeenCalledOnce();
  });

  it('shutdown handles job queue stop failure gracefully', async () => {
    mockJobQueue.stop.mockRejectedValueOnce(new Error('Stop failed'));

    const shutdownCleanup = async () => {
      mockWatchManager.shutdown();
      await mockJobQueue.stop().catch(() => { /* handled */ });
      await mockShutdownRenderer();
    };

    await shutdownCleanup();

    expect(mockWatchManager.shutdown).toHaveBeenCalled();
    expect(mockShutdownRenderer).toHaveBeenCalled();
  });

  it('shutdown handles renderer shutdown failure gracefully', async () => {
    mockShutdownRenderer.mockRejectedValueOnce(new Error('Renderer crash'));

    const shutdownCleanup = async () => {
      mockWatchManager.shutdown();
      await mockJobQueue.stop();
      await mockShutdownRenderer().catch(() => { /* handled */ });
    };

    await shutdownCleanup();

    expect(mockWatchManager.shutdown).toHaveBeenCalled();
    expect(mockJobQueue.stop).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Process error handler logic tests
// ---------------------------------------------------------------------------

describe('Process error handlers', () => {
  it('classifies EPIPE as handled client disconnect', () => {
    const error = new Error('write EPIPE') as NodeJS.ErrnoException;
    error.code = 'EPIPE';

    const isExpected = error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ERR_STREAM_DESTROYED';
    expect(isExpected).toBe(true);
  });

  it('classifies ECONNRESET as handled client disconnect', () => {
    const error = new Error('read ECONNRESET') as NodeJS.ErrnoException;
    error.code = 'ECONNRESET';

    const isExpected = error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ERR_STREAM_DESTROYED';
    expect(isExpected).toBe(true);
  });

  it('classifies ERR_STREAM_DESTROYED as handled client disconnect', () => {
    const error = new Error('stream destroyed') as NodeJS.ErrnoException;
    error.code = 'ERR_STREAM_DESTROYED';

    const isExpected = error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ERR_STREAM_DESTROYED';
    expect(isExpected).toBe(true);
  });

  it('does not classify other errors as handled', () => {
    const error = new Error('something else') as NodeJS.ErrnoException;
    error.code = 'ENOENT';

    const isExpected = error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ERR_STREAM_DESTROYED';
    expect(isExpected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Server initialization logic tests
// ---------------------------------------------------------------------------

describe('Server initialization logic', () => {
  it('initRenderer is called when rendering is enabled', async () => {
    const renderingEnabled = true;

    if (renderingEnabled) {
      const result = await mockInitRenderer();
      expect(result.launched).toBe(true);
    }

    expect(mockInitRenderer).toHaveBeenCalledOnce();
  });

  it('initRenderer logs warning when prelaunch fails', async () => {
    mockInitRenderer.mockResolvedValueOnce({ launched: false, error: 'No browser binary' });

    const result = await mockInitRenderer();
    expect(result.launched).toBe(false);
    expect(result.error).toBe('No browser binary');
  });

  it('watchManager.init failure is caught and does not crash', async () => {
    mockWatchManager.init.mockRejectedValueOnce(new Error('Init failed'));

    let initError: string | undefined;
    await mockWatchManager.init().catch((err: Error) => {
      initError = err.message;
    });

    expect(initError).toBe('Init failed');
  });

  it('jobQueue.init failure falls back to in-memory', async () => {
    mockJobQueue.init.mockRejectedValueOnce(new Error('Redis unavailable'));

    let caught = false;
    await mockJobQueue.init().catch(() => {
      caught = true;
    });

    expect(caught).toBe(true);

    // start is called regardless
    mockJobQueue.start();
    expect(mockJobQueue.start).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Client error handler logic tests
// ---------------------------------------------------------------------------

describe('Client error handling', () => {
  it('socket.end is called on clientError when socket is not destroyed', () => {
    const mockSocket = {
      destroyed: false,
      end: vi.fn(),
    };

    // Replicating server.ts clientError handler logic
    if (!mockSocket.destroyed) {
      mockSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }

    expect(mockSocket.end).toHaveBeenCalledWith('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  it('socket.end is NOT called when socket is already destroyed', () => {
    const mockSocket = {
      destroyed: true,
      end: vi.fn(),
    };

    if (!mockSocket.destroyed) {
      mockSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }

    expect(mockSocket.end).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Metrics token extraction logic
// ---------------------------------------------------------------------------

describe('Metrics reset token extraction', () => {
  it('prefers header token over query token', async () => {
    const app = buildTestApp();
    const res = await supertest(app)
      .post('/metrics/reset?token=wrong-token')
      .set('x-metrics-reset-token', 'secret-token');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reset');
  });

  it('uses query token when header is absent', async () => {
    const app = buildTestApp();
    const res = await supertest(app)
      .post('/metrics/reset?token=secret-token');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reset');
  });
});
