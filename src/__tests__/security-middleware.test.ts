import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Mock helmet and cors — they return middleware functions
// ---------------------------------------------------------------------------

const mockHelmetMiddleware = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
const mockCorsMiddleware = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());

vi.mock('helmet', () => ({
  default: vi.fn(() => mockHelmetMiddleware),
}));

vi.mock('cors', () => ({
  default: vi.fn((_opts: unknown) => mockCorsMiddleware),
}));

import {
  createSecurityHeadersMiddleware,
  createCorsMiddleware,
  httpsRedirectMiddleware,
  getSecurityConfigFromEnv,
  createRequestSizeLimitMiddleware,
} from '../middleware/security';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    CORS_CREDENTIALS: process.env.CORS_CREDENTIALS,
    MAX_REQUEST_SIZE: process.env.MAX_REQUEST_SIZE,
    FORCE_HTTPS: process.env.FORCE_HTTPS,
    NODE_ENV: process.env.NODE_ENV,
  };
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

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    path: '/test',
    url: '/test',
    secure: false,
    method: 'GET',
    header: vi.fn(),
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): Response & { _statusCode?: number; _body?: unknown; _redirectUrl?: string } {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    redirect: vi.fn(),
  } as unknown as Response & { _statusCode?: number; _body?: unknown; _redirectUrl?: string };
  return res;
}

// ---------------------------------------------------------------------------
// getSecurityConfigFromEnv
// ---------------------------------------------------------------------------

