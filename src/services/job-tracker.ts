/**
 * Job Progress Tracker for Long-Running Data Collection
 *
 * Tracks progress, errors, retries, and provides resumability for multi-hour jobs.
 * Perfect for legacy data backfills.
 *
 * @module services/job-tracker
 */

import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { logger } from '../utils/logger';

export interface JobItem {
  id: string;
  url: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'captcha';
  attempts: number;
  lastAttempt?: number;
  completedAt?: number;
  error?: string;
  data?: any;
}

export interface JobProgress {
  jobId: string;
  startedAt: number;
  lastUpdate: number;
  items: Map<string, JobItem>;
  stats: {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    captcha: number;
  };
}

export interface JobConfig {
  maxRetries: number;
  retryDelayMs: number;
  checkpointInterval: number; // Save progress every N items
  checkpointPath: string;
}

const DEFAULT_CONFIG: JobConfig = {
  maxRetries: 3,
  retryDelayMs: 60000, // 1 minute
  checkpointInterval: 10,
  checkpointPath: '.anno/jobs'
};

export class JobTracker {
  private progress: JobProgress;
  private config: JobConfig;
  private itemsSinceCheckpoint = 0;

  constructor(jobId: string, config?: Partial<JobConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.progress = {
      jobId,
      startedAt: Date.now(),
      lastUpdate: Date.now(),
      items: new Map(),
      stats: {
        total: 0,
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        captcha: 0
      }
    };
  }

  /**
   * Load job from checkpoint file
   */
  static async load(jobId: string, config?: Partial<JobConfig>): Promise<JobTracker> {
    const tracker = new JobTracker(jobId, config);
    const checkpointFile = `${tracker.config.checkpointPath}/${jobId}.json`;

    if (existsSync(checkpointFile)) {
      try {
        const data = await readFile(checkpointFile, 'utf-8');
        const saved = JSON.parse(data);

        // Reconstruct the Map from saved array
        tracker.progress = {
          ...saved,
          items: new Map(saved.items)
        };

        logger.info('job resumed from checkpoint', {
          jobId,
          completed: tracker.progress.stats.completed,
          pending: tracker.progress.stats.pending
        });
      } catch (error) {
        logger.error('failed to load checkpoint', { jobId, error });
      }
    }

    return tracker;
  }

  /**
   * Add items to job
   */
  addItems(urls: string[]): void {
    for (const url of urls) {
      const id = this.generateId(url);

      // Don't overwrite existing items
      if (this.progress.items.has(id)) {
        continue;
      }

      const item: JobItem = {
        id,
        url,
        status: 'pending',
        attempts: 0
      };

      this.progress.items.set(id, item);
      this.progress.stats.total++;
      this.progress.stats.pending++;
    }

    logger.info('items added to job', {
      jobId: this.progress.jobId,
      added: urls.length,
      total: this.progress.stats.total
    });
  }

  /**
   * Get next pending item
   */
  getNextItem(): JobItem | null {
    // First, check for failed items that can be retried
    for (const item of this.progress.items.values()) {
      if (
        item.status === 'failed' &&
        item.attempts < this.config.maxRetries &&
        (!item.lastAttempt || Date.now() - item.lastAttempt > this.config.retryDelayMs)
      ) {
        return item;
      }
    }

    // Then get first pending item
    for (const item of this.progress.items.values()) {
      if (item.status === 'pending') {
        return item;
      }
    }

    return null;
  }

  /**
   * Mark item as processing
   */
  markProcessing(itemId: string): void {
    const item = this.progress.items.get(itemId);
    if (!item) return;

    const oldStatus = item.status;
    item.status = 'processing';
    item.lastAttempt = Date.now();
    item.attempts++;

    this.updateStats(oldStatus, 'processing');
    this.progress.lastUpdate = Date.now();
  }

  /**
   * Mark item as completed
   */
  markCompleted(itemId: string, data?: any): void {
    const item = this.progress.items.get(itemId);
    if (!item) return;

    const oldStatus = item.status;
    item.status = 'completed';
    item.completedAt = Date.now();
    item.data = data;

    this.updateStats(oldStatus, 'completed');
    this.progress.lastUpdate = Date.now();

    this.itemsSinceCheckpoint++;
    if (this.itemsSinceCheckpoint >= this.config.checkpointInterval) {
      this.save().catch(error => logger.error('checkpoint save failed', { error }));
      this.itemsSinceCheckpoint = 0;
    }

    this.logProgress();
  }

