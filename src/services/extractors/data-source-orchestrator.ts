/**
 * DataSourceOrchestrator Implementation
 *
 * Orchestrates fallback between multiple data sources for marketplace data.
 * Provides unified access to data regardless of source, with automatic
 * fallback chains, conflict resolution, and health monitoring.
 *
 * @module extractors/data-source-orchestrator
 * @see docs/specs/FUTURE_PROOF_DATA_ARCHITECTURE.md
 */

import { logger } from '../../utils/logger';
import {
  DataSourceOrchestrator,
  DataSourceAdapter,
  DataSourceChannel,
  DataSourceTier,
  DataSourceHealth,
  DataProvenance,
  MarketplaceType,
  MarketplaceListing,
  MarketplaceListingWithProvenance,
  OrchestratorGetOptions,
  OrchestratorResult,
  MultiSourceResult,
} from './marketplace-adapter';

// ============================================================================
// Types
// ============================================================================

interface RegisteredAdapter {
  adapter: DataSourceAdapter;
  marketplace: MarketplaceType;
  channel: DataSourceChannel;
  tier: DataSourceTier;
  enabled: boolean;
  lastHealth?: DataSourceHealth;
  lastHealthCheck?: string;
}

interface ConflictResolution {
  field: keyof MarketplaceListing;
  values: Array<{ source: DataProvenance; value: unknown }>;
  resolvedValue?: unknown;
  resolutionMethod?: 'highest_tier' | 'majority' | 'most_recent' | 'manual';
}

// ============================================================================
// DataSourceOrchestrator Implementation
// ============================================================================

export class DataSourceOrchestratorImpl implements DataSourceOrchestrator {
  private adapters: Map<MarketplaceType, Map<DataSourceChannel, RegisteredAdapter>> = new Map();
  private fallbackChains: Map<MarketplaceType, DataSourceChannel[]> = new Map();
  private healthCheckInterval = 5 * 60 * 1000; // 5 minutes

  // =========================================================================
  // Adapter Registration
  // =========================================================================

  registerAdapter(marketplace: MarketplaceType, adapter: DataSourceAdapter): void {
    if (!this.adapters.has(marketplace)) {
      this.adapters.set(marketplace, new Map());
    }

    const marketplaceAdapters = this.adapters.get(marketplace)!;
    const existing = marketplaceAdapters.get(adapter.channel);

    if (existing) {
      logger.warn('Replacing existing adapter', {
        marketplace,
        channel: adapter.channel,
        oldVersion: existing.adapter.version,
        newVersion: adapter.version,
      });
    }

    marketplaceAdapters.set(adapter.channel, {
      adapter,
      marketplace,
      channel: adapter.channel,
      tier: adapter.tier,
      enabled: true,
    });

    logger.info('Registered data source adapter', {
      marketplace,
      channel: adapter.channel,
      tier: adapter.tier,
      name: adapter.name,
      version: adapter.version,
    });
  }

  unregisterAdapter(marketplace: MarketplaceType, channel: DataSourceChannel): void {
    const marketplaceAdapters = this.adapters.get(marketplace);
    if (marketplaceAdapters) {
      const removed = marketplaceAdapters.delete(channel);
      if (removed) {
        logger.info('Unregistered data source adapter', { marketplace, channel });
      }
    }
  }

  // =========================================================================
  // Fallback Chain Configuration
  // =========================================================================

  setFallbackChain(marketplace: MarketplaceType, chain: DataSourceChannel[]): void {
    this.fallbackChains.set(marketplace, chain);
    logger.info('Set fallback chain', { marketplace, chain });
  }

  getFallbackChain(marketplace: MarketplaceType): DataSourceChannel[] {
    // Return custom chain if set
    const customChain = this.fallbackChains.get(marketplace);
    if (customChain) {
      return customChain;
    }

    // Otherwise, build default chain from registered adapters sorted by tier
    const marketplaceAdapters = this.adapters.get(marketplace);
    if (!marketplaceAdapters) {
      return [];
    }

    return Array.from(marketplaceAdapters.values())
      .filter(a => a.enabled)
      .sort((a, b) => a.tier - b.tier)
      .map(a => a.channel);
  }

