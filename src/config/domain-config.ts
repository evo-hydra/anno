/**
 * Domain Configuration System
 *
 * Provides per-domain configuration for rendering, rate limiting, and extraction.
 * Configuration is loaded from a YAML file and can be hot-reloaded.
 *
 * @module domain-config
 */

import { readFile, watch } from 'fs/promises';
import { existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { logger } from '../utils/logger';
import { config as envConfig } from './env';

/**
 * Per-domain rendering configuration
 */
export interface DomainRenderingConfig {
  /** Whether JavaScript rendering is required */
  requiresJavaScript?: boolean;
  /** CSS selectors to wait for before extraction */
  waitForSelectors?: string[];
  /** Additional wait time in milliseconds after page load */
  waitTime?: number;
  /** Resource types to block (images, stylesheets, etc.) */
  blockResources?: ('image' | 'stylesheet' | 'font' | 'media' | 'script')[];
  /** Custom timeout for this domain */
  timeout?: number;
}

/**
 * Per-domain rate limiting configuration
 */
export interface DomainRateLimitConfig {
  /** Requests per second */
  requestsPerSecond?: number;
  /** Requests per minute */
  requestsPerMinute?: number;
  /** Requests per hour */
  requestsPerHour?: number;
  /** Minimum delay between requests in milliseconds */
  minDelay?: number;
}

/**
 * Per-domain extraction configuration
 */
export interface DomainExtractionConfig {
  /** Preferred extraction adapter */
  preferredAdapter?: string;
  /** Custom CSS selectors for content extraction */
  contentSelectors?: string[];
  /** CSS selectors to exclude from extraction */
  excludeSelectors?: string[];
  /** Minimum confidence threshold */
  minConfidence?: number;
}

/**
 * Per-domain session configuration
 */
export interface DomainSessionConfig {
  /** Whether to persist cookies for this domain */
  persistCookies?: boolean;
  /** Session cookie names to preserve */
  sessionCookies?: string[];
  /** Custom headers to include */
  headers?: Record<string, string>;
}

/**
 * Complete domain configuration
 */
export interface DomainConfig {
  /** Domain pattern (supports wildcards: *.example.com) */
  pattern: string;
  /** Whether this domain is enabled */
  enabled?: boolean;
  /** Rendering configuration */
  rendering?: DomainRenderingConfig;
  /** Rate limiting configuration */
  rateLimit?: DomainRateLimitConfig;
  /** Extraction configuration */
  extraction?: DomainExtractionConfig;
  /** Session configuration */
  session?: DomainSessionConfig;
}

/**
 * Root configuration file structure
 */
interface DomainConfigFile {
  /** Version of the config file format */
  version: string;
  /** Default configuration applied to all domains */
  defaults?: Omit<DomainConfig, 'pattern'>;
  /** Per-domain configurations */
  domains: DomainConfig[];
}

/**
 * Domain Configuration Manager
 */
class DomainConfigManager {
  private configs: Map<string, DomainConfig> = new Map();
  private patterns: { regex: RegExp; config: DomainConfig }[] = [];
  private defaults: Omit<DomainConfig, 'pattern'> = {};
  private loaded = false;
  private configPath: string;
  private watchController: AbortController | null = null;

  constructor() {
    this.configPath = envConfig.domains.configPath;
  }

  /**
   * Load configuration from file
   */
  async load(): Promise<void> {
    if (!existsSync(this.configPath)) {
      logger.info('Domain config file not found, using defaults', {
        path: this.configPath,
      });
      this.loaded = true;
      return;
    }

    try {
      const content = await readFile(this.configPath, 'utf-8');
      const parsed = parseYaml(content) as DomainConfigFile;

      // Validate version
      if (!parsed.version) {
        logger.warn('Domain config missing version, assuming v1');
      }

      // Load defaults
      if (parsed.defaults) {
        this.defaults = parsed.defaults;
      }

      // Clear existing configs
      this.configs.clear();
      this.patterns = [];

      // Load domain configs
      for (const domain of parsed.domains || []) {
        if (!domain.pattern) {
          logger.warn('Domain config missing pattern, skipping');
          continue;
        }

        // Convert pattern to regex
        const regexPattern = domain.pattern
          .replace(/\./g, '\\.')
          .replace(/\*/g, '.*');
        const regex = new RegExp(`^${regexPattern}$`, 'i');

        this.patterns.push({ regex, config: domain });

        // Also store by exact pattern for fast lookups
        this.configs.set(domain.pattern, domain);
      }

      this.loaded = true;
      logger.info('Domain config loaded', {
        path: this.configPath,
        domainCount: this.patterns.length,
        hasDefaults: Boolean(parsed.defaults),
      });
    } catch (error) {
      logger.error('Failed to load domain config', {
        path: this.configPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Start watching for config changes
   */
  async startWatching(): Promise<void> {
    if (!existsSync(this.configPath)) {
      return;
    }

    this.watchController = new AbortController();

    try {
      const watcher = watch(this.configPath, { signal: this.watchController.signal });
      for await (const event of watcher) {
        if (event.eventType === 'change') {
          logger.info('Domain config file changed, reloading');
          await this.load();
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).name !== 'AbortError') {
        logger.error('Domain config watch error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Stop watching for config changes
   */
  stopWatching(): void {
    if (this.watchController) {
      this.watchController.abort();
      this.watchController = null;
    }
  }

  /**
   * Get configuration for a domain
   */
  getConfig(domain: string): DomainConfig | null {
    if (!this.loaded) {
      logger.warn('Domain config not loaded, returning null');
      return null;
    }

    // Try exact match first
    const exact = this.configs.get(domain);
    if (exact) {
      return this.mergeWithDefaults(exact);
    }

    // Try pattern matching
    for (const { regex, config } of this.patterns) {
      if (regex.test(domain)) {
        return this.mergeWithDefaults(config);
      }
    }

    // Return defaults if available
    if (Object.keys(this.defaults).length > 0) {
      return { pattern: domain, ...this.defaults };
    }

    return null;
  }

  /**
   * Get configuration for a URL
   */
  getConfigForUrl(url: string): DomainConfig | null {
    try {
      const parsed = new URL(url);
      return this.getConfig(parsed.hostname);
    } catch {
      logger.warn('Invalid URL for domain config lookup', { url });
      return null;
    }
  }

  /**
   * Merge domain config with defaults
   */
  private mergeWithDefaults(config: DomainConfig): DomainConfig {
    return {
      ...config,
      rendering: { ...this.defaults.rendering, ...config.rendering },
      rateLimit: { ...this.defaults.rateLimit, ...config.rateLimit },
      extraction: { ...this.defaults.extraction, ...config.extraction },
      session: { ...this.defaults.session, ...config.session },
    };
  }

  /**
   * Check if a domain requires JavaScript rendering
   */
  requiresJavaScript(domain: string): boolean {
    const config = this.getConfig(domain);
    return config?.rendering?.requiresJavaScript ?? false;
  }

  /**
   * Get wait selectors for a domain
   */
  getWaitSelectors(domain: string): string[] {
    const config = this.getConfig(domain);
    return config?.rendering?.waitForSelectors ?? [];
  }

  /**
   * Get rate limit for a domain
   */
  getRateLimit(domain: string): DomainRateLimitConfig | null {
    const config = this.getConfig(domain);
    return config?.rateLimit ?? null;
  }

  /**
   * Check if domain is enabled
   */
  isEnabled(domain: string): boolean {
    const config = this.getConfig(domain);
    return config?.enabled ?? true;
  }

  /**
   * Get all configured domains
   */
  getConfiguredDomains(): string[] {
    return Array.from(this.configs.keys());
  }

  /**
   * Add or update a domain configuration at runtime
   */
  setConfig(domain: string, config: DomainConfig): void {
    this.configs.set(domain, config);

    // Update patterns array
    const regexPattern = domain.replace(/\./g, '\\.').replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexPattern}$`, 'i');

    const existingIndex = this.patterns.findIndex((p) => p.config.pattern === domain);
    if (existingIndex >= 0) {
      this.patterns[existingIndex] = { regex, config };
    } else {
      this.patterns.push({ regex, config });
    }

    logger.info('Domain config updated', { domain, enabled: config.enabled });
  }

  /**
   * Remove a domain configuration
   */
  removeConfig(domain: string): boolean {
    const existed = this.configs.delete(domain);
    if (existed) {
      this.patterns = this.patterns.filter((p) => p.config.pattern !== domain);
      logger.info('Domain config removed', { domain });
    }
    return existed;
  }
}

// Global singleton
export const domainConfigManager = new DomainConfigManager();

/**
 * Initialize domain configuration system
 */
export async function initDomainConfig(): Promise<void> {
  await domainConfigManager.load();
  // Start watching in background (don't await)
  domainConfigManager.startWatching().catch((error) => {
    logger.error('Failed to start domain config watcher', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Shutdown domain configuration system
 */
export function shutdownDomainConfig(): void {
  domainConfigManager.stopWatching();
}
