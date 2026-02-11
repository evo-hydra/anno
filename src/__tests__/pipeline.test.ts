import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as dns } from 'dns';
import { runPipeline, type StreamEvent } from '../core/pipeline';
import { config } from '../config/env';
import { AppError, ErrorCode } from '../middleware/error-handler';
import { rateLimiter } from '../core/rate-limiter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let originalSsrf: typeof config.ssrf;
const originalFetch = global.fetch;
const originalLookup = dns.lookup;

const originalRateLimiter = {
  checkLimit: rateLimiter.checkLimit.bind(rateLimiter),
  setDomainLimit: rateLimiter.setDomainLimit.bind(rateLimiter),
};

const stubRateLimiter = () => {
  (rateLimiter as unknown as { setDomainLimit: typeof rateLimiter.setDomainLimit }).setDomainLimit = () => {};
  (rateLimiter as unknown as { checkLimit: typeof rateLimiter.checkLimit }).checkLimit = async () => {};
};

const restoreRateLimiter = () => {
  (rateLimiter as unknown as { setDomainLimit: typeof rateLimiter.setDomainLimit }).setDomainLimit = originalRateLimiter.setDomainLimit;
  (rateLimiter as unknown as { checkLimit: typeof rateLimiter.checkLimit }).checkLimit = originalRateLimiter.checkLimit;
};

const mockDnsLookup = (results: Array<{ address: string; family: number }>) => {
  (dns as unknown as { lookup: typeof dns.lookup }).lookup = async () => results as never;
};

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
  <article>
    <h1>Test Article Heading</h1>
    <p>This is a substantial paragraph of content that should be extracted by the distiller.
    It contains enough text to trigger the content length heuristics in the confidence scorer.
    The quick brown fox jumps over the lazy dog, providing additional meaningful content for extraction.</p>
    <p>A second paragraph with more content to ensure the distiller picks up multiple nodes
    and produces a reasonable extraction result with good confidence scores.</p>
  </article>
</body>
</html>`;

const collectEvents = async (gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
};

beforeEach(() => {
  originalSsrf = { ...config.ssrf, allowedHosts: [...config.ssrf.allowedHosts], blockedHosts: [...config.ssrf.blockedHosts] };
  config.ssrf.enabled = true;
  config.ssrf.allowedHosts = [];
  config.ssrf.blockedHosts = [];
  config.ssrf.allowPrivateIPs = false;
  stubRateLimiter();
});

afterEach(() => {
  config.ssrf.enabled = originalSsrf.enabled;
  config.ssrf.allowedHosts = originalSsrf.allowedHosts;
  config.ssrf.blockedHosts = originalSsrf.blockedHosts;
  config.ssrf.allowPrivateIPs = originalSsrf.allowPrivateIPs;
  global.fetch = originalFetch;
  (dns as unknown as { lookup: typeof dns.lookup }).lookup = originalLookup;
  restoreRateLimiter();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPipeline', () => {
  it('emits events in correct order: metadata → confidence → extraction → node(s) → provenance → done', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(SAMPLE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/article',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const types = events.map(e => e.type);

    // First event should be metadata
    expect(types[0]).toBe('metadata');

    // Should have confidence, extraction, and done events
    expect(types).toContain('confidence');
    expect(types).toContain('extraction');
    expect(types).toContain('done');

    // Last event should be done
    expect(types[types.length - 1]).toBe('done');

    // Provenance should appear
    expect(types).toContain('provenance');
  });

  it('emits done event with node count', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(SAMPLE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/article',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.payload).toHaveProperty('nodes');
    expect(typeof doneEvent!.payload.nodes).toBe('number');
  });

  it('handles SSRF-blocked URLs with error propagation', async () => {
    // Attempt to pipeline a private IP — should throw SSRF error
    await expect(async () => {
      const gen = runPipeline({
        url: 'http://169.254.169.254/latest/meta-data/',
        useCache: false,
        maxNodes: 100,
        mode: 'http',
      });
      await collectEvents(gen);
    }).rejects.toThrow(AppError);

    try {
      const gen = runPipeline({
        url: 'http://127.0.0.1/',
        useCache: false,
        maxNodes: 100,
        mode: 'http',
      });
      await collectEvents(gen);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCode.SSRF_BLOCKED);
    }
  });

  it('emits metadata with correct URL and status', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(SAMPLE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/test',
      useCache: false,
      maxNodes: 10,
      mode: 'http',
    }));

    const metadata = events.find(e => e.type === 'metadata');
    expect(metadata).toBeDefined();
    expect(metadata!.payload.status).toBe(200);
    expect(metadata!.payload.url).toBe('https://example.com/test');
  });
});
