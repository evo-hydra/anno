/**
 * Marketplace Registry
 *
 * Central registry for managing marketplace adapters with compliance enforcement,
 * rate limiting, metrics collection, and feature flag support.
 *
 * @module marketplace-registry
 */

import { logger } from '../../utils/logger';
import { RateLimiter } from '../../core/marketplace-rate-limiter';
import { fetchPage, type FetchMode, type FetchResult } from '../fetcher';
import {
  MarketplaceType,
  MarketplaceAdapter,
  MarketplaceConfig,
  ExtractionResult,
  ExtractionOptions,
  MarketplaceMetrics,
  MarketplaceListing,
} from './marketplace-adapter';

/**
 * Central registry for marketplace adapters with compliance enforcement
 */
export class MarketplaceRegistry {
  private adapters: Map<MarketplaceType, MarketplaceAdapter>;
  private configs: Map<MarketplaceType, MarketplaceConfig>;
  private rateLimiters: Map<MarketplaceType, RateLimiter>;
  private metrics: Map<MarketplaceType, MetricsCollector>;

  constructor() {
    this.adapters = new Map();
    this.configs = new Map();
    this.rateLimiters = new Map();
    this.metrics = new Map();
  }

  /**
   * Register a new marketplace adapter
   */
  register(adapter: MarketplaceAdapter, config: MarketplaceConfig): void {
    const id = adapter.marketplaceId;

    if (this.adapters.has(id)) {
      logger.warn(`Marketplace adapter ${id} already registered, overwriting`, {
        marketplace: id,
      });
    }

    // Validate config matches adapter
    if (config.marketplaceId !== id) {
      throw new Error(
        `Config marketplace ID (${config.marketplaceId}) does not match adapter ID (${id})`
      );
    }

    this.adapters.set(id, adapter);
    this.configs.set(id, config);

    // Initialize rate limiter based on config
    const rateLimiter = new RateLimiter({
      requestsPerSecond: config.rateLimit.requestsPerSecond,
      requestsPerMinute: config.rateLimit.requestsPerMinute,
      requestsPerHour: config.rateLimit.requestsPerHour,
      burstSize: config.rateLimit.burstSize,
    });
    this.rateLimiters.set(id, rateLimiter);

    // Initialize metrics collector
    this.metrics.set(id, new MetricsCollector(id));

    logger.info(`Registered marketplace adapter: ${adapter.name} v${adapter.version}`, {
      marketplace: id,
      enabled: config.enabled,
    });
  }

  /**
   * Unregister a marketplace adapter
   */
  unregister(marketplaceId: MarketplaceType): boolean {
    const hadAdapter = this.adapters.has(marketplaceId);

    this.adapters.delete(marketplaceId);
    this.configs.delete(marketplaceId);
    this.rateLimiters.delete(marketplaceId);
    this.metrics.delete(marketplaceId);

    if (hadAdapter) {
      logger.info(`Unregistered marketplace adapter: ${marketplaceId}`);
    }

    return hadAdapter;
  }

  /**
   * Get adapter for a specific URL
   */
  getAdapterForUrl(url: string): MarketplaceAdapter | null {
    for (const adapter of this.adapters.values()) {
      if (adapter.canHandle(url)) {
        const config = this.configs.get(adapter.marketplaceId);
        if (config?.enabled) {
          return adapter;
        } else {
          logger.debug(`Adapter found but disabled for URL: ${url}`, {
            marketplace: adapter.marketplaceId,
          });
          return null;
        }
      }
    }
    return null;
  }

  /**
   * Get adapter by marketplace ID
   */
  getAdapter(marketplaceId: MarketplaceType): MarketplaceAdapter | null {
    return this.adapters.get(marketplaceId) || null;
  }

