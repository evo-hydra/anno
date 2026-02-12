import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockFetchPage = vi.hoisted(() => vi.fn());
const mockCheckLimit = vi.hoisted(() => vi.fn());
const mockRateLimiterInstances = vi.hoisted(() => [] as Array<{ config: unknown }>);
const MockRateLimiter = vi.hoisted(() => {
  return class MockRateLimiter {
    config: unknown;
    constructor(config: unknown) {
      this.config = config;
      mockRateLimiterInstances.push({ config });
    }
    checkLimit = mockCheckLimit;
  };
});

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../core/marketplace-rate-limiter', () => ({
  RateLimiter: MockRateLimiter,
}));

vi.mock('../services/fetcher', () => ({
  fetchPage: mockFetchPage,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { MarketplaceRegistry } from '../services/extractors/marketplace-registry';
import type {
  MarketplaceAdapter,
  MarketplaceConfig,
  MarketplaceListing,
  MarketplaceType,
} from '../services/extractors/marketplace-adapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<MarketplaceConfig>): MarketplaceConfig {
  return {
    marketplaceId: 'ebay',
    enabled: true,
    rendering: {
      requiresJavaScript: false,
      waitForSelectors: [],
      waitTime: 0,
      blockResources: [],
    },
    rateLimit: {
      requestsPerSecond: 2,
      requestsPerMinute: 100,
      requestsPerHour: 5000,
      backoffStrategy: 'exponential' as const,
      retryAttempts: 3,
    },
    session: {
      requireProxy: false,
      proxyRotation: 'none' as const,
      cookiePersistence: false,
      userAgentRotation: false,
    },
    compliance: {
      respectRobotsTxt: true,
      crawlDelay: 500,
      userAgent: 'TestBot/1.0',
      maxConcurrentRequests: 3,
    },
    quality: {
      minConfidenceScore: 0.7,
      requiredFields: ['title', 'price'],
    },
    features: {
      extractDescriptions: false,
      extractReviews: false,
      extractVariants: false,
      enableBackfill: false,
    },
    ...overrides,
  };
}

function makeListing(overrides?: Partial<MarketplaceListing>): MarketplaceListing {
  return {
    id: 'test-123',
    marketplace: 'ebay',
    url: 'https://www.ebay.com/itm/123456789',
    title: 'Test Item',
    price: { amount: 29.99, currency: 'USD' },
    condition: 'new',
    availability: 'sold',
    seller: { name: 'test-seller' },
    images: ['https://img.example.com/1.jpg'],
    extractedAt: '2026-01-01T00:00:00Z',
    extractionMethod: 'test',
    confidence: 0.85,
    extractorVersion: '1.0.0',
    ...overrides,
  };
}

function makeAdapter(overrides?: Partial<MarketplaceAdapter>): MarketplaceAdapter {
  return {
    marketplaceId: 'ebay' as MarketplaceType,
    name: 'Test eBay Adapter',
    version: '1.0.0',
    canHandle: vi.fn((url: string) => url.includes('ebay.com')),
    extract: vi.fn().mockResolvedValue(makeListing()),
    validate: vi.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
    getConfig: vi.fn().mockReturnValue(makeConfig()),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MarketplaceRegistry', () => {
  let registry: MarketplaceRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimiterInstances.length = 0;
    mockCheckLimit.mockResolvedValue(true);
    mockFetchPage.mockResolvedValue({
      url: 'https://www.ebay.com/itm/123456789',
      finalUrl: 'https://www.ebay.com/itm/123456789',
      status: 200,
      headers: {},
      body: '<html><body>Test</body></html>',
      fetchTimestamp: Date.now(),
      durationMs: 100,
      fromCache: false,
      rendered: false,
      renderDiagnostics: {},
    });
    registry = new MarketplaceRegistry();
  });

  // =========================================================================
  // register
  // =========================================================================

  describe('register', () => {
    it('registers an adapter with config', () => {
      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);

      expect(registry.getRegisteredMarketplaces()).toContain('ebay');
    });

    it('throws when config marketplaceId does not match adapter', () => {
      const adapter = makeAdapter();
      const config = makeConfig({ marketplaceId: 'amazon' });

      expect(() => registry.register(adapter, config)).toThrow(
        'Config marketplace ID (amazon) does not match adapter ID (ebay)'
      );
    });

    it('overwrites existing adapter with warning', () => {
      const adapter1 = makeAdapter({ version: '1.0.0' });
      const adapter2 = makeAdapter({ version: '2.0.0' });
      const config = makeConfig();

      registry.register(adapter1, config);
      registry.register(adapter2, config);

      const registered = registry.getRegisteredMarketplaces();
      expect(registered).toHaveLength(1);
      expect(registry.getAdapter('ebay')?.version).toBe('2.0.0');
    });

    it('initializes rate limiter from config', () => {
      const adapter = makeAdapter();
      const config = makeConfig({
        rateLimit: {
          requestsPerSecond: 5,
          requestsPerMinute: 200,
          requestsPerHour: 10000,
          burstSize: 10,
          backoffStrategy: 'linear',
          retryAttempts: 2,
        },
      });

      registry.register(adapter, config);

      // Rate limiter was constructed (via the mock)
      expect(mockRateLimiterInstances.length).toBeGreaterThan(0);
      const lastInstance = mockRateLimiterInstances[mockRateLimiterInstances.length - 1];
      expect(lastInstance.config).toEqual(
        expect.objectContaining({
          requestsPerSecond: 5,
          requestsPerMinute: 200,
          requestsPerHour: 10000,
          burstSize: 10,
        })
      );
    });

    it('initializes metrics collector', () => {
      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);

      const metrics = registry.getMetrics('ebay');
      expect(metrics).not.toBeNull();
      expect(metrics?.totalExtractions).toBe(0);
    });
  });

  // =========================================================================
  // unregister
  // =========================================================================

  describe('unregister', () => {
    it('removes a registered adapter', () => {
      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);
      const result = registry.unregister('ebay');

      expect(result).toBe(true);
      expect(registry.getRegisteredMarketplaces()).toHaveLength(0);
    });

    it('returns false for non-existent adapter', () => {
      const result = registry.unregister('walmart');
      expect(result).toBe(false);
    });

    it('cleans up metrics, config, and rate limiter', () => {
      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);
      registry.unregister('ebay');

      expect(registry.getAdapter('ebay')).toBeNull();
      expect(registry.getConfig('ebay')).toBeNull();
      expect(registry.getMetrics('ebay')).toBeNull();
    });
  });

  // =========================================================================
  // getAdapterForUrl
  // =========================================================================

  describe('getAdapterForUrl', () => {
    it('returns adapter that can handle the URL', () => {
      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);

      const found = registry.getAdapterForUrl('https://www.ebay.com/itm/123');
      expect(found).toBe(adapter);
    });

    it('returns null when no adapter matches', () => {
      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);

      const found = registry.getAdapterForUrl('https://www.amazon.com/dp/B001');
      expect(found).toBeNull();
    });

    it('returns null when adapter matches but is disabled', () => {
      const adapter = makeAdapter();
      const config = makeConfig({ enabled: false });

      registry.register(adapter, config);

      const found = registry.getAdapterForUrl('https://www.ebay.com/itm/123');
      expect(found).toBeNull();
    });
  });

  // =========================================================================
  // getAdapter
  // =========================================================================

  describe('getAdapter', () => {
    it('returns adapter by marketplace ID', () => {
      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);

      expect(registry.getAdapter('ebay')).toBe(adapter);
    });

    it('returns null for unregistered marketplace', () => {
      expect(registry.getAdapter('amazon')).toBeNull();
    });
  });

  // =========================================================================
  // isEnabled
  // =========================================================================

  describe('isEnabled', () => {
    it('returns true for enabled marketplace', () => {
      const adapter = makeAdapter();
      const config = makeConfig({ enabled: true });

      registry.register(adapter, config);

      expect(registry.isEnabled('ebay')).toBe(true);
    });

    it('returns false for disabled marketplace', () => {
      const adapter = makeAdapter();
      const config = makeConfig({ enabled: false });

      registry.register(adapter, config);

      expect(registry.isEnabled('ebay')).toBe(false);
    });

    it('returns false for unregistered marketplace', () => {
      expect(registry.isEnabled('walmart')).toBe(false);
    });
  });

  // =========================================================================
  // extractListing
  // =========================================================================

  describe('extractListing', () => {
    it('returns NO_ADAPTER error when no adapter found', async () => {
      const result = await registry.extractListing('https://unknown.com/product/1');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NO_ADAPTER');
    });

    it('extracts listing successfully', async () => {
      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);

      const result = await registry.extractListing('https://www.ebay.com/itm/123');

      expect(result.success).toBe(true);
      expect(result.listing).toBeDefined();
      expect(result.metadata.retryCount).toBe(0);
    });

    it('returns FETCH_FAILED when fetch returns error status', async () => {
      mockFetchPage.mockResolvedValue({
        url: 'https://www.ebay.com/itm/123',
        finalUrl: 'https://www.ebay.com/itm/123',
        status: 404,
        headers: {},
        body: '',
        fetchTimestamp: Date.now(),
        durationMs: 50,
        fromCache: false,
        rendered: false,
        renderDiagnostics: {},
      });

      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);

      const result = await registry.extractListing('https://www.ebay.com/itm/123');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FETCH_FAILED');
    });

    it('returns FETCH_FAILED when fetch throws', async () => {
      mockFetchPage.mockRejectedValue(new Error('Network error'));

      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);

      const result = await registry.extractListing('https://www.ebay.com/itm/123');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FETCH_FAILED');
    });

    it('returns EXTRACTION_FAILED when adapter returns null', async () => {
      const adapter = makeAdapter({
        extract: vi.fn().mockResolvedValue(null),
      });
      const config = makeConfig();

      registry.register(adapter, config);

      const result = await registry.extractListing('https://www.ebay.com/itm/123');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXTRACTION_FAILED');
    });

    it('returns LOW_CONFIDENCE when confidence below threshold', async () => {
      const lowConfListing = makeListing({ confidence: 0.3 });
      const adapter = makeAdapter({
        extract: vi.fn().mockResolvedValue(lowConfListing),
        validate: vi.fn().mockReturnValue({ valid: false, errors: ['low'], warnings: [] }),
      });
      const config = makeConfig({ quality: { minConfidenceScore: 0.7, requiredFields: ['title'] } });

      registry.register(adapter, config);

      const result = await registry.extractListing('https://www.ebay.com/itm/123');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LOW_CONFIDENCE');
    });

    it('succeeds when validation fails but confidence is above threshold', async () => {
      const listing = makeListing({ confidence: 0.85 });
      const adapter = makeAdapter({
        extract: vi.fn().mockResolvedValue(listing),
        validate: vi.fn().mockReturnValue({ valid: false, errors: ['minor'], warnings: [] }),
      });
      const config = makeConfig({ quality: { minConfidenceScore: 0.7, requiredFields: ['title'] } });

      registry.register(adapter, config);

      const result = await registry.extractListing('https://www.ebay.com/itm/123');

      expect(result.success).toBe(true);
    });

    it('tracks cache hits in metrics', async () => {
      mockFetchPage.mockResolvedValue({
        url: 'https://www.ebay.com/itm/123',
        finalUrl: 'https://www.ebay.com/itm/123',
        status: 200,
        headers: {},
        body: '<html>cached</html>',
        fetchTimestamp: Date.now(),
        durationMs: 5,
        fromCache: true,
        rendered: false,
        renderDiagnostics: {},
      });

      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);

      await registry.extractListing('https://www.ebay.com/itm/123');

      const metrics = registry.getMetrics('ebay');
      expect(metrics?.cacheHitRate).toBeGreaterThan(0);
    });

    it('handles rate limiting with retry', async () => {
      const adapter = makeAdapter();
      const config = makeConfig({
        rateLimit: {
          requestsPerSecond: 1,
          requestsPerMinute: 10,
          requestsPerHour: 100,
          backoffStrategy: 'constant',
          retryAttempts: 3,
        },
      });

      registry.register(adapter, config);

      // After registration, set up the rate limit mock sequence
      // First call rate limited, second allowed
      mockCheckLimit
        .mockReset()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const resultPromise = registry.extractListing('https://www.ebay.com/itm/123');
      await vi.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.success).toBe(true);
      expect(result.metadata.rateLimited).toBe(true);
      expect(result.metadata.retryCount).toBe(1);
    });

    it('returns RATE_LIMIT_EXCEEDED after max retries', async () => {
      const adapter = makeAdapter();
      const config = makeConfig({
        rateLimit: {
          requestsPerSecond: 1,
          requestsPerMinute: 10,
          requestsPerHour: 100,
          backoffStrategy: 'constant',
          retryAttempts: 1,
        },
      });

      registry.register(adapter, config);

      // After registration, always rate limit
      mockCheckLimit.mockReset().mockResolvedValue(false);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const resultPromise = registry.extractListing('https://www.ebay.com/itm/123');
      await vi.advanceTimersByTimeAsync(10000);
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('retries on extraction error', async () => {
      const adapter = makeAdapter({
        extract: vi
          .fn()
          .mockRejectedValueOnce(new Error('Temporary error'))
          .mockResolvedValueOnce(makeListing()),
      });
      const config = makeConfig({
        rateLimit: {
          requestsPerSecond: 10,
          requestsPerMinute: 100,
          requestsPerHour: 5000,
          backoffStrategy: 'constant',
          retryAttempts: 3,
        },
      });

      registry.register(adapter, config);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const resultPromise = registry.extractListing('https://www.ebay.com/itm/123');
      await vi.advanceTimersByTimeAsync(10000);
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.success).toBe(true);
      expect(result.metadata.retryCount).toBe(1);
    });

    it('returns EXTRACTION_ERROR after max extraction retries', async () => {
      const adapter = makeAdapter({
        extract: vi.fn().mockRejectedValue(new Error('Persistent error')),
      });
      const config = makeConfig({
        rateLimit: {
          requestsPerSecond: 10,
          requestsPerMinute: 100,
          requestsPerHour: 5000,
          backoffStrategy: 'constant',
          retryAttempts: 1,
        },
      });

      registry.register(adapter, config);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const resultPromise = registry.extractListing('https://www.ebay.com/itm/123');
      await vi.advanceTimersByTimeAsync(10000);
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXTRACTION_ERROR');
      expect(result.error?.message).toBe('Persistent error');
    });

    it('uses rendered fetch mode when JS is required', async () => {
      const adapter = makeAdapter();
      const config = makeConfig({
        rendering: {
          requiresJavaScript: true,
          waitForSelectors: ['h1'],
          waitTime: 1000,
          blockResources: [],
        },
      });

      registry.register(adapter, config);

      await registry.extractListing('https://www.ebay.com/itm/123');

      expect(mockFetchPage).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'rendered' })
      );
    });

    it('uses http fetch mode when JS is not required', async () => {
      const adapter = makeAdapter();
      const config = makeConfig({
        rendering: { requiresJavaScript: false },
      });

      registry.register(adapter, config);

      await registry.extractListing('https://www.ebay.com/itm/123');

      expect(mockFetchPage).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'http' })
      );
    });
  });

  // =========================================================================
  // updateConfig
  // =========================================================================

  describe('updateConfig', () => {
    it('updates config for registered marketplace', () => {
      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);
      registry.updateConfig('ebay', { enabled: false });

      expect(registry.isEnabled('ebay')).toBe(false);
    });

    it('throws for unregistered marketplace', () => {
      expect(() => registry.updateConfig('walmart', { enabled: true })).toThrow(
        'No config found for marketplace: walmart'
      );
    });

    it('deep merges nested config objects', () => {
      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);
      registry.updateConfig('ebay', {
        rateLimit: { requestsPerSecond: 5 },
      } as Partial<MarketplaceConfig>);

      const updated = registry.getConfig('ebay');
      expect(updated?.rateLimit.requestsPerSecond).toBe(5);
      // Other rate limit fields should be preserved
      expect(updated?.rateLimit.requestsPerMinute).toBe(100);
    });

    it('recreates rate limiter when rate limit config changes', () => {
      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);

      const countBefore = mockRateLimiterInstances.length;

      registry.updateConfig('ebay', {
        rateLimit: { requestsPerSecond: 10 },
      } as Partial<MarketplaceConfig>);

      expect(mockRateLimiterInstances.length).toBe(countBefore + 1);
    });

    it('does not recreate rate limiter when non-rateLimit config changes', () => {
      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);

      const countBefore = mockRateLimiterInstances.length;

      registry.updateConfig('ebay', { enabled: false });

      expect(mockRateLimiterInstances.length).toBe(countBefore);
    });
  });

  // =========================================================================
  // getConfig
  // =========================================================================

  describe('getConfig', () => {
    it('returns config for registered marketplace', () => {
      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);

      expect(registry.getConfig('ebay')).toEqual(config);
    });

    it('returns null for unregistered marketplace', () => {
      expect(registry.getConfig('walmart')).toBeNull();
    });
  });

  // =========================================================================
  // getMetrics
  // =========================================================================

  describe('getMetrics', () => {
    it('returns metrics after successful extraction', async () => {
      const adapter = makeAdapter();
      const config = makeConfig();

      registry.register(adapter, config);
      await registry.extractListing('https://www.ebay.com/itm/123');

      const metrics = registry.getMetrics('ebay');
      expect(metrics).not.toBeNull();
      expect(metrics!.totalExtractions).toBe(1);
      expect(metrics!.successfulExtractions).toBe(1);
      expect(metrics!.failedExtractions).toBe(0);
      expect(metrics!.averageConfidence).toBeCloseTo(0.85, 1);
    });

    it('returns metrics after failed extraction', async () => {
      const adapter = makeAdapter({
        extract: vi.fn().mockResolvedValue(null),
      });
      const config = makeConfig();

      registry.register(adapter, config);
      await registry.extractListing('https://www.ebay.com/itm/123');

      const metrics = registry.getMetrics('ebay');
      expect(metrics!.failedExtractions).toBe(1);
    });

    it('returns null for unregistered marketplace', () => {
      expect(registry.getMetrics('walmart')).toBeNull();
    });

    it('tracks rate limit hits', async () => {
      const adapter = makeAdapter();
      const config = makeConfig({
        rateLimit: {
          requestsPerSecond: 1,
          requestsPerMinute: 10,
          requestsPerHour: 100,
          backoffStrategy: 'constant',
          retryAttempts: 0,
        },
      });

      registry.register(adapter, config);

      // After registration, always deny
      mockCheckLimit.mockReset().mockResolvedValue(false);
      await registry.extractListing('https://www.ebay.com/itm/123');

      const metrics = registry.getMetrics('ebay');
      expect(metrics!.rateLimitHits).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // getRegisteredMarketplaces
  // =========================================================================

  describe('getRegisteredMarketplaces', () => {
    it('returns empty array when none registered', () => {
      expect(registry.getRegisteredMarketplaces()).toEqual([]);
    });

    it('returns all registered marketplace IDs', () => {
      const ebayAdapter = makeAdapter();
      const amazonAdapter = makeAdapter({
        marketplaceId: 'amazon',
        canHandle: vi.fn((url: string) => url.includes('amazon.com')),
      });

      registry.register(ebayAdapter, makeConfig());
      registry.register(amazonAdapter, makeConfig({ marketplaceId: 'amazon' }));

      const marketplaces = registry.getRegisteredMarketplaces();
      expect(marketplaces).toContain('ebay');
      expect(marketplaces).toContain('amazon');
      expect(marketplaces).toHaveLength(2);
    });
  });

  // =========================================================================
  // Backoff calculation
  // =========================================================================

  describe('backoff strategies', () => {
    it('uses exponential backoff', async () => {
      const adapter = makeAdapter();
      const config = makeConfig({
        rateLimit: {
          requestsPerSecond: 1,
          requestsPerMinute: 10,
          requestsPerHour: 100,
          backoffStrategy: 'exponential',
          retryAttempts: 5,
        },
      });

      registry.register(adapter, config);

      // After registration, set rate limit sequence
      mockCheckLimit
        .mockReset()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      const resultPromise = registry.extractListing('https://www.ebay.com/itm/123');
      await vi.advanceTimersByTimeAsync(20000);
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result.success).toBe(true);
      expect(result.metadata.retryCount).toBe(2);
    });
  });
});
