/**
 * Security Middleware
 *
 * Provides security headers and CORS configuration for production deployments.
 * Uses helmet for standard security headers and configurable CORS.
 *
 * @module middleware/security
 */

import helmet from 'helmet';
import cors from 'cors';
import type { Request, Response, NextFunction } from 'express';

/**
 * Security configuration from environment variables
 */
export interface SecurityConfig {
  /** Allowed CORS origins (comma-separated) */
  allowedOrigins: string[];

  /** Whether to enable CORS credentials */
  corsCredentials: boolean;

  /** Maximum request body size */
  maxRequestSize: string;

  /** Whether to force HTTPS redirect */
  forceHttps: boolean;
}

/**
 * Get security config from environment variables
 */
export function getSecurityConfigFromEnv(): SecurityConfig {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['*'];

  return {
    allowedOrigins,
    corsCredentials: process.env.CORS_CREDENTIALS === 'true',
    maxRequestSize: process.env.MAX_REQUEST_SIZE || '1mb',
    forceHttps: process.env.FORCE_HTTPS === 'true' && process.env.NODE_ENV === 'production',
  };
}

/**
 * Create helmet security middleware with recommended settings
 *
 * Provides:
 * - Content-Security-Policy (CSP)
 * - HTTP Strict Transport Security (HSTS)
 * - X-Frame-Options (clickjacking protection)
 * - X-Content-Type-Options (MIME sniffing protection)
 * - X-XSS-Protection
 * - Referrer-Policy
 */
export function createSecurityHeadersMiddleware() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Allow inline styles for error pages
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    frameguard: {
      action: 'deny', // Prevent iframe embedding
    },
    noSniff: true, // Prevent MIME sniffing
    xssFilter: true, // Enable XSS filter
    referrerPolicy: {
      policy: 'strict-origin-when-cross-origin',
    },
  });
}

/**
 * Create CORS middleware with configurable origins
 *
 * @example
 * ```typescript
 * const corsMiddleware = createCorsMiddleware({
 *   allowedOrigins: ['https://app.example.com', 'https://api.example.com'],
 *   corsCredentials: true
 * });
 * ```
 */
export function createCorsMiddleware(config: Pick<SecurityConfig, 'allowedOrigins' | 'corsCredentials'>) {
  const { allowedOrigins, corsCredentials } = config;

  return cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, Postman)
      if (!origin) {
        return callback(null, true);
      }

      // Allow all origins in development
      if (process.env.NODE_ENV !== 'production') {
        return callback(null, true);
      }

      // Check if origin is in allowed list
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: corsCredentials,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-ID'],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'X-Request-ID',
    ],
    maxAge: 86400, // 24 hours
  });
}

/**
 * HTTPS redirect middleware
 * Only redirects in production when FORCE_HTTPS is true
 *
 * @example
 * ```typescript
 * app.use(httpsRedirectMiddleware);
 * ```
 */
export function httpsRedirectMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip in development
  if (process.env.NODE_ENV !== 'production') {
    return next();
  }

  // Skip if FORCE_HTTPS is not enabled
  if (process.env.FORCE_HTTPS !== 'true') {
    return next();
  }

  // Check if request is already HTTPS
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';

  if (!isHttps) {
    // Skip redirect for health checks
    if (req.path === '/health' || req.path === '/metrics') {
      return next();
    }

    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }

  next();
}

/**
 * Request size limit middleware
 * Prevents large request bodies from consuming resources
 */
export function createRequestSizeLimitMiddleware(maxSize: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const contentLength = req.headers['content-length'];

    if (contentLength) {
      const bytes = parseInt(contentLength, 10);
      const maxBytes = parseSize(maxSize);

      if (bytes > maxBytes) {
        res.status(413).json({
          error: 'Payload too large',
          message: `Request body must be smaller than ${maxSize}`,
          maxSize,
        });
        return;
      }
    }

    next();
  };
}

/**
 * Parse size string like "1mb", "500kb" to bytes
 */
function parseSize(size: string): number {
  const units: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };

  const match = size.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/);
  if (!match) {
    return parseInt(size, 10) || 1024 * 1024; // Default 1MB
  }

  const [, value, unit] = match;
  return parseFloat(value) * (units[unit] || 1);
}
