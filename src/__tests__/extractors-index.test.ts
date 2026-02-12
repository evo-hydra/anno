import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks for all modules imported by the index barrel
// ---------------------------------------------------------------------------

const mockInitializeMarketplaceRegistry = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockLoadFeatureFlags = vi.hoisted(() =>
  vi.fn().mockResolvedValue(new Map([['test.flag', true]]))
);
const mockLoadFlags = vi.hoisted(() => vi.fn());

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock heavy dependencies that the barrel re-exports
vi.mock('../services/extractors/ebay-adapter-v2', () => ({
  EbayAdapterV2: vi.fn(),
  ebayAdapterV2: { marketplaceId: 'ebay', name: 'eBay', version: '2.1.0' },
}));

vi.mock('../services/extractors/amazon-adapter', () => ({
  AmazonAdapter: vi.fn(),
  amazonAdapter: { marketplaceId: 'amazon', name: 'Amazon', version: '1.0.0' },
}));

vi.mock('../services/extractors/walmart-adapter', () => ({
  WalmartAdapter: vi.fn(),
  walmartAdapter: { marketplaceId: 'walmart', name: 'Walmart', version: '1.0.0' },
}));

vi.mock('../services/extractors/amazon-data-export-adapter', () => ({
  AmazonDataExportAdapter: vi.fn(),
  amazonDataExportAdapter: {},
}));

vi.mock('../services/extractors/ebay-data-export-adapter', () => ({
  EbayDataExportAdapter: vi.fn(),
  ebayDataExportAdapter: {},
}));

vi.mock('../services/extractors/browser-extension-adapter', () => ({
  BrowserExtensionAdapter: vi.fn(),
  createBrowserExtensionAdapter: vi.fn(),
  createIsolatedBrowserExtensionAdapter: vi.fn(),
  getBrowserExtensionAdapter: vi.fn(),
}));

vi.mock('../services/extractors/email-parsing-adapter', () => ({
  EmailParsingAdapter: vi.fn(),
  emailParsingAdapter: {},
  createEmailAdapter: vi.fn(),
}));

vi.mock('../services/extractors/llm-extraction-adapter', () => ({
  LLMExtractionAdapter: vi.fn(),
  createClaudeAdapter: vi.fn(),
  createOpenAIAdapter: vi.fn(),
  createOllamaAdapter: vi.fn(),
}));

vi.mock('../services/extractors/data-source-orchestrator', () => ({
  DataSourceOrchestratorImpl: vi.fn(),
  getOrchestrator: vi.fn(),
  createOrchestrator: vi.fn(),
}));

vi.mock('../services/extractors/marketplace-registry', () => ({
  MarketplaceRegistry: vi.fn(),
  marketplaceRegistry: {
    register: vi.fn(),
    getRegisteredMarketplaces: vi.fn().mockReturnValue([]),
    isEnabled: vi.fn(),
  },
}));

