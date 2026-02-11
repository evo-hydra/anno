/**
 * Unified Cache Interface
 *
 * Provides Redis caching with graceful fallback to in-memory LRU.
 *
 * @module cache
 */

import { LRUCache } from 'lru-cache';
import { config } from '../config/env';
import { RedisCacheAdapter } from './cache-redis';
import { logger } from '../utils/logger';
import { metrics } from './metrics';
import { CircuitBreaker, CircuitOpenError } from '../utils/circuit-breaker';

export interface CacheEntry<T> {
  value: T;
  insertedAt: number;
  etag?: string;
  lastModified?: string;
  contentHash?: string;
}

export type CacheStrategy = 'redis' | 'lru';

class MemoryCache {
  private readonly cache: LRUCache<string, CacheEntry<unknown>>;

  constructor() {
    this.cache = new LRUCache<string, CacheEntry<unknown>>({
      max: config.cache.maxEntries,
      ttl: config.cache.ttlMs
    });
  }

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    return this.cache.get(key) as CacheEntry<T> | undefined;
  }

  async set<T>(key: string, value: T, metadata?: { etag?: string; lastModified?: string; contentHash?: string }): Promise<void> {
    this.cache.set(key, {
      value,
      insertedAt: Date.now(),
      etag: metadata?.etag,
      lastModified: metadata?.lastModified,
      contentHash: metadata?.contentHash
    });
  }

  async has(key: string): Promise<boolean> {
    return this.cache.has(key);
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }
}

class UnifiedCache {
  private redisAdapter: RedisCacheAdapter | null = null;
  private lruCache: MemoryCache;
  private strategy: CacheStrategy = 'lru';
  private redisCircuitBreaker: CircuitBreaker;

  constructor() {
    this.lruCache = new MemoryCache();
    this.redisCircuitBreaker = new CircuitBreaker({
      name: 'redis-cache',
      failureThreshold: 5,
      resetTimeoutMs: 30000,
      halfOpenMaxAttempts: 1,
    });

    if (config.redis.enabled) {
      try {
        this.redisAdapter = new RedisCacheAdapter({
          url: config.redis.url,
          ttl: config.redis.ttlMs,
          enabled: config.redis.enabled
        });
        this.strategy = 'redis';
        logger.info('Cache: Using Redis strategy');
      } catch (error: unknown) {
        logger.error('Cache: Failed to initialize Redis, falling back to LRU', error as Record<string, unknown>);
        this.strategy = 'lru';
      }
    } else {
      logger.info('Cache: Using in-memory LRU strategy');
    }
  }

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const startTime = Date.now();

    try {
      // Try Redis first if available, guarded by circuit breaker
      if (this.strategy === 'redis' && this.redisAdapter?.isReady()) {
        try {
          const result = await this.redisCircuitBreaker.execute(async () => {
            return this.redisAdapter!.get<T>(key);
          });
          const duration = Date.now() - startTime;

          if (result !== undefined) {
            metrics.recordCacheHit();
            metrics.recordCacheLookup(duration);
            logger.debug(`Cache HIT (Redis): ${key} in ${duration}ms`);
            return result;
          }
        } catch (error: unknown) {
          if (error instanceof CircuitOpenError) {
            logger.debug(`Cache: Redis circuit open, falling back to LRU for key ${key}`);
          } else {
            throw error;
          }
        }
      }

      // Fallback to LRU
      const result = await this.lruCache.get<T>(key);
      const duration = Date.now() - startTime;

      if (result !== undefined) {
        metrics.recordCacheHit();
        metrics.recordCacheLookup(duration);
        logger.debug(`Cache HIT (LRU): ${key} in ${duration}ms`);
        return result;
      }

      metrics.recordCacheMiss();
      metrics.recordCacheLookup(duration);
      logger.debug(`Cache MISS: ${key} in ${duration}ms`);
      return undefined;

    } catch (error: unknown) {
      logger.error(`Cache: Error during get for key ${key}`, error as Record<string, unknown>);
      metrics.recordCacheMiss();
      return undefined;
    }
  }

  async set<T>(key: string, value: T, metadata?: { etag?: string; lastModified?: string; contentHash?: string }): Promise<void> {
    try {
      // Write to both Redis and LRU for redundancy
      if (this.strategy === 'redis' && this.redisAdapter?.isReady()) {
        try {
          await this.redisCircuitBreaker.execute(async () => {
            await this.redisAdapter!.set(key, value);
          });
          logger.debug(`Cache SET (Redis): ${key}`);
        } catch (error: unknown) {
          if (error instanceof CircuitOpenError) {
            logger.debug(`Cache: Redis circuit open, skipping Redis SET for key ${key}`);
          } else {
            logger.error(`Cache: Redis SET failed for key ${key}`, error as Record<string, unknown>);
          }
        }
      }

      // Always write to LRU as fallback layer
      await this.lruCache.set(key, value, metadata);
      logger.debug(`Cache SET (LRU): ${key}`, { etag: metadata?.etag, lastModified: metadata?.lastModified });

    } catch (error: unknown) {
      logger.error(`Cache: Error during set for key ${key}`, error as Record<string, unknown>);
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      if (this.strategy === 'redis' && this.redisAdapter?.isReady()) {
        try {
          return await this.redisCircuitBreaker.execute(async () => {
            return this.redisAdapter!.has(key);
          });
        } catch (error: unknown) {
          if (error instanceof CircuitOpenError) {
            logger.debug(`Cache: Redis circuit open, falling back to LRU for has check on key ${key}`);
          } else {
            throw error;
          }
        }
      }
      return await this.lruCache.has(key);
    } catch (error: unknown) {
      logger.error(`Cache: Error during has for key ${key}`, error as Record<string, unknown>);
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      if (this.strategy === 'redis' && this.redisAdapter?.isReady()) {
        try {
          await this.redisCircuitBreaker.execute(async () => {
            await this.redisAdapter!.delete(key);
          });
        } catch (error: unknown) {
          if (error instanceof CircuitOpenError) {
            logger.debug(`Cache: Redis circuit open, skipping Redis DELETE for key ${key}`);
          } else {
            logger.error(`Cache: Redis DELETE failed for key ${key}`, error as Record<string, unknown>);
          }
        }
      }
      await this.lruCache.delete(key);
      logger.debug(`Cache DELETE: ${key}`);
    } catch (error: unknown) {
      logger.error(`Cache: Error during delete for key ${key}`, error as Record<string, unknown>);
    }
  }

  async clear(): Promise<void> {
    try {
      if (this.strategy === 'redis' && this.redisAdapter?.isReady()) {
        await this.redisAdapter.clear();
      }
      await this.lruCache.clear();
      logger.info('Cache: Cleared all entries');
    } catch (error: unknown) {
      logger.error('Cache: Error during clear', error as Record<string, unknown>);
    }
  }

  getStrategy(): CacheStrategy {
    return this.strategy;
  }

  getRedisStatus(): { connected: boolean; reconnectAttempts: number } | null {
    if (this.redisAdapter) {
      return this.redisAdapter.getStatus();
    }
    return null;
  }

  async shutdown(): Promise<void> {
    if (this.redisAdapter) {
      await this.redisAdapter.disconnect();
    }
  }
}

export const cache = new UnifiedCache();
