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
  it('registers all four tools', () => {
    expect(registeredTools.has('anno_fetch')).toBe(true);
    expect(registeredTools.has('anno_batch_fetch')).toBe(true);
    expect(registeredTools.has('anno_crawl')).toBe(true);
    expect(registeredTools.has('anno_health')).toBe(true);
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
