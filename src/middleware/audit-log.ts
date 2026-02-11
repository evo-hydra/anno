/**
 * Audit Logging Middleware
 *
 * Logs every request with tenant ID, method, path, status code, duration, and timestamp.
 * Uses res.on('finish') to capture the final response status.
 *
 * @module middleware/audit-log
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export interface AuditLogConfig {
  /** Whether to log request bodies (may contain sensitive data) */
  logRequestBody?: boolean;

  /** Whether to log response data */
  logResponse?: boolean;

  /** Paths to exclude from audit logging (e.g., /health, /metrics) */
  excludePaths?: string[];

  /** Maximum body size to log (in bytes) */
  maxBodySize?: number;
}

/**
 * Create audit logging middleware.
 *
 * Logs every request on response finish with:
 * - tenant ID
 * - HTTP method
 * - request path
 * - response status code
 * - request duration in ms
 * - timestamp
 *
 * Log level: info for 2xx/3xx, warn for 4xx, error for 5xx.
 */
export function createAuditLogMiddleware(_config: AuditLogConfig = {}) {
  return function auditLogMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const startTime = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const statusCode = res.statusCode;
      const tenantId = req.tenant?.id ?? 'unknown';

      const logData = {
        type: 'audit',
        tenantId: tenantId.length > 16 ? tenantId.slice(0, 8) + '...' : tenantId,
        method: req.method,
        path: req.path,
        statusCode,
        durationMs: duration,
        timestamp: new Date(startTime).toISOString(),
      };

      const message = `${req.method} ${req.path} ${statusCode} ${duration}ms`;

      if (statusCode >= 500) {
        logger.error(message, logData);
      } else if (statusCode >= 400) {
        logger.warn(message, logData);
      } else {
        logger.info(message, logData);
      }
    });

    next();
  };
}

/**
 * Helper to get audit config from environment
 */
export function getAuditConfigFromEnv(): AuditLogConfig {
  return {
    logRequestBody: process.env.AUDIT_LOG_REQUEST_BODY === 'true',
    logResponse: process.env.AUDIT_LOG_RESPONSE === 'true',
    excludePaths: ['/health', '/metrics'],
    maxBodySize: 1000
  };
}
