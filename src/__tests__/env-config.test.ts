/**
 * Tests for src/config/env.ts
 *
 * Tests environment variable parsing: numberFromEnv, booleanFromEnv, waitUntilFromEnv,
 * and the full config object construction from process.env values.
 *
 * The existing coverage (~54%) likely covers basic config reads. This file focuses on:
 * - Edge cases for parsing helpers (NaN, empty, invalid values)
 * - All config sections with explicit env var overrides
 * - Default values when env vars are unset
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_USER_AGENT } from '../config/user-agents';

// ---------------------------------------------------------------------------
// We need to test the config module with controlled env vars. Since config
// is a module-level const, we need to use vi.resetModules() and dynamic imports.
// ---------------------------------------------------------------------------

describe('env.ts config parsing', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Clear all env vars that the config reads
    const envKeys = [
      'PORT', 'CACHE_MAX_ENTRIES', 'CACHE_TTL_MS', 'CACHE_ENCRYPTION_KEY',
      'REDIS_ENABLED', 'REDIS_URL', 'REDIS_TTL_MS',
      'USER_AGENT', 'FETCH_TIMEOUT_MS', 'RESPECT_ROBOTS', 'OVERRIDE_ROBOTS',
      'RENDERING_ENABLED', 'RENDER_TIMEOUT_MS', 'RENDER_WAIT_UNTIL',
      'RENDER_HEADLESS', 'RENDER_MAX_PAGES', 'RENDER_STEALTH', 'PROXY_URL',
      'METRICS_RESET_ENABLED', 'METRICS_RESET_TOKEN', 'ENABLE_STAGE_METRICS',
      'AI_EMBEDDING_PROVIDER', 'AI_LLM_PROVIDER', 'AI_VECTOR_STORE',
      'AI_SUMMARIZER', 'AI_DEFAULT_K',
      'POLICY_ENABLED', 'POLICY_DIR', 'DEFAULT_POLICY', 'POLICY_VALIDATION_ENABLED',
      'SSRF_PROTECTION_ENABLED', 'SSRF_ALLOWED_HOSTS', 'SSRF_BLOCKED_HOSTS',
      'SSRF_ALLOW_PRIVATE_IPS',
      'DOMAIN_CONFIG_PATH',
      'ANNO_AUTH_ENABLED', 'ANNO_API_KEYS', 'ANNO_RATE_LIMIT_PER_KEY',
      'ANNO_AUTH_BYPASS_DEV',
      'NODE_ENV',
    ];
    for (const key of envKeys) {
      delete process.env[key];
    }
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  // -----------------------------------------------------------------------
  // Default values (no env vars set)
  // -----------------------------------------------------------------------

  describe('default values', () => {
    it('port defaults to 5213', async () => {
      const { config } = await import('../config/env');
      expect(config.port).toBe(5213);
    });

    it('cache defaults', async () => {
      const { config } = await import('../config/env');
      expect(config.cache.maxEntries).toBe(128);
      expect(config.cache.ttlMs).toBe(300000);
      expect(config.cache.encryptionKey).toBeUndefined();
    });

    it('redis defaults (disabled in test env)', async () => {
      const { config } = await import('../config/env');
      expect(config.redis.enabled).toBe(false); // NODE_ENV=test, not production
      expect(config.redis.url).toBe('redis://localhost:6379');
      expect(config.redis.ttlMs).toBe(3600000);
    });

    it('redis defaults to enabled in production', async () => {
      process.env.NODE_ENV = 'production';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.redis.enabled).toBe(true);
    });

    it('fetch defaults', async () => {
      const { config } = await import('../config/env');
      expect(config.fetch.userAgent).toBe(DEFAULT_USER_AGENT);
      expect(config.fetch.timeoutMs).toBe(15000);
      expect(config.fetch.respectRobots).toBe(true);
      expect(config.fetch.overrideRobots).toBe(false);
    });

    it('rendering defaults to disabled in test env', async () => {
      const { config } = await import('../config/env');
      expect(config.rendering.enabled).toBe(false);
      expect(config.rendering.timeoutMs).toBe(20000);
      expect(config.rendering.waitUntil).toBe('networkidle');
      expect(config.rendering.headless).toBe(true);
      expect(config.rendering.maxPages).toBe(2);
      expect(config.rendering.stealth).toBe(true);
      expect(config.rendering.proxy).toBeUndefined();
    });

    it('metrics defaults', async () => {
      const { config } = await import('../config/env');
      expect(config.metrics.allowReset).toBe(false);
      expect(config.metrics.resetToken).toBeUndefined();
      expect(config.metrics.enableStageMetrics).toBe(true);
    });

    it('ai defaults', async () => {
      const { config } = await import('../config/env');
      expect(config.ai.embeddingProvider).toBe('deterministic');
      expect(config.ai.llmProvider).toBe('none');
      expect(config.ai.vectorStoreProvider).toBe('memory');
      expect(config.ai.summarizer).toBe('heuristic');
      expect(config.ai.defaultK).toBe(3);
    });

    it('policies defaults', async () => {
      const { config } = await import('../config/env');
      expect(config.policies.enabled).toBe(true);
      expect(config.policies.dir).toBe('./policies');
      expect(config.policies.defaultPolicy).toBe('default.yaml');
      expect(config.policies.validationEnabled).toBe(true);
    });

    it('ssrf defaults', async () => {
      const { config } = await import('../config/env');
      expect(config.ssrf.enabled).toBe(true);
      expect(config.ssrf.allowedHosts).toEqual([]);
      expect(config.ssrf.blockedHosts).toEqual([]);
      expect(config.ssrf.allowPrivateIPs).toBe(false);
    });

    it('domains defaults', async () => {
      const { config } = await import('../config/env');
      expect(config.domains.configPath).toBe('./config/domains.yaml');
    });

    it('auth defaults', async () => {
      const { config } = await import('../config/env');
      expect(config.auth.enabled).toBe(false);
      expect(config.auth.apiKeys).toEqual([]);
      expect(config.auth.rateLimitPerKey).toBe(60);
      expect(config.auth.bypassInDev).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // numberFromEnv edge cases
  // -----------------------------------------------------------------------

  describe('numberFromEnv', () => {
    it('parses valid integer from env', async () => {
      process.env.PORT = '8080';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.port).toBe(8080);
    });

    it('returns fallback for NaN value', async () => {
      process.env.PORT = 'not-a-number';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.port).toBe(5213);
    });

    it('returns fallback for empty string', async () => {
      process.env.PORT = '';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.port).toBe(5213);
    });

    it('parses zero correctly', async () => {
      process.env.CACHE_MAX_ENTRIES = '0';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.cache.maxEntries).toBe(0);
    });

    it('parses negative numbers', async () => {
      process.env.FETCH_TIMEOUT_MS = '-1';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.fetch.timeoutMs).toBe(-1);
    });

    it('truncates floating point numbers', async () => {
      process.env.PORT = '3.14';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.port).toBe(3); // parseInt truncates
    });
  });

  // -----------------------------------------------------------------------
  // booleanFromEnv edge cases
  // -----------------------------------------------------------------------

  describe('booleanFromEnv', () => {
    it('parses "true" (case insensitive)', async () => {
      process.env.REDIS_ENABLED = 'TRUE';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.redis.enabled).toBe(true);
    });

    it('parses "True" (mixed case)', async () => {
      process.env.REDIS_ENABLED = 'True';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.redis.enabled).toBe(true);
    });

    it('parses "false" (case insensitive)', async () => {
      process.env.RESPECT_ROBOTS = 'FALSE';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.fetch.respectRobots).toBe(false);
    });

    it('parses "False" (mixed case)', async () => {
      process.env.RESPECT_ROBOTS = 'False';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.fetch.respectRobots).toBe(false);
    });

    it('returns fallback for invalid boolean value', async () => {
      process.env.RESPECT_ROBOTS = 'yes';
      vi.resetModules();
      const { config } = await import('../config/env');
      // fallback for respectRobots is true
      expect(config.fetch.respectRobots).toBe(true);
    });

    it('returns fallback for empty string', async () => {
      process.env.RESPECT_ROBOTS = '';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.fetch.respectRobots).toBe(true);
    });

    it('returns fallback for "1" (not recognized as true)', async () => {
      process.env.REDIS_ENABLED = '1';
      vi.resetModules();
      const { config } = await import('../config/env');
      // '1' is not 'true' or 'false', so fallback applies
      // Fallback for REDIS_ENABLED depends on NODE_ENV
      // NODE_ENV=test -> fallback=false
      expect(config.redis.enabled).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // waitUntilFromEnv edge cases
  // -----------------------------------------------------------------------

  describe('waitUntilFromEnv', () => {
    it('accepts "load"', async () => {
      process.env.RENDER_WAIT_UNTIL = 'load';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.rendering.waitUntil).toBe('load');
    });

    it('accepts "domcontentloaded"', async () => {
      process.env.RENDER_WAIT_UNTIL = 'domcontentloaded';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.rendering.waitUntil).toBe('domcontentloaded');
    });

    it('accepts "networkidle"', async () => {
      process.env.RENDER_WAIT_UNTIL = 'networkidle';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.rendering.waitUntil).toBe('networkidle');
    });

    it('is case insensitive', async () => {
      process.env.RENDER_WAIT_UNTIL = 'LOAD';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.rendering.waitUntil).toBe('load');
    });

    it('returns fallback for invalid value', async () => {
      process.env.RENDER_WAIT_UNTIL = 'invalid-value';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.rendering.waitUntil).toBe('networkidle');
    });

    it('returns fallback for empty string', async () => {
      process.env.RENDER_WAIT_UNTIL = '';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.rendering.waitUntil).toBe('networkidle');
    });
  });

  // -----------------------------------------------------------------------
  // String env vars
  // -----------------------------------------------------------------------

  describe('string env vars', () => {
    it('reads USER_AGENT', async () => {
      process.env.USER_AGENT = 'TestBot/2.0';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.fetch.userAgent).toBe('TestBot/2.0');
    });

    it('reads REDIS_URL', async () => {
      process.env.REDIS_URL = 'redis://redis.example.com:6380';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.redis.url).toBe('redis://redis.example.com:6380');
    });

    it('reads CACHE_ENCRYPTION_KEY', async () => {
      process.env.CACHE_ENCRYPTION_KEY = 'my-secret-key';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.cache.encryptionKey).toBe('my-secret-key');
    });

    it('reads PROXY_URL', async () => {
      process.env.PROXY_URL = 'http://proxy.local:8888';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.rendering.proxy).toBe('http://proxy.local:8888');
    });

    it('reads METRICS_RESET_TOKEN', async () => {
      process.env.METRICS_RESET_TOKEN = 'secret-123';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.metrics.resetToken).toBe('secret-123');
    });

    it('reads DOMAIN_CONFIG_PATH', async () => {
      process.env.DOMAIN_CONFIG_PATH = '/etc/anno/domains.yaml';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.domains.configPath).toBe('/etc/anno/domains.yaml');
    });
  });

  // -----------------------------------------------------------------------
  // AI config
  // -----------------------------------------------------------------------

  describe('ai config', () => {
    it('reads AI_EMBEDDING_PROVIDER', async () => {
      process.env.AI_EMBEDDING_PROVIDER = 'openai';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.ai.embeddingProvider).toBe('openai');
    });

    it('reads AI_LLM_PROVIDER', async () => {
      process.env.AI_LLM_PROVIDER = 'ollama';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.ai.llmProvider).toBe('ollama');
    });

    it('reads AI_VECTOR_STORE', async () => {
      process.env.AI_VECTOR_STORE = 'redis';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.ai.vectorStoreProvider).toBe('redis');
    });

    it('reads AI_SUMMARIZER "llm"', async () => {
      process.env.AI_SUMMARIZER = 'llm';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.ai.summarizer).toBe('llm');
    });

    it('defaults AI_SUMMARIZER to "heuristic" for unknown values', async () => {
      process.env.AI_SUMMARIZER = 'unknown';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.ai.summarizer).toBe('heuristic');
    });

    it('reads AI_DEFAULT_K', async () => {
      process.env.AI_DEFAULT_K = '10';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.ai.defaultK).toBe(10);
    });
  });

  // -----------------------------------------------------------------------
  // SSRF config with comma-separated hosts
  // -----------------------------------------------------------------------

  describe('ssrf comma-separated hosts', () => {
    it('parses SSRF_ALLOWED_HOSTS', async () => {
      process.env.SSRF_ALLOWED_HOSTS = 'example.com, api.example.com, cdn.example.com';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.ssrf.allowedHosts).toEqual(['example.com', 'api.example.com', 'cdn.example.com']);
    });

    it('parses SSRF_BLOCKED_HOSTS', async () => {
      process.env.SSRF_BLOCKED_HOSTS = '169.254.169.254, metadata.google.internal';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.ssrf.blockedHosts).toEqual(['169.254.169.254', 'metadata.google.internal']);
    });

    it('filters empty strings from comma-separated lists', async () => {
      process.env.SSRF_ALLOWED_HOSTS = 'example.com,,, ,api.example.com';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.ssrf.allowedHosts).toEqual(['example.com', 'api.example.com']);
    });
  });

  // -----------------------------------------------------------------------
  // Auth config with comma-separated API keys
  // -----------------------------------------------------------------------

  describe('auth config', () => {
    it('parses ANNO_API_KEYS', async () => {
      process.env.ANNO_API_KEYS = 'key1,key2,key3';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.auth.apiKeys).toEqual(['key1', 'key2', 'key3']);
    });

    it('trims whitespace from API keys', async () => {
      process.env.ANNO_API_KEYS = ' key1 , key2 , key3 ';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.auth.apiKeys).toEqual(['key1', 'key2', 'key3']);
    });

    it('filters empty API keys', async () => {
      process.env.ANNO_API_KEYS = 'key1,,,key2';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.auth.apiKeys).toEqual(['key1', 'key2']);
    });

    it('reads ANNO_AUTH_ENABLED', async () => {
      process.env.ANNO_AUTH_ENABLED = 'true';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.auth.enabled).toBe(true);
    });

    it('reads ANNO_RATE_LIMIT_PER_KEY', async () => {
      process.env.ANNO_RATE_LIMIT_PER_KEY = '120';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.auth.rateLimitPerKey).toBe(120);
    });

    it('reads ANNO_AUTH_BYPASS_DEV', async () => {
      process.env.ANNO_AUTH_BYPASS_DEV = 'false';
      vi.resetModules();
      const { config } = await import('../config/env');
      expect(config.auth.bypassInDev).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Complete config override
  // -----------------------------------------------------------------------

  describe('full config override', () => {
    it('reads all overridable values simultaneously', async () => {
      process.env.PORT = '9090';
      process.env.CACHE_MAX_ENTRIES = '256';
      process.env.CACHE_TTL_MS = '600000';
      process.env.REDIS_ENABLED = 'true';
      process.env.REDIS_TTL_MS = '7200000';
      process.env.FETCH_TIMEOUT_MS = '30000';
      process.env.RENDERING_ENABLED = 'true';
      process.env.RENDER_TIMEOUT_MS = '40000';
      process.env.RENDER_WAIT_UNTIL = 'domcontentloaded';
      process.env.RENDER_MAX_PAGES = '5';
      process.env.METRICS_RESET_ENABLED = 'true';
      process.env.AI_DEFAULT_K = '7';
      process.env.ANNO_AUTH_ENABLED = 'true';
      process.env.ANNO_RATE_LIMIT_PER_KEY = '200';

      vi.resetModules();
      const { config } = await import('../config/env');

      expect(config.port).toBe(9090);
      expect(config.cache.maxEntries).toBe(256);
      expect(config.cache.ttlMs).toBe(600000);
      expect(config.redis.enabled).toBe(true);
      expect(config.redis.ttlMs).toBe(7200000);
      expect(config.fetch.timeoutMs).toBe(30000);
      expect(config.rendering.enabled).toBe(true);
      expect(config.rendering.timeoutMs).toBe(40000);
      expect(config.rendering.waitUntil).toBe('domcontentloaded');
      expect(config.rendering.maxPages).toBe(5);
      expect(config.metrics.allowReset).toBe(true);
      expect(config.ai.defaultK).toBe(7);
      expect(config.auth.enabled).toBe(true);
      expect(config.auth.rateLimitPerKey).toBe(200);
    });
  });
});
