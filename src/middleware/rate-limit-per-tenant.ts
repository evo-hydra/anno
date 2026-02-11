/**
 * Per-Tenant Rate Limiting Middleware
 *
 * Tracks request counts per tenant ID using an in-memory sliding window.
 * Each tenant gets config.auth.rateLimitPerKey requests per minute.
 *
 * @module middleware/rate-limit-per-tenant
 */

import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/env';
import { AppError, ErrorCode } from './error-handler';
import { logger } from '../utils/logger';

const WINDOW_MS = 60_000; // 1 minute

interface WindowEntry {
  timestamps: number[];
}

const tenantWindows = new Map<string, WindowEntry>();

/**
 * Prune timestamps older than the sliding window for a given entry.
 */
function pruneWindow(entry: WindowEntry, now: number): void {
  const cutoff = now - WINDOW_MS;
  // Remove timestamps older than the window
  while (entry.timestamps.length > 0 && entry.timestamps[0] <= cutoff) {
    entry.timestamps.shift();
  }
}

/**
 * Per-tenant rate limiting middleware.
 *
 * - Skips if auth is disabled.
 * - Tracks request counts per tenant ID using a sliding window of 1 minute.
 * - Responds with 429 and Retry-After header when limit is exceeded.
 */
export function rateLimitPerTenantMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip rate limiting if auth is disabled
  if (!config.auth.enabled) {
    next();
    return;
  }

  const tenantId = req.tenant?.id;
  if (!tenantId) {
    // No tenant attached — skip rate limiting
    next();
    return;
  }

  const now = Date.now();
  const limit = config.auth.rateLimitPerKey;

  let entry = tenantWindows.get(tenantId);
  if (!entry) {
    entry = { timestamps: [] };
    tenantWindows.set(tenantId, entry);
  }

  pruneWindow(entry, now);

  if (entry.timestamps.length >= limit) {
    // Calculate how long until the oldest request in the window expires
    const oldestTimestamp = entry.timestamps[0];
    const retryAfterMs = (oldestTimestamp + WINDOW_MS) - now;
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

    logger.warn('Rate limit exceeded', {
      tenantId: tenantId.slice(0, 8) + '...',
      limit,
      windowMs: WINDOW_MS,
    });

    res.setHeader('Retry-After', String(retryAfterSeconds));
    next(new AppError(
      ErrorCode.RATE_LIMIT_EXCEEDED,
      `Rate limit exceeded. Maximum ${limit} requests per minute. Retry after ${retryAfterSeconds} seconds.`,
      429
    ));
    return;
  }

  entry.timestamps.push(now);
  next();
}

/**
 * Reset all tenant windows (useful for testing).
 */
export function resetTenantWindows(): void {
  tenantWindows.clear();
}
