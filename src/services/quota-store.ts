/**
 * Redis-backed Monthly Quota Store
 *
 * Tracks per-tenant monthly request counts using Redis INCR with auto-expiring keys.
 * Falls back to in-memory Map when Redis is unavailable.
 *
 * Redis key format: anno:quota:{tenantId}:{YYYY-MM}
 * Keys auto-expire via TTL at month end + 1 day buffer.
 *
 * @module services/quota-store
 */

import { createClient, RedisClientType } from 'redis';
import { config } from '../config/env';
import { logger } from '../utils/logger';

export interface QuotaInfo {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: Date;
}

export class QuotaStore {
  private client: RedisClientType | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private fallbackMap = new Map<string, number>();

  async init(): Promise<void> {
    if (!config.redis.enabled) {
      logger.info('QuotaStore: Redis disabled, using in-memory fallback');
      return;
    }

    try {
      this.client = createClient({
        url: config.redis.url || 'redis://localhost:6379',
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > this.maxReconnectAttempts) {
              logger.error('QuotaStore: Max reconnection attempts reached');
              return false;
            }
            const delay = Math.min(retries * 100, 3000);
            return delay;
          }
        }
      });

      this.client.on('error', (err) => {
        this.isConnected = false;
        logger.error('QuotaStore: Redis error', { error: err.message });
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        logger.info('QuotaStore: Redis connected');
      });

      this.client.on('reconnecting', () => {
        this.reconnectAttempts++;
      });

      await this.client.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('QuotaStore: Failed to connect, using in-memory fallback', { error: msg });
      this.client = null;
      this.isConnected = false;
    }
  }

  /**
   * Increment and return the current month's usage for a tenant.
   * Uses Redis INCR (atomic) with auto-expiring TTL.
   */
  async increment(tenantId: string): Promise<number> {
    const monthKey = this.monthKey(tenantId);

    if (this.isConnected && this.client) {
      try {
        const count = await this.client.incr(monthKey);
        if (count === 1) {
          // First request this month — set TTL to expire after month ends
          const ttl = this.secondsUntilMonthEnd() + 86400; // +1 day buffer
          await this.client.expire(monthKey, ttl);
        }
        return count;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('QuotaStore: Redis INCR failed, falling back to in-memory', { error: msg });
      }
    }

    // In-memory fallback
    const current = (this.fallbackMap.get(monthKey) ?? 0) + 1;
    this.fallbackMap.set(monthKey, current);
    return current;
  }

  /**
   * Get current month's usage without incrementing.
   */
  async getUsage(tenantId: string): Promise<number> {
    const monthKey = this.monthKey(tenantId);

    if (this.isConnected && this.client) {
      try {
        const val = await this.client.get(monthKey);
        return val ? parseInt(val, 10) : 0;
      } catch {
        // Fall through to in-memory
      }
    }

    return this.fallbackMap.get(monthKey) ?? 0;
  }

  /**
   * Get the UTC date when quotas reset (first of next month).
   */
  getResetDate(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
        logger.info('QuotaStore: Redis disconnected');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('QuotaStore: Disconnect error', { error: msg });
      }
      this.client = null;
      this.isConnected = false;
    }
  }

  isReady(): boolean {
    return this.isConnected && this.client !== null;
  }

  private monthKey(tenantId: string): string {
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    return `anno:quota:${tenantId}:${month}`;
  }

  private secondsUntilMonthEnd(): number {
    const resetDate = this.getResetDate();
    return Math.ceil((resetDate.getTime() - Date.now()) / 1000);
  }
}

// Singleton
let instance: QuotaStore | null = null;

export function getQuotaStore(): QuotaStore {
  if (!instance) {
    instance = new QuotaStore();
  }
  return instance;
}
