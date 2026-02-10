/**
 * Backfill Job Executor
 *
 * Generalized system for long-running marketplace scraping jobs with
 * checkpointing, error handling, and compliance enforcement.
 *
 * @module backfill-executor
 */

import { randomUUID } from 'crypto';
import { readFile, writeFile, appendFile, access, constants } from 'fs/promises';
import { logger } from '../../utils/logger';
import { BackfillJob, BackfillStatus, MarketplaceType, MarketplaceListing } from './marketplace-adapter';
import { MarketplaceRegistry } from './marketplace-registry';
import {
  extractionEventPipeline,
  createExtractionEvent,
} from './extraction-event-pipeline';

/**
 * Database connection interface for backfill persistence
 */
interface DatabaseConnection {
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }>;
  close(): Promise<void>;
}

/**
 * Database adapter factory - override for custom database support
 */
let databaseAdapterFactory: ((connectionString: string) => Promise<DatabaseConnection>) | null = null;

/**
 * Register a database adapter for backfill operations
 */
export function registerDatabaseAdapter(
  factory: (connectionString: string) => Promise<DatabaseConnection>
): void {
  databaseAdapterFactory = factory;
}

/**
 * CSV field definitions for MarketplaceListing
 */
const CSV_FIELDS = [
  'id',
  'marketplace',
  'url',
  'title',
  'description',
  'price_amount',
  'price_currency',
  'original_price_amount',
  'original_price_currency',
  'shipping_cost_amount',
  'shipping_cost_currency',
  'condition',
  'availability',
  'sold_date',
  'quantity_available',
  'seller_id',
  'seller_name',
  'seller_rating',
  'seller_review_count',
  'seller_verified',
  'images',
  'item_number',
  'category',
  'extracted_at',
  'extraction_method',
  'confidence',
  'raw_data_hash',
  'extractor_version',
] as const;

/**
 * URL source interface
 */
interface UrlSource {
  /**
   * Get next batch of URLs
   */
  next(batchSize: number): Promise<string[]>;

  /**
   * Check if there are more URLs
   */
  hasMore(): Promise<boolean>;

  /**
   * Get total URL count (if known)
   */
  getTotal(): Promise<number | null>;
}

/**
 * File-based URL source
 */
class FileUrlSource implements UrlSource {
  private urls: string[];
  private currentIndex: number;

  constructor(urls: string[]) {
    this.urls = urls;
    this.currentIndex = 0;
  }

  async next(batchSize: number): Promise<string[]> {
    const batch = this.urls.slice(this.currentIndex, this.currentIndex + batchSize);
    this.currentIndex += batchSize;
    return batch;
  }

  async hasMore(): Promise<boolean> {
    return this.currentIndex < this.urls.length;
  }

  async getTotal(): Promise<number | null> {
    return this.urls.length;
  }

  static async fromFile(filePath: string): Promise<FileUrlSource> {
    const content = await readFile(filePath, 'utf-8');
    const urls = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    return new FileUrlSource(urls);
  }
}

/**
 * Job checkpoint
 */
interface Checkpoint {
  jobId: string;
  timestamp: string;
  processedUrls: number;
  successfulExtractions: number;
  failedExtractions: number;
  lastProcessedUrl?: string;
}

/**
 * Backfill job executor
 */
export class BackfillExecutor {
  private jobs: Map<string, RunningJob>;
  private registry: MarketplaceRegistry;
  private csvHeadersWritten: Set<string>;
  private databaseConnections: Map<string, DatabaseConnection>;

  constructor(registry: MarketplaceRegistry) {
    this.jobs = new Map();
    this.registry = registry;
    this.csvHeadersWritten = new Set();
    this.databaseConnections = new Map();
  }

