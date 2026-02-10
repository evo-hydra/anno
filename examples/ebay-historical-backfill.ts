/**
 * eBay Historical Data Backfill Script
 *
 * Patient, long-running scraper for building a sold price database.
 * Perfect for FlipIQ depreciation analysis.
 *
 * Features:
 * - Persistent browser sessions (avoids challenges)
 * - Progress tracking with checkpoints
 * - Automatic CAPTCHA detection and cooldown
 * - Graceful error handling and retries
 * - Slow, respectful rate limiting
 *
 * Usage:
 *   npx tsx examples/ebay-historical-backfill.ts urls.txt output.json
 *
 * urls.txt format (one URL per line):
 *   https://www.ebay.com/itm/123456789
 *   https://www.ebay.com/itm/987654321
 *   ...
 *
 * @module examples/ebay-historical-backfill
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { PersistentSessionManager } from '../src/services/persistent-session-manager';
import { JobTracker } from '../src/services/job-tracker';
import { ebayAdapter } from '../src/services/extractors/ebay-adapter';
import { logger } from '../src/utils/logger';

interface BackfillConfig {
  // Rate limiting (VERY conservative for long-running jobs)
  requestsPerMinute: number;
  delayBetweenRequestsMs: number;

  // Session management
  sessionMaxAge: number;
  sessionMaxRequests: number;
  sessionWarmingPages: number;

  // Job management
  checkpointInterval: number;
  maxRetries: number;

  // Output
  outputPath: string;
  exportInterval: number; // Export data every N items
}

const DEFAULT_CONFIG: BackfillConfig = {
  // Ultra-slow for stealth (2 requests/min)
  requestsPerMinute: 2,
  delayBetweenRequestsMs: 30000, // 30 seconds

  // Keep sessions alive for 2 hours
  sessionMaxAge: 2 * 60 * 60 * 1000,
  sessionMaxRequests: 120, // 2/min * 60 min = 120 per session
  sessionWarmingPages: 3,

  // Save progress every 10 items
  checkpointInterval: 10,
  maxRetries: 3,

  // Export data every 50 items
  outputPath: 'ebay-sold-prices.json',
  exportInterval: 50
};

export class EbayHistoricalBackfill {
  private config: BackfillConfig;
  private sessionManager: PersistentSessionManager;
  private jobTracker: JobTracker | null = null;
  private running = false;
  private itemsSinceExport = 0;

  constructor(config?: Partial<BackfillConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.sessionManager = new PersistentSessionManager({
      maxAge: this.config.sessionMaxAge,
      maxRequests: this.config.sessionMaxRequests,
      warmingPages: this.config.sessionWarmingPages,
      cookieStorePath: '.anno/sessions'
    });
  }

  /**
   * Load URLs from file
   */
  private async loadUrls(filePath: string): Promise<string[]> {
    const content = await readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')); // Skip empty lines and comments
  }

  /**
   * Start backfill job
   */
  async start(urlsFile: string, jobId?: string): Promise<void> {
    this.running = true;

    // Generate job ID if not provided
    const actualJobId = jobId || `ebay-backfill-${Date.now()}`;

    // Load or create job tracker
    this.jobTracker = await JobTracker.load(actualJobId, {
      checkpointInterval: this.config.checkpointInterval,
      maxRetries: this.config.maxRetries,
      checkpointPath: '.anno/jobs'
    });

    // Load URLs and add to job (won't overwrite existing items)
    const urls = await this.loadUrls(urlsFile);
    this.jobTracker.addItems(urls);

    logger.info('backfill job started', {
      jobId: actualJobId,
      totalItems: this.jobTracker.getStats().total,
      config: {
        requestsPerMinute: this.config.requestsPerMinute,
        sessionMaxRequests: this.config.sessionMaxRequests
      }
    });

    // Process items
    await this.processQueue();

    // Final save
    await this.export();
    await this.jobTracker.save();

    logger.info('backfill job completed', this.jobTracker.getStats());
  }

  /**
   * Process job queue
   */
  private async processQueue(): Promise<void> {
    while (this.running && !this.jobTracker!.isComplete()) {
      const item = this.jobTracker!.getNextItem();

      if (!item) {
        // No items available (might be waiting for retry delay)
        logger.debug('no items available, waiting...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      // Mark as processing
      this.jobTracker!.markProcessing(item.id);

      try {
        // Process item
        const result = await this.processItem(item.url);

        if (result.captcha) {
          // CAPTCHA detected - mark item and trigger cooldown
          this.jobTracker!.markCaptcha(item.id);
          await this.handleCaptchaCooldown();
        } else if (result.success) {
          // Success!
          this.jobTracker!.markCompleted(item.id, result.data);
          this.itemsSinceExport++;

          // Export periodically
          if (this.itemsSinceExport >= this.config.exportInterval) {
            await this.export();
            this.itemsSinceExport = 0;
          }
        } else {
          // Failed
          this.jobTracker!.markFailed(item.id, result.error || 'Unknown error');
        }
      } catch (error) {
        logger.error('unexpected error processing item', {
          itemId: item.id,
          error: (error as Error).message
        });
        this.jobTracker!.markFailed(item.id, (error as Error).message);
      }

      // Rate limiting - wait between requests
      if (this.running) {
        await this.rateLimit();
      }
    }
  }

  /**
   * Process a single eBay URL
   */
  private async processItem(url: string): Promise<{
    success: boolean;
    captcha?: boolean;
    data?: any;
    error?: string;
  }> {
    try {
      logger.debug('processing item', { url });

      // Get persistent session for eBay
      const context = await this.sessionManager.getSession('ebay.com');
      const page = await context.newPage();

      try {
        // Navigate to listing
        await page.goto(url, {
          waitUntil: 'networkidle',
          timeout: 30000
        });

        // Check for CAPTCHA
        const captchaResult = await this.sessionManager.detectCaptcha(page);
        if (captchaResult.detected) {
          logger.warn('captcha detected', { url, type: captchaResult.type });
          return { success: false, captcha: true };
        }

        // Extract data using eBay adapter
        const html = await page.content();
        const listing = ebayAdapter.extract(html, url);

        // Validate extraction
        if (!listing.soldPrice) {
          return {
            success: false,
            error: 'No sold price found (might not be a sold listing)'
          };
        }

        logger.info('item extracted successfully', {
          url,
          title: listing.title,
          price: listing.soldPrice,
          confidence: listing.confidence
        });

        return {
          success: true,
          data: listing
        };
      } finally {
        await page.close();
      }
    } catch (error) {
      logger.error('failed to process item', {
        url,
        error: (error as Error).message
      });

      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * Handle CAPTCHA cooldown
   */
  private async handleCaptchaCooldown(): Promise<void> {
    logger.warn('entering captcha cooldown mode');

    // Close eBay session
    await this.sessionManager.closeSession('ebay.com');

    // Cooldown period (15-30 minutes)
    const cooldownMinutes = 15 + Math.random() * 15;
    logger.info('cooling down', { minutes: cooldownMinutes.toFixed(1) });

    await new Promise(resolve =>
      setTimeout(resolve, cooldownMinutes * 60 * 1000)
    );

    // Reset CAPTCHA items back to pending
    this.jobTracker!.resetCaptchaItems();

    logger.info('cooldown complete, resuming...');
  }

  /**
   * Rate limiting delay
   */
  private async rateLimit(): Promise<void> {
    const baseDelay = this.config.delayBetweenRequestsMs;

    // Add jitter (±20%)
    const jitter = (Math.random() - 0.5) * 0.4;
    const delay = baseDelay * (1 + jitter);

    logger.debug('rate limit delay', { delayMs: Math.floor(delay) });
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Export data to JSON
   */
  private async export(): Promise<void> {
    if (!this.jobTracker) return;

    const data = this.jobTracker.exportData();

    try {
      await writeFile(
        this.config.outputPath,
        JSON.stringify(data, null, 2)
      );

      logger.info('data exported', {
        path: this.config.outputPath,
        items: data.length
      });
    } catch (error) {
      logger.error('failed to export data', { error });
    }
  }

  /**
   * Stop the backfill job
   */
  async stop(): Promise<void> {
    logger.info('stopping backfill job...');
    this.running = false;

    // Save final state
    if (this.jobTracker) {
      await this.jobTracker.save();
    }

    // Close all sessions
    await this.sessionManager.closeAll();

    logger.info('backfill job stopped');
  }
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error('Usage: npx tsx ebay-historical-backfill.ts <urls-file> [output-file] [job-id]');
    console.error('');
    console.error('Example:');
    console.error('  npx tsx ebay-historical-backfill.ts urls.txt sold-prices.json');
    console.error('');
    console.error('To resume a job:');
    console.error('  npx tsx ebay-historical-backfill.ts urls.txt sold-prices.json ebay-backfill-1234567890');
    process.exit(1);
  }

  const urlsFile = args[0];
  const outputFile = args[1] || 'ebay-sold-prices.json';
  const jobId = args[2];

  // Ensure directories exist
  await mkdir('.anno/sessions', { recursive: true });
  await mkdir('.anno/jobs', { recursive: true });

  // Create backfill instance
  const backfill = new EbayHistoricalBackfill({
    outputPath: outputFile,
    requestsPerMinute: 2, // Ultra-slow
    delayBetweenRequestsMs: 30000 // 30 seconds between requests
  });

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\nReceived SIGINT, shutting down gracefully...');
    await backfill.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\nReceived SIGTERM, shutting down gracefully...');
    await backfill.stop();
    process.exit(0);
  });

  // Start backfill
  try {
    await backfill.start(urlsFile, jobId);
  } catch (error) {
    logger.error('backfill failed', { error: (error as Error).message });
    await backfill.stop();
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export default EbayHistoricalBackfill;