vi.mock('../services/extractors/extraction-event-pipeline', () => {
  class MockExtractionAnalytics {
    subscribe = vi.fn().mockReturnValue(vi.fn());
  }
  return {
    DefaultExtractionEventPipeline: vi.fn(),
    extractionEventPipeline: {
      emit: vi.fn(),
      subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
    createExtractionEvent: vi.fn(),
    ExtractionAnalytics: MockExtractionAnalytics,
  };
});

vi.mock('../services/extractors/marketplace-config-loader', () => ({
  loadMarketplaceConfigs: vi.fn(),
  initializeMarketplaceRegistry: mockInitializeMarketplaceRegistry,
  loadFeatureFlags: mockLoadFeatureFlags,
  reloadMarketplaceConfig: vi.fn(),
  validateMarketplaceConfig: vi.fn(),
  exportMarketplaceConfig: vi.fn(),
}));

vi.mock('../services/extractors/backfill-executor', () => {
  class MockBackfillExecutor {
    start = vi.fn();
    pause = vi.fn();
  }
  return {
    BackfillExecutor: MockBackfillExecutor,
    createBackfillJob: vi.fn(),
  };
});

vi.mock('../services/extractors/feature-flags', () => ({
  FeatureFlagManager: vi.fn(),
  featureFlags: {
    loadFlags: mockLoadFlags,
    isEnabled: vi.fn(),
  },
  MARKETPLACE_FLAGS: {
    MARKETPLACE_EBAY_ENABLED: 'marketplace.ebay.enabled',
  },
  DEFAULT_FLAGS: {},
}));

vi.mock('../../core/marketplace-rate-limiter', () => ({
  RateLimiter: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import (after mocks)
// ---------------------------------------------------------------------------

import {
  initializeMarketplaceSystem,
  ebayAdapterV2,
  walmartAdapter,
  marketplaceRegistry,
  extractionEventPipeline,
  createBackfillJob,
  BackfillExecutor,
  ExtractionAnalytics,
  MARKETPLACE_FLAGS,
  featureFlags,
} from '../services/extractors/index';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractors/index barrel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Re-exports
  // =========================================================================

  describe('re-exports', () => {
    it('exports ebayAdapterV2', () => {
      expect(ebayAdapterV2).toBeDefined();
      expect(ebayAdapterV2.marketplaceId).toBe('ebay');
    });

    it('exports walmartAdapter', () => {
      expect(walmartAdapter).toBeDefined();
      expect(walmartAdapter.marketplaceId).toBe('walmart');
    });

    it('exports marketplaceRegistry', () => {
      expect(marketplaceRegistry).toBeDefined();
    });

    it('exports extractionEventPipeline', () => {
      expect(extractionEventPipeline).toBeDefined();
      expect(typeof extractionEventPipeline.emit).toBe('function');
    });

    it('exports createBackfillJob function', () => {
      expect(createBackfillJob).toBeDefined();
    });

    it('exports BackfillExecutor class', () => {
      expect(BackfillExecutor).toBeDefined();
    });

    it('exports ExtractionAnalytics class', () => {
      expect(ExtractionAnalytics).toBeDefined();
    });

    it('exports MARKETPLACE_FLAGS', () => {
      expect(MARKETPLACE_FLAGS).toBeDefined();
      expect(MARKETPLACE_FLAGS.MARKETPLACE_EBAY_ENABLED).toBe('marketplace.ebay.enabled');
    });

    it('exports featureFlags singleton', () => {
      expect(featureFlags).toBeDefined();
    });
  });

  // =========================================================================
  // initializeMarketplaceSystem
  // =========================================================================

  describe('initializeMarketplaceSystem', () => {
    it('loads feature flags from config path', async () => {
      await initializeMarketplaceSystem('/path/to/config.yaml');

      expect(mockLoadFeatureFlags).toHaveBeenCalledWith('/path/to/config.yaml');
    });

    it('loads flags into featureFlags singleton', async () => {
      await initializeMarketplaceSystem('/path/to/config.yaml');

      expect(mockLoadFlags).toHaveBeenCalled();
    });

    it('initializes marketplace registry with config path', async () => {
      await initializeMarketplaceSystem('/path/to/config.yaml');

      expect(mockInitializeMarketplaceRegistry).toHaveBeenCalledWith(
        expect.anything(),
        '/path/to/config.yaml'
      );
    });

    it('returns registry, pipeline, analytics, and backfillExecutor', async () => {
      const result = await initializeMarketplaceSystem('/path/to/config.yaml');

      expect(result).toHaveProperty('registry');
      expect(result).toHaveProperty('pipeline');
      expect(result).toHaveProperty('analytics');
      expect(result).toHaveProperty('backfillExecutor');
    });

    it('subscribes analytics to event pipeline', async () => {
      const result = await initializeMarketplaceSystem('/path/to/config.yaml');

      // analytics.subscribe should have been called with pipeline
      expect(result.analytics.subscribe).toHaveBeenCalled();
    });

    it('creates backfill executor with registry', async () => {
      const result = await initializeMarketplaceSystem('/path/to/config.yaml');

      // The backfillExecutor should be an instance of the mocked class
      expect(result.backfillExecutor).toBeDefined();
      expect(result.backfillExecutor).toHaveProperty('start');
      expect(result.backfillExecutor).toHaveProperty('pause');
    });
  });
});
