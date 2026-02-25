/**
 * Redis-backed API Key Store
 *
 * Stores provisioned API key hashes with tier and metadata.
 * Used by auth middleware to validate keys dynamically (no restarts needed).
 *
 * Redis key format: anno:key:{sha256hash}
 * Value: JSON { tier, email, createdAt, active }
 *
 * @module services/key-store
 */

import { createClient, RedisClientType } from 'redis';
import { config } from '../config/env';
import { logger } from '../utils/logger';

export interface StoredKey {
  tier: string;
  email?: string;
  createdAt: string;
  active: boolean;
}

export class KeyStore {
  private client: RedisClientType | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;

  async init(): Promise<void> {
    if (!config.redis.enabled) {
      logger.info('KeyStore: Redis disabled, only env var keys will work');
      return;
    }

    try {
      this.client = createClient({
        url: config.redis.url || 'redis://localhost:6379',
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > this.maxReconnectAttempts) {
              logger.error('KeyStore: Max reconnection attempts reached');
              return false;
            }
            return Math.min(retries * 100, 3000);
          }
        }
      });

      this.client.on('error', (err) => {
        this.isConnected = false;
        logger.error('KeyStore: Redis error', { error: err.message });
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        logger.info('KeyStore: Redis connected');
      });

      this.client.on('reconnecting', () => {
        this.reconnectAttempts++;
      });

      await this.client.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('KeyStore: Failed to connect', { error: msg });
      this.client = null;
      this.isConnected = false;
    }
  }

  /**
   * Provision a new API key by storing its hash with tier metadata.
   */
  async provision(keyHash: string, tier: string, email?: string): Promise<boolean> {
    if (!this.isConnected || !this.client) {
      logger.warn('KeyStore: Cannot provision key, Redis unavailable');
      return false;
    }

    const entry: StoredKey = {
      tier,
      email,
      createdAt: new Date().toISOString(),
      active: true,
    };

    try {
      await this.client.set(this.redisKey(keyHash), JSON.stringify(entry));
      logger.info('KeyStore: Key provisioned', { keyHash: keyHash.slice(0, 8) + '...', tier });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('KeyStore: Provision failed', { error: msg });
      return false;
    }
  }

  /**
   * Look up a key hash. Returns stored metadata if found and active.
   */
  async lookup(keyHash: string): Promise<StoredKey | null> {
    if (!this.isConnected || !this.client) {
      return null;
    }

    try {
      const data = await this.client.get(this.redisKey(keyHash));
      if (!data) return null;

      const entry = JSON.parse(data) as StoredKey;
      return entry.active ? entry : null;
    } catch {
      return null;
    }
  }

  /**
   * Revoke a key by marking it inactive.
   */
  async revoke(keyHash: string): Promise<boolean> {
    if (!this.isConnected || !this.client) {
      return false;
    }

    try {
      const data = await this.client.get(this.redisKey(keyHash));
      if (!data) return false;

      const entry = JSON.parse(data) as StoredKey;
      entry.active = false;
      await this.client.set(this.redisKey(keyHash), JSON.stringify(entry));
      logger.info('KeyStore: Key revoked', { keyHash: keyHash.slice(0, 8) + '...' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all provisioned keys (for admin visibility).
   */
  async listKeys(): Promise<Array<{ hash: string } & StoredKey>> {
    if (!this.isConnected || !this.client) {
      return [];
    }

    try {
      const keys = await this.client.keys('anno:key:*');
      const results: Array<{ hash: string } & StoredKey> = [];

      for (const key of keys) {
        const data = await this.client.get(key);
        if (data) {
          const hash = key.replace('anno:key:', '');
          results.push({ hash: hash.slice(0, 12) + '...', ...JSON.parse(data) });
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
        logger.info('KeyStore: Redis disconnected');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('KeyStore: Disconnect error', { error: msg });
      }
      this.client = null;
      this.isConnected = false;
    }
  }

  isReady(): boolean {
    return this.isConnected && this.client !== null;
  }

  private redisKey(keyHash: string): string {
    return `anno:key:${keyHash}`;
  }
}

// Singleton
let instance: KeyStore | null = null;

export function getKeyStore(): KeyStore {
  if (!instance) {
    instance = new KeyStore();
  }
  return instance;
}
