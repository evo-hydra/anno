import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/env';
import { rateLimitPerTenantMiddleware, resetTenantWindows } from '../middleware/rate-limit-per-tenant';
import { ErrorCode } from '../middleware/error-handler';

let originalAuth: typeof config.auth;

beforeEach(() => {
  originalAuth = { ...config.auth, apiKeys: [...config.auth.apiKeys] };
  resetTenantWindows();
});

afterEach(() => {
  config.auth.enabled = originalAuth.enabled;
  config.auth.apiKeys = originalAuth.apiKeys;
  config.auth.rateLimitPerKey = originalAuth.rateLimitPerKey;
  config.auth.bypassInDev = originalAuth.bypassInDev;
  vi.useRealTimers();
});

function createMockReq(tenantId?: string): Request {
  const req = {
    headers: {},
    get: (name: string) => req.headers[name.toLowerCase()],
    tenant: tenantId ? { id: tenantId, authenticated: true } : undefined,
  } as unknown as Request;
  return req;
}

function createMockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe('rateLimitPerTenantMiddleware', () => {
  it('allows requests under the limit', () => {
    config.auth.enabled = true;
    config.auth.rateLimitPerKey = 5;

    const _req = createMockReq('tenant-a');
    const _res = createMockRes();
    const _next = vi.fn() as NextFunction;

    // Make 5 requests (at the limit)
    for (let i = 0; i < 5; i++) {
      const r = createMockReq('tenant-a');
      const s = createMockRes();
      const n = vi.fn() as NextFunction;
      rateLimitPerTenantMiddleware(r, s, n);
      expect(n).toHaveBeenCalledWith();
    }
  });

  it('blocks requests over the limit with 429', () => {
    config.auth.enabled = true;
    config.auth.rateLimitPerKey = 3;

    // Make 3 requests (at the limit)
    for (let i = 0; i < 3; i++) {
      const req = createMockReq('tenant-b');
      const res = createMockRes();
      const next = vi.fn() as NextFunction;
      rateLimitPerTenantMiddleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
    }

    // 4th request should be blocked
    const req = createMockReq('tenant-b');
    const res = createMockRes();
    const next = vi.fn() as NextFunction;
    rateLimitPerTenantMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.RATE_LIMIT_EXCEEDED,
        statusCode: 429,
      })
    );
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('tracks limits per tenant independently', () => {
    config.auth.enabled = true;
    config.auth.rateLimitPerKey = 2;

    // Tenant A: make 2 requests
    for (let i = 0; i < 2; i++) {
      const req = createMockReq('tenant-a');
      const res = createMockRes();
      const next = vi.fn() as NextFunction;
      rateLimitPerTenantMiddleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
    }

    // Tenant A: 3rd request should be blocked
    const reqA = createMockReq('tenant-a');
    const resA = createMockRes();
    const nextA = vi.fn() as NextFunction;
    rateLimitPerTenantMiddleware(reqA, resA, nextA);
    expect(nextA).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.RATE_LIMIT_EXCEEDED,
      })
    );

    // Tenant B: should still be allowed (independent tracking)
    const reqB = createMockReq('tenant-b');
    const resB = createMockRes();
    const nextB = vi.fn() as NextFunction;
    rateLimitPerTenantMiddleware(reqB, resB, nextB);
    expect(nextB).toHaveBeenCalledWith();
  });

  it('resets after window expires', () => {
    vi.useFakeTimers();
    config.auth.enabled = true;
    config.auth.rateLimitPerKey = 2;

    // Make 2 requests (at the limit)
    for (let i = 0; i < 2; i++) {
      const req = createMockReq('tenant-c');
      const res = createMockRes();
      const next = vi.fn() as NextFunction;
      rateLimitPerTenantMiddleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
    }

    // 3rd request should be blocked
    const reqBlocked = createMockReq('tenant-c');
    const resBlocked = createMockRes();
    const nextBlocked = vi.fn() as NextFunction;
    rateLimitPerTenantMiddleware(reqBlocked, resBlocked, nextBlocked);
    expect(nextBlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.RATE_LIMIT_EXCEEDED,
      })
    );

    // Advance time by 61 seconds (past the 1-minute window)
    vi.advanceTimersByTime(61_000);

    // Now requests should be allowed again
    const reqAfter = createMockReq('tenant-c');
    const resAfter = createMockRes();
    const nextAfter = vi.fn() as NextFunction;
    rateLimitPerTenantMiddleware(reqAfter, resAfter, nextAfter);
    expect(nextAfter).toHaveBeenCalledWith();
  });

  it('skips when auth is disabled', () => {
    config.auth.enabled = false;
    config.auth.rateLimitPerKey = 1;

    // Even though limit is 1, auth is disabled so rate limiting should be skipped
    for (let i = 0; i < 10; i++) {
      const req = createMockReq('tenant-d');
      const res = createMockRes();
      const next = vi.fn() as NextFunction;
      rateLimitPerTenantMiddleware(req, res, next);
      expect(next).toHaveBeenCalledWith();
    }
  });

  it('skips when no tenant is attached', () => {
    config.auth.enabled = true;
    config.auth.rateLimitPerKey = 1;

    // Request without tenant should pass through
    const req = createMockReq(); // no tenant ID
    const res = createMockRes();
    const next = vi.fn() as NextFunction;
    rateLimitPerTenantMiddleware(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });
});
