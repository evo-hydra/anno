import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock external dependencies before imports
// ---------------------------------------------------------------------------

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../config/env', () => ({
  config: {
    domains: {
      configPath: '/tmp/test-domains.yaml',
    },
  },
}));

// Mock fs/promises and fs
const mockExistsSync = vi.fn();
const mockReadFile = vi.fn();
const mockWatch = vi.fn();

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  watch: (...args: unknown[]) => mockWatch(...args),
}));

// Mock YAML parser
const mockParseYaml = vi.fn();
vi.mock('yaml', () => ({
  parse: (...args: unknown[]) => mockParseYaml(...args),
}));

// ---------------------------------------------------------------------------
// We need to re-import for each test to get a fresh singleton.
// The module exports a singleton `domainConfigManager`, so we use dynamic import
// with resetModules to get fresh instances.
// ---------------------------------------------------------------------------

async function freshImport() {
  vi.resetModules();

  // Re-apply mocks after reset
  vi.doMock('../utils/logger', () => ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  }));

  vi.doMock('../config/env', () => ({
    config: {
      domains: {
        configPath: '/tmp/test-domains.yaml',
      },
    },
  }));

  vi.doMock('fs', () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  }));

  vi.doMock('fs/promises', () => ({
    readFile: (...args: unknown[]) => mockReadFile(...args),
    watch: (...args: unknown[]) => mockWatch(...args),
  }));

  vi.doMock('yaml', () => ({
    parse: (...args: unknown[]) => mockParseYaml(...args),
  }));

  return import('../config/domain-config');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DomainConfigManager', () => {
  // -----------------------------------------------------------------------
  // load()
  // -----------------------------------------------------------------------

  describe('load()', () => {
    it('returns early if config file does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('loads and parses YAML config file', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml content');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [
          { pattern: 'example.com', rendering: { requiresJavaScript: true } },
        ],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      expect(mockReadFile).toHaveBeenCalledWith('/tmp/test-domains.yaml', 'utf-8');
      expect(mockParseYaml).toHaveBeenCalledWith('yaml content');
    });

    it('loads defaults from config file', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml content');
      mockParseYaml.mockReturnValue({
        version: '1',
        defaults: {
          rendering: { waitTime: 2000 },
        },
        domains: [
          { pattern: 'example.com' },
        ],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      const cfg = domainConfigManager.getConfig('example.com');
      expect(cfg).not.toBeNull();
      expect(cfg!.rendering!.waitTime).toBe(2000);
    });

    it('warns when version is missing', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml content');
      mockParseYaml.mockReturnValue({
        domains: [{ pattern: 'test.com' }],
      });

      const mod = await freshImport();
      const { logger: mockLogger } = await import('../utils/logger');
      await mod.domainConfigManager.load();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('missing version')
      );
    });

    it('skips domains without pattern', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml content');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [
          { rendering: { requiresJavaScript: true } }, // no pattern
          { pattern: 'valid.com' },
        ],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      expect(domainConfigManager.getConfiguredDomains()).toEqual(['valid.com']);
    });

    it('throws and logs error if readFile fails', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const { domainConfigManager } = await freshImport();

      await expect(domainConfigManager.load()).rejects.toThrow('ENOENT');
    });

    it('handles empty domains array', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml content');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      expect(domainConfigManager.getConfiguredDomains()).toEqual([]);
    });

    it('handles undefined domains', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml content');
      mockParseYaml.mockReturnValue({
        version: '1',
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      expect(domainConfigManager.getConfiguredDomains()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getConfig()
  // -----------------------------------------------------------------------

  describe('getConfig()', () => {
    it('returns null if not loaded', async () => {
      mockExistsSync.mockReturnValue(false);

      const { domainConfigManager } = await freshImport();
      // Don't call load() — loaded is false

      const result = domainConfigManager.getConfig('example.com');
      expect(result).toBeNull();
    });

    it('returns exact match config', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [
          {
            pattern: 'example.com',
            enabled: true,
            rendering: { requiresJavaScript: true },
          },
        ],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      const cfg = domainConfigManager.getConfig('example.com');
      expect(cfg).not.toBeNull();
      expect(cfg!.pattern).toBe('example.com');
      expect(cfg!.rendering!.requiresJavaScript).toBe(true);
    });

    it('returns pattern match with wildcard', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [
          {
            pattern: '*.example.com',
            rendering: { requiresJavaScript: true },
          },
        ],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      const cfg = domainConfigManager.getConfig('sub.example.com');
      expect(cfg).not.toBeNull();
      expect(cfg!.rendering!.requiresJavaScript).toBe(true);
    });

    it('returns defaults for unknown domain when defaults exist', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({
        version: '1',
        defaults: {
          rendering: { waitTime: 1000 },
        },
        domains: [
          { pattern: 'specific.com' },
        ],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      const cfg = domainConfigManager.getConfig('unknown.com');
      expect(cfg).not.toBeNull();
      expect(cfg!.pattern).toBe('unknown.com');
      expect(cfg!.rendering!.waitTime).toBe(1000);
    });

    it('returns null for unknown domain when no defaults', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [
          { pattern: 'specific.com' },
        ],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      const cfg = domainConfigManager.getConfig('unknown.com');
      expect(cfg).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getConfigForUrl()
  // -----------------------------------------------------------------------

  describe('getConfigForUrl()', () => {
    it('extracts hostname from URL and returns config', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [
          { pattern: 'example.com', enabled: true },
        ],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      const cfg = domainConfigManager.getConfigForUrl('https://example.com/path/page');
      expect(cfg).not.toBeNull();
      expect(cfg!.pattern).toBe('example.com');
    });

    it('returns null for invalid URL', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({ version: '1', domains: [] });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      const cfg = domainConfigManager.getConfigForUrl('not-a-url');
      expect(cfg).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Helper methods
  // -----------------------------------------------------------------------

  describe('requiresJavaScript()', () => {
    it('returns true when domain config sets requiresJavaScript', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [
          { pattern: 'spa.app', rendering: { requiresJavaScript: true } },
        ],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      expect(domainConfigManager.requiresJavaScript('spa.app')).toBe(true);
    });

    it('returns false for unconfigured domain', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({ version: '1', domains: [] });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      expect(domainConfigManager.requiresJavaScript('unknown.com')).toBe(false);
    });
  });

  describe('getWaitSelectors()', () => {
    it('returns selectors when configured', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [
          { pattern: 'app.com', rendering: { waitForSelectors: ['.content', '#main'] } },
        ],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      expect(domainConfigManager.getWaitSelectors('app.com')).toEqual(['.content', '#main']);
    });

    it('returns empty array for unconfigured domain', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({ version: '1', domains: [] });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      expect(domainConfigManager.getWaitSelectors('unknown.com')).toEqual([]);
    });
  });

  describe('getRateLimit()', () => {
    it('returns rate limit config when set', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [
          { pattern: 'api.com', rateLimit: { requestsPerSecond: 5, minDelay: 200 } },
        ],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      const rl = domainConfigManager.getRateLimit('api.com');
      expect(rl).toEqual({ requestsPerSecond: 5, minDelay: 200 });
    });

    it('returns null for unconfigured domain', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({ version: '1', domains: [] });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      expect(domainConfigManager.getRateLimit('unknown.com')).toBeNull();
    });
  });

  describe('isEnabled()', () => {
    it('returns true by default', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [{ pattern: 'example.com' }],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      expect(domainConfigManager.isEnabled('example.com')).toBe(true);
    });

    it('returns false when explicitly disabled', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [{ pattern: 'blocked.com', enabled: false }],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      expect(domainConfigManager.isEnabled('blocked.com')).toBe(false);
    });

    it('returns true for unconfigured domain', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({ version: '1', domains: [] });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      expect(domainConfigManager.isEnabled('unknown.com')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // setConfig() / removeConfig()
  // -----------------------------------------------------------------------

  describe('setConfig()', () => {
    it('adds a new domain config at runtime', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({ version: '1', domains: [] });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      domainConfigManager.setConfig('new.com', {
        pattern: 'new.com',
        enabled: true,
        rendering: { requiresJavaScript: true },
      });

      expect(domainConfigManager.getConfiguredDomains()).toContain('new.com');
      expect(domainConfigManager.requiresJavaScript('new.com')).toBe(true);
    });

    it('updates an existing domain config', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [{ pattern: 'exist.com', enabled: true }],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      domainConfigManager.setConfig('exist.com', {
        pattern: 'exist.com',
        enabled: false,
      });

      expect(domainConfigManager.isEnabled('exist.com')).toBe(false);
    });
  });

  describe('removeConfig()', () => {
    it('removes an existing domain config', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [{ pattern: 'remove.com' }],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      const removed = domainConfigManager.removeConfig('remove.com');
      expect(removed).toBe(true);
      expect(domainConfigManager.getConfiguredDomains()).not.toContain('remove.com');
    });

    it('returns false when domain does not exist', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({ version: '1', domains: [] });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      const removed = domainConfigManager.removeConfig('nonexistent.com');
      expect(removed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // stopWatching()
  // -----------------------------------------------------------------------

  describe('stopWatching()', () => {
    it('does nothing when no watcher is active', async () => {
      mockExistsSync.mockReturnValue(false);

      const { domainConfigManager } = await freshImport();

      // Should not throw
      domainConfigManager.stopWatching();
    });
  });

  // -----------------------------------------------------------------------
  // startWatching()
  // -----------------------------------------------------------------------

  describe('startWatching()', () => {
    it('returns early if config file does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.startWatching();

      expect(mockWatch).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // getConfiguredDomains()
  // -----------------------------------------------------------------------

  describe('getConfiguredDomains()', () => {
    it('returns all configured domain patterns', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('yaml');
      mockParseYaml.mockReturnValue({
        version: '1',
        domains: [
          { pattern: 'a.com' },
          { pattern: 'b.com' },
          { pattern: '*.c.com' },
        ],
      });

      const { domainConfigManager } = await freshImport();
      await domainConfigManager.load();

      const domains = domainConfigManager.getConfiguredDomains();
      expect(domains).toEqual(['a.com', 'b.com', '*.c.com']);
    });
  });

  // -----------------------------------------------------------------------
  // initDomainConfig / shutdownDomainConfig
  // -----------------------------------------------------------------------

  describe('initDomainConfig()', () => {
    it('calls load() on the manager', async () => {
      mockExistsSync.mockReturnValue(false);

      const { initDomainConfig } = await freshImport();
      await initDomainConfig();

      // Should not throw, and file-not-found path is handled gracefully
    });
  });

  describe('shutdownDomainConfig()', () => {
    it('stops watching', async () => {
      mockExistsSync.mockReturnValue(false);

      const { shutdownDomainConfig } = await freshImport();
      shutdownDomainConfig();

      // Should not throw
    });
  });
});