  /**
   * Extract listing with compliance enforcement
   */
  async extractListing(url: string, options?: ExtractionOptions): Promise<ExtractionResult> {
    const startTime = Date.now();
    let retryCount = 0;
    let rateLimited = false;
    let cached = false;

    // Find appropriate adapter
    const adapter = this.getAdapterForUrl(url);
    if (!adapter) {
      return {
        success: false,
        error: {
          code: 'NO_ADAPTER',
          message: `No enabled adapter found for URL: ${url}`,
          recoverable: false,
        },
        metadata: {
          duration: Date.now() - startTime,
          retryCount: 0,
          rateLimited: false,
          cached: false,
        },
      };
    }

    const marketplaceId = adapter.marketplaceId;
    const config = this.configs.get(marketplaceId)!;
    const rateLimiter = this.rateLimiters.get(marketplaceId)!;
    const metricsCollector = this.metrics.get(marketplaceId)!;

    // Respect rate limiting
    const maxRetries = config.rateLimit.retryAttempts;

    while (retryCount <= maxRetries) {
      // Check rate limit
      const allowed = await rateLimiter.checkLimit();
      if (!allowed) {
        rateLimited = true;
        metricsCollector.recordRateLimitHit();

        if (retryCount >= maxRetries) {
          logger.warn('Rate limit exceeded, max retries reached', {
            marketplace: marketplaceId,
            url,
            retries: retryCount,
          });

          return {
            success: false,
            error: {
              code: 'RATE_LIMIT_EXCEEDED',
              message: 'Rate limit exceeded and max retries reached',
              recoverable: true,
            },
            metadata: {
              duration: Date.now() - startTime,
              retryCount,
              rateLimited: true,
              cached: false,
            },
          };
        }

        // Wait before retry
        const backoffMs = this.calculateBackoff(
          retryCount,
          config.rateLimit.backoffStrategy
        );
        logger.debug(`Rate limited, waiting ${backoffMs}ms before retry`, {
          marketplace: marketplaceId,
          retry: retryCount + 1,
        });
        await this.sleep(backoffMs);
        retryCount++;
        continue;
      }

      // Attempt extraction
      try {
        // Fetch content using the fetcher service
        const fetchResult = await this.fetchContent(url, config);

        if (!fetchResult) {
          metricsCollector.recordFailure(Date.now() - startTime);
          return {
            success: false,
            error: {
              code: 'FETCH_FAILED',
              message: 'Failed to fetch content for extraction',
              recoverable: true,
            },
            metadata: {
              duration: Date.now() - startTime,
              retryCount,
              rateLimited,
              cached: false,
            },
          };
        }

        // Track cache hits
        cached = fetchResult.fromCache;
        if (cached) {
          metricsCollector.recordCacheHit();
        }

        // Extract listing using the adapter
        const listing = await adapter.extract(fetchResult.body, fetchResult.finalUrl, options);

        if (!listing) {
          metricsCollector.recordFailure(Date.now() - startTime);
          return {
            success: false,
            error: {
              code: 'EXTRACTION_FAILED',
              message: 'Adapter returned null - page structure may have changed',
              recoverable: false,
            },
            metadata: {
              duration: Date.now() - startTime,
              retryCount,
              rateLimited,
              cached: fetchResult.fromCache,
            },
          };
        }

        // Validate listing (TypeScript should know listing is not null here)
        const validListing = listing as MarketplaceListing;
        const validation = adapter.validate(validListing);
        if (!validation.valid) {
          logger.warn('Listing validation failed', {
            marketplace: marketplaceId,
            url,
            errors: validation.errors,
          });

          if (validListing.confidence < config.quality.minConfidenceScore) {
            metricsCollector.recordFailure(Date.now() - startTime);
            return {
              success: false,
              error: {
                code: 'LOW_CONFIDENCE',
                message: `Confidence ${validListing.confidence} below threshold ${config.quality.minConfidenceScore}`,
                recoverable: false,
              },
              metadata: {
                duration: Date.now() - startTime,
                retryCount,
                rateLimited,
                cached,
              },
            };
          }
        }

        // Success
        const duration = Date.now() - startTime;
        metricsCollector.recordSuccess(duration, validListing.confidence);

        return {
          success: true,
          listing,
          metadata: {
            duration,
            retryCount,
            rateLimited,
            cached,
          },
        };
      } catch (error) {
        logger.error('Extraction error', {
          marketplace: marketplaceId,
          url,
          error: error instanceof Error ? error.message : String(error),
          retry: retryCount,
        });

        if (retryCount >= maxRetries) {
          metricsCollector.recordFailure(Date.now() - startTime);
          return {
            success: false,
            error: {
              code: 'EXTRACTION_ERROR',
              message: error instanceof Error ? error.message : String(error),
              recoverable: true,
            },
            metadata: {
              duration: Date.now() - startTime,
              retryCount,
              rateLimited,
              cached,
            },
          };
        }

        retryCount++;
        const backoffMs = this.calculateBackoff(retryCount, config.rateLimit.backoffStrategy);
        await this.sleep(backoffMs);
      }
    }

    // Should not reach here
    metricsCollector.recordFailure(Date.now() - startTime);
    return {
      success: false,
      error: {
        code: 'UNKNOWN_ERROR',
        message: 'Unexpected error in extraction loop',
        recoverable: false,
      },
      metadata: {
        duration: Date.now() - startTime,
        retryCount,
        rateLimited,
        cached,
      },
    };
  }

  /**
   * Check if marketplace is enabled (feature flag)
   */
  isEnabled(marketplaceId: MarketplaceType): boolean {
    const config = this.configs.get(marketplaceId);
    return config?.enabled ?? false;
  }