  /**
   * Start a backfill job
   */
  async start(job: BackfillJob): Promise<void> {
    logger.info('Starting backfill job', {
      jobId: job.jobId,
      marketplace: job.marketplace,
    });

    // Check if marketplace is enabled
    if (!this.registry.isEnabled(job.marketplace)) {
      throw new Error(`Marketplace ${job.marketplace} is not enabled`);
    }

    // Check if job already running
    if (this.jobs.has(job.jobId)) {
      throw new Error(`Job ${job.jobId} is already running`);
    }

    // Create URL source
    const urlSource = await this.createUrlSource(job);

    // Create running job
    const runningJob: RunningJob = {
      job,
      urlSource,
      state: 'running',
      startedAt: new Date().toISOString(),
      progress: {
        totalUrls: (await urlSource.getTotal()) || 0,
        processedUrls: 0,
        successfulExtractions: 0,
        failedExtractions: 0,
        averageConfidence: 0,
      },
      consecutiveFailures: 0,
      cancelRequested: false,
    };

    this.jobs.set(job.jobId, runningJob);

    // Start execution in background
    this.executeJob(runningJob).catch((error) => {
      logger.error('Job execution error', {
        jobId: job.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Pause a running job
   */
  async pause(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    job.state = 'paused';
    logger.info('Job paused', { jobId });
  }

  /**
   * Resume a paused job
   */
  async resume(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    if (job.state !== 'paused') {
      throw new Error(`Job ${jobId} is not paused`);
    }

    job.state = 'running';
    logger.info('Job resumed', { jobId });
  }

  /**
   * Cancel a job
   */
  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    job.cancelRequested = true;
    job.state = 'failed';
    logger.info('Job cancelled', { jobId });
  }

  /**
   * Get job status
   */
  async getStatus(jobId: string): Promise<BackfillStatus> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const duration = Date.now() - new Date(job.startedAt).getTime();
    const estimatedCompletion = this.calculateEstimatedCompletion(job, duration);

    return {
      jobId,
      state: job.state,
      progress: job.progress,
      timing: {
        startedAt: job.startedAt,
        estimatedCompletion,
        duration,
      },
      currentCheckpoint: job.currentCheckpoint,
    };
  }

  /**
   * List all jobs
   */
  listJobs(): string[] {
    return Array.from(this.jobs.keys());
  }

  // =========================================================================
  // Private methods
  // =========================================================================

  /**
   * Execute job processing loop
   */
  private async executeJob(runningJob: RunningJob): Promise<void> {
    const { job, urlSource } = runningJob;

    try {
      while (await urlSource.hasMore()) {
        // Check for pause/cancel
        if (runningJob.state === 'paused') {
          await this.sleep(1000);
          continue;
        }

        if (runningJob.cancelRequested) {
          logger.info('Job cancelled by user', { jobId: job.jobId });
          return;
        }

        // Get next batch
        const urls = await urlSource.next(job.batchSize);
        if (urls.length === 0) break;

        // Process batch with concurrency control
        await this.processBatch(runningJob, urls);

        // Save checkpoint if enabled
        if (job.checkpoint.enabled && runningJob.progress.processedUrls % job.checkpoint.interval === 0) {
          await this.saveCheckpoint(runningJob);
        }
      }

      // Job completed
      runningJob.state = 'completed';
      logger.info('Job completed successfully', {
        jobId: job.jobId,
        processedUrls: runningJob.progress.processedUrls,
        successfulExtractions: runningJob.progress.successfulExtractions,
      });
    } catch (error) {
      runningJob.state = 'failed';
      logger.error('Job failed', {
        jobId: job.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Final checkpoint
      if (job.checkpoint.enabled) {
        await this.saveCheckpoint(runningJob);
      }
      // Clean up database connections
      await this.cleanupJobConnections(job.jobId);
    }
  }

  /**
   * Process a batch of URLs
   */
  private async processBatch(runningJob: RunningJob, urls: string[]): Promise<void> {
    const { job } = runningJob;

    // Process with concurrency limit
    const concurrency = job.concurrency;
    const results: Array<{ success: boolean; confidence?: number }> = [];

    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      const promises = batch.map((url) => this.processUrl(runningJob, url));
      const batchResults = await Promise.allSettled(promises);

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({ success: false });
        }
      }
    }

    // Update progress
    for (const result of results) {
      runningJob.progress.processedUrls++;

      if (result.success) {
        runningJob.progress.successfulExtractions++;
        runningJob.consecutiveFailures = 0;

        if (result.confidence !== undefined) {
          // Update rolling average confidence
          const total = runningJob.progress.successfulExtractions;
          const oldAvg = runningJob.progress.averageConfidence;
          runningJob.progress.averageConfidence = (oldAvg * (total - 1) + result.confidence) / total;
        }
      } else {
        runningJob.progress.failedExtractions++;
        runningJob.consecutiveFailures++;

        // Check for too many failures
        if (
          runningJob.consecutiveFailures >= job.errorHandling.maxConsecutiveFailures &&
          job.errorHandling.pauseOnError
        ) {
          runningJob.state = 'paused';
          logger.warn('Job paused due to consecutive failures', {
            jobId: job.jobId,
            consecutiveFailures: runningJob.consecutiveFailures,
          });
          break;
        }
      }
    }
  }

  /**
   * Process a single URL
   */
  private async processUrl(
    runningJob: RunningJob,
    url: string
  ): Promise<{ success: boolean; confidence?: number }> {
    const { job } = runningJob;
    const startTime = Date.now();

    try {
      // Extract using registry
      const result = await this.registry.extractListing(url);

      if (result.success && result.listing) {
        // Emit success event
        if (job.output.emitEvents) {
          const event = createExtractionEvent({
            eventType: 'extraction_success',
            marketplace: job.marketplace,
            url,
            listing: result.listing,
            duration: Date.now() - startTime,
            extractorVersion: 'backfill-executor',
            adapterVersion: result.listing.extractorVersion,
            rateLimited: result.metadata.rateLimited,
            retryCount: result.metadata.retryCount,
          });
          await extractionEventPipeline.emit(event);
        }

        // Write to output
        await this.writeOutput(runningJob, result.listing);

        return { success: true, confidence: result.listing.confidence };
      } else {
        // Emit failure event
        if (job.output.emitEvents) {
          const event = createExtractionEvent({
            eventType: 'extraction_failure',
            marketplace: job.marketplace,
            url,
            duration: Date.now() - startTime,
            extractorVersion: 'backfill-executor',
            adapterVersion: 'unknown',
            validationErrors: result.error ? [result.error.message] : [],
          });
          await extractionEventPipeline.emit(event);
        }

        return { success: false };
      }
    } catch (error) {
      logger.error('URL processing error', {
        jobId: job.jobId,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false };
    }
  }

  /**
   * Write extraction output
   */
  private async writeOutput(runningJob: RunningJob, listing: MarketplaceListing): Promise<void> {
    const { job } = runningJob;

    try {
      if (job.output.format === 'jsonl') {
        await appendFile(job.output.destination, JSON.stringify(listing) + '\n', 'utf-8');
      } else if (job.output.format === 'csv') {
        await this.writeCsvOutput(runningJob, listing);
      } else if (job.output.format === 'database') {
        await this.writeDatabaseOutput(runningJob, listing);
      }
    } catch (error) {
      logger.error('Failed to write output', {
        jobId: job.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Write CSV output
   */
  private async writeCsvOutput(runningJob: RunningJob, listing: MarketplaceListing): Promise<void> {
    const { job } = runningJob;
    const csvPath = job.output.destination;

    // Write header if this is the first row for this file
    if (!this.csvHeadersWritten.has(csvPath)) {
      const fileExists = await this.fileExists(csvPath);
      if (!fileExists) {
        const header = CSV_FIELDS.join(',') + '\n';
        await writeFile(csvPath, header, 'utf-8');
      }
      this.csvHeadersWritten.add(csvPath);
    }

    // Convert listing to CSV row
    const row = this.listingToCsvRow(listing);
    await appendFile(csvPath, row + '\n', 'utf-8');
  }

  /**
   * Convert a MarketplaceListing to a CSV row
   */
  private listingToCsvRow(listing: MarketplaceListing): string {
    const values: string[] = [
      this.escapeCsvValue(listing.id),
      this.escapeCsvValue(listing.marketplace),
      this.escapeCsvValue(listing.url),
      this.escapeCsvValue(listing.title),
      this.escapeCsvValue(listing.description || ''),
      this.escapeCsvValue(listing.price?.amount?.toString() || ''),
      this.escapeCsvValue(listing.price?.currency || ''),
      this.escapeCsvValue(listing.originalPrice?.amount?.toString() || ''),
      this.escapeCsvValue(listing.originalPrice?.currency || ''),
      this.escapeCsvValue(listing.shippingCost?.amount?.toString() || ''),
      this.escapeCsvValue(listing.shippingCost?.currency || ''),
      this.escapeCsvValue(listing.condition || ''),
      this.escapeCsvValue(listing.availability),
      this.escapeCsvValue(listing.soldDate || ''),
      this.escapeCsvValue(listing.quantityAvailable?.toString() || ''),
      this.escapeCsvValue(listing.seller.id || ''),
      this.escapeCsvValue(listing.seller.name || ''),
      this.escapeCsvValue(listing.seller.rating?.toString() || ''),
      this.escapeCsvValue(listing.seller.reviewCount?.toString() || ''),
      this.escapeCsvValue(listing.seller.verified?.toString() || ''),
      this.escapeCsvValue(listing.images.join('|')),
      this.escapeCsvValue(listing.itemNumber || ''),
      this.escapeCsvValue(listing.category?.join('|') || ''),
      this.escapeCsvValue(listing.extractedAt),
      this.escapeCsvValue(listing.extractionMethod),
      this.escapeCsvValue(listing.confidence.toString()),
      this.escapeCsvValue(listing.rawDataHash || ''),
      this.escapeCsvValue(listing.extractorVersion),
    ];

    return values.join(',');
  }

  /**
   * Escape a value for CSV output
   */
  private escapeCsvValue(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  /**
   * Check if a file exists
   */
  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write database output
   */
  private async writeDatabaseOutput(runningJob: RunningJob, listing: MarketplaceListing): Promise<void> {
    const { job } = runningJob;

    if (!databaseAdapterFactory) {
      logger.warn('Database output requested but no database adapter registered. Use registerDatabaseAdapter() to configure.');
      return;
    }

    // Get or create connection
    let connection = this.databaseConnections.get(job.jobId);
    if (!connection) {
      connection = await databaseAdapterFactory(job.output.destination);
      this.databaseConnections.set(job.jobId, connection);
    }

    // Insert listing into database
    const sql = `
      INSERT INTO marketplace_listings (
        id, marketplace, url, title, description,
        price_amount, price_currency,
        original_price_amount, original_price_currency,
        shipping_cost_amount, shipping_cost_currency,
        condition, availability, sold_date, quantity_available,
        seller_id, seller_name, seller_rating, seller_review_count, seller_verified,
        images, item_number, category,
        extracted_at, extraction_method, confidence,
        raw_data_hash, extractor_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id, marketplace) DO UPDATE SET
        url = EXCLUDED.url,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        price_amount = EXCLUDED.price_amount,
        price_currency = EXCLUDED.price_currency,
        extracted_at = EXCLUDED.extracted_at,
        confidence = EXCLUDED.confidence
    `;

    const params = [
      listing.id,
      listing.marketplace,
      listing.url,
      listing.title,
      listing.description || null,
      listing.price?.amount || null,
      listing.price?.currency || null,
      listing.originalPrice?.amount || null,
      listing.originalPrice?.currency || null,
      listing.shippingCost?.amount || null,
      listing.shippingCost?.currency || null,
      listing.condition || null,
      listing.availability,
      listing.soldDate || null,
      listing.quantityAvailable || null,
      listing.seller.id || null,
      listing.seller.name,
      listing.seller.rating || null,
      listing.seller.reviewCount || null,
      listing.seller.verified || null,
      JSON.stringify(listing.images),
      listing.itemNumber || null,
      listing.category ? JSON.stringify(listing.category) : null,
      listing.extractedAt,
      listing.extractionMethod,
      listing.confidence,
      listing.rawDataHash || null,
      listing.extractorVersion,
    ];

    await connection.execute(sql, params);
  }

  /**
   * Save job checkpoint
   */
  private async saveCheckpoint(runningJob: RunningJob): Promise<void> {
    const { job, progress } = runningJob;

    const checkpoint: Checkpoint = {
      jobId: job.jobId,
      timestamp: new Date().toISOString(),
      processedUrls: progress.processedUrls,
      successfulExtractions: progress.successfulExtractions,
      failedExtractions: progress.failedExtractions,
    };

    if (job.checkpoint.storage === 'file') {
      const checkpointPath = `${job.output.destination}.checkpoint`;
      await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
      runningJob.currentCheckpoint = checkpointPath;
    } else if (job.checkpoint.storage === 'database') {
      await this.saveDatabaseCheckpoint(runningJob, checkpoint);
    }

    logger.debug('Checkpoint saved', {
      jobId: job.jobId,
      processedUrls: progress.processedUrls,
    });
  }

  /**
   * Save checkpoint to database
   */
  private async saveDatabaseCheckpoint(runningJob: RunningJob, checkpoint: Checkpoint): Promise<void> {
    const { job } = runningJob;

    if (!databaseAdapterFactory) {
      logger.warn('Database checkpoint requested but no database adapter registered. Use registerDatabaseAdapter() to configure.');
      return;
    }

    // Get or create connection
    let connection = this.databaseConnections.get(job.jobId);
    if (!connection) {
      connection = await databaseAdapterFactory(job.output.destination);
      this.databaseConnections.set(job.jobId, connection);
    }

    const sql = `
      INSERT INTO backfill_checkpoints (
        job_id, timestamp, processed_urls, successful_extractions, failed_extractions, last_processed_url
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (job_id) DO UPDATE SET
        timestamp = EXCLUDED.timestamp,
        processed_urls = EXCLUDED.processed_urls,
        successful_extractions = EXCLUDED.successful_extractions,
        failed_extractions = EXCLUDED.failed_extractions,
        last_processed_url = EXCLUDED.last_processed_url
    `;

    const params = [
      checkpoint.jobId,
      checkpoint.timestamp,
      checkpoint.processedUrls,
      checkpoint.successfulExtractions,
      checkpoint.failedExtractions,
      checkpoint.lastProcessedUrl || null,
    ];

    await connection.execute(sql, params);
    runningJob.currentCheckpoint = `database:${checkpoint.jobId}`;
  }

  /**
   * Load checkpoint from database
   */
  async loadDatabaseCheckpoint(jobId: string, connectionString: string): Promise<Checkpoint | null> {
    if (!databaseAdapterFactory) {
      logger.warn('Database checkpoint requested but no database adapter registered.');
      return null;
    }

    const connection = await databaseAdapterFactory(connectionString);
    try {
      const sql = `
        SELECT job_id, timestamp, processed_urls, successful_extractions, failed_extractions, last_processed_url
        FROM backfill_checkpoints
        WHERE job_id = ?
      `;

      const rows = await connection.query(sql, [jobId]);
      if (!rows || rows.length === 0) {
        return null;
      }

      const row = rows[0] as Record<string, unknown>;
      return {
        jobId: row.job_id as string,
        timestamp: row.timestamp as string,
        processedUrls: row.processed_urls as number,
        successfulExtractions: row.successful_extractions as number,
        failedExtractions: row.failed_extractions as number,
        lastProcessedUrl: row.last_processed_url as string | undefined,
      };
    } finally {
      await connection.close();
    }
  }

  /**
   * Clean up database connections when job completes
   */
  private async cleanupJobConnections(jobId: string): Promise<void> {
    const connection = this.databaseConnections.get(jobId);
    if (connection) {
      await connection.close();
      this.databaseConnections.delete(jobId);
    }
  }

  /**
   * Create URL source from job config
   */
  private async createUrlSource(job: BackfillJob): Promise<UrlSource> {
    if (job.urlSource.type === 'file') {
      return FileUrlSource.fromFile(job.urlSource.config.filePath);
    } else {
      throw new Error(`Unsupported URL source type: ${job.urlSource.type}`);
    }
  }

  /**
   * Calculate estimated completion time
   */
  private calculateEstimatedCompletion(runningJob: RunningJob, duration: number): string | undefined {
    const { progress } = runningJob;

    if (progress.totalUrls === 0 || progress.processedUrls === 0) {
      return undefined;
    }

    const avgTimePerUrl = duration / progress.processedUrls;
    const remainingUrls = progress.totalUrls - progress.processedUrls;
    const estimatedRemainingTime = avgTimePerUrl * remainingUrls;

    const estimatedCompletion = new Date(Date.now() + estimatedRemainingTime);
    return estimatedCompletion.toISOString();
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Running job state
 */
interface RunningJob {
  job: BackfillJob;
  urlSource: UrlSource;
  state: BackfillStatus['state'];
  startedAt: string;
  progress: BackfillStatus['progress'];
  consecutiveFailures: number;
  cancelRequested: boolean;
  currentCheckpoint?: string;
}

/**
 * Helper to create a backfill job
 */
export function createBackfillJob(params: {
  marketplace: MarketplaceType;
  urlSourceFile: string;
  outputFile: string;
  concurrency?: number;
  batchSize?: number;
}): BackfillJob {
  return {
    jobId: randomUUID(),
    marketplace: params.marketplace,
    urlSource: {
      type: 'file',
      config: { filePath: params.urlSourceFile },
    },
    concurrency: params.concurrency || 3,
    batchSize: params.batchSize || 10,
    checkpoint: {
      enabled: true,
      interval: 100,
      storage: 'file',
    },
    errorHandling: {
      maxConsecutiveFailures: 10,
      pauseOnError: true,
      skipFailedUrls: true,
      retryStrategy: 'skip',
    },
    output: {
      format: 'jsonl',
      destination: params.outputFile,
      emitEvents: true,
    },
  };
}
