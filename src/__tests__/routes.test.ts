/**
 * Integration tests for Anno API route handlers.
 *
 * Strategy: mount each router on a minimal Express app, start a real HTTP
 * server on an ephemeral port, and drive it with native `fetch`. All heavy
 * dependencies (pipeline, crawler, job-queue, logger, config) are vi.mock'd
 * so tests run without Redis, Playwright, or the network.
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import http from 'http';
import express, { type Router } from 'express';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that touches these modules
// ---------------------------------------------------------------------------

vi.mock('../core/pipeline', () => ({
  runPipeline: vi.fn(),
}));

vi.mock('../services/crawler', async () => {
  const { EventEmitter } = await import('events');
  return {
    createCrawler: vi.fn(() => {
      const emitter = new EventEmitter();
      (emitter as Record<string, unknown>).crawl = vi.fn().mockResolvedValue({
        status: 'completed',
        stats: { totalPages: 0 },
      });
      return emitter;
    }),
  };
});

const mockQueue = {
  enqueue: vi.fn().mockReturnValue('test-job-id'),
  getJob: vi.fn().mockResolvedValue(undefined),
  listJobs: vi.fn().mockResolvedValue([]),
  cancel: vi.fn().mockReturnValue(false),
  getStats: vi.fn().mockReturnValue({ queued: 0, running: 0, total: 0, handlers: [] }),
  streamProgress: vi.fn(),
  init: vi.fn().mockResolvedValue(undefined),
  start: vi.fn(),
};

vi.mock('../services/job-queue', () => ({
  getJobQueue: vi.fn(() => mockQueue),
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  startSpan: vi.fn(() => ({ end: vi.fn() })),
}));

vi.mock('../config/env', () => ({
  config: {
    rendering: { enabled: false },
    fetch: { respectRobots: true },
    metrics: { allowReset: false },
    auth: { enabled: false },
    policies: { enabled: false },
    ssrf: { enabled: false, allowedHosts: [], blockedHosts: [], allowPrivateIPs: true },
    redis: { url: '' },
  },
}));

vi.mock('../core/url-validator', () => ({
  validateUrl: vi.fn().mockResolvedValue(undefined),
  validateWebhookUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/job-store', () => ({
  InMemoryJobStore: vi.fn(),
  createJobStore: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runPipeline } from '../core/pipeline';
import { contentRouter } from '../api/routes/content';
import { crawlRouter } from '../api/routes/crawl';
import { jobsRouter } from '../api/routes/jobs';
import { errorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Helper: create a test HTTP server with a mounted router
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

  // Global error handler so asyncHandler rejections produce proper status codes
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Helper: collect an NDJSON response body into parsed objects
// ---------------------------------------------------------------------------

async function collectNdjson(res: globalThis.Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// ===========================================================================
// 1. Content routes — /v1/content
// ===========================================================================

describe('Content routes (/v1/content)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp('/v1/content', contentRouter);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- POST /v1/content/fetch ----

  describe('POST /v1/content/fetch', () => {
    it('returns 400 when body is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when url is not a valid URL', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'not-a-url' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
      expect(body.details).toBeDefined();
    });

    it('returns 400 when options.maxNodes exceeds max', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', options: { maxNodes: 999 } }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('streams NDJSON events on valid request', async () => {
      const mockEvents = [
        { type: 'metadata', payload: { url: 'https://example.com' } },
        { type: 'node', payload: { tag: 'p', text: 'hello' } },
        { type: 'done', payload: { totalNodes: 1 } },
      ];

      // runPipeline is an async generator
      vi.mocked(runPipeline).mockImplementation(async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      });

      const res = await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/x-ndjson');

      const events = await collectNdjson(res);
      expect(events).toHaveLength(3);
      expect(events[0]).toEqual(mockEvents[0]);
      expect(events[2]).toEqual(mockEvents[2]);
    });

    it('sends an error event when pipeline throws', async () => {
      vi.mocked(runPipeline).mockImplementation(async function* () {
        throw new Error('pipeline boom');
      });

      const res = await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      // The route still responds 200 (NDJSON) but the stream includes an error event
      expect(res.status).toBe(200);
      const events = await collectNdjson(res);
      const errorEvent = events.find((e: unknown) => (e as Record<string, unknown>).type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent as Record<string, unknown>).payload).toEqual({ message: 'pipeline boom' });
    });

    it('applies default options when none provided', async () => {
      vi.mocked(runPipeline).mockImplementation(async function* () {
        yield { type: 'done', payload: {} };
      });

      await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(runPipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com',
          useCache: true,
          maxNodes: 60,
          mode: 'http', // rendering.enabled is false, so mode should be 'http'
        }),
      );
    });
  });

  // ---- POST /v1/content/batch-fetch ----

  describe('POST /v1/content/batch-fetch', () => {
    it('returns 400 when body is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when urls is empty', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: [] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when urls contains invalid URL', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: ['not-valid'] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when urls exceeds max length of 10', async () => {
      const urls = Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`);
      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });

      expect(res.status).toBe(400);
    });

    it('streams batch events for valid urls', async () => {
      vi.mocked(runPipeline).mockImplementation(async function* () {
        yield { type: 'node', payload: { tag: 'p', text: 'content' } };
        yield { type: 'done', payload: {} };
      });

      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: ['https://a.com', 'https://b.com'] }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/x-ndjson');

      const events = await collectNdjson(res);

      // Should have: batch_start, source_start*2, source_event*4 (2 per URL), source_end*2, batch_end
      const batchStarts = events.filter((e: unknown) => (e as Record<string, unknown>).type === 'batch_start');
      const batchEnds = events.filter((e: unknown) => (e as Record<string, unknown>).type === 'batch_end');
      const sourceStarts = events.filter((e: unknown) => (e as Record<string, unknown>).type === 'source_start');
      const sourceEnds = events.filter((e: unknown) => (e as Record<string, unknown>).type === 'source_end');

      expect(batchStarts).toHaveLength(1);
      expect(batchEnds).toHaveLength(1);
      expect(sourceStarts).toHaveLength(2);
      expect(sourceEnds).toHaveLength(2);

      // batch_start should contain totalUrls
      const batchStart = batchStarts[0] as Record<string, Record<string, unknown>>;
      expect(batchStart.payload.totalUrls).toBe(2);
    });

    it('includes source error events when a pipeline fails in batch', async () => {
      let callCount = 0;
      vi.mocked(runPipeline).mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          throw new Error('first url failed');
        }
        yield { type: 'done', payload: {} };
      });

      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: ['https://fail.com', 'https://ok.com'] }),
      });

      expect(res.status).toBe(200);
      const events = await collectNdjson(res);

      const sourceEnds = events.filter((e: unknown) => (e as Record<string, unknown>).type === 'source_end');
      const errorEnd = sourceEnds.find(
        (e: unknown) => (e as Record<string, Record<string, unknown>>).payload.status === 'error',
      ) as Record<string, Record<string, unknown>> | undefined;
      const successEnd = sourceEnds.find(
        (e: unknown) => (e as Record<string, Record<string, unknown>>).payload.status === 'success',
      );

      expect(errorEnd).toBeDefined();
      expect(errorEnd!.payload.error).toBe('first url failed');
      expect(successEnd).toBeDefined();
    });
  });
});

// ===========================================================================
// 2. Crawl routes — /v1/crawl
// ===========================================================================

describe('Crawl routes (/v1/crawl)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp('/v1/crawl', crawlRouter);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- POST /v1/crawl ----

  describe('POST /v1/crawl', () => {
    it('returns 400 when body is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when url is invalid', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'garbage' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when options.maxDepth exceeds limit', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', options: { maxDepth: 99 } }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 202 with jobId for valid request', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.jobId).toBeDefined();
      expect(typeof body.jobId).toBe('string');
      expect(body.status).toBe('running');
      expect(body.startUrl).toBe('https://example.com');
      expect(body.startedAt).toBeDefined();
    });
  });

  // ---- GET /v1/crawl/jobs ----

  describe('GET /v1/crawl/jobs', () => {
    it('returns job list (initially empty or contains previously created jobs)', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl/jobs`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobs).toBeDefined();
      expect(Array.isArray(body.jobs)).toBe(true);
    });
  });

  // ---- GET /v1/crawl/:jobId ----

  describe('GET /v1/crawl/:jobId', () => {
    it('returns 404 for unknown job id', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl/nonexistent-job-id`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('job_not_found');
    });

    it('returns job details for a known job', async () => {
      // First create a job
      const createRes = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/crawl-test' }),
      });
      const createBody = await createRes.json();
      const jobId = createBody.jobId;

      // Then fetch it
      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobId).toBe(jobId);
      expect(body.startUrl).toBe('https://example.com/crawl-test');
      expect(body.status).toBeDefined();
      expect(body.progress).toBeDefined();
    });
  });

  // ---- DELETE /v1/crawl/:jobId ----

  describe('DELETE /v1/crawl/:jobId', () => {
    it('returns 404 for unknown job id', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl/nonexistent-delete-id`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('job_not_found');
    });

    it('cancels a running job and returns status', async () => {
      // Create a job so we have something to cancel
      const createRes = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/to-cancel' }),
      });
      const createBody = await createRes.json();
      const jobId = createBody.jobId;

      // Cancel it
      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobId).toBe(jobId);
      expect(body.status).toBe('cancelled');
    });

    it('returns 409 when trying to cancel an already cancelled job', async () => {
      // Create and cancel a job
      const createRes = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/double-cancel' }),
      });
      const createBody = await createRes.json();
      const jobId = createBody.jobId;

      // Cancel first time
      await fetch(`${app.baseUrl}/v1/crawl/${jobId}`, { method: 'DELETE' });

      // Cancel second time — should be 409
      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`, { method: 'DELETE' });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('not_running');
    });
  });

  // ---- GET /v1/crawl/:jobId/results ----

  describe('GET /v1/crawl/:jobId/results', () => {
    it('returns 404 for unknown job id', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl/missing-id/results`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('job_not_found');
    });

    it('returns 409 when crawl is still running', async () => {
      // Create a job (status = running)
      const createRes = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/results-test' }),
      });
      const createBody = await createRes.json();
      const jobId = createBody.jobId;

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}/results`);

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('crawl_in_progress');
    });
  });
});

// ===========================================================================
// 3. Jobs routes — /v1/jobs
// ===========================================================================

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

    // Reset to defaults — each test can override
    mockQueue.enqueue.mockReturnValue('test-job-id');
    mockQueue.getJob.mockResolvedValue(undefined);
    mockQueue.listJobs.mockResolvedValue([]);
    mockQueue.cancel.mockReturnValue(false);
    mockQueue.getStats.mockReturnValue({ queued: 0, running: 0, total: 0, handlers: [] });
  });

  // ---- POST /v1/jobs ----

  describe('POST /v1/jobs', () => {
    it('returns 400 when body is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when type is invalid', async () => {
      const res = await fetch(`${app.baseUrl}/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'invalid_type', payload: {} }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when options.priority is out of range', async () => {
      const res = await fetch(`${app.baseUrl}/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'fetch',
          payload: { url: 'https://example.com' },
          options: { priority: 100 },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 202 with jobId for valid request', async () => {
      const res = await fetch(`${app.baseUrl}/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'fetch',
          payload: { url: 'https://example.com' },
        }),
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
    it('returns jobs list and stats', async () => {
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

    it('returns job details when found', async () => {
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
      const res = await fetch(`${app.baseUrl}/v1/jobs/nonexistent`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('job_not_found');
    });

    it('returns 409 when job cannot be cancelled', async () => {
      mockQueue.getJob.mockResolvedValue({
        id: 'done-job',
        type: 'fetch',
        status: 'completed',
      });
      mockQueue.cancel.mockReturnValue(false);

      const res = await fetch(`${app.baseUrl}/v1/jobs/done-job`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('cannot_cancel');
    });

    it('returns success when job is cancelled', async () => {
      mockQueue.getJob.mockResolvedValue({
        id: 'cancel-me',
        type: 'fetch',
        status: 'queued',
      });
      mockQueue.cancel.mockReturnValue(true);

      const res = await fetch(`${app.baseUrl}/v1/jobs/cancel-me`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobId).toBe('cancel-me');
      expect(body.status).toBe('cancelled');
    });
  });
});
