/**
 * eBay Search Fetcher with Playwright
 *
 * Handles browser automation for eBay search results with bot detection bypass.
 * Production-grade with telemetry, retry logic, and error handling.
 *
 * @module extractors/ebay-search-fetcher
 */

import { chromium, Browser, Page } from 'playwright-core';
import { logger } from '../../utils/logger';

export interface FetchOptions {
  timeout?: number; // Milliseconds (default: 30000)
  waitForSelector?: string; // Wait for specific element
  retryAttempts?: number; // Number of retries (default: 3)
  userAgent?: string;
}

export interface FetchResult {
  success: boolean;
  html?: string;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
  metadata: {
    duration: number;
    retryCount: number;
    challengeDetected: boolean;
    browserUsed: boolean;
  };
}

/**
 * eBay Search Fetcher with Playwright for JavaScript rendering and bot detection bypass
 */
export class EbaySearchFetcher {
  private browser: Browser | null = null;
  private isInitialized = false;

  /**
   * Initialize browser instance
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      logger.info('Initializing Playwright browser for eBay search');

      // Use installed browser (handle version mismatch)
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
        `${process.env.HOME}/.cache/ms-playwright/chromium-1194/chrome-linux/chrome`;

      this.browser = await chromium.launch({
        headless: true,
        executablePath,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
        ],
      });

      this.isInitialized = true;
      logger.info('Playwright browser initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize browser', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Browser initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Fetch HTML from eBay search URL with bot detection bypass
   */
  async fetch(url: string, options?: FetchOptions): Promise<FetchResult> {
    const startTime = Date.now();
    let retryCount = 0;
    const maxRetries = options?.retryAttempts ?? 3;
    const timeout = options?.timeout ?? 30000;

    // Ensure browser is initialized
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.browser) {
      return {
        success: false,
        error: {
          code: 'BROWSER_NOT_INITIALIZED',
          message: 'Browser failed to initialize',
          recoverable: false,
        },
        metadata: {
          duration: Date.now() - startTime,
          retryCount: 0,
          challengeDetected: false,
          browserUsed: true,
        },
      };
    }

    // Retry loop
    while (retryCount <= maxRetries) {
      const page = await this.browser.newPage({
        userAgent: options?.userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      try {
        logger.debug('Fetching eBay search page', { url, attempt: retryCount + 1 });

        // Navigate to URL (use 'load' instead of 'networkidle' - eBay has continuous activity)
        const response = await page.goto(url, {
          waitUntil: 'load',
          timeout,
        });

        if (!response) {
          throw new Error('No response received from eBay');
        }

        // Check for bot detection challenge
        const challengeDetected = await this.detectChallenge(page);

        if (challengeDetected) {
          logger.warn('eBay challenge page detected, waiting for resolution', {
            attempt: retryCount + 1,
          });

          // Wait longer for challenge to resolve (eBay usually auto-redirects after ~10s)
          await page.waitForTimeout(12000);

          // Check if we're past the challenge
          const stillChallenged = await this.detectChallenge(page);
          if (stillChallenged) {
            retryCount++;
            await page.close();
            logger.warn('Challenge not resolved after 12s, retrying', {
              attempt: retryCount,
              maxRetries,
            });
            continue; // Retry
          }
        }

        // Wait for search results to load
        const resultsLoaded = await this.waitForSearchResults(page, timeout);

        if (!resultsLoaded) {
          logger.warn('Search results did not load in time', {
            url,
            attempt: retryCount + 1,
          });
          retryCount++;
          await page.close();
          continue; // Retry
        }

        // Get final HTML
        const html = await page.content();

        await page.close();

        logger.info('eBay search page fetched successfully', {
          url,
          htmlSize: html.length,
          duration: Date.now() - startTime,
          retryCount,
        });

        return {
          success: true,
          html,
          metadata: {
            duration: Date.now() - startTime,
            retryCount,
            challengeDetected,
            browserUsed: true,
          },
        };

      } catch (error) {
        await page.close();

        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Error fetching eBay search page', {
          url,
          error: errorMessage,
          attempt: retryCount + 1,
        });

        if (retryCount >= maxRetries) {
          return {
            success: false,
            error: {
              code: 'FETCH_FAILED',
              message: errorMessage,
              recoverable: false,
            },
            metadata: {
              duration: Date.now() - startTime,
              retryCount,
              challengeDetected: false,
              browserUsed: true,
            },
          };
        }

        retryCount++;
        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, retryCount), 10000)));
      }
    }

    // Should never reach here
    return {
      success: false,
      error: {
        code: 'MAX_RETRIES_EXCEEDED',
        message: `Failed after ${maxRetries} attempts`,
        recoverable: false,
      },
      metadata: {
        duration: Date.now() - startTime,
        retryCount,
        challengeDetected: false,
        browserUsed: true,
      },
    };
  }

  /**
   * Detect if we're on eBay's challenge/bot detection page
   */
  private async detectChallenge(page: Page): Promise<boolean> {
    try {
      // Check for challenge indicators
      const challengeTexts = [
        'Checking your browser',
        'Pardon Our Interruption',
        'Please wait',
        'Reference ID:',
      ];

      for (const text of challengeTexts) {
        const found = await page.locator(`text=${text}`).count();
        if (found > 0) {
          return true;
        }
      }

      // Check for challenge class names
      const challengeClasses = await page.$$('.pgHeading, .spinner-grow');
      return challengeClasses.length > 0;
    } catch (error) {
      logger.debug('Challenge detection error (non-fatal)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Wait for search results to appear on page
   */
  private async waitForSearchResults(page: Page, timeout: number): Promise<boolean> {
    try {
      // Try multiple selectors for search results
      const selectors = [
        'ul.srp-results',
        '.srp-river-results',
        'li.s-item',
        '[data-view="mi:1686|iid:1"]', // eBay's data attribute
      ];

      for (const selector of selectors) {
        try {
          await page.waitForSelector(selector, {
            timeout: timeout / selectors.length, // Divide timeout among selectors
            state: 'visible',
          });
          logger.debug('Found search results with selector', { selector });
          return true;
        } catch (e) {
          // Try next selector
          continue;
        }
      }

      return false;
    } catch (error) {
      logger.debug('Error waiting for search results', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Close browser and cleanup
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.isInitialized = false;
      logger.info('Playwright browser closed');
    }
  }
}

// Export singleton instance
export const ebaySearchFetcher = new EbaySearchFetcher();
