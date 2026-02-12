import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted ensures these are available when vi.mock factories run
// ---------------------------------------------------------------------------

const {
  mockCreateSession,
  mockGetSessionPage,
  mockCloseSession,
  mockExecuteActions,
  mockScreenshot,
} = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
  mockGetSessionPage: vi.fn(),
  mockCloseSession: vi.fn(),
  mockExecuteActions: vi.fn(),
  mockScreenshot: vi.fn(),
}));

vi.mock('../services/session-manager', () => ({
  getSessionManager: vi.fn().mockResolvedValue({
    createSession: mockCreateSession,
    getSessionPage: mockGetSessionPage,
    closeSession: mockCloseSession,
  }),
}));

vi.mock('../services/interaction-manager', () => {
  return {
    InteractionManager: class {
      executeActions = mockExecuteActions;
      screenshot = mockScreenshot;
    },
  };
});

vi.mock('../services/distiller', () => ({
  distillContent: vi.fn(),
}));

vi.mock('js-yaml', () => ({
  load: vi.fn(),
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  WorkflowEngine,
  type WorkflowDefinition,
  type FetchStep,
  type SetVariableStep,
  type LoopStep,
} from '../services/workflow-engine';
import { distillContent } from '../services/distiller';
import * as yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Mock page object — simulates a Playwright Page
// ---------------------------------------------------------------------------

function createMockPage(overrides: Record<string, unknown> = {}) {
  return {
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    content: vi.fn().mockResolvedValue('<html><body>Hello</body></html>'),
    url: vi.fn().mockReturnValue('https://example.com'),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue('eval-result'),
    $: vi.fn().mockResolvedValue({
      textContent: vi.fn().mockResolvedValue('element-text'),
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalWorkflow(
  steps: WorkflowDefinition['steps'],
  options?: WorkflowDefinition['options'],
  variables?: Record<string, string>
): WorkflowDefinition {
  return {
    name: 'test-workflow',
    steps,
    options,
    variables,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;
  let mockPage: ReturnType<typeof createMockPage>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockPage = createMockPage();

    mockCreateSession.mockResolvedValue({ id: 'session-123' });
    mockGetSessionPage.mockResolvedValue(mockPage);
    mockCloseSession.mockResolvedValue(undefined);

    // Create a fresh engine for each test
    engine = new WorkflowEngine();
  });

  // =========================================================================
  // validate()
  // =========================================================================

  describe('validate', () => {
    it('returns valid for a well-formed workflow', () => {
      const workflow = minimalWorkflow([
        { type: 'fetch', url: 'https://example.com' },
      ]);
      const result = engine.validate(workflow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects null/undefined workflow', () => {
      const result = engine.validate(null as unknown as WorkflowDefinition);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Workflow definition is null or undefined');
    });

    it('rejects workflow without name', () => {
      const result = engine.validate({
        name: '',
        steps: [{ type: 'fetch', url: 'https://example.com' }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('name'))).toBe(true);
    });

    it('rejects workflow without steps array', () => {
      const result = engine.validate({
        name: 'test',
        steps: 'not-an-array' as unknown as WorkflowDefinition['steps'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('steps'))).toBe(true);
    });

    it('rejects workflow with empty steps', () => {
      const result = engine.validate(minimalWorkflow([]));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('at least one step'))).toBe(true);
    });

    it('rejects invalid options.timeout', () => {
      const result = engine.validate({
        name: 'test',
        options: { timeout: -1 },
        steps: [{ type: 'fetch', url: 'https://example.com' }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('timeout'))).toBe(true);
    });

    it('rejects invalid options.sessionTtl', () => {
      const result = engine.validate({
        name: 'test',
        options: { sessionTtl: 0 },
        steps: [{ type: 'fetch', url: 'https://example.com' }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('sessionTtl'))).toBe(true);
    });

    it('rejects invalid options.continueOnError', () => {
      const result = engine.validate({
        name: 'test',
        options: { continueOnError: 'yes' as unknown as boolean },
        steps: [{ type: 'fetch', url: 'https://example.com' }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('continueOnError'))).toBe(true);
    });

    // -- Step type validation -------------------------------------------------

    it('rejects unknown step type', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'unknown' as never } as never])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('invalid step type'))).toBe(true);
    });

    it('rejects null step', () => {
      const result = engine.validate(
        minimalWorkflow([null as unknown as FetchStep])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('non-null object'))).toBe(true);
    });

    // -- Fetch step -----------------------------------------------------------

    it('rejects fetch step without url', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'fetch', url: '' }])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('fetch step requires'))).toBe(true);
    });

    // -- Interact step --------------------------------------------------------

    it('rejects interact step without actions', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'interact', actions: [] }])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('interact step requires'))).toBe(true);
    });

    it('accepts valid interact step', () => {
      const result = engine.validate(
        minimalWorkflow([
          { type: 'interact', actions: [{ type: 'click', selector: '#btn' }] },
        ])
      );
      expect(result.valid).toBe(true);
    });

    // -- Wait step ------------------------------------------------------------

    it('rejects wait step with invalid condition', () => {
      const result = engine.validate(
        minimalWorkflow([
          { type: 'wait', condition: 'invalid' as never },
        ])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('wait step requires a "condition"'))).toBe(true);
    });

    it('rejects wait step with condition "selector" but no value', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'wait', condition: 'selector' }])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('requires a string "value"'))).toBe(true);
    });

    it('rejects wait step with condition "timeout" and invalid value', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'wait', condition: 'timeout', value: 'abc' }])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('positive numeric'))).toBe(true);
    });

    it('accepts wait step with condition "networkidle"', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'wait', condition: 'networkidle' }])
      );
      expect(result.valid).toBe(true);
    });

    it('accepts wait step with condition "timeout" and numeric value', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'wait', condition: 'timeout', value: 1000 }])
      );
      expect(result.valid).toBe(true);
    });

    it('accepts wait step with condition "selector" and string value', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'wait', condition: 'selector', value: '#foo' }])
      );
      expect(result.valid).toBe(true);
    });

    // -- SetVariable step -----------------------------------------------------

    it('rejects setVariable step without name', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'setVariable', name: '', value: 'x' }])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('setVariable step requires'))).toBe(true);
    });

    it('rejects setVariable step without value, fromEval, or fromSelector', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'setVariable', name: 'foo' }])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('at least one of'))).toBe(true);
    });

    it('accepts setVariable with fromEval', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'setVariable', name: 'foo', fromEval: 'document.title' }])
      );
      expect(result.valid).toBe(true);
    });

    it('accepts setVariable with fromSelector', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'setVariable', name: 'foo', fromSelector: '#title' }])
      );
      expect(result.valid).toBe(true);
    });

    // -- If step --------------------------------------------------------------

    it('rejects if step without condition', () => {
      const result = engine.validate(
        minimalWorkflow([
          { type: 'if', condition: '', then: [{ type: 'fetch', url: 'https://example.com' }] },
        ])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('if step requires'))).toBe(true);
    });

    it('rejects if step without then array', () => {
      const result = engine.validate(
        minimalWorkflow([
          { type: 'if', condition: 'true', then: [] },
        ])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('non-empty "then"'))).toBe(true);
    });

    it('rejects if step with non-array else', () => {
      const result = engine.validate(
        minimalWorkflow([
          {
            type: 'if',
            condition: 'true',
            then: [{ type: 'fetch', url: 'https://example.com' }],
            else: 'not-an-array' as unknown as never[],
          },
        ])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('"else" must be an array'))).toBe(true);
    });

    it('accepts if step with valid else', () => {
      const result = engine.validate(
        minimalWorkflow([
          {
            type: 'if',
            condition: 'true',
            then: [{ type: 'fetch', url: 'https://a.com' }],
            else: [{ type: 'fetch', url: 'https://b.com' }],
          },
        ])
      );
      expect(result.valid).toBe(true);
    });

    it('validates nested steps inside if/then', () => {
      const result = engine.validate(
        minimalWorkflow([
          {
            type: 'if',
            condition: 'true',
            then: [{ type: 'fetch', url: '' }],
          },
        ])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('then[0]'))).toBe(true);
    });

    // -- Loop step ------------------------------------------------------------

    it('rejects loop step without over or times', () => {
      const result = engine.validate(
        minimalWorkflow([
          { type: 'loop', steps: [{ type: 'fetch', url: 'https://example.com' }] },
        ])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('loop step requires'))).toBe(true);
    });

    it('rejects loop step with empty steps', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'loop', times: 3, steps: [] }])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('non-empty "steps"'))).toBe(true);
    });

    it('rejects loop step with invalid maxIterations', () => {
      const result = engine.validate(
        minimalWorkflow([
          {
            type: 'loop',
            times: 3,
            maxIterations: -1,
            steps: [{ type: 'fetch', url: 'https://example.com' }],
          },
        ])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('maxIterations'))).toBe(true);
    });

    it('accepts loop step with "over"', () => {
      const result = engine.validate(
        minimalWorkflow([
          {
            type: 'loop',
            over: 'items',
            steps: [{ type: 'fetch', url: 'https://example.com' }],
          },
        ])
      );
      expect(result.valid).toBe(true);
    });

    it('accepts loop step with "times"', () => {
      const result = engine.validate(
        minimalWorkflow([
          {
            type: 'loop',
            times: 5,
            steps: [{ type: 'fetch', url: 'https://example.com' }],
          },
        ])
      );
      expect(result.valid).toBe(true);
    });

    it('validates nested loop steps', () => {
      const result = engine.validate(
        minimalWorkflow([
          {
            type: 'loop',
            times: 3,
            steps: [{ type: 'fetch', url: '' }],
          },
        ])
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('steps[0]'))).toBe(true);
    });

    // -- Extract and Screenshot steps -----------------------------------------

    it('accepts extract step with no required fields', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'extract' }])
      );
      expect(result.valid).toBe(true);
    });

    it('accepts screenshot step with no required fields', () => {
      const result = engine.validate(
        minimalWorkflow([{ type: 'screenshot' }])
      );
      expect(result.valid).toBe(true);
    });
  });

  // =========================================================================
  // parseYaml()
  // =========================================================================

  describe('parseYaml', () => {
    it('parses a valid YAML string into a workflow definition', () => {
      const parsed = {
        name: 'yaml-workflow',
        steps: [{ type: 'fetch', url: 'https://example.com' }],
      };
      vi.mocked(yaml.load).mockReturnValue(parsed);

      const result = engine.parseYaml('name: yaml-workflow\nsteps: []');
      expect(result).toEqual(parsed);
      expect(yaml.load).toHaveBeenCalledOnce();
    });

    it('throws when YAML does not parse to an object', () => {
      vi.mocked(yaml.load).mockReturnValue(null);
      expect(() => engine.parseYaml('null')).toThrow('YAML did not parse into a valid object');
    });

    it('throws when YAML parses to a string', () => {
      vi.mocked(yaml.load).mockReturnValue('just a string');
      expect(() => engine.parseYaml('just a string')).toThrow('YAML did not parse into a valid object');
    });
  });

  // =========================================================================
  // execute() — Fetch step
  // =========================================================================

  describe('execute - fetch step', () => {
    it('navigates to the given URL', async () => {
      const workflow = minimalWorkflow([
        { type: 'fetch', url: 'https://example.com/page' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(result.name).toBe('test-workflow');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].status).toBe('success');
      expect(result.steps[0].type).toBe('fetch');
      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com/page',
        { waitUntil: 'domcontentloaded' }
      );
    });

    it('interpolates variables in fetch URL', async () => {
      const workflow = minimalWorkflow(
        [{ type: 'fetch', url: 'https://{{domain}}/{{path}}' }],
        undefined,
        { domain: 'example.com', path: 'hello' }
      );

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com/hello',
        { waitUntil: 'domcontentloaded' }
      );
    });

    it('replaces missing variables with empty string in interpolation', async () => {
      const workflow = minimalWorkflow(
        [{ type: 'fetch', url: 'https://example.com/{{missing}}' }],
      );

      const result = await engine.execute(workflow);
      expect(result.status).toBe('completed');
      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com/',
        { waitUntil: 'domcontentloaded' }
      );
    });

    it('captures status code from page response', async () => {
      mockPage.goto.mockResolvedValueOnce({ status: () => 404 });
      const workflow = minimalWorkflow([
        { type: 'fetch', url: 'https://example.com/missing' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.steps[0].data).toEqual({
        url: 'https://example.com/missing',
        statusCode: 404,
      });
    });

    it('handles null response (no status code)', async () => {
      mockPage.goto.mockResolvedValueOnce(null);
      const workflow = minimalWorkflow([
        { type: 'fetch', url: 'https://example.com' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.steps[0].data).toEqual({
        url: 'https://example.com',
        statusCode: null,
      });
    });
  });

  // =========================================================================
  // execute() — Wait step
  // =========================================================================

  describe('execute - wait step', () => {
    it('waits for networkidle', async () => {
      const workflow = minimalWorkflow([
        { type: 'wait', condition: 'networkidle' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(mockPage.waitForLoadState).toHaveBeenCalledWith('networkidle');
    });

    it('waits for timeout with numeric value', async () => {
      const workflow = minimalWorkflow([
        { type: 'wait', condition: 'timeout', value: 500 },
      ]);

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(500);
    });

    it('waits for timeout with string value', async () => {
      const workflow = minimalWorkflow([
        { type: 'wait', condition: 'timeout', value: '2000' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(2000);
    });

    it('defaults to 1000ms for timeout with no value', async () => {
      const workflow = minimalWorkflow([
        { type: 'wait', condition: 'timeout' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(1000);
    });

    it('waits for selector with interpolation', async () => {
      const workflow = minimalWorkflow(
        [{ type: 'wait', condition: 'selector', value: '#{{elemId}}' }],
        undefined,
        { elemId: 'my-button' }
      );

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(mockPage.waitForSelector).toHaveBeenCalledWith('#my-button', {
        state: 'visible',
      });
    });

    it('throws error for selector wait with empty value', async () => {
      const workflow = minimalWorkflow([
        { type: 'wait', condition: 'selector', value: '' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.status).toBe('failed');
      expect(result.steps[0].error).toContain('requires a value');
    });
  });

  // =========================================================================
  // execute() — Extract step
  // =========================================================================

  describe('execute - extract step', () => {
    it('extracts content using distiller and stores extraction', async () => {
      vi.mocked(distillContent).mockResolvedValueOnce({
        title: 'Test Page',
        contentText: 'Distilled content here',
        contentHtml: '<p>Distilled content here</p>',
        contentLength: 22,
        extractionMethod: 'readability',
        extractionConfidence: 0.85,
      } as never);

      const workflow = minimalWorkflow([{ type: 'extract', policy: 'article' }]);

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(result.extractions).toHaveLength(1);
      expect(result.extractions[0].content).toBe('Distilled content here');
      expect(result.extractions[0].policy).toBe('article');
      expect(distillContent).toHaveBeenCalledWith(
        '<html><body>Hello</body></html>',
        'https://example.com',
        'article'
      );
    });

    it('uses default policy when not specified', async () => {
      vi.mocked(distillContent).mockResolvedValueOnce({
        title: 'Test',
        contentText: 'Content',
        contentHtml: '<p>Content</p>',
        contentLength: 7,
        extractionMethod: 'readability',
        extractionConfidence: 0.8,
      } as never);

      const workflow = minimalWorkflow([{ type: 'extract' }]);
      await engine.execute(workflow);

      expect(distillContent).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'default'
      );
    });

    it('saves extraction to variable when saveAs is specified', async () => {
      vi.mocked(distillContent).mockResolvedValueOnce({
        title: 'Test',
        contentText: 'Saved content',
        contentHtml: '<p>Saved content</p>',
        contentLength: 13,
        extractionMethod: 'readability',
        extractionConfidence: 0.8,
      } as never);

      const workflow = minimalWorkflow([
        { type: 'extract', saveAs: 'pageContent' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.variables['pageContent']).toBe('Saved content');
    });
  });

  // =========================================================================
  // execute() — Screenshot step
  // =========================================================================

  describe('execute - screenshot step', () => {
    it('takes a screenshot and stores it', async () => {
      mockScreenshot.mockResolvedValueOnce('base64-screenshot-data');

      const workflow = minimalWorkflow([{ type: 'screenshot' }]);

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(result.screenshots).toHaveLength(1);
      expect(result.screenshots[0].data).toBe('base64-screenshot-data');
      expect(mockScreenshot).toHaveBeenCalledWith(mockPage, { fullPage: false });
    });

    it('takes a full page screenshot when fullPage is true', async () => {
      mockScreenshot.mockResolvedValueOnce('full-page-data');

      const workflow = minimalWorkflow([
        { type: 'screenshot', fullPage: true },
      ]);

      const result = await engine.execute(workflow);

      expect(result.screenshots[0].data).toBe('full-page-data');
      expect(mockScreenshot).toHaveBeenCalledWith(mockPage, { fullPage: true });
    });

    it('saves screenshot to variable when saveAs is specified', async () => {
      mockScreenshot.mockResolvedValueOnce('saved-screenshot');

      const workflow = minimalWorkflow([
        { type: 'screenshot', saveAs: 'img' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.variables['img']).toBe('saved-screenshot');
    });
  });

  // =========================================================================
  // execute() — Interact step
  // =========================================================================

  describe('execute - interact step', () => {
    it('executes browser actions', async () => {
      mockExecuteActions.mockResolvedValueOnce([
        {
          action: { type: 'click', selector: '#btn' },
          success: true,
          duration: 50,
          data: null,
        },
      ]);

      const workflow = minimalWorkflow([
        {
          type: 'interact',
          actions: [{ type: 'click', selector: '#btn' }],
        },
      ]);

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(result.steps[0].status).toBe('success');
      expect(mockExecuteActions).toHaveBeenCalledOnce();
    });

    it('interpolates variables in action selectors and values', async () => {
      mockExecuteActions.mockResolvedValueOnce([
        {
          action: { type: 'fill', selector: '#input-field', value: 'hello' },
          success: true,
          duration: 30,
          data: null,
        },
      ]);

      const workflow = minimalWorkflow(
        [
          {
            type: 'interact',
            actions: [
              { type: 'fill', selector: '#{{inputId}}', value: '{{greeting}}' },
            ],
          },
        ],
        undefined,
        { inputId: 'input-field', greeting: 'hello' }
      );

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      const callArgs = mockExecuteActions.mock.calls[0][1];
      expect(callArgs[0].selector).toBe('#input-field');
      expect(callArgs[0].value).toBe('hello');
    });

    it('fails when an action fails', async () => {
      mockExecuteActions.mockResolvedValueOnce([
        {
          action: { type: 'click', selector: '#missing' },
          success: false,
          duration: 100,
          error: 'Element not found',
        },
      ]);

      const workflow = minimalWorkflow([
        {
          type: 'interact',
          actions: [{ type: 'click', selector: '#missing' }],
        },
      ]);

      const result = await engine.execute(workflow);

      expect(result.status).toBe('failed');
      expect(result.steps[0].status).toBe('failed');
      expect(result.steps[0].error).toContain('Element not found');
    });
  });

  // =========================================================================
  // execute() — SetVariable step
  // =========================================================================

  describe('execute - setVariable step', () => {
    it('sets a variable from a literal value', async () => {
      const workflow = minimalWorkflow([
        { type: 'setVariable', name: 'greeting', value: 'hello world' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(result.variables['greeting']).toBe('hello world');
    });

    it('interpolates variables in the value', async () => {
      const workflow = minimalWorkflow(
        [{ type: 'setVariable', name: 'full', value: '{{first}} {{last}}' }],
        undefined,
        { first: 'John', last: 'Doe' }
      );

      const result = await engine.execute(workflow);

      expect(result.variables['full']).toBe('John Doe');
    });

    it('sets a variable from page.evaluate (fromEval)', async () => {
      mockPage.evaluate.mockResolvedValueOnce('Page Title');

      const workflow = minimalWorkflow([
        { type: 'setVariable', name: 'title', fromEval: 'document.title' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.variables['title']).toBe('Page Title');
      expect(mockPage.evaluate).toHaveBeenCalled();
    });

    it('sets a variable from a DOM selector (fromSelector)', async () => {
      mockPage.$.mockResolvedValueOnce({
        textContent: vi.fn().mockResolvedValueOnce('Element Text'),
      });

      const workflow = minimalWorkflow([
        { type: 'setVariable', name: 'heading', fromSelector: 'h1' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.variables['heading']).toBe('Element Text');
    });

    it('sets null when selector finds no element', async () => {
      mockPage.$.mockResolvedValueOnce(null);

      const workflow = minimalWorkflow([
        { type: 'setVariable', name: 'absent', fromSelector: '#nonexistent' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.variables['absent']).toBeNull();
    });

    it('sets null when no value, fromEval, or fromSelector is provided', async () => {
      // Even though validate rejects this, execute should handle it gracefully
      const workflow = minimalWorkflow([
        { type: 'setVariable', name: 'empty' } as SetVariableStep,
      ]);

      const result = await engine.execute(workflow);

      expect(result.variables['empty']).toBeNull();
    });
  });

  // =========================================================================
  // execute() — Conditional (if) step
  // =========================================================================

  describe('execute - if step', () => {
    it('executes then branch when condition is true', async () => {
      mockScreenshot.mockResolvedValueOnce('screenshot-data');

      const workflow = minimalWorkflow(
        [
          {
            type: 'if',
            condition: 'flag === true',
            then: [{ type: 'screenshot' }],
            else: [{ type: 'wait', condition: 'networkidle' }],
          },
        ],
        undefined,
        { flag: 'true' } // Note: evaluated as JS, so the variable is the string 'true'
      );

      // Override variables to set flag as boolean true
      workflow.variables = undefined;
      // Use an approach that sets the actual boolean
      const boolWorkflow: WorkflowDefinition = {
        name: 'test-workflow',
        steps: [
          {
            type: 'if',
            condition: 'true',
            then: [{ type: 'screenshot' }],
            else: [{ type: 'wait', condition: 'networkidle' }],
          },
        ],
      };

      const result = await engine.execute(boolWorkflow);

      expect(result.status).toBe('completed');
      expect(mockScreenshot).toHaveBeenCalled();
      expect(mockPage.waitForLoadState).not.toHaveBeenCalled();
    });

    it('executes else branch when condition is false', async () => {
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        steps: [
          {
            type: 'if',
            condition: 'false',
            then: [{ type: 'screenshot' }],
            else: [{ type: 'wait', condition: 'networkidle' }],
          },
        ],
      };

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(mockScreenshot).not.toHaveBeenCalled();
      expect(mockPage.waitForLoadState).toHaveBeenCalledWith('networkidle');
    });

    it('returns branch "none" when condition is false and no else', async () => {
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        steps: [
          {
            type: 'if',
            condition: 'false',
            then: [{ type: 'screenshot' }],
          },
        ],
      };

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(mockScreenshot).not.toHaveBeenCalled();
    });

    it('evaluates condition using variables context', async () => {
      mockScreenshot.mockResolvedValueOnce('data');

      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        variables: { count: '5' as unknown as string },
        steps: [
          {
            type: 'if',
            condition: 'count > 3',
            then: [{ type: 'screenshot' }],
          },
        ],
      };
      // Manually set as number for the condition to work properly
      (workflow.variables as Record<string, unknown>)['count'] = 5;

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(mockScreenshot).toHaveBeenCalled();
    });

    it('fails when condition evaluation throws', async () => {
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        steps: [
          {
            type: 'if',
            condition: 'this.is.invalid.syntax(',
            then: [{ type: 'screenshot' }],
          },
        ],
      };

      const result = await engine.execute(workflow);

      expect(result.status).toBe('failed');
      expect(result.steps[0].error).toContain('Condition evaluation failed');
    });
  });

  // =========================================================================
  // execute() — Loop step
  // =========================================================================

  describe('execute - loop step', () => {
    it('loops N times with "times" property', async () => {
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        steps: [
          {
            type: 'loop',
            times: 3,
            steps: [{ type: 'wait', condition: 'networkidle' }],
          },
        ],
      };

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      // 3 wait steps + 1 loop step
      expect(mockPage.waitForLoadState).toHaveBeenCalledTimes(3);
    });

    it('iterates over an array variable', async () => {
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        steps: [
          {
            type: 'loop',
            over: 'urls',
            steps: [{ type: 'fetch', url: '{{__item}}' }],
          },
        ],
      };
      (workflow as { variables: Record<string, unknown> }).variables = {
        urls: ['https://a.com', 'https://b.com'],
      };

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(mockPage.goto).toHaveBeenCalledTimes(2);
      expect(mockPage.goto).toHaveBeenCalledWith('https://a.com', { waitUntil: 'domcontentloaded' });
      expect(mockPage.goto).toHaveBeenCalledWith('https://b.com', { waitUntil: 'domcontentloaded' });
    });

    it('sets __item and __index variables in loop body', async () => {
      // We'll use a setVariable to capture __index during each loop iteration
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        steps: [
          {
            type: 'loop',
            times: 2,
            steps: [{ type: 'setVariable', name: 'lastIndex', value: '{{__index}}' }],
          },
        ],
      };

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      // After loop, __index and __item should be cleaned up
      expect(result.variables['__index']).toBeUndefined();
      expect(result.variables['__item']).toBeUndefined();
      // lastIndex was set to '1' (the last iteration index as string)
      expect(result.variables['lastIndex']).toBe('1');
    });

    it('respects maxIterations limit', async () => {
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        steps: [
          {
            type: 'loop',
            times: 100,
            maxIterations: 3,
            steps: [{ type: 'wait', condition: 'networkidle' }],
          },
        ],
      };

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(mockPage.waitForLoadState).toHaveBeenCalledTimes(3);
    });

    it('respects default maxIterations of 50 for "over" loops', async () => {
      const largeArray = Array.from({ length: 100 }, (_, i) => `https://example.com/${i}`);
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        steps: [
          {
            type: 'loop',
            over: 'pages',
            steps: [{ type: 'wait', condition: 'networkidle' }],
          },
        ],
      };
      (workflow as { variables: Record<string, unknown> }).variables = {
        pages: largeArray,
      };

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(mockPage.waitForLoadState).toHaveBeenCalledTimes(50);
    });

    it('breaks loop when breakIf evaluates to true', async () => {
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        steps: [
          {
            type: 'loop',
            times: 10,
            breakIf: '__index >= 2',
            steps: [{ type: 'wait', condition: 'networkidle' }],
          },
        ],
      };

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      // breakIf is checked before executing the step body, so:
      // iteration 0: breakIf(0>=2)=false, execute, iterations=1
      // iteration 1: breakIf(1>=2)=false, execute, iterations=2
      // iteration 2: breakIf(2>=2)=true, break
      expect(mockPage.waitForLoadState).toHaveBeenCalledTimes(2);
    });

    it('throws when loop variable is not an array', async () => {
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        steps: [
          {
            type: 'loop',
            over: 'notArray',
            steps: [{ type: 'wait', condition: 'networkidle' }],
          },
        ],
      };
      (workflow as { variables: Record<string, unknown> }).variables = {
        notArray: 'string-not-array',
      };

      const result = await engine.execute(workflow);

      expect(result.status).toBe('failed');
      expect(result.steps[0].error).toContain('not an array');
    });

    it('throws when loop has neither over nor times', async () => {
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        steps: [
          {
            type: 'loop',
            steps: [{ type: 'wait', condition: 'networkidle' }],
          } as LoopStep,
        ],
      };

      const result = await engine.execute(workflow);

      expect(result.status).toBe('failed');
      expect(result.steps[0].error).toContain('requires either "over"');
    });

    it('breakIf works in "over" loops', async () => {
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        steps: [
          {
            type: 'loop',
            over: 'items',
            breakIf: '__item === "stop"',
            steps: [{ type: 'wait', condition: 'networkidle' }],
          },
        ],
      };
      (workflow as { variables: Record<string, unknown> }).variables = {
        items: ['go', 'go', 'stop', 'nope'],
      };

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      // Items: go(execute), go(execute), stop(break)
      expect(mockPage.waitForLoadState).toHaveBeenCalledTimes(2);
    });

    it('breakIf evaluation error throws', async () => {
      const workflow: WorkflowDefinition = {
        name: 'test-workflow',
        steps: [
          {
            type: 'loop',
            times: 3,
            breakIf: 'this.is.invalid(',
            steps: [{ type: 'wait', condition: 'networkidle' }],
          },
        ],
      };

      const result = await engine.execute(workflow);

      expect(result.status).toBe('failed');
      expect(result.error).toBeDefined();
    });
  });

  // =========================================================================
  // execute() — Error handling and continueOnError
  // =========================================================================

  describe('execute - error handling', () => {
    it('aborts on step failure when continueOnError is false (default)', async () => {
      mockPage.goto.mockRejectedValueOnce(new Error('Network error'));

      const workflow = minimalWorkflow([
        { type: 'fetch', url: 'https://bad.com' },
        { type: 'wait', condition: 'networkidle' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.status).toBe('failed');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].status).toBe('failed');
      // Second step should not have been reached
      expect(mockPage.waitForLoadState).not.toHaveBeenCalled();
    });

    it('continues after failure when continueOnError is true', async () => {
      mockPage.goto.mockRejectedValueOnce(new Error('Network error'));

      const workflow = minimalWorkflow(
        [
          { type: 'fetch', url: 'https://bad.com' },
          { type: 'wait', condition: 'networkidle' },
        ],
        { continueOnError: true }
      );

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].status).toBe('failed');
      expect(result.steps[1].status).toBe('success');
    });

    it('returns failed status when session page cannot be obtained', async () => {
      mockGetSessionPage.mockRejectedValueOnce(new Error('No browser'));

      const workflow = minimalWorkflow([
        { type: 'fetch', url: 'https://example.com' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Failed to obtain session page');
      expect(result.steps).toHaveLength(0);
    });

    it('closes session even when getSessionPage fails', async () => {
      mockGetSessionPage.mockRejectedValueOnce(new Error('No browser'));

      const workflow = minimalWorkflow([
        { type: 'fetch', url: 'https://example.com' },
      ]);

      await engine.execute(workflow);

      expect(mockCloseSession).toHaveBeenCalledWith('session-123');
    });

    it('handles session close failure gracefully', async () => {
      mockCloseSession.mockRejectedValueOnce(new Error('Close failed'));

      const workflow = minimalWorkflow([
        { type: 'fetch', url: 'https://example.com' },
      ]);

      // Should not throw
      const result = await engine.execute(workflow);
      expect(result.status).toBe('completed');
    });
  });

  // =========================================================================
  // execute() — Timeout
  // =========================================================================

  describe('execute - timeout', () => {
    it('times out when workflow exceeds timeout', async () => {
      // Make a step that takes forever
      mockPage.waitForLoadState.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 10000))
      );

      const workflow = minimalWorkflow(
        [{ type: 'wait', condition: 'networkidle' }],
        { timeout: 50 }
      );

      const result = await engine.execute(workflow);

      expect(result.status).toBe('timeout');
      expect(result.error).toContain('timed out');
    });
  });

  // =========================================================================
  // execute() — Session management
  // =========================================================================

  describe('execute - session management', () => {
    it('creates a session with workflow name', async () => {
      const workflow = minimalWorkflow([
        { type: 'fetch', url: 'https://example.com' },
      ]);

      await engine.execute(workflow);

      expect(mockCreateSession).toHaveBeenCalledWith({
        name: 'workflow:test-workflow',
        ttl: 1800, // default
      });
    });

    it('uses custom session TTL', async () => {
      const workflow = minimalWorkflow(
        [{ type: 'fetch', url: 'https://example.com' }],
        { sessionTtl: 600 }
      );

      await engine.execute(workflow);

      expect(mockCreateSession).toHaveBeenCalledWith({
        name: 'workflow:test-workflow',
        ttl: 600,
      });
    });

    it('always closes session in finally block', async () => {
      const workflow = minimalWorkflow([
        { type: 'fetch', url: 'https://example.com' },
      ]);

      await engine.execute(workflow);

      expect(mockCloseSession).toHaveBeenCalledWith('session-123');
    });
  });

  // =========================================================================
  // execute() — Result structure
  // =========================================================================

  describe('execute - result structure', () => {
    it('includes totalDuration', async () => {
      const workflow = minimalWorkflow([
        { type: 'fetch', url: 'https://example.com' },
      ]);

      const result = await engine.execute(workflow);

      expect(typeof result.totalDuration).toBe('number');
      expect(result.totalDuration).toBeGreaterThanOrEqual(0);
    });

    it('returns initial variables in result', async () => {
      const workflow = minimalWorkflow(
        [{ type: 'fetch', url: 'https://example.com' }],
        undefined,
        { key: 'value' }
      );

      const result = await engine.execute(workflow);

      expect(result.variables['key']).toBe('value');
    });

    it('preserves step IDs when provided', async () => {
      const workflow = minimalWorkflow([
        { id: 'my-fetch', type: 'fetch', url: 'https://example.com' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.steps[0].id).toBe('my-fetch');
    });

    it('auto-generates step IDs when not provided', async () => {
      const workflow = minimalWorkflow([
        { type: 'fetch', url: 'https://example.com' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.steps[0].id).toMatch(/^fetch_\d+$/);
    });
  });

  // =========================================================================
  // execute() — Multi-step workflows
  // =========================================================================

  describe('execute - multi-step workflows', () => {
    it('executes a multi-step fetch -> extract -> screenshot workflow', async () => {
      vi.mocked(distillContent).mockResolvedValueOnce({
        title: 'Test',
        contentText: 'extracted',
        contentHtml: '<p>extracted</p>',
        contentLength: 9,
        extractionMethod: 'readability',
        extractionConfidence: 0.9,
      } as never);
      mockScreenshot.mockResolvedValueOnce('screenshot-base64');

      const workflow = minimalWorkflow([
        { id: 'step-1', type: 'fetch', url: 'https://example.com' },
        { id: 'step-2', type: 'extract', saveAs: 'content' },
        { id: 'step-3', type: 'screenshot', saveAs: 'shot' },
      ]);

      const result = await engine.execute(workflow);

      expect(result.status).toBe('completed');
      expect(result.steps).toHaveLength(3);
      expect(result.steps.map((s) => s.status)).toEqual(['success', 'success', 'success']);
      expect(result.extractions).toHaveLength(1);
      expect(result.screenshots).toHaveLength(1);
      expect(result.variables['content']).toBe('extracted');
      expect(result.variables['shot']).toBe('screenshot-base64');
    });

    it('each step records its duration', async () => {
      const workflow = minimalWorkflow([
        { type: 'fetch', url: 'https://example.com' },
        { type: 'wait', condition: 'networkidle' },
      ]);

      const result = await engine.execute(workflow);

      for (const step of result.steps) {
        expect(typeof step.duration).toBe('number');
        expect(step.duration).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
