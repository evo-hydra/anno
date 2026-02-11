/**
 * Persistent Session Manager for Long-Running Data Collection
 *
 * Keeps browser sessions alive for hours/days to avoid repeated challenges.
 * Perfect for legacy data backfills where speed doesn't matter.
 *
 * Features:
 * - Cookie persistence to disk
 * - Session warming (natural browsing before scraping)
 * - Automatic session rotation
 * - Graceful CAPTCHA detection with pause/retry
 * - Progress tracking for long jobs
 *
 * @module services/persistent-session-manager
 */

import { type BrowserContext, type Page } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger';
import { rendererManager } from './renderer';

interface SessionMetadata {
  domain: string;
  createdAt: number;
  lastUsedAt: number;
  requestCount: number;
  cookiesPath: string;
  warmed: boolean;
}

interface SessionState {
  context: BrowserContext;
  metadata: SessionMetadata;
}

interface CaptchaDetectionResult {
  detected: boolean;
  type?: 'recaptcha' | 'hcaptcha' | 'perimeter-x' | 'cloudflare' | 'unknown';
  selector?: string;
}

interface SessionConfig {
  maxAge: number;              // Max session age in ms (default: 2 hours)
  maxRequests: number;         // Max requests per session (default: 100)
  warmingPages: number;        // Pages to visit during warming (default: 3)
  cookieStorePath: string;     // Path to store cookies (default: .anno/sessions)
  sessionRotationDelay: number; // Delay before creating new session (default: 5 min)
}

const DEFAULT_CONFIG: SessionConfig = {
  maxAge: 2 * 60 * 60 * 1000,      // 2 hours
  maxRequests: 100,                 // 100 requests per session
  warmingPages: 3,                  // Visit 3 pages during warming
  cookieStorePath: '.anno/sessions',
  sessionRotationDelay: 5 * 60 * 1000  // 5 minutes
};

