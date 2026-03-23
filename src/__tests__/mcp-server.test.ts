import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the MCP SDK before importing the server module.
// The module registers tools on a global McpServer singleton and calls main()
// at module scope, so we capture the tool handlers during import.
// ---------------------------------------------------------------------------

const registeredTools: Map<string, { handler: (...args: unknown[]) => unknown; schema: unknown; description: string }> = new Map();

const mockConnect = vi.fn().mockResolvedValue(undefined);

// Use function keyword so it can be called with `new`
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: function McpServer() {
    return {
      tool(name: string, description: string, schema: unknown, handler: (...args: unknown[]) => unknown) {
        registeredTools.set(name, { handler, schema, description });
      },
      connect: mockConnect,
    };
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: function StdioServerTransport() {
    return {};
  },
}));

// Save and restore originals
const originalFetch = global.fetch;
const originalStderrWrite = process.stderr.write;
const originalExit = process.exit;

beforeAll(async () => {
  // Suppress stderr and prevent process.exit during import
  process.stderr.write = vi.fn() as unknown as typeof process.stderr.write;
  process.exit = vi.fn() as unknown as typeof process.exit;

  // Import once — this triggers tool registration and main()
  await import('../mcp/server');

  // Wait for main() promise to settle
  await new Promise(resolve => setTimeout(resolve, 50));
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  global.fetch = originalFetch;
});

afterAll(() => {
  process.stderr.write = originalStderrWrite;
  process.exit = originalExit;
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe('MCP Server tool registration', () => {
  it('registers all eleven tools', () => {
    expect(registeredTools.has('anno_fetch')).toBe(true);
    expect(registeredTools.has('anno_batch_fetch')).toBe(true);
    expect(registeredTools.has('anno_crawl')).toBe(true);
    expect(registeredTools.has('anno_health')).toBe(true);
    expect(registeredTools.has('anno_session_auth')).toBe(true);
    expect(registeredTools.has('anno_interact')).toBe(true);
    expect(registeredTools.has('anno_screenshot')).toBe(true);
    expect(registeredTools.has('anno_page_state')).toBe(true);
    expect(registeredTools.has('anno_workflow')).toBe(true);
    expect(registeredTools.has('anno_watch')).toBe(true);
    expect(registeredTools.has('anno_search')).toBe(true);
    expect(registeredTools.has('anno_observe')).toBe(true);
  });

  it('each tool has a description', () => {
    for (const [_name, tool] of registeredTools) {
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// anno_health tool
// ---------------------------------------------------------------------------

describe('anno_health', () => {
  it('returns healthy status when server responds 200', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', uptime: 1234 }),
    });

    const handler = registeredTools.get('anno_health')!.handler;
    const result = await handler({});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('Anno is healthy');
    expect(result.content[0].text).toContain('uptime');
  });

  it('returns unhealthy when server responds non-200', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    const handler = registeredTools.get('anno_health')!.handler;
    const result = await handler({});

    expect(result.content[0].text).toContain('unhealthy');
    expect(result.content[0].text).toContain('503');
  });

  it('handles connection refused error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const handler = registeredTools.get('anno_health')!.handler;
    const result = await handler({});

    expect(result.content[0].text).toContain('not reachable');
  });

  it('handles generic errors', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network timeout'));

    const handler = registeredTools.get('anno_health')!.handler;
    const result = await handler({});

    expect(result.content[0].text).toContain('network timeout');
  });
});

// ---------------------------------------------------------------------------
// anno_fetch tool
// ---------------------------------------------------------------------------

describe('anno_fetch', () => {
  it('returns formatted content on success', async () => {
    const ndjson = [
      JSON.stringify({ type: 'metadata', payload: { title: 'Test Page', url: 'https://example.com', extractionMethod: 'readability', confidence: 0.9 } }),
      JSON.stringify({ type: 'node', payload: { type: 'paragraph', text: 'Hello world' } }),
      JSON.stringify({ type: 'node', payload: { type: 'heading', text: 'Section 1' } }),
    ].join('\n');

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => ndjson,
    });

    const handler = registeredTools.get('anno_fetch')!.handler;
    const result = await handler({ url: 'https://example.com', render: false, maxNodes: 60 });

    expect(result.content[0].text).toContain('# Test Page');
    expect(result.content[0].text).toContain('Hello world');
    expect(result.content[0].text).toContain('## Section 1');
  });

  it('includes extraction method and source URL in output', async () => {
    const ndjson = [
      JSON.stringify({ type: 'metadata', payload: { title: 'Page', url: 'https://example.com', extractionMethod: 'dom-heuristic', confidence: 0.8 } }),
    ].join('\n');

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => ndjson,
    });

    const handler = registeredTools.get('anno_fetch')!.handler;
    const result = await handler({ url: 'https://example.com', render: false, maxNodes: 60 });

    expect(result.content[0].text).toContain('Source: https://example.com');
    expect(result.content[0].text).toContain('dom-heuristic');
  });

  it('returns error message when server responds with error status', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Invalid URL' }),
    });

    const handler = registeredTools.get('anno_fetch')!.handler;
    const result = await handler({ url: 'https://bad.com', render: false, maxNodes: 60 });

    expect(result.content[0].text).toContain('Anno fetch failed');
    expect(result.content[0].text).toContain('400');
  });

  it('returns ECONNREFUSED message when server is down', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const handler = registeredTools.get('anno_fetch')!.handler;
    const result = await handler({ url: 'https://example.com', render: false, maxNodes: 60 });

    expect(result.content[0].text).toContain('not running');
    expect(result.content[0].text).toContain('npm start');
  });

  it('handles generic fetch errors', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('DNS resolution failed'));

    const handler = registeredTools.get('anno_fetch')!.handler;
    const result = await handler({ url: 'https://example.com', render: false, maxNodes: 60 });

    expect(result.content[0].text).toContain('Anno fetch error');
    expect(result.content[0].text).toContain('DNS resolution failed');
  });

  it('handles NDJSON with error event', async () => {
    const ndjson = [
      JSON.stringify({ type: 'error', payload: { message: 'Extraction failed' } }),
    ].join('\n');

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => ndjson,
    });

    const handler = registeredTools.get('anno_fetch')!.handler;
    const result = await handler({ url: 'https://example.com', render: false, maxNodes: 60 });

    expect(result.content[0].text).toContain('Error: Extraction failed');
  });

  it('returns "No content extracted." for empty events', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '',
    });

    const handler = registeredTools.get('anno_fetch')!.handler;
    const result = await handler({ url: 'https://example.com', render: false, maxNodes: 60 });

    expect(result.content[0].text).toContain('No content extracted.');
  });
});

