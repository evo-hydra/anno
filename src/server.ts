/**
 * Anno - AI-Native Web Browser
 * Copyright (c) 2025 Evolving Intelligence AI. All rights reserved.
 *
 * PROPRIETARY AND CONFIDENTIAL
 * This code is proprietary to Evolving Intelligence AI and may not be copied, modified,
 * or distributed without explicit written permission.
 */

// Load environment variables from .env file
import 'dotenv/config';

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
import { initRenderer, shutdownRenderer } from './services/renderer';
import { watchManager } from './services/watch-manager';
import { getJobQueue } from './services/job-queue';
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
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import {
  createSecurityHeadersMiddleware,
  createCorsMiddleware,
  httpsRedirectMiddleware,
  getSecurityConfigFromEnv
} from './middleware/security';

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

// Apply per-tenant rate limiting middleware (after auth so tenant is attached)
app.use('/v1', rateLimitPerTenantMiddleware);
if (config.auth.enabled) {
  logger.info('Per-tenant rate limiting enabled', { rateLimitPerKey: config.auth.rateLimitPerKey });
}

// Apply global rate limiting middleware
if (rateLimitConfig.enabled) {
  app.use('/v1', createRateLimitMiddleware(rateLimitConfig));
  logger.info(`⏱️  Rate limiting enabled: ${rateLimitConfig.maxRequests} requests per ${rateLimitConfig.windowMs}ms`);
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

const server = app.listen(config.port, async () => {
  logger.info('Anno MVP service listening', { port: config.port });

  if (config.rendering.enabled) {
    const result = await initRenderer();
    if (result.launched) {
      logger.info('renderer prelaunch successful');
    } else {
      logger.warn('renderer prelaunch skipped', { reason: result.error });
    }
  }

  // Initialize watch manager (loads persisted watches and starts timer)
  await watchManager.init().catch((err: Error) => {
    logger.error('watch manager init failed', { error: err.message });
  });

  // Initialize and start job queue worker
  const jobQueue = getJobQueue();
  await jobQueue.init().catch((err: Error) => {
    logger.error('job queue store init failed, using in-memory fallback', { error: err.message });
  });
  jobQueue.start();
  logger.info('Job queue started');
});

// Handle connection errors gracefully (EPIPE, ECONNRESET, etc.)
server.on('clientError', (err: Error, socket) => {
  // Log but don't crash on client connection errors
  logger.debug('client connection error', { error: err.message, code: (err as NodeJS.ErrnoException).code });
  // Try to end the socket gracefully
  if (!socket.destroyed) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

// Handle connection errors on individual connections
server.on('connection', (socket) => {
  socket.on('error', (err: Error) => {
    // Silently handle EPIPE, ECONNRESET - these are expected when clients disconnect
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPIPE' && code !== 'ECONNRESET' && code !== 'ERR_STREAM_DESTROYED') {
      logger.warn('socket error', { error: err.message, code });
    }
  });
});

// Handle uncaught errors from sockets (EPIPE, ECONNRESET, etc.)
process.on('uncaughtException', (error: Error) => {
  const code = (error as NodeJS.ErrnoException).code;

  // Silently handle expected client disconnect errors
  if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED') {
    logger.debug('client disconnect error (handled)', { error: error.message, code });
    return; // Don't crash
  }

  // For other errors, log and exit
  logger.error('uncaught exception', { error: error.message, stack: error.stack });
  shutdown();
});

const shutdown = async () => {
  logger.info('shutting down service');
  watchManager.shutdown();
  await getJobQueue().stop().catch((error: Error) => {
    logger.error('job queue shutdown failed', { error: error.message });
  });
  server.close();
  await shutdownRenderer().catch((error: Error) => {
    logger.error('renderer shutdown failed', { error: error.message });
  });
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
