/**
 * API Key Authentication Middleware with Multi-Tenancy
 *
 * Provides API key-based authentication and tenant identification.
 * Supports Bearer token and X-API-Key header extraction.
 *
 * @module middleware/auth
 */

import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { config } from '../config/env';
import { AppError, ErrorCode } from './error-handler';
import { logger } from '../utils/logger';
import { getKeyStore } from '../services/key-store';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: {
        id: string;
        authenticated: boolean;
        tier: string;
      };
    }
  }
}

const DEFAULT_TENANT_ID = 'default';

/**
 * Detect tier from raw API key prefix before hashing.
 * Keys use prefixes: anno_free_, anno_pro_, anno_biz_
 * Unknown prefixes default to 'free' (most restrictive).
 */
function detectTier(rawKey: string): string {
  if (rawKey.startsWith('anno_pro_')) return 'pro';
  if (rawKey.startsWith('anno_biz_')) return 'business';
  return 'free';
}

/**
 * Hash an API key to produce a tenant ID.
 * Never store or log raw keys.
 */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Extract API key from request headers.
 * Checks Authorization: Bearer <key> first, then x-api-key header.
 */
function extractKey(req: Request): string | undefined {
  const authHeader = req.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }

  const xApiKey = req.get('x-api-key');
  if (xApiKey) {
    return xApiKey;
  }

  return undefined;
}

/**
 * Attach default (unauthenticated) tenant info to the request.
 */
function attachDefaultTenant(req: Request): void {
  req.tenant = {
    id: DEFAULT_TENANT_ID,
    authenticated: false,
    tier: 'free',
  };
}

/**
 * API key authentication middleware.
 *
 * - If auth is disabled, passes through with a default tenant.
 * - If bypassInDev is true and NODE_ENV !== 'production', passes through with a default tenant.
 * - Validates key against configured apiKeys list.
 * - On valid key, attaches tenant info (hashed key as tenant ID).
 * - On missing/invalid key, responds with 401.
 */
export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  // Skip auth if disabled
  if (!config.auth.enabled) {
    attachDefaultTenant(req);
    next();
    return;
  }

  // Skip auth in dev mode when bypassInDev is true
  if (config.auth.bypassInDev && process.env.NODE_ENV !== 'production') {
    attachDefaultTenant(req);
    next();
    return;
  }

  const key = extractKey(req);

  if (!key) {
    next(new AppError(
      ErrorCode.UNAUTHORIZED,
      'Missing API key. Provide via Authorization: Bearer <key> or x-api-key header.',
      401
    ));
    return;
  }

  const keyHash = hashApiKey(key);
  const tier = detectTier(key);

  // Check env var keys first (fast, synchronous)
  const isEnvValid = config.auth.apiKeys.some(configuredKey => {
    const configuredHash = hashApiKey(configuredKey);
    return keyHash === configuredHash;
  });

  if (isEnvValid) {
    req.tenant = { id: keyHash, authenticated: true, tier };
    next();
    return;
  }

  // Check Redis key store (async, for dynamically provisioned keys)
  const keyStore = getKeyStore();
  if (!keyStore.isReady()) {
    // Redis unavailable — only env var keys work
    logger.warn('Invalid API key attempt', { keyHashPrefix: keyHash.slice(0, 8) });
    next(new AppError(ErrorCode.UNAUTHORIZED, 'Invalid API key.', 401));
    return;
  }

  keyStore.lookup(keyHash)
    .then((stored) => {
      if (stored) {
        req.tenant = { id: keyHash, authenticated: true, tier: stored.tier };
        next();
      } else {
        logger.warn('Invalid API key attempt', { keyHashPrefix: keyHash.slice(0, 8) });
        next(new AppError(ErrorCode.UNAUTHORIZED, 'Invalid API key.', 401));
      }
    })
    .catch((err) => {
      logger.error('KeyStore lookup failed, rejecting key', { error: (err as Error).message });
      next(new AppError(ErrorCode.UNAUTHORIZED, 'Invalid API key.', 401));
    });
}

// Re-export types and helpers used by existing server.ts imports
export interface AuthConfig {
  enabled: boolean;
  apiKeys: string[];
  headerName?: string;
  allowDevBypass?: boolean;
}

export interface AuthenticatedRequest extends Request {
  apiKey?: string;
  apiKeyHash?: string;
}

export function createAuthMiddleware(_authConfig: AuthConfig) {
  return authMiddleware;
}

export function extractApiKeyMiddleware(_headerName = 'X-API-Key') {
  return function (req: Request, _res: Response, next: NextFunction): void {
    attachDefaultTenant(req);
    next();
  };
}

export function getAuthConfigFromEnv(): AuthConfig {
  return {
    enabled: config.auth.enabled,
    apiKeys: config.auth.apiKeys,
    headerName: 'X-API-Key',
    allowDevBypass: config.auth.bypassInDev,
  };
}
