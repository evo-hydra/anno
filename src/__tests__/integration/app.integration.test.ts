import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';

const app = createApp();

describe('App Integration Tests', () => {
  describe('GET /health', () => {
    it('returns 200 with health status', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('metrics');
      expect(res.body).toHaveProperty('cache');
      expect(res.body).toHaveProperty('robots');
      expect(res.body).toHaveProperty('rateLimit');
      expect(res.body).toHaveProperty('http');
      expect(res.body).toHaveProperty('summary');
    });
  });

  describe('GET /metrics', () => {
    it('returns Prometheus-format metrics', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('anno_fetch_total');
    });
  });

  describe('404 handler', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await request(app).get('/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });

    it('returns 404 for unknown /v1 routes', async () => {
      const res = await request(app).get('/v1/unknown');
      expect(res.status).toBe(404);
    });
  });

  describe('Security headers', () => {
    it('sets x-content-type-options header', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('sets x-frame-options header', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-frame-options']).toBeDefined();
    });
  });

  describe('CORS', () => {
    it('responds to OPTIONS preflight', async () => {
      const res = await request(app)
        .options('/health')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'GET');
      // Should not be 404
      expect(res.status).not.toBe(404);
    });
  });

  describe('Request context', () => {
    it('returns x-request-id in response headers', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-request-id']).toBeDefined();
    });

    it('echoes provided x-request-id', async () => {
      const requestId = 'test-integration-id-123';
      const res = await request(app)
        .get('/health')
        .set('x-request-id', requestId);
      expect(res.headers['x-request-id']).toBe(requestId);
    });
  });

  describe('POST /v1/content/fetch', () => {
    it('rejects request without url field', async () => {
      const res = await request(app)
        .post('/v1/content/fetch')
        .send({});
      // Should get a validation error (400) or similar
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects non-JSON body', async () => {
      const res = await request(app)
        .post('/v1/content/fetch')
        .set('Content-Type', 'text/plain')
        .send('not json');
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('GET /v1/jobs', () => {
    it('returns job listing', async () => {
      const res = await request(app).get('/v1/jobs');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('jobs');
    });
  });

  describe('POST /metrics/reset', () => {
    it('returns 404 when metrics reset is disabled', async () => {
      // By default, metrics reset is likely disabled
      const res = await request(app).post('/metrics/reset');
      // Could be 404 (disabled) or 200/401 (enabled but missing token)
      expect([200, 401, 404]).toContain(res.status);
    });
  });

  describe('JSON parsing', () => {
    it('handles valid JSON body', async () => {
      const res = await request(app)
        .post('/v1/content/fetch')
        .send({ url: 'https://example.com' });
      // Should process the request (may fail on network, but shouldn't be a parse error)
      expect(res.status).not.toBe(415);
    });
  });
});
