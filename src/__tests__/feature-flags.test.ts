import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  FeatureFlagManager,
  MARKETPLACE_FLAGS,
  DEFAULT_FLAGS,
  featureFlags,
} from '../services/extractors/feature-flags';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeatureFlagManager', () => {
  let manager: FeatureFlagManager;

  beforeEach(() => {
    manager = new FeatureFlagManager();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('initializes with no flags', () => {
      const flags = manager.getAllFlags();
      expect(Object.keys(flags)).toHaveLength(0);
    });

    it('initializes with boolean flags', () => {
      const m = new FeatureFlagManager({
        'feature.a': true,
        'feature.b': false,
      });

      expect(m.isEnabled('feature.a')).toBe(true);
      expect(m.isEnabled('feature.b')).toBe(false);
    });

    it('initializes with FeatureFlag objects', () => {
      const m = new FeatureFlagManager({
        'feature.c': { enabled: true, rolloutPercentage: 50, description: 'Half rollout' },
      });

      const flag = m.getFlag('feature.c');
      expect(flag).not.toBeNull();
      expect(flag!.enabled).toBe(true);
      expect(flag!.rolloutPercentage).toBe(50);
      expect(flag!.description).toBe('Half rollout');
    });

    it('handles mixed boolean and object flags', () => {
      const m = new FeatureFlagManager({
        'flag.bool': true,
        'flag.obj': { enabled: false, description: 'disabled' },
      });

      expect(m.isEnabled('flag.bool')).toBe(true);
      expect(m.isEnabled('flag.obj')).toBe(false);
    });
  });

  // =========================================================================
  // isEnabled
  // =========================================================================

  describe('isEnabled', () => {
    it('returns false for unknown flag', () => {
      expect(manager.isEnabled('nonexistent.flag')).toBe(false);
    });

    it('returns true when flag is enabled', () => {
      manager.setFlag('my.flag', { enabled: true });
      expect(manager.isEnabled('my.flag')).toBe(true);
    });

    it('returns false when flag is disabled', () => {
      manager.setFlag('my.flag', { enabled: false });
      expect(manager.isEnabled('my.flag')).toBe(false);
    });

    it('returns true when enabled and no rollout percentage (no userId)', () => {
      manager.setFlag('my.flag', { enabled: true, rolloutPercentage: 50 });
      // Without userId, rollout percentage is not checked
      expect(manager.isEnabled('my.flag')).toBe(true);
    });

    it('uses consistent hashing for rollout percentage with userId', () => {
      manager.setFlag('rollout.flag', { enabled: true, rolloutPercentage: 50 });

      // Same userId should always return the same result
      const result1 = manager.isEnabled('rollout.flag', 'user-123');
      const result2 = manager.isEnabled('rollout.flag', 'user-123');
      expect(result1).toBe(result2);
    });

    it('returns true for 100% rollout', () => {
      manager.setFlag('full.rollout', { enabled: true, rolloutPercentage: 100 });
      // All users should be included
      expect(manager.isEnabled('full.rollout', 'user-abc')).toBe(true);
      expect(manager.isEnabled('full.rollout', 'user-xyz')).toBe(true);
      expect(manager.isEnabled('full.rollout', 'user-123')).toBe(true);
    });

    it('returns false for 0% rollout with userId', () => {
      manager.setFlag('zero.rollout', { enabled: true, rolloutPercentage: 0 });
      expect(manager.isEnabled('zero.rollout', 'user-abc')).toBe(false);
      expect(manager.isEnabled('zero.rollout', 'user-xyz')).toBe(false);
    });

    it('returns false even with userId when flag is disabled', () => {
      manager.setFlag('disabled.flag', { enabled: false, rolloutPercentage: 100 });
      expect(manager.isEnabled('disabled.flag', 'user-abc')).toBe(false);
    });
  });

  // =========================================================================
  // setFlag
  // =========================================================================

  describe('setFlag', () => {
    it('sets a new flag', () => {
      manager.setFlag('new.flag', { enabled: true });
      expect(manager.getFlag('new.flag')).toEqual({ enabled: true });
    });

    it('overwrites existing flag', () => {
      manager.setFlag('flag', { enabled: true });
      manager.setFlag('flag', { enabled: false, description: 'updated' });

      const flag = manager.getFlag('flag');
      expect(flag!.enabled).toBe(false);
      expect(flag!.description).toBe('updated');
    });
  });

  // =========================================================================
  // enable / disable
  // =========================================================================

  describe('enable', () => {
    it('enables an existing disabled flag', () => {
      manager.setFlag('flag', { enabled: false });
      manager.enable('flag');
      expect(manager.isEnabled('flag')).toBe(true);
    });

    it('enables a non-existent flag (creates it)', () => {
      manager.enable('brand.new');
      expect(manager.isEnabled('brand.new')).toBe(true);
    });

    it('preserves other properties when enabling', () => {
      manager.setFlag('flag', { enabled: false, description: 'keep me', rolloutPercentage: 50 });
      manager.enable('flag');

      const flag = manager.getFlag('flag');
      expect(flag!.enabled).toBe(true);
      expect(flag!.description).toBe('keep me');
      expect(flag!.rolloutPercentage).toBe(50);
    });
  });

  describe('disable', () => {
    it('disables an existing enabled flag', () => {
      manager.setFlag('flag', { enabled: true });
      manager.disable('flag');
      expect(manager.isEnabled('flag')).toBe(false);
    });

    it('disables a non-existent flag (creates it disabled)', () => {
      manager.disable('nonexistent');
      expect(manager.isEnabled('nonexistent')).toBe(false);
      expect(manager.getFlag('nonexistent')).not.toBeNull();
    });
  });

  // =========================================================================
  // setRolloutPercentage
  // =========================================================================

  describe('setRolloutPercentage', () => {
    it('sets rollout percentage on existing flag', () => {
      manager.setFlag('flag', { enabled: true });
      manager.setRolloutPercentage('flag', 75);

      const flag = manager.getFlag('flag');
      expect(flag!.rolloutPercentage).toBe(75);
    });

    it('creates flag if not existing', () => {
      manager.setRolloutPercentage('new.flag', 25);

      const flag = manager.getFlag('new.flag');
      expect(flag).not.toBeNull();
      expect(flag!.rolloutPercentage).toBe(25);
      // Default enabled: true when created from setRolloutPercentage
      expect(flag!.enabled).toBe(true);
    });

    it('throws for percentage below 0', () => {
      expect(() => manager.setRolloutPercentage('flag', -1)).toThrow(
        'Rollout percentage must be between 0 and 100'
      );
    });

    it('throws for percentage above 100', () => {
      expect(() => manager.setRolloutPercentage('flag', 101)).toThrow(
        'Rollout percentage must be between 0 and 100'
      );
    });

    it('allows boundary values 0 and 100', () => {
      manager.setRolloutPercentage('a', 0);
      manager.setRolloutPercentage('b', 100);

      expect(manager.getFlag('a')!.rolloutPercentage).toBe(0);
      expect(manager.getFlag('b')!.rolloutPercentage).toBe(100);
    });
  });

  // =========================================================================
  // getAllFlags / getFlag
  // =========================================================================

  describe('getAllFlags', () => {
    it('returns all flags as a record', () => {
      manager.setFlag('a', { enabled: true });
      manager.setFlag('b', { enabled: false });

      const all = manager.getAllFlags();
      expect(Object.keys(all)).toHaveLength(2);
      expect(all.a.enabled).toBe(true);
      expect(all.b.enabled).toBe(false);
    });
  });

  describe('getFlag', () => {
    it('returns null for non-existent flag', () => {
      expect(manager.getFlag('missing')).toBeNull();
    });

    it('returns the flag object', () => {
      manager.setFlag('exists', { enabled: true, description: 'found' });
      const flag = manager.getFlag('exists');
      expect(flag).toEqual({ enabled: true, description: 'found' });
    });
  });

  // =========================================================================
  // loadFlags
  // =========================================================================

  describe('loadFlags', () => {
    it('loads multiple boolean flags', () => {
      manager.loadFlags({
        'x': true,
        'y': false,
      });

      expect(manager.isEnabled('x')).toBe(true);
      expect(manager.isEnabled('y')).toBe(false);
    });

    it('loads multiple object flags', () => {
      manager.loadFlags({
        'obj1': { enabled: true, rolloutPercentage: 50 },
        'obj2': { enabled: false },
      });

      expect(manager.getFlag('obj1')!.rolloutPercentage).toBe(50);
      expect(manager.isEnabled('obj2')).toBe(false);
    });

    it('overwrites existing flags', () => {
      manager.setFlag('existing', { enabled: true });
      manager.loadFlags({ 'existing': false });
      expect(manager.isEnabled('existing')).toBe(false);
    });
  });

  // =========================================================================
  // MARKETPLACE_FLAGS constants
  // =========================================================================

  describe('MARKETPLACE_FLAGS', () => {
    it('has correct marketplace flag names', () => {
      expect(MARKETPLACE_FLAGS.MARKETPLACE_EBAY_ENABLED).toBe('marketplace.ebay.enabled');
      expect(MARKETPLACE_FLAGS.MARKETPLACE_AMAZON_ENABLED).toBe('marketplace.amazon.enabled');
      expect(MARKETPLACE_FLAGS.MARKETPLACE_WALMART_ENABLED).toBe('marketplace.walmart.enabled');
      expect(MARKETPLACE_FLAGS.MARKETPLACE_ETSY_ENABLED).toBe('marketplace.etsy.enabled');
    });

    it('has correct feature-specific flag names', () => {
      expect(MARKETPLACE_FLAGS.EXTRACTION_EVENTS_ENABLED).toBe('extraction.events.enabled');
      expect(MARKETPLACE_FLAGS.BACKFILL_JOBS_ENABLED).toBe('backfill.jobs.enabled');
      expect(MARKETPLACE_FLAGS.NIGHTLY_VALIDATION_ENABLED).toBe('validation.nightly.enabled');
    });
  });

  // =========================================================================
  // DEFAULT_FLAGS
  // =========================================================================

  describe('DEFAULT_FLAGS', () => {
    it('has eBay enabled by default', () => {
      expect(DEFAULT_FLAGS[MARKETPLACE_FLAGS.MARKETPLACE_EBAY_ENABLED].enabled).toBe(true);
    });

    it('has Amazon disabled by default (dark launch)', () => {
      expect(DEFAULT_FLAGS[MARKETPLACE_FLAGS.MARKETPLACE_AMAZON_ENABLED].enabled).toBe(false);
      expect(DEFAULT_FLAGS[MARKETPLACE_FLAGS.MARKETPLACE_AMAZON_ENABLED].rolloutPercentage).toBe(0);
    });

    it('has extraction events enabled by default', () => {
      expect(DEFAULT_FLAGS[MARKETPLACE_FLAGS.EXTRACTION_EVENTS_ENABLED].enabled).toBe(true);
    });

    it('has event persistence disabled by default', () => {
      expect(DEFAULT_FLAGS[MARKETPLACE_FLAGS.EXTRACTION_EVENTS_PERSIST].enabled).toBe(false);
    });

    it('contains descriptions for all flags', () => {
      for (const [_key, flag] of Object.entries(DEFAULT_FLAGS)) {
        expect(flag.description).toBeDefined();
        expect(typeof flag.description).toBe('string');
        expect(flag.description!.length).toBeGreaterThan(0);
      }
    });
  });

  // =========================================================================
  // featureFlags singleton
  // =========================================================================

  describe('featureFlags singleton', () => {
    it('is initialized with DEFAULT_FLAGS', () => {
      expect(featureFlags.isEnabled(MARKETPLACE_FLAGS.MARKETPLACE_EBAY_ENABLED)).toBe(true);
      expect(featureFlags.isEnabled(MARKETPLACE_FLAGS.MARKETPLACE_AMAZON_ENABLED)).toBe(false);
    });

    it('has all default flags loaded', () => {
      const allFlags = featureFlags.getAllFlags();
      const defaultFlagKeys = Object.keys(DEFAULT_FLAGS);

      for (const key of defaultFlagKeys) {
        expect(allFlags[key]).toBeDefined();
      }
    });
  });

  // =========================================================================
  // Hash consistency
  // =========================================================================

  describe('hash consistency for rollout', () => {
    it('provides deterministic results across multiple checks', () => {
      manager.setFlag('rollout', { enabled: true, rolloutPercentage: 50 });

      const results: boolean[] = [];
      for (let i = 0; i < 10; i++) {
        results.push(manager.isEnabled('rollout', 'consistent-user'));
      }

      // All should be the same
      expect(new Set(results).size).toBe(1);
    });

    it('distributes users across rollout', () => {
      manager.setFlag('rollout', { enabled: true, rolloutPercentage: 50 });

      let enabledCount = 0;
      const sampleSize = 100;

      for (let i = 0; i < sampleSize; i++) {
        if (manager.isEnabled('rollout', `user-${i}`)) {
          enabledCount++;
        }
      }

      // With 50% rollout and 100 users, we expect roughly 50 enabled
      // Allow wide margin for hash distribution
      expect(enabledCount).toBeGreaterThan(10);
      expect(enabledCount).toBeLessThan(90);
    });
  });
});
