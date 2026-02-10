/**
 * Domain-Level Rate Limiter
 *
 * Token bucket algorithm with per-domain limits.
 * Respects crawl-delay from robots.txt.
 *
 * @module rate-limiter
 */

import { logger } from '../utils/logger';
import { config } from '../config/env';

interface TokenBucket {
  tokens: number;
  capacity: number;
  refillRate: number; // tokens per second
  lastRefill: number;
  queue: Array<{
    resolve: () => void;
    timestamp: number;
  }>;
}

export class DomainRateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private readonly defaultRateLimit: number; // requests per second
  private readonly enabled: boolean;

  constructor(rateLimit = 1, enabled = true) {
    this.defaultRateLimit = rateLimit;
    this.enabled = enabled;
    logger.info(`RateLimiter: Initialized (${rateLimit} req/sec per domain, enabled: ${enabled})`);
  }

  /**
   * Extract domain from URL
   */
  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.host;
    } catch (error) {
      logger.error('RateLimiter: Invalid URL', {
        url,
        error: error instanceof Error ? error.message : String(error)
      });
      throw new Error(`Invalid URL: ${url}`);
    }
  }

  /**
   * Get or create token bucket for domain
   */
  private getBucket(domain: string): TokenBucket {
    let bucket = this.buckets.get(domain);

    if (!bucket) {
      bucket = {
        tokens: 1, // Start with 1 token
        capacity: 1,
        refillRate: this.defaultRateLimit,
        lastRefill: Date.now(),
        queue: []
      };
      this.buckets.set(domain, bucket);
      logger.debug('RateLimiter: Created bucket', { domain, refillRate: this.defaultRateLimit });
    }

    return bucket;
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillTokens(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsedSeconds = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = elapsedSeconds * bucket.refillRate;

    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }
  }

  /**
   * Process queued requests for a domain
   */
  private processQueue(bucket: TokenBucket): void {
    while (bucket.queue.length > 0 && bucket.tokens >= 1) {
      const request = bucket.queue.shift();
      if (request) {
        bucket.tokens -= 1;
        const waitTime = Date.now() - request.timestamp;
        logger.debug('RateLimiter: Released queued request', { waitTime });
        request.resolve();
      }
    }
  }

  /**
   * Set custom rate limit for domain (e.g., from robots.txt crawl-delay)
   */
  setDomainLimit(domain: string, crawlDelaySeconds: number): void {
    const bucket = this.getBucket(domain);

    if (crawlDelaySeconds > 0) {
      // Crawl-delay = minimum seconds between requests
      bucket.refillRate = 1 / crawlDelaySeconds;
      logger.info('RateLimiter: Set custom limit from crawl-delay', {
        domain,
        crawlDelaySeconds,
        refillRate: bucket.refillRate
      });
    }
  }

  /**
   * Wait for rate limit clearance
   */
  async checkLimit(url: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const domain = this.extractDomain(url);
    const bucket = this.getBucket(domain);

    // Refill tokens
    this.refillTokens(bucket);

    // If tokens available, consume and proceed
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      logger.debug('RateLimiter: Request allowed immediately', { domain, tokensRemaining: bucket.tokens });
      return;
    }

    // Otherwise, queue the request
    logger.debug('RateLimiter: Request queued (rate limited)', {
      domain,
      queueSize: bucket.queue.length
    });

    return new Promise<void>((resolve) => {
      bucket.queue.push({
        resolve,
        timestamp: Date.now()
      });

      // Set up periodic queue processing
      const interval = setInterval(() => {
        this.refillTokens(bucket);
        this.processQueue(bucket);

        // Clean up interval when queue is empty
        if (bucket.queue.length === 0) {
          clearInterval(interval);
        }
      }, 100); // Check every 100ms
    });
  }

  /**
   * Get stats for domain
   */
  getDomainStats(url: string): {
    domain: string;
    tokens: number;
    refillRate: number;
    queueSize: number;
  } | null {
    try {
      const domain = this.extractDomain(url);
      const bucket = this.buckets.get(domain);

      if (!bucket) {
        return null;
      }

      this.refillTokens(bucket);

      return {
        domain,
        tokens: bucket.tokens,
        refillRate: bucket.refillRate,
        queueSize: bucket.queue.length
      };
    } catch (error) {
      logger.debug('RateLimiter: Failed to compute domain stats', {
        url,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Get all stats
   */
  getAllStats(): {
    totalDomains: number;
    domains: Array<{
      domain: string;
      tokens: number;
      refillRate: number;
      queueSize: number;
    }>;
  } {
    const domains = Array.from(this.buckets.entries()).map(([domain, bucket]) => {
      this.refillTokens(bucket);
      return {
        domain,
        tokens: bucket.tokens,
        refillRate: bucket.refillRate,
        queueSize: bucket.queue.length
      };
    });

    return {
      totalDomains: this.buckets.size,
      domains
    };
  }

  /**
   * Clear bucket for domain
   */
  clearDomain(domain: string): void {
    this.buckets.delete(domain);
    logger.info('RateLimiter: Cleared domain', { domain });
  }

  /**
   * Clear all buckets
   */
  clearAll(): void {
    this.buckets.clear();
    logger.info('RateLimiter: Cleared all domains');
  }
}

// Global singleton with config
export const rateLimiter = new DomainRateLimiter(
  config.fetch.respectRobots ? 1 : 0, // 1 req/sec default, or unlimited if robots disabled
  config.fetch.respectRobots
);
