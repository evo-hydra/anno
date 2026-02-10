/**
 * Extraction Event Pipeline
 *
 * Streams structured extraction events to analytics/AI consumers.
 * Supports filtering, persistence, and multiple subscribers.
 *
 * @module extraction-event-pipeline
 */

import { randomUUID } from 'crypto';
import { writeFile, appendFile } from 'fs/promises';
import { logger } from '../../utils/logger';
import {
  ExtractionEvent,
  ExtractionEventPipeline,
  EventFilter,
  Unsubscribe,
  MarketplaceListing,
  MarketplaceType,
} from './marketplace-adapter';

/**
 * Event handler function type
 */
type EventHandler = (event: ExtractionEvent) => void | Promise<void>;

/**
 * Subscriber with optional filter
 */
interface Subscriber {
  id: string;
  handler: EventHandler;
  filter?: EventFilter;
}

/**
 * Pipeline configuration
 */
export interface PipelineConfig {
  persistToDisk?: boolean;
  persistPath?: string;
  maxQueueSize?: number;
  emitEnabled?: boolean;
}

/**
 * Default event pipeline implementation
 */
export class DefaultExtractionEventPipeline implements ExtractionEventPipeline {
  private subscribers: Map<string, Subscriber>;
  private eventQueue: ExtractionEvent[];
  private config: Required<PipelineConfig>;
  private totalEventsEmitted: number;

  constructor(config: PipelineConfig = {}) {
    this.subscribers = new Map();
    this.eventQueue = [];
    this.totalEventsEmitted = 0;

    this.config = {
      persistToDisk: config.persistToDisk ?? false,
      persistPath: config.persistPath ?? './data/extraction-events.jsonl',
      maxQueueSize: config.maxQueueSize ?? 1000,
      emitEnabled: config.emitEnabled ?? true,
    };

    logger.info('ExtractionEventPipeline initialized', {
      persistToDisk: this.config.persistToDisk,
      persistPath: this.config.persistPath,
      emitEnabled: this.config.emitEnabled,
    });
  }

  /**
   * Emit an extraction event to all subscribers
   */
  async emit(event: ExtractionEvent): Promise<void> {
    if (!this.config.emitEnabled) {
      return;
    }

    logger.debug('Emitting extraction event', {
      eventId: event.eventId,
      eventType: event.eventType,
      marketplace: event.marketplace,
      url: event.url,
    });

    this.totalEventsEmitted++;

    // Add to queue (with size limit)
    this.eventQueue.push(event);
    if (this.eventQueue.length > this.config.maxQueueSize) {
      this.eventQueue.shift(); // Remove oldest event
    }

    // Persist to disk if enabled
    if (this.config.persistToDisk) {
      await this.persistEvent(event);
    }

    // Notify subscribers
    const promises: Promise<void>[] = [];
    for (const subscriber of this.subscribers.values()) {
      if (this.matchesFilter(event, subscriber.filter)) {
        promises.push(this.invokeHandler(subscriber, event));
      }
    }

    // Wait for all handlers (with error isolation)
    await Promise.allSettled(promises);
  }

