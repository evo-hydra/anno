/**
 * Integration tests for jobs routes (/v1/jobs).
 *
 * Covers POST /, GET /, GET /:jobId, DELETE /:jobId, GET /:jobId/stream.
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import http from 'http';
import express, { type Router } from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockQueue = vi.hoisted(() => ({
  enqueue: vi.fn().mockReturnValue('test-job-id'),
  getJob: vi.fn().mockResolvedValue(undefined),
  listJobs: vi.fn().mockResolvedValue([]),
  cancel: vi.fn().mockReturnValue(false),
  getStats: vi.fn().mockReturnValue({ queued: 0, running: 0, total: 0, handlers: [] }),
  streamProgress: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../services/job-queue', () => ({
  getJobQueue: vi.fn(() => mockQueue),
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

import { jobsRouter } from '../../api/routes/jobs';
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

describe('Jobs routes (/v1/jobs)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp('/v1/jobs', jobsRouter);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset to defaults
    mockQueue.enqueue.mockReturnValue('test-job-id');
    mockQueue.getJob.mockResolvedValue(undefined);
    mockQueue.listJobs.mockResolvedValue([]);
    mockQueue.cancel.mockReturnValue(false);
    mockQueue.getStats.mockReturnValue({ queued: 0, running: 0, total: 0, handlers: [] });
  });

  // ---- POST /v1/jobs ----

  describe('POST /v1/jobs', () => {
    it('returns 400 when body is empty', async () => {
      const res = await fetch(`${app.baseUrl}/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when type is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: {} }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when type is invalid', async () => {
      const res = await fetch(`${app.baseUrl}/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'invalid_type', payload: {} }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when options.priority is out of range', async () => {
      const res = await fetch(`${app.baseUrl}/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'fetch',
          payload: {},
          options: { priority: 100 },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 202 with jobId for valid request', async () => {
      const res = await fetch(`${app.baseUrl}/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'fetch', payload: { url: 'https://example.com' } }),
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.jobId).toBe('test-job-id');
      expect(body.status).toBe('queued');
    });

    it('passes type, payload, and options to queue.enqueue', async () => {
      await fetch(`${app.baseUrl}/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'crawl',
          payload: { startUrl: 'https://example.com' },
          options: { priority: 8 },
        }),
      });

      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        'crawl',
        { startUrl: 'https://example.com' },
        expect.objectContaining({ priority: 8 }),
      );
    });
  });

  // ---- GET /v1/jobs ----

  describe('GET /v1/jobs', () => {
    it('returns job list with stats', async () => {
      mockQueue.listJobs.mockResolvedValue([
        { id: 'j1', type: 'fetch', status: 'completed' },
        { id: 'j2', type: 'crawl', status: 'running' },
      ]);
      mockQueue.getStats.mockReturnValue({ queued: 0, running: 1, total: 2, handlers: [] });

      const res = await fetch(`${app.baseUrl}/v1/jobs`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobs).toHaveLength(2);
      expect(body.count).toBe(2);
      expect(body.stats.total).toBe(2);
    });

    it('returns empty list when no jobs exist', async () => {
      const res = await fetch(`${app.baseUrl}/v1/jobs`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobs).toHaveLength(0);
      expect(body.count).toBe(0);
    });

    it('filters by ?status= query parameter', async () => {
      mockQueue.listJobs.mockResolvedValue([
        { id: 'j1', type: 'fetch', status: 'completed' },
      ]);

      await fetch(`${app.baseUrl}/v1/jobs?status=completed`);

      expect(mockQueue.listJobs).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('filters by ?type= query parameter', async () => {
      mockQueue.listJobs.mockResolvedValue([]);

      await fetch(`${app.baseUrl}/v1/jobs?type=crawl`);

      expect(mockQueue.listJobs).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'crawl' }),
      );
    });

    it('ignores invalid status filter', async () => {
      await fetch(`${app.baseUrl}/v1/jobs?status=invalid`);

      expect(mockQueue.listJobs).toHaveBeenCalledWith(undefined);
    });
  });

  // ---- GET /v1/jobs/:jobId ----

  describe('GET /v1/jobs/:jobId', () => {
    it('returns 404 for unknown job id', async () => {
      const res = await fetch(`${app.baseUrl}/v1/jobs/unknown-id`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('job_not_found');
      expect(body.message).toContain('unknown-id');
    });

    it('returns 200 with job details when found', async () => {
      const fakeJob = {
        id: 'found-job',
        type: 'fetch',
        status: 'completed',
        payload: {},
        progress: 100,
      };
      mockQueue.getJob.mockResolvedValue(fakeJob);

      const res = await fetch(`${app.baseUrl}/v1/jobs/found-job`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('found-job');
      expect(body.status).toBe('completed');
    });
  });

  // ---- DELETE /v1/jobs/:jobId ----

  describe('DELETE /v1/jobs/:jobId', () => {
    it('returns 404 for unknown job id', async () => {
      const res = await fetch(`${app.baseUrl}/v1/jobs/nonexistent`, { method: 'DELETE' });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('job_not_found');
    });

    it('returns 409 for non-cancellable job', async () => {
      mockQueue.getJob.mockResolvedValue({
        id: 'done-job',
        type: 'fetch',
        status: 'completed',
      });
      mockQueue.cancel.mockReturnValue(false);

      const res = await fetch(`${app.baseUrl}/v1/jobs/done-job`, { method: 'DELETE' });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('cannot_cancel');
    });

    it('returns 200 when job is cancelled', async () => {
      mockQueue.getJob.mockResolvedValue({
        id: 'cancel-me',
        type: 'fetch',
        status: 'queued',
      });
      mockQueue.cancel.mockReturnValue(true);

      const res = await fetch(`${app.baseUrl}/v1/jobs/cancel-me`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobId).toBe('cancel-me');
      expect(body.status).toBe('cancelled');
    });
  });

  // ---- GET /v1/jobs/:jobId/stream ----

  describe('GET /v1/jobs/:jobId/stream', () => {
    it('returns 404 for unknown job', async () => {
      const res = await fetch(`${app.baseUrl}/v1/jobs/unknown/stream`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('job_not_found');
    });

    it('returns SSE events for known job', async () => {
      mockQueue.getJob.mockResolvedValue({
        id: 'stream-job',
        type: 'fetch',
        status: 'running',
      });

      // Mock streamProgress as an async generator
      mockQueue.streamProgress.mockImplementation(async function* () {
        yield { event: 'progress', data: { percent: 50 } };
        yield { event: 'complete', data: { status: 'completed' } };
      });

      const res = await fetch(`${app.baseUrl}/v1/jobs/stream-job/stream`);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');

      const text = await res.text();
      expect(text).toContain(':ok');
      expect(text).toContain('event: progress');
      expect(text).toContain('event: complete');
      expect(text).toContain('"percent":50');
    });
  });
});