// ---------------------------------------------------------------------------
// anno_batch_fetch tool
// ---------------------------------------------------------------------------

describe('anno_batch_fetch', () => {
  it('returns formatted content for multiple URLs', async () => {
    const ndjson = [
      JSON.stringify({ type: 'source_event', payload: { index: 0, event: { type: 'node', text: 'Content A' } } }),
      JSON.stringify({ type: 'source_end', payload: { index: 0, status: 'ok' } }),
      JSON.stringify({ type: 'source_event', payload: { index: 1, event: { type: 'node', text: 'Content B' } } }),
      JSON.stringify({ type: 'source_end', payload: { index: 1, status: 'ok' } }),
    ].join('\n');

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => ndjson,
    });

    const handler = registeredTools.get('anno_batch_fetch')!.handler;
    const result = await handler({
      urls: ['https://a.com', 'https://b.com'],
      render: false,
      parallel: 3,
    });

    expect(result.content[0].text).toContain('Source 1: https://a.com');
    expect(result.content[0].text).toContain('Source 2: https://b.com');
  });

  it('returns error for failed sources', async () => {
    const ndjson = [
      JSON.stringify({ type: 'source_end', payload: { index: 0, status: 'error', error: 'Timeout' } }),
    ].join('\n');

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => ndjson,
    });

    const handler = registeredTools.get('anno_batch_fetch')!.handler;
    const result = await handler({
      urls: ['https://a.com'],
      render: false,
      parallel: 3,
    });

    expect(result.content[0].text).toContain('Error: Timeout');
  });

  it('handles server error response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal error' }),
    });

    const handler = registeredTools.get('anno_batch_fetch')!.handler;
    const result = await handler({
      urls: ['https://a.com'],
      render: false,
      parallel: 3,
    });

    expect(result.content[0].text).toContain('batch fetch failed');
    expect(result.content[0].text).toContain('500');
  });

  it('handles ECONNREFUSED for batch fetch', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const handler = registeredTools.get('anno_batch_fetch')!.handler;
    const result = await handler({
      urls: ['https://a.com'],
      render: false,
      parallel: 3,
    });

    expect(result.content[0].text).toContain('not running');
  });

  it('handles generic error for batch fetch', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('some network issue'));

    const handler = registeredTools.get('anno_batch_fetch')!.handler;
    const result = await handler({
      urls: ['https://a.com'],
      render: false,
      parallel: 3,
    });

    expect(result.content[0].text).toContain('batch fetch error');
    expect(result.content[0].text).toContain('some network issue');
  });
});

