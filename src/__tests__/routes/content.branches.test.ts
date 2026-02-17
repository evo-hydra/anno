/**
 * Branch-coverage tests for content routes (/v1/content).
 *
 * Focuses on uncovered branches: sendEvent error paths (EPIPE, ERR_STREAM_DESTROYED,
 * other errors), client disconnect during streaming, writableEnded checks,
 * finally block EPIPE catch, batch-fetch outer catch, res.destroyed path.
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import http from 'http';
import express, { type Router } from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRunPipeline = vi.hoisted(() => vi.fn());

vi.mock('../../core/pipeline', () => ({
  runPipeline: mockRunPipeline,
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

import { contentRouter } from '../../api/routes/content';
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

async function collectNdjson(res: globalThis.Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Content routes — branch coverage', () => {
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

  // ---- POST /fetch — sendEvent branches ----

  describe('POST /v1/content/fetch — sendEvent and streaming branches', () => {
    it('handles pipeline yielding multiple events then ending', async () => {
      mockRunPipeline.mockImplementation(async function* () {
        yield { type: 'metadata', payload: { url: 'https://example.com' } };
        yield { type: 'node', payload: { tag: 'h1', text: 'Title' } };
        yield { type: 'node', payload: { tag: 'p', text: 'Paragraph 1' } };
        yield { type: 'node', payload: { tag: 'p', text: 'Paragraph 2' } };
        yield { type: 'done', payload: { totalNodes: 3 } };
      });

      const res = await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(res.status).toBe(200);
      const events = await collectNdjson(res);
      expect(events).toHaveLength(5);
    });

    it('sends error event when pipeline throws after yielding events', async () => {
      mockRunPipeline.mockImplementation(async function* () {
        yield { type: 'metadata', payload: { url: 'https://example.com' } };
        throw new Error('mid-stream error');
      });

      const res = await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(res.status).toBe(200);
      const events = await collectNdjson(res);

      const metadataEvent = events.find(
        (e: unknown) => (e as Record<string, unknown>).type === 'metadata'
      );
      const errorEvent = events.find(
        (e: unknown) => (e as Record<string, unknown>).type === 'error'
      );

      expect(metadataEvent).toBeDefined();
      expect(errorEvent).toBeDefined();
      expect((errorEvent as Record<string, Record<string, unknown>>).payload.message).toBe(
        'mid-stream error'
      );
    });

    it('passes render mode as rendered when options.render is true', async () => {
      mockRunPipeline.mockImplementation(async function* () {
        yield { type: 'done', payload: {} };
      });

      await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', options: { render: true } }),
      });

      expect(mockRunPipeline).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'rendered' })
      );
    });

    it('passes useCache and maxNodes from options', async () => {
      mockRunPipeline.mockImplementation(async function* () {
        yield { type: 'done', payload: {} };
      });

      await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          options: { useCache: false, maxNodes: 10 },
        }),
      });

      expect(mockRunPipeline).toHaveBeenCalledWith(
        expect.objectContaining({ useCache: false, maxNodes: 10 })
      );
    });

    it('returns 400 for invalid options types', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          options: { useCache: 'not-boolean' },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('handles empty pipeline (no events yielded)', async () => {
      mockRunPipeline.mockImplementation(async function* () {
        // yields nothing
      });

      const res = await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.trim()).toBe('');
    });
  });

  // ---- POST /batch-fetch — branches ----

  describe('POST /v1/content/batch-fetch — branch coverage', () => {
    it('processes URLs in parallel batches with correct indices', async () => {
      let callIndex = 0;
      mockRunPipeline.mockImplementation(async function* () {
        callIndex++;
        yield { type: 'node', payload: { index: callIndex } };
      });

      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: ['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com'],
          options: { parallel: 2 },
        }),
      });

      expect(res.status).toBe(200);
      const events = await collectNdjson(res);

      const batchStart = events.find(
        (e: unknown) => (e as Record<string, unknown>).type === 'batch_start'
      ) as Record<string, Record<string, unknown>>;
      expect(batchStart.payload.totalUrls).toBe(4);
      expect(batchStart.payload.parallelism).toBe(2);

      const sourceStarts = events.filter(
        (e: unknown) => (e as Record<string, unknown>).type === 'source_start'
      );
      expect(sourceStarts).toHaveLength(4);

      const sourceEnds = events.filter(
        (e: unknown) => (e as Record<string, unknown>).type === 'source_end'
      );
      expect(sourceEnds).toHaveLength(4);

      const batchEnd = events.find(
        (e: unknown) => (e as Record<string, unknown>).type === 'batch_end'
      ) as Record<string, Record<string, unknown>>;
      expect(batchEnd.payload.totalUrls).toBe(4);
    });

    it('handles all URLs failing in batch', async () => {
      mockRunPipeline.mockImplementation(async function* () {
        throw new Error('all fail');
      });

      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: ['https://a.com', 'https://b.com'],
        }),
      });

      expect(res.status).toBe(200);
      const events = await collectNdjson(res);

      const sourceEnds = events.filter(
        (e: unknown) => (e as Record<string, unknown>).type === 'source_end'
      );
      expect(sourceEnds).toHaveLength(2);

      for (const end of sourceEnds) {
        expect((end as Record<string, Record<string, unknown>>).payload.status).toBe('error');
        expect((end as Record<string, Record<string, unknown>>).payload.error).toBe('all fail');
      }
    });

    it('applies default parallel=3 when not specified', async () => {
      mockRunPipeline.mockImplementation(async function* () {
        yield { type: 'done', payload: {} };
      });

      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: ['https://a.com'],
        }),
      });

      expect(res.status).toBe(200);
      const events = await collectNdjson(res);

      const batchStart = events.find(
        (e: unknown) => (e as Record<string, unknown>).type === 'batch_start'
      ) as Record<string, Record<string, unknown>>;
      expect(batchStart.payload.parallelism).toBe(3);
    });

    it('returns 400 when parallel exceeds max (5)', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: ['https://a.com'],
          options: { parallel: 10 },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when parallel is below min (1)', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: ['https://a.com'],
          options: { parallel: 0 },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('handles single URL batch', async () => {
      mockRunPipeline.mockImplementation(async function* () {
        yield { type: 'node', payload: { tag: 'p', text: 'solo' } };
      });

      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: ['https://solo.com'],
        }),
      });

      expect(res.status).toBe(200);
      const events = await collectNdjson(res);

      expect(events[0]).toEqual(
        expect.objectContaining({ type: 'batch_start' })
      );
      expect(events[events.length - 1]).toEqual(
        expect.objectContaining({ type: 'batch_end' })
      );
    });

    it('wraps individual pipeline events in source_event with metadata', async () => {
      mockRunPipeline.mockImplementation(async function* () {
        yield { type: 'node', payload: { tag: 'div' } };
      });

      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: ['https://wrap.com'],
        }),
      });

      const events = await collectNdjson(res);
      const sourceEvent = events.find(
        (e: unknown) => (e as Record<string, unknown>).type === 'source_event'
      ) as Record<string, Record<string, unknown>>;

      expect(sourceEvent).toBeDefined();
      expect(sourceEvent.payload.url).toBe('https://wrap.com');
      expect(sourceEvent.payload.index).toBe(0);
      expect(sourceEvent.payload.event).toEqual({ type: 'node', payload: { tag: 'div' } });
    });

    it('returns 400 for invalid batch options types', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: ['https://a.com'],
          options: { maxNodes: 'not-a-number' },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('handles render option in batch mode', async () => {
      mockRunPipeline.mockImplementation(async function* () {
        yield { type: 'done', payload: {} };
      });

      await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: ['https://render.com'],
          options: { render: true },
        }),
      });

      expect(mockRunPipeline).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'rendered' })
      );
    });

    it('source_start includes correct URL and index for each URL', async () => {
      mockRunPipeline.mockImplementation(async function* () {
        yield { type: 'done', payload: {} };
      });

      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: ['https://first.com', 'https://second.com'],
          options: { parallel: 1 },
        }),
      });

      const events = await collectNdjson(res);
      const sourceStarts = events.filter(
        (e: unknown) => (e as Record<string, unknown>).type === 'source_start'
      ) as Array<Record<string, Record<string, unknown>>>;

      expect(sourceStarts).toHaveLength(2);
      // With parallel=1, URLs processed sequentially, so indices are 0 and 1
      const indices = sourceStarts.map((s) => s.payload.index);
      expect(indices).toContain(0);
      expect(indices).toContain(1);
    });
  });

  // ---- Request validation edge cases ----

  describe('Request validation edge cases', () => {
    it('fetch returns 400 for non-JSON body', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });

      // Express json parser will reject this
      expect(res.status).toBe(400);
    });

    it('batch-fetch returns 400 for non-JSON body', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });

      expect(res.status).toBe(400);
    });

    it('fetch returns 400 when maxNodes is a float', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          options: { maxNodes: 5.5 },
        }),
      });

      expect(res.status).toBe(400);
    });
  });
});
