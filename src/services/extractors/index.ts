/**
 * Marketplace Adapter System - Main Export
 *
 * Central integration point for the marketplace adapter system.
 * Provides a unified API for marketplace extraction, event streaming,
 * and backfill job management.
 *
 * @module services/extractors
 * @see docs/specs/MARKETPLACE_ADAPTER_RFC.md
 */

// Core types and interfaces
export * from './marketplace-adapter';

// Adapters (Tier 3: Scraping)
export { EbayAdapterV2, ebayAdapterV2 } from './ebay-adapter-v2';
export { AmazonAdapter, amazonAdapter } from './amazon-adapter';
export { WalmartAdapter, walmartAdapter } from './walmart-adapter';

// Data Source Adapters (Multi-Channel Architecture)
// Tier 2: User-Consented Data
export {
  AmazonDataExportAdapter,
  amazonDataExportAdapter,
} from './amazon-data-export-adapter';
export {
  EbayDataExportAdapter,
  ebayDataExportAdapter,
} from './ebay-data-export-adapter';
export {
  BrowserExtensionAdapter,
  createBrowserExtensionAdapter,
  createIsolatedBrowserExtensionAdapter,
  getBrowserExtensionAdapter,
} from './browser-extension-adapter';
export {
  EmailParsingAdapter,
  emailParsingAdapter,
  createEmailAdapter,
} from './email-parsing-adapter';

// Tier 4: AI-Assisted Extraction
export {
  LLMExtractionAdapter,
  createClaudeAdapter,
  createOpenAIAdapter,
  createOllamaAdapter,
} from './llm-extraction-adapter';

// Data Source Orchestrator
export {
  DataSourceOrchestratorImpl,
  getOrchestrator,
  createOrchestrator,
} from './data-source-orchestrator';

// Registry
export { MarketplaceRegistry, marketplaceRegistry } from './marketplace-registry';

// Event pipeline
export {
  DefaultExtractionEventPipeline,
  extractionEventPipeline,
  createExtractionEvent,
  ExtractionAnalytics,
} from './extraction-event-pipeline';

// Configuration
export {
  loadMarketplaceConfigs,
  initializeMarketplaceRegistry,
  loadFeatureFlags,
  reloadMarketplaceConfig,
  validateMarketplaceConfig,
  exportMarketplaceConfig,
} from './marketplace-config-loader';

// Backfill
export {
  BackfillExecutor,
  createBackfillJob,
} from './backfill-executor';

// Feature flags
export {
  FeatureFlagManager,
  featureFlags,
  MARKETPLACE_FLAGS,
  DEFAULT_FLAGS,
} from './feature-flags';

// Rate limiting
export { RateLimiter } from '../../core/marketplace-rate-limiter';

/**
 * Initialize the complete marketplace adapter system
 */
export async function initializeMarketplaceSystem(configPath: string): Promise<{
  registry: typeof marketplaceRegistry;
  pipeline: typeof extractionEventPipeline;
  analytics: InstanceType<typeof ExtractionAnalytics>;
  backfillExecutor: InstanceType<typeof BackfillExecutor>;
}> {
  const { marketplaceRegistry } = await import('./marketplace-registry');
  const { extractionEventPipeline } = await import('./extraction-event-pipeline');
  const { ExtractionAnalytics } = await import('./extraction-event-pipeline');
  const { BackfillExecutor } = await import('./backfill-executor');
  const { initializeMarketplaceRegistry, loadFeatureFlags } = await import('./marketplace-config-loader');
  const { featureFlags } = await import('./feature-flags');

  // Load feature flags
  const flagsMap = await loadFeatureFlags(configPath);
  featureFlags.loadFlags(Object.fromEntries(flagsMap));

  // Initialize registry with configs
  await initializeMarketplaceRegistry(marketplaceRegistry, configPath);

  // Initialize analytics
  const analytics = new ExtractionAnalytics();
  analytics.subscribe(extractionEventPipeline);

  // Initialize backfill executor
  const backfillExecutor = new BackfillExecutor(marketplaceRegistry);

  return {
    registry: marketplaceRegistry,
    pipeline: extractionEventPipeline,
    analytics,
    backfillExecutor,
  };
}
