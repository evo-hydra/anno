import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryJobStore, JobRecord } from '../services/job-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides?: Partial<JobRecord>): JobRecord {
  return {
    id: overrides?.id ?? `job-${Math.random().toString(36).slice(2, 8)}`,
    type: overrides?.type ?? 'crawl',
    status: overrides?.status ?? 'queued',
    payload: overrides?.payload ?? { url: 'https://example.com' },
    options: overrides?.options ?? { priority: 5, retries: 0 },
    progress: overrides?.progress ?? 0,
    statusMessage: overrides?.statusMessage,
    result: overrides?.result,
    error: overrides?.error,
    createdAt: overrides?.createdAt ?? new Date().toISOString(),
    startedAt: overrides?.startedAt,
    completedAt: overrides?.completedAt,
    attempts: overrides?.attempts ?? 0,
  };
}

// ---------------------------------------------------------------------------
// InMemoryJobStore tests
// ---------------------------------------------------------------------------

describe('InMemoryJobStore', () => {
  let store: InMemoryJobStore;

  beforeEach(() => {
    store = new InMemoryJobStore();
  });

  // -----------------------------------------------------------------------
  // set() and get() roundtrip
  // -----------------------------------------------------------------------

  it('set() and get() roundtrip preserves all fields', async () => {
    const job = makeJob({
      id: 'roundtrip-1',
      type: 'fetch',
      status: 'running',
      payload: { url: 'https://example.com', depth: 2 },
      options: { priority: 8, retries: 3 },
      progress: 42,
      statusMessage: 'Fetching page 2 of 5',
      startedAt: new Date().toISOString(),
      attempts: 1,
    });

    await store.set(job);
    const retrieved = await store.get('roundtrip-1');

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(job.id);
    expect(retrieved!.type).toBe(job.type);
    expect(retrieved!.status).toBe(job.status);
    expect(retrieved!.payload).toEqual(job.payload);
    expect(retrieved!.options).toEqual(job.options);
    expect(retrieved!.progress).toBe(42);
    expect(retrieved!.statusMessage).toBe('Fetching page 2 of 5');
    expect(retrieved!.startedAt).toBe(job.startedAt);
    expect(retrieved!.attempts).toBe(1);
    expect(retrieved!.createdAt).toBe(job.createdAt);
  });

  // -----------------------------------------------------------------------
  // get() returns null for missing job
  // -----------------------------------------------------------------------

  it('get() returns null for missing job', async () => {
    const result = await store.get('nonexistent-id');
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // set() does not mutate the original object (defensive copy)
  // -----------------------------------------------------------------------

  it('set() stores a copy; mutations to original do not affect stored data', async () => {
    const job = makeJob({ id: 'copy-test', status: 'queued' });
    await store.set(job);

    // Mutate original
    job.status = 'running';
    job.progress = 50;

    const retrieved = await store.get('copy-test');
    expect(retrieved!.status).toBe('queued');
    expect(retrieved!.progress).toBe(0);
  });

  // -----------------------------------------------------------------------
  // delete() removes a job
  // -----------------------------------------------------------------------

  it('delete() removes a job and returns true', async () => {
    const job = makeJob({ id: 'del-1' });
    await store.set(job);

    const deleted = await store.delete('del-1');
    expect(deleted).toBe(true);

    const result = await store.get('del-1');
    expect(result).toBeNull();
  });

  it('delete() returns false for missing job', async () => {
    const deleted = await store.delete('does-not-exist');
    expect(deleted).toBe(false);
  });

  // -----------------------------------------------------------------------
  // list() returns all jobs
  // -----------------------------------------------------------------------

  it('list() returns all jobs sorted by createdAt descending', async () => {
    const t1 = '2025-01-01T00:00:00.000Z';
    const t2 = '2025-01-02T00:00:00.000Z';
    const t3 = '2025-01-03T00:00:00.000Z';

    await store.set(makeJob({ id: 'a', createdAt: t1 }));
    await store.set(makeJob({ id: 'b', createdAt: t3 }));
    await store.set(makeJob({ id: 'c', createdAt: t2 }));

    const jobs = await store.list();
    expect(jobs).toHaveLength(3);
    expect(jobs[0].id).toBe('b'); // newest first
    expect(jobs[1].id).toBe('c');
    expect(jobs[2].id).toBe('a'); // oldest last
  });

  // -----------------------------------------------------------------------
  // list() with status filter
  // -----------------------------------------------------------------------

  it('list() with status filter returns only matching jobs', async () => {
    await store.set(makeJob({ id: 'q1', status: 'queued' }));
    await store.set(makeJob({ id: 'r1', status: 'running' }));
    await store.set(makeJob({ id: 'c1', status: 'completed' }));
    await store.set(makeJob({ id: 'q2', status: 'queued' }));

    const queued = await store.list({ status: 'queued' });
    expect(queued).toHaveLength(2);
    expect(queued.every(j => j.status === 'queued')).toBe(true);

    const running = await store.list({ status: 'running' });
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe('r1');

    const failed = await store.list({ status: 'failed' });
    expect(failed).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // list() with type filter
  // -----------------------------------------------------------------------

  it('list() with type filter returns only matching jobs', async () => {
    await store.set(makeJob({ id: 'f1', type: 'fetch' }));
    await store.set(makeJob({ id: 'c1', type: 'crawl' }));
    await store.set(makeJob({ id: 'f2', type: 'fetch' }));
    await store.set(makeJob({ id: 'e1', type: 'extract' }));

    const fetchJobs = await store.list({ type: 'fetch' });
    expect(fetchJobs).toHaveLength(2);
    expect(fetchJobs.every(j => j.type === 'fetch')).toBe(true);

    const crawlJobs = await store.list({ type: 'crawl' });
    expect(crawlJobs).toHaveLength(1);
    expect(crawlJobs[0].id).toBe('c1');
  });

  // -----------------------------------------------------------------------
  // list() with combined status + type filter
  // -----------------------------------------------------------------------

  it('list() with combined status and type filter', async () => {
    await store.set(makeJob({ id: 'j1', type: 'crawl', status: 'queued' }));
    await store.set(makeJob({ id: 'j2', type: 'crawl', status: 'completed' }));
    await store.set(makeJob({ id: 'j3', type: 'fetch', status: 'queued' }));
    await store.set(makeJob({ id: 'j4', type: 'fetch', status: 'completed' }));

    const result = await store.list({ status: 'queued', type: 'crawl' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('j1');
  });

  // -----------------------------------------------------------------------
  // list() with pagination (limit + offset)
  // -----------------------------------------------------------------------

  it('list() with limit returns at most N jobs', async () => {
    const t = (n: number) => `2025-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;
    for (let i = 1; i <= 5; i++) {
      await store.set(makeJob({ id: `p${i}`, createdAt: t(i) }));
    }

    const page = await store.list({ limit: 2 });
    expect(page).toHaveLength(2);
    // Newest first
    expect(page[0].id).toBe('p5');
    expect(page[1].id).toBe('p4');
  });

  it('list() with offset skips the first N jobs', async () => {
    const t = (n: number) => `2025-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;
    for (let i = 1; i <= 5; i++) {
      await store.set(makeJob({ id: `p${i}`, createdAt: t(i) }));
    }

    const page = await store.list({ offset: 2 });
    expect(page).toHaveLength(3);
    expect(page[0].id).toBe('p3');
    expect(page[1].id).toBe('p2');
    expect(page[2].id).toBe('p1');
  });

  it('list() with limit + offset together for pagination', async () => {
    const t = (n: number) => `2025-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;
    for (let i = 1; i <= 10; i++) {
      await store.set(makeJob({ id: `p${i}`, createdAt: t(i) }));
    }

    // Page 2 (offset 3, limit 3): should get p7, p6, p5
    const page2 = await store.list({ offset: 3, limit: 3 });
    expect(page2).toHaveLength(3);
    expect(page2[0].id).toBe('p7');
    expect(page2[1].id).toBe('p6');
    expect(page2[2].id).toBe('p5');
  });

  it('list() with offset beyond total returns empty', async () => {
    await store.set(makeJob({ id: 'only-one' }));
    const result = await store.list({ offset: 5 });
    expect(result).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // count() returns correct counts
  // -----------------------------------------------------------------------

  it('count() returns total number of jobs', async () => {
    expect(await store.count()).toBe(0);

    await store.set(makeJob({ id: 'a' }));
    await store.set(makeJob({ id: 'b' }));
    await store.set(makeJob({ id: 'c' }));

    expect(await store.count()).toBe(3);
  });

  // -----------------------------------------------------------------------
  // count() with filters
  // -----------------------------------------------------------------------

  it('count() with status filter', async () => {
    await store.set(makeJob({ id: 'q1', status: 'queued' }));
    await store.set(makeJob({ id: 'r1', status: 'running' }));
    await store.set(makeJob({ id: 'q2', status: 'queued' }));
    await store.set(makeJob({ id: 'c1', status: 'completed' }));

    expect(await store.count({ status: 'queued' })).toBe(2);
    expect(await store.count({ status: 'running' })).toBe(1);
    expect(await store.count({ status: 'completed' })).toBe(1);
    expect(await store.count({ status: 'failed' })).toBe(0);
  });

  it('count() with type filter', async () => {
    await store.set(makeJob({ id: 'f1', type: 'fetch' }));
    await store.set(makeJob({ id: 'c1', type: 'crawl' }));
    await store.set(makeJob({ id: 'f2', type: 'fetch' }));

    expect(await store.count({ type: 'fetch' })).toBe(2);
    expect(await store.count({ type: 'crawl' })).toBe(1);
    expect(await store.count({ type: 'extract' })).toBe(0);
  });

  it('count() with combined status + type filter', async () => {
    await store.set(makeJob({ id: 'j1', type: 'crawl', status: 'queued' }));
    await store.set(makeJob({ id: 'j2', type: 'crawl', status: 'completed' }));
    await store.set(makeJob({ id: 'j3', type: 'fetch', status: 'queued' }));

    expect(await store.count({ status: 'queued', type: 'crawl' })).toBe(1);
    expect(await store.count({ status: 'queued', type: 'fetch' })).toBe(1);
    expect(await store.count({ status: 'completed', type: 'crawl' })).toBe(1);
    expect(await store.count({ status: 'completed', type: 'fetch' })).toBe(0);
  });

  // -----------------------------------------------------------------------
  // cleanup() removes old completed jobs
  // -----------------------------------------------------------------------

  it('cleanup() removes old completed/failed/cancelled jobs', async () => {
    const oldTime = '2024-01-01T00:00:00.000Z'; // Old enough to be cleaned up
    const recentTime = new Date().toISOString();

    await store.set(makeJob({ id: 'old-completed', status: 'completed', createdAt: oldTime, completedAt: oldTime }));
    await store.set(makeJob({ id: 'old-failed', status: 'failed', createdAt: oldTime, completedAt: oldTime }));
    await store.set(makeJob({ id: 'old-cancelled', status: 'cancelled', createdAt: oldTime, completedAt: oldTime }));
    await store.set(makeJob({ id: 'recent-completed', status: 'completed', createdAt: recentTime, completedAt: recentTime }));

    // Clean up anything older than 1 hour
    const removed = await store.cleanup(60 * 60 * 1000);

    expect(removed).toBe(3);
    expect(await store.get('old-completed')).toBeNull();
    expect(await store.get('old-failed')).toBeNull();
    expect(await store.get('old-cancelled')).toBeNull();
    expect(await store.get('recent-completed')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // cleanup() preserves active jobs
  // -----------------------------------------------------------------------

  it('cleanup() preserves old queued and running jobs', async () => {
    const oldTime = '2024-01-01T00:00:00.000Z';

    await store.set(makeJob({ id: 'old-queued', status: 'queued', createdAt: oldTime }));
    await store.set(makeJob({ id: 'old-running', status: 'running', createdAt: oldTime, startedAt: oldTime }));
    await store.set(makeJob({ id: 'old-completed', status: 'completed', createdAt: oldTime, completedAt: oldTime }));

    const removed = await store.cleanup(60 * 60 * 1000);

    expect(removed).toBe(1); // Only the completed one
    expect(await store.get('old-queued')).not.toBeNull();
    expect(await store.get('old-running')).not.toBeNull();
    expect(await store.get('old-completed')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // cleanup() returns 0 when nothing to clean
  // -----------------------------------------------------------------------

  it('cleanup() returns 0 when no expired jobs exist', async () => {
    const recentTime = new Date().toISOString();
    await store.set(makeJob({ id: 'recent', status: 'completed', createdAt: recentTime, completedAt: recentTime }));

    const removed = await store.cleanup(60 * 60 * 1000);
    expect(removed).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Overwrite: set() updates existing job
  // -----------------------------------------------------------------------

  it('set() overwrites existing job with same id', async () => {
    await store.set(makeJob({ id: 'upd', status: 'queued', progress: 0 }));
    await store.set(makeJob({ id: 'upd', status: 'running', progress: 50 }));

    const result = await store.get('upd');
    expect(result!.status).toBe('running');
    expect(result!.progress).toBe(50);
    expect(await store.count()).toBe(1);
  });
});
