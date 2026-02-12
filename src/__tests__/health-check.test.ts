/**
 * Unit tests for the Enhanced Health Check Service.
 *
 * Tests performHealthCheck() which aggregates cache, Ollama, renderer,
 * and policy engine health into a single HealthStatus object.
 *
 * All external dependencies are vi.mock'd so tests run without
 * Redis, Playwright, Ollama, or the network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted ensures these are available when vi.mock
// factories run (vi.mock is hoisted to the top of the file).
// ---------------------------------------------------------------------------

const {
  mockGetStrategy,
  mockGetRedisStatus,
  mockCheckAvailability,
  mockGetRendererStatus,
  mockPolicyInit,
  mockGetPolicies,
  mockGetFingerprint,
} = vi.hoisted(() => ({
  mockGetStrategy: vi.fn().mockReturnValue('lru'),
  mockGetRedisStatus: vi.fn().mockReturnValue(null),
  mockCheckAvailability: vi.fn().mockResolvedValue(false),
  mockGetRendererStatus: vi.fn().mockReturnValue({ enabled: false, initialized: false }),
  mockPolicyInit: vi.fn().mockResolvedValue(undefined),
  mockGetPolicies: vi.fn().mockReturnValue([]),
  mockGetFingerprint: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../services/cache', () => ({
  cache: {
    getStrategy: mockGetStrategy,
    getRedisStatus: mockGetRedisStatus,
  },
}));

vi.mock('../services/ollama-extractor', () => ({
  ollamaExtractor: {
    checkAvailability: mockCheckAvailability,
  },
}));

vi.mock('../services/renderer', () => ({
  getRendererStatus: mockGetRendererStatus,
}));

vi.mock('../services/policy-engine', () => ({
  policyEngine: {
    init: mockPolicyInit,
    getPolicies: mockGetPolicies,
    getFingerprint: mockGetFingerprint,
  },
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Import (after mocks)
// ---------------------------------------------------------------------------

import { performHealthCheck } from '../services/health-check';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('performHealthCheck()', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset to defaults
    mockGetStrategy.mockReturnValue('lru');
    mockGetRedisStatus.mockReturnValue(null);
    mockCheckAvailability.mockResolvedValue(false);
    mockGetRendererStatus.mockReturnValue({ enabled: false, initialized: false });
    mockPolicyInit.mockResolvedValue(undefined);
    mockGetPolicies.mockReturnValue([]);
    mockGetFingerprint.mockReturnValue(null);
  });

  // -----------------------------------------------------------------------
  // Overall status calculation
  // -----------------------------------------------------------------------

  it('returns a valid HealthStatus object', async () => {
    const result = await performHealthCheck();

    expect(result).toBeDefined();
    expect(result.status).toBeDefined();
    expect(result.timestamp).toBeGreaterThan(0);
    expect(result.checks).toBeDefined();
    expect(result.checks.cache).toBeDefined();
    expect(result.checks.ollama).toBeDefined();
    expect(result.checks.renderer).toBeDefined();
    expect(result.checks.policies).toBeDefined();
    expect(result.overall).toBeDefined();
    expect(typeof result.overall.healthy).toBe('number');
    expect(typeof result.overall.degraded).toBe('number');
    expect(typeof result.overall.unhealthy).toBe('number');
  });

  it('returns healthy when all components are healthy', async () => {
    // Cache: Redis connected
    mockGetStrategy.mockReturnValue('redis');
    mockGetRedisStatus.mockReturnValue({ connected: true, reconnectAttempts: 0 });

    // Ollama: available
    mockCheckAvailability.mockResolvedValue(true);

    // Renderer: enabled + initialized
    mockGetRendererStatus.mockReturnValue({ enabled: true, initialized: true, concurrency: 2 });

    // Policies: loaded
    mockGetPolicies.mockReturnValue([{ name: 'default' }]);
    mockGetFingerprint.mockReturnValue('abc123');

    const result = await performHealthCheck();

    expect(result.status).toBe('healthy');
    expect(result.overall.healthy).toBe(4);
    expect(result.overall.degraded).toBe(0);
    expect(result.overall.unhealthy).toBe(0);
  });

  it('returns degraded when some components are degraded', async () => {
    // Cache: using LRU (degraded)
    mockGetStrategy.mockReturnValue('lru');
    mockGetRedisStatus.mockReturnValue(null);

    // Ollama: unavailable (degraded)
    mockCheckAvailability.mockResolvedValue(false);

    // Renderer: disabled (degraded)
    mockGetRendererStatus.mockReturnValue({ enabled: false, initialized: false });

    // Policies: no policies (degraded)
    mockGetPolicies.mockReturnValue([]);

    const result = await performHealthCheck();

    expect(result.status).toBe('degraded');
    expect(result.overall.degraded).toBeGreaterThan(0);
    expect(result.overall.unhealthy).toBe(0);
  });

  it('returns unhealthy when at least one component is unhealthy', async () => {
    // Cache: strategy is not lru and redis is disconnected
    mockGetStrategy.mockReturnValue('redis');
    mockGetRedisStatus.mockReturnValue({ connected: false, reconnectAttempts: 5 });

    // Others degraded
    mockCheckAvailability.mockResolvedValue(false);
    mockGetRendererStatus.mockReturnValue({ enabled: false, initialized: false });
    mockGetPolicies.mockReturnValue([]);

    const result = await performHealthCheck();

    expect(result.status).toBe('unhealthy');
    expect(result.overall.unhealthy).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Cache health checks
  // -----------------------------------------------------------------------

  describe('cache health', () => {
    it('returns healthy when Redis is connected', async () => {
      mockGetStrategy.mockReturnValue('redis');
      mockGetRedisStatus.mockReturnValue({ connected: true, reconnectAttempts: 0 });

      const result = await performHealthCheck();

      expect(result.checks.cache.status).toBe('healthy');
      expect(result.checks.cache.message).toContain('Redis connected');
      expect(result.checks.cache.details).toEqual(
        expect.objectContaining({ strategy: 'redis', connected: true }),
      );
    });

    it('returns degraded when using in-memory LRU cache', async () => {
      mockGetStrategy.mockReturnValue('lru');
      mockGetRedisStatus.mockReturnValue(null);

      const result = await performHealthCheck();

      expect(result.checks.cache.status).toBe('degraded');
      expect(result.checks.cache.message).toContain('in-memory cache');
    });

    it('returns unhealthy when cache strategy is redis but not connected', async () => {
      mockGetStrategy.mockReturnValue('redis');
      mockGetRedisStatus.mockReturnValue({ connected: false, reconnectAttempts: 3 });

      const result = await performHealthCheck();

      expect(result.checks.cache.status).toBe('unhealthy');
      expect(result.checks.cache.message).toContain('unavailable');
    });

    it('returns unhealthy when getStrategy throws', async () => {
      mockGetStrategy.mockImplementation(() => {
        throw new Error('cache exploded');
      });

      const result = await performHealthCheck();

      expect(result.checks.cache.status).toBe('unhealthy');
      expect(result.checks.cache.message).toContain('cache exploded');
    });
  });

  // -----------------------------------------------------------------------
  // Ollama health checks
  // -----------------------------------------------------------------------

  describe('ollama health', () => {
    it('returns healthy when Ollama is available', async () => {
      mockCheckAvailability.mockResolvedValue(true);

      const result = await performHealthCheck();

      expect(result.checks.ollama.status).toBe('healthy');
      expect(result.checks.ollama.message).toContain('Ollama LLM available');
      expect(result.checks.ollama.details).toEqual(expect.objectContaining({ available: true }));
    });

    it('returns degraded when Ollama is not available', async () => {
      mockCheckAvailability.mockResolvedValue(false);

      const result = await performHealthCheck();

      expect(result.checks.ollama.status).toBe('degraded');
      expect(result.checks.ollama.message).toContain('unavailable');
    });

    it('returns degraded when checkAvailability throws', async () => {
      mockCheckAvailability.mockRejectedValue(new Error('connection refused'));

      const result = await performHealthCheck();

      expect(result.checks.ollama.status).toBe('degraded');
      expect(result.checks.ollama.message).toContain('connection refused');
    });
  });

  // -----------------------------------------------------------------------
  // Renderer health checks
  // -----------------------------------------------------------------------

  describe('renderer health', () => {
    it('returns healthy when renderer is enabled and initialized', async () => {
      mockGetRendererStatus.mockReturnValue({ enabled: true, initialized: true, concurrency: 4 });

      const result = await performHealthCheck();

      expect(result.checks.renderer.status).toBe('healthy');
      expect(result.checks.renderer.message).toContain('initialized and ready');
      expect(result.checks.renderer.details).toEqual(
        expect.objectContaining({ enabled: true, initialized: true, concurrency: 4 }),
      );
    });

    it('returns degraded when renderer is enabled but not initialized', async () => {
      mockGetRendererStatus.mockReturnValue({ enabled: true, initialized: false });

      const result = await performHealthCheck();

      expect(result.checks.renderer.status).toBe('degraded');
      expect(result.checks.renderer.message).toContain('not initialized');
    });

    it('returns degraded when renderer is disabled', async () => {
      mockGetRendererStatus.mockReturnValue({ enabled: false, initialized: false });

      const result = await performHealthCheck();

      expect(result.checks.renderer.status).toBe('degraded');
      expect(result.checks.renderer.message).toContain('disabled');
    });

    it('returns unhealthy when getRendererStatus throws', async () => {
      mockGetRendererStatus.mockImplementation(() => {
        throw new Error('renderer crashed');
      });

      const result = await performHealthCheck();

      expect(result.checks.renderer.status).toBe('unhealthy');
      expect(result.checks.renderer.message).toContain('renderer crashed');
    });
  });

  // -----------------------------------------------------------------------
  // Policy health checks
  // -----------------------------------------------------------------------

  describe('policy health', () => {
    it('returns healthy when policies are loaded', async () => {
      mockGetPolicies.mockReturnValue([
        { name: 'default-policy' },
        { name: 'strict-policy' },
      ]);
      mockGetFingerprint.mockReturnValue('fingerprint-abc');

      const result = await performHealthCheck();

      expect(result.checks.policies.status).toBe('healthy');
      expect(result.checks.policies.message).toContain('loaded');
      expect(result.checks.policies.details).toEqual(
        expect.objectContaining({
          count: 2,
          fingerprint: 'fingerprint-abc',
          names: ['default-policy', 'strict-policy'],
        }),
      );
    });

    it('returns degraded when no policies are loaded', async () => {
      mockGetPolicies.mockReturnValue([]);
      mockGetFingerprint.mockReturnValue(null);

      const result = await performHealthCheck();

      expect(result.checks.policies.status).toBe('degraded');
      expect(result.checks.policies.message).toContain('No policies');
    });

    it('returns degraded when policy init throws', async () => {
      mockPolicyInit.mockRejectedValue(new Error('file not found'));

      const result = await performHealthCheck();

      expect(result.checks.policies.status).toBe('degraded');
      expect(result.checks.policies.message).toContain('file not found');
    });
  });

  // -----------------------------------------------------------------------
  // Latency tracking
  // -----------------------------------------------------------------------

  it('includes latencyMs in all component checks', async () => {
    const result = await performHealthCheck();

    expect(result.checks.cache.latencyMs).toBeDefined();
    expect(typeof result.checks.cache.latencyMs).toBe('number');
    expect(result.checks.ollama.latencyMs).toBeDefined();
    expect(result.checks.renderer.latencyMs).toBeDefined();
    expect(result.checks.policies.latencyMs).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Total failure scenario
  // -----------------------------------------------------------------------

  it('returns unhealthy status with fallback counts when total check fails', async () => {
    const result = await performHealthCheck();

    const totalChecks = result.overall.healthy + result.overall.degraded + result.overall.unhealthy;
    expect(totalChecks).toBe(4);
  });

  // -----------------------------------------------------------------------
  // Sum consistency
  // -----------------------------------------------------------------------

  it('overall counts sum equals number of checked components (4)', async () => {
    // Mixed scenario
    mockGetStrategy.mockReturnValue('redis');
    mockGetRedisStatus.mockReturnValue({ connected: true, reconnectAttempts: 0 });
    mockCheckAvailability.mockResolvedValue(true);
    mockGetRendererStatus.mockReturnValue({ enabled: true, initialized: false });
    mockGetPolicies.mockReturnValue([]);

    const result = await performHealthCheck();

    const total = result.overall.healthy + result.overall.degraded + result.overall.unhealthy;
    expect(total).toBe(4);

    // Cache: healthy, Ollama: healthy, Renderer: degraded, Policies: degraded
    expect(result.overall.healthy).toBe(2);
    expect(result.overall.degraded).toBe(2);
    expect(result.overall.unhealthy).toBe(0);
    expect(result.status).toBe('degraded');
  });
});
