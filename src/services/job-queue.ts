/**
 * Async Job Queue with Webhook Support
 *
 * Provides a priority-based job queue for long-running tasks such as
 * crawls, bulk extractions, research, and workflows. Jobs are submitted via
 * `enqueue()` which returns a job ID immediately. A background worker loop
 * processes queued jobs up to a configurable concurrency limit.
 *
 * Features:
 * - Priority queue (1-10, higher = processed first)
 * - Configurable concurrency
 * - Per-job timeout via AbortController
 * - Retry on failure
 * - Webhook notifications on completion/failure (fire-and-forget with one retry)
 * - SSE-compatible progress streaming via async generator
 * - Persistent job storage via Redis (with in-memory fallback)
 * - LRU eviction for completed jobs (keeps last 100)
 *
 * @module services/job-queue
 */

import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { validateWebhookUrl } from '../core/url-validator';
import { JobStore, InMemoryJobStore, createJobStore } from './job-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobType = 'fetch' | 'crawl' | 'extract' | 'workflow' | 'research';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobOptions {
  priority?: number;                    // 1-10, higher = more important, default 5
  webhookUrl?: string;                  // URL to POST result to
  retries?: number;                     // retry count on failure, default 0
  timeout?: number;                     // job timeout ms, default 300000 (5 min)
  metadata?: Record<string, unknown>;
}

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  payload: unknown;
  options: JobOptions;
  progress: number;         // 0-100
  statusMessage?: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  attempts: number;
}

export type JobHandler = (
  job: Job,
  updateProgress: (progress: number, message?: string) => void,
  signal: AbortSignal
) => Promise<unknown>;

export interface JobEvent {
  event: 'progress' | 'status' | 'complete' | 'error';
  data: {
    jobId: string;
    status?: JobStatus;
    progress?: number;
    message?: string;
    result?: unknown;
    error?: string;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Stripped-down job for external display (no internal handles). */
function toPublicJob(job: Job): Job {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    payload: job.payload,
    options: job.options,
    progress: job.progress,
    statusMessage: job.statusMessage,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    attempts: job.attempts,
  };
}

/** Convert a Job to a plain record suitable for the store. */
function jobToRecord(job: Job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    payload: job.payload,
    options: job.options as Record<string, unknown>,
    progress: job.progress,
    statusMessage: job.statusMessage,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    attempts: job.attempts,
  };
}

// ---------------------------------------------------------------------------
// JobQueue implementation
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TIMEOUT = 300_000;  // 5 minutes
const DEFAULT_PRIORITY = 5;
const MAX_COMPLETED_JOBS = 100;
const WORKER_INTERVAL_MS = 250;

export class JobQueue {
  /** In-memory cache of active jobs indexed by ID (hot path for running jobs). */
  private jobs = new Map<string, Job>();

  /** Persistent store for all jobs. */
  private store: JobStore;

  /** Ordered queue of job IDs waiting to run (sorted by priority desc, then creation asc). */
  private queue: string[] = [];

  /** Set of currently running job IDs. */
  private running = new Set<string>();

  /** AbortControllers for running jobs (for cancellation + timeout). */
  private abortControllers = new Map<string, AbortController>();

  /** Timeout handles for per-job timeouts. */
  private timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();

  /** Registered handlers per job type. */
  private handlers = new Map<JobType, JobHandler>();

  /** Progress listeners keyed by job ID. Each job can have multiple listeners. */
  private progressListeners = new Map<string, Array<(event: JobEvent) => void>>();

  /** Worker interval handle. */
  private workerInterval: ReturnType<typeof setInterval> | null = null;

  /** Maximum concurrent jobs. */
  private concurrency: number;

  /** Whether the queue is accepting and processing jobs. */
  private active = false;

