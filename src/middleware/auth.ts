/**
 * API Authentication Middleware
 *
 * Provides API key-based authentication for securing endpoints.
 * Supports multiple keys for different clients/services.
 *
 * @module middleware/auth
 */

import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';

export interface AuthConfig {
  /** Whether authentication is enabled (default: false for dev) */
  enabled: boolean;

  /** List of valid API keys (plain text or SHA-256 hashes) */
  apiKeys: string[];

  /** Header name for API key (default: 'X-API-Key') */
  headerName?: string;

  /** Whether to allow bypass in development mode */
  allowDevBypass?: boolean;
}

export interface AuthenticatedRequest extends Request {
  /** API key that was used for authentication */
  apiKey?: string;

  /** Hash of the API key (for logging) */
  apiKeyHash?: string;
}

/**
 * Hash an API key for secure storage/comparison
 */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Verify if a provided key matches any of the configured keys
 */
function verifyApiKey(providedKey: string, configuredKeys: string[]): { valid: boolean; keyHash: string } {
  const providedHash = hashApiKey(providedKey);

  for (const configuredKey of configuredKeys) {
    // Support both plain text keys and pre-hashed keys
    const configuredHash = configuredKey.length === 64 && /^[a-f0-9]+$/i.test(configuredKey)
      ? configuredKey.toLowerCase()
      : hashApiKey(configuredKey);

    if (providedHash === configuredHash) {
      return { valid: true, keyHash: providedHash };
    }
  }

  return { valid: false, keyHash: providedHash };
}

/**
 * Create authentication middleware
 *
 * @example
 * ```typescript
 * const authMiddleware = createAuthMiddleware({
 *   enabled: true,
 *   apiKeys: ['secret-key-1', 'secret-key-2']
 * });
 * app.use('/v1', authMiddleware);
 * ```
 */
export function createAuthMiddleware(config: AuthConfig) {
  const {
    enabled = false,
    apiKeys = [],
    headerName = 'X-API-Key',
    allowDevBypass = true
  } = config;

  return function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Skip auth if disabled
    if (!enabled) {
      next();
      return;
    }

    // Allow bypass in development mode (NODE_ENV !== 'production')
    if (allowDevBypass && process.env.NODE_ENV !== 'production') {
      next();
      return;
    }

    // No keys configured - fail closed for security
    if (apiKeys.length === 0) {
      res.status(500).json({
        error: 'Authentication is enabled but no API keys are configured'
      });
      return;
    }

    // Extract API key from header
    const providedKey = req.headers[headerName.toLowerCase()] as string | undefined;

    if (!providedKey) {
      res.status(401).json({
        error: 'Missing API key',
        message: `Please provide an API key in the '${headerName}' header`
      });
      return;
    }

    // Verify API key
    const { valid, keyHash } = verifyApiKey(providedKey, apiKeys);

    if (!valid) {
      res.status(403).json({
        error: 'Invalid API key',
        message: 'The provided API key is not authorized'
      });
      return;
    }

    // Attach auth metadata to request
    const authReq = req as AuthenticatedRequest;
    authReq.apiKey = providedKey;
    authReq.apiKeyHash = keyHash;

    next();
  };
}

/**
 * Optional middleware to extract API key without requiring it
 * Useful for endpoints that track usage by key but don't require auth
 */
export function extractApiKeyMiddleware(headerName = 'X-API-Key') {
  return function (req: Request, _res: Response, next: NextFunction): void {
    const providedKey = req.headers[headerName.toLowerCase()] as string | undefined;

    if (providedKey) {
      const authReq = req as AuthenticatedRequest;
      authReq.apiKey = providedKey;
      authReq.apiKeyHash = hashApiKey(providedKey);
    }

    next();
  };
}

/**
 * Helper to get auth config from environment variables
 *
 * Supports:
 * - API_AUTH_ENABLED=true/false
 * - API_KEYS=key1,key2,key3 (comma-separated)
 * - API_KEY_HEADER=X-Custom-Header
 */
export function getAuthConfigFromEnv(): AuthConfig {
  const enabled = process.env.API_AUTH_ENABLED === 'true';

  const apiKeys = process.env.API_KEYS
    ? process.env.API_KEYS.split(',').map(k => k.trim()).filter(k => k.length > 0)
    : [];

  const headerName = process.env.API_KEY_HEADER || 'X-API-Key';

  return {
    enabled,
    apiKeys,
    headerName,
    allowDevBypass: true
  };
}
