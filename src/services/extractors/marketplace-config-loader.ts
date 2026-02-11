/**
 * Marketplace Configuration Loader
 *
 * Loads marketplace adapter configurations from YAML files and
 * initializes the marketplace registry.
 *
 * @module marketplace-config-loader
 */

import { readFile, writeFile } from 'fs/promises';
import yaml from 'yaml';
import { logger } from '../../utils/logger';
import { MarketplaceConfig, MarketplaceType } from './marketplace-adapter';
import { MarketplaceRegistry } from './marketplace-registry';
import { ebayAdapterV2 } from './ebay-adapter-v2';
import { amazonAdapter } from './amazon-adapter';
import { walmartAdapter } from './walmart-adapter';

/**
 * Configuration file schema
 */
interface MarketplaceConfigFile {
  marketplaces: {
    [key: string]: Omit<MarketplaceConfig, 'marketplaceId'>;
  };
  featureFlags?: {
    extraction_events_enabled?: boolean;
    extraction_events_persist_to_disk?: boolean;
    nightly_validation_enabled?: boolean;
    backfill_jobs_enabled?: boolean;
  };
}

/**
 * Load marketplace configurations from YAML file
 */
export async function loadMarketplaceConfigs(
  configPath: string
): Promise<Map<MarketplaceType, MarketplaceConfig>> {
  logger.info('Loading marketplace configurations', { configPath });

  try {
    const fileContent = await readFile(configPath, 'utf-8');
    const configFile = yaml.parse(fileContent) as MarketplaceConfigFile;

    const configs = new Map<MarketplaceType, MarketplaceConfig>();

    for (const [marketplaceId, configData] of Object.entries(configFile.marketplaces)) {
      const config: MarketplaceConfig = {
        marketplaceId: marketplaceId as MarketplaceType,
        ...configData,
      };

      configs.set(marketplaceId as MarketplaceType, config);
      logger.debug('Loaded config for marketplace', {
        marketplace: marketplaceId,
        enabled: config.enabled,
      });
    }

    logger.info('Marketplace configurations loaded', {
      count: configs.size,
      marketplaces: Array.from(configs.keys()),
    });

    return configs;
  } catch (error) {
    logger.error('Failed to load marketplace configurations', {
      configPath,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(`Failed to load marketplace configs: ${error}`);
  }
}

/**
 * Initialize marketplace registry with configs and adapters
 */
export async function initializeMarketplaceRegistry(
  registry: MarketplaceRegistry,
  configPath: string
): Promise<void> {
  logger.info('Initializing marketplace registry', { configPath });

  // Load configurations
  const configs = await loadMarketplaceConfigs(configPath);

  // Register adapters with their configs
  const adapters = [ebayAdapterV2, amazonAdapter, walmartAdapter];

  for (const adapter of adapters) {
    const config = configs.get(adapter.marketplaceId);

    if (config) {
      registry.register(adapter, config);
      logger.info('Registered marketplace adapter', {
        marketplace: adapter.marketplaceId,
        name: adapter.name,
        version: adapter.version,
        enabled: config.enabled,
      });
    } else {
      // Use adapter's default config
      const defaultConfig = adapter.getConfig();
      registry.register(adapter, defaultConfig);
      logger.warn('No config found for adapter, using defaults', {
        marketplace: adapter.marketplaceId,
      });
    }
  }

  logger.info('Marketplace registry initialized', {
    totalAdapters: registry.getRegisteredMarketplaces().length,
    enabledMarketplaces: registry
      .getRegisteredMarketplaces()
      .filter((mp) => registry.isEnabled(mp)),
  });
}

/**
 * Load feature flags from config file
 */
export async function loadFeatureFlags(
  configPath: string
): Promise<Map<string, boolean>> {
  logger.info('Loading feature flags', { configPath });

  try {
    const fileContent = await readFile(configPath, 'utf-8');
    const configFile = yaml.parse(fileContent) as MarketplaceConfigFile;

    const flags = new Map<string, boolean>();

    if (configFile.featureFlags) {
      for (const [key, value] of Object.entries(configFile.featureFlags)) {
        flags.set(key, value ?? false);
      }
    }

    logger.info('Feature flags loaded', {
      count: flags.size,
      flags: Object.fromEntries(flags),
    });

    return flags;
  } catch (error) {
    logger.warn('Failed to load feature flags, using defaults', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

/**
 * Hot-reload marketplace configuration
 */
export async function reloadMarketplaceConfig(
  registry: MarketplaceRegistry,
  configPath: string,
  marketplaceId: MarketplaceType
): Promise<void> {
  logger.info('Reloading marketplace configuration', {
    configPath,
    marketplace: marketplaceId,
  });

  const configs = await loadMarketplaceConfigs(configPath);
  const config = configs.get(marketplaceId);

  if (!config) {
    throw new Error(`No config found for marketplace: ${marketplaceId}`);
  }

  registry.updateConfig(marketplaceId, config);

  logger.info('Marketplace configuration reloaded', {
    marketplace: marketplaceId,
    enabled: config.enabled,
  });
}

/**
 * Validate marketplace configuration
 */
export function validateMarketplaceConfig(config: MarketplaceConfig): string[] {
  const errors: string[] = [];

  // Validate rate limits
  if (config.rateLimit.requestsPerSecond <= 0) {
    errors.push('requestsPerSecond must be > 0');
  }

  if (config.rateLimit.requestsPerMinute <= 0) {
    errors.push('requestsPerMinute must be > 0');
  }

  if (config.rateLimit.requestsPerHour <= 0) {
    errors.push('requestsPerHour must be > 0');
  }

  // Validate consistency
  if (config.rateLimit.requestsPerSecond * 60 > config.rateLimit.requestsPerMinute) {
    errors.push('requestsPerSecond * 60 exceeds requestsPerMinute');
  }

  if (config.rateLimit.requestsPerMinute * 60 > config.rateLimit.requestsPerHour) {
    errors.push('requestsPerMinute * 60 exceeds requestsPerHour');
  }

  // Validate quality thresholds
  if (config.quality.minConfidenceScore < 0 || config.quality.minConfidenceScore > 1) {
    errors.push('minConfidenceScore must be between 0 and 1');
  }

  if (config.quality.requiredFields.length === 0) {
    errors.push('requiredFields cannot be empty');
  }

  // Validate compliance
  if (config.compliance.maxConcurrentRequests <= 0) {
    errors.push('maxConcurrentRequests must be > 0');
  }

  if (config.compliance.crawlDelay && config.compliance.crawlDelay < 0) {
    errors.push('crawlDelay must be >= 0');
  }

  return errors;
}

/**
 * Export configuration to YAML
 */
export async function exportMarketplaceConfig(
  registry: MarketplaceRegistry,
  outputPath: string
): Promise<void> {
  logger.info('Exporting marketplace configurations', { outputPath });

  const marketplaces = registry.getRegisteredMarketplaces();
  const configData: MarketplaceConfigFile = {
    marketplaces: {},
  };

  for (const marketplaceId of marketplaces) {
    const config = registry.getConfig(marketplaceId);
    if (config) {
      const { marketplaceId: _marketplaceId, ...configWithoutId } = config;
      configData.marketplaces[marketplaceId] = configWithoutId;
    }
  }

  const yamlContent = yaml.stringify(configData);
  await writeFile(outputPath, yamlContent, 'utf-8');

  logger.info('Marketplace configurations exported', {
    outputPath,
    count: marketplaces.length,
  });
}