// ---------------------------------------------------------------------------
// anno_crawl tool
// ---------------------------------------------------------------------------

describe('anno_crawl', () => {
  it('returns completed crawl results', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // POST /v1/crawl — start crawl
        return {
          ok: true,
          json: async () => ({ jobId: 'job-123' }),
        };
      }
      if (callCount === 2) {
        // GET /v1/crawl/job-123 — status poll
        return {
          ok: true,
          json: async () => ({ status: 'completed', progress: { pagesCompleted: 2, pagesTotal: 2 } }),
        };
      }
      if (callCount === 3) {
        // GET /v1/crawl/job-123/results
        return {
          ok: true,
          json: async () => ({
            pages: [
              { url: 'https://a.com', title: 'Page A', content: 'Content A' },
              { url: 'https://a.com/sub', title: 'Page B', content: 'Content B' },
            ],
            stats: { totalPages: 2 },
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    const handler = registeredTools.get('anno_crawl')!.handler;
    const result = await handler({
      url: 'https://a.com',
      maxDepth: 2,
      maxPages: 20,
      renderJs: false,
    });

    expect(result.content[0].text).toContain('Crawl completed: 2 pages');
    expect(result.content[0].text).toContain('Page A');
    expect(result.content[0].text).toContain('Page B');
  });

  it('handles crawl start failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Invalid crawl config' }),
    });

    const handler = registeredTools.get('anno_crawl')!.handler;
    const result = await handler({
      url: 'https://a.com',
      maxDepth: 2,
      maxPages: 20,
      renderJs: false,
    });

    expect(result.content[0].text).toContain('Anno crawl failed');
    expect(result.content[0].text).toContain('400');
  });

  it('handles crawl error status', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => ({ jobId: 'job-err' }) };
      }
      return {
        ok: true,
        json: async () => ({ status: 'error', progress: { pagesCompleted: 0, pagesTotal: 0 }, error: 'Crawl failed' }),
      };
    });

    const handler = registeredTools.get('anno_crawl')!.handler;
    const result = await handler({
      url: 'https://a.com',
      maxDepth: 2,
      maxPages: 20,
      renderJs: false,
    });

    expect(result.content[0].text).toContain('Crawl error');
    expect(result.content[0].text).toContain('Crawl failed');
  });

  it('handles ECONNREFUSED for crawl', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const handler = registeredTools.get('anno_crawl')!.handler;
    const result = await handler({
      url: 'https://a.com',
      maxDepth: 2,
      maxPages: 20,
      renderJs: false,
    });

    expect(result.content[0].text).toContain('not running');
  });

  it('handles generic crawl errors', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('unexpected issue'));

    const handler = registeredTools.get('anno_crawl')!.handler;
    const result = await handler({
      url: 'https://a.com',
      maxDepth: 2,
      maxPages: 20,
      renderJs: false,
    });

    expect(result.content[0].text).toContain('Anno crawl error');
    expect(result.content[0].text).toContain('unexpected issue');
  });

  it('handles cancelled crawl', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => ({ jobId: 'job-cancel' }) };
      }
      return {
        ok: true,
        json: async () => ({ status: 'cancelled', progress: { pagesCompleted: 0, pagesTotal: 0 } }),
      };
    });

    const handler = registeredTools.get('anno_crawl')!.handler;
    const result = await handler({
      url: 'https://a.com',
      maxDepth: 2,
      maxPages: 20,
      renderJs: false,
    });

    expect(result.content[0].text).toContain('Crawl cancelled');
  });
});

// ---------------------------------------------------------------------------
// anno_interact tool
// ---------------------------------------------------------------------------

describe('anno_interact', () => {
  it('returns action results and page state on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        results: [{ action: 'click', success: true }],
        pageState: { url: 'https://example.com', interactiveElements: [] },
        totalDuration: 500,
      }),
    });

    const handler = registeredTools.get('anno_interact')!.handler;
    const result = await handler({
      url: 'https://example.com',
      actions: [{ type: 'click', selector: '#btn' }],
      extract: false,
      extractPolicy: 'default',
    });

    expect(result.content[0].text).toContain('success');
    expect(result.content[0].text).toContain('click');
  });

  it('handles server error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Bad request' }),
    });

    const handler = registeredTools.get('anno_interact')!.handler;
    const result = await handler({
      url: 'https://example.com',
      actions: [],
      extract: false,
      extractPolicy: 'default',
    });

    expect(result.content[0].text).toContain('interact failed');
    expect(result.content[0].text).toContain('400');
  });

  it('handles ECONNREFUSED', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const handler = registeredTools.get('anno_interact')!.handler;
    const result = await handler({
      url: 'https://example.com',
      actions: [],
      extract: false,
      extractPolicy: 'default',
    });

    expect(result.content[0].text).toContain('not running');
  });

  it('passes sessionId and createSession in request body', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, results: [], pageState: {}, sessionId: 'sess-123' }),
    });

    const handler = registeredTools.get('anno_interact')!.handler;
    await handler({
      url: 'https://example.com',
      actions: [],
      extract: false,
      extractPolicy: 'default',
      sessionId: 'sess-123',
      createSession: true,
    });

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.sessionId).toBe('sess-123');
    expect(body.createSession).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// anno_screenshot tool
