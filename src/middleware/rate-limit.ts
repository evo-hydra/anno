/**
 * API Rate Limiting Middleware
 *
 * Provides rate limiting for API endpoints based on IP address or API key.
 * Uses a token bucket algorithm for smooth rate limiting.
 *
 * @module middleware/rate-limit
 */

import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './auth';

export interface RateLimitConfig {
  /** Whether rate limiting is enabled */
  enabled: boolean;

  /** Maximum requests per window */
  maxRequests: number;

  /** Window duration in milliseconds */
  windowMs: number;

  /** Message to return when rate limited */
  message?: string;

  /** Whether to use API key for rate limiting (default: true if available) */
  keyByApiKey?: boolean;

  /** Whether to use IP address for rate limiting (default: true) */
  keyByIp?: boolean;
}

interface RateLimitEntry {
  /** Number of tokens (requests) remaining */
  tokens: number;

  /** Last time tokens were refilled */
  lastRefill: number;
}

/**
 * In-memory rate limiter using token bucket algorithm
 */
class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, RateLimitEntry>();
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxTokens = maxRequests;
    this.windowMs = windowMs;
    this.refillRate = maxRequests / windowMs;
  }

  /**
   * Check if a request is allowed for the given key
   * @returns { allowed: boolean, remaining: number, resetMs: number }
   */
  checkLimit(key: string): {
    allowed: boolean;
    remaining: number;
    resetMs: number;
  } {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = {
        tokens: this.maxTokens - 1, // consume 1 token
        lastRefill: now
      };
      this.buckets.set(key, bucket);

      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        resetMs: this.windowMs
      };
    }

    // Refill tokens based on time elapsed
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    // Check if request is allowed
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        resetMs: Math.ceil((this.maxTokens - bucket.tokens) / this.refillRate)
      };
    }

    // Rate limited
    return {
      allowed: false,
      remaining: 0,
      resetMs: Math.ceil((1 - bucket.tokens) / this.refillRate)
    };
  }

  /**
   * Get current stats
   */
  getStats(): {
    totalKeys: number;
    buckets: Array<{ key: string; tokens: number; age: number }>;
  } {
    const now = Date.now();
    const buckets = Array.from(this.buckets.entries()).map(([key, bucket]) => ({
      key: key.replace(/\d+/g, 'X'), // Anonymize IPs/keys
      tokens: Math.floor(bucket.tokens),
      age: now - bucket.lastRefill
    }));

    return {
      totalKeys: this.buckets.size,
      buckets
    };
  }

  /**
   * Clean up old buckets (call periodically)
   */
  cleanup(maxAgeMs = 3600000): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > maxAgeMs) {
        this.buckets.delete(key);
      }
    }
  }
}

/**
 * Create rate limiting middleware
 *
 * @example
 * ```typescript
 * const rateLimitMiddleware = createRateLimitMiddleware({
 *   enabled: true,
 *   maxRequests: 100,
 *   windowMs: 60000 // 100 requests per minute
 * });
 * app.use('/v1', rateLimitMiddleware);
 * ```
 */
export function createRateLimitMiddleware(config: RateLimitConfig) {
  const {
    enabled = false,
    maxRequests,
    windowMs,
    message = 'Too many requests, please try again later',
    keyByApiKey = true,
    keyByIp = true
  } = config;

  const limiter = new TokenBucketRateLimiter(maxRequests, windowMs);

  // Cleanup old buckets every 10 minutes
  if (enabled) {
    setInterval(() => limiter.cleanup(), 600000);
  }

  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    if (!enabled) {
      next();
      return;
    }

    // Determine rate limit key (prefer API key over IP)
    const authReq = req as AuthenticatedRequest;
    let key: string;

    if (keyByApiKey && authReq.apiKeyHash) {
      key = `apikey:${authReq.apiKeyHash}`;
    } else if (keyByIp) {
      // Get IP from X-Forwarded-For or req.ip
      const forwarded = req.headers['x-forwarded-for'];
      const ip = typeof forwarded === 'string'
        ? forwarded.split(',')[0].trim()
        : req.ip || 'unknown';
      key = `ip:${ip}`;
    } else {
      key = 'global';
    }

    // Check rate limit
    const { allowed, remaining, resetMs } = limiter.checkLimit(key);

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining).toString());
    res.setHeader('X-RateLimit-Reset', new Date(Date.now() + resetMs).toISOString());

    if (!allowed) {
      res.status(429).json({
        error: 'Rate limit exceeded',
        message,
        retryAfter: Math.ceil(resetMs / 1000) // seconds
      });
      return;
    }

    next();
  };
}

/**
 * Helper to get rate limit config from environment variables
 *
 * Supports:
 * - RATE_LIMIT_ENABLED=true/false
 * - RATE_LIMIT_MAX_REQUESTS=100
 * - RATE_LIMIT_WINDOW_MS=60000
 */
export function getRateLimitConfigFromEnv(): RateLimitConfig {
  const enabled = process.env.RATE_LIMIT_ENABLED === 'true';
  const maxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10);
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

  return {
    enabled,
    maxRequests,
    windowMs,
    keyByApiKey: true,
    keyByIp: true
  };
}
