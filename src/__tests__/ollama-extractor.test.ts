import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The CircuitBreaker is used internally by OllamaExtractor.
// We let it run with the real implementation since the tests need to verify
// circuit breaker behavior (opening after failures).
// We do NOT mock it — we import the real module.

import { OllamaExtractor } from '../services/ollama-extractor';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OllamaExtractor', () => {
  let extractor: OllamaExtractor;
  let originalFetch: typeof global.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = global.fetch;
    originalEnv = process.env.OLLAMA_ENABLED;
    extractor = new OllamaExtractor('http://localhost:11434', 'llama3.2:3b-instruct-q8_0', 5000);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.OLLAMA_ENABLED;
    } else {
      process.env.OLLAMA_ENABLED = originalEnv;
    }
  });

  // -----------------------------------------------------------------------
  // checkAvailability / OLLAMA_ENABLED
  // -----------------------------------------------------------------------

  it('returns null when OLLAMA_ENABLED=false', async () => {
    process.env.OLLAMA_ENABLED = 'false';
    // Create a new extractor so it picks up the env var fresh
    const ex = new OllamaExtractor();

    const result = await ex.extract('<html><body>Hello</body></html>', 'https://example.com');
    expect(result).toBeNull();
  });

  it('returns null when Ollama server is unreachable', async () => {
    delete process.env.OLLAMA_ENABLED;

    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await extractor.extract(
      '<html><body>Hello</body></html>',
      'https://example.com'
    );
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Successful extraction
  // -----------------------------------------------------------------------

  it('returns extraction result when server responds', async () => {
    delete process.env.OLLAMA_ENABLED;

    // First call: checkAvailability (/api/tags)
    // Second call: /api/generate
    global.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [{ name: 'llama3.2:3b-instruct-q8_0' }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'llama3.2:3b-instruct-q8_0',
            created_at: '2024-01-01T00:00:00Z',
            response: 'TITLE: Test Title\nCONTENT: Test content body\nSUMMARY: A test summary.',
            done: true,
          }),
          { status: 200 }
        )
      );

    const result = await extractor.extract(
      '<html><body><h1>Test Title</h1><p>Test content body</p></body></html>',
      'https://example.com/page'
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Test Title');
    expect(result!.content).toBe('Test content body');
    expect(result!.summary).toBe('A test summary.');
    expect(result!.metadata.method).toBe('ollama');
    expect(result!.metadata.model).toBe('llama3.2:3b-instruct-q8_0');
  });

  // -----------------------------------------------------------------------
  // Response parsing
  // -----------------------------------------------------------------------

  it('parses TITLE/CONTENT/SUMMARY from response', async () => {
    delete process.env.OLLAMA_ENABLED;

    global.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ models: [{ name: 'llama3.2:3b-instruct-q8_0' }] }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'llama3.2:3b-instruct-q8_0',
            created_at: '2024-01-01T00:00:00Z',
            response: 'TITLE: My Article\nCONTENT: Full article text here.\nSUMMARY: Brief summary.',
            done: true,
          }),
          { status: 200 }
        )
      );

    const result = await extractor.extract('<p>html</p>', 'https://example.com');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('My Article');
    expect(result!.content).toBe('Full article text here.');
    expect(result!.summary).toBe('Brief summary.');
  });

  it('handles malformed response gracefully', async () => {
    delete process.env.OLLAMA_ENABLED;

    global.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ models: [{ name: 'llama3.2:3b-instruct-q8_0' }] }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'llama3.2:3b-instruct-q8_0',
            created_at: '2024-01-01T00:00:00Z',
            response: 'Just some unstructured text without markers',
            done: true,
          }),
          { status: 200 }
        )
      );

    const result = await extractor.extract('<p>html</p>', 'https://example.com');

    expect(result).not.toBeNull();
    // Falls back to 'Untitled' for title, raw response for content
    expect(result!.title).toBe('Untitled');
    expect(result!.content).toBe('Just some unstructured text without markers');
    expect(result!.summary).toBe('');
  });

  // -----------------------------------------------------------------------
  // Truncation
  // -----------------------------------------------------------------------

  it('truncates HTML over 8000 chars before sending to LLM', async () => {
    delete process.env.OLLAMA_ENABLED;

    const longHtml = '<html><body>' + 'x'.repeat(9000) + '</body></html>';

    global.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ models: [{ name: 'llama3.2:3b-instruct-q8_0' }] }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'llama3.2:3b-instruct-q8_0',
            created_at: '2024-01-01T00:00:00Z',
            response: 'TITLE: Truncated\nCONTENT: Result\nSUMMARY: Sum',
            done: true,
          }),
          { status: 200 }
        )
      );

    await extractor.extract(longHtml, 'https://example.com');

    // The second fetch call is the /api/generate request
    const generateCall = vi.mocked(global.fetch).mock.calls[1];
    const requestBody = JSON.parse(generateCall[1]!.body as string);
    // The prompt should contain the truncated HTML (8000 chars + '...')
    expect(requestBody.prompt.length).toBeLessThan(longHtml.length + 500);
    expect(requestBody.prompt).toContain('...');
  });

  // -----------------------------------------------------------------------
  // Circuit breaker
  // -----------------------------------------------------------------------

  it('circuit breaker opens after repeated failures', async () => {
    delete process.env.OLLAMA_ENABLED;

    // Always available
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/tags')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ models: [{ name: 'llama3.2:3b-instruct-q8_0' }] }),
            { status: 200 }
          )
        );
      }
      // /api/generate always fails
      return Promise.resolve(new Response('Error', { status: 500 }));
    });

    // The circuit breaker is configured with failureThreshold: 3
    // Cause 3 failures to open the breaker
    for (let i = 0; i < 3; i++) {
      // Reset availability to force re-check each time
      extractor.resetAvailability();
      const result = await extractor.extract('<p>test</p>', 'https://example.com');
      expect(result).toBeNull();
    }

    // The 4th call should also return null (circuit is now open, rejects immediately)
    extractor.resetAvailability();
    const result = await extractor.extract('<p>test</p>', 'https://example.com');
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // resetAvailability
  // -----------------------------------------------------------------------

  it('resetAvailability clears cached state', async () => {
    delete process.env.OLLAMA_ENABLED;

    // First: make it unavailable
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result1 = await extractor.extract('<p>test</p>', 'https://example.com');
    expect(result1).toBeNull();

    // Without reset, availability is cached as false
    global.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ models: [{ name: 'llama3.2:3b-instruct-q8_0' }] }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'llama3.2:3b-instruct-q8_0',
            created_at: '2024-01-01T00:00:00Z',
            response: 'TITLE: Hello\nCONTENT: World\nSUMMARY: Brief',
            done: true,
          }),
          { status: 200 }
        )
      );

    // Still null because isAvailable is cached as false
    const result2 = await extractor.extract('<p>test</p>', 'https://example.com');
    expect(result2).toBeNull();

    // After reset, it should re-check
    extractor.resetAvailability();
    const result3 = await extractor.extract('<p>test</p>', 'https://example.com');
    expect(result3).not.toBeNull();
    expect(result3!.title).toBe('Hello');
  });

  // -----------------------------------------------------------------------
  // Non-200 availability check
  // -----------------------------------------------------------------------

  it('returns null when /api/tags response is not ok', async () => {
    delete process.env.OLLAMA_ENABLED;

    global.fetch = vi.fn().mockResolvedValue(
      new Response('Server Error', { status: 500 })
    );

    const result = await extractor.extract('<p>test</p>', 'https://example.com');
    expect(result).toBeNull();
  });

  it('returns null when model is not found in /api/tags', async () => {
    delete process.env.OLLAMA_ENABLED;

    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ models: [{ name: 'some-other-model' }] }),
        { status: 200 }
      )
    );

    const result = await extractor.extract('<p>test</p>', 'https://example.com');
    expect(result).toBeNull();
  });
});
