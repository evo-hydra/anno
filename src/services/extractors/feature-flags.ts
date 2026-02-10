/**
 * Feature Flag System
 *
 * Manages feature flags for marketplace rollout control.
 * Supports runtime updates and percentage-based gradual rollouts.
 *
 * @module feature-flags
 */

import { logger } from '../../utils/logger';

/**
 * Feature flag configuration
 */
export interface FeatureFlag {
  enabled: boolean;
  rolloutPercentage?: number; // 0-100, for gradual rollouts
  description?: string;
}

/**
 * Feature flag manager
 */
export class FeatureFlagManager {
  private flags: Map<string, FeatureFlag>;

  constructor(initialFlags?: Record<string, boolean | FeatureFlag>) {
    this.flags = new Map();

    if (initialFlags) {
      for (const [key, value] of Object.entries(initialFlags)) {
        if (typeof value === 'boolean') {
          this.flags.set(key, { enabled: value });
        } else {
          this.flags.set(key, value);
        }
      }
    }

    logger.info('FeatureFlagManager initialized', {
      flagCount: this.flags.size,
    });
  }

  /**
   * Check if a feature is enabled
   * @param flagName - Feature flag name
   * @param userId - Optional user/session ID for percentage-based rollouts
   */
  isEnabled(flagName: string, userId?: string): boolean {
    const flag = this.flags.get(flagName);

    if (!flag) {
      logger.debug('Feature flag not found, defaulting to false', { flagName });
      return false;
    }

    if (!flag.enabled) {
      return false;
    }

    // If rollout percentage is set, use consistent hashing for gradual rollout
    if (flag.rolloutPercentage !== undefined && userId) {
      const userHash = this.hashUserId(userId);
      const isInRollout = userHash % 100 < flag.rolloutPercentage;
      logger.debug('Feature flag check with rollout', {
        flagName,
        userId,
        rolloutPercentage: flag.rolloutPercentage,
        isInRollout,
      });
      return isInRollout;
    }

    return true;
  }

  /**
   * Set a feature flag
   */
  setFlag(flagName: string, flag: FeatureFlag): void {
    this.flags.set(flagName, flag);
    logger.info('Feature flag updated', {
      flagName,
      enabled: flag.enabled,
      rolloutPercentage: flag.rolloutPercentage,
    });
  }

  /**
   * Enable a feature flag
   */
  enable(flagName: string): void {
    const flag = this.flags.get(flagName) || { enabled: false };
    this.setFlag(flagName, { ...flag, enabled: true });
  }

  /**
   * Disable a feature flag
   */
  disable(flagName: string): void {
    const flag = this.flags.get(flagName) || { enabled: false };
    this.setFlag(flagName, { ...flag, enabled: false });
  }

  /**
   * Set rollout percentage for gradual rollout
   */
  setRolloutPercentage(flagName: string, percentage: number): void {
    if (percentage < 0 || percentage > 100) {
      throw new Error('Rollout percentage must be between 0 and 100');
    }

    const flag = this.flags.get(flagName) || { enabled: true };
    this.setFlag(flagName, { ...flag, rolloutPercentage: percentage });
  }

  /**
   * Get all feature flags
   */
  getAllFlags(): Record<string, FeatureFlag> {
    return Object.fromEntries(this.flags);
  }

  /**
   * Get a specific flag
   */
  getFlag(flagName: string): FeatureFlag | null {
    return this.flags.get(flagName) || null;
  }

  /**
   * Load flags from object
   */
  loadFlags(flags: Record<string, boolean | FeatureFlag>): void {
    for (const [key, value] of Object.entries(flags)) {
      if (typeof value === 'boolean') {
        this.setFlag(key, { enabled: value });
      } else {
        this.setFlag(key, value);
      }
    }

    logger.info('Feature flags loaded', { count: Object.keys(flags).length });
  }

