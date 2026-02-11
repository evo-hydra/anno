import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as dns } from 'dns';
import { HttpClient } from '../core/http-client';
import { config } from '../config/env';
import { AppError, ErrorCode } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let originalSsrf: typeof config.ssrf;
const originalFetch = global.fetch;
const originalLookup = dns.lookup;

const mockDnsLookup = (results: Array<{ address: string; family: number }>) => {
  (dns as unknown as { lookup: typeof dns.lookup }).lookup = async () => results as never;
};

beforeEach(() => {
  originalSsrf = { ...config.ssrf, allowedHosts: [...config.ssrf.allowedHosts], blockedHosts: [...config.ssrf.blockedHosts] };
  config.ssrf.enabled = true;
  config.ssrf.allowedHosts = [];
  config.ssrf.blockedHosts = [];
  config.ssrf.allowPrivateIPs = false;
});

afterEach(() => {
  config.ssrf.enabled = originalSsrf.enabled;
  config.ssrf.allowedHosts = originalSsrf.allowedHosts;
  config.ssrf.blockedHosts = originalSsrf.blockedHosts;
  config.ssrf.allowPrivateIPs = originalSsrf.allowPrivateIPs;
  global.fetch = originalFetch;
  (dns as unknown as { lookup: typeof dns.lookup }).lookup = originalLookup;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HttpClient SSRF integration', () => {
  const client = new HttpClient(5000, 'TestAgent/1.0');

  it('rejects request to http://127.0.0.1', async () => {
    global.fetch = async () => new Response('should not reach here');
    await expect(client.get('http://127.0.0.1')).rejects.toThrow(AppError);
    await expect(client.get('http://127.0.0.1')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  it('rejects request to hostname resolving to private IP', async () => {
    mockDnsLookup([{ address: '192.168.1.1', family: 4 }]);
    global.fetch = async () => new Response('should not reach here');
    await expect(client.get('http://internal.corp')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  it('allows request to public URL', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = async () => new Response('<html>OK</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });

    const result = await client.get('https://example.com');
    expect(result.status).toBe(200);
    expect(result.body).toContain('OK');
  });

  it('throws AppError with SSRF_BLOCKED code and 403 status', async () => {
    try {
      await client.get('http://169.254.169.254/latest/meta-data/');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCode.SSRF_BLOCKED);
      expect((error as AppError).statusCode).toBe(403);
    }
  });
});
