/**
 * Integration tests for crawl routes (/v1/crawl).
 *
 * Covers POST /, GET /jobs, GET /:jobId, GET /:jobId/results, DELETE /:jobId.
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import http from 'http';
import express, { type Router } from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../services/crawler', async () => {
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

import { crawlRouter } from '../../api/routes/crawl';
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
    it('returns 400 when body is empty', async () => {
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

    it('returns 400 when options.maxDepth exceeds limit (10)', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', options: { maxDepth: 99 } }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when options.maxPages exceeds limit (500)', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', options: { maxPages: 1000 } }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when options.concurrency exceeds limit (10)', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', options: { concurrency: 20 } }),
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
    it('returns job list as array', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl/jobs`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobs).toBeDefined();
      expect(Array.isArray(body.jobs)).toBe(true);
    });

    it('includes previously created jobs in list', async () => {
      // Create a job first
      await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/jobs-list-test' }),
      });

      const res = await fetch(`${app.baseUrl}/v1/crawl/jobs`);
      const body = await res.json();

      const job = body.jobs.find(
        (j: Record<string, unknown>) => j.startUrl === 'https://example.com/jobs-list-test',
      );
      expect(job).toBeDefined();
      expect(job.jobId).toBeDefined();
      expect(job.status).toBeDefined();
      expect(job.progress).toBeDefined();
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

    it('returns job progress for a known job', async () => {
      const createRes = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/progress-test' }),
      });
      const { jobId } = await createRes.json();

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobId).toBe(jobId);
      expect(body.startUrl).toBe('https://example.com/progress-test');
      expect(body.status).toBeDefined();
      expect(body.progress).toBeDefined();
      expect(typeof body.elapsed).toBe('number');
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

    it('returns 409 while crawl is still running', async () => {
      const createRes = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/results-running' }),
      });
      const { jobId } = await createRes.json();

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}/results`);

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('crawl_in_progress');
      expect(body.progress).toBeDefined();
    });

    it('returns 404 with no results for cancelled job', async () => {
      const createRes = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/results-cancelled' }),
      });
      const { jobId } = await createRes.json();

      // Cancel the job
      await fetch(`${app.baseUrl}/v1/crawl/${jobId}`, { method: 'DELETE' });

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}/results`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('no_results');
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

    it('cancels a running job', async () => {
      const createRes = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/to-cancel' }),
      });
      const { jobId } = await createRes.json();

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobId).toBe(jobId);
      expect(body.status).toBe('cancelled');
      expect(body.message).toBeDefined();
    });

    it('returns 409 for already-cancelled job', async () => {
      const createRes = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/double-cancel' }),
      });
      const { jobId } = await createRes.json();

      // Cancel first time
      await fetch(`${app.baseUrl}/v1/crawl/${jobId}`, { method: 'DELETE' });

      // Cancel second time — should be 409
      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`, { method: 'DELETE' });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('not_running');
    });
  });
});