  /**
   * Hash user ID for consistent rollout
   */
  private hashUserId(userId: string): number {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      const char = userId.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
}

/**
 * Predefined marketplace feature flags
 */
export const MARKETPLACE_FLAGS = {
  // Marketplace enablement
  MARKETPLACE_EBAY_ENABLED: 'marketplace.ebay.enabled',
  MARKETPLACE_AMAZON_ENABLED: 'marketplace.amazon.enabled',
  MARKETPLACE_WALMART_ENABLED: 'marketplace.walmart.enabled',
  MARKETPLACE_ETSY_ENABLED: 'marketplace.etsy.enabled',

  // Feature-specific flags
  EXTRACTION_EVENTS_ENABLED: 'extraction.events.enabled',
  EXTRACTION_EVENTS_PERSIST: 'extraction.events.persist_to_disk',
  BACKFILL_JOBS_ENABLED: 'backfill.jobs.enabled',
  NIGHTLY_VALIDATION_ENABLED: 'validation.nightly.enabled',

  // Rendering flags
  AMAZON_RENDERING_ENABLED: 'marketplace.amazon.rendering',
  WALMART_RENDERING_ENABLED: 'marketplace.walmart.rendering',

  // Advanced features
  AMAZON_EXTRACT_DESCRIPTIONS: 'marketplace.amazon.extract_descriptions',
  AMAZON_EXTRACT_REVIEWS: 'marketplace.amazon.extract_reviews',
  AMAZON_EXTRACT_VARIANTS: 'marketplace.amazon.extract_variants',
} as const;

/**
 * Default feature flag configuration
 */
export const DEFAULT_FLAGS: Record<string, FeatureFlag> = {
  [MARKETPLACE_FLAGS.MARKETPLACE_EBAY_ENABLED]: {
    enabled: true,
    description: 'Enable eBay marketplace adapter',
  },
  [MARKETPLACE_FLAGS.MARKETPLACE_AMAZON_ENABLED]: {
    enabled: false,
    rolloutPercentage: 0,
    description: 'Enable Amazon marketplace adapter (dark launch)',
  },
  [MARKETPLACE_FLAGS.MARKETPLACE_WALMART_ENABLED]: {
    enabled: false,
    description: 'Enable Walmart marketplace adapter',
  },
  [MARKETPLACE_FLAGS.MARKETPLACE_ETSY_ENABLED]: {
    enabled: false,
    description: 'Enable Etsy marketplace adapter',
  },
  [MARKETPLACE_FLAGS.EXTRACTION_EVENTS_ENABLED]: {
    enabled: true,
    description: 'Enable extraction event pipeline',
  },
  [MARKETPLACE_FLAGS.EXTRACTION_EVENTS_PERSIST]: {
    enabled: false,
    description: 'Persist extraction events to disk',
  },
  [MARKETPLACE_FLAGS.BACKFILL_JOBS_ENABLED]: {
    enabled: false,
    description: 'Enable backfill job execution',
  },
  [MARKETPLACE_FLAGS.NIGHTLY_VALIDATION_ENABLED]: {
    enabled: false,
    description: 'Enable nightly validation jobs',
  },
  [MARKETPLACE_FLAGS.AMAZON_RENDERING_ENABLED]: {
    enabled: true,
    description: 'Enable JavaScript rendering for Amazon',
  },
  [MARKETPLACE_FLAGS.WALMART_RENDERING_ENABLED]: {
    enabled: true,
    description: 'Enable JavaScript rendering for Walmart',
  },
  [MARKETPLACE_FLAGS.AMAZON_EXTRACT_DESCRIPTIONS]: {
    enabled: false,
    description: 'Extract product descriptions from Amazon',
  },
  [MARKETPLACE_FLAGS.AMAZON_EXTRACT_REVIEWS]: {
    enabled: false,
    description: 'Extract product reviews from Amazon',
  },
  [MARKETPLACE_FLAGS.AMAZON_EXTRACT_VARIANTS]: {
    enabled: false,
    description: 'Extract product variants from Amazon',
  },
};

/**
 * Global feature flag manager instance
 */
export const featureFlags = new FeatureFlagManager(DEFAULT_FLAGS);
