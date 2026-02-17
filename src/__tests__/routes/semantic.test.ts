/**
 * Integration tests for semantic routes (/v1/semantic).
 *
 * Covers POST /index, POST /search, POST /rag.
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import http from 'http';
import express, { type Router } from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockIndexDocuments,
  mockSearch,
  mockRagRun,
  mockQueryCacheGetOrCompute,
} = vi.hoisted(() => ({
  mockIndexDocuments: vi.fn().mockResolvedValue(undefined),
  mockSearch: vi.fn().mockResolvedValue([]),
  mockRagRun: vi.fn().mockResolvedValue({ answer: 'test', sources: [] }),
  mockQueryCacheGetOrCompute: vi.fn(async (_query: string, computeFn: () => Promise<unknown>) => {
    const result = await computeFn();
    return { result, cached: false };
  }),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../services/semantic-services', () => ({
  getSemanticServices: vi.fn(() => ({
    searchService: {
      indexDocuments: mockIndexDocuments,
      search: mockSearch,
    },
    ragPipeline: {
      run: mockRagRun,
    },
  })),
}));

vi.mock('../../services/query-cache', () => ({
  queryCache: {
    getOrCompute: mockQueryCacheGetOrCompute,
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

import { semanticRouter } from '../../api/routes/semantic';
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

describe('Semantic routes (/v1/semantic)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp('/v1/semantic', semanticRouter);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockQueryCacheGetOrCompute.mockImplementation(
      async (_query: string, computeFn: () => Promise<unknown>) => {
        const result = await computeFn();
        return { result, cached: false };
      },
    );
  });

  // ---- POST /v1/semantic/index ----

  describe('POST /v1/semantic/index', () => {
    it('returns 400 when documents are missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/semantic/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when documents array is empty', async () => {
      const res = await fetch(`${app.baseUrl}/v1/semantic/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents: [] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when document text is empty', async () => {
      const res = await fetch(`${app.baseUrl}/v1/semantic/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents: [{ id: 'doc1', text: '' }] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 202 with count for valid documents', async () => {
      const res = await fetch(`${app.baseUrl}/v1/semantic/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documents: [
            { id: 'doc1', text: 'Some document content' },
            { id: 'doc2', text: 'Another document' },
          ],
        }),
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.status).toBe('indexed');
      expect(body.count).toBe(2);
      expect(mockIndexDocuments).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'doc1' }),
          expect.objectContaining({ id: 'doc2' }),
        ]),
      );
    });
  });

  // ---- POST /v1/semantic/search ----

  describe('POST /v1/semantic/search', () => {
    it('returns 400 when query is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/semantic/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when query is empty string', async () => {
      const res = await fetch(`${app.baseUrl}/v1/semantic/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 200 with results for valid query', async () => {
      mockSearch.mockResolvedValue([{ id: 'doc1', score: 0.95, text: 'result' }]);

      const res = await fetch(`${app.baseUrl}/v1/semantic/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test query' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].id).toBe('doc1');
    });

    it('passes optional k and minScore parameters', async () => {
      mockSearch.mockResolvedValue([]);

      await fetch(`${app.baseUrl}/v1/semantic/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test', k: 5, minScore: 0.8 }),
      });

      expect(mockSearch).toHaveBeenCalledWith('test', {
        k: 5,
        filter: undefined,
        minScore: 0.8,
      });
    });
  });

  // ---- POST /v1/semantic/rag ----

  describe('POST /v1/semantic/rag', () => {
    it('returns 400 when query is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/semantic/rag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 200 with result and _cached=false', async () => {
      const res = await fetch(`${app.baseUrl}/v1/semantic/rag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'What is the meaning of life?' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.answer).toBe('test');
      expect(body._cached).toBe(false);
    });

    it('serves cached result with _cached=true', async () => {
      mockQueryCacheGetOrCompute.mockResolvedValueOnce({
        result: { answer: 'cached answer', sources: [] },
        cached: true,
      });

      const res = await fetch(`${app.baseUrl}/v1/semantic/rag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'cached query' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.answer).toBe('cached answer');
      expect(body._cached).toBe(true);
    });

    it('passes optional parameters to ragPipeline', async () => {
      await fetch(`${app.baseUrl}/v1/semantic/rag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'test',
          sessionId: 'sess-1',
          k: 3,
          summaryLevels: ['headline'],
        }),
      });

      expect(mockRagRun).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'test',
          sessionId: 'sess-1',
          topK: 3,
          summaryLevels: ['headline'],
        }),
      );
    });
  });
});