  constructor(options?: { concurrency?: number; store?: JobStore }) {
    this.concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
    // Use provided store or default to in-memory (caller can upgrade via init())
    this.store = options?.store ?? new InMemoryJobStore();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Initialize the job store. If no store was provided in the constructor,
   * this will attempt to connect to Redis and fall back to in-memory if
   * Redis is unavailable.
   */
  async init(): Promise<void> {
    // Only auto-create if using the default InMemoryJobStore from constructor
    if (this.store instanceof InMemoryJobStore) {
      this.store = await createJobStore();
    }
    logger.info('JobQueue store initialized');
  }

  /**
   * Add a job to the queue. Returns the job ID immediately.
   */
  enqueue(type: JobType, payload: unknown, options?: JobOptions): string {
    const id = randomUUID();
    const now = new Date().toISOString();

    const job: Job = {
      id,
      type,
      status: 'queued',
      payload,
      options: {
        priority: options?.priority ?? DEFAULT_PRIORITY,
        retries: options?.retries ?? 0,
        timeout: options?.timeout ?? DEFAULT_TIMEOUT,
        webhookUrl: options?.webhookUrl,
        metadata: options?.metadata,
      },
      progress: 0,
      createdAt: now,
      attempts: 0,
    };

    this.jobs.set(id, job);
    this.persistJob(job);
    this.insertIntoQueue(id, job.options.priority ?? DEFAULT_PRIORITY, now);

    logger.info('Job enqueued', { jobId: id, type, priority: job.options.priority });
    return id;
  }

  /**
   * Cancel a queued or running job. Returns true if the job was found and cancelled.
   */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    if (job.status !== 'queued' && job.status !== 'running') {
      return false;
    }

    // Remove from queue if still queued
    const queueIdx = this.queue.indexOf(jobId);
    if (queueIdx !== -1) {
      this.queue.splice(queueIdx, 1);
    }

    // Abort if running
    const controller = this.abortControllers.get(jobId);
    if (controller) {
      controller.abort();
    }

    // Clear timeout
    const timeout = this.timeoutHandles.get(jobId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeoutHandles.delete(jobId);
    }

    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();
    this.running.delete(jobId);
    this.abortControllers.delete(jobId);

    this.persistJob(job);

    this.emitEvent(jobId, {
      event: 'status',
      data: { jobId, status: 'cancelled' },
    });

    logger.info('Job cancelled', { jobId });
    this.evictCompletedJobs();
    return true;
  }

  /**
   * Get a job by ID (returns a public snapshot).
   *
   * Checks in-memory cache first (for hot/active jobs), then falls back to
   * the persistent store for completed/historical jobs.
   */
  async getJob(jobId: string): Promise<Job | undefined> {
    // Check in-memory cache first (fast path for active jobs)
    const memJob = this.jobs.get(jobId);
    if (memJob) return toPublicJob(memJob);

    // Fall back to persistent store
    const record = await this.store.get(jobId);
    if (!record) return undefined;

    return {
      id: record.id,
      type: record.type as JobType,
      status: record.status as JobStatus,
      payload: record.payload,
      options: record.options as JobOptions,
      progress: record.progress,
      statusMessage: record.statusMessage,
      result: record.result,
      error: record.error,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      attempts: record.attempts,
    };
  }

  /**
   * Synchronous get from in-memory cache only. Used internally and for
   * backward compatibility where async is not possible.
   */
  getJobSync(jobId: string): Job | undefined {
    const job = this.jobs.get(jobId);
    return job ? toPublicJob(job) : undefined;
  }

  /**
   * List jobs with optional status/type filter.
   *
   * Queries the persistent store for a complete view (including jobs that
   * survived a restart). Falls back to in-memory if the store is empty.
   */
  async listJobs(filter?: { status?: JobStatus; type?: JobType }): Promise<Job[]> {
    const records = await this.store.list({
      status: filter?.status,
      type: filter?.type,
    });

    // Merge with in-memory state for active jobs (running jobs have fresher state in memory)
    const result = new Map<string, Job>();

    for (const record of records) {
      result.set(record.id, {
        id: record.id,
        type: record.type as JobType,
        status: record.status as JobStatus,
        payload: record.payload,
        options: record.options as JobOptions,
        progress: record.progress,
        statusMessage: record.statusMessage,
        result: record.result,
        error: record.error,
        createdAt: record.createdAt,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        attempts: record.attempts,
      });
    }

    // Overlay in-memory active jobs (they have the latest progress/status)
    for (const [id, job] of this.jobs) {
      if (filter?.status && job.status !== filter.status) continue;
      if (filter?.type && job.type !== filter.type) continue;
      result.set(id, toPublicJob(job));
    }

    const jobs = Array.from(result.values());
    // Sort by createdAt descending (newest first)
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return jobs;
  }

