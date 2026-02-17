/**
 * Integration tests for interact routes (/v1/interact).
 *
 * Covers POST /, POST /screenshot, POST /page-state.
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import http from 'http';
import express, { type Router } from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockWithPage,
  mockExecuteActions,
  mockGetPageState,
  mockScreenshot,
  mockDistillContent,
} = vi.hoisted(() => ({
  mockWithPage: vi.fn(),
  mockExecuteActions: vi.fn().mockResolvedValue([]),
  mockGetPageState: vi.fn().mockResolvedValue({
    url: 'https://example.com',
    title: 'Test',
    interactiveElements: [],
  }),
  mockScreenshot: vi.fn().mockResolvedValue('base64-screenshot-data'),
  mockDistillContent: vi.fn().mockResolvedValue({
    contentText: 'distilled content',
    title: 'Test Page',
  }),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config/env', () => ({
  config: {
    rendering: { enabled: false },
  },
}));

vi.mock('../../services/renderer', () => ({
  rendererManager: { withPage: mockWithPage },
}));

vi.mock('../../services/interaction-manager', () => ({
  interactionManager: {
    executeActions: mockExecuteActions,
    getPageState: mockGetPageState,
    screenshot: mockScreenshot,
  },
}));

vi.mock('../../services/distiller', () => ({
  distillContent: mockDistillContent,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { interactRouter } from '../../api/routes/interact';
import { errorHandler } from '../../middleware/error-handler';

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
  app.use(errorHandler);

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

describe('Interact routes (/v1/interact)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp('/v1/interact', interactRouter);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Default withPage: invoke handler with a fake page, wrap result
    mockWithPage.mockImplementation(async (handler: (page: unknown) => Promise<unknown>) => {
      const fakePage = {
        goto: vi.fn().mockResolvedValue(undefined),
        content: vi.fn().mockResolvedValue('<html><body>test</body></html>'),
        url: vi.fn().mockReturnValue('https://example.com'),
        title: vi.fn().mockResolvedValue('Test Page'),
      };
      const result = await handler(fakePage);
      return { result, status: {} };
    });

    mockDistillContent.mockResolvedValue({
      contentText: 'distilled content',
      title: 'Test Page',
    });
  });

  // ---- POST /v1/interact ----

  describe('POST /v1/interact', () => {
    it('returns 400 when url is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when url is invalid', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'not-a-url' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 with invalid action type', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          actions: [{ type: 'invalidAction' }],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 200 with action results and page state', async () => {
      mockExecuteActions.mockResolvedValue([{ type: 'click', success: true }]);

      const res = await fetch(`${app.baseUrl}/v1/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          actions: [{ type: 'click', selector: '#btn' }],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.results).toHaveLength(1);
      expect(body.pageState).toBeDefined();
      expect(typeof body.totalDuration).toBe('number');
    });

    it('returns empty results when no actions provided', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.results).toEqual([]);
    });

    it('returns extraction when extract=true', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', extract: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.extraction).toBeDefined();
      expect(body.extraction.contentText).toBe('distilled content');
    });

    it('returns extraction error object when distiller fails', async () => {
      mockDistillContent.mockRejectedValueOnce(new Error('distill failed'));

      const res = await fetch(`${app.baseUrl}/v1/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', extract: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.extraction).toEqual({ error: 'distill failed' });
    });

    it('does not extract when extract is false (default)', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      const body = await res.json();
      expect(body.extraction).toBeNull();
      expect(mockDistillContent).not.toHaveBeenCalled();
    });
  });

  // ---- POST /v1/interact/screenshot ----

  describe('POST /v1/interact/screenshot', () => {
    it('returns 400 when url is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 200 with base64 screenshot', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.screenshot).toBe('base64-screenshot-data');
      expect(body.pageState.url).toBe('https://example.com');
      expect(body.pageState.title).toBe('Test Page');
    });

    it('passes fullPage option to screenshot', async () => {
      await fetch(`${app.baseUrl}/v1/interact/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', fullPage: true }),
      });

      expect(mockScreenshot).toHaveBeenCalledWith(expect.anything(), { fullPage: true });
    });

    it('executes preparatory actions before screenshot', async () => {
      await fetch(`${app.baseUrl}/v1/interact/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          actions: [{ type: 'click', selector: '#dismiss' }],
        }),
      });

      expect(mockExecuteActions).toHaveBeenCalled();
    });
  });

  // ---- POST /v1/interact/page-state ----

  describe('POST /v1/interact/page-state', () => {
    it('returns 400 when url is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact/page-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 200 with page state', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact/page-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.pageState).toBeDefined();
    });

    it('executes actions before getting page state', async () => {
      await fetch(`${app.baseUrl}/v1/interact/page-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          actions: [{ type: 'scroll', direction: 'down' }],
        }),
      });

      expect(mockExecuteActions).toHaveBeenCalled();
    });
  });
});
