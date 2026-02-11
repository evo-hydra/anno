/**
 * Marketplace Adapter System Tests
 *
 * Comprehensive test suite for marketplace adapters, registry, and event pipeline.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EbayAdapterV2 } from '../services/extractors/ebay-adapter-v2';
import { EbayAdapter } from '../services/extractors/ebay-adapter';
import { AmazonAdapter } from '../services/extractors/amazon-adapter';
import { WalmartAdapter } from '../services/extractors/walmart-adapter';
import { MarketplaceRegistry } from '../services/extractors/marketplace-registry';
import {
  DefaultExtractionEventPipeline,
  createExtractionEvent,
  ExtractionAnalytics,
} from '../services/extractors/extraction-event-pipeline';
import { createBackfillJob } from '../services/extractors/backfill-executor';
import {
  CHANNEL_TIER_MAP,
  CHANNEL_CONFIDENCE_DEFAULTS,
} from '../services/extractors/marketplace-adapter';
import type {
  ExtractionEvent,
} from '../services/extractors/marketplace-adapter';

// ============================================================================
// Adapter Tests
// ============================================================================

describe('EbayAdapterV2', () => {
  const adapter = new EbayAdapterV2();

  it('should have correct metadata', () => {
    expect(adapter.marketplaceId).toBe('ebay');
    expect(adapter.name).toBe('eBay Marketplace Adapter');
    expect(adapter.version).toBe('2.1.0');
  });

  it('should identify eBay URLs', () => {
    expect(adapter.canHandle('https://www.ebay.com/itm/123456789')).toBe(true);
    expect(adapter.canHandle('https://www.ebay.co.uk/itm/123456789')).toBe(true);
    expect(adapter.canHandle('https://www.amazon.com/dp/B08X6PYCQV')).toBe(false);
  });

  it('should return valid config', () => {
    const config = adapter.getConfig();
    expect(config.marketplaceId).toBe('ebay');
    expect(config.enabled).toBe(true);
    expect(config.rateLimit.requestsPerSecond).toBeGreaterThan(0);
    expect(config.quality.minConfidenceScore).toBeGreaterThan(0);
    expect(config.quality.minConfidenceScore).toBeLessThanOrEqual(1);
  });

  it('should validate listings correctly', () => {
    const validListing = {
      id: '123',
      marketplace: 'ebay' as const,
      url: 'https://ebay.com/itm/123',
      title: 'Test Product',
      price: { amount: 19.99, currency: 'USD' },
      availability: 'sold' as const,
      seller: { name: 'Test Seller' },
      images: [],
      extractedAt: new Date().toISOString(),
      extractionMethod: 'test',
      confidence: 0.9,
      extractorVersion: '1.0.0',
    };

    const result = adapter.validate(validListing);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject listings with low confidence', () => {
    const lowConfidenceListing = {
      id: '123',
      marketplace: 'ebay' as const,
      url: 'https://ebay.com/itm/123',
      title: 'Test Product',
      price: { amount: 19.99, currency: 'USD' },
      availability: 'sold' as const,
      seller: { name: 'Test Seller' },
      images: [],
      extractedAt: new Date().toISOString(),
      extractionMethod: 'test',
      confidence: 0.3, // Too low
      extractorVersion: '1.0.0',
    };

    const result = adapter.validate(lowConfidenceListing);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('AmazonAdapter', () => {
  const adapter = new AmazonAdapter();

  it('should have correct metadata', () => {
    expect(adapter.marketplaceId).toBe('amazon');
    expect(adapter.name).toBe('Amazon Scraping Adapter');
  });

  it('should identify Amazon URLs', () => {
    expect(adapter.canHandle('https://www.amazon.com/dp/B08X6PYCQV')).toBe(true);
    expect(adapter.canHandle('https://www.amazon.co.uk/dp/B08X6PYCQV')).toBe(true);
    expect(adapter.canHandle('https://www.ebay.com/itm/123456789')).toBe(false);
  });

  it('should require JavaScript rendering', () => {
    const config = adapter.getConfig();
    expect(config.rendering.requiresJavaScript).toBe(true);
  });

  it('should be disabled by default (dark launch)', () => {
    const config = adapter.getConfig();
    expect(config.enabled).toBe(false);
  });
});

// ============================================================================
// DataSourceAdapter Tests (Multi-Channel Architecture)
// ============================================================================

describe('DataSourceAdapter - EbayAdapter', () => {
  const adapter = new EbayAdapter();

  it('should implement DataSourceAdapter interface', () => {
    // Check required readonly properties
    expect(adapter.channel).toBe('scraping');
    expect(adapter.tier).toBe(3);
    expect(adapter.confidenceRange).toBeDefined();
    expect(adapter.confidenceRange.min).toBeGreaterThanOrEqual(0);
    expect(adapter.confidenceRange.max).toBeLessThanOrEqual(1);
    expect(adapter.requiresUserAction).toBe(false);
  });

  it('should have correct channel classification', () => {
    expect(adapter.channel).toBe('scraping');
    expect(adapter.tier).toBe(3); // Tier 3 = scraping
  });

  it('should report availability', async () => {
    const available = await adapter.isAvailable();
    expect(typeof available).toBe('boolean');
    expect(available).toBe(true); // Scraping adapter is always "available"
  });

  it('should return health status', async () => {
    const health = await adapter.getHealth();

    expect(health).toBeDefined();
    expect(typeof health.available).toBe('boolean');
    expect(typeof health.recentFailureRate).toBe('number');
    expect(health.recentFailureRate).toBeGreaterThanOrEqual(0);
    expect(health.recentFailureRate).toBeLessThanOrEqual(1);
    expect(typeof health.estimatedReliability).toBe('number');
  });

  it('should have consistent metadata between interfaces', () => {
    // Ensure MarketplaceAdapter properties are present
    expect(adapter.marketplaceId).toBe('ebay');
    expect(adapter.name).toBeDefined();
    expect(adapter.version).toBeDefined();

    // Ensure canHandle works
    expect(adapter.canHandle('https://www.ebay.com/itm/123')).toBe(true);
    expect(adapter.canHandle('https://www.amazon.com/dp/B123')).toBe(false);
  });
});

describe('DataSourceAdapter - AmazonAdapter', () => {
  const adapter = new AmazonAdapter();

  it('should implement DataSourceAdapter interface', () => {
    expect(adapter.channel).toBe('scraping');
    expect(adapter.tier).toBe(3);
    expect(adapter.confidenceRange).toBeDefined();
    expect(adapter.requiresUserAction).toBe(false);
  });

  it('should report availability based on failure rate', async () => {
    const available = await adapter.isAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('should return health status with ToS warning', async () => {
    const health = await adapter.getHealth();

    expect(health).toBeDefined();
    expect(typeof health.available).toBe('boolean');
    expect(typeof health.recentFailureRate).toBe('number');
    expect(health.statusMessage).toBeDefined();
  });
});

describe('DataProvenance', () => {
  const adapter = new EbayAdapter();

  // Mock HTML for testing
  const mockEbayHtml = `
    <html>
      <body>
        <h1 class="x-item-title__mainTitle">Test Nintendo Switch</h1>
        <span class="x-price-primary"><span class="ux-textspans">$299.99</span></span>
        <div class="vi-bboxrev-postiontop">Sold Oct 15, 2024</div>
        <div data-testid="x-item-condition-value">Used - Like New</div>
        <div data-testid="ux-item-number">123456789</div>
        <a class="x-sellercard-atf__info__about-seller"><span>TestSeller</span></a>
        <div class="x-sellercard-atf__data--rating">99.5%</div>
      </body>
    </html>
  `;

  it('should include provenance in extractWithProvenance result', async () => {
    const result = await adapter.extractWithProvenance(
      mockEbayHtml,
      'https://www.ebay.com/itm/123456789'
    );

    expect(result).not.toBeNull();
    expect(result?.provenance).toBeDefined();

    const { provenance } = result!;
    expect(provenance.channel).toBe('scraping');
    expect(provenance.tier).toBe(3);
    expect(typeof provenance.confidence).toBe('number');
    expect(provenance.freshness).toBe('realtime');
    expect(provenance.sourceId).toContain('eBay');
    expect(provenance.extractedAt).toBeDefined();
    expect(provenance.userConsented).toBe(true);
    expect(provenance.termsCompliant).toBe(true); // eBay is more permissive
  });

  it('should have valid ISO 8601 extractedAt timestamp', async () => {
    const result = await adapter.extractWithProvenance(
      mockEbayHtml,
      'https://www.ebay.com/itm/123456789'
    );

    expect(result).not.toBeNull();
    const timestamp = new Date(result!.provenance.extractedAt);
    expect(timestamp.toString()).not.toBe('Invalid Date');
  });

  it('should include confidence within expected range', async () => {
    const result = await adapter.extractWithProvenance(
      mockEbayHtml,
      'https://www.ebay.com/itm/123456789'
    );

    expect(result).not.toBeNull();
    expect(result!.provenance.confidence).toBeGreaterThanOrEqual(0);
    expect(result!.provenance.confidence).toBeLessThanOrEqual(1);
  });

  it('should convert legacy format to MarketplaceListing', async () => {
    const result = await adapter.extractWithProvenance(
      mockEbayHtml,
      'https://www.ebay.com/itm/123456789'
    );

    expect(result).not.toBeNull();

    // Check MarketplaceListing fields
    expect(result!.marketplace).toBe('ebay');
    expect(result!.url).toBe('https://www.ebay.com/itm/123456789');
    expect(result!.title).toBeDefined();
    expect(result!.availability).toBe('sold');
    expect(result!.extractionMethod).toContain('eBay');
    expect(result!.extractorVersion).toBeDefined();
  });
});

describe('AmazonAdapter Provenance', () => {
  const adapter = new AmazonAdapter();

  const mockAmazonHtml = `
    <html>
      <body>
        <h1 id="productTitle">Test Product Title</h1>
        <span class="a-price"><span class="a-offscreen">$49.99</span></span>
        <div id="availability"><span>In Stock</span></div>
        <input name="ASIN" value="B08TEST123" />
        <a id="sellerProfileTriggerId">Amazon.com</a>
      </body>
    </html>
  `;

  it('should mark Amazon scraping as not ToS compliant', async () => {
    const result = await adapter.extractWithProvenance(
      mockAmazonHtml,
      'https://www.amazon.com/dp/B08TEST123'
    );

    expect(result).not.toBeNull();
    expect(result?.provenance.termsCompliant).toBe(false);
    expect(result?.provenance.metadata?.note).toBeDefined();
  });

  it('should include provenance with correct tier', async () => {
    const result = await adapter.extractWithProvenance(
      mockAmazonHtml,
      'https://www.amazon.com/dp/B08TEST123'
    );

    expect(result).not.toBeNull();
    expect(result?.provenance.tier).toBe(3); // Scraping tier
    expect(result?.provenance.channel).toBe('scraping');
  });
});

describe('Channel Configuration', () => {
  it('should have correct tier mappings', () => {
    // Tier 1 - Official APIs
    expect(CHANNEL_TIER_MAP.official_api).toBe(1);
    expect(CHANNEL_TIER_MAP.financial_api).toBe(1);

    // Tier 2 - Authenticated user context
    expect(CHANNEL_TIER_MAP.browser_extension).toBe(2);
    expect(CHANNEL_TIER_MAP.data_export).toBe(2);
    expect(CHANNEL_TIER_MAP.email_parsing).toBe(2);
    expect(CHANNEL_TIER_MAP.cookie_import).toBe(2);

    // Tier 3 - Scraping
    expect(CHANNEL_TIER_MAP.scraping).toBe(3);

    // Tier 4 - AI-assisted
    expect(CHANNEL_TIER_MAP.ocr_extraction).toBe(4);
    expect(CHANNEL_TIER_MAP.llm_extraction).toBe(4);
  });

  it('should have confidence ranges that decrease by tier', () => {
    // Tier 1 should have highest confidence
    expect(CHANNEL_CONFIDENCE_DEFAULTS.official_api.min).toBeGreaterThan(
      CHANNEL_CONFIDENCE_DEFAULTS.scraping.min
    );

    // Tier 4 should have lowest confidence
    expect(CHANNEL_CONFIDENCE_DEFAULTS.llm_extraction.max).toBeLessThan(
      CHANNEL_CONFIDENCE_DEFAULTS.official_api.max
    );

    // All ranges should be valid (0-1)
    Object.values(CHANNEL_CONFIDENCE_DEFAULTS).forEach((range) => {
      expect(range.min).toBeGreaterThanOrEqual(0);
      expect(range.max).toBeLessThanOrEqual(1);
      expect(range.min).toBeLessThanOrEqual(range.max);
    });
  });
});

describe('WalmartAdapter', () => {
  const adapter = new WalmartAdapter();

  it('should have correct metadata', () => {
    expect(adapter.marketplaceId).toBe('walmart');
    expect(adapter.name).toBe('Walmart Marketplace Adapter');
  });

  it('should identify Walmart URLs', () => {
    expect(adapter.canHandle('https://www.walmart.com/ip/123456789')).toBe(true);
    expect(adapter.canHandle('https://www.amazon.com/dp/B08X6PYCQV')).toBe(false);
  });

  it('should be disabled by default', () => {
    const config = adapter.getConfig();
    expect(config.enabled).toBe(false);
  });
});

// ============================================================================
// Registry Tests
// ============================================================================

describe('MarketplaceRegistry', () => {
  let registry: MarketplaceRegistry;
  let ebayAdapter: EbayAdapterV2;

  beforeEach(() => {
    registry = new MarketplaceRegistry();
    ebayAdapter = new EbayAdapterV2();
  });

  it('should register adapters', () => {
    const config = ebayAdapter.getConfig();
    registry.register(ebayAdapter, config);

    const registered = registry.getRegisteredMarketplaces();
    expect(registered).toContain('ebay');
  });

  it('should find adapter for URL', () => {
    const config = ebayAdapter.getConfig();
    registry.register(ebayAdapter, config);

    const adapter = registry.getAdapterForUrl('https://www.ebay.com/itm/123456789');
    expect(adapter).not.toBeNull();
    expect(adapter?.marketplaceId).toBe('ebay');
  });

  it('should return null for disabled marketplaces', () => {
    const config = { ...ebayAdapter.getConfig(), enabled: false };
    registry.register(ebayAdapter, config);

    const adapter = registry.getAdapterForUrl('https://www.ebay.com/itm/123456789');
    expect(adapter).toBeNull();
  });

  it('should track enabled status', () => {
    const config = ebayAdapter.getConfig();
    registry.register(ebayAdapter, config);

    expect(registry.isEnabled('ebay')).toBe(true);

    registry.updateConfig('ebay', { enabled: false });
    expect(registry.isEnabled('ebay')).toBe(false);
  });

  it('should allow runtime config updates', () => {
    const config = ebayAdapter.getConfig();
    registry.register(ebayAdapter, config);

    const originalRateLimit = registry.getConfig('ebay')?.rateLimit.requestsPerSecond;
    registry.updateConfig('ebay', {
      rateLimit: { ...config.rateLimit, requestsPerSecond: 5 },
    });

    const updatedRateLimit = registry.getConfig('ebay')?.rateLimit.requestsPerSecond;
    expect(updatedRateLimit).toBe(5);
    expect(updatedRateLimit).not.toBe(originalRateLimit);
  });

  it('should track metrics', () => {
    const config = ebayAdapter.getConfig();
    registry.register(ebayAdapter, config);

    const metrics = registry.getMetrics('ebay');
    expect(metrics).not.toBeNull();
    expect(metrics?.totalExtractions).toBe(0);
  });
});

// ============================================================================
// Event Pipeline Tests
// ============================================================================

describe('ExtractionEventPipeline', () => {
  let pipeline: DefaultExtractionEventPipeline;

  beforeEach(() => {
    pipeline = new DefaultExtractionEventPipeline({
      persistToDisk: false,
      emitEnabled: true,
    });
  });

  it('should emit events to subscribers', async () => {
    const receivedEvents: ExtractionEvent[] = [];

    pipeline.subscribe((event) => {
      receivedEvents.push(event);
    });

    const event = createExtractionEvent({
      eventType: 'extraction_success',
      marketplace: 'ebay',
      url: 'https://ebay.com/itm/123',
      duration: 1000,
      extractorVersion: 'test',
      adapterVersion: '1.0.0',
    });

    await pipeline.emit(event);

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].eventId).toBe(event.eventId);
  });

  it('should filter events by marketplace', async () => {
    const receivedEvents: ExtractionEvent[] = [];

    pipeline.subscribe(
      (event) => {
        receivedEvents.push(event);
      },
      { marketplaces: ['amazon'] }
    );

    // Emit eBay event (should be filtered out)
    const ebayEvent = createExtractionEvent({
      eventType: 'extraction_success',
      marketplace: 'ebay',
      url: 'https://ebay.com/itm/123',
      duration: 1000,
      extractorVersion: 'test',
      adapterVersion: '1.0.0',
    });
    await pipeline.emit(ebayEvent);

    // Emit Amazon event (should pass filter)
    const amazonEvent = createExtractionEvent({
      eventType: 'extraction_success',
      marketplace: 'amazon',
      url: 'https://amazon.com/dp/B123',
      duration: 1000,
      extractorVersion: 'test',
      adapterVersion: '1.0.0',
    });
    await pipeline.emit(amazonEvent);

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].marketplace).toBe('amazon');
  });

  it('should support unsubscribe', async () => {
    const receivedEvents: ExtractionEvent[] = [];

    const unsubscribe = pipeline.subscribe((event) => {
      receivedEvents.push(event);
    });

    const event1 = createExtractionEvent({
      eventType: 'extraction_success',
      marketplace: 'ebay',
      url: 'https://ebay.com/itm/123',
      duration: 1000,
      extractorVersion: 'test',
      adapterVersion: '1.0.0',
    });
    await pipeline.emit(event1);

    expect(receivedEvents).toHaveLength(1);

    // Unsubscribe
    unsubscribe();

    const event2 = createExtractionEvent({
      eventType: 'extraction_success',
      marketplace: 'ebay',
      url: 'https://ebay.com/itm/456',
      duration: 1000,
      extractorVersion: 'test',
      adapterVersion: '1.0.0',
    });
    await pipeline.emit(event2);

    // Should still be 1 (not 2)
    expect(receivedEvents).toHaveLength(1);
  });

  it('should track pipeline stats', async () => {
    const event = createExtractionEvent({
      eventType: 'extraction_success',
      marketplace: 'ebay',
      url: 'https://ebay.com/itm/123',
      duration: 1000,
      extractorVersion: 'test',
      adapterVersion: '1.0.0',
    });

    await pipeline.emit(event);

    const stats = pipeline.getStats();
    expect(stats.totalEventsEmitted).toBe(1);
    expect(stats.queueSize).toBe(1);
  });
});

describe('ExtractionAnalytics', () => {
  let pipeline: DefaultExtractionEventPipeline;
  let analytics: ExtractionAnalytics;

  beforeEach(() => {
    pipeline = new DefaultExtractionEventPipeline({ emitEnabled: true });
    analytics = new ExtractionAnalytics();
    analytics.subscribe(pipeline);
  });

  it('should track success and failure counts', async () => {
    const successEvent = createExtractionEvent({
      eventType: 'extraction_success',
      marketplace: 'ebay',
      url: 'https://ebay.com/itm/123',
      duration: 1000,
      extractorVersion: 'test',
      adapterVersion: '1.0.0',
    });

    const failureEvent = createExtractionEvent({
      eventType: 'extraction_failure',
      marketplace: 'ebay',
      url: 'https://ebay.com/itm/456',
      duration: 500,
      extractorVersion: 'test',
      adapterVersion: '1.0.0',
    });

    await pipeline.emit(successEvent);
    await pipeline.emit(failureEvent);

    const summary = analytics.getSummary('ebay');
    expect(summary).toHaveLength(1);
    expect(summary[0].successCount).toBe(1);
    expect(summary[0].failureCount).toBe(1);
  });

  it('should calculate success rate', async () => {
    // 3 successes, 1 failure
    for (let i = 0; i < 3; i++) {
      await pipeline.emit(
        createExtractionEvent({
          eventType: 'extraction_success',
          marketplace: 'ebay',
          url: `https://ebay.com/itm/${i}`,
          duration: 1000,
          extractorVersion: 'test',
          adapterVersion: '1.0.0',
        })
      );
    }

    await pipeline.emit(
      createExtractionEvent({
        eventType: 'extraction_failure',
        marketplace: 'ebay',
        url: 'https://ebay.com/itm/fail',
        duration: 500,
        extractorVersion: 'test',
        adapterVersion: '1.0.0',
      })
    );

    const summary = analytics.getSummary('ebay');
    expect(summary[0].successRate).toBe(0.75);
  });
});

// ============================================================================
// Backfill Executor Tests
// ============================================================================

describe('BackfillExecutor', () => {
  it('should create backfill jobs with correct structure', () => {
    const job = createBackfillJob({
      marketplace: 'ebay',
      urlSourceFile: './urls.txt',
      outputFile: './output.jsonl',
      concurrency: 5,
      batchSize: 20,
    });

    expect(job.marketplace).toBe('ebay');
    expect(job.concurrency).toBe(5);
    expect(job.batchSize).toBe(20);
    expect(job.output.format).toBe('jsonl');
    expect(job.checkpoint.enabled).toBe(true);
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Marketplace System Integration', () => {
  it('should integrate registry, adapters, and event pipeline', async () => {
    const registry = new MarketplaceRegistry();
    const pipeline = new DefaultExtractionEventPipeline({ emitEnabled: true });
    const analytics = new ExtractionAnalytics();

    // Register adapters
    const ebayAdapter = new EbayAdapterV2();
    registry.register(ebayAdapter, ebayAdapter.getConfig());

    // Subscribe analytics
    analytics.subscribe(pipeline);

    // Verify integration
    expect(registry.getRegisteredMarketplaces()).toContain('ebay');
    expect(registry.isEnabled('ebay')).toBe(true);

    // Test event emission
    const event = createExtractionEvent({
      eventType: 'extraction_success',
      marketplace: 'ebay',
      url: 'https://ebay.com/itm/123',
      duration: 1000,
      extractorVersion: 'test',
      adapterVersion: '1.0.0',
    });

    await pipeline.emit(event);

    const summary = analytics.getSummary('ebay');
    expect(summary[0].successCount).toBe(1);
  });
});
