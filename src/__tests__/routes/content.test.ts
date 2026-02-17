/**
 * Integration tests for content routes (/v1/content).
 *
 * Covers POST /fetch (NDJSON streaming) and POST /batch-fetch.
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
    it('returns 400 when body is empty', async () => {
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

    it('returns 400 when options.maxNodes exceeds max (100)', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', options: { maxNodes: 999 } }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when options.maxNodes is less than min (1)', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', options: { maxNodes: 0 } }),
      });

      expect(res.status).toBe(400);
    });

    it('streams NDJSON events with metadata and done on valid request', async () => {
      const mockEvents = [
        { type: 'metadata', payload: { url: 'https://example.com' } },
        { type: 'node', payload: { tag: 'p', text: 'hello' } },
        { type: 'done', payload: { totalNodes: 1 } },
      ];

      mockRunPipeline.mockImplementation(async function* () {
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

    it('sends error event when pipeline throws', async () => {
      mockRunPipeline.mockImplementation(async function* () {
        throw new Error('pipeline boom');
      });

      const res = await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(res.status).toBe(200);
      const events = await collectNdjson(res);
      const errorEvent = events.find(
        (e: unknown) => (e as Record<string, unknown>).type === 'error',
      );
      expect(errorEvent).toBeDefined();
      expect((errorEvent as Record<string, Record<string, unknown>>).payload.message).toBe(
        'pipeline boom',
      );
    });

    it('applies default options when none provided', async () => {
      mockRunPipeline.mockImplementation(async function* () {
        yield { type: 'done', payload: {} };
      });

      await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(mockRunPipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com',
          useCache: true,
          maxNodes: 60,
          mode: 'http',
        }),
      );
    });

    it('passes render mode when options.render is true', async () => {
      mockRunPipeline.mockImplementation(async function* () {
        yield { type: 'done', payload: {} };
      });

      await fetch(`${app.baseUrl}/v1/content/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', options: { render: true } }),
      });

      expect(mockRunPipeline).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'rendered' }),
      );
    });
  });

  // ---- POST /v1/content/batch-fetch ----

  describe('POST /v1/content/batch-fetch', () => {
    it('returns 400 when body is empty', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when urls array is empty', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: [] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when urls contains invalid URL', async () => {
      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: ['not-valid'] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when urls exceeds max (10)', async () => {
      const urls = Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`);
      const res = await fetch(`${app.baseUrl}/v1/content/batch-fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });

      expect(res.status).toBe(400);
    });

    it('streams batch_start, source_start, source_event, source_end, batch_end events', async () => {
      mockRunPipeline.mockImplementation(async function* () {
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

      const types = events.map((e: unknown) => (e as Record<string, unknown>).type);
      expect(types[0]).toBe('batch_start');
      expect(types[types.length - 1]).toBe('batch_end');
      expect(types.filter((t) => t === 'source_start')).toHaveLength(2);
      expect(types.filter((t) => t === 'source_end')).toHaveLength(2);

      const batchStart = events[0] as Record<string, Record<string, unknown>>;
      expect(batchStart.payload.totalUrls).toBe(2);
    });

    it('includes source_end with status error when one URL fails', async () => {
      let callCount = 0;
      mockRunPipeline.mockImplementation(async function* () {
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

      const sourceEnds = events.filter(
        (e: unknown) => (e as Record<string, unknown>).type === 'source_end',
      );
      const errorEnd = sourceEnds.find(
        (e: unknown) =>
          (e as Record<string, Record<string, unknown>>).payload.status === 'error',
      ) as Record<string, Record<string, unknown>>;
      const successEnd = sourceEnds.find(
        (e: unknown) =>
          (e as Record<string, Record<string, unknown>>).payload.status === 'success',
      );

      expect(errorEnd).toBeDefined();
      expect(errorEnd.payload.error).toBe('first url failed');
      expect(successEnd).toBeDefined();
    });
  });
});
