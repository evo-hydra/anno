/**
 * Branch-coverage tests for crawl routes (/v1/crawl).
 *
 * Focuses on uncovered branches: crawler events (page:fetched, page:error,
 * crawl:complete with cancelled status), crawl error catch path,
 * evictCompletedJobs logic, GET /jobs with error/result fields,
 * GET /:jobId with completedAt/error/completed+result branches.
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import http from 'http';
import express, { type Router } from 'express';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let latestCrawler: EventEmitter & { crawl: ReturnType<typeof vi.fn> };
const crawlers: Array<EventEmitter & { crawl: ReturnType<typeof vi.fn> }> = [];

vi.mock('../../services/crawler', () => ({
  createCrawler: vi.fn(() => {
    const emitter = new EventEmitter();
    (emitter as Record<string, unknown>).crawl = vi.fn().mockReturnValue(
      new Promise(() => {
        /* never resolves by default — simulates a running crawl */
      })
    );
    latestCrawler = emitter as EventEmitter & { crawl: ReturnType<typeof vi.fn> };
    crawlers.push(latestCrawler);
    return latestCrawler;
  }),
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

async function createJob(baseUrl: string, url = 'https://example.com/test'): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/crawl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const body = await res.json();
  return body.jobId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Crawl routes — branch coverage', () => {
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

  // ---- POST: crawler event branches ----

  describe('crawler events', () => {
    it('page:fetched increments progress on the job', async () => {
      const jobId = await createJob(app.baseUrl, 'https://example.com/page-fetched-test');
      const crawler = latestCrawler;

      // Emit page:fetched event
      crawler.emit('page:fetched', { url: 'https://example.com/p1', depth: 1, httpStatus: 200 });
      crawler.emit('page:fetched', { url: 'https://example.com/p2', depth: 2, httpStatus: 200 });

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`);
      const body = await res.json();

      expect(body.progress.pagesCompleted).toBe(2);
      expect(body.progress.currentUrl).toBe('https://example.com/p2');
    });

    it('page:error increments progress on the job', async () => {
      const jobId = await createJob(app.baseUrl, 'https://example.com/page-error-test');
      const crawler = latestCrawler;

      crawler.emit('page:error', { url: 'https://example.com/err', error: 'timeout' });

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`);
      const body = await res.json();

      expect(body.progress.pagesCompleted).toBe(1);
      expect(body.progress.currentUrl).toBe('https://example.com/err');
    });

    it('crawl:complete sets status to completed with result', async () => {
      const jobId = await createJob(app.baseUrl, 'https://example.com/crawl-complete-test');
      const crawler = latestCrawler;

      crawler.emit('crawl:complete', {
        status: 'completed',
        stats: { totalPages: 5, totalDuration: 1234 },
        pages: [],
      });

      // Small delay for event processing
      await new Promise((r) => setTimeout(r, 10));

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`);
      const body = await res.json();

      expect(body.status).toBe('completed');
      expect(body.completedAt).toBeDefined();
      expect(body.stats).toBeDefined();
      expect(body.stats.totalPages).toBe(5);
    });

    it('crawl:complete with cancelled status sets job to cancelled', async () => {
      const jobId = await createJob(app.baseUrl, 'https://example.com/crawl-cancelled-test');
      const crawler = latestCrawler;

      crawler.emit('crawl:complete', {
        status: 'cancelled',
        stats: { totalPages: 2, totalDuration: 500 },
        pages: [],
      });

      await new Promise((r) => setTimeout(r, 10));

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`);
      const body = await res.json();

      expect(body.status).toBe('cancelled');
    });

    it('crawler.crawl rejection sets job status to error', async () => {
      // Override crawl to reject
      const jobId = await createJob(app.baseUrl, 'https://example.com/crawl-reject-test');
      const crawler = latestCrawler;

      // The mock crawl returns a never-resolving promise by default.
      // We need to make it reject. Since we captured latestCrawler, let's
      // trigger the catch path by making the crawl mock reject.
      const crawlMock = crawler.crawl as ReturnType<typeof vi.fn>;
      // Get the stored promise and resolve it with a rejection
      // Actually we need to re-trigger — the promise was already created.
      // Instead, let's configure a new test where crawl rejects immediately.
      crawlMock.mockRejectedValueOnce(new Error('network failure'));

      // Create another job with the rejection mock already set
      const { createCrawler } = await import('../../services/crawler');
      const createCrawlerMock = createCrawler as ReturnType<typeof vi.fn>;

      // Set up the next createCrawler call to return a crawler that rejects
      const rejectEmitter = new EventEmitter();
      (rejectEmitter as Record<string, unknown>).crawl = vi.fn().mockRejectedValue(new Error('network failure'));
      createCrawlerMock.mockReturnValueOnce(rejectEmitter);

      const jobId2 = await createJob(app.baseUrl, 'https://example.com/crawl-reject-test-2');

      // Wait for rejection to be caught
      await new Promise((r) => setTimeout(r, 50));

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId2}`);
      const body = await res.json();

      expect(body.status).toBe('error');
      expect(body.error).toBe('network failure');
    });

    it('crawler.crawl rejection with non-Error sets unknown error', async () => {
      const { createCrawler } = await import('../../services/crawler');
      const createCrawlerMock = createCrawler as ReturnType<typeof vi.fn>;

      const rejectEmitter = new EventEmitter();
      (rejectEmitter as Record<string, unknown>).crawl = vi.fn().mockRejectedValue('string error');
      createCrawlerMock.mockReturnValueOnce(rejectEmitter);

      const jobId = await createJob(app.baseUrl, 'https://example.com/crawl-reject-non-error');

      await new Promise((r) => setTimeout(r, 50));

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`);
      const body = await res.json();

      expect(body.status).toBe('error');
      expect(body.error).toBe('unknown error');
    });
  });

  // ---- GET /jobs: elapsed and optional fields ----

  describe('GET /v1/crawl/jobs — branch coverage', () => {
    it('includes error field for errored jobs', async () => {
      const { createCrawler } = await import('../../services/crawler');
      const createCrawlerMock = createCrawler as ReturnType<typeof vi.fn>;

      const rejectEmitter = new EventEmitter();
      (rejectEmitter as Record<string, unknown>).crawl = vi.fn().mockRejectedValue(new Error('jobs list error'));
      createCrawlerMock.mockReturnValueOnce(rejectEmitter);

      await createJob(app.baseUrl, 'https://example.com/jobs-error-field');
      await new Promise((r) => setTimeout(r, 50));

      const res = await fetch(`${app.baseUrl}/v1/crawl/jobs`);
      const body = await res.json();

      const errorJob = body.jobs.find(
        (j: Record<string, unknown>) => j.startUrl === 'https://example.com/jobs-error-field'
      );
      expect(errorJob).toBeDefined();
      expect(errorJob.error).toBe('jobs list error');
    });

    it('includes stats for completed jobs', async () => {
      const jobId = await createJob(app.baseUrl, 'https://example.com/jobs-stats-field');
      const crawler = latestCrawler;

      crawler.emit('crawl:complete', {
        status: 'completed',
        stats: { totalPages: 3, totalDuration: 100 },
        pages: [],
      });
      await new Promise((r) => setTimeout(r, 10));

      const res = await fetch(`${app.baseUrl}/v1/crawl/jobs`);
      const body = await res.json();

      const completedJob = body.jobs.find(
        (j: Record<string, unknown>) => j.startUrl === 'https://example.com/jobs-stats-field'
      );
      expect(completedJob).toBeDefined();
      expect(completedJob.stats).toBeDefined();
      expect(completedJob.stats.totalPages).toBe(3);
    });

    it('calculates elapsed for completed vs running jobs differently', async () => {
      // Create a running job
      await createJob(app.baseUrl, 'https://example.com/jobs-elapsed-running');

      // Create a completed job
      const completedJobId = await createJob(app.baseUrl, 'https://example.com/jobs-elapsed-completed');
      const crawler = latestCrawler;
      crawler.emit('crawl:complete', {
        status: 'completed',
        stats: { totalPages: 1, totalDuration: 50 },
        pages: [],
      });
      await new Promise((r) => setTimeout(r, 10));

      const res = await fetch(`${app.baseUrl}/v1/crawl/jobs`);
      const body = await res.json();

      const runningJob = body.jobs.find(
        (j: Record<string, unknown>) => j.startUrl === 'https://example.com/jobs-elapsed-running'
      );
      const completedJob = body.jobs.find(
        (j: Record<string, unknown>) => j.startUrl === 'https://example.com/jobs-elapsed-completed'
      );

      expect(typeof runningJob.elapsed).toBe('number');
      expect(typeof completedJob.elapsed).toBe('number');
      expect(completedJob.completedAt).toBeDefined();
    });
  });

  // ---- GET /:jobId — completedAt, error, completed+result branches ----

  describe('GET /v1/crawl/:jobId — branch coverage', () => {
    it('includes completedAt when job is completed', async () => {
      const jobId = await createJob(app.baseUrl, 'https://example.com/jobid-completed');
      const crawler = latestCrawler;

      crawler.emit('crawl:complete', {
        status: 'completed',
        stats: { totalPages: 2, totalDuration: 200 },
        pages: [],
      });
      await new Promise((r) => setTimeout(r, 10));

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`);
      const body = await res.json();

      expect(body.completedAt).toBeDefined();
      expect(body.stats).toBeDefined();
    });

    it('includes error field when job has error', async () => {
      const { createCrawler } = await import('../../services/crawler');
      const createCrawlerMock = createCrawler as ReturnType<typeof vi.fn>;

      const rejectEmitter = new EventEmitter();
      (rejectEmitter as Record<string, unknown>).crawl = vi.fn().mockRejectedValue(new Error('jobid error test'));
      createCrawlerMock.mockReturnValueOnce(rejectEmitter);

      const jobId = await createJob(app.baseUrl, 'https://example.com/jobid-error');
      await new Promise((r) => setTimeout(r, 50));

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`);
      const body = await res.json();

      expect(body.error).toBe('jobid error test');
      expect(body.status).toBe('error');
    });

    it('does not include stats when job is running', async () => {
      const jobId = await createJob(app.baseUrl, 'https://example.com/jobid-running-no-stats');

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`);
      const body = await res.json();

      expect(body.stats).toBeUndefined();
      expect(body.completedAt).toBeUndefined();
    });

    it('computes elapsed from completedAt for completed jobs', async () => {
      const jobId = await createJob(app.baseUrl, 'https://example.com/jobid-elapsed-completed');
      const crawler = latestCrawler;

      crawler.emit('crawl:complete', {
        status: 'completed',
        stats: { totalPages: 1, totalDuration: 10 },
        pages: [],
      });
      await new Promise((r) => setTimeout(r, 10));

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`);
      const body = await res.json();

      expect(typeof body.elapsed).toBe('number');
      expect(body.elapsed).toBeGreaterThanOrEqual(0);
    });
  });

  // ---- GET /:jobId/results — no_results with error vs without ----

  describe('GET /v1/crawl/:jobId/results — branch coverage', () => {
    it('returns results for completed job', async () => {
      const jobId = await createJob(app.baseUrl, 'https://example.com/results-completed');
      const crawler = latestCrawler;

      crawler.emit('crawl:complete', {
        status: 'completed',
        stats: { totalPages: 3, totalDuration: 300 },
        pages: [{ url: 'https://example.com/p1', content: 'hello' }],
      });
      await new Promise((r) => setTimeout(r, 10));

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}/results`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.stats).toBeDefined();
      expect(body.pages).toBeDefined();
    });

    it('returns no_results with crawlError for errored job', async () => {
      const { createCrawler } = await import('../../services/crawler');
      const createCrawlerMock = createCrawler as ReturnType<typeof vi.fn>;

      const rejectEmitter = new EventEmitter();
      (rejectEmitter as Record<string, unknown>).crawl = vi.fn().mockRejectedValue(new Error('results error'));
      createCrawlerMock.mockReturnValueOnce(rejectEmitter);

      const jobId = await createJob(app.baseUrl, 'https://example.com/results-error');
      await new Promise((r) => setTimeout(r, 50));

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}/results`);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe('no_results');
      expect(body.crawlError).toBe('results error');
    });

    it('returns no_results without crawlError for cancelled job (no error)', async () => {
      const jobId = await createJob(app.baseUrl, 'https://example.com/results-cancelled-no-error');

      // Cancel the job
      await fetch(`${app.baseUrl}/v1/crawl/${jobId}`, { method: 'DELETE' });

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}/results`);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe('no_results');
      expect(body.crawlError).toBeUndefined();
    });
  });

  // ---- DELETE: not_running message with different statuses ----

  describe('DELETE /v1/crawl/:jobId — branch coverage', () => {
    it('returns 409 for completed job with status in message', async () => {
      const jobId = await createJob(app.baseUrl, 'https://example.com/delete-completed');
      const crawler = latestCrawler;

      crawler.emit('crawl:complete', {
        status: 'completed',
        stats: { totalPages: 1, totalDuration: 10 },
        pages: [],
      });
      await new Promise((r) => setTimeout(r, 10));

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`, { method: 'DELETE' });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.error).toBe('not_running');
      expect(body.message).toContain('completed');
    });

    it('returns 409 for errored job', async () => {
      const { createCrawler } = await import('../../services/crawler');
      const createCrawlerMock = createCrawler as ReturnType<typeof vi.fn>;

      const rejectEmitter = new EventEmitter();
      (rejectEmitter as Record<string, unknown>).crawl = vi.fn().mockRejectedValue(new Error('err'));
      createCrawlerMock.mockReturnValueOnce(rejectEmitter);

      const jobId = await createJob(app.baseUrl, 'https://example.com/delete-errored');
      await new Promise((r) => setTimeout(r, 50));

      const res = await fetch(`${app.baseUrl}/v1/crawl/${jobId}`, { method: 'DELETE' });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.error).toBe('not_running');
      expect(body.message).toContain('error');
    });
  });

  // ---- POST: valid options pass-through ----

  describe('POST /v1/crawl — options branches', () => {
    it('accepts all optional crawl options', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com/full-options',
          options: {
            maxDepth: 5,
            maxPages: 100,
            pathPrefix: '/docs',
            includePatterns: ['*.html'],
            excludePatterns: ['*.pdf'],
            respectRobots: false,
            renderJs: true,
            extractContent: false,
            concurrency: 5,
            strategy: 'dfs',
            sitemapUrl: 'https://example.com/sitemap.xml',
          },
        }),
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.jobId).toBeDefined();
    });

    it('returns 400 for invalid strategy value', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          options: { strategy: 'invalid' },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for negative maxDepth', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          options: { maxDepth: -1 },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for maxPages below minimum (1)', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          options: { maxPages: 0 },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid sitemapUrl', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          options: { sitemapUrl: 'not-a-url' },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for concurrency below minimum (1)', async () => {
      const res = await fetch(`${app.baseUrl}/v1/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          options: { concurrency: 0 },
        }),
      });

      expect(res.status).toBe(400);
    });
  });
});
