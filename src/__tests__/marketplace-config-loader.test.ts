import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockYamlParse = vi.hoisted(() => vi.fn());
const mockYamlStringify = vi.hoisted(() => vi.fn());

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

vi.mock('yaml', () => ({
  default: {
    parse: mockYamlParse,
    stringify: mockYamlStringify,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock the adapter modules to avoid loading their real dependencies
const mockEbayAdapter = vi.hoisted(() => ({
  marketplaceId: 'ebay' as const,
  name: 'eBay Adapter V2',
  version: '2.0.0',
  canHandle: vi.fn(),
  getConfig: vi.fn(),
}));

const mockAmazonAdapter = vi.hoisted(() => ({
  marketplaceId: 'amazon' as const,
  name: 'Amazon Adapter',
  version: '1.0.0',
  canHandle: vi.fn(),
  getConfig: vi.fn(),
}));

const mockWalmartAdapter = vi.hoisted(() => ({
  marketplaceId: 'walmart' as const,
  name: 'Walmart Adapter',
  version: '1.0.0',
  canHandle: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock('../services/extractors/ebay-adapter-v2', () => ({
  ebayAdapterV2: mockEbayAdapter,
}));

vi.mock('../services/extractors/amazon-adapter', () => ({
  amazonAdapter: mockAmazonAdapter,
}));

vi.mock('../services/extractors/walmart-adapter', () => ({
  walmartAdapter: mockWalmartAdapter,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  loadMarketplaceConfigs,
  loadFeatureFlags,
  initializeMarketplaceRegistry,
  reloadMarketplaceConfig,
  validateMarketplaceConfig,
  exportMarketplaceConfig,
} from '../services/extractors/marketplace-config-loader';
import type { MarketplaceConfig } from '../services/extractors/marketplace-adapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidConfig(): MarketplaceConfig {
  return {
    marketplaceId: 'ebay',
    enabled: true,
    rendering: {
      requiresJavaScript: false,
    },
    rateLimit: {
      requestsPerSecond: 1,
      requestsPerMinute: 60,
      requestsPerHour: 3600,
      backoffStrategy: 'exponential',
      retryAttempts: 3,
    },
    session: {
      requireProxy: false,
      proxyRotation: 'none',
      cookiePersistence: false,
      userAgentRotation: false,
    },
    compliance: {
      respectRobotsTxt: true,
      userAgent: 'AnnoBot/1.0',
      maxConcurrentRequests: 2,
      crawlDelay: 1000,
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
  };
}

function makeConfigFileData() {
  return {
    marketplaces: {
      ebay: {
        enabled: true,
        rendering: { requiresJavaScript: false },
        rateLimit: {
          requestsPerSecond: 1,
          requestsPerMinute: 30,
          requestsPerHour: 500,
          backoffStrategy: 'exponential',
          retryAttempts: 3,
        },
        session: {
          requireProxy: false,
          proxyRotation: 'none',
          cookiePersistence: false,
          userAgentRotation: false,
        },
        compliance: {
          respectRobotsTxt: true,
          userAgent: 'AnnoBot/1.0',
          maxConcurrentRequests: 2,
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
      },
    },
    featureFlags: {
      extraction_events_enabled: true,
      nightly_validation_enabled: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadMarketplaceConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and returns configs from YAML file', async () => {
    const configData = makeConfigFileData();
    mockReadFile.mockResolvedValue('yaml content');
    mockYamlParse.mockReturnValue(configData);

    const configs = await loadMarketplaceConfigs('/path/to/config.yaml');

    expect(mockReadFile).toHaveBeenCalledWith('/path/to/config.yaml', 'utf-8');
    expect(configs.size).toBe(1);
    expect(configs.has('ebay')).toBe(true);

    const ebayConfig = configs.get('ebay')!;
    expect(ebayConfig.marketplaceId).toBe('ebay');
    expect(ebayConfig.enabled).toBe(true);
  });

  it('loads configs for multiple marketplaces', async () => {
    const configData = makeConfigFileData();
    (configData.marketplaces as Record<string, unknown>)['amazon'] = {
      ...configData.marketplaces.ebay,
      enabled: false,
    };

    mockReadFile.mockResolvedValue('yaml content');
    mockYamlParse.mockReturnValue(configData);

    const configs = await loadMarketplaceConfigs('/path/to/config.yaml');
    expect(configs.size).toBe(2);
  });

  it('throws when file cannot be read', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    await expect(loadMarketplaceConfigs('/missing.yaml')).rejects.toThrow(
      'Failed to load marketplace configs'
    );
  });

  it('throws when YAML parsing fails', async () => {
    mockReadFile.mockResolvedValue('invalid: yaml: content:');
    mockYamlParse.mockImplementation(() => {
      throw new Error('YAML parse error');
    });

    await expect(loadMarketplaceConfigs('/bad.yaml')).rejects.toThrow(
      'Failed to load marketplace configs'
    );
  });
});

describe('loadFeatureFlags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads feature flags from config file', async () => {
    const configData = makeConfigFileData();
    mockReadFile.mockResolvedValue('yaml content');
    mockYamlParse.mockReturnValue(configData);

    const flags = await loadFeatureFlags('/config.yaml');

    expect(flags.size).toBe(2);
    expect(flags.get('extraction_events_enabled')).toBe(true);
    expect(flags.get('nightly_validation_enabled')).toBe(false);
  });

  it('returns empty map when featureFlags is missing', async () => {
    mockReadFile.mockResolvedValue('yaml content');
    mockYamlParse.mockReturnValue({ marketplaces: {} });

    const flags = await loadFeatureFlags('/config.yaml');
    expect(flags.size).toBe(0);
  });

  it('returns empty map on file read error (graceful)', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const flags = await loadFeatureFlags('/missing.yaml');
    expect(flags.size).toBe(0);
  });

  it('handles null flag values by defaulting to false', async () => {
    mockReadFile.mockResolvedValue('yaml');
    mockYamlParse.mockReturnValue({
      marketplaces: {},
      featureFlags: {
        some_flag: null,
      },
    });

    const flags = await loadFeatureFlags('/config.yaml');
    expect(flags.get('some_flag')).toBe(false);
  });
});

describe('initializeMarketplaceRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers adapters with configs from file', async () => {
    const configData = makeConfigFileData();
    (configData.marketplaces as Record<string, unknown>)['amazon'] = { ...configData.marketplaces.ebay };
    (configData.marketplaces as Record<string, unknown>)['walmart'] = { ...configData.marketplaces.ebay };

    mockReadFile.mockResolvedValue('yaml');
    mockYamlParse.mockReturnValue(configData);

    const mockRegistry = {
      register: vi.fn(),
      getRegisteredMarketplaces: vi.fn().mockReturnValue(['ebay', 'amazon', 'walmart']),
      isEnabled: vi.fn().mockReturnValue(true),
    };

    await initializeMarketplaceRegistry(mockRegistry as unknown, '/config.yaml');

    expect(mockRegistry.register).toHaveBeenCalledTimes(3);
  });

  it('uses adapter default config when no config found for adapter', async () => {
    // Only provide ebay config, not amazon or walmart
    const configData = makeConfigFileData();
    mockReadFile.mockResolvedValue('yaml');
    mockYamlParse.mockReturnValue(configData);

    const defaultConfig = makeValidConfig();
    mockAmazonAdapter.getConfig.mockReturnValue({ ...defaultConfig, marketplaceId: 'amazon' });
    mockWalmartAdapter.getConfig.mockReturnValue({ ...defaultConfig, marketplaceId: 'walmart' });

    const mockRegistry = {
      register: vi.fn(),
      getRegisteredMarketplaces: vi.fn().mockReturnValue(['ebay', 'amazon', 'walmart']),
      isEnabled: vi.fn().mockReturnValue(true),
    };

    await initializeMarketplaceRegistry(mockRegistry as unknown, '/config.yaml');

    // All three adapters should be registered
    expect(mockRegistry.register).toHaveBeenCalledTimes(3);

    // Amazon and Walmart should have been registered with default configs
    const amazonCall = mockRegistry.register.mock.calls.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>).marketplaceId === 'amazon'
    );
    expect(amazonCall).toBeDefined();
  });
});

describe('reloadMarketplaceConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reloads config for a specific marketplace', async () => {
    const configData = makeConfigFileData();
    mockReadFile.mockResolvedValue('yaml');
    mockYamlParse.mockReturnValue(configData);

    const mockRegistry = {
      updateConfig: vi.fn(),
    };

    await reloadMarketplaceConfig(mockRegistry as unknown, '/config.yaml', 'ebay');

    expect(mockRegistry.updateConfig).toHaveBeenCalledTimes(1);
    expect(mockRegistry.updateConfig).toHaveBeenCalledWith(
      'ebay',
      expect.objectContaining({ marketplaceId: 'ebay' })
    );
  });

  it('throws when marketplace not found in config', async () => {
    const configData = makeConfigFileData();
    mockReadFile.mockResolvedValue('yaml');
    mockYamlParse.mockReturnValue(configData);

    const mockRegistry = {
      updateConfig: vi.fn(),
    };

    await expect(
      reloadMarketplaceConfig(mockRegistry as unknown, '/config.yaml', 'etsy')
    ).rejects.toThrow('No config found for marketplace: etsy');
  });
});

