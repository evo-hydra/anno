/**
 * Integration tests for watch routes (/v1/watch).
 *
 * Covers POST /, GET /, GET /:watchId, DELETE /:watchId,
 * PUT /:watchId/pause, PUT /:watchId/resume,
 * GET /:watchId/events, GET /:watchId/history.
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import http from 'http';
import express, { type Router } from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockAddWatch,
  mockListWatches,
  mockGetWatch,
  mockRemoveWatch,
  mockPauseWatch,
  mockResumeWatch,
  mockGetEvents,
  mockGetHistory,
} = vi.hoisted(() => ({
  mockAddWatch: vi.fn(),
  mockListWatches: vi.fn().mockReturnValue([]),
  mockGetWatch: vi.fn().mockReturnValue(null),
  mockRemoveWatch: vi.fn().mockResolvedValue(false),
  mockPauseWatch: vi.fn().mockResolvedValue(null),
  mockResumeWatch: vi.fn().mockResolvedValue(null),
  mockGetEvents: vi.fn().mockResolvedValue([]),
  mockGetHistory: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../services/watch-manager', () => ({
  watchManager: {
    addWatch: mockAddWatch,
    listWatches: mockListWatches,
    getWatch: mockGetWatch,
    removeWatch: mockRemoveWatch,
    pauseWatch: mockPauseWatch,
    resumeWatch: mockResumeWatch,
    getEvents: mockGetEvents,
  },
}));

vi.mock('../../services/diff-engine', () => ({
  diffEngine: {
    getHistory: mockGetHistory,
  },
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

import { watchRouter } from '../../api/routes/watch';
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

describe('Watch routes (/v1/watch)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp('/v1/watch', watchRouter);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockListWatches.mockReturnValue([]);
    mockGetWatch.mockReturnValue(null);
    mockRemoveWatch.mockResolvedValue(false);
    mockPauseWatch.mockResolvedValue(null);
    mockResumeWatch.mockResolvedValue(null);
    mockGetEvents.mockResolvedValue([]);
  });

  // ---- POST /v1/watch ----

  describe('POST /v1/watch', () => {
    it('returns 400 when url is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when url is invalid', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'not-a-url' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when interval is below minimum (60)', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', interval: 10 }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 201 with watch for valid request', async () => {
      const fakeWatch = {
        id: 'watch-1',
        url: 'https://example.com',
        interval: 3600,
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      mockAddWatch.mockResolvedValue(fakeWatch);

      const res = await fetch(`${app.baseUrl}/v1/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe('watch-1');
      expect(body.url).toBe('https://example.com');
      expect(body.status).toBe('active');
    });

    it('returns 500 when addWatch throws', async () => {
      mockAddWatch.mockRejectedValue(new Error('disk full'));

      const res = await fetch(`${app.baseUrl}/v1/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('watch_creation_failed');
      expect(body.message).toBe('disk full');
    });
  });

  // ---- GET /v1/watch ----

  describe('GET /v1/watch', () => {
    it('returns empty watches and total=0', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.watches).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns watches when they exist', async () => {
      mockListWatches.mockReturnValue([
        { id: 'w1', url: 'https://a.com', status: 'active' },
        { id: 'w2', url: 'https://b.com', status: 'paused' },
      ]);

      const res = await fetch(`${app.baseUrl}/v1/watch`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.watches).toHaveLength(2);
      expect(body.total).toBe(2);
    });
  });

  // ---- GET /v1/watch/:watchId ----

  describe('GET /v1/watch/:watchId', () => {
    it('returns 404 for unknown watch', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch/nonexistent`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('watch_not_found');
    });

    it('returns watch with recent events', async () => {
      mockGetWatch.mockReturnValue({ id: 'w1', url: 'https://example.com', status: 'active' });
      mockGetEvents.mockResolvedValue([{ watchId: 'w1', changePercent: 5 }]);

      const res = await fetch(`${app.baseUrl}/v1/watch/w1`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.watch.id).toBe('w1');
      expect(body.recentEvents).toHaveLength(1);
    });

    it('returns empty events when getEvents fails', async () => {
      mockGetWatch.mockReturnValue({ id: 'w1', url: 'https://example.com', status: 'active' });
      mockGetEvents.mockRejectedValue(new Error('read error'));

      const res = await fetch(`${app.baseUrl}/v1/watch/w1`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.watch.id).toBe('w1');
      expect(body.recentEvents).toEqual([]);
    });
  });

  // ---- DELETE /v1/watch/:watchId ----

  describe('DELETE /v1/watch/:watchId', () => {
    it('returns 404 when watch not found', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch/nonexistent`, { method: 'DELETE' });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('watch_not_found');
    });

    it('returns 200 when watch is removed', async () => {
      mockRemoveWatch.mockResolvedValue(true);

      const res = await fetch(`${app.baseUrl}/v1/watch/w1`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('removed');
      expect(body.watchId).toBe('w1');
    });
  });

  // ---- PUT /v1/watch/:watchId/pause ----

  describe('PUT /v1/watch/:watchId/pause', () => {
    it('returns 404 when watch not found', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch/nonexistent/pause`, { method: 'PUT' });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('watch_not_found');
    });

    it('returns 200 with paused watch', async () => {
      mockPauseWatch.mockResolvedValue({ id: 'w1', url: 'https://example.com', status: 'paused' });

      const res = await fetch(`${app.baseUrl}/v1/watch/w1/pause`, { method: 'PUT' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('paused');
    });
  });

  // ---- PUT /v1/watch/:watchId/resume ----

  describe('PUT /v1/watch/:watchId/resume', () => {
    it('returns 404 when watch not found', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch/nonexistent/resume`, { method: 'PUT' });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('watch_not_found');
    });

    it('returns 200 with resumed watch', async () => {
      mockResumeWatch.mockResolvedValue({
        id: 'w1',
        url: 'https://example.com',
        status: 'active',
      });

      const res = await fetch(`${app.baseUrl}/v1/watch/w1/resume`, { method: 'PUT' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('active');
    });
  });

  // ---- GET /v1/watch/:watchId/events ----

  describe('GET /v1/watch/:watchId/events', () => {
    it('returns 404 when watch not found', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch/nonexistent/events`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('watch_not_found');
    });

    it('returns 200 with events and total', async () => {
      mockGetWatch.mockReturnValue({ id: 'w1', url: 'https://example.com' });
      mockGetEvents.mockResolvedValue([
        { watchId: 'w1', changePercent: 10 },
        { watchId: 'w1', changePercent: 5 },
      ]);

      const res = await fetch(`${app.baseUrl}/v1/watch/w1/events`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.watchId).toBe('w1');
      expect(body.events).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it('respects limit query parameter', async () => {
      mockGetWatch.mockReturnValue({ id: 'w1', url: 'https://example.com' });
      mockGetEvents.mockResolvedValue([]);

      await fetch(`${app.baseUrl}/v1/watch/w1/events?limit=10`);

      expect(mockGetEvents).toHaveBeenCalledWith('w1', 10);
    });

    it('returns 500 when getEvents throws', async () => {
      mockGetWatch.mockReturnValue({ id: 'w1', url: 'https://example.com' });
      mockGetEvents.mockRejectedValue(new Error('storage error'));

      const res = await fetch(`${app.baseUrl}/v1/watch/w1/events`);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('events_retrieval_failed');
    });
  });

  // ---- GET /v1/watch/:watchId/history ----

  describe('GET /v1/watch/:watchId/history', () => {
    it('returns 404 when watch not found', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch/nonexistent/history`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('watch_not_found');
    });

    it('returns 200 with history', async () => {
      mockGetWatch.mockReturnValue({ id: 'w1', url: 'https://example.com' });
      mockGetHistory.mockResolvedValue([{ timestamp: '2025-01-01', changePercent: 15 }]);

      const res = await fetch(`${app.baseUrl}/v1/watch/w1/history`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.watchId).toBe('w1');
      expect(body.url).toBe('https://example.com');
      expect(body.history).toHaveLength(1);
    });

    it('returns 500 when getHistory throws', async () => {
      mockGetWatch.mockReturnValue({ id: 'w1', url: 'https://example.com' });
      mockGetHistory.mockRejectedValue(new Error('history storage error'));

      const res = await fetch(`${app.baseUrl}/v1/watch/w1/history`);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('history_retrieval_failed');
    });
  });
});
