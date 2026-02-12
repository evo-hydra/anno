import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted ensures these are available when vi.mock factories run
// ---------------------------------------------------------------------------

const {
  mockCacheGet,
  mockCacheSet,
  mockCacheDelete,
  mockCacheGetStrategy,
  mockCacheGetRedisStatus,
} = vi.hoisted(() => ({
  mockCacheGet: vi.fn(),
  mockCacheSet: vi.fn(),
  mockCacheDelete: vi.fn(),
  mockCacheGetStrategy: vi.fn().mockReturnValue('lru'),
  mockCacheGetRedisStatus: vi.fn().mockReturnValue(null),
}));

vi.mock('../services/cache', () => ({
  cache: {
    get: mockCacheGet,
    set: mockCacheSet,
    delete: mockCacheDelete,
    getStrategy: mockCacheGetStrategy,
    getRedisStatus: mockCacheGetRedisStatus,
  },
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { QueryCache } from '../services/query-cache';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueryCache', () => {
  let queryCache: QueryCache;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheGet.mockResolvedValue(undefined);
    mockCacheSet.mockResolvedValue(undefined);
    mockCacheDelete.mockResolvedValue(undefined);

    queryCache = new QueryCache();
  });

  // =========================================================================
  // get()
  // =========================================================================

  describe('get', () => {
    it('returns null on cache miss (no memory, no redis)', async () => {
      const result = await queryCache.get('test query');
      expect(result).toBeNull();
    });

    it('returns null when skipCache is true', async () => {
      // Prime the memory cache first
      await queryCache.set('test query', { data: 'cached' });

      const result = await queryCache.get('test query', undefined, { skipCache: true });
      expect(result).toBeNull();
    });

    it('returns result from memory cache on hit', async () => {
      // Populate the cache first
      await queryCache.set('test query', { answer: 42 });

      const result = await queryCache.get('test query');
      expect(result).toEqual({ answer: 42 });
    });

    it('promotes Redis hit to memory cache', async () => {
      const entry = {
        result: { data: 'from-redis' },
        cachedAt: Date.now(),
        ttl: 3600,
        queryHash: 'abc123',
        metadata: { hitCount: 0, lastAccessedAt: Date.now() },
      };

      mockCacheGet.mockResolvedValueOnce({ value: entry });

      const result = await queryCache.get('redis query');
      expect(result).toEqual({ data: 'from-redis' });

      // Second call should come from memory, not Redis
      mockCacheGet.mockResolvedValueOnce(undefined);
      const result2 = await queryCache.get('redis query');
      expect(result2).toEqual({ data: 'from-redis' });
    });

    it('handles Redis read error gracefully', async () => {
      mockCacheGet.mockRejectedValueOnce(new Error('Redis down'));

      const result = await queryCache.get('query with error');
      expect(result).toBeNull();
    });

    it('skips memory cache when useMemoryCache is false', async () => {
      // Populate memory cache
      await queryCache.set('query', { data: 'cached' });

      // Redis miss
      mockCacheGet.mockResolvedValueOnce(undefined);

      const result = await queryCache.get('query', undefined, { useMemoryCache: false });
      expect(result).toBeNull();
    });

    it('normalizes query (case-insensitive, trimmed) for cache key', async () => {
      await queryCache.set('  Hello World  ', { data: 'stored' });

      const result = await queryCache.get('hello world');
      expect(result).toEqual({ data: 'stored' });
    });

    it('distinguishes queries with different params', async () => {
      await queryCache.set('query', { data: 'a' }, { param: 'a' });

      // Different params should be a cache miss in memory
      const result = await queryCache.get('query', { param: 'b' });
      expect(result).toBeNull();
    });

    it('returns same result for same query with same params', async () => {
      await queryCache.set('query', { data: 'matched' }, { key: 'value' });

      const result = await queryCache.get('query', { key: 'value' });
      expect(result).toEqual({ data: 'matched' });
    });

    it('uses custom prefix for cache key', async () => {
      await queryCache.set('query', { data: 'custom' }, undefined, { prefix: 'custom:' });

      // Default prefix won't find it in memory
      const miss = await queryCache.get('query');
      expect(miss).toBeNull();

      // Custom prefix finds it
      const hit = await queryCache.get('query', undefined, { prefix: 'custom:' });
      expect(hit).toEqual({ data: 'custom' });
    });
  });

  // =========================================================================
  // set()
  // =========================================================================

  describe('set', () => {
    it('stores entry in both Redis and memory cache', async () => {
      await queryCache.set('new query', { result: 'data' });

      expect(mockCacheSet).toHaveBeenCalledOnce();
      // Verify it's stored in memory by retrieving
      const result = await queryCache.get('new query');
      expect(result).toEqual({ result: 'data' });
    });

    it('handles Redis write error gracefully', async () => {
      mockCacheSet.mockRejectedValueOnce(new Error('Redis write failed'));

      // Should not throw
      await expect(
        queryCache.set('query', { data: 'value' })
      ).resolves.toBeUndefined();

      // Memory cache should still work
      const result = await queryCache.get('query');
      expect(result).toEqual({ data: 'value' });
    });

    it('skips memory cache when useMemoryCache is false', async () => {
      await queryCache.set('query', { data: 'redis-only' }, undefined, {
        useMemoryCache: false,
      });

      expect(mockCacheSet).toHaveBeenCalledOnce();

      // Memory cache should not have it
      mockCacheGet.mockResolvedValueOnce(undefined);
      const result = await queryCache.get('query', undefined, { useMemoryCache: false });
      expect(result).toBeNull();
    });

    it('stores entry with custom TTL', async () => {
      await queryCache.set('query', { data: 'ttl' }, undefined, { ttl: 60 });

      // Verify the Redis call received the entry with TTL = 60
      expect(mockCacheSet).toHaveBeenCalledOnce();
      const storedEntry = mockCacheSet.mock.calls[0][1];
      expect(storedEntry.ttl).toBe(60);
    });

    it('stores metadata with hitCount and lastAccessedAt', async () => {
      await queryCache.set('query', { data: 'meta' });

      const storedEntry = mockCacheSet.mock.calls[0][1];
      expect(storedEntry.metadata).toBeDefined();
      expect(storedEntry.metadata.hitCount).toBe(0);
      expect(typeof storedEntry.metadata.lastAccessedAt).toBe('number');
    });
  });

  // =========================================================================
  // getOrCompute()
  // =========================================================================

  describe('getOrCompute', () => {
    it('returns cached result when available', async () => {
      await queryCache.set('cached query', { data: 'precomputed' });

      const computeFn = vi.fn().mockResolvedValue({ data: 'fresh' });

      const { result, cached } = await queryCache.getOrCompute(
        'cached query',
        computeFn
      );

      expect(result).toEqual({ data: 'precomputed' });
      expect(cached).toBe(true);
      expect(computeFn).not.toHaveBeenCalled();
    });

    it('computes and caches result on cache miss', async () => {
      const computeFn = vi.fn().mockResolvedValue({ data: 'computed' });

      const { result, cached } = await queryCache.getOrCompute(
        'new query',
        computeFn
      );

      expect(result).toEqual({ data: 'computed' });
      expect(cached).toBe(false);
      expect(computeFn).toHaveBeenCalledOnce();

      // Verify it was cached
      const cachedResult = await queryCache.get('new query');
      expect(cachedResult).toEqual({ data: 'computed' });
    });

    it('passes params to cache key generation', async () => {
      const computeFn = vi.fn().mockResolvedValue({ data: 'result' });

      await queryCache.getOrCompute('query', computeFn, { page: 1 });

      // Verify it's cached with the same params
      const hit = await queryCache.get('query', { page: 1 });
      expect(hit).toEqual({ data: 'result' });

      // Different params should miss
      const miss = await queryCache.get('query', { page: 2 });
      expect(miss).toBeNull();
    });

    it('passes options through to get and set', async () => {
      const computeFn = vi.fn().mockResolvedValue({ data: 'val' });

      await queryCache.getOrCompute('q', computeFn, undefined, {
        prefix: 'special:',
        ttl: 120,
      });

      const storedEntry = mockCacheSet.mock.calls[0][1];
      expect(storedEntry.ttl).toBe(120);
    });

    it('skips cache when skipCache option is true', async () => {
      // Pre-populate
      await queryCache.set('query', { data: 'old' });

      const computeFn = vi.fn().mockResolvedValue({ data: 'new' });

      const { result, cached } = await queryCache.getOrCompute(
        'query',
        computeFn,
        undefined,
        { skipCache: true }
      );

      expect(result).toEqual({ data: 'new' });
      expect(cached).toBe(false);
      expect(computeFn).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // invalidate()
  // =========================================================================

  describe('invalidate', () => {
    it('deletes entry from Redis', async () => {
      await queryCache.invalidate('query to invalidate');

      expect(mockCacheDelete).toHaveBeenCalledOnce();
    });

    it('handles Redis delete error gracefully', async () => {
      mockCacheDelete.mockRejectedValueOnce(new Error('Redis delete failed'));

      // Should not throw
      await expect(queryCache.invalidate('query')).resolves.toBeUndefined();
    });

    it('uses custom prefix when provided', async () => {
      await queryCache.invalidate('query', undefined, 'custom:');

      const key = mockCacheDelete.mock.calls[0][0];
      expect(key).toMatch(/^custom:/);
    });

    it('uses params for cache key', async () => {
      await queryCache.invalidate('query', { key: 'val' });
      await queryCache.invalidate('query');

      // Two different calls with different cache keys
      const key1 = mockCacheDelete.mock.calls[0][0];
      const key2 = mockCacheDelete.mock.calls[1][0];
      expect(key1).not.toBe(key2);
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================

  describe('clear', () => {
    it('clears the in-memory cache', async () => {
      await queryCache.set('query1', { data: 'a' });
      await queryCache.set('query2', { data: 'b' });

      await queryCache.clear();

      // Memory cache should be empty
      const result1 = await queryCache.get('query1');
      const result2 = await queryCache.get('query2');
      expect(result1).toBeNull();
      expect(result2).toBeNull();
    });
  });

  // =========================================================================
  // getStats()
  // =========================================================================

  describe('getStats', () => {
    it('returns memory and redis stats', () => {
      const stats = queryCache.getStats();

      expect(stats.memory).toBeDefined();
      expect(typeof stats.memory.size).toBe('number');
      expect(typeof stats.memory.maxSize).toBe('number');
      expect(typeof stats.memory.totalHits).toBe('number');
      expect(typeof stats.memory.avgAgeMs).toBe('number');

      expect(stats.redis).toBeDefined();
      expect(stats.redis.enabled).toBe(false); // 'lru' strategy
    });

    it('reflects correct memory cache size', async () => {
      await queryCache.set('q1', { a: 1 });
      await queryCache.set('q2', { b: 2 });

      const stats = queryCache.getStats();
      expect(stats.memory.size).toBe(2);
    });

    it('reports redis as enabled when strategy is redis', () => {
      mockCacheGetStrategy.mockReturnValueOnce('redis');
      mockCacheGetRedisStatus.mockReturnValueOnce({ connected: true, reconnectAttempts: 0 });

      const stats = queryCache.getStats();
      expect(stats.redis.enabled).toBe(true);
      expect(stats.redis.status).toEqual({ connected: true, reconnectAttempts: 0 });
    });
  });

  // =========================================================================
  // MemoryCache LRU eviction
  // =========================================================================

  describe('memory cache LRU behavior', () => {
    it('expires entries after TTL', async () => {
      // Set a very short TTL entry
      const shortTtlCache = new QueryCache();

      // We need to set directly into the memory cache with a very old cachedAt
      // by using the normal set method and then manipulating time
      const originalDateNow = Date.now;

      // Set at time T
      await shortTtlCache.set('old query', { data: 'old' }, undefined, { ttl: 1 });

      // Advance time beyond TTL (1 second = 1000ms)
      Date.now = () => originalDateNow() + 2000;

      try {
        // Redis returns undefined (miss)
        mockCacheGet.mockResolvedValueOnce(undefined);

        const result = await shortTtlCache.get('old query');
        expect(result).toBeNull();
      } finally {
        Date.now = originalDateNow;
      }
    });

    it('tracks hit count in metadata', async () => {
      await queryCache.set('popular query', { data: 'popular' });

      // Access multiple times
      await queryCache.get('popular query');
      await queryCache.get('popular query');
      await queryCache.get('popular query');

      const stats = queryCache.getStats();
      expect(stats.memory.totalHits).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Cache key generation — deterministic hashing
  // =========================================================================

  describe('cache key generation', () => {
    it('generates consistent keys for same input', async () => {
      const calls: string[] = [];
      mockCacheSet.mockImplementation((key: string) => {
        calls.push(key);
        return Promise.resolve();
      });

      await queryCache.set('test query', { a: 1 });
      await queryCache.set('test query', { b: 2 });

      // Same query should produce same key
      expect(calls[0]).toBe(calls[1]);
    });

    it('generates different keys for different queries', async () => {
      const calls: string[] = [];
      mockCacheSet.mockImplementation((key: string) => {
        calls.push(key);
        return Promise.resolve();
      });

      await queryCache.set('query alpha', { a: 1 });
      await queryCache.set('query beta', { b: 2 });

      expect(calls[0]).not.toBe(calls[1]);
    });

    it('generates different keys for different params', async () => {
      const calls: string[] = [];
      mockCacheSet.mockImplementation((key: string) => {
        calls.push(key);
        return Promise.resolve();
      });

      await queryCache.set('query', { a: 1 }, { page: 1 });
      await queryCache.set('query', { b: 2 }, { page: 2 });

      expect(calls[0]).not.toBe(calls[1]);
    });

    it('sorts params keys for deterministic hashing', async () => {
      const calls: string[] = [];
      mockCacheSet.mockImplementation((key: string) => {
        calls.push(key);
        return Promise.resolve();
      });

      await queryCache.set('query', { a: 1 }, { b: 2, a: 1 });
      await queryCache.set('query', { a: 1 }, { a: 1, b: 2 });

      // Same params in different order should produce same key
      expect(calls[0]).toBe(calls[1]);
    });
  });
});
