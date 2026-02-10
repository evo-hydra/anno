/**
 * Tests for DataSourceOrchestrator
 *
 * Tests the unified data access layer with fallback chains,
 * conflict resolution, and health monitoring.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DataSourceOrchestratorImpl,
  createOrchestrator,
} from '../services/extractors/data-source-orchestrator';
import {
  DataSourceAdapter,
  DataSourceChannel,
  DataSourceTier,
  DataSourceHealth,
  MarketplaceListing,
  MarketplaceListingWithProvenance,
  MarketplaceConfig,
  ExtractionOptions,
  ValidationResult,
  CHANNEL_CONFIDENCE_DEFAULTS,
} from '../services/extractors/marketplace-adapter';

// ============================================================================
// Mock Adapter Factory
// ============================================================================

function createMockAdapter(
  options: {
    marketplace?: 'ebay' | 'amazon';
    channel?: DataSourceChannel;
    tier?: DataSourceTier;
    name?: string;
    version?: string;
    available?: boolean;
    extractResult?: MarketplaceListingWithProvenance | null;
    extractError?: Error;
    health?: Partial<DataSourceHealth>;
  } = {}
): DataSourceAdapter {
  const {
    marketplace = 'ebay',
    channel = 'scraping',
    tier = CHANNEL_CONFIDENCE_DEFAULTS[channel] ? 3 : 3,
    name = `Mock ${channel} Adapter`,
    version = '1.0.0',
    available = true,
    extractResult = null,
    extractError,
    health = {},
  } = options;

  const actualTier = options.tier ?? (channel === 'official_api' ? 1 : channel === 'data_export' ? 2 : 3);

  return {
    marketplaceId: marketplace,
    name,
    version,
    channel,
    tier: actualTier,
    confidenceRange: CHANNEL_CONFIDENCE_DEFAULTS[channel] || { min: 0.7, max: 0.85 },
    requiresUserAction: channel === 'data_export' || channel === 'browser_extension',

    canHandle: vi.fn().mockReturnValue(true),

    extract: vi.fn().mockImplementation(async () => {
      if (extractError) throw extractError;
      return extractResult;
    }),

    extractWithProvenance: vi.fn().mockImplementation(async () => {
      if (extractError) throw extractError;
      return extractResult;
    }),

    validate: vi.fn().mockReturnValue({ valid: true, errors: [], warnings: [] } as ValidationResult),

    getConfig: vi.fn().mockReturnValue({
      marketplaceId: marketplace,
      enabled: true,
    } as MarketplaceConfig),

    isAvailable: vi.fn().mockResolvedValue(available),

    getHealth: vi.fn().mockResolvedValue({
      available,
      recentFailureRate: 0,
      estimatedReliability: CHANNEL_CONFIDENCE_DEFAULTS[channel]?.max || 0.8,
      statusMessage: 'Mock adapter healthy',
      ...health,
    } as DataSourceHealth),
  };
}

function createMockListing(
  overrides: Partial<MarketplaceListingWithProvenance> = {}
): MarketplaceListingWithProvenance {
  return {
    id: 'test-123',
    marketplace: 'ebay',
    url: 'https://www.ebay.com/itm/test-123',
    title: 'Test Item',
    price: { amount: 99.99, currency: 'USD' },
    availability: 'sold',
    seller: { name: 'test_seller' },
    images: [],
    extractedAt: new Date().toISOString(),
    extractionMethod: 'mock-adapter',
    confidence: 0.85,
    extractorVersion: '1.0.0',
    provenance: {
      channel: 'scraping',
      tier: 3,
      confidence: 0.85,
      freshness: 'recent',
      sourceId: 'mock-adapter/1.0.0',
      extractedAt: new Date().toISOString(),
      userConsented: true,
      termsCompliant: true,
    },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('DataSourceOrchestrator', () => {
  let orchestrator: DataSourceOrchestratorImpl;

  beforeEach(() => {
    orchestrator = createOrchestrator();
  });

  describe('adapter registration', () => {
    it('registers an adapter successfully', () => {
      const adapter = createMockAdapter({ channel: 'scraping' });
      orchestrator.registerAdapter('ebay', adapter);

      const available = orchestrator.getAvailableAdapters('ebay');
      expect(available).toHaveLength(1);
      expect(available[0].channel).toBe('scraping');
    });

    it('registers multiple adapters for same marketplace', () => {
      const scraping = createMockAdapter({ channel: 'scraping', tier: 3 });
      const dataExport = createMockAdapter({ channel: 'data_export', tier: 2 });
      const api = createMockAdapter({ channel: 'official_api', tier: 1 });

      orchestrator.registerAdapter('ebay', scraping);
      orchestrator.registerAdapter('ebay', dataExport);
      orchestrator.registerAdapter('ebay', api);

      const available = orchestrator.getAvailableAdapters('ebay');
      expect(available).toHaveLength(3);
    });

    it('replaces existing adapter for same channel', () => {
      const v1 = createMockAdapter({ channel: 'scraping', version: '1.0.0' });
      const v2 = createMockAdapter({ channel: 'scraping', version: '2.0.0' });

      orchestrator.registerAdapter('ebay', v1);
      orchestrator.registerAdapter('ebay', v2);

      const available = orchestrator.getAvailableAdapters('ebay');
      expect(available).toHaveLength(1);
    });

    it('unregisters an adapter', () => {
      const adapter = createMockAdapter({ channel: 'scraping' });
      orchestrator.registerAdapter('ebay', adapter);
      orchestrator.unregisterAdapter('ebay', 'scraping');

      const available = orchestrator.getAvailableAdapters('ebay');
      expect(available).toHaveLength(0);
    });

    it('returns empty array for unknown marketplace', () => {
      const available = orchestrator.getAvailableAdapters('walmart');
      expect(available).toEqual([]);
    });
  });

  describe('fallback chains', () => {
    it('uses default tier-based ordering', () => {
      const tier3 = createMockAdapter({ channel: 'scraping', tier: 3 });
      const tier2 = createMockAdapter({ channel: 'data_export', tier: 2 });
      const tier1 = createMockAdapter({ channel: 'official_api', tier: 1 });

      // Register in random order
      orchestrator.registerAdapter('ebay', tier3);
      orchestrator.registerAdapter('ebay', tier1);
      orchestrator.registerAdapter('ebay', tier2);

      const chain = orchestrator.getFallbackChain('ebay');
      expect(chain).toEqual(['official_api', 'data_export', 'scraping']);
    });

    it('respects custom fallback chain', () => {
      const scraping = createMockAdapter({ channel: 'scraping', tier: 3 });
      const dataExport = createMockAdapter({ channel: 'data_export', tier: 2 });

      orchestrator.registerAdapter('ebay', scraping);
      orchestrator.registerAdapter('ebay', dataExport);

      // Set custom chain (prefer scraping over data_export)
      orchestrator.setFallbackChain('ebay', ['scraping', 'data_export']);

      const chain = orchestrator.getFallbackChain('ebay');
      expect(chain).toEqual(['scraping', 'data_export']);
    });

    it('returns empty chain for unknown marketplace', () => {
      const chain = orchestrator.getFallbackChain('walmart');
      expect(chain).toEqual([]);
    });
  });

  describe('getData - single source with fallback', () => {
    it('returns data from first successful adapter', async () => {
      const listing = createMockListing({ title: 'Success Item' });
      const adapter = createMockAdapter({
        channel: 'scraping',
        extractResult: listing,
      });

      orchestrator.registerAdapter('ebay', adapter);

      const result = await orchestrator.getData('ebay', 'https://ebay.com/itm/123');

      expect(result.data).not.toBeNull();
      expect(result.data?.title).toBe('Success Item');
      expect(result.fallbackUsed).toBe(false);
      expect(result.attemptedSources).toHaveLength(1);
      expect(result.attemptedSources[0].success).toBe(true);
    });

    it('falls back to next adapter on failure', async () => {
      const tier1Listing = createMockListing({
        title: 'Tier 1 Item',
        provenance: { channel: 'official_api', tier: 1, confidence: 0.95, freshness: 'realtime', sourceId: 'api', extractedAt: new Date().toISOString(), userConsented: true, termsCompliant: true },
      });

      const failingAdapter = createMockAdapter({
        channel: 'official_api',
        tier: 1,
        extractError: new Error('API unavailable'),
      });

      const successAdapter = createMockAdapter({
        channel: 'scraping',
        tier: 3,
        extractResult: createMockListing({ title: 'Fallback Item' }),
      });

      orchestrator.registerAdapter('ebay', failingAdapter);
      orchestrator.registerAdapter('ebay', successAdapter);

      const result = await orchestrator.getData('ebay', 'https://ebay.com/itm/123');

      expect(result.data).not.toBeNull();
      expect(result.data?.title).toBe('Fallback Item');
      expect(result.fallbackUsed).toBe(true);
      expect(result.attemptedSources).toHaveLength(2);
      expect(result.attemptedSources[0].success).toBe(false);
      expect(result.attemptedSources[1].success).toBe(true);
    });

    it('respects preferredTiers option', async () => {
      const tier1 = createMockAdapter({
        channel: 'official_api',
        tier: 1,
        extractResult: createMockListing({ title: 'API Item' }),
      });

      const tier3 = createMockAdapter({
        channel: 'scraping',
        tier: 3,
        extractResult: createMockListing({ title: 'Scraping Item' }),
      });

      orchestrator.registerAdapter('ebay', tier1);
      orchestrator.registerAdapter('ebay', tier3);

      // Only allow tier 3
      const result = await orchestrator.getData('ebay', 'https://ebay.com/itm/123', {
        preferredTiers: [3],
      });

      expect(result.data?.title).toBe('Scraping Item');
      expect(result.attemptedSources).toHaveLength(1);
    });

    it('respects requiredConfidence threshold', async () => {
      const lowConfidence = createMockAdapter({
        channel: 'scraping',
        tier: 3,
        extractResult: createMockListing({ confidence: 0.4 }),
      });

      const highConfidence = createMockAdapter({
        channel: 'data_export',
        tier: 2,
        extractResult: createMockListing({ confidence: 0.9 }),
      });

      orchestrator.registerAdapter('ebay', lowConfidence);
      orchestrator.registerAdapter('ebay', highConfidence);

      const result = await orchestrator.getData('ebay', 'https://ebay.com/itm/123', {
        requiredConfidence: 0.8,
      });

      expect(result.data?.confidence).toBe(0.9);
    });

    it('skips unavailable adapters', async () => {
      const unavailable = createMockAdapter({
        channel: 'official_api',
        tier: 1,
        available: false,
      });

      const available = createMockAdapter({
        channel: 'scraping',
        tier: 3,
        available: true,
        extractResult: createMockListing({ title: 'Available Item' }),
      });

      orchestrator.registerAdapter('ebay', unavailable);
      orchestrator.registerAdapter('ebay', available);

      const result = await orchestrator.getData('ebay', 'https://ebay.com/itm/123');

      expect(result.data?.title).toBe('Available Item');
      expect(result.attemptedSources[0].error).toBe('Adapter not available');
    });

    it('respects allowFallback=false', async () => {
      const failing = createMockAdapter({
        channel: 'official_api',
        tier: 1,
        extractError: new Error('Failed'),
      });

      const backup = createMockAdapter({
        channel: 'scraping',
        tier: 3,
        extractResult: createMockListing(),
      });

      orchestrator.registerAdapter('ebay', failing);
      orchestrator.registerAdapter('ebay', backup);

      const result = await orchestrator.getData('ebay', 'https://ebay.com/itm/123', {
        allowFallback: false,
      });

      expect(result.data).toBeNull();
      expect(result.attemptedSources).toHaveLength(1);
    });

    it('returns null when no adapters registered', async () => {
      const result = await orchestrator.getData('ebay', 'https://ebay.com/itm/123');

      expect(result.data).toBeNull();
      expect(result.attemptedSources).toHaveLength(0);
    });

    it('excludes channels via excludeChannels option', async () => {
      const api = createMockAdapter({
        channel: 'official_api',
        tier: 1,
        extractResult: createMockListing({ title: 'API' }),
      });

      const scraping = createMockAdapter({
        channel: 'scraping',
        tier: 3,
        extractResult: createMockListing({ title: 'Scraping' }),
      });

      orchestrator.registerAdapter('ebay', api);
      orchestrator.registerAdapter('ebay', scraping);

      const result = await orchestrator.getData('ebay', 'https://ebay.com/itm/123', {
        excludeChannels: ['official_api'],
      });

      expect(result.data?.title).toBe('Scraping');
    });
  });

  describe('getFromAllSources - multi-source with merge', () => {
    it('collects data from all available sources', async () => {
      const api = createMockAdapter({
        channel: 'official_api',
        tier: 1,
        extractResult: createMockListing({
          title: 'API Title',
          provenance: { channel: 'official_api', tier: 1, confidence: 0.95, freshness: 'realtime', sourceId: 'api', extractedAt: new Date().toISOString(), userConsented: true, termsCompliant: true },
        }),
      });

      const scraping = createMockAdapter({
        channel: 'scraping',
        tier: 3,
        extractResult: createMockListing({
          title: 'API Title', // Same title
          provenance: { channel: 'scraping', tier: 3, confidence: 0.8, freshness: 'recent', sourceId: 'scraper', extractedAt: new Date().toISOString(), userConsented: true, termsCompliant: true },
        }),
      });

      orchestrator.registerAdapter('ebay', api);
      orchestrator.registerAdapter('ebay', scraping);

      const result = await orchestrator.getFromAllSources('ebay', 'https://ebay.com/itm/123');

      expect(result.sources).toHaveLength(2);
      expect(result.mergedData).not.toBeNull();
      expect(result.mergedData?.correlatedSources).toHaveLength(2);
    });

    it('detects and resolves conflicts', async () => {
      const api = createMockAdapter({
        channel: 'official_api',
        tier: 1,
        extractResult: createMockListing({
          title: 'API Title',
          price: { amount: 100, currency: 'USD' },
          provenance: { channel: 'official_api', tier: 1, confidence: 0.95, freshness: 'realtime', sourceId: 'api', extractedAt: new Date().toISOString(), userConsented: true, termsCompliant: true },
        }),
      });

      const scraping = createMockAdapter({
        channel: 'scraping',
        tier: 3,
        extractResult: createMockListing({
          title: 'Scraping Title', // Different!
          price: { amount: 99, currency: 'USD' }, // Different!
          provenance: { channel: 'scraping', tier: 3, confidence: 0.8, freshness: 'recent', sourceId: 'scraper', extractedAt: new Date().toISOString(), userConsented: true, termsCompliant: true },
        }),
      });

      orchestrator.registerAdapter('ebay', api);
      orchestrator.registerAdapter('ebay', scraping);

      const result = await orchestrator.getFromAllSources('ebay', 'https://ebay.com/itm/123');

      expect(result.conflicts.length).toBeGreaterThan(0);

      // Should resolve to tier 1 (API) values
      expect(result.mergedData?.title).toBe('API Title');
      expect(result.mergedData?.price?.amount).toBe(100);

      // Check conflict metadata
      const titleConflict = result.conflicts.find(c => c.field === 'title');
      expect(titleConflict).toBeDefined();
      expect(titleConflict?.resolutionMethod).toBe('highest_tier');
    });

    it('boosts confidence for agreeing sources', async () => {
      const baseConfidence = 0.85;

      const source1 = createMockAdapter({
        channel: 'official_api',
        tier: 1,
        extractResult: createMockListing({
          title: 'Same Title',
          confidence: baseConfidence,
          provenance: { channel: 'official_api', tier: 1, confidence: baseConfidence, freshness: 'realtime', sourceId: 'api', extractedAt: new Date().toISOString(), userConsented: true, termsCompliant: true },
        }),
      });

      const source2 = createMockAdapter({
        channel: 'scraping',
        tier: 3,
        extractResult: createMockListing({
          title: 'Same Title', // Agreeing
          confidence: 0.8,
          provenance: { channel: 'scraping', tier: 3, confidence: 0.8, freshness: 'recent', sourceId: 'scraper', extractedAt: new Date().toISOString(), userConsented: true, termsCompliant: true },
        }),
      });

      orchestrator.registerAdapter('ebay', source1);
      orchestrator.registerAdapter('ebay', source2);

      const result = await orchestrator.getFromAllSources('ebay', 'https://ebay.com/itm/123');

      // Confidence should be boosted due to agreement
      expect(result.mergedData?.confidence).toBeGreaterThan(baseConfidence);
    });

    it('returns null when no sources succeed', async () => {
      const failing = createMockAdapter({
        channel: 'scraping',
        extractError: new Error('Failed'),
      });

      orchestrator.registerAdapter('ebay', failing);

      const result = await orchestrator.getFromAllSources('ebay', 'https://ebay.com/itm/123');

      expect(result.mergedData).toBeNull();
      expect(result.sources).toHaveLength(0);
    });
  });

  describe('health monitoring', () => {
    it('returns health report for all adapters', async () => {
      const ebayAdapter = createMockAdapter({
        marketplace: 'ebay',
        channel: 'scraping',
        health: { available: true, recentFailureRate: 0.1 },
      });

      const amazonAdapter = createMockAdapter({
        marketplace: 'amazon',
        channel: 'data_export',
        health: { available: true, recentFailureRate: 0 },
      });

      orchestrator.registerAdapter('ebay', ebayAdapter);
      orchestrator.registerAdapter('amazon', amazonAdapter);

      const report = await orchestrator.getHealthReport();

      expect(report.size).toBe(2);
      expect(report.get('ebay')?.get('scraping')?.available).toBe(true);
      expect(report.get('amazon')?.get('data_export')?.available).toBe(true);
    });

    it('handles health check failures gracefully', async () => {
      const adapter = createMockAdapter({ channel: 'scraping' });
      (adapter.getHealth as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Health check failed'));

      orchestrator.registerAdapter('ebay', adapter);

      const report = await orchestrator.getHealthReport();

      expect(report.get('ebay')?.get('scraping')?.available).toBe(false);
      expect(report.get('ebay')?.get('scraping')?.recentFailureRate).toBe(1.0);
    });
  });

  describe('enable/disable adapters', () => {
    it('disables an adapter', async () => {
      const adapter = createMockAdapter({
        channel: 'scraping',
        extractResult: createMockListing(),
      });

      orchestrator.registerAdapter('ebay', adapter);
      orchestrator.disableAdapter('ebay', 'scraping');

      const result = await orchestrator.getData('ebay', 'https://ebay.com/itm/123');

      expect(result.data).toBeNull();
      expect(result.attemptedSources).toHaveLength(0);
    });

    it('re-enables a disabled adapter', async () => {
      const adapter = createMockAdapter({
        channel: 'scraping',
        extractResult: createMockListing(),
      });

      orchestrator.registerAdapter('ebay', adapter);
      orchestrator.disableAdapter('ebay', 'scraping');
      orchestrator.enableAdapter('ebay', 'scraping');

      const result = await orchestrator.getData('ebay', 'https://ebay.com/itm/123');

      expect(result.data).not.toBeNull();
    });

    it('reports disabled adapters as unavailable', () => {
      const adapter = createMockAdapter({ channel: 'scraping' });

      orchestrator.registerAdapter('ebay', adapter);
      orchestrator.disableAdapter('ebay', 'scraping');

      const available = orchestrator.getAvailableAdapters('ebay');
      expect(available[0].available).toBe(false);
    });
  });
});

describe('createOrchestrator factory', () => {
  it('creates a new instance', () => {
    const orchestrator = createOrchestrator();
    expect(orchestrator).toBeInstanceOf(DataSourceOrchestratorImpl);
  });

  it('creates independent instances', () => {
    const o1 = createOrchestrator();
    const o2 = createOrchestrator();

    const adapter = createMockAdapter({ channel: 'scraping' });
    o1.registerAdapter('ebay', adapter);

    expect(o1.getAvailableAdapters('ebay')).toHaveLength(1);
    expect(o2.getAvailableAdapters('ebay')).toHaveLength(0);
  });
});