// ---------------------------------------------------------------------------

describe('anno_screenshot', () => {
  it('returns image content and page state on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        screenshot: 'base64encodeddata',
        pageState: { url: 'https://example.com', title: 'Test' },
      }),
    });

    const handler = registeredTools.get('anno_screenshot')!.handler;
    const result = await handler({
      url: 'https://example.com',
      actions: [],
      fullPage: false,
    });

    // Should have image + text content blocks
    expect(result.content.length).toBe(2);
    expect(result.content[0].type).toBe('image');
    expect(result.content[0].data).toBe('base64encodeddata');
    expect(result.content[1].type).toBe('text');
  });

  it('handles missing screenshot gracefully', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        pageState: { url: 'https://example.com', title: 'Test' },
      }),
    });

    const handler = registeredTools.get('anno_screenshot')!.handler;
    const result = await handler({
      url: 'https://example.com',
      actions: [],
      fullPage: false,
    });

    // Only text content (no image when screenshot is missing)
    expect(result.content.length).toBe(1);
    expect(result.content[0].type).toBe('text');
  });

  it('handles ECONNREFUSED', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const handler = registeredTools.get('anno_screenshot')!.handler;
    const result = await handler({
      url: 'https://example.com',
      actions: [],
      fullPage: false,
    });

    expect(result.content[0].text).toContain('not running');
  });
});

// ---------------------------------------------------------------------------
// anno_page_state tool
// ---------------------------------------------------------------------------

describe('anno_page_state', () => {
  it('returns page state on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        pageState: {
          url: 'https://example.com',
          interactiveElements: [
            { type: 'button', selector: '#submit', text: 'Submit' },
            { type: 'input', selector: '#email', text: '' },
          ],
        },
      }),
    });

    const handler = registeredTools.get('anno_page_state')!.handler;
    const result = await handler({
      url: 'https://example.com',
      actions: [],
    });

    expect(result.content[0].text).toContain('button');
    expect(result.content[0].text).toContain('Submit');
    expect(result.content[0].text).toContain('input');
  });

  it('handles server error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal error' }),
    });

    const handler = registeredTools.get('anno_page_state')!.handler;
    const result = await handler({
      url: 'https://example.com',
      actions: [],
    });

    expect(result.content[0].text).toContain('page-state failed');
  });
});

// ---------------------------------------------------------------------------
// anno_workflow tool
// ---------------------------------------------------------------------------

describe('anno_workflow', () => {
  it('returns workflow results on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          status: 'completed',
          steps: [{ id: 'step1', status: 'completed' }],
          extractions: [],
          screenshots: [],
          totalDuration: 1000,
        },
      }),
    });

    const handler = registeredTools.get('anno_workflow')!.handler;
    const result = await handler({
      workflow: {
        name: 'test-workflow',
        steps: [{ type: 'fetch', url: 'https://example.com' }],
      },
    });

    expect(result.content[0].text).toContain('completed');
    expect(result.content[0].text).toContain('step1');
  });

  it('handles workflow failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Invalid workflow' }),
    });

    const handler = registeredTools.get('anno_workflow')!.handler;
    const result = await handler({
      workflow: {
        name: 'bad-workflow',
        steps: [{ type: 'invalid' }],
      },
    });

    expect(result.content[0].text).toContain('workflow failed');
  });

  it('handles ECONNREFUSED', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const handler = registeredTools.get('anno_workflow')!.handler;
    const result = await handler({
      workflow: {
        name: 'test',
        steps: [{ type: 'fetch', url: 'https://example.com' }],
      },
    });

    expect(result.content[0].text).toContain('not running');
  });
});

// ---------------------------------------------------------------------------
// anno_watch tool
// ---------------------------------------------------------------------------

