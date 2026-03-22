/**
 * Tests for session auth route (POST /v1/session/auth).
 *
 * Mocks the renderer and wall-detector — no real browser needed.
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import http from 'http';
import express, { type Router } from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockWithPage,
  mockDetectChallengePage,
} = vi.hoisted(() => ({
  mockWithPage: vi.fn(),
  mockDetectChallengePage: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config/env', () => ({
  config: {
    rendering: { enabled: true },
  },
}));

vi.mock('../../services/renderer', () => ({
  rendererManager: { withPage: mockWithPage },
}));

vi.mock('../../core/wall-detector', () => ({
  detectChallengePage: mockDetectChallengePage,
}));

vi.mock('../../utils/error', () => ({
  extractErrorMessage: (e: unknown) => (e as Error).message ?? String(e),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { sessionAuthRouter } from '../../api/routes/session-auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestApp {
  server: http.Server;
  baseUrl: string;
  close: () => Promise<void>;
}

async function createTestApp(path: string, router: Router): Promise<TestApp> {
  const app = express();
  app.use(express.json());
  app.use(path, router);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session auth route (POST /v1/session/auth)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp('/v1/session/auth', sessionAuthRouter);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectChallengePage.mockReturnValue(null);

    // Default withPage: invoke handler, return mock cookies
    mockWithPage.mockImplementation(async (handler: Function) => ({
      result: await handler(
        {
          goto: vi.fn().mockResolvedValue({ status: () => 200 }),
          content: vi.fn().mockResolvedValue('<html>OK</html>'),
          waitForSelector: vi.fn().mockResolvedValue(null),
          waitForNavigation: vi.fn().mockResolvedValue(null),
        },
        {
          cookies: vi.fn().mockResolvedValue([
            { name: 'sessionKey', value: 'sk-test', domain: '.claude.ai', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
            { name: 'cf_clearance', value: 'cf-abc123', domain: '.claude.ai', path: '/', expires: 1700000000, httpOnly: true, secure: true, sameSite: 'None' },
          ]),
        }
      ),
      status: { launched: true },
    }));
  });

  it('returns 400 when domain is missing', async () => {
    const res = await fetch(`${app.baseUrl}/v1/session/auth/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://claude.ai' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid request');
  });

  it('returns 400 when url is missing', async () => {
    const res = await fetch(`${app.baseUrl}/v1/session/auth/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'claude.ai' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns cookies from Playwright session', async () => {
    const res = await fetch(`${app.baseUrl}/v1/session/auth/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: 'claude.ai',
        url: 'https://claude.ai',
        cookies: [{ name: 'sessionKey', value: 'sk-test', domain: '.claude.ai' }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.rendered).toBe(true);
    expect(body.cookies.length).toBe(2);

    const cfCookie = body.cookies.find((c: { name: string }) => c.name === 'cf_clearance');
    expect(cfCookie).toBeTruthy();
    expect(cfCookie.value).toBe('cf-abc123');
  });

  it('reports challenge detected when wall-detector fires', async () => {
    mockDetectChallengePage.mockReturnValue({ reason: 'cloudflare challenge', pattern: 'verify you are human' });

    const res = await fetch(`${app.baseUrl}/v1/session/auth/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: 'claude.ai',
        url: 'https://claude.ai',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.challengeDetected).toBe(true);
  });

  it('falls back gracefully when renderer throws', async () => {
    mockWithPage.mockRejectedValue(new Error('renderer unavailable'));

    const res = await fetch(`${app.baseUrl}/v1/session/auth/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: 'claude.ai',
        url: 'https://claude.ai',
        cookies: [{ name: 'sessionKey', value: 'sk-test', domain: '.claude.ai' }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.rendered).toBe(false);
    // Returns seed cookies
    expect(body.cookies.length).toBe(1);
    expect(body.cookies[0].name).toBe('sessionKey');
  });
});
