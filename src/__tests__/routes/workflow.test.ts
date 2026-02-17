/**
 * Integration tests for workflow routes (/v1/workflow).
 *
 * Covers POST / (execute), POST /validate, POST /parse.
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import http from 'http';
import express, { type Router } from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockWorkflowExecute,
  mockWorkflowValidate,
  mockWorkflowParseYaml,
} = vi.hoisted(() => ({
  mockWorkflowExecute: vi.fn(),
  mockWorkflowValidate: vi.fn(),
  mockWorkflowParseYaml: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../services/workflow-engine', () => ({
  workflowEngine: {
    execute: mockWorkflowExecute,
    validate: mockWorkflowValidate,
    parseYaml: mockWorkflowParseYaml,
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

import { workflowRouter } from '../../api/routes/workflow';
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

const validWorkflow = {
  name: 'test-workflow',
  steps: [{ type: 'fetch', url: 'https://example.com' }],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Workflow routes (/v1/workflow)', () => {
  let app: TestApp;

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

    mockWorkflowValidate.mockReturnValue({ valid: true, errors: [] });

    mockWorkflowParseYaml.mockReturnValue({
      name: 'parsed-workflow',
      steps: [{ type: 'fetch', url: 'https://example.com' }],
    });
  });

  // ---- POST /v1/workflow (execute) ----

  describe('POST /v1/workflow', () => {
    it('returns 400 when body is empty', async () => {
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
        body: JSON.stringify({
          workflow: { steps: [{ type: 'fetch', url: 'https://a.com' }] },
        }),
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

    it('returns 400 when step type is invalid', async () => {
      const res = await fetch(`${app.baseUrl}/v1/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow: { name: 'test', steps: [{ type: 'badtype' }] },
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 200 with success=true for completed workflow', async () => {
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

    it('returns success=false when workflow status is not completed', async () => {
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
    it('returns 400 when body is empty', async () => {
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

    it('returns valid=false with errors when workflow is invalid', async () => {
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
    it('returns 400 when body is empty', async () => {
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

    it('returns 200 with parsed workflow for valid YAML', async () => {
      const res = await fetch(`${app.baseUrl}/v1/workflow/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          yaml: 'name: test\nsteps:\n  - type: fetch\n    url: https://a.com',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.workflow).toBeDefined();
      expect(body.workflow.name).toBe('parsed-workflow');
      expect(mockWorkflowParseYaml).toHaveBeenCalled();
    });

    it('returns 500 when parseYaml throws', async () => {
      mockWorkflowParseYaml.mockImplementation(() => {
        throw new Error('Invalid YAML syntax');
      });

      const res = await fetch(`${app.baseUrl}/v1/workflow/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: 'bad: [yaml' }),
      });

      expect(res.status).toBe(500);
    });
  });
});
