import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// We test the in-memory LRU path only. To do this we mock the config so
// Redis is disabled, the cache-redis module, the metrics module, and the logger.
// Then we dynamically import the cache module to get a fresh instance.
// ---------------------------------------------------------------------------

// Mock config to disable Redis and set small TTL/size for testing
vi.mock('../config/env', () => ({
  config: {
    cache: {
      maxEntries: 64,
      ttlMs: 1000 * 60 * 5 // 5 minutes default
    },
    redis: {
      enabled: false,
      url: 'redis://localhost:6379',
      ttlMs: 1000 * 60 * 60
    }
  }
}));

// Mock Redis adapter to avoid real connection attempts
vi.mock('./cache-redis', () => ({
  RedisCacheAdapter: vi.fn()
}));

// Mock metrics
vi.mock('./metrics', () => ({
  metrics: {
    recordCacheHit: vi.fn(),
    recordCacheMiss: vi.fn(),
    recordCacheLookup: vi.fn()
  }
}));

// Mock logger
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

describe('UnifiedCache (in-memory LRU path)', () => {
  let cache: Awaited<typeof import('../services/cache')>['cache'];

  beforeEach(async () => {
    // Re-import to get fresh module with mocks applied
    vi.resetModules();

    // Re-apply mocks after reset
    vi.doMock('../config/env', () => ({
      config: {
        cache: {
          maxEntries: 64,
          ttlMs: 1000 * 60 * 5
        },
        redis: {
          enabled: false,
          url: 'redis://localhost:6379',
          ttlMs: 1000 * 60 * 60
        }
      }
    }));

    vi.doMock('./cache-redis', () => ({
      RedisCacheAdapter: vi.fn()
    }));

    vi.doMock('./metrics', () => ({
      metrics: {
        recordCacheHit: vi.fn(),
        recordCacheMiss: vi.fn(),
        recordCacheLookup: vi.fn()
      }
    }));

    vi.doMock('../utils/logger', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      }
    }));

    const mod = await import('../services/cache');
    cache = mod.cache;
  });

  afterEach(async () => {
    if (cache) {
      await cache.clear();
    }
  });

  // -----------------------------------------------------------------------
  // Basic operations
  // -----------------------------------------------------------------------

  it('set() and get() roundtrip', async () => {
    await cache.set('key1', { data: 'hello world' });
    const entry = await cache.get<{ data: string }>('key1');

    expect(entry).toBeDefined();
    expect(entry!.value).toEqual({ data: 'hello world' });
    expect(typeof entry!.insertedAt).toBe('number');
    expect(entry!.insertedAt).toBeLessThanOrEqual(Date.now());
  });

  it('get() returns undefined for missing key', async () => {
    const entry = await cache.get('nonexistent-key');
    expect(entry).toBeUndefined();
  });

  it('delete() removes entry', async () => {
    await cache.set('to-delete', 42);
    const before = await cache.get<number>('to-delete');
    expect(before).toBeDefined();
    expect(before!.value).toBe(42);

    await cache.delete('to-delete');
    const after = await cache.get<number>('to-delete');
    expect(after).toBeUndefined();
  });

  it('clear() empties cache', async () => {
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('c', 3);

    await cache.clear();

    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('c')).toBeUndefined();
  });

  it('has() returns true for existing key, false for missing', async () => {
    await cache.set('exists', 'yes');
    expect(await cache.has('exists')).toBe(true);
    expect(await cache.has('not-here')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Metadata
  // -----------------------------------------------------------------------

  it('stores and retrieves etag metadata', async () => {
    await cache.set('with-etag', 'content', {
      etag: '"abc123"'
    });
    const entry = await cache.get<string>('with-etag');

    expect(entry).toBeDefined();
    expect(entry!.etag).toBe('"abc123"');
  });

  it('stores and retrieves lastModified metadata', async () => {
    const lastMod = 'Tue, 15 Nov 2024 12:45:26 GMT';
    await cache.set('with-lm', 'content', {
      lastModified: lastMod
    });
    const entry = await cache.get<string>('with-lm');

    expect(entry).toBeDefined();
    expect(entry!.lastModified).toBe(lastMod);
  });

  it('stores and retrieves contentHash metadata', async () => {
    await cache.set('with-hash', 'content', {
      contentHash: 'sha256-abc'
    });
    const entry = await cache.get<string>('with-hash');

    expect(entry).toBeDefined();
    expect(entry!.contentHash).toBe('sha256-abc');
  });

  it('stores and retrieves all metadata fields together', async () => {
    const meta = {
      etag: '"xyz789"',
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
      contentHash: 'sha256-deadbeef'
    };

    await cache.set('full-meta', { body: 'test' }, meta);
    const entry = await cache.get<{ body: string }>('full-meta');

    expect(entry).toBeDefined();
    expect(entry!.value).toEqual({ body: 'test' });
    expect(entry!.etag).toBe(meta.etag);
    expect(entry!.lastModified).toBe(meta.lastModified);
    expect(entry!.contentHash).toBe(meta.contentHash);
  });

  // -----------------------------------------------------------------------
  // Multiple entries coexist
  // -----------------------------------------------------------------------

  it('multiple entries coexist independently', async () => {
    await cache.set('k1', 'value-one');
    await cache.set('k2', 'value-two');
    await cache.set('k3', 'value-three');

    const e1 = await cache.get<string>('k1');
    const e2 = await cache.get<string>('k2');
    const e3 = await cache.get<string>('k3');

    expect(e1!.value).toBe('value-one');
    expect(e2!.value).toBe('value-two');
    expect(e3!.value).toBe('value-three');
  });

  // -----------------------------------------------------------------------
  // Overwrite behavior
  // -----------------------------------------------------------------------

  it('set() with same key overwrites previous value', async () => {
    await cache.set('overwrite-me', 'first');
    await cache.set('overwrite-me', 'second');

    const entry = await cache.get<string>('overwrite-me');
    expect(entry!.value).toBe('second');
  });

  // -----------------------------------------------------------------------
  // Concurrent access
  // -----------------------------------------------------------------------

  it('handles concurrent set() and get() without errors', async () => {
    const ops = Array.from({ length: 50 }, (_, i) =>
      cache.set(`concurrent-${i}`, `val-${i}`)
    );
    await Promise.all(ops);

    const reads = Array.from({ length: 50 }, (_, i) =>
      cache.get<string>(`concurrent-${i}`)
    );
    const results = await Promise.all(reads);

    for (let i = 0; i < 50; i++) {
      expect(results[i]).toBeDefined();
      expect(results[i]!.value).toBe(`val-${i}`);
    }
  });

  it('handles concurrent mixed operations without errors', async () => {
    // Write, read, delete, write cycle concurrently
    await cache.set('mix-1', 'a');
    await cache.set('mix-2', 'b');

    const results = await Promise.allSettled([
      cache.get('mix-1'),
      cache.delete('mix-2'),
      cache.set('mix-3', 'c'),
      cache.get('mix-2'),
      cache.set('mix-1', 'updated'),
      cache.has('mix-3')
    ]);

    // All operations should settle without rejection
    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }
  });

  // -----------------------------------------------------------------------
  // Strategy
  // -----------------------------------------------------------------------

  it('reports LRU strategy when Redis is disabled', () => {
    expect(cache.getStrategy()).toBe('lru');
  });

  it('reports null Redis status when Redis is disabled', () => {
    expect(cache.getRedisStatus()).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Complex value types
  // -----------------------------------------------------------------------

  it('stores and retrieves complex nested objects', async () => {
    const complex = {
      title: 'Test Article',
      nodes: [
        { id: '1', text: 'para 1' },
        { id: '2', text: 'para 2' }
      ],
      metadata: { author: 'Jane', tags: ['tech', 'ai'] }
    };

    await cache.set('complex-obj', complex);
    const entry = await cache.get<typeof complex>('complex-obj');

    expect(entry!.value).toEqual(complex);
    expect(entry!.value.nodes).toHaveLength(2);
    expect(entry!.value.metadata.tags).toContain('ai');
  });
});