export class PersistentSessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private config: SessionConfig;
  private warmingInProgress: Map<string, Promise<void>> = new Map();

  constructor(config?: Partial<SessionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureStorageDirectory();
  }

  private async ensureStorageDirectory(): Promise<void> {
    if (!existsSync(this.config.cookieStorePath)) {
      await mkdir(this.config.cookieStorePath, { recursive: true });
    }
  }

  /**
   * Get or create a warm session for a domain
   */
  async getSession(domain: string): Promise<BrowserContext> {
    // Check if we have a valid session
    const existing = this.sessions.get(domain);
    if (existing && this.isSessionValid(existing)) {
      existing.metadata.lastUsedAt = Date.now();
      existing.metadata.requestCount++;
      logger.debug('reusing session', {
        domain,
        age: Date.now() - existing.metadata.createdAt,
        requests: existing.metadata.requestCount
      });
      return existing.context;
    }

    // Clean up old session if exists
    if (existing) {
      await this.closeSession(domain);
    }

    // Create new session
    return await this.createSession(domain);
  }

  /**
   * Create a new browser session with warming
   */
  private async createSession(domain: string): Promise<BrowserContext> {
    // Check if warming is already in progress
    const warmingPromise = this.warmingInProgress.get(domain);
    if (warmingPromise) {
      await warmingPromise;
      const session = this.sessions.get(domain);
      if (session) {
        return session.context;
      }
    }

    // Start warming process
    const warming = this._createAndWarmSession(domain);
    this.warmingInProgress.set(domain, warming);

    try {
      await warming;
      const session = this.sessions.get(domain);
      if (!session) {
        throw new Error('Session creation failed');
      }
      return session.context;
    } finally {
      this.warmingInProgress.delete(domain);
    }
  }

  private async _createAndWarmSession(domain: string): Promise<void> {
    logger.info('creating new session', { domain });

    // Create context
    const context = await this.createBrowserContext(domain);

    const metadata: SessionMetadata = {
      domain,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      requestCount: 0,
      cookiesPath: join(this.config.cookieStorePath, `${domain}.json`),
      warmed: false
    };

    // Store session
    this.sessions.set(domain, { context, metadata });

    // Warm the session (browse naturally)
    await this.warmSession(domain, context);

    // Save cookies
    await this.saveCookies(domain, context);

    metadata.warmed = true;
    logger.info('session ready', { domain, warmed: true });
  }

  /**
   * Create browser context with saved cookies if available
   */
  private async createBrowserContext(domain: string): Promise<BrowserContext> {
    // Get browser instance (initializes if needed)
    const browser = await rendererManager.getBrowser();

    // Random viewport for anti-detection
    const viewportWidth = 1920 + Math.floor(Math.random() * 200 - 100);
    const viewportHeight = 1080 + Math.floor(Math.random() * 200 - 100);

    // Enhanced user agents for stealth
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    ];
    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

    // Create new context (persistent - won't be closed by us)
    const context = await browser.newContext({
      userAgent: randomUserAgent,
      viewport: { width: viewportWidth, height: viewportHeight },
      locale: 'en-US',
      timezoneId: 'America/New_York'
    });

    // Load saved cookies if available
    const cookiesPath = join(this.config.cookieStorePath, `${domain}.json`);
    if (existsSync(cookiesPath)) {
      try {
        const cookiesData = await readFile(cookiesPath, 'utf-8');
        const cookies = JSON.parse(cookiesData);
        await context.addCookies(cookies);
        logger.info('loaded saved cookies', { domain, count: cookies.length });
      } catch (error) {
        logger.warn('failed to load cookies', { domain, error });
      }
    }

    return context;
  }

  /**
   * Warm session by browsing naturally (key to avoiding challenges!)
   */
  private async warmSession(domain: string, context: BrowserContext): Promise<void> {
    logger.info('warming session', { domain, pages: this.config.warmingPages });

    const page = await context.newPage();

    try {
      // Visit homepage first
      await page.goto(`https://www.${domain}`, {
        waitUntil: 'networkidle',
        timeout: 30000
      });
      await this.humanDelay(2000, 4000);

      // Scroll naturally
      await this.naturalScroll(page);
      await this.humanDelay(1000, 2000);

      // Visit a few more pages (categories, search results, etc.)
      for (let i = 0; i < this.config.warmingPages - 1; i++) {
        try {
          // Click a random link (avoid external links)
          const links = await page.locator('a[href^="/"]').all();
          if (links.length > 0) {
            const randomLink = links[Math.floor(Math.random() * Math.min(10, links.length))];
            await randomLink.click();
            await page.waitForLoadState('networkidle', { timeout: 15000 });
            await this.humanDelay(2000, 4000);
            await this.naturalScroll(page);
          }
        } catch (error) {
          logger.debug('warming navigation error (non-fatal)', { error });
        }
      }

      logger.info('session warmed successfully', { domain });
    } catch (error) {
      logger.error('session warming failed', { domain, error });
      throw error;
    } finally {
      await page.close();
    }
  }

  /**
   * Natural scrolling behavior
   */
  private async naturalScroll(page: Page): Promise<void> {
    const scrollSteps = 3 + Math.floor(Math.random() * 3);
    const viewportHeight = page.viewportSize()?.height || 1080;

    for (let i = 0; i < scrollSteps; i++) {
      const scrollAmount = Math.floor(Math.random() * (viewportHeight / 2)) + 100;
      await page.mouse.wheel(0, scrollAmount);
      await this.humanDelay(300, 800);
    }

    // Scroll back up a bit (humans do this)
    if (Math.random() > 0.5) {
      await page.mouse.wheel(0, -200);
      await this.humanDelay(200, 500);
    }
  }

  /**
   * Human-like delay
   */
  private async humanDelay(minMs: number, maxMs: number): Promise<void> {
    const delay = minMs + Math.random() * (maxMs - minMs);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Save cookies to disk for session recovery
   */
  private async saveCookies(domain: string, context: BrowserContext): Promise<void> {
    try {
      const cookies = await context.cookies();
      const cookiesPath = join(this.config.cookieStorePath, `${domain}.json`);
      await writeFile(cookiesPath, JSON.stringify(cookies, null, 2));
      logger.debug('cookies saved', { domain, count: cookies.length });
    } catch (error) {
      logger.error('failed to save cookies', { domain, error });
    }
  }

  /**
   * Check if session is still valid
   */
  private isSessionValid(session: SessionState): boolean {
    const age = Date.now() - session.metadata.createdAt;
    const tooOld = age > this.config.maxAge;
    const tooManyRequests = session.metadata.requestCount >= this.config.maxRequests;
    const notWarmed = !session.metadata.warmed;

    if (tooOld) {
      logger.debug('session expired (age)', {
        domain: session.metadata.domain,
        age
      });
    }
    if (tooManyRequests) {
      logger.debug('session expired (requests)', {
        domain: session.metadata.domain,
        requests: session.metadata.requestCount
      });
    }

    return !tooOld && !tooManyRequests && !notWarmed;
  }

  /**
   * Close a session and save cookies
   */
  async closeSession(domain: string): Promise<void> {
    const session = this.sessions.get(domain);
    if (!session) {
      return;
    }

    logger.info('closing session', {
      domain,
      age: Date.now() - session.metadata.createdAt,
      requests: session.metadata.requestCount
    });

    try {
      await this.saveCookies(domain, session.context);
      await session.context.close();
    } catch (error) {
      logger.error('error closing session', { domain, error });
    }

    this.sessions.delete(domain);
  }

  /**
   * Detect CAPTCHA challenges on page
   */
  async detectCaptcha(page: Page): Promise<CaptchaDetectionResult> {
    const detectors = [
      { selector: '#px-captcha', type: 'perimeter-x' as const },
      { selector: '.g-recaptcha', type: 'recaptcha' as const },
      { selector: 'iframe[src*="recaptcha"]', type: 'recaptcha' as const },
      { selector: 'iframe[src*="hcaptcha"]', type: 'hcaptcha' as const },
      { selector: '.challenge-form', type: 'cloudflare' as const },
      { selector: '#challenge-form', type: 'cloudflare' as const },
      { selector: '[id*="captcha"]', type: 'unknown' as const }
    ];

    for (const detector of detectors) {
      try {
        const element = page.locator(detector.selector);
        const visible = await element.isVisible({ timeout: 1000 });
        if (visible) {
          logger.warn('captcha detected', { type: detector.type, selector: detector.selector });
          return { detected: true, type: detector.type, selector: detector.selector };
        }
      } catch {
        // Element not found, continue
      }
    }

    // Check for common challenge text
    const bodyText = await page.locator('body').textContent();
    if (bodyText) {
      const challengeIndicators = [
        'verify you are human',
        'checking your browser',
        'security check',
        'unusual traffic',
        'automated requests'
      ];

      for (const indicator of challengeIndicators) {
        if (bodyText.toLowerCase().includes(indicator)) {
          logger.warn('challenge text detected', { indicator });
          return { detected: true, type: 'unknown' };
        }
      }
    }

    return { detected: false };
  }

  /**
   * Handle CAPTCHA detection (pause and wait strategy)
   */
  async handleCaptcha(domain: string, detection: CaptchaDetectionResult): Promise<void> {
    logger.error('captcha challenge encountered', {
      domain,
      type: detection.type,
      strategy: 'pause-and-rotate'
    });

    // Close the challenged session
    await this.closeSession(domain);

    // Wait before creating a new session (let the IP cool down)
    const cooldownMinutes = 10 + Math.random() * 10; // 10-20 minutes
    logger.info('cooling down before session rotation', {
      domain,
      cooldownMinutes: cooldownMinutes.toFixed(1)
    });

    await new Promise(resolve => setTimeout(resolve, cooldownMinutes * 60 * 1000));

    // Create a new session (will auto-warm)
    logger.info('rotating session after cooldown', { domain });
  }

  /**
   * Close all sessions
   */
  async closeAll(): Promise<void> {
    logger.info('closing all sessions', { count: this.sessions.size });

    const promises = Array.from(this.sessions.keys()).map(domain =>
      this.closeSession(domain)
    );

    await Promise.all(promises);
  }

  /**
   * Get session statistics
   */
  getStats(): Record<string, { age: number; lastUsed: number; requestCount: number; warmed: boolean }> {
    const stats: Record<string, { age: number; lastUsed: number; requestCount: number; warmed: boolean }> = {};

    for (const [domain, session] of this.sessions.entries()) {
      stats[domain] = {
        age: Date.now() - session.metadata.createdAt,
        lastUsed: Date.now() - session.metadata.lastUsedAt,
        requestCount: session.metadata.requestCount,
        warmed: session.metadata.warmed
      };
    }

    return stats;
  }
}

// Global instance
export const persistentSessionManager = new PersistentSessionManager();
