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

import { config } from './config/env';
import { logger } from './utils/logger';
import { createApp } from './app';
import { initRenderer, shutdownRenderer } from './services/renderer';
import { watchManager } from './services/watch-manager';
import { getJobQueue } from './services/job-queue';

const app = createApp();

const server = app.listen(config.port, async () => {
  // Server-side request timeouts to prevent clients holding connections indefinitely
  server.setTimeout(120_000);       // 2 min max request lifetime
  server.keepAliveTimeout = 65_000; // Slightly above typical LB timeout (60s)
  server.headersTimeout = 70_000;   // Must be > keepAliveTimeout

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

  // Force exit after 30s to prevent hanging on stuck connections
  const forceExitTimer = setTimeout(() => {
    logger.error('graceful shutdown timed out after 30s, forcing exit');
    process.exit(1);
  }, 30_000);
  forceExitTimer.unref();

  try {
    // Stop accepting new connections and drain existing ones
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    logger.info('HTTP server closed, connections drained');
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('HTTP server close failed', { error: msg });
  }

  watchManager.shutdown();

  await getJobQueue().stop().catch((error: Error) => {
    logger.error('job queue shutdown failed', { error: error.message });
  });

  await shutdownRenderer().catch((error: Error) => {
    logger.error('renderer shutdown failed', { error: error.message });
  });

  // Close cache/Redis connections
  try {
    const { cache } = await import('./services/cache');
    if (typeof cache.shutdown === 'function') {
      await cache.shutdown();
      logger.info('cache shutdown complete');
    }
  } catch {
    // Cache may not have a shutdown method — that's fine
  }

  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
