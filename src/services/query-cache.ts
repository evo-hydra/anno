/**
 * Query Result Caching Service
 *
 * Caches expensive AI/RAG query results to dramatically reduce latency
 * on repeated queries. Uses Redis for persistence and memory for fast access.
 *
 * @module services/query-cache
 */

import { createHash } from 'node:crypto';
import { cache } from './cache';
import { logger } from '../utils/logger';

export interface QueryCacheEntry<T> {
  /** Cached result data */
  result: T;

  /** When this entry was cached */
  cachedAt: number;

  /** TTL in seconds */
  ttl: number;

  /** Query hash for identification */
  queryHash: string;

  /** Optional metadata */
  metadata?: {
    hitCount?: number;
    lastAccessedAt?: number;
  };
}

export interface QueryCacheOptions {
  /** Time-to-live in seconds (default: 3600 = 1 hour) */
  ttl?: number;

  /** Cache key prefix (default: 'query:') */
  prefix?: string;

  /** Whether to use in-memory cache as well (default: true) */
  useMemoryCache?: boolean;

  /** Skip cache and force fresh query (default: false) */
  skipCache?: boolean;
}

/**
 * In-memory LRU cache for hot queries
 */
class MemoryCache<T> {
  private cache = new Map<string, QueryCacheEntry<T>>();
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  get(key: string): QueryCacheEntry<T> | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check if expired
    const age = Date.now() - entry.cachedAt;
    if (age > entry.ttl * 1000) {
      this.cache.delete(key);
      return null;
    }

    // Update access time
    if (entry.metadata) {
      entry.metadata.lastAccessedAt = Date.now();
      entry.metadata.hitCount = (entry.metadata.hitCount || 0) + 1;
    }

    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry;
  }

  set(key: string, entry: QueryCacheEntry<T>): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, entry);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  getStats() {
    const entries = Array.from(this.cache.values());
    const totalHits = entries.reduce((sum, e) => sum + (e.metadata?.hitCount || 0), 0);
    const avgAge = entries.reduce((sum, e) => sum + (Date.now() - e.cachedAt), 0) / entries.length;

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      totalHits,
      avgAgeMs: avgAge || 0
    };
  }
}

/**
 * Query Cache Service
 *
 * Two-tier caching: Memory (fast, limited) + Redis (persistent, larger)
 */
export class QueryCache {
  private memoryCache = new MemoryCache(1000);
  private readonly defaultTTL = 3600; // 1 hour
  private readonly defaultPrefix = 'query:';

  /**
   * Generate cache key from query parameters
   */
  private generateCacheKey(query: string, params?: Record<string, unknown>, prefix = 'query:'): string {
    const queryNormalized = query.trim().toLowerCase();
    const paramsStr = params ? JSON.stringify(params, Object.keys(params).sort()) : '';
    const hash = createHash('sha256')
      .update(queryNormalized + paramsStr)
      .digest('hex')
      .slice(0, 16); // First 16 chars is enough

    return `${prefix}${hash}`;
  }

  /**
   * Get cached query result
   */
  async get<T>(
    query: string,
    params?: Record<string, unknown>,
    options: QueryCacheOptions = {}
  ): Promise<T | null> {
    const { prefix = this.defaultPrefix, useMemoryCache = true, skipCache = false } = options;

    if (skipCache) return null;

    const cacheKey = this.generateCacheKey(query, params, prefix);

    // Try memory cache first (fastest)
    if (useMemoryCache) {
      const memoryEntry = this.memoryCache.get(cacheKey);
      if (memoryEntry) {
        logger.debug(`Query cache HIT (memory): ${cacheKey}`);
        return memoryEntry.result as T;
      }
    }

    // Try Redis cache
    try {
      const cacheEntry = await cache.get<QueryCacheEntry<T>>(cacheKey);
      if (cacheEntry) {
        const entry = cacheEntry.value;

        // Add to memory cache for next time
        if (useMemoryCache) {
          this.memoryCache.set(cacheKey, entry);
        }

        logger.debug(`Query cache HIT (redis): ${cacheKey}`);
        return entry.result;
      }
    } catch (error) {
      logger.warn(`Query cache read error: ${error}`);
    }

    logger.debug(`Query cache MISS: ${cacheKey}`);
    return null;
  }

  /**
   * Set cached query result
   */
  async set<T>(
    query: string,
    result: T,
    params?: Record<string, unknown>,
    options: QueryCacheOptions = {}
  ): Promise<void> {
    const {
      ttl = this.defaultTTL,
      prefix = this.defaultPrefix,
      useMemoryCache = true
    } = options;

    const cacheKey = this.generateCacheKey(query, params, prefix);
    const queryHash = cacheKey.split(':')[1];

    const entry: QueryCacheEntry<T> = {
      result,
      cachedAt: Date.now(),
      ttl,
      queryHash,
      metadata: {
        hitCount: 0,
        lastAccessedAt: Date.now()
      }
    };

    // Set in Redis
    try {
      await cache.set(cacheKey, entry);
      logger.debug(`Query cached (redis): ${cacheKey}, TTL: ${ttl}s`);
    } catch (error) {
      logger.warn(`Query cache write error: ${error}`);
    }

    // Set in memory cache
    if (useMemoryCache) {
      this.memoryCache.set(cacheKey, entry);
      logger.debug(`Query cached (memory): ${cacheKey}`);
    }
  }

  /**
   * Get or compute query result with caching
   */
  async getOrCompute<T>(
    query: string,
    computeFn: () => Promise<T>,
    params?: Record<string, unknown>,
    options: QueryCacheOptions = {}
  ): Promise<{ result: T; cached: boolean }> {
    // Try to get from cache
    const cached = await this.get<T>(query, params, options);
    if (cached !== null) {
      return { result: cached, cached: true };
    }

    // Compute fresh result
    const result = await computeFn();

    // Cache the result
    await this.set(query, result, params, options);

    return { result, cached: false };
  }

  /**
   * Invalidate cached query
   */
  async invalidate(query: string, params?: Record<string, unknown>, prefix = 'query:'): Promise<void> {
    const cacheKey = this.generateCacheKey(query, params, prefix);

    // Remove from Redis
    try {
      await cache.delete(cacheKey);
    } catch (error) {
      logger.warn(`Query cache invalidation error: ${error}`);
    }

    logger.debug(`Query cache invalidated: ${cacheKey}`);
  }

  /**
   * Clear all cached queries
   */
  async clear(_prefix = 'query:'): Promise<void> {
    this.memoryCache.clear();

    // Note: Clearing Redis requires scanning keys which is expensive
    // In production, rely on TTL expiration instead
    logger.info('Query cache cleared (memory only)');
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      memory: this.memoryCache.getStats(),
      redis: {
        enabled: cache.getStrategy() === 'redis',
        status: cache.getRedisStatus()
      }
    };
  }
}

// Singleton instance
export const queryCache = new QueryCache();