  /**
   * Subscribe to extraction events
   */
  subscribe(handler: EventHandler, filter?: EventFilter): Unsubscribe {
    const subscriberId = randomUUID();

    this.subscribers.set(subscriberId, {
      id: subscriberId,
      handler,
      filter,
    });

    logger.info('New subscriber registered', {
      subscriberId,
      hasFilter: !!filter,
      totalSubscribers: this.subscribers.size,
    });

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(subscriberId);
      logger.info('Subscriber unregistered', {
        subscriberId,
        remainingSubscribers: this.subscribers.size,
      });
    };
  }

  /**
   * Get recent events from queue
   */
  getRecentEvents(limit = 100): ExtractionEvent[] {
    return this.eventQueue.slice(-limit);
  }

  /**
   * Get pipeline statistics
   */
  getStats(): {
    totalEventsEmitted: number;
    queueSize: number;
    subscriberCount: number;
  } {
    return {
      totalEventsEmitted: this.totalEventsEmitted,
      queueSize: this.eventQueue.length,
      subscriberCount: this.subscribers.size,
    };
  }

  /**
   * Clear event queue
   */
  clearQueue(): void {
    this.eventQueue = [];
    logger.info('Event queue cleared');
  }

  /**
   * Enable/disable event emission
   */
  setEnabled(enabled: boolean): void {
    this.config.emitEnabled = enabled;
    logger.info(`Event pipeline ${enabled ? 'enabled' : 'disabled'}`);
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Check if event matches filter criteria
   */
  private matchesFilter(event: ExtractionEvent, filter?: EventFilter): boolean {
    if (!filter) return true;

    // Filter by marketplace
    if (filter.marketplaces && !filter.marketplaces.includes(event.marketplace)) {
      return false;
    }

    // Filter by event type
    if (filter.eventTypes && !filter.eventTypes.includes(event.eventType)) {
      return false;
    }

    // Filter by confidence
    if (filter.minConfidence !== undefined && event.confidence !== undefined) {
      if (event.confidence < filter.minConfidence) {
        return false;
      }
    }

    return true;
  }

  /**
   * Invoke event handler with error isolation
   */
  private async invokeHandler(subscriber: Subscriber, event: ExtractionEvent): Promise<void> {
    try {
      await subscriber.handler(event);
    } catch (error) {
      logger.error('Event handler error', {
        subscriberId: subscriber.id,
        eventId: event.eventId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Persist event to disk (JSONL format)
   */
  private async persistEvent(event: ExtractionEvent): Promise<void> {
    try {
      const line = JSON.stringify(event) + '\n';
      await appendFile(this.config.persistPath, line, 'utf-8');
    } catch (error) {
      logger.error('Failed to persist event to disk', {
        eventId: event.eventId,
        path: this.config.persistPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Helper function to create extraction events
 */
export function createExtractionEvent(params: {
  eventType: ExtractionEvent['eventType'];
  marketplace: MarketplaceType;
  url: string;
  listing?: MarketplaceListing;
  duration: number;
  validationErrors?: string[];
  validationWarnings?: string[];
  extractorVersion: string;
  adapterVersion: string;
  rateLimited?: boolean;
  retryCount?: number;
  renderingUsed?: boolean;
}): ExtractionEvent {
  return {
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    eventType: params.eventType,
    marketplace: params.marketplace,
    url: params.url,
    listing: params.listing,
    duration: params.duration,
    confidence: params.listing?.confidence,
    validationErrors: params.validationErrors,
    validationWarnings: params.validationWarnings,
    extractorVersion: params.extractorVersion,
    adapterVersion: params.adapterVersion,
    rateLimited: params.rateLimited ?? false,
    retryCount: params.retryCount ?? 0,
    renderingUsed: params.renderingUsed ?? false,
  };
}

/**
 * Example analytics consumer
 */
export class ExtractionAnalytics {
  private successCount: Map<MarketplaceType, number> = new Map();
  private failureCount: Map<MarketplaceType, number> = new Map();
  private totalDuration: Map<MarketplaceType, number> = new Map();
  private totalConfidence: Map<MarketplaceType, number> = new Map();

  /**
   * Subscribe to event pipeline and track analytics
   */
  subscribe(pipeline: ExtractionEventPipeline): Unsubscribe {
    return pipeline.subscribe((event) => {
      this.processEvent(event);
    });
  }

  /**
   * Process incoming event
   */
  private processEvent(event: ExtractionEvent): void {
    const marketplace = event.marketplace;

    // Track success/failure
    if (event.eventType === 'extraction_success') {
      this.successCount.set(marketplace, (this.successCount.get(marketplace) || 0) + 1);

      // Track duration and confidence
      this.totalDuration.set(
        marketplace,
        (this.totalDuration.get(marketplace) || 0) + event.duration
      );

      if (event.confidence !== undefined) {
        this.totalConfidence.set(
          marketplace,
          (this.totalConfidence.get(marketplace) || 0) + event.confidence
        );
      }
    } else if (event.eventType === 'extraction_failure') {
      this.failureCount.set(marketplace, (this.failureCount.get(marketplace) || 0) + 1);
    }
  }

  /**
   * Get analytics summary
   */
  getSummary(marketplace?: MarketplaceType): {
    marketplace: MarketplaceType | 'all';
    successCount: number;
    failureCount: number;
    successRate: number;
    averageDuration: number;
    averageConfidence: number;
  }[] {
    const marketplaces = marketplace
      ? [marketplace]
      : Array.from(
          new Set([...this.successCount.keys(), ...this.failureCount.keys()])
        );

    return marketplaces.map((mp) => {
      const success = this.successCount.get(mp) || 0;
      const failure = this.failureCount.get(mp) || 0;
      const total = success + failure;

      return {
        marketplace: mp,
        successCount: success,
        failureCount: failure,
        successRate: total > 0 ? success / total : 0,
        averageDuration: success > 0 ? (this.totalDuration.get(mp) || 0) / success : 0,
        averageConfidence: success > 0 ? (this.totalConfidence.get(mp) || 0) / success : 0,
      };
    });
  }

  /**
   * Reset all analytics
   */
  reset(): void {
    this.successCount.clear();
    this.failureCount.clear();
    this.totalDuration.clear();
    this.totalConfidence.clear();
  }
}

// Global singleton pipeline
export const extractionEventPipeline = new DefaultExtractionEventPipeline({
  persistToDisk: false, // Enable via config/feature flag
  emitEnabled: true,
});
