import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as dns } from 'dns';
import { isPrivateIP, validateUrl, validateWebhookUrl } from '../core/url-validator';
import { config } from '../config/env';
import { AppError, ErrorCode } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Helpers: save and restore config + DNS mock
// ---------------------------------------------------------------------------

let originalSsrf: typeof config.ssrf;
const originalLookup = dns.lookup;

const mockDnsLookup = (results: Array<{ address: string; family: number }>) => {
  (dns as unknown as { lookup: typeof dns.lookup }).lookup = async () => results as never;
};

const mockDnsLookupError = (message: string) => {
  (dns as unknown as { lookup: typeof dns.lookup }).lookup = async () => {
    throw new Error(message);
  };
};

beforeEach(() => {
  originalSsrf = { ...config.ssrf, allowedHosts: [...config.ssrf.allowedHosts], blockedHosts: [...config.ssrf.blockedHosts] };
  // Reset to defaults for each test
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
  (dns as unknown as { lookup: typeof dns.lookup }).lookup = originalLookup;
});

// ---------------------------------------------------------------------------
// isPrivateIP
// ---------------------------------------------------------------------------

describe('isPrivateIP', () => {
  it('blocks 127.0.0.1 (loopback)', () => {
    expect(isPrivateIP('127.0.0.1')).toBe(true);
  });

  it('blocks 127.0.0.2 (loopback range)', () => {
    expect(isPrivateIP('127.0.0.2')).toBe(true);
  });

  it('blocks 10.0.0.1 (private class A)', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
  });

  it('blocks 10.255.255.255 (end of class A)', () => {
    expect(isPrivateIP('10.255.255.255')).toBe(true);
  });

  it('blocks 172.16.0.1 (private class B start)', () => {
    expect(isPrivateIP('172.16.0.1')).toBe(true);
  });

  it('blocks 172.31.255.255 (private class B end)', () => {
    expect(isPrivateIP('172.31.255.255')).toBe(true);
  });

  it('allows 172.15.255.255 (just below private class B)', () => {
    expect(isPrivateIP('172.15.255.255')).toBe(false);
  });

  it('allows 172.32.0.0 (just above private class B)', () => {
    expect(isPrivateIP('172.32.0.0')).toBe(false);
  });

  it('blocks 192.168.0.1 (private class C)', () => {
    expect(isPrivateIP('192.168.0.1')).toBe(true);
  });

  it('blocks 192.168.255.255 (end of private class C)', () => {
    expect(isPrivateIP('192.168.255.255')).toBe(true);
  });

  it('blocks 169.254.0.1 (link-local)', () => {
    expect(isPrivateIP('169.254.0.1')).toBe(true);
  });

  it('blocks 169.254.169.254 (AWS metadata)', () => {
    expect(isPrivateIP('169.254.169.254')).toBe(true);
  });

  it('blocks 0.0.0.0 (unspecified)', () => {
    expect(isPrivateIP('0.0.0.0')).toBe(true);
  });

  it('blocks ::1 (IPv6 loopback)', () => {
    expect(isPrivateIP('::1')).toBe(true);
  });

  it('blocks fc00::1 (IPv6 unique local)', () => {
    expect(isPrivateIP('fc00::1')).toBe(true);
  });

  it('blocks fd00::1 (IPv6 unique local)', () => {
    expect(isPrivateIP('fd00::1')).toBe(true);
  });

  it('blocks fe80::1 (IPv6 link-local)', () => {
    expect(isPrivateIP('fe80::1')).toBe(true);
  });

  it('blocks ::ffff:127.0.0.1 (IPv4-mapped IPv6 loopback)', () => {
    expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
  });

  it('blocks ::ffff:10.0.0.1 (IPv4-mapped IPv6 private)', () => {
    expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);
  });

  it('allows 8.8.8.8 (Google DNS)', () => {
    expect(isPrivateIP('8.8.8.8')).toBe(false);
  });

  it('allows 1.1.1.1 (Cloudflare DNS)', () => {
    expect(isPrivateIP('1.1.1.1')).toBe(false);
  });

  it('allows 93.184.216.34 (example.com IP)', () => {
    expect(isPrivateIP('93.184.216.34')).toBe(false);
  });

  it('allows ::ffff:8.8.8.8 (IPv4-mapped public)', () => {
    expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows 2606:4700::6810:85e5 (public IPv6)', () => {
    expect(isPrivateIP('2606:4700::6810:85e5')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateUrl
// ---------------------------------------------------------------------------

describe('validateUrl', () => {
  // --- Scheme validation ---

  it('allows https:// URLs', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    await expect(validateUrl('https://example.com')).resolves.toBeUndefined();
  });

  it('allows http:// URLs', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    await expect(validateUrl('http://example.com')).resolves.toBeUndefined();
  });

  it('rejects file:// URLs', async () => {
    await expect(validateUrl('file:///etc/passwd')).rejects.toThrow(AppError);
    await expect(validateUrl('file:///etc/passwd')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  it('rejects ftp:// URLs', async () => {
    await expect(validateUrl('ftp://evil.com/data')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  it('rejects data: URLs', async () => {
    await expect(validateUrl('data:text/html,<h1>Hi</h1>')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  it('rejects javascript: URLs', async () => {
    await expect(validateUrl('javascript:alert(1)')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  // --- IP literal private URL blocking ---

  it('blocks http://127.0.0.1', async () => {
    await expect(validateUrl('http://127.0.0.1')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  it('blocks http://10.0.0.1:8080', async () => {
    await expect(validateUrl('http://10.0.0.1:8080')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  it('blocks http://[::1]', async () => {
    await expect(validateUrl('http://[::1]')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  it('blocks http://169.254.169.254/latest/meta-data/', async () => {
    await expect(validateUrl('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  it('blocks http://0.0.0.0', async () => {
    await expect(validateUrl('http://0.0.0.0')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  // --- DNS resolution blocking ---

  it('blocks hostname resolving to private IP', async () => {
    mockDnsLookup([{ address: '127.0.0.1', family: 4 }]);
    await expect(validateUrl('http://evil.internal')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  it('blocks hostname where ANY A record is private', async () => {
    mockDnsLookup([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(validateUrl('http://sneaky.com')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  it('allows hostname resolving to public IP', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    await expect(validateUrl('https://example.com')).resolves.toBeUndefined();
  });

  // --- localhost ---

  it('blocks http://localhost', async () => {
    await expect(validateUrl('http://localhost')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  it('blocks http://localhost:3000', async () => {
    await expect(validateUrl('http://localhost:3000')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  // --- config.ssrf.allowedHosts ---

  it('allows private IP hostname when in allowedHosts', async () => {
    config.ssrf.allowedHosts = ['internal-service.local'];
    // Even though this would resolve to a private IP, it's explicitly allowed
    await expect(validateUrl('http://internal-service.local/api')).resolves.toBeUndefined();
  });

  // --- config.ssrf.blockedHosts ---

  it('blocks public hostname when in blockedHosts', async () => {
    config.ssrf.blockedHosts = ['evil.com'];
    await expect(validateUrl('https://evil.com')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  // --- config.ssrf.enabled = false ---

  it('skips all checks when config.ssrf.enabled = false', async () => {
    config.ssrf.enabled = false;
    // Should not throw even for private IP
    await expect(validateUrl('http://127.0.0.1')).resolves.toBeUndefined();
    await expect(validateUrl('http://169.254.169.254/latest/meta-data/')).resolves.toBeUndefined();
  });

  // --- config.ssrf.allowPrivateIPs = true ---

  it('allows private IPs when config.ssrf.allowPrivateIPs = true', async () => {
    config.ssrf.allowPrivateIPs = true;
    await expect(validateUrl('http://127.0.0.1')).resolves.toBeUndefined();
    await expect(validateUrl('http://10.0.0.1:8080')).resolves.toBeUndefined();
  });

  it('allows localhost when config.ssrf.allowPrivateIPs = true', async () => {
    config.ssrf.allowPrivateIPs = true;
    await expect(validateUrl('http://localhost:3000')).resolves.toBeUndefined();
  });

  // --- DNS resolution failures (fail-closed) ---

  it('blocks on DNS resolution failure (fail-closed)', async () => {
    mockDnsLookupError('getaddrinfo ENOTFOUND nonexistent.invalid');
    await expect(validateUrl('http://nonexistent.invalid')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });

  // --- Invalid URL ---

  it('rejects invalid URL', async () => {
    await expect(validateUrl('not-a-url')).rejects.toMatchObject({
      code: ErrorCode.SSRF_BLOCKED,
    });
  });
});

// ---------------------------------------------------------------------------
// validateWebhookUrl
// ---------------------------------------------------------------------------

describe('validateWebhookUrl', () => {
  it('blocks private IP with webhook-specific message', async () => {
    await expect(validateWebhookUrl('http://127.0.0.1/hook')).rejects.toThrow(/Webhook/);
  });

  it('allows public URLs', async () => {
    mockDnsLookup([{ address: '93.184.216.34', family: 4 }]);
    await expect(validateWebhookUrl('https://hooks.example.com/callback')).resolves.toBeUndefined();
  });
});
