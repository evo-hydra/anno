/**
 * Robots.txt Parser and Compliance Manager
 *
 * Respects robots.txt directives including:
 * - User-agent matching (Anno + *)
 * - Disallow/Allow rules
 * - Crawl-delay directives
 *
 * @module robots-parser
 */

import robotsParser from 'robots-parser';
import { logger } from '../utils/logger';
import { config } from '../config/env';
import { validateUrl } from './url-validator';

interface RobotsTxtEntry {
  robots: ReturnType<typeof robotsParser>;
  crawlDelay: number; // milliseconds
  fetchedAt: number;
}

export class RobotsManager {
  private cache = new Map<string, RobotsTxtEntry>();
  private readonly cacheTTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly userAgent: string;
  private readonly respectRobots: boolean;

  constructor(userAgent?: string, respectRobots = true) {
    this.userAgent = userAgent || config.fetch.userAgent;
    this.respectRobots = respectRobots;
    logger.info(`RobotsManager: Initialized (userAgent: ${this.userAgent}, respect: ${respectRobots})`);
  }

  /**
   * Extract domain from URL for robots.txt lookup
   */
  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    } catch (error) {
      logger.error('RobotsManager: Invalid URL', {
        url,
        error: error instanceof Error ? error.message : String(error)
      });
      throw new Error(`Invalid URL: ${url}`);
    }
  }

  /**
   * Fetch robots.txt for a domain
   */
  private async fetchRobotsTxt(domain: string): Promise<string> {
    const robotsUrl = `${domain}/robots.txt`;

    try {
      // SSRF protection: validate the robots.txt URL
      await validateUrl(robotsUrl);

      logger.debug('RobotsManager: Fetching robots.txt', { robotsUrl });

      const response = await fetch(robotsUrl, {
        headers: {
          'User-Agent': this.userAgent
        },
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });

      if (!response.ok) {
        if (response.status === 404) {
          logger.debug('RobotsManager: No robots.txt found (404), allowing all', { domain });
          return ''; // No robots.txt = allow all
        }
        logger.warn('RobotsManager: Failed to fetch robots.txt', {
          domain,
          status: response.status
        });
        return ''; // On error, be permissive
      }

      const text = await response.text();
      logger.debug('RobotsManager: Fetched robots.txt', {
        domain,
        size: text.length
      });

      return text;
    } catch (error) {
      logger.warn('RobotsManager: Error fetching robots.txt, allowing all', {
        domain,
        error: error instanceof Error ? error.message : 'unknown'
      });
      return ''; // On error, be permissive
    }
  }

  /**
   * Parse crawl-delay directive
   */
  private parseCrawlDelay(robots: ReturnType<typeof robotsParser>): number {
    // robots-parser library doesn't expose crawl-delay directly
    // We need to parse it manually from the rules
    const crawlDelayMatch = robots.toString().match(/Crawl-delay:\s*(\d+)/i);
    if (crawlDelayMatch) {
      const seconds = parseInt(crawlDelayMatch[1], 10);
      logger.debug('RobotsManager: Found crawl-delay', { seconds });
      return seconds * 1000; // Convert to ms
    }
    return 0;
  }

  /**
   * Get robots.txt entry for domain (with caching)
   */
  private async getRobotsEntry(domain: string): Promise<RobotsTxtEntry> {
    // Check cache
    const cached = this.cache.get(domain);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTTL) {
      logger.debug('RobotsManager: Cache hit', { domain });
      return cached;
    }

    // Fetch and parse
    const robotsTxt = await this.fetchRobotsTxt(domain);
    const robots = robotsParser(`${domain}/robots.txt`, robotsTxt);
    const crawlDelay = this.parseCrawlDelay(robots);

    const entry: RobotsTxtEntry = {
      robots,
      crawlDelay,
      fetchedAt: Date.now()
    };

    this.cache.set(domain, entry);
    logger.info('RobotsManager: Cached robots.txt', {
      domain,
      crawlDelay: crawlDelay > 0 ? `${crawlDelay}ms` : 'none'
    });

    return entry;
  }

  /**
   * Check if URL is allowed by robots.txt
   */
  async isAllowed(url: string): Promise<boolean> {
    if (!this.respectRobots) {
      return true;
    }

    try {
      const domain = this.extractDomain(url);
      const entry = await this.getRobotsEntry(domain);
      const allowed = entry.robots.isAllowed(url, this.userAgent);

      logger.debug('RobotsManager: Checked URL', {
        url,
        userAgent: this.userAgent,
        allowed
      });

      return allowed ?? true; // If undefined, allow
    } catch (error) {
      logger.error('RobotsManager: Error checking robots.txt', {
        url,
        error: error instanceof Error ? error.message : 'unknown'
      });
      return true; // On error, be permissive
    }
  }

  /**
   * Get crawl delay for domain (in milliseconds)
   */
  async getCrawlDelay(url: string): Promise<number> {
    if (!this.respectRobots) {
      return 0;
    }

    try {
      const domain = this.extractDomain(url);
      const entry = await this.getRobotsEntry(domain);
      return entry.crawlDelay;
    } catch (error) {
      logger.error('RobotsManager: Error getting crawl delay', {
        url,
        error: error instanceof Error ? error.message : 'unknown'
      });
      return 0;
    }
  }

  /**
   * Check if URL is allowed and throw error if blocked
   */
  async checkAndEnforce(url: string): Promise<void> {
    const allowed = await this.isAllowed(url);
    if (!allowed) {
      const error = new Error(`Blocked by robots.txt: ${url}`);
      error.name = 'RobotsBlockedError';
      throw error;
    }
  }

  /**
   * Clear cache for domain or all domains
   */
  clearCache(domain?: string): void {
    if (domain) {
      this.cache.delete(domain);
      logger.info('RobotsManager: Cleared cache', { domain });
    } else {
      this.cache.clear();
      logger.info('RobotsManager: Cleared all cache');
    }
  }

  /**
   * Get cache stats
   */
  getCacheStats(): { domains: number; entries: string[] } {
    return {
      domains: this.cache.size,
      entries: Array.from(this.cache.keys())
    };
  }
}

// Global singleton instance
export const robotsManager = new RobotsManager(config.fetch.userAgent, config.fetch.respectRobots);
