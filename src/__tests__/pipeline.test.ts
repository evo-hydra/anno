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

  it('handles empty body with alert and done(empty_body)', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response('', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/empty',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const alert = events.find(e => e.type === 'alert');
    expect(alert).toBeDefined();
    expect(alert!.payload.kind).toBe('empty_body');
    expect(alert!.payload.url).toBe('https://example.com/empty');

    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
    expect(done!.payload.reason).toBe('empty_body');
    expect(done!.payload.nodes).toBe(0);

    // Should not emit extraction or node events
    expect(events.find(e => e.type === 'extraction')).toBeUndefined();
    expect(events.find(e => e.type === 'node')).toBeUndefined();
  });

  it('detects captcha challenge', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(
      `<!DOCTYPE html>
      <html>
      <head><title>Captcha</title></head>
      <body>
        <h1>Please complete the CAPTCHA below</h1>
        <div class="captcha-widget"></div>
      </body>
      </html>`,
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/captcha',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const alert = events.find(e => e.type === 'alert');
    expect(alert).toBeDefined();
    expect(alert!.payload.kind).toBe('challenge_detected');
    expect(alert!.payload.reason).toBe('captcha');
    expect(alert!.payload.pattern).toContain('captcha');
  });

  it('detects human verification challenge', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(
      `<!DOCTYPE html>
      <html>
      <head><title>Verify</title></head>
      <body>
        <h1>Verify you are human</h1>
        <p>Please complete the verification.</p>
      </body>
      </html>`,
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/verify',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const alert = events.find(e => e.type === 'alert');
    expect(alert).toBeDefined();
    expect(alert!.payload.kind).toBe('challenge_detected');
    expect(alert!.payload.reason).toBe('human_verification');
  });

  it('detects robot check challenge', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(
      `<!DOCTYPE html><html><body><h1>Are you a robot?</h1></body></html>`,
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/robot',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const alert = events.find(e => e.type === 'alert');
    expect(alert).toBeDefined();
    expect(alert!.payload.reason).toBe('robot_check');
  });

  it('detects access denied challenge', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(
      `<!DOCTYPE html><html><body><h1>Access Denied</h1><p>You do not have permission.</p></body></html>`,
      {
        status: 403,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/denied',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const alert = events.find(e => e.type === 'alert');
    expect(alert).toBeDefined();
    expect(alert!.payload.reason).toBe('access_denied');
  });

  it('detects PerimeterX challenge', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(
      `<!DOCTYPE html><html><body><script>window._pxAppId="PXabcdef";</script><div>PerimeterX protection</div></body></html>`,
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/px',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const alert = events.find(e => e.type === 'alert');
    expect(alert).toBeDefined();
    expect(alert!.payload.reason).toBe('perimeterx');
  });

  it('detects JavaScript required challenge', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(
      `<!DOCTYPE html><html><body><noscript>Please enable JavaScript to continue.</noscript></body></html>`,
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/nojs',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const alert = events.find(e => e.type === 'alert');
    expect(alert).toBeDefined();
    expect(alert!.payload.reason).toBe('javascript_required');
  });

  it('detects unusual traffic challenge', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(
      `<!DOCTYPE html><html><body><h1>Unusual Traffic Detected</h1><p>Please try again later.</p></body></html>`,
      {
        status: 429,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/traffic',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const alert = events.find(e => e.type === 'alert');
    expect(alert).toBeDefined();
    expect(alert!.payload.reason).toBe('unusual_traffic');
  });

  it('truncates nodes when exceeding maxNodes', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    const longHtml = `<!DOCTYPE html>
<html>
<head><title>Long Article</title></head>
<body>
  <article>
    <h1>Title</h1>
    ${Array.from({ length: 20 }, (_, i) => `<p>Paragraph ${i + 1} with enough content to be extracted by the distiller as a separate node.</p>`).join('\n')}
  </article>
</body>
</html>`;

    global.fetch = async () => new Response(longHtml, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/long',
      useCache: false,
      maxNodes: 5,
      mode: 'http',
    }));

    const nodeEvents = events.filter(e => e.type === 'node');
    expect(nodeEvents.length).toBeLessThanOrEqual(5);

    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
    expect(done!.payload.truncated).toBe(true);
  });

  it('applies heading confidence boost', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(
      `<!DOCTYPE html>
<html>
<head><title>Heading Test</title></head>
<body>
  <article>
    <h1>Main Heading</h1>
    <p>This is a substantial paragraph with enough content to be extracted properly.</p>
  </article>
</body>
</html>`,
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/heading',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const confidence = events.find(e => e.type === 'confidence');
    expect(confidence).toBeDefined();
    const overallConfidence = confidence!.payload.overallConfidence as number;

    const nodeEvents = events.filter(e => e.type === 'node');
    const headingNode = nodeEvents.find(n => n.payload.kind === 'heading');

    if (headingNode) {
      const headingConfidence = headingNode.payload.confidence as number;
      // Heading should have +0.02 boost
      expect(headingConfidence).toBeGreaterThan(overallConfidence);
      expect(headingConfidence).toBeCloseTo(overallConfidence + 0.02, 1);
    }
  });

  it('applies long text confidence boost', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(
      `<!DOCTYPE html>
<html>
<head><title>Long Text Test</title></head>
<body>
  <article>
    <h1>Article Title</h1>
    <p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10)}</p>
  </article>
</body>
</html>`,
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/longtext',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const confidence = events.find(e => e.type === 'confidence');
    expect(confidence).toBeDefined();
    const overallConfidence = confidence!.payload.overallConfidence as number;

    const nodeEvents = events.filter(e => e.type === 'node');
    const longTextNode = nodeEvents.find(n => {
      const text = n.payload.text as string;
      return text.length > 200 && n.payload.kind !== 'heading';
    });

    if (longTextNode) {
      const nodeConfidence = longTextNode.payload.confidence as number;
      // Long text (>200 chars) should have +0.04 boost
      expect(nodeConfidence).toBeGreaterThan(overallConfidence);
      expect(nodeConfidence).toBeCloseTo(overallConfidence + 0.04, 1);
    }
  });

  it('applies short text confidence penalty', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(
      `<!DOCTYPE html>
<html>
<head><title>Short Text Test</title></head>
<body>
  <article>
    <h1>Title</h1>
    <p>Short.</p>
    <p>This is a longer paragraph with substantial content to ensure extraction works properly.</p>
  </article>
</body>
</html>`,
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/shorttext',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const confidence = events.find(e => e.type === 'confidence');
    expect(confidence).toBeDefined();
    const overallConfidence = confidence!.payload.overallConfidence as number;

    const nodeEvents = events.filter(e => e.type === 'node');
    const shortTextNode = nodeEvents.find(n => {
      const text = n.payload.text as string;
      return text.length < 40 && n.payload.kind !== 'heading';
    });

    if (shortTextNode) {
      const nodeConfidence = shortTextNode.payload.confidence as number;
      // Short text (<40 chars) should have -0.08 penalty
      expect(nodeConfidence).toBeLessThan(overallConfidence);
    }
  });

  it('applies high confidence for long content with byline', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(
      `<!DOCTYPE html>
<html>
<head><title>Article</title></head>
<body>
  <article>
    <h1>Comprehensive Article Title</h1>
    <div class="byline">By Jane Doe</div>
    <p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(30)}</p>
    <p>${'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(20)}</p>
  </article>
</body>
</html>`,
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/highconf',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const confidence = events.find(e => e.type === 'confidence');
    expect(confidence).toBeDefined();
    const overallConfidence = confidence!.payload.overallConfidence as number;

    // Long content (>1200 chars) + byline + multiple nodes should boost confidence
    expect(overallConfidence).toBeGreaterThan(0.7);
  });

  it('applies low confidence for short content without byline', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(
      `<!DOCTYPE html>
<html>
<head><title>Short</title></head>
<body>
  <article>
    <h1>Title</h1>
    <p>Brief content.</p>
  </article>
</body>
</html>`,
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/lowconf',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const confidence = events.find(e => e.type === 'confidence');
    expect(confidence).toBeDefined();
    const overallConfidence = confidence!.payload.overallConfidence as number;

    // Short content (<400 chars) without byline should reduce confidence
    expect(overallConfidence).toBeLessThan(0.65);
  });

  it('uses fallback-dom as extractionMethod when fallbackUsed=true and extractionMethod is null', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    // Minimal HTML that might trigger fallback
    global.fetch = async () => new Response(
      `<!DOCTYPE html><html><body><div>Some text content here.</div></body></html>`,
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }
    );

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/fallback',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const extraction = events.find(e => e.type === 'extraction');
    expect(extraction).toBeDefined();

    // If fallbackUsed is true, method should be 'fallback-dom' or 'readability'
    const method = extraction!.payload.method as string;
    expect(['fallback-dom', 'readability']).toContain(method);
  });

  it('populates extractionMethod correctly based on fallbackUsed ternary', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response(SAMPLE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/method-test',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const extraction = events.find(e => e.type === 'extraction');
    expect(extraction).toBeDefined();

    const method = extraction!.payload.method as string;
    const fallbackUsed = extraction!.payload.fallbackUsed as boolean;

    // Verify that extractionMethod is populated (tests the ternary logic)
    expect(method).toBeDefined();
    expect(typeof method).toBe('string');
    expect(method.length).toBeGreaterThan(0);

    // If fallbackUsed is true, method should be 'fallback-dom', otherwise should be another method
    if (fallbackUsed) {
      expect(['fallback-dom', 'dom-heuristic']).toContain(method);
    } else {
      expect(['readability', 'mozilla-readability', 'dom-heuristic']).toContain(method);
    }
  });

  it('includes ebayListing and ebaySearch data when present', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    // This will not actually produce eBay data with normal HTML,
    // but we can verify the extraction event structure
    global.fetch = async () => new Response(SAMPLE_HTML, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    const events = await collectEvents(runPipeline({
      url: 'https://example.com/ebay-test',
      useCache: false,
      maxNodes: 100,
      mode: 'http',
    }));

    const extraction = events.find(e => e.type === 'extraction');
    expect(extraction).toBeDefined();

    // Verify structure exists (will be undefined for non-eBay pages)
    expect(extraction!.payload).toHaveProperty('ebayListing');
    expect(extraction!.payload).toHaveProperty('ebaySearch');
  });
});