describe('validateMarketplaceConfig', () => {
  it('returns empty array for valid config', () => {
    const config = makeValidConfig();
    const errors = validateMarketplaceConfig(config);
    expect(errors).toHaveLength(0);
  });

  it('reports requestsPerSecond <= 0', () => {
    const config = makeValidConfig();
    config.rateLimit.requestsPerSecond = 0;
    const errors = validateMarketplaceConfig(config);
    expect(errors).toContain('requestsPerSecond must be > 0');
  });

  it('reports requestsPerMinute <= 0', () => {
    const config = makeValidConfig();
    config.rateLimit.requestsPerMinute = -1;
    const errors = validateMarketplaceConfig(config);
    expect(errors).toContain('requestsPerMinute must be > 0');
  });

  it('reports requestsPerHour <= 0', () => {
    const config = makeValidConfig();
    config.rateLimit.requestsPerHour = 0;
    const errors = validateMarketplaceConfig(config);
    expect(errors).toContain('requestsPerHour must be > 0');
  });

  it('reports rate limit consistency: requestsPerSecond * 60 > requestsPerMinute', () => {
    const config = makeValidConfig();
    config.rateLimit.requestsPerSecond = 10;
    config.rateLimit.requestsPerMinute = 30; // 10*60=600 > 30
    const errors = validateMarketplaceConfig(config);
    expect(errors).toContain('requestsPerSecond * 60 exceeds requestsPerMinute');
  });

  it('reports rate limit consistency: requestsPerMinute * 60 > requestsPerHour', () => {
    const config = makeValidConfig();
    config.rateLimit.requestsPerSecond = 1;
    config.rateLimit.requestsPerMinute = 100;
    config.rateLimit.requestsPerHour = 500; // 100*60=6000 > 500
    const errors = validateMarketplaceConfig(config);
    expect(errors).toContain('requestsPerMinute * 60 exceeds requestsPerHour');
  });

  it('reports minConfidenceScore out of range (below 0)', () => {
    const config = makeValidConfig();
    config.quality.minConfidenceScore = -0.1;
    const errors = validateMarketplaceConfig(config);
    expect(errors).toContain('minConfidenceScore must be between 0 and 1');
  });

  it('reports minConfidenceScore out of range (above 1)', () => {
    const config = makeValidConfig();
    config.quality.minConfidenceScore = 1.5;
    const errors = validateMarketplaceConfig(config);
    expect(errors).toContain('minConfidenceScore must be between 0 and 1');
  });

  it('reports empty requiredFields', () => {
    const config = makeValidConfig();
    config.quality.requiredFields = [];
    const errors = validateMarketplaceConfig(config);
    expect(errors).toContain('requiredFields cannot be empty');
  });

  it('reports maxConcurrentRequests <= 0', () => {
    const config = makeValidConfig();
    config.compliance.maxConcurrentRequests = 0;
    const errors = validateMarketplaceConfig(config);
    expect(errors).toContain('maxConcurrentRequests must be > 0');
  });

  it('reports negative crawlDelay', () => {
    const config = makeValidConfig();
    config.compliance.crawlDelay = -100;
    const errors = validateMarketplaceConfig(config);
    expect(errors).toContain('crawlDelay must be >= 0');
  });

  it('allows crawlDelay of 0', () => {
    const config = makeValidConfig();
    config.compliance.crawlDelay = 0;
    const errors = validateMarketplaceConfig(config);
    expect(errors).not.toContain('crawlDelay must be >= 0');
  });

  it('reports multiple errors simultaneously', () => {
    const config = makeValidConfig();
    config.rateLimit.requestsPerSecond = 0;
    config.rateLimit.requestsPerMinute = 0;
    config.rateLimit.requestsPerHour = 0;
    config.quality.requiredFields = [];
    config.compliance.maxConcurrentRequests = 0;

    const errors = validateMarketplaceConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(5);
  });
});