describe('anno_watch', () => {
  it('creates a new watch', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ watchId: 'watch-123', url: 'https://example.com', interval: 3600 }),
    });

    const handler = registeredTools.get('anno_watch')!.handler;
    const result = await handler({
      url: 'https://example.com',
      interval: 3600,
      changeThreshold: 1,
    });

    expect(result.content[0].text).toContain('watch-123');
  });

  it('checks status of existing watch', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ watchId: 'watch-123', status: 'active', lastCheck: '2026-03-23' }),
    });

    const handler = registeredTools.get('anno_watch')!.handler;
    const result = await handler({
      watchId: 'watch-123',
      interval: 3600,
      changeThreshold: 1,
    });

    expect(result.content[0].text).toContain('active');

    // Should call GET, not POST
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toContain('/v1/watch/watch-123');
  });

  it('requires url when creating a new watch', async () => {
    const handler = registeredTools.get('anno_watch')!.handler;
    const result = await handler({
      interval: 3600,
      changeThreshold: 1,
    });

    expect(result.content[0].text).toContain('url is required');
  });

  it('handles ECONNREFUSED', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const handler = registeredTools.get('anno_watch')!.handler;
    const result = await handler({
      url: 'https://example.com',
      interval: 3600,
      changeThreshold: 1,
    });

    expect(result.content[0].text).toContain('not running');
  });
});

// ---------------------------------------------------------------------------
// anno_search tool
// ---------------------------------------------------------------------------

describe('anno_search', () => {
  it('returns search results on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { id: 'doc1', score: 0.95, text: 'Relevant content' },
          { id: 'doc2', score: 0.82, text: 'Also relevant' },
        ],
      }),
    });

    const handler = registeredTools.get('anno_search')!.handler;
    const result = await handler({ query: 'test query' });

    expect(result.content[0].text).toContain('doc1');
    expect(result.content[0].text).toContain('0.95');
  });

  it('handles server error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Vector store unavailable' }),
    });

    const handler = registeredTools.get('anno_search')!.handler;
    const result = await handler({ query: 'test' });

    expect(result.content[0].text).toContain('search failed');
  });

  it('handles ECONNREFUSED', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const handler = registeredTools.get('anno_search')!.handler;
    const result = await handler({ query: 'test' });

    expect(result.content[0].text).toContain('not running');
  });
});

// ---------------------------------------------------------------------------
// anno_observe tool
// ---------------------------------------------------------------------------

describe('anno_observe', () => {
  it('returns page observation on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: 'https://example.com',
        title: 'Example',
        pageType: 'article',
        confidence: 0.85,
        interactiveElements: { buttons: 2, links: 10, inputs: 0, selects: 0, textareas: 0, total: 12 },
        navigation: [{ text: 'Home', href: '/', selector: 'nav a:first-of-type' }],
        detectedPatterns: [],
        contentSummary: { headings: ['Main Title'], textLength: 5000, imageCount: 3, formCount: 0 },
      }),
    });

    const handler = registeredTools.get('anno_observe')!.handler;
    const result = await handler({ url: 'https://example.com' });

    expect(result.content[0].text).toContain('article');
    expect(result.content[0].text).toContain('0.85');
    expect(result.content[0].text).toContain('Main Title');
  });

  it('passes sessionId in request', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pageType: 'unknown', confidence: 0.1 }),
    });

    const handler = registeredTools.get('anno_observe')!.handler;
    await handler({ url: 'https://example.com', sessionId: 'sess-abc', createSession: false });

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.sessionId).toBe('sess-abc');
  });

  it('handles server error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Observe failed' }),
    });

    const handler = registeredTools.get('anno_observe')!.handler;
    const result = await handler({ url: 'https://example.com' });

    expect(result.content[0].text).toContain('observe failed');
  });

  it('handles ECONNREFUSED', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const handler = registeredTools.get('anno_observe')!.handler;
    const result = await handler({ url: 'https://example.com' });

    expect(result.content[0].text).toContain('not running');
  });
});

// ---------------------------------------------------------------------------
// anno_session_auth tool (sessionId threading)
// ---------------------------------------------------------------------------

describe('anno_session_auth', () => {
  it('passes createSession in request body', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        cookies: [{ name: 'cf_clearance', value: 'abc', domain: '.example.com' }],
        challengeDetected: false,
        rendered: true,
        sessionId: 'sess-new',
      }),
    });

    const handler = registeredTools.get('anno_session_auth')!.handler;
    const result = await handler({
      domain: 'example.com',
      url: 'https://example.com',
      createSession: true,
    });

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.createSession).toBe(true);
    expect(result.content[0].text).toContain('sess-new');
  });

  it('handles ECONNREFUSED', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const handler = registeredTools.get('anno_session_auth')!.handler;
    const result = await handler({
      domain: 'example.com',
      url: 'https://example.com',
    });

    expect(result.content[0].text).toContain('not running');
  });
});
