import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../core/url-validator', () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue(undefined),
}));

// Mock createJobStore to avoid Redis connection attempts
vi.mock('../services/job-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/job-store')>();
  return {
    ...actual,
    createJobStore: vi.fn().mockResolvedValue(new actual.InMemoryJobStore()),
  };
});

import { JobQueue, type JobHandler } from '../services/job-queue';
import { InMemoryJobStore } from '../services/job-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Small delay to let the worker loop tick and process jobs. */
const tick = (ms = 350) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobQueue', () => {
  let queue: JobQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    queue = new JobQueue({
      concurrency: 2,
      store: new InMemoryJobStore(),
    });
  });

  afterEach(async () => {
    await queue.stop();
  });

  // -----------------------------------------------------------------------
  // enqueue
  // -----------------------------------------------------------------------

  it('enqueue returns a job ID', () => {
    const id = queue.enqueue('fetch', { url: 'https://example.com' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // getJob
  // -----------------------------------------------------------------------

  it('getJob returns the enqueued job', async () => {
    const id = queue.enqueue('crawl', { startUrl: 'https://example.com' });
    const job = await queue.getJob(id);

    expect(job).toBeDefined();
    expect(job!.id).toBe(id);
    expect(job!.type).toBe('crawl');
    expect(job!.status).toBe('queued');
    expect(job!.progress).toBe(0);
    expect(job!.payload).toEqual({ startUrl: 'https://example.com' });
  });

  it('getJob returns undefined for non-existent job', async () => {
    const job = await queue.getJob('non-existent-id');
    expect(job).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // listJobs
  // -----------------------------------------------------------------------

  it('listJobs returns all jobs', async () => {
    queue.enqueue('fetch', { url: 'https://a.com' });
    queue.enqueue('crawl', { url: 'https://b.com' });
    queue.enqueue('extract', { url: 'https://c.com' });

    const jobs = await queue.listJobs();
    expect(jobs).toHaveLength(3);
  });

  it('listJobs filters by type', async () => {
    queue.enqueue('fetch', { url: 'https://a.com' });
    queue.enqueue('crawl', { url: 'https://b.com' });
    queue.enqueue('fetch', { url: 'https://c.com' });

    const jobs = await queue.listJobs({ type: 'fetch' });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.type === 'fetch')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // cancel
  // -----------------------------------------------------------------------

  it('cancel cancels a queued job', async () => {
    const id = queue.enqueue('fetch', { url: 'https://example.com' });
    const cancelled = queue.cancel(id);

    expect(cancelled).toBe(true);

    const job = await queue.getJob(id);
    expect(job!.status).toBe('cancelled');
  });

  it('cancel returns false for non-existent job', () => {
    const result = queue.cancel('does-not-exist');
    expect(result).toBe(false);
  });

  it('cancel returns false for already completed job', async () => {
    const handler: JobHandler = async () => 'done';
    queue.registerHandler('fetch', handler);
    queue.start();

    const id = queue.enqueue('fetch', { url: 'https://example.com' });

    // Wait for the job to complete
    await tick(500);

    const result = queue.cancel(id);
    expect(result).toBe(false);
  });

  // -----------------------------------------------------------------------
  // registerHandler + start
  // -----------------------------------------------------------------------

  it('registerHandler + start processes jobs', async () => {
    const handler: JobHandler = vi.fn().mockResolvedValue({ extracted: true });
    queue.registerHandler('fetch', handler);
    queue.start();

    const id = queue.enqueue('fetch', { url: 'https://example.com' });

    await tick(500);

    const job = await queue.getJob(id);
    expect(job!.status).toBe('completed');
    expect(job!.result).toEqual({ extracted: true });
    expect(job!.progress).toBe(100);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('job with no handler fails immediately', async () => {
    // Do NOT register a handler for 'workflow'
    queue.start();

    const id = queue.enqueue('workflow', { data: 'test' });

    await tick(500);

    const job = await queue.getJob(id);
    expect(job!.status).toBe('failed');
    expect(job!.error).toContain("No handler registered for job type 'workflow'");
  });

  // -----------------------------------------------------------------------
  // getStats
  // -----------------------------------------------------------------------

  it('getStats returns correct counts', () => {
    queue.registerHandler('fetch', vi.fn().mockResolvedValue(null));

    queue.enqueue('fetch', { url: 'https://a.com' });
    queue.enqueue('fetch', { url: 'https://b.com' });

    const stats = queue.getStats();
    expect(stats.queued).toBe(2);
    expect(stats.running).toBe(0);
    expect(stats.total).toBe(2);
    expect(stats.handlers).toContain('fetch');
  });

  // -----------------------------------------------------------------------
  // Priority ordering
  // -----------------------------------------------------------------------

  it('processes higher priority jobs first', async () => {
    const order: string[] = [];

    const handler: JobHandler = async (job) => {
      order.push(String((job.payload as { name: string }).name));
      return null;
    };

    queue.registerHandler('fetch', handler);

    // Enqueue low-priority first, then high-priority
    queue.enqueue('fetch', { name: 'low' }, { priority: 1 });
    queue.enqueue('fetch', { name: 'high' }, { priority: 10 });
    queue.enqueue('fetch', { name: 'medium' }, { priority: 5 });

    // Start after all are enqueued so priority ordering is deterministic
    queue.start();

    await tick(800);

    // High priority should be processed before medium, medium before low
    expect(order[0]).toBe('high');
    expect(order[1]).toBe('medium');
    expect(order[2]).toBe('low');
  });

  // -----------------------------------------------------------------------
  // Progress updates
  // -----------------------------------------------------------------------

  it('handler can update progress', async () => {
    const handler: JobHandler = async (_job, updateProgress) => {
      updateProgress(25, 'Starting');
      updateProgress(75, 'Almost done');
      return 'finished';
    };

    queue.registerHandler('fetch', handler);
    queue.start();

    const id = queue.enqueue('fetch', { url: 'https://example.com' });

    await tick(500);

    const job = await queue.getJob(id);
    expect(job!.status).toBe('completed');
    expect(job!.progress).toBe(100); // overridden to 100 on completion
  });

  // -----------------------------------------------------------------------
  // Retry behaviour
  // -----------------------------------------------------------------------

  it('retries failed job when retries > 0', async () => {
    let callCount = 0;

    const handler: JobHandler = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Transient failure');
      }
      return 'success on retry';
    };

    queue.registerHandler('fetch', handler);
    queue.start();

    const id = queue.enqueue('fetch', { url: 'https://example.com' }, { retries: 1 });

    // Wait enough time for both attempts
    await tick(1000);

    const job = await queue.getJob(id);
    expect(job!.status).toBe('completed');
    expect(job!.result).toBe('success on retry');
    expect(callCount).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Concurrency
  // -----------------------------------------------------------------------

  it('respects concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const handler: JobHandler = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      concurrent--;
      return null;
    };

    // Set concurrency to 2
    const limitedQueue = new JobQueue({
      concurrency: 2,
      store: new InMemoryJobStore(),
    });
    limitedQueue.registerHandler('fetch', handler);

    // Enqueue 4 jobs
    limitedQueue.enqueue('fetch', { n: 1 });
    limitedQueue.enqueue('fetch', { n: 2 });
    limitedQueue.enqueue('fetch', { n: 3 });
    limitedQueue.enqueue('fetch', { n: 4 });

    limitedQueue.start();

    await tick(1500);

    // Max concurrent should not exceed 2
    expect(maxConcurrent).toBeLessThanOrEqual(2);

    await limitedQueue.stop();
  });

  // -----------------------------------------------------------------------
  // getJobSync
  // -----------------------------------------------------------------------

  it('getJobSync returns job from in-memory cache', () => {
    const id = queue.enqueue('fetch', { url: 'https://example.com' });
    const job = queue.getJobSync(id);

    expect(job).toBeDefined();
    expect(job!.id).toBe(id);
    expect(job!.status).toBe('queued');
  });

  it('getJobSync returns undefined for unknown job', () => {
    const job = queue.getJobSync('nonexistent');
    expect(job).toBeUndefined();
  });
});