  /**
   * Register a handler for a specific job type.
   */
  registerHandler(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
    logger.info('Job handler registered', { type });
  }

  /**
   * Returns an async generator that yields JobEvents for the given job ID.
   * Useful for SSE streaming endpoints.
   */
  async *streamProgress(jobId: string): AsyncGenerator<JobEvent> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    // If already completed, yield final event and return
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      yield {
        event: job.status === 'completed' ? 'complete' : job.status === 'failed' ? 'error' : 'status',
        data: {
          jobId,
          status: job.status,
          progress: job.progress,
          result: job.result,
          error: job.error,
        },
      };
      return;
    }

    // Set up a listener that pushes events into a buffer
    const buffer: JobEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const listener = (event: JobEvent) => {
      buffer.push(event);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    // Register listener
    if (!this.progressListeners.has(jobId)) {
      this.progressListeners.set(jobId, []);
    }
    this.progressListeners.get(jobId)!.push(listener);

    // Yield initial status
    yield {
      event: 'status',
      data: { jobId, status: job.status, progress: job.progress, message: job.statusMessage },
    };

    try {
      while (!done) {
        // Wait for events
        if (buffer.length === 0) {
          await new Promise<void>((r) => { resolve = r; });
        }

        // Drain buffer
        while (buffer.length > 0) {
          const event = buffer.shift()!;
          yield event;

          // Stop streaming on terminal events
          if (event.event === 'complete' || event.event === 'error' ||
              (event.event === 'status' && (event.data.status === 'cancelled' || event.data.status === 'failed'))) {
            done = true;
            break;
          }
        }
      }
    } finally {
      // Remove listener
      const listeners = this.progressListeners.get(jobId);
      if (listeners) {
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
        if (listeners.length === 0) this.progressListeners.delete(jobId);
      }
    }
  }

  /**
   * Start the worker loop.
   */
  start(): void {
    if (this.active) return;
    this.active = true;

    this.workerInterval = setInterval(() => {
      this.processNext();
    }, WORKER_INTERVAL_MS);

    // Don't prevent process exit
    if (this.workerInterval && typeof this.workerInterval === 'object' && 'unref' in this.workerInterval) {
      this.workerInterval.unref();
    }

    logger.info('Job queue started', { concurrency: this.concurrency });
  }

  /**
   * Graceful shutdown: stop accepting new work, wait for running jobs, clear interval.
   */
  async stop(): Promise<void> {
    this.active = false;

    if (this.workerInterval) {
      clearInterval(this.workerInterval);
      this.workerInterval = null;
    }

    // Cancel all running jobs
    for (const jobId of this.running) {
      const controller = this.abortControllers.get(jobId);
      if (controller) controller.abort();
    }

    // Clear all timeout handles
    for (const handle of this.timeoutHandles.values()) {
      clearTimeout(handle);
    }
    this.timeoutHandles.clear();

    // Wait briefly for running jobs to react to abort signals
    if (this.running.size > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }

    logger.info('Job queue stopped');
  }

  /**
   * Get queue statistics.
   */
  getStats(): { queued: number; running: number; total: number; handlers: string[] } {
    return {
      queued: this.queue.length,
      running: this.running.size,
      total: this.jobs.size,
      handlers: Array.from(this.handlers.keys()),
    };
  }

  // -----------------------------------------------------------------------
  // Internal methods
  // -----------------------------------------------------------------------

  /**
   * Persist a job to the store (fire-and-forget with error logging).
   */
  private persistJob(job: Job): void {
    this.store.set(jobToRecord(job)).catch((err: Error) => {
      logger.error('Failed to persist job to store', { jobId: job.id, error: err.message });
    });
  }

  /**
   * Insert a job ID into the priority queue, maintaining sort order.
   * Higher priority first; within same priority, earlier creation time first (FIFO).
   */
  private insertIntoQueue(jobId: string, priority: number, createdAt: string): void {
    // Find insertion point using binary search for efficiency
    let lo = 0;
    let hi = this.queue.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midJob = this.jobs.get(this.queue[mid]);
      if (!midJob) {
        // Stale entry; skip
        hi = mid;
        continue;
      }
      const midPriority = midJob.options.priority ?? DEFAULT_PRIORITY;

      if (midPriority > priority) {
        lo = mid + 1;
      } else if (midPriority < priority) {
        hi = mid;
      } else {
        // Same priority — FIFO: insert after existing jobs with same priority and earlier time
        if (midJob.createdAt <= createdAt) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
    }

    this.queue.splice(lo, 0, jobId);
  }

  /**
   * Worker loop tick: start jobs up to concurrency limit.
   */
  private processNext(): void {
    if (!this.active) return;

    while (this.running.size < this.concurrency && this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) break;

      const job = this.jobs.get(jobId);
      if (!job || job.status !== 'queued') continue;

      this.executeJob(job);
    }
  }

  /**
   * Execute a single job with timeout, retry, and error handling.
   */
  private executeJob(job: Job): void {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      job.status = 'failed';
      job.error = `No handler registered for job type '${job.type}'`;
      job.completedAt = new Date().toISOString();
      this.persistJob(job);
      logger.error('Job failed: no handler', { jobId: job.id, type: job.type });
      this.emitEvent(job.id, {
        event: 'error',
        data: { jobId: job.id, status: 'failed', error: job.error },
      });
      this.evictCompletedJobs();
      this.deliverWebhook(job);
      return;
    }

    // Set up abort controller
    const controller = new AbortController();
    this.abortControllers.set(job.id, controller);
    this.running.add(job.id);

    // Update job state
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.attempts++;
    this.persistJob(job);

    this.emitEvent(job.id, {
      event: 'status',
      data: { jobId: job.id, status: 'running' },
    });

    // Set up timeout
    const timeout = job.options.timeout ?? DEFAULT_TIMEOUT;
    const timeoutHandle = setTimeout(() => {
      controller.abort();
      logger.warn('Job timed out', { jobId: job.id, timeout });
    }, timeout);
    this.timeoutHandles.set(job.id, timeoutHandle);

    // Progress callback
    const updateProgress = (progress: number, message?: string) => {
      const currentJob = this.jobs.get(job.id);
      if (!currentJob || currentJob.status !== 'running') return;

      currentJob.progress = Math.min(100, Math.max(0, progress));
      if (message !== undefined) currentJob.statusMessage = message;

      // Persist progress updates (fire-and-forget)
      this.persistJob(currentJob);

      this.emitEvent(job.id, {
        event: 'progress',
        data: { jobId: job.id, progress: currentJob.progress, message: currentJob.statusMessage },
      });
    };

    logger.info('Job started', { jobId: job.id, type: job.type, attempt: job.attempts });

    // Execute the handler
    handler(job, updateProgress, controller.signal)
      .then((result) => {
        // Check if job was cancelled while running
        const currentJob = this.jobs.get(job.id);
        if (!currentJob || currentJob.status === 'cancelled') return;

        currentJob.status = 'completed';
        currentJob.result = result;
        currentJob.progress = 100;
        currentJob.completedAt = new Date().toISOString();

        this.persistJob(currentJob);

        logger.info('Job completed', {
          jobId: job.id,
          type: job.type,
          durationMs: Date.now() - new Date(currentJob.startedAt!).getTime(),
        });

        this.emitEvent(job.id, {
          event: 'complete',
          data: { jobId: job.id, status: 'completed', progress: 100, result },
        });

        this.deliverWebhook(currentJob);
        this.evictCompletedJobs();
      })
      .catch((err: Error) => {
        const currentJob = this.jobs.get(job.id);
        if (!currentJob || currentJob.status === 'cancelled') return;

        const errorMessage = err.name === 'AbortError'
          ? 'Job timed out or was aborted'
          : err.message || 'Unknown error';

        // Check for retries
        const maxRetries = currentJob.options.retries ?? 0;
        if (currentJob.attempts <= maxRetries) {
          // Re-queue for retry
          logger.warn('Job failed, retrying', {
            jobId: job.id,
            attempt: currentJob.attempts,
            maxRetries,
            error: errorMessage,
          });

          currentJob.status = 'queued';
          currentJob.progress = 0;
          currentJob.statusMessage = `Retrying (attempt ${currentJob.attempts + 1}/${maxRetries + 1})`;
          this.persistJob(currentJob);
          this.insertIntoQueue(
            job.id,
            currentJob.options.priority ?? DEFAULT_PRIORITY,
            currentJob.createdAt
          );

          this.emitEvent(job.id, {
            event: 'status',
            data: { jobId: job.id, status: 'queued', message: currentJob.statusMessage },
          });
        } else {
          // Final failure
          currentJob.status = 'failed';
          currentJob.error = errorMessage;
          currentJob.completedAt = new Date().toISOString();

          this.persistJob(currentJob);

          logger.error('Job failed', {
            jobId: job.id,
            type: job.type,
            error: errorMessage,
            attempts: currentJob.attempts,
          });

          this.emitEvent(job.id, {
            event: 'error',
            data: { jobId: job.id, status: 'failed', error: errorMessage },
          });

          this.deliverWebhook(currentJob);
          this.evictCompletedJobs();
        }
      })
      .finally(() => {
        // Clean up resources
        clearTimeout(timeoutHandle);
        this.timeoutHandles.delete(job.id);
        this.running.delete(job.id);
        this.abortControllers.delete(job.id);
      });
  }

  /**
   * Emit a job event to all registered progress listeners.
   */
  private emitEvent(jobId: string, event: JobEvent): void {
    const listeners = this.progressListeners.get(jobId);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          logger.warn('Progress listener error', { jobId, error: (err as Error).message });
        }
      }
    }
  }

  /**
   * Deliver webhook notification for a completed/failed job.
   * Fire-and-forget with one retry on failure.
   */
  private deliverWebhook(job: Job): void {
    const webhookUrl = job.options.webhookUrl;
    if (!webhookUrl) return;

    const duration = job.startedAt && job.completedAt
      ? new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()
      : undefined;

    const payload = {
      jobId: job.id,
      type: job.type,
      status: job.status,
      result: job.result,
      error: job.error,
      duration,
    };

    const deliver = async (attempt: number) => {
      try {
        await validateWebhookUrl(webhookUrl);
      } catch (err) {
        logger.error('Webhook SSRF blocked, not delivering', {
          jobId: job.id,
          webhookUrl,
          error: err instanceof Error ? err.message : 'unknown',
        });
        return;
      }

      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000), // 10s timeout for webhook
      })
        .then((res) => {
          if (!res.ok) {
            throw new Error(`Webhook returned HTTP ${res.status}`);
          }
          logger.info('Webhook delivered', { jobId: job.id, webhookUrl, attempt });
        })
        .catch((err: Error) => {
          if (attempt < 2) {
            logger.warn('Webhook delivery failed, retrying', {
              jobId: job.id,
              webhookUrl,
              attempt,
              error: err.message,
            });
            // Retry after 1 second
            setTimeout(() => deliver(attempt + 1), 1000);
          } else {
            logger.error('Webhook delivery failed permanently', {
              jobId: job.id,
              webhookUrl,
              error: err.message,
            });
          }
        });
    };

    deliver(1);
  }

  /**
   * Evict oldest completed jobs when the in-memory store exceeds the limit.
   * Note: persistent store handles its own TTL-based expiration.
   */
  private evictCompletedJobs(): void {
    const completed: Array<{ id: string; completedAt: string }> = [];

    for (const [id, job] of this.jobs) {
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        completed.push({ id, completedAt: job.completedAt ?? job.createdAt });
      }
    }

    if (completed.length > MAX_COMPLETED_JOBS) {
      // Sort oldest first
      completed.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
      const toRemove = completed.length - MAX_COMPLETED_JOBS;
      for (let i = 0; i < toRemove; i++) {
        this.jobs.delete(completed[i].id);
        this.progressListeners.delete(completed[i].id);
      }
      logger.debug('Evicted completed jobs from memory', { count: toRemove });
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: JobQueue | null = null;

/**
 * Get or create the singleton JobQueue instance.
 */
export function getJobQueue(): JobQueue {
  if (!instance) {
    instance = new JobQueue();
  }
  return instance;
}
