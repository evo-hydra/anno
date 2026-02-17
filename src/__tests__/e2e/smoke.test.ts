/**
 * E2E Smoke Tests
 *
 * Verifies the full Express app wiring end-to-end: middleware stack,
 * route mounting, streaming responses, and error handling — all via
 * supertest (no real server process needed).
 *
 * Unlike unit tests, these exercise the REAL middleware and route chain.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';

const app = createApp();

describe('E2E smoke tests', () => {
  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  it('GET /health → 200 with status field', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(['healthy', 'degraded', 'unhealthy']).toContain(res.body.status);
  });

  // -----------------------------------------------------------------------
  // Content fetch — NDJSON streaming
  // -----------------------------------------------------------------------

  it('POST /v1/content/fetch with valid url → starts NDJSON stream or returns error', async () => {
    const res = await request(app)
      .post('/v1/content/fetch')
      .send({ url: 'https://example.com' });

    // The request should be accepted (200 for stream or error from network)
    // but should NOT be a 404 or middleware failure
    expect([200, 500, 502, 503]).toContain(res.status);

    // If 200, the response should have NDJSON content type or JSON
    if (res.status === 200) {
      const ct = res.headers['content-type'] || '';
      expect(ct.includes('ndjson') || ct.includes('json')).toBe(true);
    }
  });

  it('POST /v1/content/fetch without url → 400 validation error', async () => {
    const res = await request(app)
      .post('/v1/content/fetch')
      .send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // -----------------------------------------------------------------------
  // Jobs listing
  // -----------------------------------------------------------------------

  it('GET /v1/jobs → 200 with jobs array', async () => {
    const res = await request(app).get('/v1/jobs');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('jobs');
    expect(Array.isArray(res.body.jobs)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 404 handler
  // -----------------------------------------------------------------------

  it('GET /nonexistent → 404', async () => {
    const res = await request(app).get('/nonexistent');

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  // -----------------------------------------------------------------------
  // Security headers
  // -----------------------------------------------------------------------

  it('responses include security headers', async () => {
    const res = await request(app).get('/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  // -----------------------------------------------------------------------
  // Metrics endpoint
  // -----------------------------------------------------------------------

  it('GET /metrics → 200 with prometheus text', async () => {
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('anno_');
  });

  // -----------------------------------------------------------------------
  // Request context tracing
  // -----------------------------------------------------------------------

  it('echoes x-request-id header', async () => {
    const reqId = 'smoke-test-' + Date.now();
    const res = await request(app)
      .get('/health')
      .set('x-request-id', reqId);

    expect(res.headers['x-request-id']).toBe(reqId);
  });

  // -----------------------------------------------------------------------
  // Watch API wiring
  // -----------------------------------------------------------------------

  it('GET /v1/watch → 200 with watches array', async () => {
    const res = await request(app).get('/v1/watch');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('watches');
  });

  // -----------------------------------------------------------------------
  // Crawl API wiring
  // -----------------------------------------------------------------------

  it('GET /v1/crawl/jobs → 200 with jobs array', async () => {
    const res = await request(app).get('/v1/crawl/jobs');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('jobs');
  });
});
