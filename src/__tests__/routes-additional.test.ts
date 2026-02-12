/**
 * Integration tests for additional Anno API route handlers:
 *   - interact (POST /, /screenshot, /page-state)
 *   - workflow (POST /, /validate, /parse)
 *   - semantic (POST /index, /search, /rag)
 *   - watch   (POST /, GET /, GET /:id, DELETE /:id, PUT /:id/pause, PUT /:id/resume, GET /:id/events, GET /:id/history)
 *   - memory  (GET /:sessionId, POST /:sessionId/entries, DELETE /:sessionId)
 *
 * Strategy: mount each router on a minimal Express app, start a real HTTP
 * server on an ephemeral port, and drive it with native `fetch`. All heavy
 * dependencies are vi.mock'd so tests run without Redis, Playwright, or the network.
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import http from 'http';
import express, { type Router } from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted ensures these are available when vi.mock
// factories run (vi.mock is hoisted to the top of the file in vitest 4.x).
// ---------------------------------------------------------------------------

const {
  mockWithPage,
  mockExecuteActions,
  mockGetPageState,
  mockScreenshot,
  mockDistillContent,
  mockWorkflowExecute,
  mockWorkflowValidate,
  mockWorkflowParseYaml,
  mockIndexDocuments,
  mockSearch,
  mockRagRun,
  mockGetSession,
  mockAddEntry,
  mockClearSession,
  mockQueryCacheGetOrCompute,
  mockAddWatch,
  mockListWatches,
  mockGetWatch,
  mockRemoveWatch,
  mockPauseWatch,
  mockResumeWatch,
  mockGetEvents,
  mockGetHistory,
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
  mockWorkflowExecute: vi.fn(),
  mockWorkflowValidate: vi.fn(),
  mockWorkflowParseYaml: vi.fn(),
  mockIndexDocuments: vi.fn().mockResolvedValue(undefined),
  mockSearch: vi.fn().mockResolvedValue([]),
  mockRagRun: vi.fn().mockResolvedValue({ answer: 'test', sources: [] }),
  mockGetSession: vi.fn().mockResolvedValue(null),
  mockAddEntry: vi.fn().mockResolvedValue(undefined),
  mockClearSession: vi.fn().mockResolvedValue(undefined),
  mockQueryCacheGetOrCompute: vi.fn(async (_query: string, computeFn: () => Promise<unknown>) => {
    const result = await computeFn();
    return { result, cached: false };
  }),
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
    ai: { summarizer: 'heuristic' },
  },
}));

vi.mock('../services/renderer', () => ({
  rendererManager: {
    withPage: mockWithPage,
  },
  getRendererStatus: vi.fn(),
}));

vi.mock('../services/interaction-manager', () => ({
  interactionManager: {
    executeActions: mockExecuteActions,
    getPageState: mockGetPageState,
    screenshot: mockScreenshot,
  },
}));

vi.mock('../services/distiller', () => ({
  distillContent: mockDistillContent,
}));

vi.mock('../services/workflow-engine', () => ({
  workflowEngine: {
    execute: mockWorkflowExecute,
    validate: mockWorkflowValidate,
    parseYaml: mockWorkflowParseYaml,
  },
}));

vi.mock('../services/semantic-services', () => ({
  getSemanticServices: vi.fn(() => ({
    searchService: {
      indexDocuments: mockIndexDocuments,
      search: mockSearch,
    },
    ragPipeline: {
      run: mockRagRun,
    },
    memoryStore: {
      getSession: mockGetSession,
      addEntry: mockAddEntry,
      clearSession: mockClearSession,
    },
  })),
}));

vi.mock('../services/query-cache', () => ({
  queryCache: {
    getOrCompute: mockQueryCacheGetOrCompute,
  },
}));

vi.mock('../services/watch-manager', () => ({
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

vi.mock('../services/diff-engine', () => ({
  diffEngine: {
    getHistory: mockGetHistory,
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

import { interactRouter } from '../api/routes/interact';
import { workflowRouter } from '../api/routes/workflow';
import { semanticRouter } from '../api/routes/semantic';
import { watchRouter } from '../api/routes/watch';
import { memoryRouter } from '../api/routes/memory';
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

// ===========================================================================
// 1. Interact routes — /v1/interact
// ===========================================================================

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

    // Default withPage mock: calls the handler with a fake page, wraps result
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
    it('returns 400 when body is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when url is not a valid URL', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'not-a-url' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns success for a valid request with no actions', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.results).toEqual([]);
      expect(body.pageState).toBeDefined();
    });

    it('executes actions when provided', async () => {
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
      expect(mockExecuteActions).toHaveBeenCalled();
    });

    it('extracts content when extract is true', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          extract: true,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.extraction).toBeDefined();
    });

    it('returns extraction error when distiller fails', async () => {
      mockDistillContent.mockRejectedValueOnce(new Error('distill failed'));

      const res = await fetch(`${app.baseUrl}/v1/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          extract: true,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.extraction).toEqual({ error: 'distill failed' });
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
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('includes totalDuration in response', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.totalDuration).toBe('number');
    });
  });

  // ---- POST /v1/interact/screenshot ----

  describe('POST /v1/interact/screenshot', () => {
    it('returns 400 when body is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when url is invalid', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'bad-url' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns screenshot for valid request', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.screenshot).toBe('base64-screenshot-data');
      expect(body.pageState).toBeDefined();
      expect(body.pageState.url).toBe('https://example.com');
      expect(body.pageState.title).toBe('Test Page');
    });

    it('executes preparatory actions before screenshot', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          actions: [{ type: 'click', selector: '#dismiss-popup' }],
        }),
      });

      expect(res.status).toBe(200);
      expect(mockExecuteActions).toHaveBeenCalled();
    });

    it('supports fullPage option', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          fullPage: true,
        }),
      });

      expect(res.status).toBe(200);
      expect(mockScreenshot).toHaveBeenCalledWith(
        expect.anything(),
        { fullPage: true },
      );
    });
  });

  // ---- POST /v1/interact/page-state ----

  describe('POST /v1/interact/page-state', () => {
    it('returns 400 when body is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact/page-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when url is invalid', async () => {
      const res = await fetch(`${app.baseUrl}/v1/interact/page-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'not-valid' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns page state for valid request', async () => {
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
      const res = await fetch(`${app.baseUrl}/v1/interact/page-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com',
          actions: [{ type: 'scroll', direction: 'down' }],
        }),
      });

      expect(res.status).toBe(200);
      expect(mockExecuteActions).toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// 2. Workflow routes — /v1/workflow
// ===========================================================================

describe('Workflow routes (/v1/workflow)', () => {
  let app: TestApp;

  const validWorkflow = {
    name: 'test-workflow',
    steps: [
      { type: 'fetch', url: 'https://example.com' },
    ],
  };

  beforeAll(async () => {
    app = await createTestApp('/v1/workflow', workflowRouter);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockWorkflowExecute.mockResolvedValue({
      status: 'completed',
      totalDuration: 100,
      steps: [{ id: 's1', status: 'completed' }],
      extractions: [],
      screenshots: [],
    });

    mockWorkflowValidate.mockReturnValue({
      valid: true,
      errors: [],
    });

    mockWorkflowParseYaml.mockReturnValue({
      name: 'parsed-workflow',
      steps: [{ type: 'fetch', url: 'https://example.com' }],
    });
  });

  // ---- POST /v1/workflow ----

  describe('POST /v1/workflow (execute)', () => {
    it('returns 400 when body is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when workflow name is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: { steps: [{ type: 'fetch', url: 'https://a.com' }] } }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when workflow steps are empty', async () => {
      const res = await fetch(`${app.baseUrl}/v1/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: { name: 'test', steps: [] } }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when steps contain invalid type', async () => {
      const res = await fetch(`${app.baseUrl}/v1/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow: {
            name: 'test',
            steps: [{ type: 'badtype' }],
          },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns success for a valid workflow execute request', async () => {
      const res = await fetch(`${app.baseUrl}/v1/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: validWorkflow }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.result.status).toBe('completed');
      expect(mockWorkflowExecute).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'test-workflow' }),
      );
    });

    it('returns success false when workflow status is not completed', async () => {
      mockWorkflowExecute.mockResolvedValue({
        status: 'failed',
        totalDuration: 50,
        steps: [],
        extractions: [],
        screenshots: [],
      });

      const res = await fetch(`${app.baseUrl}/v1/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: validWorkflow }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.result.status).toBe('failed');
    });
  });

  // ---- POST /v1/workflow/validate ----

  describe('POST /v1/workflow/validate', () => {
    it('returns 400 when body is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/workflow/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns valid=true for a valid workflow', async () => {
      const res = await fetch(`${app.baseUrl}/v1/workflow/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: validWorkflow }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.valid).toBe(true);
      expect(body.errors).toEqual([]);
    });

    it('returns validation errors when workflow is invalid', async () => {
      mockWorkflowValidate.mockReturnValue({
        valid: false,
        errors: ['Missing required field: url in fetch step'],
      });

      const res = await fetch(`${app.baseUrl}/v1/workflow/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: validWorkflow }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.valid).toBe(false);
      expect(body.errors).toHaveLength(1);
    });
  });

  // ---- POST /v1/workflow/parse ----

  describe('POST /v1/workflow/parse', () => {
    it('returns 400 when body is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/workflow/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when yaml is empty string', async () => {
      const res = await fetch(`${app.baseUrl}/v1/workflow/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: '' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns parsed workflow for valid YAML', async () => {
      const res = await fetch(`${app.baseUrl}/v1/workflow/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: 'name: test\nsteps:\n  - type: fetch\n    url: https://a.com' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workflow).toBeDefined();
      expect(body.workflow.name).toBe('parsed-workflow');
      expect(mockWorkflowParseYaml).toHaveBeenCalled();
    });

    it('propagates error when parseYaml throws', async () => {
      mockWorkflowParseYaml.mockImplementation(() => {
        throw new Error('Invalid YAML syntax');
      });

      const res = await fetch(`${app.baseUrl}/v1/workflow/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: 'bad: [yaml' }),
      });

      // Error handler catches it
      expect(res.status).toBe(500);
    });
  });
});

// ===========================================================================
// 3. Semantic routes — /v1/semantic
// ===========================================================================

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

    // Reset defaults
    mockQueryCacheGetOrCompute.mockImplementation(async (_query: string, computeFn: () => Promise<unknown>) => {
      const result = await computeFn();
      return { result, cached: false };
    });
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

    it('returns 202 with status=indexed for valid documents', async () => {
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

    it('returns search results for valid query', async () => {
      mockSearch.mockResolvedValue([
        { id: 'doc1', score: 0.95, text: 'result' },
      ]);

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

    it('returns RAG result for valid query', async () => {
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

    it('includes _cached field from query cache', async () => {
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
      expect(body._cached).toBe(true);
    });
  });
});

// ===========================================================================
// 4. Watch routes — /v1/watch
// ===========================================================================

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
    it('returns 400 when body is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when url is not valid', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'not-a-url' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when interval is less than minimum (60)', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', interval: 10 }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 201 with watch object for valid request', async () => {
      const fakeWatch = {
        id: 'watch-1',
        url: 'https://example.com',
        interval: 3600,
        status: 'active',
        createdAt: new Date().toISOString(),
        checkCount: 0,
        changeCount: 0,
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
    });
  });

  // ---- GET /v1/watch ----

  describe('GET /v1/watch', () => {
    it('returns empty watches list', async () => {
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
    it('returns 404 for unknown watch id', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch/nonexistent`);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('watch_not_found');
    });

    it('returns watch with recent events', async () => {
      const fakeWatch = { id: 'w1', url: 'https://example.com', status: 'active' };
      mockGetWatch.mockReturnValue(fakeWatch);
      mockGetEvents.mockResolvedValue([{ watchId: 'w1', changePercent: 5 }]);

      const res = await fetch(`${app.baseUrl}/v1/watch/w1`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.watch.id).toBe('w1');
      expect(body.recentEvents).toHaveLength(1);
    });

    it('returns watch with empty events on getEvents failure', async () => {
      const fakeWatch = { id: 'w1', url: 'https://example.com', status: 'active' };
      mockGetWatch.mockReturnValue(fakeWatch);
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
      mockRemoveWatch.mockResolvedValue(false);

      const res = await fetch(`${app.baseUrl}/v1/watch/nonexistent`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('watch_not_found');
    });

    it('returns success when watch is removed', async () => {
      mockRemoveWatch.mockResolvedValue(true);

      const res = await fetch(`${app.baseUrl}/v1/watch/w1`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('removed');
      expect(body.watchId).toBe('w1');
    });
  });

  // ---- PUT /v1/watch/:watchId/pause ----

  describe('PUT /v1/watch/:watchId/pause', () => {
    it('returns 404 when watch not found', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch/nonexistent/pause`, {
        method: 'PUT',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('watch_not_found');
    });

    it('returns paused watch', async () => {
      const pausedWatch = { id: 'w1', url: 'https://example.com', status: 'paused' };
      mockPauseWatch.mockResolvedValue(pausedWatch);

      const res = await fetch(`${app.baseUrl}/v1/watch/w1/pause`, {
        method: 'PUT',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('paused');
    });
  });

  // ---- PUT /v1/watch/:watchId/resume ----

  describe('PUT /v1/watch/:watchId/resume', () => {
    it('returns 404 when watch not found', async () => {
      const res = await fetch(`${app.baseUrl}/v1/watch/nonexistent/resume`, {
        method: 'PUT',
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('watch_not_found');
    });

    it('returns resumed watch', async () => {
      const resumedWatch = { id: 'w1', url: 'https://example.com', status: 'active' };
      mockResumeWatch.mockResolvedValue(resumedWatch);

      const res = await fetch(`${app.baseUrl}/v1/watch/w1/resume`, {
        method: 'PUT',
      });

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

    it('returns events for known watch', async () => {
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

    it('returns history for known watch', async () => {
      mockGetWatch.mockReturnValue({ id: 'w1', url: 'https://example.com' });
      mockGetHistory.mockResolvedValue([
        { timestamp: '2025-01-01', changePercent: 15 },
      ]);

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

// ===========================================================================
// 5. Memory routes — /v1/memory
// ===========================================================================

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

    it('returns session when found', async () => {
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
    it('returns 400 when body is missing', async () => {
      const res = await fetch(`${app.baseUrl}/v1/memory/sess-1/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 when content is empty', async () => {
      const res = await fetch(`${app.baseUrl}/v1/memory/sess-1/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 202 for valid entry', async () => {
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

    it('returns 400 when type is invalid', async () => {
      const res = await fetch(`${app.baseUrl}/v1/memory/sess-1/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hello', type: 'invalid_type' }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ---- DELETE /v1/memory/:sessionId ----

  describe('DELETE /v1/memory/:sessionId', () => {
    it('returns 204 when session is cleared', async () => {
      const res = await fetch(`${app.baseUrl}/v1/memory/sess-1`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(204);
      expect(mockClearSession).toHaveBeenCalledWith('sess-1');
    });
  });
});
