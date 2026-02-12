/**
 * Tests for UnifiedCache strategy selection and circuit breaker paths
 * in src/services/cache.ts.
 *
 * The existing cache.test.ts covers the in-memory LRU path.
 * This file covers:
 * - Redis strategy path (with mocked Redis adapter)
 * - Circuit breaker fallback behavior
 * - Error handling in get/set/has/delete/clear
 * - Strategy info and shutdown methods
 * - Constructor failure fallback to LRU
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock references used across tests
// ---------------------------------------------------------------------------

const mockRecordCacheHit = vi.hoisted(() => vi.fn());
const mockRecordCacheMiss = vi.hoisted(() => vi.fn());
const mockRecordCacheLookup = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Shared mock factory helpers
// ---------------------------------------------------------------------------

function makeMetricsMock() {
  return () => ({
    metrics: {
      recordCacheHit: mockRecordCacheHit,
      recordCacheMiss: mockRecordCacheMiss,
      recordCacheLookup: mockRecordCacheLookup,
    },
  });
}

function makeLoggerMock() {
  return () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
}

// ---------------------------------------------------------------------------
// Tests with Redis strategy (enabled) — verifies strategy and adapter wiring
// ---------------------------------------------------------------------------

describe('UnifiedCache with Redis strategy', () => {
  let cache: Awaited<typeof import('../services/cache')>['cache'];

  // These will be set by the mock factory when the adapter is constructed
  let adapterInstance: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    adapterInstance = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      has: vi.fn().mockResolvedValue(false),
      delete: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue({ connected: true, reconnectAttempts: 0 }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };

    vi.doMock('../config/env', () => ({
      config: {
        cache: { maxEntries: 64, ttlMs: 300000 },
        redis: { enabled: true, url: 'redis://localhost:6379', ttlMs: 3600000 },
      },
    }));

    vi.doMock('../services/cache-redis', () => {
      const inst = adapterInstance;
      return {
        RedisCacheAdapter: class FakeRedisCacheAdapter {
          get = inst.get;
          set = inst.set;
          has = inst.has;
          delete = inst.delete;
          clear = inst.clear;
          isReady = inst.isReady;
          getStatus = inst.getStatus;
          disconnect = inst.disconnect;
        },
      };
    });

    vi.doMock('../services/metrics', makeMetricsMock());
    vi.doMock('../utils/logger', makeLoggerMock());

    // Use a real-ish circuit breaker mock (passthrough)
    vi.doMock('../utils/circuit-breaker', () => ({
      CircuitBreaker: class MockCircuitBreaker {
        async execute<T>(fn: () => Promise<T>): Promise<T> {
          return fn();
        }
        getState(): string { return 'CLOSED'; }
        reset(): void { /* no-op */ }
      },
      CircuitOpenError: class extends Error {
        constructor(name: string) { super(name); this.name = 'CircuitOpenError'; }
      },
    }));

    const mod = await import('../services/cache');
    cache = mod.cache;
  });

  afterEach(async () => {
    if (cache) {
      await cache.clear();
    }
  });

  it('reports redis strategy when Redis is enabled', () => {
    expect(cache.getStrategy()).toBe('redis');
  });

  it('reports Redis status when adapter exists', () => {
    const status = cache.getRedisStatus();
    expect(status).not.toBeNull();
    expect(status!.connected).toBe(true);
  });

  describe('get()', () => {
    it('returns Redis hit when data exists in Redis', async () => {
      const entry = { value: 'from-redis', insertedAt: Date.now() };
      adapterInstance.get.mockResolvedValueOnce(entry);

      const result = await cache.get<string>('test-key');
      expect(result).toBeDefined();
      expect(result!.value).toBe('from-redis');
      expect(mockRecordCacheHit).toHaveBeenCalled();
    });

    it('falls back to LRU when Redis has no data', async () => {
      // Redis returns nothing
      adapterInstance.get.mockResolvedValue(undefined);

      // Write data (goes to both Redis and LRU)
      await cache.set('lru-key', 'lru-value');

      const result = await cache.get<string>('lru-key');
      expect(result).toBeDefined();
      expect(result!.value).toBe('lru-value');
    });

    it('records cache miss when neither Redis nor LRU has data', async () => {
      adapterInstance.get.mockResolvedValueOnce(undefined);

      const result = await cache.get<string>('missing-key');
      expect(result).toBeUndefined();
      expect(mockRecordCacheMiss).toHaveBeenCalled();
    });

    it('falls back to LRU when Redis is not ready', async () => {
      adapterInstance.isReady.mockReturnValue(false);

      await cache.set('fallback-key', 'fallback-value');

      const result = await cache.get<string>('fallback-key');
      expect(result).toBeDefined();
      expect(result!.value).toBe('fallback-value');
    });
  });

  describe('set()', () => {
    it('writes to both Redis and LRU', async () => {
      await cache.set('dual-write', 'test-value', { etag: '"abc"' });

      expect(adapterInstance.set).toHaveBeenCalled();

      // Verify LRU also has it by disabling Redis
      adapterInstance.isReady.mockReturnValue(false);
      adapterInstance.get.mockResolvedValue(undefined);
      const result = await cache.get<string>('dual-write');
      expect(result).toBeDefined();
      expect(result!.value).toBe('test-value');
    });

    it('continues to write LRU even if Redis set fails', async () => {
      adapterInstance.set.mockRejectedValueOnce(new Error('Redis write failed'));

      await cache.set('resilient-key', 'resilient-value');

      // LRU should still have the value
      adapterInstance.isReady.mockReturnValue(false);
      const result = await cache.get<string>('resilient-key');
      expect(result).toBeDefined();
      expect(result!.value).toBe('resilient-value');
    });
  });

  describe('has()', () => {
    it('returns true when Redis has the key', async () => {
      adapterInstance.has.mockResolvedValueOnce(true);

      const result = await cache.has('exists-in-redis');
      expect(result).toBe(true);
    });

    it('falls back to LRU when Redis is not ready', async () => {
      adapterInstance.isReady.mockReturnValue(false);

      await cache.set('lru-has-test', 'data');

      const result = await cache.has('lru-has-test');
      expect(result).toBe(true);
    });

    it('returns false when key is not found', async () => {
      adapterInstance.has.mockResolvedValueOnce(false);
      adapterInstance.isReady.mockReturnValue(false);

      const result = await cache.has('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('delete()', () => {
    it('deletes from both Redis and LRU', async () => {
      await cache.set('delete-dual', 'value');
      await cache.delete('delete-dual');

      expect(adapterInstance.delete).toHaveBeenCalled();
    });

    it('continues LRU delete even if Redis delete fails', async () => {
      adapterInstance.delete.mockRejectedValueOnce(new Error('Delete failed'));

      await cache.set('resilient-delete', 'value');
      await cache.delete('resilient-delete');

      // LRU should be cleared
      adapterInstance.isReady.mockReturnValue(false);
      const result = await cache.get<string>('resilient-delete');
      expect(result).toBeUndefined();
    });
  });

  describe('clear()', () => {
    it('clears both Redis and LRU', async () => {
      await cache.set('clear-test', 'value');
      await cache.clear();

      expect(adapterInstance.clear).toHaveBeenCalled();
    });
  });

  describe('shutdown()', () => {
    it('disconnects Redis adapter', async () => {
      await cache.shutdown();
      expect(adapterInstance.disconnect).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests with Redis strategy but circuit breaker open
// ---------------------------------------------------------------------------

describe('UnifiedCache with circuit breaker open', () => {
  let cache: Awaited<typeof import('../services/cache')>['cache'];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const adapterInstance = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      has: vi.fn().mockResolvedValue(false),
      delete: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue({ connected: true, reconnectAttempts: 0 }),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };

    vi.doMock('../config/env', () => ({
      config: {
        cache: { maxEntries: 64, ttlMs: 300000 },
        redis: { enabled: true, url: 'redis://localhost:6379', ttlMs: 3600000 },
      },
    }));

    vi.doMock('../services/cache-redis', () => {
      const inst = adapterInstance;
      return {
        RedisCacheAdapter: class FakeRedisCacheAdapter {
          get = inst.get;
          set = inst.set;
          has = inst.has;
          delete = inst.delete;
          clear = inst.clear;
          isReady = inst.isReady;
          getStatus = inst.getStatus;
          disconnect = inst.disconnect;
        },
      };
    });

    vi.doMock('../services/metrics', makeMetricsMock());
    vi.doMock('../utils/logger', makeLoggerMock());

    class MockCircuitOpenError extends Error {
      constructor(name: string) {
        super(`Circuit breaker '${name}' is OPEN`);
        this.name = 'CircuitOpenError';
      }
    }

    vi.doMock('../utils/circuit-breaker', () => ({
      CircuitBreaker: class MockCircuitBreaker {
        async execute<T>(_fn: () => Promise<T>): Promise<T> {
          throw new MockCircuitOpenError('redis-cache');
        }
        getState(): string { return 'OPEN'; }
        reset(): void { /* no-op */ }
      },
      CircuitOpenError: MockCircuitOpenError,
    }));

    const mod = await import('../services/cache');
    cache = mod.cache;
  });

  afterEach(async () => {
    if (cache) {
      await cache.clear();
    }
  });

  it('get() falls back to LRU when circuit is open', async () => {
    // set goes to LRU (circuit open skips Redis)
    await cache.set('cb-fallback', 'lru-data');

    const result = await cache.get<string>('cb-fallback');
    expect(result).toBeDefined();
    expect(result!.value).toBe('lru-data');
  });

  it('has() falls back to LRU when circuit is open', async () => {
    await cache.set('cb-has', 'data');

    const result = await cache.has('cb-has');
    expect(result).toBe(true);
  });

  it('delete() still deletes from LRU when circuit is open', async () => {
    await cache.set('cb-delete', 'data');
    await cache.delete('cb-delete');

    const result = await cache.get<string>('cb-delete');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests with Redis constructor failure (falls back to LRU strategy)
// ---------------------------------------------------------------------------

describe('UnifiedCache when Redis adapter constructor throws', () => {
  let cache: Awaited<typeof import('../services/cache')>['cache'];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.doMock('../config/env', () => ({
      config: {
        cache: { maxEntries: 64, ttlMs: 300000 },
        redis: { enabled: true, url: 'redis://localhost:6379', ttlMs: 3600000 },
      },
    }));

    vi.doMock('../services/cache-redis', () => ({
      RedisCacheAdapter: class ThrowingRedisCacheAdapter {
        constructor() {
          throw new Error('Redis connection refused');
        }
      },
    }));

    vi.doMock('../services/metrics', makeMetricsMock());
    vi.doMock('../utils/logger', makeLoggerMock());

    vi.doMock('../utils/circuit-breaker', () => ({
      CircuitBreaker: class MockCircuitBreaker {
        async execute<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
        getState(): string { return 'CLOSED'; }
        reset(): void { /* no-op */ }
      },
      CircuitOpenError: class extends Error {
        constructor(name: string) { super(name); this.name = 'CircuitOpenError'; }
      },
    }));

    const mod = await import('../services/cache');
    cache = mod.cache;
  });

  afterEach(async () => {
    if (cache) {
      await cache.clear();
    }
  });

  it('falls back to LRU strategy when Redis adapter fails to construct', () => {
    expect(cache.getStrategy()).toBe('lru');
  });

  it('set and get work via LRU path', async () => {
    await cache.set('lru-only', 'works');
    const result = await cache.get<string>('lru-only');
    expect(result).toBeDefined();
    expect(result!.value).toBe('works');
  });
});

// ---------------------------------------------------------------------------
// Edge case: LRU-only mode (Redis disabled)
// ---------------------------------------------------------------------------

describe('UnifiedCache LRU-only edge cases', () => {
  let cache: Awaited<typeof import('../services/cache')>['cache'];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.doMock('../config/env', () => ({
      config: {
        cache: { maxEntries: 64, ttlMs: 300000 },
        redis: { enabled: false, url: '', ttlMs: 3600000 },
      },
    }));

    vi.doMock('../services/cache-redis', () => ({ RedisCacheAdapter: vi.fn() }));
    vi.doMock('../services/metrics', makeMetricsMock());
    vi.doMock('../utils/logger', makeLoggerMock());

    vi.doMock('../utils/circuit-breaker', () => ({
      CircuitBreaker: class MockCircuitBreaker {
        async execute<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
        getState(): string { return 'CLOSED'; }
        reset(): void { /* no-op */ }
      },
      CircuitOpenError: class extends Error {
        constructor(name: string) { super(name); this.name = 'CircuitOpenError'; }
      },
    }));

    const mod = await import('../services/cache');
    cache = mod.cache;
  });

  afterEach(async () => {
    if (cache) {
      await cache.clear();
    }
  });

  it('shutdown is safe when no Redis adapter', async () => {
    await cache.shutdown();
  });

  it('clear is safe when only LRU', async () => {
    await cache.set('x', 1);
    await cache.clear();
    const result = await cache.get('x');
    expect(result).toBeUndefined();
  });

  it('getRedisStatus returns null when no adapter', () => {
    expect(cache.getRedisStatus()).toBeNull();
  });

  it('getStrategy returns lru', () => {
    expect(cache.getStrategy()).toBe('lru');
  });

  it('has returns false for missing key', async () => {
    expect(await cache.has('nope')).toBe(false);
  });

  it('delete on missing key does not throw', async () => {
    await cache.delete('nonexistent');
  });
});
