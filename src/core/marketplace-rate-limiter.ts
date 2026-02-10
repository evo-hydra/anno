/**
 * Marketplace Rate Limiter
 *
 * Multi-tier token bucket rate limiter supporting per-second, per-minute,
 * and per-hour limits. Designed for marketplace adapters with strict
 * compliance requirements.
 *
 * @module marketplace-rate-limiter
 */

import { logger } from '../utils/logger';

export interface RateLimiterConfig {
  requestsPerSecond?: number;
  requestsPerMinute?: number;
  requestsPerHour?: number;
  burstSize?: number; // Optional burst capacity
}

interface Bucket {
  capacity: number;
  tokens: number;
  lastRefill: number;
  refillInterval: number; // milliseconds
}

/**
 * Multi-tier rate limiter with second/minute/hour enforcement
 */
export class RateLimiter {
  private secondBucket?: Bucket;
  private minuteBucket?: Bucket;
  private hourBucket?: Bucket;
  private enabled: boolean;

  constructor(config: RateLimiterConfig) {
    this.enabled = true;

    // Initialize second-level bucket
    if (config.requestsPerSecond !== undefined && config.requestsPerSecond > 0) {
      const capacity = config.burstSize || config.requestsPerSecond;
      this.secondBucket = {
        capacity,
        tokens: capacity,
        lastRefill: Date.now(),
        refillInterval: 1000, // 1 second
      };
    }

    // Initialize minute-level bucket
    if (config.requestsPerMinute !== undefined && config.requestsPerMinute > 0) {
      this.minuteBucket = {
        capacity: config.requestsPerMinute,
        tokens: config.requestsPerMinute,
        lastRefill: Date.now(),
        refillInterval: 60000, // 1 minute
      };
    }

    // Initialize hour-level bucket
    if (config.requestsPerHour !== undefined && config.requestsPerHour > 0) {
      this.hourBucket = {
        capacity: config.requestsPerHour,
        tokens: config.requestsPerHour,
        lastRefill: Date.now(),
        refillInterval: 3600000, // 1 hour
      };
    }

    logger.debug('RateLimiter initialized', {
      perSecond: config.requestsPerSecond,
      perMinute: config.requestsPerMinute,
      perHour: config.requestsPerHour,
      burstSize: config.burstSize,
    });
  }

  /**
   * Check if a request can proceed (non-blocking check)
   * @returns true if allowed, false if rate limited
   */
  async checkLimit(): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }

    // Refill all buckets
    this.refillBucket(this.secondBucket);
    this.refillBucket(this.minuteBucket);
    this.refillBucket(this.hourBucket);

    // Check if all buckets have tokens
    const secondAllowed = !this.secondBucket || this.secondBucket.tokens >= 1;
    const minuteAllowed = !this.minuteBucket || this.minuteBucket.tokens >= 1;
    const hourAllowed = !this.hourBucket || this.hourBucket.tokens >= 1;

    if (secondAllowed && minuteAllowed && hourAllowed) {
      // Consume tokens from all buckets
      if (this.secondBucket) this.secondBucket.tokens -= 1;
      if (this.minuteBucket) this.minuteBucket.tokens -= 1;
      if (this.hourBucket) this.hourBucket.tokens -= 1;

      logger.debug('Rate limit check: allowed', {
        secondTokens: this.secondBucket?.tokens,
        minuteTokens: this.minuteBucket?.tokens,
        hourTokens: this.hourBucket?.tokens,
      });

      return true;
    }

    logger.debug('Rate limit check: denied', {
      secondAllowed,
      minuteAllowed,
      hourAllowed,
    });

    return false;
  }

  /**
   * Wait until rate limit allows (blocking)
   */
  async waitForClearance(): Promise<void> {
    while (!(await this.checkLimit())) {
      // Calculate wait time based on which bucket is limiting
      const waitTime = this.calculateWaitTime();
      await this.sleep(waitTime);
    }
  }

  /**
   * Refill bucket based on elapsed time
   */
  private refillBucket(bucket?: Bucket): void {
    if (!bucket) return;

    const now = Date.now();
    const elapsed = now - bucket.lastRefill;

    if (elapsed >= bucket.refillInterval) {
      // Full refill if interval has passed
      const intervalsElapsed = Math.floor(elapsed / bucket.refillInterval);
      bucket.tokens = bucket.capacity;
      bucket.lastRefill += intervalsElapsed * bucket.refillInterval;

      logger.debug('Bucket refilled', {
        capacity: bucket.capacity,
        tokens: bucket.tokens,
        intervalsElapsed,
      });
    }
  }

  /**
   * Calculate optimal wait time based on bucket states
   */
  private calculateWaitTime(): number {
    const now = Date.now();
    let minWait = 1000; // Default 1 second

    if (this.secondBucket && this.secondBucket.tokens < 1) {
      const timeToRefill = this.secondBucket.refillInterval - (now - this.secondBucket.lastRefill);
      minWait = Math.min(minWait, Math.max(100, timeToRefill));
    }

    if (this.minuteBucket && this.minuteBucket.tokens < 1) {
      const timeToRefill = this.minuteBucket.refillInterval - (now - this.minuteBucket.lastRefill);
      minWait = Math.min(minWait, Math.max(100, timeToRefill));
    }

    if (this.hourBucket && this.hourBucket.tokens < 1) {
      const timeToRefill = this.hourBucket.refillInterval - (now - this.hourBucket.lastRefill);
      minWait = Math.min(minWait, Math.max(100, timeToRefill));
    }

    return minWait;
  }

  /**
   * Get current rate limiter status
   */
  getStatus(): {
    enabled: boolean;
    secondBucket?: { tokens: number; capacity: number };
    minuteBucket?: { tokens: number; capacity: number };
    hourBucket?: { tokens: number; capacity: number };
  } {
    // Refill before reporting
    this.refillBucket(this.secondBucket);
    this.refillBucket(this.minuteBucket);
    this.refillBucket(this.hourBucket);

    return {
      enabled: this.enabled,
      secondBucket: this.secondBucket
        ? { tokens: this.secondBucket.tokens, capacity: this.secondBucket.capacity }
        : undefined,
      minuteBucket: this.minuteBucket
        ? { tokens: this.minuteBucket.tokens, capacity: this.minuteBucket.capacity }
        : undefined,
      hourBucket: this.hourBucket
        ? { tokens: this.hourBucket.tokens, capacity: this.hourBucket.capacity }
        : undefined,
    };
  }

  /**
   * Enable/disable rate limiting
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    logger.info(`RateLimiter ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Reset all buckets to full capacity
   */
  reset(): void {
    const now = Date.now();

    if (this.secondBucket) {
      this.secondBucket.tokens = this.secondBucket.capacity;
      this.secondBucket.lastRefill = now;
    }

    if (this.minuteBucket) {
      this.minuteBucket.tokens = this.minuteBucket.capacity;
      this.minuteBucket.lastRefill = now;
    }

    if (this.hourBucket) {
      this.hourBucket.tokens = this.hourBucket.capacity;
      this.hourBucket.lastRefill = now;
    }

    logger.info('RateLimiter reset');
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
