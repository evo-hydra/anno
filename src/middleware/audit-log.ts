/**
 * Audit Logging Middleware
 *
 * Logs API usage for security and compliance purposes.
 * Tracks who accessed what endpoints with what data.
 *
 * @module middleware/audit-log
 */

import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './auth';
import { logger } from '../utils/logger';

export interface AuditLogEntry {
  timestamp: number;
  method: string;
  path: string;
  apiKeyHash?: string;
  ip: string;
  userAgent?: string;
  requestBody?: unknown;
  responseStatus?: number;
  responseTime?: number;
  error?: string;
}

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
 * Create audit logging middleware
 *
 * Logs structured JSON entries for each API request
 */
export function createAuditLogMiddleware(config: AuditLogConfig = {}) {
  const {
    logRequestBody = false,
    logResponse = false,
    excludePaths = ['/health', '/metrics'],
    maxBodySize = 1000
  } = config;

  return function auditLogMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Skip excluded paths
    if (excludePaths.some(path => req.path.startsWith(path))) {
      next();
      return;
    }

    const startTime = Date.now();
    const authReq = req as AuthenticatedRequest;

    // Get IP address
    const forwarded = req.headers['x-forwarded-for'];
    const ip = typeof forwarded === 'string'
      ? forwarded.split(',')[0].trim()
      : req.ip || 'unknown';

    // Prepare audit entry
    const entry: AuditLogEntry = {
      timestamp: startTime,
      method: req.method,
      path: req.path,
      apiKeyHash: authReq.apiKeyHash,
      ip,
      userAgent: req.headers['user-agent']
    };

    // Optionally log request body (sanitized)
    if (logRequestBody && req.body) {
      const bodyStr = JSON.stringify(req.body);
      entry.requestBody = bodyStr.length <= maxBodySize
        ? req.body
        : `[TRUNCATED ${bodyStr.length} bytes]`;
    }

    // Intercept response to log result
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    res.json = function (body: unknown) {
      entry.responseStatus = res.statusCode;
      entry.responseTime = Date.now() - startTime;

      if (logResponse && body) {
        const bodyStr = JSON.stringify(body);
        if (bodyStr.length <= maxBodySize) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (entry as any).responseBody = body;
        }
      }

      // Log the audit entry
      logAuditEntry(entry);

      return originalJson(body);
    };

    res.send = function (body: unknown) {
      entry.responseStatus = res.statusCode;
      entry.responseTime = Date.now() - startTime;

      // Log the audit entry
      logAuditEntry(entry);

      return originalSend(body);
    };

    next();
  };
}

/**
 * Log audit entry to structured logger
 */
function logAuditEntry(entry: AuditLogEntry): void {
  const level = entry.responseStatus && entry.responseStatus >= 400 ? 'warn' : 'info';
  const message = `API ${entry.method} ${entry.path} - ${entry.responseStatus} (${entry.responseTime}ms)`;

  const logData = {
    type: 'audit',
    ...entry,
    apiKeyHash: entry.apiKeyHash ? entry.apiKeyHash.slice(0, 8) + '...' : undefined
  };

  logger[level](message, logData);
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