describe('getSecurityConfigFromEnv', () => {
  it('returns defaults when no env vars are set', () => {
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.CORS_CREDENTIALS;
    delete process.env.MAX_REQUEST_SIZE;
    delete process.env.FORCE_HTTPS;
    delete process.env.NODE_ENV;

    const cfg = getSecurityConfigFromEnv();

    expect(cfg.allowedOrigins).toEqual(['*']);
    expect(cfg.corsCredentials).toBe(false);
    expect(cfg.maxRequestSize).toBe('1mb');
    expect(cfg.forceHttps).toBe(false);
  });

  it('parses comma-separated ALLOWED_ORIGINS', () => {
    process.env.ALLOWED_ORIGINS = 'https://a.com, https://b.com ,https://c.com';
    const cfg = getSecurityConfigFromEnv();
    expect(cfg.allowedOrigins).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });

  it('sets corsCredentials to true when CORS_CREDENTIALS=true', () => {
    process.env.CORS_CREDENTIALS = 'true';
    const cfg = getSecurityConfigFromEnv();
    expect(cfg.corsCredentials).toBe(true);
  });

  it('reads MAX_REQUEST_SIZE from env', () => {
    process.env.MAX_REQUEST_SIZE = '5mb';
    const cfg = getSecurityConfigFromEnv();
    expect(cfg.maxRequestSize).toBe('5mb');
  });

  it('sets forceHttps only when FORCE_HTTPS=true AND NODE_ENV=production', () => {
    process.env.FORCE_HTTPS = 'true';
    process.env.NODE_ENV = 'production';
    const cfg = getSecurityConfigFromEnv();
    expect(cfg.forceHttps).toBe(true);
  });

  it('does not force HTTPS outside production', () => {
    process.env.FORCE_HTTPS = 'true';
    process.env.NODE_ENV = 'development';
    const cfg = getSecurityConfigFromEnv();
    expect(cfg.forceHttps).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createSecurityHeadersMiddleware
// ---------------------------------------------------------------------------

describe('createSecurityHeadersMiddleware', () => {
  it('returns a middleware function from helmet', () => {
    const mw = createSecurityHeadersMiddleware();
    expect(typeof mw).toBe('function');
  });

  it('calls helmet with expected CSP directives', async () => {
    const helmetMod = await import('helmet');
    const helmetFn = vi.mocked(helmetMod.default);
    helmetFn.mockClear();

    createSecurityHeadersMiddleware();

    expect(helmetFn).toHaveBeenCalledTimes(1);
    const opts = helmetFn.mock.calls[0][0] as Record<string, unknown>;
    expect(opts).toHaveProperty('contentSecurityPolicy');
    expect(opts).toHaveProperty('hsts');
    expect(opts).toHaveProperty('frameguard');
  });
});

// ---------------------------------------------------------------------------
// createCorsMiddleware
// ---------------------------------------------------------------------------

describe('createCorsMiddleware', () => {
  it('returns a middleware function', () => {
    const mw = createCorsMiddleware({ allowedOrigins: ['*'], corsCredentials: false });
    expect(typeof mw).toBe('function');
  });

  it('passes cors config through to the cors library', async () => {
    const corsMod = await import('cors');
    const corsFn = vi.mocked(corsMod.default);
    corsFn.mockClear();

    createCorsMiddleware({ allowedOrigins: ['https://example.com'], corsCredentials: true });

    expect(corsFn).toHaveBeenCalledTimes(1);
    const opts = corsFn.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.credentials).toBe(true);
    expect(opts.methods).toContain('GET');
    expect(opts.methods).toContain('POST');
  });

  it('origin callback allows requests with no origin', async () => {
    const corsMod = await import('cors');
    const corsFn = vi.mocked(corsMod.default);
    corsFn.mockClear();

    createCorsMiddleware({ allowedOrigins: ['https://example.com'], corsCredentials: false });

    const opts = corsFn.mock.calls[0][0] as Record<string, unknown>;
    const originFn = opts.origin as (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void;

    const cb = vi.fn();
    originFn(undefined, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('origin callback allows all origins in non-production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    const corsMod = await import('cors');
    const corsFn = vi.mocked(corsMod.default);
    corsFn.mockClear();

    createCorsMiddleware({ allowedOrigins: ['https://example.com'], corsCredentials: false });

    const opts = corsFn.mock.calls[0][0] as Record<string, unknown>;
    const originFn = opts.origin as (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void;

    const cb = vi.fn();
    originFn('https://unknown.com', cb);
    expect(cb).toHaveBeenCalledWith(null, true);

    process.env.NODE_ENV = originalEnv;
  });

  it('origin callback allows listed origin in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const corsMod = await import('cors');
    const corsFn = vi.mocked(corsMod.default);
    corsFn.mockClear();

    createCorsMiddleware({ allowedOrigins: ['https://allowed.com'], corsCredentials: false });

    const opts = corsFn.mock.calls[0][0] as Record<string, unknown>;
    const originFn = opts.origin as (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void;

    const cb = vi.fn();
    originFn('https://allowed.com', cb);
    expect(cb).toHaveBeenCalledWith(null, true);

    process.env.NODE_ENV = originalEnv;
  });

  it('origin callback rejects unlisted origin in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const corsMod = await import('cors');
    const corsFn = vi.mocked(corsMod.default);
    corsFn.mockClear();

    createCorsMiddleware({ allowedOrigins: ['https://allowed.com'], corsCredentials: false });

    const opts = corsFn.mock.calls[0][0] as Record<string, unknown>;
    const originFn = opts.origin as (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void;

    const cb = vi.fn();
    originFn('https://evil.com', cb);
    expect(cb).toHaveBeenCalledWith(expect.any(Error));

    process.env.NODE_ENV = originalEnv;
  });

  it('origin callback allows wildcard in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const corsMod = await import('cors');
    const corsFn = vi.mocked(corsMod.default);
    corsFn.mockClear();

    createCorsMiddleware({ allowedOrigins: ['*'], corsCredentials: false });

    const opts = corsFn.mock.calls[0][0] as Record<string, unknown>;
    const originFn = opts.origin as (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void;

    const cb = vi.fn();
    originFn('https://anything.com', cb);
    expect(cb).toHaveBeenCalledWith(null, true);

    process.env.NODE_ENV = originalEnv;
  });
});

// ---------------------------------------------------------------------------
// httpsRedirectMiddleware
// ---------------------------------------------------------------------------

describe('httpsRedirectMiddleware', () => {
  it('calls next() in non-production', () => {
    process.env.NODE_ENV = 'development';
    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn();

    httpsRedirectMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('calls next() in production when FORCE_HTTPS is not set', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.FORCE_HTTPS;
    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn();

    httpsRedirectMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next() when request is already HTTPS (req.secure)', () => {
    process.env.NODE_ENV = 'production';
    process.env.FORCE_HTTPS = 'true';
    const req = createMockReq({ secure: true });
    const res = createMockRes();
    const next = vi.fn();

    httpsRedirectMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('calls next() when x-forwarded-proto is https', () => {
    process.env.NODE_ENV = 'production';
    process.env.FORCE_HTTPS = 'true';
    const req = createMockReq({
      secure: false,
      headers: { 'x-forwarded-proto': 'https' } as Record<string, string>,
    });
    const res = createMockRes();
    const next = vi.fn();

    httpsRedirectMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('redirects HTTP to HTTPS in production with FORCE_HTTPS=true', () => {
    process.env.NODE_ENV = 'production';
    process.env.FORCE_HTTPS = 'true';
    const req = createMockReq({
      secure: false,
      headers: { host: 'example.com' } as Record<string, string>,
      url: '/api/test',
      path: '/api/test',
    });
    const res = createMockRes();
    const next = vi.fn();

    httpsRedirectMiddleware(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith(301, 'https://example.com/api/test');
    expect(next).not.toHaveBeenCalled();
  });

  it('skips redirect for /health path', () => {
    process.env.NODE_ENV = 'production';
    process.env.FORCE_HTTPS = 'true';
    const req = createMockReq({
      secure: false,
      headers: {} as Record<string, string>,
      path: '/health',
    });
    const res = createMockRes();
    const next = vi.fn();

    httpsRedirectMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('skips redirect for /metrics path', () => {
    process.env.NODE_ENV = 'production';
    process.env.FORCE_HTTPS = 'true';
    const req = createMockReq({
      secure: false,
      headers: {} as Record<string, string>,
      path: '/metrics',
    });
    const res = createMockRes();
    const next = vi.fn();

    httpsRedirectMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createRequestSizeLimitMiddleware
// ---------------------------------------------------------------------------

describe('createRequestSizeLimitMiddleware', () => {
  it('calls next when content-length is within limit', () => {
    const mw = createRequestSizeLimitMiddleware('1mb');
    const req = createMockReq({ headers: { 'content-length': '500' } as Record<string, string> });
    const res = createMockRes();
    const next = vi.fn();

    mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 413 when content-length exceeds limit', () => {
    const mw = createRequestSizeLimitMiddleware('1kb');
    const req = createMockReq({ headers: { 'content-length': '2048' } as Record<string, string> });
    const res = createMockRes();
    const next = vi.fn();

    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Payload too large',
        maxSize: '1kb',
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when no content-length header', () => {
    const mw = createRequestSizeLimitMiddleware('1mb');
    const req = createMockReq({ headers: {} as Record<string, string> });
    const res = createMockRes();
    const next = vi.fn();

    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('parses various size units correctly', () => {
    // 500 bytes limit, request is 600 bytes
    const mwBytes = createRequestSizeLimitMiddleware('500b');
    const req = createMockReq({ headers: { 'content-length': '600' } as Record<string, string> });
    const res = createMockRes();
    const next = vi.fn();

    mwBytes(req, res, next);
    expect(res.status).toHaveBeenCalledWith(413);
  });

  it('handles gb size unit', () => {
    const mw = createRequestSizeLimitMiddleware('1gb');
    const req = createMockReq({ headers: { 'content-length': '500' } as Record<string, string> });
    const res = createMockRes();
    const next = vi.fn();

    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('defaults to 1MB for unparsable size', () => {
    const mw = createRequestSizeLimitMiddleware('invalid');
    // 1MB = 1048576 bytes, send something smaller
    const req = createMockReq({ headers: { 'content-length': '500' } as Record<string, string> });
    const res = createMockRes();
    const next = vi.fn();

    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('handles plain numeric string as bytes', () => {
    const mw = createRequestSizeLimitMiddleware('100');
    const req = createMockReq({ headers: { 'content-length': '200' } as Record<string, string> });
    const res = createMockRes();
    const next = vi.fn();

    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(413);
  });
});
