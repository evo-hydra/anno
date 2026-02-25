/**
 * Anno - AI-Native Web Browser
 * Copyright (c) 2025 Evolving Intelligence AI. All rights reserved.
 *
 * Express application factory.
 * Extracted from server.ts to allow supertest-based integration testing.
 */

import express from 'express';
import { config } from './config/env';
import { logger } from './utils/logger';
import { contentRouter } from './api/routes/content';
import { semanticRouter } from './api/routes/semantic';
import { memoryRouter } from './api/routes/memory';
import { interactRouter } from './api/routes/interact';
import { crawlRouter } from './api/routes/crawl';
import { workflowRouter } from './api/routes/workflow';
import { watchRouter } from './api/routes/watch';
import { jobsRouter } from './api/routes/jobs';
import {
  getMetricsSnapshot,
  renderPrometheusMetrics,
  getLatencySummary,
  resetMetrics,
  getCacheStats,
  getRobotsStats,
  getRateLimitStats,
  getProtocolStats
} from './services/metrics';
import { performHealthCheck } from './services/health-check';
import { robotsManager } from './core/robots-parser';
import { rateLimiter } from './core/rate-limiter';
import { requestContextMiddleware } from './middleware/request-context';
import { createAuthMiddleware, extractApiKeyMiddleware, getAuthConfigFromEnv } from './middleware/auth';
import { createRateLimitMiddleware, getRateLimitConfigFromEnv } from './middleware/rate-limit';
import { createAuditLogMiddleware, getAuditConfigFromEnv } from './middleware/audit-log';
import { rateLimitPerTenantMiddleware } from './middleware/rate-limit-per-tenant';
import { quotaMiddleware } from './middleware/quota';
import { adminRouter } from './api/routes/admin';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import {
  createSecurityHeadersMiddleware,
  createCorsMiddleware,
  httpsRedirectMiddleware,
  getSecurityConfigFromEnv
} from './middleware/security';

export function createApp(): express.Express {
  const app = express();

  // Security configuration
  const securityConfig = getSecurityConfigFromEnv();

  // Apply HTTPS redirect first (before any processing)
  app.use(httpsRedirectMiddleware);

  // Apply security headers
  app.use(createSecurityHeadersMiddleware());
  logger.info('🛡️  Security headers enabled');

  // Apply CORS
  app.use(createCorsMiddleware(securityConfig));
  logger.info('🌐 CORS enabled', { origins: securityConfig.allowedOrigins.join(', ') });

  // Request context middleware (must be early for tracing)
  app.use(requestContextMiddleware);

  app.use(express.json({ limit: securityConfig.maxRequestSize }));

  // Enhanced health check endpoint with deep dependency checks
  app.get('/health', async (_req, res) => {
    const healthCheck = await performHealthCheck();
    const metrics = getMetricsSnapshot();
    const latencySummary = getLatencySummary();
    const cacheStats = getCacheStats();
    const robotsStats = getRobotsStats();
    const robotsCacheStats = robotsManager.getCacheStats();
    const rateLimitStats = getRateLimitStats();
    const rateLimiterStats = rateLimiter.getAllStats();
    const protocolStats = getProtocolStats();

    // Set appropriate HTTP status code based on health
    const statusCode = healthCheck.status === 'healthy' ? 200 :
                       healthCheck.status === 'degraded' ? 200 : 503;

    res.status(statusCode).json({
      ...healthCheck,
      metrics,
      cache: {
        stats: cacheStats
      },
      robots: {
        respectEnabled: config.fetch.respectRobots,
        blockedRequests: robotsStats.blockedRequests,
        cachedDomains: robotsCacheStats.domains
      },
      rateLimit: {
        enabled: config.fetch.respectRobots,
        rateLimitedRequests: rateLimitStats.rateLimitedRequests,
        avgWaitMs: rateLimitStats.avgWaitMs,
        maxWaitMs: rateLimitStats.maxWaitMs,
        activeDomains: rateLimiterStats.totalDomains
      },
      http: {
        protocolUsage: protocolStats
      },
      summary: {
        render: latencySummary.render,
        fallback: latencySummary.fallback
      }
    });
  });

  // Security middlewares for /v1 endpoints
  const authConfig = getAuthConfigFromEnv();
  const rateLimitConfig = getRateLimitConfigFromEnv();
  const auditConfig = getAuditConfigFromEnv();

  // Apply audit logging first (before auth/rate-limit so we log failures too)
  app.use('/v1', createAuditLogMiddleware(auditConfig));
  logger.info('📝 Audit logging enabled for /v1 endpoints');

  // Apply auth middleware if enabled (otherwise just extract API key for metrics)
  if (authConfig.enabled) {
    app.use('/v1', createAuthMiddleware(authConfig));
    logger.info('🔒 API authentication enabled');
  } else {
    app.use('/v1', extractApiKeyMiddleware());
    logger.info('🔓 API authentication disabled (dev mode)');
  }

  // Apply monthly quota enforcement (after auth so tenant.tier is known)
  if (config.quota.enabled && config.auth.enabled) {
    app.use('/v1', quotaMiddleware);
    logger.info('Monthly quota enforcement enabled', {
      tiers: Object.entries(config.quota.tiers).map(([name, t]) => `${name}:${t.monthlyLimit}/mo`).join(', ')
    });
  }

  // Apply per-tenant burst rate limiting (now tier-aware)
  app.use('/v1', rateLimitPerTenantMiddleware);
  if (config.auth.enabled) {
    logger.info('Per-tenant burst rate limiting enabled (tier-aware)');
  }

  // Apply global rate limiting middleware
  if (rateLimitConfig.enabled) {
    app.use('/v1', createRateLimitMiddleware(rateLimitConfig));
    logger.info(`⏱️  Rate limiting enabled: ${rateLimitConfig.maxRequests} requests per ${rateLimitConfig.windowMs}ms`);
  }

  // Admin routes (own auth — not behind /v1 auth middleware)
  app.use('/admin', adminRouter);
  if (config.auth.adminKey) {
    logger.info('Admin API enabled at /admin');
  }

  // API routes
  app.use('/v1/content', contentRouter);
  app.use('/v1/semantic', semanticRouter);
  app.use('/v1/memory', memoryRouter);
  app.use('/v1/interact', interactRouter);
  app.use('/v1/crawl', crawlRouter);
  app.use('/v1/workflow', workflowRouter);
  app.use('/v1/watch', watchRouter);
  app.use('/v1/jobs', jobsRouter);

  app.get('/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(renderPrometheusMetrics());
  });

  app.post('/metrics/reset', (req, res) => {
    if (!config.metrics.allowReset) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const token = config.metrics.resetToken;
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

    resetMetrics();
    res.json({ status: 'reset', timestamp: Date.now() });
  });

  // 404 handler for undefined routes (must be after all route definitions)
  app.use(notFoundHandler);

  // Global error handler (must be last)
  app.use(errorHandler);

  return app;
}
