/**
 * Integration tests for memory routes (/v1/memory).
 *
 * Covers GET /:sessionId, POST /:sessionId/entries, DELETE /:sessionId.
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import http from 'http';
import express, { type Router } from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockGetSession, mockAddEntry, mockClearSession } = vi.hoisted(() => ({
  mockGetSession: vi.fn().mockResolvedValue(null),
  mockAddEntry: vi.fn().mockResolvedValue(undefined),
  mockClearSession: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../services/semantic-services', () => ({
  getSemanticServices: vi.fn(() => ({
    memoryStore: {
      getSession: mockGetSession,
      addEntry: mockAddEntry,
      clearSession: mockClearSession,
    },
  })),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config/env', () => ({
  config: {
    rendering: { enabled: false },
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { memoryRouter } from '../../api/routes/memory';
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

describe('Memory routes (/v1/memory)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp('/v1/memory', memoryRouter);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(null);
  });

  // ---- GET /v1/memory/:sessionId ----

  describe('GET /v1/memory/:sessionId', () => {
    it('returns 404 when session not found', async () => {
      const res = await fetch(`${app.baseUrl}/v1/memory/unknown-session`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('not_found');
    });

    it('returns 200 with session when found', async () => {
      const fakeSession = {
        sessionId: 'sess-1',
        entries: [{ type: 'note', content: 'hello' }],
      };
      mockGetSession.mockResolvedValue(fakeSession);

      const res = await fetch(`${app.baseUrl}/v1/memory/sess-1`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessionId).toBe('sess-1');
      expect(body.entries).toHaveLength(1);
    });
  });

  // ---- POST /v1/memory/:sessionId/entries ----

  describe('POST /v1/memory/:sessionId/entries', () => {
    it('returns 400 when body is empty', async () => {
      const res = await fetch(`${app.baseUrl}/v1/memory/sess-1/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when content is empty string', async () => {
      const res = await fetch(`${app.baseUrl}/v1/memory/sess-1/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when type is invalid', async () => {
      const res = await fetch(`${app.baseUrl}/v1/memory/sess-1/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hello', type: 'invalid_type' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 202 for valid entry with default type', async () => {
      const res = await fetch(`${app.baseUrl}/v1/memory/sess-1/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Remember this fact' }),
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.status).toBe('queued');
      expect(mockAddEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          type: 'note',
          content: 'Remember this fact',
        }),
      );
    });

    it('accepts optional type and metadata', async () => {
      const res = await fetch(`${app.baseUrl}/v1/memory/sess-1/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Summary of findings',
          type: 'summary',
          metadata: { source: 'test' },
        }),
      });

      expect(res.status).toBe(202);
      expect(mockAddEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'summary',
          metadata: { source: 'test' },
        }),
      );
    });

    it('includes createdAt timestamp in entry', async () => {
      await fetch(`${app.baseUrl}/v1/memory/sess-1/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'test' }),
      });

      expect(mockAddEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          createdAt: expect.any(Number),
        }),
      );
    });
  });

  // ---- DELETE /v1/memory/:sessionId ----

  describe('DELETE /v1/memory/:sessionId', () => {
    it('returns 204 when session is cleared', async () => {
      const res = await fetch(`${app.baseUrl}/v1/memory/sess-1`, { method: 'DELETE' });

      expect(res.status).toBe(204);
      expect(mockClearSession).toHaveBeenCalledWith('sess-1');
    });
  });
});
