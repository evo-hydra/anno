/**
 * Watch Manager — URL Change Monitoring Service
 *
 * Monitors URLs for content changes at configurable polling intervals.
 * Uses the diff engine for change detection and supports webhook
 * notifications when changes exceed a configurable threshold.
 *
 * @module services/watch-manager
 */

import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger';
import { diffEngine } from './diff-engine';
import { fetchPage } from './fetcher';
import { distillContent } from './distiller';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchTarget {
  id: string;
  url: string;
  interval: number; // polling interval in seconds (min 60)
  webhookUrl?: string;
  changeThreshold?: number; // minimum changePercent to trigger notification, default 1
  extractPolicy?: string;
  status: 'active' | 'paused' | 'error';
  createdAt: string;
  lastChecked?: string;
  lastChanged?: string;
  checkCount: number;
  changeCount: number;
  lastError?: string;
}

export interface WatchEvent {
  watchId: string;
  url: string;
  timestamp: string;
  changePercent: number;
  summary: string;
  previousHash?: string;
  currentHash: string;
}

export interface AddWatchOptions {
  interval?: number;
  webhookUrl?: string;
  changeThreshold?: number;
  extractPolicy?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_INTERVAL_SECONDS = 60;
const TICK_INTERVAL_MS = 30_000; // 30 seconds
const DEFAULT_CHANGE_THRESHOLD = 1;
const DEFAULT_DATA_DIR = join(__dirname, '..', '..', 'data', 'watches');

// ---------------------------------------------------------------------------
// WatchManager
// ---------------------------------------------------------------------------

export class WatchManager {
  private readonly dataDir: string;
  private watches: Map<string, WatchTarget> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? DEFAULT_DATA_DIR;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Load persisted watch configs from disk and start the polling timer.
   */
  async init(): Promise<void> {
    await this.loadWatches();
    this.startTimer();
    logger.info('WatchManager initialized', { watchCount: this.watches.size });
  }

  /**
   * Stop the polling timer. Does not remove persisted data.
   */
  shutdown(): void {
    this.stopTimer();
    logger.info('WatchManager shut down');
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Register a URL for monitoring.
   */
  async addWatch(url: string, options: AddWatchOptions = {}): Promise<WatchTarget> {
    const id = randomUUID();
    const interval = Math.max(options.interval ?? 3600, MIN_INTERVAL_SECONDS);

    const watch: WatchTarget = {
      id,
      url,
      interval,
      webhookUrl: options.webhookUrl,
      changeThreshold: options.changeThreshold ?? DEFAULT_CHANGE_THRESHOLD,
      extractPolicy: options.extractPolicy,
      status: 'active',
      createdAt: new Date().toISOString(),
      checkCount: 0,
      changeCount: 0,
    };

    this.watches.set(id, watch);
    await this.persistWatch(watch);

    logger.info('Watch added', { id, url, interval });

    // Ensure the timer is running
    this.startTimer();

    return watch;
  }

  /**
   * Stop monitoring a URL and remove its persisted data.
   */
  async removeWatch(watchId: string): Promise<boolean> {
    const watch = this.watches.get(watchId);
    if (!watch) {
      return false;
    }

    this.watches.delete(watchId);

    // Remove persisted directory
    const dir = join(this.dataDir, watchId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      logger.warn('Failed to remove watch directory', {
        watchId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }

    logger.info('Watch removed', { watchId, url: watch.url });
    return true;
  }

  /**
   * Pause monitoring for a watch.
   */
  async pauseWatch(watchId: string): Promise<WatchTarget | null> {
    const watch = this.watches.get(watchId);
    if (!watch) {
      return null;
    }

    watch.status = 'paused';
    await this.persistWatch(watch);
    logger.info('Watch paused', { watchId, url: watch.url });
    return watch;
  }

  /**
   * Resume monitoring for a paused watch.
   */
  async resumeWatch(watchId: string): Promise<WatchTarget | null> {
    const watch = this.watches.get(watchId);
    if (!watch) {
      return null;
    }

    watch.status = 'active';
    watch.lastError = undefined;
    await this.persistWatch(watch);
    logger.info('Watch resumed', { watchId, url: watch.url });
    return watch;
  }

  /**
   * Get a single watch target by ID.
   */
  getWatch(watchId: string): WatchTarget | null {
    return this.watches.get(watchId) ?? null;
  }

  /**
   * List all watch targets.
   */
  listWatches(): WatchTarget[] {
    return Array.from(this.watches.values());
  }

  /**
   * Get change events for a watch, newest first.
   */
  async getEvents(watchId: string, limit = 50): Promise<WatchEvent[]> {
    const eventsFile = join(this.dataDir, watchId, 'events.jsonl');
    let raw: string;
    try {
      raw = await fs.readFile(eventsFile, 'utf8');
    } catch {
      return [];
    }

    const lines = raw.trim().split('\n').filter(Boolean);
    const events: WatchEvent[] = [];

    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as WatchEvent);
      } catch {
        // skip malformed lines
      }
    }

    // Return newest first, limited
    events.reverse();
    return events.slice(0, limit);
  }

  // -----------------------------------------------------------------------
  // Timer management
  // -----------------------------------------------------------------------