  /**
   * Update marketplace configuration at runtime
   */
  updateConfig(marketplaceId: MarketplaceType, configUpdate: Partial<MarketplaceConfig>): void {
    const currentConfig = this.configs.get(marketplaceId);
    if (!currentConfig) {
      throw new Error(`No config found for marketplace: ${marketplaceId}`);
    }

    const newConfig: MarketplaceConfig = {
      ...currentConfig,
      ...configUpdate,
      // Deep merge nested objects
      rendering: { ...currentConfig.rendering, ...(configUpdate.rendering || {}) },
      rateLimit: { ...currentConfig.rateLimit, ...(configUpdate.rateLimit || {}) },
      session: { ...currentConfig.session, ...(configUpdate.session || {}) },
      compliance: { ...currentConfig.compliance, ...(configUpdate.compliance || {}) },
      quality: { ...currentConfig.quality, ...(configUpdate.quality || {}) },
      features: { ...currentConfig.features, ...(configUpdate.features || {}) },
    };

    this.configs.set(marketplaceId, newConfig);

    // Update rate limiter if rate limit config changed
    if (configUpdate.rateLimit) {
      const rateLimiter = new RateLimiter({
        requestsPerSecond: newConfig.rateLimit.requestsPerSecond,
        requestsPerMinute: newConfig.rateLimit.requestsPerMinute,
        requestsPerHour: newConfig.rateLimit.requestsPerHour,
        burstSize: newConfig.rateLimit.burstSize,
      });
      this.rateLimiters.set(marketplaceId, rateLimiter);
    }

    logger.info(`Updated config for marketplace: ${marketplaceId}`, {
      marketplace: marketplaceId,
      updates: Object.keys(configUpdate),
    });
  }

  /**
   * Get configuration for a marketplace
   */
  getConfig(marketplaceId: MarketplaceType): MarketplaceConfig | null {
    return this.configs.get(marketplaceId) || null;
  }

  /**
   * Get metrics for a specific marketplace
   */
  getMetrics(marketplaceId: MarketplaceType): MarketplaceMetrics | null {
    const collector = this.metrics.get(marketplaceId);
    return collector ? collector.getMetrics() : null;
  }

  /**
   * Get all registered marketplace IDs
   */
  getRegisteredMarketplaces(): MarketplaceType[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Fetch content from URL using the fetcher service
   */
  private async fetchContent(url: string, config: MarketplaceConfig): Promise<FetchResult | null> {
    try {
      // Determine fetch mode based on marketplace config
      const mode: FetchMode = config.rendering.requiresJavaScript ? 'rendered' : 'http';

      logger.debug('Fetching content for extraction', {
        url,
        mode,
        requiresJs: config.rendering.requiresJavaScript,
      });

      const result = await fetchPage({
        url,
        useCache: true,
        mode,
      });

      // Check for successful response
      if (result.status >= 400) {
        logger.warn('Fetch returned error status', {
          url,
          status: result.status,
        });
        return null;
      }

      return result;
    } catch (error) {
      logger.error('Failed to fetch content', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Calculate backoff delay based on strategy
   */
  private calculateBackoff(
    retryCount: number,
    strategy: 'exponential' | 'linear' | 'constant'
  ): number {
    const baseDelay = 1000; // 1 second

    switch (strategy) {
      case 'exponential':
        return baseDelay * Math.pow(2, retryCount);
      case 'linear':
        return baseDelay * (retryCount + 1);
      case 'constant':
        return baseDelay;
      default:
        return baseDelay;
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Metrics collector for a single marketplace
 */
class MetricsCollector {
  private marketplaceId: MarketplaceType;
  private totalExtractions: number = 0;
  private successfulExtractions: number = 0;
  private failedExtractions: number = 0;
  private totalConfidence: number = 0;
  private totalDuration: number = 0;
  private rateLimitHits: number = 0;
  private cacheHits: number = 0;

  constructor(marketplaceId: MarketplaceType) {
    this.marketplaceId = marketplaceId;
  }

  recordSuccess(duration: number, confidence: number): void {
    this.totalExtractions++;
    this.successfulExtractions++;
    this.totalDuration += duration;
    this.totalConfidence += confidence;
  }

  recordFailure(duration: number): void {
    this.totalExtractions++;
    this.failedExtractions++;
    this.totalDuration += duration;
  }

  recordRateLimitHit(): void {
    this.rateLimitHits++;
  }

  recordCacheHit(): void {
    this.cacheHits++;
  }

  getMetrics(): MarketplaceMetrics {
    const avgConfidence =
      this.successfulExtractions > 0 ? this.totalConfidence / this.successfulExtractions : 0;

    const avgDuration = this.totalExtractions > 0 ? this.totalDuration / this.totalExtractions : 0;

    const cacheHitRate = this.totalExtractions > 0 ? this.cacheHits / this.totalExtractions : 0;

    return {
      totalExtractions: this.totalExtractions,
      successfulExtractions: this.successfulExtractions,
      failedExtractions: this.failedExtractions,
      averageConfidence: avgConfidence,
      averageDuration: avgDuration,
      rateLimitHits: this.rateLimitHits,
      cacheHitRate: cacheHitRate,
    };
  }

  reset(): void {
    this.totalExtractions = 0;
    this.successfulExtractions = 0;
    this.failedExtractions = 0;
    this.totalConfidence = 0;
    this.totalDuration = 0;
    this.rateLimitHits = 0;
    this.cacheHits = 0;
  }
}

// Global singleton registry
export const marketplaceRegistry = new MarketplaceRegistry();
