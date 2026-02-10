/**
 * Redis Cache Adapter
 *
 * Persistent caching layer with graceful fallback to in-memory LRU.
 *
 * @module cache-redis
 */

import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';
import { CacheEntry } from './cache';

export interface RedisCacheConfig {
  url?: string;
  ttl: number;
  enabled: boolean;
}

export class RedisCacheAdapter {
  private client: RedisClientType | null = null;
  private isConnected = false;
  private readonly config: RedisCacheConfig;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;

  constructor(config: RedisCacheConfig) {
    this.config = config;
    if (config.enabled) {
      this.connect();
    }
  }

  private async connect(): Promise<void> {
    try {
      this.client = createClient({
        url: this.config.url || 'redis://localhost:6379',
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > this.maxReconnectAttempts) {
              logger.error('Redis: Max reconnection attempts reached, giving up');
              return false;
            }
            const delay = Math.min(retries * 100, 3000);
            logger.info(`Redis: Reconnecting in ${delay}ms (attempt ${retries})`);
            return delay;
          }
        }
      });

      this.client.on('error', (err) => {
        logger.error('Redis client error:', err);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        logger.info('Redis: Connected successfully');
        this.isConnected = true;
        this.reconnectAttempts = 0;
      });

      this.client.on('ready', () => {
        logger.info('Redis: Client ready');
      });

      this.client.on('reconnecting', () => {
        this.reconnectAttempts++;
        logger.warn(`Redis: Reconnecting (attempt ${this.reconnectAttempts})`);
      });

      await this.client.connect();
    } catch (error: unknown) {
      logger.error('Redis: Failed to connect', error as Record<string, unknown>);
      this.isConnected = false;
      this.client = null;
    }
  }

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    if (!this.isConnected || !this.client) {
      return undefined;
    }

    try {
      const data = await this.client.get(key);
      if (!data) {
        return undefined;
      }

      const entry = JSON.parse(data) as CacheEntry<T>;
      return entry;
    } catch (error: unknown) {
      logger.error(`Redis: Failed to get key ${key}`, error as Record<string, unknown>);
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (!this.isConnected || !this.client) {
      return;
    }

    try {
      const entry: CacheEntry<T> = {
        value,
        insertedAt: Date.now()
      };

      await this.client.set(
        key,
        JSON.stringify(entry),
        {
          EX: Math.floor(this.config.ttl / 1000) // Convert ms to seconds
        }
      );
    } catch (error: unknown) {
      logger.error(`Redis: Failed to set key ${key}`, error as Record<string, unknown>);
    }
  }

  async has(key: string): Promise<boolean> {
    if (!this.isConnected || !this.client) {
      return false;
    }

    try {
      const exists = await this.client.exists(key);
      return exists === 1;
    } catch (error: unknown) {
      logger.error(`Redis: Failed to check key ${key}`, error as Record<string, unknown>);
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.isConnected || !this.client) {
      return;
    }

    try {
      await this.client.del(key);
    } catch (error: unknown) {
      logger.error(`Redis: Failed to delete key ${key}`, error as Record<string, unknown>);
    }
  }

  async clear(): Promise<void> {
    if (!this.isConnected || !this.client) {
      return;
    }

    try {
      await this.client.flushDb();
      logger.info('Redis: Cache cleared');
    } catch (error: unknown) {
      logger.error('Redis: Failed to clear cache', error as Record<string, unknown>);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
        logger.info('Redis: Disconnected gracefully');
      } catch (error: unknown) {
        logger.error('Redis: Error during disconnect', error as Record<string, unknown>);
      }
      this.isConnected = false;
      this.client = null;
    }
  }

  getStatus(): { connected: boolean; reconnectAttempts: number } {
    return {
      connected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts
    };
  }

  isReady(): boolean {
    return this.isConnected && this.client !== null;
  }
}
