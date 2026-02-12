import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { createRateLimitMiddleware, getRateLimitConfigFromEnv } from '../middleware/rate-limit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
    RATE_LIMIT_MAX_REQUESTS: process.env.RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_WINDOW_MS: process.env.RATE_LIMIT_WINDOW_MS,
  };
  vi.useFakeTimers();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.useRealTimers();
});

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    ip: '192.168.1.1',
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// getRateLimitConfigFromEnv
// ---------------------------------------------------------------------------

describe('getRateLimitConfigFromEnv', () => {
  it('returns defaults when no env vars are set', () => {
    delete process.env.RATE_LIMIT_ENABLED;
    delete process.env.RATE_LIMIT_MAX_REQUESTS;
    delete process.env.RATE_LIMIT_WINDOW_MS;

    const cfg = getRateLimitConfigFromEnv();

    expect(cfg.enabled).toBe(false);
    expect(cfg.maxRequests).toBe(100);
    expect(cfg.windowMs).toBe(60000);
    expect(cfg.keyByApiKey).toBe(true);
    expect(cfg.keyByIp).toBe(true);
  });

  it('enables rate limiting when RATE_LIMIT_ENABLED=true', () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    const cfg = getRateLimitConfigFromEnv();
    expect(cfg.enabled).toBe(true);
  });

  it('parses custom maxRequests and windowMs', () => {
    process.env.RATE_LIMIT_MAX_REQUESTS = '50';
    process.env.RATE_LIMIT_WINDOW_MS = '30000';

    const cfg = getRateLimitConfigFromEnv();
    expect(cfg.maxRequests).toBe(50);
    expect(cfg.windowMs).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// createRateLimitMiddleware — disabled
// ---------------------------------------------------------------------------

describe('createRateLimitMiddleware (disabled)', () => {
  it('calls next() immediately when disabled', () => {
    const mw = createRateLimitMiddleware({
      enabled: false,
      maxRequests: 10,
      windowMs: 60000,
    });

    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createRateLimitMiddleware — enabled, key selection
// ---------------------------------------------------------------------------

describe('createRateLimitMiddleware (key selection)', () => {
  it('uses API key hash when available and keyByApiKey=true', () => {
    const mw = createRateLimitMiddleware({
      enabled: true,
      maxRequests: 100,
      windowMs: 60000,
      keyByApiKey: true,
      keyByIp: true,
    });

    const req = createMockReq() as AuthenticatedRequest;
    req.apiKeyHash = 'abc123hash';
    const res = createMockRes();
    const next = vi.fn();

    mw(req as unknown as Request, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '100');
  });

  it('falls back to IP when no API key', () => {
    const mw = createRateLimitMiddleware({
      enabled: true,
      maxRequests: 100,
      windowMs: 60000,
      keyByApiKey: true,
      keyByIp: true,
    });

    const req = createMockReq({ ip: '10.0.0.1' });
    const res = createMockRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '100');
  });

  it('uses x-forwarded-for header for IP', () => {
    const mw = createRateLimitMiddleware({
      enabled: true,
      maxRequests: 100,
      windowMs: 60000,
      keyByApiKey: false,
      keyByIp: true,
    });

    const req = createMockReq({
      headers: { 'x-forwarded-for': '203.0.113.1, 70.41.3.18' } as Record<string, string>,
      ip: '127.0.0.1',
    });
    const res = createMockRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('uses "global" key when both keyByApiKey and keyByIp are false', () => {
    const mw = createRateLimitMiddleware({
      enabled: true,
      maxRequests: 100,
      windowMs: 60000,
      keyByApiKey: false,
      keyByIp: false,
    });

    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn();

    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createRateLimitMiddleware — rate limit headers
// ---------------------------------------------------------------------------

describe('createRateLimitMiddleware (headers)', () => {
  it('sets rate limit headers on every request', () => {
    const mw = createRateLimitMiddleware({
      enabled: true,
      maxRequests: 50,
      windowMs: 60000,
    });

    const req = createMockReq({ ip: '1.2.3.4' });
    const res = createMockRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '50');
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(String));
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// createRateLimitMiddleware — token bucket behavior
// ---------------------------------------------------------------------------

describe('createRateLimitMiddleware (token bucket)', () => {
  it('allows requests within the limit', () => {
    const mw = createRateLimitMiddleware({
      enabled: true,
      maxRequests: 5,
      windowMs: 60000,
    });

    for (let i = 0; i < 5; i++) {
      const req = createMockReq({ ip: '10.10.10.10' });
      const res = createMockRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalled();
    }
  });

  it('returns 429 when rate limit is exceeded', () => {
    const mw = createRateLimitMiddleware({
      enabled: true,
      maxRequests: 3,
      windowMs: 60000,
    });

    // Consume all 3 tokens
    for (let i = 0; i < 3; i++) {
      const req = createMockReq({ ip: '10.10.10.10' });
      const res = createMockRes();
      const next = vi.fn();
      mw(req, res, next);
    }

    // 4th request should be rate limited
    const req = createMockReq({ ip: '10.10.10.10' });
    const res = createMockRes();
    const next = vi.fn();
    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Rate limit exceeded',
        retryAfter: expect.any(Number),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('uses custom message when rate limited', () => {
    const mw = createRateLimitMiddleware({
      enabled: true,
      maxRequests: 1,
      windowMs: 60000,
      message: 'Slow down there partner!',
    });

    // Consume the 1 token
    const req1 = createMockReq({ ip: '5.5.5.5' });
    const res1 = createMockRes();
    mw(req1, res1, vi.fn());

    // 2nd request triggers limit
    const req2 = createMockReq({ ip: '5.5.5.5' });
    const res2 = createMockRes();
    const next2 = vi.fn();
    mw(req2, res2, next2);

    expect(res2.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Slow down there partner!' })
    );
  });

  it('refills tokens after time passes', () => {
    const mw = createRateLimitMiddleware({
      enabled: true,
      maxRequests: 2,
      windowMs: 10000,
    });

    // Consume both tokens
    for (let i = 0; i < 2; i++) {
      const req = createMockReq({ ip: '20.20.20.20' });
      const res = createMockRes();
      mw(req, res, vi.fn());
    }

    // Should be rate limited
    const req3 = createMockReq({ ip: '20.20.20.20' });
    const res3 = createMockRes();
    const next3 = vi.fn();
    mw(req3, res3, next3);
    expect(next3).not.toHaveBeenCalled();

    // Advance time to allow token refill (full window)
    vi.advanceTimersByTime(10000);

    const req4 = createMockReq({ ip: '20.20.20.20' });
    const res4 = createMockRes();
    const next4 = vi.fn();
    mw(req4, res4, next4);
    expect(next4).toHaveBeenCalled();
  });

  it('tracks different IPs independently', () => {
    const mw = createRateLimitMiddleware({
      enabled: true,
      maxRequests: 1,
      windowMs: 60000,
    });

    // First IP — consume its 1 token
    const req1 = createMockReq({ ip: '1.1.1.1' });
    const res1 = createMockRes();
    mw(req1, res1, vi.fn());

    // Second IP — should still have its token
    const req2 = createMockReq({ ip: '2.2.2.2' });
    const res2 = createMockRes();
    const next2 = vi.fn();
    mw(req2, res2, next2);
    expect(next2).toHaveBeenCalled();

    // First IP — should be rate limited
    const req3 = createMockReq({ ip: '1.1.1.1' });
    const res3 = createMockRes();
    const next3 = vi.fn();
    mw(req3, res3, next3);
    expect(next3).not.toHaveBeenCalled();
  });

  it('handles "unknown" IP when req.ip is undefined', () => {
    const mw = createRateLimitMiddleware({
      enabled: true,
      maxRequests: 100,
      windowMs: 60000,
      keyByIp: true,
      keyByApiKey: false,
    });

    const req = createMockReq({ ip: undefined });
    const res = createMockRes();
    const next = vi.fn();

    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
