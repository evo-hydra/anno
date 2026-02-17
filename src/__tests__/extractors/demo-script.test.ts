import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Mock fs/promises (used by extraction-telemetry)
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock fs (used by extraction-telemetry)
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

import { MarketplaceDemoRunner } from '../../services/extractors/demo-script';

describe('MarketplaceDemoRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('constructor', () => {
    it('creates runner with default config', () => {
      const runner = new MarketplaceDemoRunner();
      expect(runner).toBeDefined();
    });

    it('accepts partial config overrides', () => {
      const runner = new MarketplaceDemoRunner({
        useFixtures: false,
        marketplaces: ['ebay'],
        outputReport: false,
        exitOnError: true,
      });
      expect(runner).toBeDefined();
    });

    it('uses default marketplaces when none specified', () => {
      const runner = new MarketplaceDemoRunner({});
      expect(runner).toBeDefined();
    });
  });

  describe('run()', () => {
    it('completes successfully with default config', async () => {
      const runner = new MarketplaceDemoRunner({
        outputReport: false,
      });

      const result = await runner.run();

      expect(result.success).toBe(true);
      expect(result.extractionsAttempted).toBeGreaterThan(0);
      expect(result.extractionsSuccessful).toBe(result.extractionsAttempted);
      expect(result.extractionsFailed).toBe(0);
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.avgConfidence).toBeGreaterThan(0);
      expect(result.timestamp).toBeDefined();
      expect(result.errors).toHaveLength(0);
    });

    it('runs with single marketplace subset', async () => {
      const runner = new MarketplaceDemoRunner({
        marketplaces: ['ebay'],
        outputReport: false,
      });

      const result = await runner.run();

      // 2 demo URLs per marketplace
      expect(result.extractionsAttempted).toBe(2);
      expect(result.success).toBe(true);
    });

    it('runs with multiple marketplace subset', async () => {
      const runner = new MarketplaceDemoRunner({
        marketplaces: ['ebay', 'walmart'],
        outputReport: false,
      });

      const result = await runner.run();

      // 2 URLs for ebay + 2 URLs for walmart
      expect(result.extractionsAttempted).toBe(4);
      expect(result.success).toBe(true);
    });

    it('runs with report generation enabled', async () => {
      const runner = new MarketplaceDemoRunner({
        marketplaces: ['ebay'],
        outputReport: true,
      });

      const result = await runner.run();
      expect(result.success).toBe(true);
      expect(result.telemetryReport).not.toBeNull();
    });

    it('handles empty marketplace list gracefully', async () => {
      const runner = new MarketplaceDemoRunner({
        marketplaces: [],
        outputReport: false,
      });

      const result = await runner.run();
      expect(result.extractionsAttempted).toBe(0);
    });

    it('includes telemetry report in results', async () => {
      const runner = new MarketplaceDemoRunner({
        marketplaces: ['walmart'],
        outputReport: false,
      });

      const result = await runner.run();
      expect(result.telemetryReport).toBeDefined();
    });

    it('runs all three default marketplaces', async () => {
      const runner = new MarketplaceDemoRunner({
        outputReport: false,
      });

      const result = await runner.run();
      // 3 marketplaces * 2 URLs each = 6
      expect(result.extractionsAttempted).toBe(6);
      expect(result.extractionsSuccessful).toBe(6);
    });

    it('calculates average confidence across extractions', async () => {
      const runner = new MarketplaceDemoRunner({
        marketplaces: ['ebay'],
        outputReport: false,
      });

      const result = await runner.run();
      // Mock listings have confidence > 0
      expect(result.avgConfidence).toBeGreaterThan(0);
      expect(result.avgConfidence).toBeLessThanOrEqual(1);
    });

    it('records duration', async () => {
      const runner = new MarketplaceDemoRunner({
        marketplaces: ['ebay'],
        outputReport: false,
      });

      const result = await runner.run();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('skips marketplaces not in config', async () => {
      const runner = new MarketplaceDemoRunner({
        marketplaces: ['amazon'],
        outputReport: false,
      });

      const result = await runner.run();
      // Only amazon URLs (2)
      expect(result.extractionsAttempted).toBe(2);
    });
  });
});