  /**
   * Mark item as failed
   */
  markFailed(itemId: string, error: string): void {
    const item = this.progress.items.get(itemId);
    if (!item) return;

    const oldStatus = item.status;
    item.status = item.attempts >= this.config.maxRetries ? 'failed' : 'pending';
    item.error = error;

    this.updateStats(oldStatus, item.status);
    this.progress.lastUpdate = Date.now();

    logger.warn('item failed', {
      itemId,
      attempts: item.attempts,
      maxRetries: this.config.maxRetries,
      error
    });
  }

  /**
   * Mark item as CAPTCHA challenged
   */
  markCaptcha(itemId: string): void {
    const item = this.progress.items.get(itemId);
    if (!item) return;

    const oldStatus = item.status;
    item.status = 'captcha';

    this.updateStats(oldStatus, 'captcha');
    this.progress.lastUpdate = Date.now();

    logger.error('item encountered captcha', { itemId, url: item.url });
  }

  /**
   * Reset CAPTCHA items back to pending after cooldown
   */
  resetCaptchaItems(): void {
    let count = 0;
    for (const item of this.progress.items.values()) {
      if (item.status === 'captcha') {
        item.status = 'pending';
        item.attempts = 0; // Reset attempts
        this.progress.stats.captcha--;
        this.progress.stats.pending++;
        count++;
      }
    }

    if (count > 0) {
      logger.info('captcha items reset to pending', { count });
    }
  }

  /**
   * Update statistics
   */
  private updateStats(oldStatus: JobItem['status'], newStatus: JobItem['status']): void {
    if (oldStatus !== newStatus) {
      this.progress.stats[oldStatus]--;
      this.progress.stats[newStatus]++;
    }
  }

  /**
   * Save checkpoint to disk
   */
  async save(): Promise<void> {
    try {
      const checkpointFile = `${this.config.checkpointPath}/${this.progress.jobId}.json`;

      // Convert Map to array for JSON serialization
      const serializable = {
        ...this.progress,
        items: Array.from(this.progress.items.entries())
      };

      await writeFile(checkpointFile, JSON.stringify(serializable, null, 2));

      logger.debug('checkpoint saved', {
        jobId: this.progress.jobId,
        completed: this.progress.stats.completed,
        pending: this.progress.stats.pending
      });
    } catch (error) {
      logger.error('failed to save checkpoint', { error });
    }
  }

  /**
   * Generate deterministic ID from URL
   */
  private generateId(url: string): string {
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      const char = url.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Log progress summary
   */
  private logProgress(): void {
    const { stats } = this.progress;
    const percentComplete = ((stats.completed / stats.total) * 100).toFixed(1);
    const elapsed = Date.now() - this.progress.startedAt;
    const avgTimePerItem = elapsed / stats.completed;
    const remaining = stats.pending + stats.processing;
    const estimatedTimeLeft = remaining * avgTimePerItem;

    logger.info('job progress', {
      jobId: this.progress.jobId,
      completed: `${stats.completed}/${stats.total} (${percentComplete}%)`,
      pending: stats.pending,
      failed: stats.failed,
      captcha: stats.captcha,
      avgTimePerItem: `${(avgTimePerItem / 1000).toFixed(1)}s`,
      estimatedTimeLeft: this.formatDuration(estimatedTimeLeft)
    });
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((ms % (1000 * 60)) / 1000);

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Get job statistics
   */
  getStats() {
    return {
      ...this.progress.stats,
      percentComplete: ((this.progress.stats.completed / this.progress.stats.total) * 100).toFixed(1),
      elapsed: Date.now() - this.progress.startedAt,
      startedAt: new Date(this.progress.startedAt).toISOString()
    };
  }

  /**
   * Check if job is complete
   */
  isComplete(): boolean {
    return this.progress.stats.pending === 0 && this.progress.stats.processing === 0;
  }

  /**
   * Export completed items data
   */
  exportData(): any[] {
    const results: any[] = [];

    for (const item of this.progress.items.values()) {
      if (item.status === 'completed' && item.data) {
        results.push({
          url: item.url,
          completedAt: item.completedAt,
          ...item.data
        });
      }
    }

    return results;
  }
}