  private startTimer(): void {
    if (this.timer) {
      return; // already running
    }

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error('Watch tick error', {
          error: err instanceof Error ? err.message : 'unknown',
        });
      });
    }, TICK_INTERVAL_MS);

    // Allow the process to exit even if this timer is still running
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Tick — check all watches
  // -----------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.checking) {
      return; // previous tick still in progress
    }
    this.checking = true;

    try {
      const now = Date.now();

      const activeWatches = Array.from(this.watches.values());
      for (const watch of activeWatches) {
        if (watch.status !== 'active') {
          continue;
        }

        // Check whether interval has elapsed since last check
        const lastCheckedMs = watch.lastChecked
          ? new Date(watch.lastChecked).getTime()
          : 0;
        const elapsedSeconds = (now - lastCheckedMs) / 1000;

        if (elapsedSeconds < watch.interval) {
          continue;
        }

        await this.checkWatch(watch);
      }
    } finally {
      this.checking = false;
    }
  }

  // -----------------------------------------------------------------------
  // Individual watch check
  // -----------------------------------------------------------------------

  private async checkWatch(watch: WatchTarget): Promise<void> {
    const { id, url } = watch;
    logger.info('Checking watch', { watchId: id, url });

    try {
      // Fetch the page
      const fetchResult = await fetchPage({
        url,
        useCache: false,
        mode: 'http',
      });

      // Distill content
      const distilled = await distillContent(
        fetchResult.body,
        fetchResult.finalUrl,
        watch.extractPolicy
      );

      const content = distilled.contentText;

      // Run change detection via the diff engine
      const detection = await diffEngine.detectChanges(url, content, {
        title: distilled.title,
      });

      // Update watch metadata
      watch.lastChecked = new Date().toISOString();
      watch.checkCount += 1;

      const threshold = watch.changeThreshold ?? DEFAULT_CHANGE_THRESHOLD;

      if (detection.hasChanged && detection.changePercent >= threshold) {
        watch.lastChanged = watch.lastChecked;
        watch.changeCount += 1;

        // Build event
        const event: WatchEvent = {
          watchId: id,
          url,
          timestamp: watch.lastChecked,
          changePercent: detection.changePercent,
          summary: detection.summary,
          previousHash: detection.previousSnapshot?.contentHash,
          currentHash: detection.currentSnapshot.contentHash,
        };

        // Append event to JSONL file
        await this.appendEvent(id, event);

        logger.info('Watch detected change', {
          watchId: id,
          url,
          changePercent: detection.changePercent,
          summary: detection.summary,
        });

        // Fire webhook if configured
        if (watch.webhookUrl) {
          this.fireWebhook(watch.webhookUrl, event).catch((err) => {
            logger.warn('Webhook delivery failed', {
              watchId: id,
              webhookUrl: watch.webhookUrl,
              error: err instanceof Error ? err.message : 'unknown',
            });
          });
        }
      }

      // Clear any previous error status
      if (watch.status === 'error') {
        watch.status = 'active';
      }
      watch.lastError = undefined;

      await this.persistWatch(watch);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.error('Watch check failed', { watchId: id, url, error: message });

      watch.lastChecked = new Date().toISOString();
      watch.checkCount += 1;
      watch.status = 'error';
      watch.lastError = message;

      await this.persistWatch(watch);
    }
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private async persistWatch(watch: WatchTarget): Promise<void> {
    const dir = join(this.dataDir, watch.id);
    await fs.mkdir(dir, { recursive: true });

    const configPath = join(dir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(watch, null, 2), 'utf8');
  }

  private async loadWatches(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dataDir);
    } catch {
      // Data directory doesn't exist yet — nothing to load
      return;
    }

    for (const entry of entries) {
      const configPath = join(this.dataDir, entry, 'config.json');
      try {
        const raw = await fs.readFile(configPath, 'utf8');
        const watch = JSON.parse(raw) as WatchTarget;
        this.watches.set(watch.id, watch);
      } catch {
        // Skip unreadable watch configs
        logger.warn('Failed to load watch config', { entry });
      }
    }

    logger.info('Loaded persisted watches', { count: this.watches.size });
  }

  private async appendEvent(watchId: string, event: WatchEvent): Promise<void> {
    const dir = join(this.dataDir, watchId);
    await fs.mkdir(dir, { recursive: true });

    const eventsFile = join(dir, 'events.jsonl');
    await fs.appendFile(eventsFile, JSON.stringify(event) + '\n', 'utf8');
  }

  // -----------------------------------------------------------------------
  // Webhook
  // -----------------------------------------------------------------------

  private async fireWebhook(webhookUrl: string, event: WatchEvent): Promise<void> {
    logger.info('Firing webhook', { webhookUrl, watchId: event.watchId });

    // Use a dynamic import for http/https to keep things simple
    const url = new URL(webhookUrl);
    const mod = url.protocol === 'https:' ? await import('https') : await import('http');

    const body = JSON.stringify(event);

    return new Promise<void>((resolve, reject) => {
      const req = mod.request(
        webhookUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'User-Agent': 'Anno-WatchManager/1.0',
          },
          timeout: 10_000,
        },
        (res) => {
          // Consume response body to free the socket
          res.resume();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Webhook returned HTTP ${res.statusCode}`));
          }
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('Webhook request timed out'));
      });

      req.write(body);
      req.end();
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton export (matches codebase convention)
// ---------------------------------------------------------------------------

export const watchManager = new WatchManager();
