/**
 * Batch Fetch Tests
 * Tests for multi-source parallel fetching endpoint (ANNO-601)
 */

import { describe, it, expect } from 'vitest';

describe('Batch Fetch Endpoint', () => {
  const BATCH_URL = 'http://localhost:5213/v1/content/batch-fetch';

  it('should fetch multiple URLs in parallel', async () => {
    const response = await fetch(BATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: [
          'https://example.com',
          'https://www.iana.org/help/example-domains'
        ],
        options: {
          useCache: false,
          maxNodes: 10,
          parallel: 2
        }
      })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');

    const text = await response.text();
    const lines = text.trim().split('\n');
    const events = lines.map(line => JSON.parse(line));

    // Check batch_start event
    const batchStart = events.find(e => e.type === 'batch_start');
    expect(batchStart).toBeTruthy();
    expect(batchStart.payload.totalUrls).toBe(2);
    expect(batchStart.payload.parallelism).toBe(2);

    // Check source_start events
    const sourceStarts = events.filter(e => e.type === 'source_start');
    expect(sourceStarts.length).toBe(2);

    // Check source_event events (wrapped pipeline events)
    const sourceEvents = events.filter(e => e.type === 'source_event');
    expect(sourceEvents.length > 0).toBe(true);

    // Verify each source has metadata, nodes, etc.
    for (let i = 0; i < 2; i++) {
      const urlEvents = sourceEvents.filter(e => e.payload.index === i);
      expect(urlEvents.length > 0).toBe(true);

      const metadataEvent = urlEvents.find(e => e.payload.event.type === 'metadata');
      expect(metadataEvent).toBeTruthy();

      const nodeEvents = urlEvents.filter(e => e.payload.event.type === 'node');
      expect(nodeEvents.length > 0).toBe(true);
    }

    // Check source_end events
    const sourceEnds = events.filter(e => e.type === 'source_end');
    expect(sourceEnds.length).toBe(2);
    expect(sourceEnds.every(e => e.payload.status === 'success')).toBe(true);

    // Check batch_end event
    const batchEnd = events.find(e => e.type === 'batch_end');
    expect(batchEnd).toBeTruthy();
    expect(batchEnd.payload.totalUrls).toBe(2);
  });

  it('should handle errors for individual URLs gracefully', async () => {
    const response = await fetch(BATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: [
          'https://example.com',
          'https://invalid-domain-that-does-not-exist-12345.com'
        ],
        options: {
          parallel: 2
        }
      })
    });

    expect(response.status).toBe(200);

    const text = await response.text();
    const lines = text.trim().split('\n');
    const events = lines.map(line => JSON.parse(line));

    // Check that we have both source_end events
    const sourceEnds = events.filter(e => e.type === 'source_end');
    expect(sourceEnds.length).toBe(2);

    // One should succeed, one should fail
    const successCount = sourceEnds.filter(e => e.payload.status === 'success').length;
    const errorCount = sourceEnds.filter(e => e.payload.status === 'error').length;
    expect(successCount >= 1 && errorCount >= 1).toBe(true);
  });

  it('should reject invalid requests', async () => {
    const response = await fetch(BATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: [], // Empty array
        options: {}
      })
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_request');
  });

  it('should respect parallel limit', async () => {
    const response = await fetch(BATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: [
          'https://example.com',
          'https://www.iana.org',
          'https://httpbin.org'
        ],
        options: {
          useCache: false,
          parallel: 1 // Force sequential
        }
      })
    });

    const text = await response.text();
    const lines = text.trim().split('\n');
    const events = lines.map(line => JSON.parse(line));

    const sourceStarts = events.filter(e => e.type === 'source_start');
    expect(sourceStarts.length).toBe(3);
  });

  it('should respect URL limit (max 10)', async () => {
    const urls = Array.from({ length: 11 }, (_, i) => `https://en.wikipedia.org/wiki/Test${i}`);

    const response = await fetch(BATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls,
        options: {}
      })
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_request');
  });
});
