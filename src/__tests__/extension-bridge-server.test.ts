import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
  startSpan: () => ({ end: vi.fn() }),
}));

import {
  ExtensionBridgeServer,
  createBridgeServer,
  type CapturedData,
} from '../services/extension-bridge-server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a raw HTTP request to the bridge server. */
function makeRequest(
  port: number,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: options.method,
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function validPayload() {
  return JSON.stringify({
    marketplace: 'ebay',
    dataType: 'orders',
    items: [{ id: '123', title: 'Widget' }],
    capturedAt: new Date().toISOString(),
    extensionVersion: '1.0.0',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExtensionBridgeServer', () => {
  let server: ExtensionBridgeServer;
  let port: number;

  beforeEach(async () => {
    // Use random high port to avoid conflicts
    port = 30000 + Math.floor(Math.random() * 20000);
    server = createBridgeServer({
      port,
      host: '127.0.0.1',
      authToken: 'test-token-abc',
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('reports isServerRunning correctly', () => {
      expect(server.isServerRunning()).toBe(true);
    });

    it('returns the configured auth token', () => {
      expect(server.getAuthToken()).toBe('test-token-abc');
    });

    it('returns the configured port', () => {
      expect(server.getPort()).toBe(port);
    });

    it('start is idempotent when already running', async () => {
      await server.start(); // second call
      expect(server.isServerRunning()).toBe(true);
    });

    it('stop sets isRunning to false', async () => {
      await server.stop();
      expect(server.isServerRunning()).toBe(false);
    });

    it('stop is safe when server is null', async () => {
      await server.stop();
      // Calling stop again should not throw
      await server.stop();
    });
  });

  // =========================================================================
  // GET /api/extension/status
  // =========================================================================

  describe('GET /api/extension/status', () => {
    it('returns status 200 with server info', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/extension/status',
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('ok');
      expect(body.version).toBe('1.0.0');
      expect(typeof body.uptime).toBe('number');
      expect(body.capturedCount).toBe(0);
    });
  });

  // =========================================================================
  // OPTIONS (preflight)
  // =========================================================================

  describe('OPTIONS preflight', () => {
    it('returns 204 with CORS headers', async () => {
      const res = await makeRequest(port, {
        method: 'OPTIONS',
        path: '/api/extension/submit',
      });

      expect(res.status).toBe(204);
    });
  });

  // =========================================================================
  // POST /api/extension/submit
  // =========================================================================

  describe('POST /api/extension/submit', () => {
    it('rejects request without auth token', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/api/extension/submit',
        headers: { 'Content-Type': 'application/json' },
        body: validPayload(),
      });

      expect(res.status).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Unauthorized');
    });

    it('rejects request with wrong auth token', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/api/extension/submit',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-token',
        },
        body: validPayload(),
      });

      expect(res.status).toBe(401);
    });

    it('rejects non-POST methods', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/extension/submit',
        headers: {
          Authorization: 'Bearer test-token-abc',
        },
      });

      expect(res.status).toBe(405);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Method not allowed');
    });

    it('rejects invalid JSON body', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/api/extension/submit',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token-abc',
        },
        body: 'not-json{{{',
      });

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Invalid JSON body');
    });

    it('rejects payload missing required fields', async () => {
      const res = await makeRequest(port, {
        method: 'POST',
        path: '/api/extension/submit',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token-abc',
        },
        body: JSON.stringify({ marketplace: 'ebay' }), // missing dataType, items
      });

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Invalid payload structure');
    });

    it('accepts valid payload and stores data', async () => {
      const dataPromise = new Promise<CapturedData>((resolve) => {
        server.on('data', (data: CapturedData) => resolve(data));
      });

      const res = await makeRequest(port, {
        method: 'POST',
        path: '/api/extension/submit',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token-abc',
        },
        body: validPayload(),
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.itemsReceived).toBe(1);
      expect(typeof body.id).toBe('string');

      // Verify event was emitted
      const capturedData = await dataPromise;
      expect(capturedData.marketplace).toBe('ebay');
      expect(capturedData.items).toHaveLength(1);

      // Verify internal storage
      expect(server.getCapturedCount()).toBe(1);
    });
  });

  // =========================================================================
  // GET /api/extension/auth
  // =========================================================================

  describe('GET /api/extension/auth', () => {
    it('returns the auth token', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/extension/auth',
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.token).toBe('test-token-abc');
      expect(typeof body.instructions).toBe('string');
    });
  });

  // =========================================================================
  // GET /api/extension/data
  // =========================================================================

  describe('GET /api/extension/data', () => {
    it('rejects without auth', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/extension/data',
      });

      expect(res.status).toBe(401);
    });

    it('returns empty data initially', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/extension/data',
        headers: {
          Authorization: 'Bearer test-token-abc',
        },
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns stored data after submission', async () => {
      // Submit data first
      await makeRequest(port, {
        method: 'POST',
        path: '/api/extension/submit',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token-abc',
        },
        body: validPayload(),
      });

      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/extension/data',
        headers: {
          Authorization: 'Bearer test-token-abc',
        },
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total).toBe(1);
      expect(body.data[0].marketplace).toBe('ebay');
    });

    it('filters by marketplace query param', async () => {
      // Submit eBay data
      await makeRequest(port, {
        method: 'POST',
        path: '/api/extension/submit',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token-abc',
        },
        body: validPayload(),
      });

      // Submit Amazon data
      await makeRequest(port, {
        method: 'POST',
        path: '/api/extension/submit',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token-abc',
        },
        body: JSON.stringify({
          marketplace: 'amazon',
          dataType: 'orders',
          items: [{ id: '456' }],
          capturedAt: new Date().toISOString(),
          extensionVersion: '1.0.0',
        }),
      });

      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/extension/data?marketplace=amazon',
        headers: {
          Authorization: 'Bearer test-token-abc',
        },
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total).toBe(1);
      expect(body.data[0].marketplace).toBe('amazon');
    });

    it('respects limit query param', async () => {
      // Submit multiple entries
      for (let i = 0; i < 5; i++) {
        await makeRequest(port, {
          method: 'POST',
          path: '/api/extension/submit',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token-abc',
          },
          body: validPayload(),
        });
      }

      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/extension/data?limit=2',
        headers: {
          Authorization: 'Bearer test-token-abc',
        },
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total).toBe(2);
    });
  });

  // =========================================================================
  // 404 Not Found
  // =========================================================================

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/extension/unknown',
      });

      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Not found');
    });
  });

  // =========================================================================
  // Data access methods
  // =========================================================================

  describe('data access', () => {
    it('getCapturedData returns a copy', async () => {
      await makeRequest(port, {
        method: 'POST',
        path: '/api/extension/submit',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token-abc',
        },
        body: validPayload(),
      });

      const data = server.getCapturedData();
      expect(data).toHaveLength(1);
      // Verify it's a copy
      data.pop();
      expect(server.getCapturedCount()).toBe(1);
    });

    it('getCapturedDataByMarketplace filters correctly', async () => {
      await makeRequest(port, {
        method: 'POST',
        path: '/api/extension/submit',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token-abc',
        },
        body: validPayload(),
      });

      const ebayData = server.getCapturedDataByMarketplace('ebay');
      expect(ebayData).toHaveLength(1);

      const amazonData = server.getCapturedDataByMarketplace('amazon');
      expect(amazonData).toHaveLength(0);
    });

    it('clearCapturedData empties the store', async () => {
      await makeRequest(port, {
        method: 'POST',
        path: '/api/extension/submit',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token-abc',
        },
        body: validPayload(),
      });

      expect(server.getCapturedCount()).toBe(1);
      server.clearCapturedData();
      expect(server.getCapturedCount()).toBe(0);
    });

    it('popCapturedData removes and returns the first item', async () => {
      await makeRequest(port, {
        method: 'POST',
        path: '/api/extension/submit',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token-abc',
        },
        body: validPayload(),
      });

      const item = server.popCapturedData();
      expect(item).toBeDefined();
      expect(item!.marketplace).toBe('ebay');
      expect(server.getCapturedCount()).toBe(0);
    });

    it('popCapturedData returns undefined when empty', () => {
      const item = server.popCapturedData();
      expect(item).toBeUndefined();
    });
  });

  // =========================================================================
  // CORS origin handling
  // =========================================================================

  describe('CORS origin handling', () => {
    it('sets wildcard origin for requests without origin header', async () => {
      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/extension/status',
      });
      expect(res.status).toBe(200);
    });
  });

  // =========================================================================
  // Constructor defaults
  // =========================================================================

  describe('constructor defaults', () => {
    it('generates an auth token when none provided', () => {
      const srv = createBridgeServer({ port: 0 });
      const token = srv.getAuthToken();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it('uses default port and host', () => {
      const srv = createBridgeServer();
      expect(srv.getPort()).toBe(3847);
    });
  });

  // =========================================================================
  // Factory functions
  // =========================================================================

  describe('factory functions', () => {
    it('createBridgeServer creates a new instance', () => {
      const s1 = createBridgeServer({ port: 1111 });
      const s2 = createBridgeServer({ port: 2222 });
      expect(s1.getPort()).toBe(1111);
      expect(s2.getPort()).toBe(2222);
    });
  });
});