describe('exportMarketplaceConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports registry configs to YAML file', async () => {
    const config = makeValidConfig();
    mockYamlStringify.mockReturnValue('yaml: output');
    mockWriteFile.mockResolvedValue(undefined);

    const mockRegistry = {
      getRegisteredMarketplaces: vi.fn().mockReturnValue(['ebay']),
      getConfig: vi.fn().mockReturnValue(config),
    };

    await exportMarketplaceConfig(mockRegistry as unknown, '/output.yaml');

    expect(mockYamlStringify).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).toHaveBeenCalledWith('/output.yaml', 'yaml: output', 'utf-8');
  });

  it('excludes marketplaceId from exported config', async () => {
    const config = makeValidConfig();
    mockYamlStringify.mockReturnValue('yaml: output');
    mockWriteFile.mockResolvedValue(undefined);

    const mockRegistry = {
      getRegisteredMarketplaces: vi.fn().mockReturnValue(['ebay']),
      getConfig: vi.fn().mockReturnValue(config),
    };

    await exportMarketplaceConfig(mockRegistry as unknown, '/output.yaml');

    const callArg = mockYamlStringify.mock.calls[0][0];
    // The exported object should not include marketplaceId in the value
    const ebayExport = callArg.marketplaces.ebay;
    expect(ebayExport.marketplaceId).toBeUndefined();
  });

  it('handles missing config for a marketplace', async () => {
    mockYamlStringify.mockReturnValue('yaml: output');
    mockWriteFile.mockResolvedValue(undefined);

    const mockRegistry = {
      getRegisteredMarketplaces: vi.fn().mockReturnValue(['ebay']),
      getConfig: vi.fn().mockReturnValue(null),
    };

    await exportMarketplaceConfig(mockRegistry as unknown, '/output.yaml');

    const callArg = mockYamlStringify.mock.calls[0][0];
    expect(callArg.marketplaces.ebay).toBeUndefined();
  });
});