  // =========================================================================
  // Single Source with Fallback
  // =========================================================================

  async getData(
    marketplace: MarketplaceType,
    identifier: string,
    options: OrchestratorGetOptions = {}
  ): Promise<OrchestratorResult> {
    const startTime = Date.now();
    const attemptedSources: OrchestratorResult['attemptedSources'] = [];

    const {
      preferredTiers = [1, 2, 3, 4],
      requiredConfidence = 0.5,
      allowFallback = true,
      timeout = 30000,
      includeChannels,
      excludeChannels = [],
    } = options;

    // Get ordered list of adapters to try
    const adaptersToTry = this.getOrderedAdapters(
      marketplace,
      preferredTiers,
      includeChannels,
      excludeChannels
    );

    if (adaptersToTry.length === 0) {
      logger.warn('No adapters available for marketplace', { marketplace });
      return {
        data: null,
        attemptedSources: [],
        fallbackUsed: false,
        totalDuration: Date.now() - startTime,
      };
    }

    let fallbackUsed = false;
    let firstAttemptTier: DataSourceTier | null = null;

    for (const registered of adaptersToTry) {
      const { adapter, channel, tier } = registered;
      const attemptStart = Date.now();

      // Check timeout
      if (Date.now() - startTime > timeout) {
        logger.warn('Orchestrator timeout reached', {
          marketplace,
          identifier,
          attemptedCount: attemptedSources.length,
        });
        break;
      }

      // Track if we're using a fallback
      if (firstAttemptTier === null) {
        firstAttemptTier = tier;
      } else if (tier > firstAttemptTier) {
        fallbackUsed = true;
      }

      try {
        // Check if adapter is available
        const available = await adapter.isAvailable();
        if (!available) {
          attemptedSources.push({
            channel,
            tier,
            success: false,
            error: 'Adapter not available',
            duration: Date.now() - attemptStart,
          });
          continue;
        }

        // Attempt extraction
        const result = await adapter.extractWithProvenance(identifier, identifier, {
          timeout: Math.max(1000, timeout - (Date.now() - startTime)),
        });

        if (result && result.confidence >= requiredConfidence) {
          attemptedSources.push({
            channel,
            tier,
            success: true,
            duration: Date.now() - attemptStart,
          });

          logger.info('Orchestrator extraction successful', {
            marketplace,
            identifier,
            channel,
            tier,
            confidence: result.confidence,
            fallbackUsed,
          });

          return {
            data: result,
            attemptedSources,
            fallbackUsed,
            totalDuration: Date.now() - startTime,
          };
        }

        // Result didn't meet confidence threshold
        attemptedSources.push({
          channel,
          tier,
          success: false,
          error: result
            ? `Confidence ${result.confidence} below threshold ${requiredConfidence}`
            : 'Extraction returned null',
          duration: Date.now() - attemptStart,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        attemptedSources.push({
          channel,
          tier,
          success: false,
          error: errorMessage,
          duration: Date.now() - attemptStart,
        });

        logger.warn('Orchestrator extraction failed', {
          marketplace,
          identifier,
          channel,
          tier,
          error: errorMessage,
        });
      }

      // If fallback is disabled, stop after first attempt
      if (!allowFallback) {
        break;
      }
    }

    // All sources failed
    logger.warn('Orchestrator exhausted all sources', {
      marketplace,
      identifier,
      attemptedCount: attemptedSources.length,
    });

    return {
      data: null,
      attemptedSources,
      fallbackUsed,
      totalDuration: Date.now() - startTime,
    };
  }

  // =========================================================================
  // Multi-Source with Conflict Resolution
  // =========================================================================

  async getFromAllSources(
    marketplace: MarketplaceType,
    identifier: string,
    options: OrchestratorGetOptions = {}
  ): Promise<MultiSourceResult> {
    const {
      preferredTiers = [1, 2, 3, 4],
      timeout = 60000,
      includeChannels,
      excludeChannels = [],
    } = options;

    const adaptersToTry = this.getOrderedAdapters(
      marketplace,
      preferredTiers,
      includeChannels,
      excludeChannels
    );

    const sources: MultiSourceResult['sources'] = [];
    const startTime = Date.now();

    // Execute all adapters in parallel
    const promises = adaptersToTry.map(async registered => {
      const { adapter, channel, tier } = registered;

      try {
        const available = await adapter.isAvailable();
        if (!available) {
          return null;
        }

        const result = await adapter.extractWithProvenance(identifier, identifier, {
          timeout: Math.max(1000, timeout - (Date.now() - startTime)),
        });

        if (result) {
          return {
            channel,
            tier,
            provenance: result.provenance,
            listing: result as MarketplaceListing,
          };
        }
      } catch (error) {
        logger.warn('Multi-source extraction failed', {
          marketplace,
          channel,
          error: error instanceof Error ? error.message : 'Unknown',
        });
      }

      return null;
    });

    const results = await Promise.all(promises);

    // Collect successful results
    for (const result of results) {
      if (result) {
        sources.push({
          provenance: result.provenance,
          listing: result.listing,
        });
      }
    }

    if (sources.length === 0) {
      return {
        mergedData: null,
        sources: [],
        conflicts: [],
      };
    }

    // Merge data and detect conflicts
    const { mergedData, conflicts } = this.mergeListings(sources);

    logger.info('Multi-source extraction complete', {
      marketplace,
      identifier,
      sourceCount: sources.length,
      conflictCount: conflicts.length,
    });

    return {
      mergedData,
      sources,
      conflicts,
    };
  }

  // =========================================================================
  // Health Monitoring
  // =========================================================================

  async getHealthReport(): Promise<Map<MarketplaceType, Map<DataSourceChannel, DataSourceHealth>>> {
    const report = new Map<MarketplaceType, Map<DataSourceChannel, DataSourceHealth>>();

    for (const [marketplace, adaptersMap] of this.adapters) {
      const marketplaceHealth = new Map<DataSourceChannel, DataSourceHealth>();

      for (const [channel, registered] of adaptersMap) {
        try {
          const health = await registered.adapter.getHealth();
          marketplaceHealth.set(channel, health);

          // Cache health for quick lookups
          registered.lastHealth = health;
          registered.lastHealthCheck = new Date().toISOString();
        } catch (error) {
          marketplaceHealth.set(channel, {
            available: false,
            recentFailureRate: 1.0,
            estimatedReliability: 0,
            statusMessage: `Health check failed: ${error instanceof Error ? error.message : 'Unknown'}`,
          });
        }
      }

      report.set(marketplace, marketplaceHealth);
    }

    return report;
  }

  getAvailableAdapters(
    marketplace: MarketplaceType
  ): Array<{ channel: DataSourceChannel; tier: DataSourceTier; available: boolean }> {
    const marketplaceAdapters = this.adapters.get(marketplace);
    if (!marketplaceAdapters) {
      return [];
    }

    return Array.from(marketplaceAdapters.values()).map(registered => ({
      channel: registered.channel,
      tier: registered.tier,
      available: registered.enabled && (registered.lastHealth?.available ?? true),
    }));
  }

  // =========================================================================
  // Enable/Disable Adapters
  // =========================================================================

  enableAdapter(marketplace: MarketplaceType, channel: DataSourceChannel): void {
    const registered = this.getRegisteredAdapter(marketplace, channel);
    if (registered) {
      registered.enabled = true;
      logger.info('Enabled adapter', { marketplace, channel });
    }
  }

  disableAdapter(marketplace: MarketplaceType, channel: DataSourceChannel): void {
    const registered = this.getRegisteredAdapter(marketplace, channel);
    if (registered) {
      registered.enabled = false;
      logger.info('Disabled adapter', { marketplace, channel });
    }
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private getRegisteredAdapter(
    marketplace: MarketplaceType,
    channel: DataSourceChannel
  ): RegisteredAdapter | undefined {
    return this.adapters.get(marketplace)?.get(channel);
  }

  private getOrderedAdapters(
    marketplace: MarketplaceType,
    preferredTiers: DataSourceTier[],
    includeChannels?: DataSourceChannel[],
    excludeChannels: DataSourceChannel[] = []
  ): RegisteredAdapter[] {
    const marketplaceAdapters = this.adapters.get(marketplace);
    if (!marketplaceAdapters) {
      return [];
    }

    // Check for custom fallback chain
    const customChain = this.fallbackChains.get(marketplace);
    if (customChain) {
      return customChain
        .filter(channel => !excludeChannels.includes(channel))
        .filter(channel => !includeChannels || includeChannels.includes(channel))
        .map(channel => marketplaceAdapters.get(channel))
        .filter((a): a is RegisteredAdapter => a !== undefined && a.enabled);
    }

    // Default: sort by tier, then by channel confidence
    return Array.from(marketplaceAdapters.values())
      .filter(a => a.enabled)
      .filter(a => !excludeChannels.includes(a.channel))
      .filter(a => !includeChannels || includeChannels.includes(a.channel))
      .filter(a => preferredTiers.includes(a.tier))
      .sort((a, b) => {
        // Primary sort by tier
        if (a.tier !== b.tier) {
          return a.tier - b.tier;
        }
        // Secondary sort by health/reliability
        const aReliability = a.lastHealth?.estimatedReliability ?? a.adapter.confidenceRange.max;
        const bReliability = b.lastHealth?.estimatedReliability ?? b.adapter.confidenceRange.max;
        return bReliability - aReliability;
      });
  }

  private mergeListings(
    sources: Array<{ provenance: DataProvenance; listing: MarketplaceListing }>
  ): { mergedData: MarketplaceListingWithProvenance; conflicts: ConflictResolution[] } {
    const conflicts: ConflictResolution[] = [];

    // Sort sources by tier (lower is better)
    const sortedSources = [...sources].sort((a, b) => a.provenance.tier - b.provenance.tier);
    const primarySource = sortedSources[0];

    // Start with primary source as base
    const mergedData: MarketplaceListingWithProvenance = {
      ...primarySource.listing,
      provenance: primarySource.provenance,
      correlatedSources: sources.length > 1 ? sources.map(s => s.provenance) : undefined,
    };

    // Fields to check for conflicts
    const fieldsToCheck: (keyof MarketplaceListing)[] = [
      'title',
      'price',
      'condition',
      'availability',
      'soldDate',
    ];

    for (const field of fieldsToCheck) {
      const values = sources
        .filter(s => s.listing[field] !== undefined && s.listing[field] !== null)
        .map(s => ({
          source: s.provenance,
          value: s.listing[field],
        }));

      if (values.length > 1) {
        // Check if values differ
        const uniqueValues = new Set(values.map(v => JSON.stringify(v.value)));
        if (uniqueValues.size > 1) {
          // Resolve conflict: prefer highest tier (lowest number)
          const resolved = values.sort((a, b) => a.source.tier - b.source.tier)[0];

          conflicts.push({
            field,
            values,
            resolvedValue: resolved.value,
            resolutionMethod: 'highest_tier',
          });

          // Apply resolution
          (mergedData as unknown as Record<string, unknown>)[field] = resolved.value;
        }
      }
    }

    // Calculate merged confidence (boost for multiple agreeing sources)
    const baseConfidence = primarySource.provenance.confidence;
    const agreementBoost = Math.min(0.1, (sources.length - 1) * 0.03);
    mergedData.confidence = Math.min(1.0, baseConfidence + agreementBoost);

    // Track conflicts in the listing
    if (conflicts.length > 0) {
      mergedData.conflictingData = conflicts.map(c => ({
        field: c.field,
        values: c.values,
      }));
    }

    return { mergedData, conflicts };
  }
}

// ============================================================================
// Factory & Singleton
// ============================================================================

let orchestratorInstance: DataSourceOrchestratorImpl | null = null;

/**
 * Get the singleton orchestrator instance
 */
export function getOrchestrator(): DataSourceOrchestratorImpl {
  if (!orchestratorInstance) {
    orchestratorInstance = new DataSourceOrchestratorImpl();
  }
  return orchestratorInstance;
}

/**
 * Create a new orchestrator instance (useful for testing)
 */
export function createOrchestrator(): DataSourceOrchestratorImpl {
  return new DataSourceOrchestratorImpl();
}

