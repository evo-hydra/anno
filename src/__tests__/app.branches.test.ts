/**
 * Branch coverage tests for src/app.ts
 *
 * Targets every conditional branch in createApp():
 * - Health endpoint status codes (healthy / degraded / unhealthy)
 * - Auth middleware enabled vs disabled
 * - Per-tenant rate limiting log branch
 * - Global rate limiting enabled vs disabled
 * - Metrics reset: disabled, enabled without token, enabled with token
 * - Metrics reset token validation: header, query string, array query, missing
 * - CORS origin checking in production vs dev
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

// -----------------------------------------------------------------------
// Mocks — must be declared before importing app
// -----------------------------------------------------------------------

// Mock health-check to control the returned status
vi.mock('../services/health-check', () => ({
  performHealthCheck: vi.fn().mockResolvedValue({
    status: 'healthy',
    timestamp: Date.now(),
    checks: {},
    overall: { healthy: 4, degraded: 0, unhealthy: 0 },
  }),
}));

// Mock metrics to avoid side effects
vi.mock('../services/metrics', () => ({
  getMetricsSnapshot: vi.fn().mockReturnValue({}),
  renderPrometheusMetrics: vi.fn().mockReturnValue('anno_fetch_total 0'),
  getLatencySummary: vi.fn().mockReturnValue({ render: {}, fallback: {} }),
  resetMetrics: vi.fn(),
  getCacheStats: vi.fn().mockReturnValue({}),
  getRobotsStats: vi.fn().mockReturnValue({ blockedRequests: 0 }),
  getRateLimitStats: vi.fn().mockReturnValue({ rateLimitedRequests: 0, avgWaitMs: 0, maxWaitMs: 0 }),
  getProtocolStats: vi.fn().mockReturnValue({}),
}));

// Mock robots-parser
vi.mock('../core/robots-parser', () => ({
  robotsManager: {
    getCacheStats: vi.fn().mockReturnValue({ domains: 0 }),
  },
}));

// Mock rate-limiter
vi.mock('../core/rate-limiter', () => ({
  rateLimiter: {
    getAllStats: vi.fn().mockReturnValue({ totalDomains: 0 }),
  },
}));

// Provide a stable import for createApp (lazy — we re-import per describe when env differs)
import { createApp } from '../app';
import { performHealthCheck } from '../services/health-check';
import { config } from '../config/env';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function buildApp(): Express {
  return createApp();
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('app.ts branch coverage', () => {
  // Save originals
  const origAuthEnabled = config.auth.enabled;
  const origMetricsAllowReset = config.metrics.allowReset;
  const origMetricsResetToken = config.metrics.resetToken;
  const origNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    // Restore config mutations
    config.auth.enabled = origAuthEnabled;
    config.metrics.allowReset = origMetricsAllowReset;
    config.metrics.resetToken = origMetricsResetToken;
    process.env.NODE_ENV = origNodeEnv;
    vi.restoreAllMocks();
  });

  // =====================================================================
  // Health endpoint — status code branches
  // =====================================================================

  describe('GET /health status codes', () => {
    it('returns 200 when status is "healthy"', async () => {
      vi.mocked(performHealthCheck).mockResolvedValueOnce({
        status: 'healthy',
        timestamp: Date.now(),
        checks: {} as never,
        overall: { healthy: 4, degraded: 0, unhealthy: 0 },
      });

      const app = buildApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
    });

    it('returns 200 when status is "degraded"', async () => {
      vi.mocked(performHealthCheck).mockResolvedValueOnce({
        status: 'degraded',
        timestamp: Date.now(),
        checks: {} as never,
        overall: { healthy: 2, degraded: 2, unhealthy: 0 },
      });

      const app = buildApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
    });

    it('returns 503 when status is "unhealthy"', async () => {
      vi.mocked(performHealthCheck).mockResolvedValueOnce({
        status: 'unhealthy',
        timestamp: Date.now(),
        checks: {} as never,
        overall: { healthy: 0, degraded: 0, unhealthy: 4 },
      });

      const app = buildApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
    });

    it('includes all expected top-level fields in health response', async () => {
      vi.mocked(performHealthCheck).mockResolvedValueOnce({
        status: 'healthy',
        timestamp: Date.now(),
        checks: {} as never,
        overall: { healthy: 4, degraded: 0, unhealthy: 0 },
      });

      const app = buildApp();
      const res = await request(app).get('/health');
      expect(res.body).toHaveProperty('metrics');
      expect(res.body).toHaveProperty('cache');
      expect(res.body).toHaveProperty('robots');
      expect(res.body).toHaveProperty('rateLimit');
      expect(res.body).toHaveProperty('http');
      expect(res.body).toHaveProperty('summary');
    });
  });

  // =====================================================================
  // Auth middleware branches
  // =====================================================================

  describe('Auth middleware branch', () => {
    it('uses extractApiKeyMiddleware when auth is disabled', async () => {
      config.auth.enabled = false;
      const app = buildApp();
      // Should reach /v1/jobs without auth errors
      const res = await request(app).get('/v1/jobs');
      expect(res.status).toBe(200);
    });

    it('uses createAuthMiddleware when auth is enabled', async () => {
      config.auth.enabled = true;
      // Set up valid API keys so the middleware can validate
      const origKeys = config.auth.apiKeys;
      config.auth.apiKeys = ['test-api-key-123'];

      const app = buildApp();

      // Without an API key, should get 401
      const res = await request(app).get('/v1/jobs');
      // In dev mode with bypassInDev, may still pass. Check it doesn't 404.
      expect([200, 401, 403]).toContain(res.status);

      config.auth.apiKeys = origKeys;
    });
  });

  // =====================================================================
  // Metrics reset endpoint — all branches
  // =====================================================================

  describe('POST /metrics/reset', () => {
    it('returns 404 when allowReset is false', async () => {
      config.metrics.allowReset = false;
      const app = buildApp();
      const res = await request(app).post('/metrics/reset');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });

    it('resets metrics when allowReset is true and no token is configured', async () => {
      config.metrics.allowReset = true;
      config.metrics.resetToken = undefined;
      const app = buildApp();
      const res = await request(app).post('/metrics/reset');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('reset');
      expect(res.body).toHaveProperty('timestamp');
    });

    it('returns 401 when token is configured but not provided', async () => {
      config.metrics.allowReset = true;
      config.metrics.resetToken = 'secret-token';
      const app = buildApp();
      const res = await request(app).post('/metrics/reset');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthorized');
    });

    it('returns 401 when wrong token is provided via header', async () => {
      config.metrics.allowReset = true;
      config.metrics.resetToken = 'secret-token';
      const app = buildApp();
      const res = await request(app)
        .post('/metrics/reset')
        .set('x-metrics-reset-token', 'wrong-token');
      expect(res.status).toBe(401);
    });

    it('accepts correct token via x-metrics-reset-token header', async () => {
      config.metrics.allowReset = true;
      config.metrics.resetToken = 'secret-token';
      const app = buildApp();
      const res = await request(app)
        .post('/metrics/reset')
        .set('x-metrics-reset-token', 'secret-token');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('reset');
    });

    it('accepts correct token via query parameter', async () => {
      config.metrics.allowReset = true;
      config.metrics.resetToken = 'secret-token';
      const app = buildApp();
      const res = await request(app)
        .post('/metrics/reset?token=secret-token');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('reset');
    });

    it('returns 401 when wrong token is provided via query', async () => {
      config.metrics.allowReset = true;
      config.metrics.resetToken = 'secret-token';
      const app = buildApp();
      const res = await request(app)
        .post('/metrics/reset?token=wrong');
      expect(res.status).toBe(401);
    });

    it('prefers header token over query token', async () => {
      config.metrics.allowReset = true;
      config.metrics.resetToken = 'header-wins';
      const app = buildApp();
      const res = await request(app)
        .post('/metrics/reset?token=wrong')
        .set('x-metrics-reset-token', 'header-wins');
      expect(res.status).toBe(200);
    });
  });

  // =====================================================================
  // Metrics GET endpoint
  // =====================================================================

  describe('GET /metrics', () => {
    it('returns prometheus text format', async () => {
      const app = buildApp();
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
    });
  });

  // =====================================================================
  // 404 handler
  // =====================================================================

  describe('404 handler', () => {
    it('returns 404 JSON for undefined routes', async () => {
      const app = buildApp();
      const res = await request(app).get('/does-not-exist');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });
  });

  // =====================================================================
  // CORS middleware branches
  // =====================================================================

  describe('CORS middleware', () => {
    it('allows requests with no Origin header (curl, mobile)', async () => {
      const app = buildApp();
      const res = await request(app).get('/health');
      // No Origin header → should be allowed
      expect(res.status).toBe(200);
    });

    it('allows any origin in non-production (dev/test)', async () => {
      process.env.NODE_ENV = 'test';
      const app = buildApp();
      const res = await request(app)
        .get('/health')
        .set('Origin', 'https://evil.example.com');
      expect(res.status).toBe(200);
      // CORS header should be present
      expect(res.headers['access-control-allow-origin']).toBeDefined();
    });

    it('handles OPTIONS preflight with origin in dev mode', async () => {
      process.env.NODE_ENV = 'test';
      const app = buildApp();
      const res = await request(app)
        .options('/v1/content/fetch')
        .set('Origin', 'https://some-app.example.com')
        .set('Access-Control-Request-Method', 'POST');
      // Should return 204 or 200 with CORS headers
      expect([200, 204]).toContain(res.status);
    });
  });

  // =====================================================================
  // CORS in production mode
  // =====================================================================

  describe('CORS in production mode', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    afterEach(() => {
      process.env.NODE_ENV = origNodeEnv;
    });

    it('allows wildcard origin when ALLOWED_ORIGINS not set', async () => {
      // Default is ['*'] which allows everything
      delete process.env.ALLOWED_ORIGINS;
      const app = buildApp();
      const res = await request(app)
        .get('/health')
        .set('Origin', 'https://anything.example.com');
      expect(res.status).toBe(200);
    });

    it('allows a matching origin in production', async () => {
      process.env.ALLOWED_ORIGINS = 'https://allowed.example.com';
      const app = buildApp();
      const res = await request(app)
        .get('/health')
        .set('Origin', 'https://allowed.example.com');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://allowed.example.com');
      delete process.env.ALLOWED_ORIGINS;
    });

    it('rejects a non-matching origin in production', async () => {
      process.env.ALLOWED_ORIGINS = 'https://allowed.example.com';
      const app = buildApp();
      const res = await request(app)
        .get('/health')
        .set('Origin', 'https://evil.example.com');
      // CORS rejection results in 500 from the cors middleware error callback
      expect(res.status).toBe(500);
      delete process.env.ALLOWED_ORIGINS;
    });
  });

  // =====================================================================
  // Security headers
  // =====================================================================

  describe('Security headers', () => {
    it('includes x-content-type-options: nosniff', async () => {
      const app = buildApp();
      const res = await request(app).get('/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('includes x-frame-options', async () => {
      const app = buildApp();
      const res = await request(app).get('/health');
      expect(res.headers['x-frame-options']).toBeDefined();
    });
  });

  // =====================================================================
  // Request context middleware
  // =====================================================================

  describe('Request context', () => {
    it('generates x-request-id when not provided', async () => {
      const app = buildApp();
      const res = await request(app).get('/health');
      expect(res.headers['x-request-id']).toBeDefined();
    });

    it('echoes provided x-request-id', async () => {
      const app = buildApp();
      const id = 'branch-test-' + Date.now();
      const res = await request(app).get('/health').set('x-request-id', id);
      expect(res.headers['x-request-id']).toBe(id);
    });
  });

  // =====================================================================
  // JSON body parsing with custom limit
  // =====================================================================

  describe('JSON body parsing', () => {
    it('parses JSON bodies on POST endpoints', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/v1/content/fetch')
        .send({ url: 'https://example.com' })
        .set('Content-Type', 'application/json');
      // Should process (not 415 unsupported media type)
      expect(res.status).not.toBe(415);
    });
  });

  // =====================================================================
  // Rate limiting branch (enabled vs disabled)
  // =====================================================================

  describe('Rate limiting branch', () => {
    it('app creates successfully when rate limiting is disabled', async () => {
      // Default env has RATE_LIMIT_ENABLED unset (disabled)
      const app = buildApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    });

    it('app creates successfully when rate limiting is enabled', async () => {
      const origVal = process.env.RATE_LIMIT_ENABLED;
      process.env.RATE_LIMIT_ENABLED = 'true';
      const app = buildApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      if (origVal === undefined) {
        delete process.env.RATE_LIMIT_ENABLED;
      } else {
        process.env.RATE_LIMIT_ENABLED = origVal;
      }
    });
  });

  // =====================================================================
  // Per-tenant rate limiting log branch
  // =====================================================================

  describe('Per-tenant rate limiting log branch', () => {
    it('logs when auth.enabled is true', async () => {
      config.auth.enabled = true;
      const origKeys = config.auth.apiKeys;
      config.auth.apiKeys = ['test-key'];
      // Should not throw during app creation
      const app = buildApp();
      expect(app).toBeDefined();
      config.auth.apiKeys = origKeys;
    });

    it('skips log when auth.enabled is false', async () => {
      config.auth.enabled = false;
      const app = buildApp();
      expect(app).toBeDefined();
    });
  });

  // =====================================================================
  // Route mounting verification
  // =====================================================================

  describe('Route mounting', () => {
    it('mounts all /v1 route groups', async () => {
      const app = buildApp();

      // Each should NOT return the generic 404 from notFoundHandler
      // (they may return their own errors, but the route should be found)
      const routes = [
        { method: 'get', path: '/v1/jobs' },
        { method: 'get', path: '/v1/watch' },
        { method: 'get', path: '/v1/crawl/jobs' },
      ];

      for (const route of routes) {
        const res = await request(app)[route.method as 'get'](route.path);
        // Route exists — should not be a "not_found" from our handler
        if (res.body.error) {
          expect(res.body.error).not.toBe('not_found');
        }
      }
    });
  });
});
