import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/env';
import { authMiddleware, hashApiKey } from '../middleware/auth';
import { ErrorCode } from '../middleware/error-handler';

// Save original config values
let originalAuth: typeof config.auth;
let originalNodeEnv: string | undefined;

beforeEach(() => {
  originalAuth = { ...config.auth, apiKeys: [...config.auth.apiKeys] };
  originalNodeEnv = process.env.NODE_ENV;
});

afterEach(() => {
  config.auth.enabled = originalAuth.enabled;
  config.auth.apiKeys = originalAuth.apiKeys;
  config.auth.rateLimitPerKey = originalAuth.rateLimitPerKey;
  config.auth.bypassInDev = originalAuth.bypassInDev;
  process.env.NODE_ENV = originalNodeEnv;
});

function createMockReq(headers: Record<string, string> = {}): Request {
  const req = {
    headers: {} as Record<string, string | undefined>,
    get: (name: string) => {
      return req.headers[name.toLowerCase()] as string | undefined;
    },
    tenant: undefined,
  } as unknown as Request;

  for (const [key, value] of Object.entries(headers)) {
    req.headers[key.toLowerCase()] = value;
  }

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

describe('authMiddleware', () => {
  it('passes through when auth is disabled', () => {
    config.auth.enabled = false;

    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.tenant).toEqual({
      id: 'default',
      authenticated: false,
    });
  });

  it('passes through in dev mode with bypassInDev=true', () => {
    config.auth.enabled = true;
    config.auth.bypassInDev = true;
    config.auth.apiKeys = ['test-key-123'];
    process.env.NODE_ENV = 'development';

    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.tenant).toEqual({
      id: 'default',
      authenticated: false,
    });
  });

  it('does not bypass in production even with bypassInDev=true', () => {
    config.auth.enabled = true;
    config.auth.bypassInDev = true;
    config.auth.apiKeys = ['test-key-123'];
    process.env.NODE_ENV = 'production';

    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    // Should call next with an error (401 for missing key)
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.UNAUTHORIZED,
        statusCode: 401,
      })
    );
  });

  it('returns 401 for missing API key when auth is enabled', () => {
    config.auth.enabled = true;
    config.auth.bypassInDev = false;
    config.auth.apiKeys = ['test-key-123'];

    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.UNAUTHORIZED,
        statusCode: 401,
        message: expect.stringContaining('Missing API key'),
      })
    );
  });

  it('returns 401 for invalid API key', () => {
    config.auth.enabled = true;
    config.auth.bypassInDev = false;
    config.auth.apiKeys = ['valid-key-123'];

    const req = createMockReq({ 'x-api-key': 'wrong-key' });
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.UNAUTHORIZED,
        statusCode: 401,
        message: expect.stringContaining('Invalid API key'),
      })
    );
  });

  it('passes through for valid API key and attaches tenant info', () => {
    config.auth.enabled = true;
    config.auth.bypassInDev = false;
    config.auth.apiKeys = ['valid-key-123'];

    const req = createMockReq({ 'x-api-key': 'valid-key-123' });
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.tenant).toBeDefined();
    expect(req.tenant!.authenticated).toBe(true);
    expect(req.tenant!.id).toBe(hashApiKey('valid-key-123'));
  });

  it('attaches tenant info with hashed key as ID', () => {
    config.auth.enabled = true;
    config.auth.bypassInDev = false;
    config.auth.apiKeys = ['my-secret-key'];

    const req = createMockReq({ 'x-api-key': 'my-secret-key' });
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    expect(req.tenant).toEqual({
      id: hashApiKey('my-secret-key'),
      authenticated: true,
    });
    // Ensure the tenant ID is a hex hash, not the raw key
    expect(req.tenant!.id).toMatch(/^[a-f0-9]{64}$/);
    expect(req.tenant!.id).not.toBe('my-secret-key');
  });

  it('accepts key from Authorization: Bearer header', () => {
    config.auth.enabled = true;
    config.auth.bypassInDev = false;
    config.auth.apiKeys = ['bearer-test-key'];

    const req = createMockReq({ authorization: 'Bearer bearer-test-key' });
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.tenant).toBeDefined();
    expect(req.tenant!.authenticated).toBe(true);
    expect(req.tenant!.id).toBe(hashApiKey('bearer-test-key'));
  });

  it('accepts key from x-api-key header', () => {
    config.auth.enabled = true;
    config.auth.bypassInDev = false;
    config.auth.apiKeys = ['x-header-test-key'];

    const req = createMockReq({ 'x-api-key': 'x-header-test-key' });
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.tenant).toBeDefined();
    expect(req.tenant!.authenticated).toBe(true);
    expect(req.tenant!.id).toBe(hashApiKey('x-header-test-key'));
  });

  it('prefers Authorization: Bearer over x-api-key header', () => {
    config.auth.enabled = true;
    config.auth.bypassInDev = false;
    config.auth.apiKeys = ['bearer-key', 'x-api-key-value'];

    const req = createMockReq({
      authorization: 'Bearer bearer-key',
      'x-api-key': 'x-api-key-value',
    });
    const res = createMockRes();
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.tenant!.id).toBe(hashApiKey('bearer-key'));
  });
});
