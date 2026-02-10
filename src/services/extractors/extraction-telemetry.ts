/**
 * Extraction Telemetry - OpenAI Production Standards
 *
 * Comprehensive telemetry, provenance tracking, and observability
 * for marketplace extraction system. Zero silent failures.
 *
 * @module extraction-telemetry
 */

import { randomUUID } from 'crypto';
import { writeFile, appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { logger } from '../../utils/logger';
import type { MarketplaceListing, MarketplaceType } from './marketplace-adapter';
import type { ValidationReport } from './extraction-validator';

/**
 * Telemetry event types
 */
export type TelemetryEventType =
  | 'extraction_started'
  | 'extraction_completed'
  | 'extraction_failed'
  | 'validation_completed'
  | 'rate_limit_hit'
  | 'retry_attempted'
  | 'fallback_selector_used'
  | 'cache_hit'
  | 'cache_miss';

/**
 * Telemetry event
 */
export interface TelemetryEvent {
  eventId: string;
  eventType: TelemetryEventType;
  timestamp: string;
  marketplace: MarketplaceType;
  url: string;

  // Timing
  startTime?: number;
  endTime?: number;
  duration?: number;

  // Extraction details
  extractorVersion?: string;
  adapterVersion?: string;
  selectorsUsed?: string[];
  fallbacksTriggered?: number;

  // Results
  success?: boolean;
  confidence?: number;
  fieldsExtracted?: string[];

  // Errors
  error?: {
    code: string;
    message: string;
    stack?: string;
    recoverable: boolean;
  };

  // Validation
  validation?: {
    valid: boolean;
    issueCount: number;
    captureRate: number;
  };

  // Performance
  performance?: {
    htmlSize: number;
    parseTime: number;
    extractionTime: number;
    validationTime: number;
  };

  // Compliance
  compliance?: {
    rateLimited: boolean;
    retryCount: number;
    proxyUsed: boolean;
    robotsChecked: boolean;
  };

  // Metadata
  metadata?: Record<string, any>;
}

/**
 * Extraction session (tracks a single extraction lifecycle)
 */
export class ExtractionSession {
  readonly sessionId: string;
  readonly marketplace: MarketplaceType;
  readonly url: string;
  readonly startTime: number;

  private events: TelemetryEvent[] = [];
  private selectorsUsed: Set<string> = new Set();
  private fallbackCount: number = 0;
  private endTime?: number;

  constructor(marketplace: MarketplaceType, url: string) {
    this.sessionId = randomUUID();
    this.marketplace = marketplace;
    this.url = url;
    this.startTime = Date.now();

    this.recordEvent({
      eventType: 'extraction_started',
      startTime: this.startTime,
    });
  }

  /**
   * Record a telemetry event
   */
  recordEvent(partial: Partial<TelemetryEvent>): void {
    const event: TelemetryEvent = {
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      marketplace: this.marketplace,
      url: this.url,
      ...partial,
    } as TelemetryEvent;

    this.events.push(event);

    // Emit to telemetry manager
    telemetryManager.recordEvent(event);
  }

  /**
   * Record selector usage
   */
  recordSelector(selector: string, success: boolean): void {
    this.selectorsUsed.add(selector);
    if (!success) {
      this.fallbackCount++;
    }
  }

  /**
   * Complete extraction with success
   */
  completeSuccess(listing: MarketplaceListing, validation: ValidationReport): void {
    this.endTime = Date.now();

    this.recordEvent({
      eventType: 'extraction_completed',
      endTime: this.endTime,
      duration: this.endTime - this.startTime,
      success: true,
      confidence: listing.confidence,
      fieldsExtracted: Object.keys(listing).filter(k => listing[k as keyof MarketplaceListing] !== undefined),
      extractorVersion: listing.extractorVersion,
      adapterVersion: listing.extractorVersion,
      selectorsUsed: Array.from(this.selectorsUsed),
      fallbacksTriggered: this.fallbackCount,
      validation: {
        valid: validation.valid,
        issueCount: validation.issues.length,
        captureRate: validation.captureRate,
      },
    });
  }

  /**
   * Complete extraction with failure
   */
  completeFailure(error: Error, recoverable: boolean): void {
    this.endTime = Date.now();

    this.recordEvent({
      eventType: 'extraction_failed',
      endTime: this.endTime,
      duration: this.endTime - this.startTime,
      success: false,
      error: {
        code: error.name || 'UNKNOWN_ERROR',
        message: error.message,
        stack: error.stack,
        recoverable,
      },
      selectorsUsed: Array.from(this.selectorsUsed),
      fallbacksTriggered: this.fallbackCount,
    });
  }

  /**
   * Get session summary
   */
  getSummary(): {
    sessionId: string;
    marketplace: MarketplaceType;
    url: string;
    duration: number;
    eventCount: number;
    success: boolean;
  } {
    const lastEvent = this.events[this.events.length - 1];
    return {
      sessionId: this.sessionId,
      marketplace: this.marketplace,
      url: this.url,
      duration: (this.endTime || Date.now()) - this.startTime,
      eventCount: this.events.length,
      success: lastEvent?.eventType === 'extraction_completed',
    };
  }
}

/**
 * Telemetry manager (singleton)
 */
export class TelemetryManager {
  private events: TelemetryEvent[] = [];
  private maxBufferSize: number = 1000;
  private persistPath: string = './data/telemetry';
  private persistEnabled: boolean = true;

  // Aggregated metrics
  private metrics: {
    totalExtractions: number;
    successfulExtractions: number;
    failedExtractions: number;
    totalDuration: number;
    rateLimitHits: number;
    cacheHits: number;
    cacheMisses: number;
    fallbacksUsed: number;
  } = {
    totalExtractions: 0,
    successfulExtractions: 0,
    failedExtractions: 0,
    totalDuration: 0,
    rateLimitHits: 0,
    cacheHits: 0,
    cacheMisses: 0,
    fallbacksUsed: 0,
  };

  constructor(config?: { persistPath?: string; persistEnabled?: boolean; maxBufferSize?: number }) {
    if (config?.persistPath) this.persistPath = config.persistPath;
    if (config?.persistEnabled !== undefined) this.persistEnabled = config.persistEnabled;
    if (config?.maxBufferSize) this.maxBufferSize = config.maxBufferSize;

    // Ensure telemetry directory exists
    if (this.persistEnabled) {
      this.initPersistence();
    }
  }

  /**
   * Record a telemetry event
   */
  recordEvent(event: TelemetryEvent): void {
    this.events.push(event);

    // Update metrics
    this.updateMetrics(event);

    // Persist if enabled
    if (this.persistEnabled) {
      this.persistEvent(event);
    }

    // Trim buffer if too large
    if (this.events.length > this.maxBufferSize) {
      this.events = this.events.slice(-this.maxBufferSize);
    }

    // Log critical events
    if (event.eventType === 'extraction_failed' || event.eventType === 'rate_limit_hit') {
      logger.warn('Telemetry event', {
        eventType: event.eventType,
        marketplace: event.marketplace,
        url: event.url,
        error: event.error,
      });
    }
  }

  /**
   * Update aggregated metrics
   */
  private updateMetrics(event: TelemetryEvent): void {
    switch (event.eventType) {
      case 'extraction_completed':
        this.metrics.totalExtractions++;
        this.metrics.successfulExtractions++;
        if (event.duration) this.metrics.totalDuration += event.duration;
        if (event.fallbacksTriggered) this.metrics.fallbacksUsed += event.fallbacksTriggered;
        break;

      case 'extraction_failed':
        this.metrics.totalExtractions++;
        this.metrics.failedExtractions++;
        if (event.duration) this.metrics.totalDuration += event.duration;
        break;

      case 'rate_limit_hit':
        this.metrics.rateLimitHits++;
        break;

      case 'cache_hit':
        this.metrics.cacheHits++;
        break;

      case 'cache_miss':
        this.metrics.cacheMisses++;
        break;
    }
  }

  /**
   * Get aggregated metrics
   */
  getMetrics(): typeof this.metrics & { avgDuration: number; successRate: number; cacheHitRate: number } {
    const avgDuration = this.metrics.totalExtractions > 0
      ? this.metrics.totalDuration / this.metrics.totalExtractions
      : 0;

    const successRate = this.metrics.totalExtractions > 0
      ? this.metrics.successfulExtractions / this.metrics.totalExtractions
      : 0;

    const totalCacheOps = this.metrics.cacheHits + this.metrics.cacheMisses;
    const cacheHitRate = totalCacheOps > 0
      ? this.metrics.cacheHits / totalCacheOps
      : 0;

    return {
      ...this.metrics,
      avgDuration,
      successRate,
      cacheHitRate,
    };
  }

  /**
   * Get recent events
   */
  getRecentEvents(limit: number = 100): TelemetryEvent[] {
    return this.events.slice(-limit);
  }

  /**
   * Query events by criteria
   */
  queryEvents(filter: {
    eventType?: TelemetryEventType;
    marketplace?: MarketplaceType;
    success?: boolean;
    minConfidence?: number;
    since?: Date;
  }): TelemetryEvent[] {
    return this.events.filter(event => {
      if (filter.eventType && event.eventType !== filter.eventType) return false;
      if (filter.marketplace && event.marketplace !== filter.marketplace) return false;
      if (filter.success !== undefined && event.success !== filter.success) return false;
      if (filter.minConfidence && (event.confidence || 0) < filter.minConfidence) return false;
      if (filter.since && new Date(event.timestamp) < filter.since) return false;
      return true;
    });
  }

  /**
   * Generate health report
   */
  getHealthReport(this: TelemetryManager): {
    status: 'healthy' | 'degraded' | 'unhealthy';
    metrics: ReturnType<TelemetryManager['getMetrics']>;
    issues: string[];
    recommendations: string[];
  } {
    const metrics = this.getMetrics();
    const issues: string[] = [];
    const recommendations: string[] = [];

    // Check success rate
    if (metrics.successRate < 0.5) {
      issues.push(`Low success rate: ${(metrics.successRate * 100).toFixed(1)}%`);
      recommendations.push('Review extraction selectors and error logs');
    } else if (metrics.successRate < 0.8) {
      issues.push(`Moderate success rate: ${(metrics.successRate * 100).toFixed(1)}%`);
      recommendations.push('Consider improving fallback selectors');
    }

    // Check rate limiting
    if (metrics.rateLimitHits > metrics.totalExtractions * 0.1) {
      issues.push(`High rate limit hit rate: ${metrics.rateLimitHits} hits`);
      recommendations.push('Reduce request rate or enable proxy rotation');
    }

    // Check fallback usage
    if (metrics.fallbacksUsed > metrics.successfulExtractions * 0.5) {
      issues.push(`High fallback usage: ${metrics.fallbacksUsed} fallbacks`);
      recommendations.push('Primary selectors may be outdated - review marketplace changes');
    }

    // Check cache efficiency
    if (metrics.cacheHitRate < 0.2 && metrics.cacheHits + metrics.cacheMisses > 10) {
      issues.push(`Low cache hit rate: ${(metrics.cacheHitRate * 100).toFixed(1)}%`);
      recommendations.push('Review caching strategy or TTL settings');
    }

    // Determine status
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (issues.length > 3 || metrics.successRate < 0.5) {
      status = 'unhealthy';
    } else if (issues.length > 0) {
      status = 'degraded';
    }

    return {
      status,
      metrics,
      issues,
      recommendations,
    };
  }

  /**
   * Initialize persistence directory
   */
  private async initPersistence(): Promise<void> {
    try {
      if (!existsSync(this.persistPath)) {
        await mkdir(this.persistPath, { recursive: true });
      }
    } catch (error) {
      logger.error('Failed to initialize telemetry persistence', {
        path: this.persistPath,
        error: error instanceof Error ? error.message : String(error),
      });
      this.persistEnabled = false;
    }
  }

  /**
   * Persist event to disk
   */
  private async persistEvent(event: TelemetryEvent): Promise<void> {
    try {
      const date = new Date().toISOString().split('T')[0];
      const filename = `${this.persistPath}/telemetry-${date}.jsonl`;
      await appendFile(filename, JSON.stringify(event) + '\n', 'utf-8');
    } catch (error) {
      // Silent failure to avoid blocking extraction
      logger.debug('Failed to persist telemetry event', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Export telemetry report
   */
  async exportReport(outputPath: string): Promise<void> {
    const report = {
      generatedAt: new Date().toISOString(),
      metrics: this.getMetrics(),
      healthReport: this.getHealthReport(),
      recentEvents: this.getRecentEvents(50),
      eventCounts: this.getEventCounts(),
    };

    await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf-8');
    logger.info('Telemetry report exported', { outputPath });
  }

  /**
   * Get event counts by type
   */
  private getEventCounts(): Record<TelemetryEventType, number> {
    const counts = {} as Record<TelemetryEventType, number>;
    for (const event of this.events) {
      counts[event.eventType] = (counts[event.eventType] || 0) + 1;
    }
    return counts;
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.events = [];
    this.metrics = {
      totalExtractions: 0,
      successfulExtractions: 0,
      failedExtractions: 0,
      totalDuration: 0,
      rateLimitHits: 0,
      cacheHits: 0,
      cacheMisses: 0,
      fallbacksUsed: 0,
    };
    logger.info('Telemetry reset');
  }
}

/**
 * Global telemetry manager instance
 */
export const telemetryManager = new TelemetryManager({
  persistEnabled: true,
  persistPath: './data/telemetry',
  maxBufferSize: 1000,
});
