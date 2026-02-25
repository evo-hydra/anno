/**
 * Monthly Quota Enforcement Middleware
 *
 * Checks per-tenant monthly request count against tier limits.
 * Tracks usage in Redis via QuotaStore. Fails open if Redis is unavailable.
 *
 * Response headers on every request:
 *   X-Quota-Limit     — monthly limit for the tenant's tier
 *   X-Quota-Remaining — requests remaining this month
 *   X-Quota-Reset     — ISO 8601 timestamp when quota resets (1st of next month UTC)
 *
 * @module middleware/quota
 */

import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/env';
import { AppError, ErrorCode } from './error-handler';
import { getQuotaStore } from '../services/quota-store';
import { logger } from '../utils/logger';

export function quotaMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.quota.enabled || !config.auth.enabled) {
    next();
    return;
  }

  const tenant = req.tenant;
  if (!tenant || !tenant.authenticated) {
    next();
    return;
  }

  const tierConfig = config.quota.tiers[tenant.tier];
  if (!tierConfig) {
    logger.warn('Unknown tier for quota check', { tier: tenant.tier, tenantId: tenant.id.slice(0, 8) });
    next();
    return;
  }

  const store = getQuotaStore();
  const resetDate = store.getResetDate();
  const limit = tierConfig.monthlyLimit;

  // Async operation — handle via promise chain to work with Express
  store.increment(tenant.id)
    .then((used) => {
      const remaining = Math.max(0, limit - used);

      res.setHeader('X-Quota-Limit', String(limit));
      res.setHeader('X-Quota-Remaining', String(remaining));
      res.setHeader('X-Quota-Reset', resetDate.toISOString());

      if (used > limit) {
        const retryAfter = Math.ceil((resetDate.getTime() - Date.now()) / 1000);

        logger.warn('Monthly quota exceeded', {
          tenantId: tenant.id.slice(0, 8) + '...',
          tier: tenant.tier,
          used,
          limit,
        });

        res.setHeader('Retry-After', String(retryAfter));
        next(new AppError(
          ErrorCode.RATE_LIMIT_EXCEEDED,
          `Monthly quota exceeded. Your ${tenant.tier} plan allows ${limit.toLocaleString()} requests/month. Resets ${resetDate.toISOString()}.`,
          429
        ));
        return;
      }

      next();
    })
    .catch((err) => {
      // Fail open — if quota check fails, let the request through
      logger.error('Quota check failed, allowing request', { error: (err as Error).message });
      next();
    });
}
