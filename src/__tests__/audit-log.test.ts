import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Mock logger before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { createAuditLogMiddleware, getAuditConfigFromEnv } from '../middleware/audit-log';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    AUDIT_LOG_REQUEST_BODY: process.env.AUDIT_LOG_REQUEST_BODY,
    AUDIT_LOG_RESPONSE: process.env.AUDIT_LOG_RESPONSE,
  };
  vi.clearAllMocks();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

/**
 * Create a mock response that can emit 'finish' events.
 */
function createMockRes(statusCode = 200): Response & EventEmitter {
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  }) as unknown as Response & EventEmitter;
  return res;
}

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/v1/content/fetch',
    headers: {},
    tenant: undefined,
    ...overrides,
  } as unknown as Request;
}

// ---------------------------------------------------------------------------
// getAuditConfigFromEnv
// ---------------------------------------------------------------------------

describe('getAuditConfigFromEnv', () => {
  it('returns defaults when no env vars are set', () => {
    delete process.env.AUDIT_LOG_REQUEST_BODY;
    delete process.env.AUDIT_LOG_RESPONSE;

    const cfg = getAuditConfigFromEnv();

    expect(cfg.logRequestBody).toBe(false);
    expect(cfg.logResponse).toBe(false);
    expect(cfg.excludePaths).toEqual(['/health', '/metrics']);
    expect(cfg.maxBodySize).toBe(1000);
  });

  it('enables logRequestBody when env is "true"', () => {
    process.env.AUDIT_LOG_REQUEST_BODY = 'true';
    const cfg = getAuditConfigFromEnv();
    expect(cfg.logRequestBody).toBe(true);
  });

  it('enables logResponse when env is "true"', () => {
    process.env.AUDIT_LOG_RESPONSE = 'true';
    const cfg = getAuditConfigFromEnv();
    expect(cfg.logResponse).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createAuditLogMiddleware — basic behavior
// ---------------------------------------------------------------------------

describe('createAuditLogMiddleware', () => {
  it('calls next() immediately', () => {
    const mw = createAuditLogMiddleware();
    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn();

    mw(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('logs info for 2xx status codes on finish', () => {
    const mw = createAuditLogMiddleware();
    const req = createMockReq({ method: 'POST', path: '/v1/fetch' });
    const res = createMockRes(200);
    const next = vi.fn();

    mw(req, res as unknown as Response, next);
    res.emit('finish');

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('POST /v1/fetch 200'),
      expect.objectContaining({
        type: 'audit',
        method: 'POST',
        path: '/v1/fetch',
        statusCode: 200,
      })
    );
  });

  it('logs info for 3xx status codes on finish', () => {
    const mw = createAuditLogMiddleware();
    const req = createMockReq({ method: 'GET', path: '/redirect' });
    const res = createMockRes(301);
    const next = vi.fn();

    mw(req, res as unknown as Response, next);
    res.emit('finish');

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('301'),
      expect.objectContaining({ statusCode: 301 })
    );
  });

  it('logs warn for 4xx status codes on finish', () => {
    const mw = createAuditLogMiddleware();
    const req = createMockReq({ method: 'GET', path: '/not-found' });
    const res = createMockRes(404);
    const next = vi.fn();

    mw(req, res as unknown as Response, next);
    res.emit('finish');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('404'),
      expect.objectContaining({ statusCode: 404 })
    );
  });

  it('logs error for 5xx status codes on finish', () => {
    const mw = createAuditLogMiddleware();
    const req = createMockReq({ method: 'POST', path: '/crash' });
    const res = createMockRes(500);
    const next = vi.fn();

    mw(req, res as unknown as Response, next);
    res.emit('finish');

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('500'),
      expect.objectContaining({ statusCode: 500 })
    );
  });

  it('includes tenantId in log when present', () => {
    const mw = createAuditLogMiddleware();
    const req = createMockReq({ tenant: { id: 'tenant-123', authenticated: true } });
    const res = createMockRes(200);
    const next = vi.fn();

    mw(req, res as unknown as Response, next);
    res.emit('finish');

    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tenantId: 'tenant-123' })
    );
  });

  it('truncates long tenantId to 8 chars plus ellipsis', () => {
    const mw = createAuditLogMiddleware();
    const req = createMockReq({
      tenant: { id: 'a1b2c3d4e5f6g7h8i9j0', authenticated: true },
    });
    const res = createMockRes(200);
    const next = vi.fn();

    mw(req, res as unknown as Response, next);
    res.emit('finish');

    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tenantId: 'a1b2c3d4...' })
    );
  });

  it('uses "unknown" tenantId when tenant is not set', () => {
    const mw = createAuditLogMiddleware();
    const req = createMockReq({ tenant: undefined });
    const res = createMockRes(200);
    const next = vi.fn();

    mw(req, res as unknown as Response, next);
    res.emit('finish');

    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tenantId: 'unknown' })
    );
  });

  it('includes durationMs and timestamp in log data', () => {
    const mw = createAuditLogMiddleware();
    const req = createMockReq();
    const res = createMockRes(200);
    const next = vi.fn();

    mw(req, res as unknown as Response, next);
    res.emit('finish');

    const logCall = vi.mocked(logger.info).mock.calls[0];
    const logData = logCall[1] as Record<string, unknown>;

    expect(logData.durationMs).toBeTypeOf('number');
    expect(logData.durationMs).toBeGreaterThanOrEqual(0);
    expect(logData.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not log before finish event', () => {
    const mw = createAuditLogMiddleware();
    const req = createMockReq();
    const res = createMockRes(200);
    const next = vi.fn();

    mw(req, res as unknown as Response, next);

    // No logger calls yet since finish hasn't fired
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
