/**
 * Tests for RedisJobStore and createJobStore factory in src/services/job-store.ts
 *
 * The existing job-store.test.ts covers InMemoryJobStore only. This file covers:
 * - RedisJobStore: all methods with a mocked Redis client
 * - createJobStore factory: Redis enabled/disabled, connection success/failure
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisJobStore, type JobRecord, type JobStore } from '../services/job-store';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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

/**
 * Build a mock Redis client that stores data in memory so we can test
 * RedisJobStore logic without a real Redis connection.
 */
function createMockRedisClient() {
  const keyValues = new Map<string, string>();
  const sortedSets = new Map<string, Map<string, number>>(); // key -> (member -> score)
  const sets = new Map<string, Set<string>>(); // key -> members

  function getSortedSet(key: string): Map<string, number> {
    let s = sortedSets.get(key);
    if (!s) {
      s = new Map();
      sortedSets.set(key, s);
    }
    return s;
  }

  function getSet(key: string): Set<string> {
    let s = sets.get(key);
    if (!s) {
      s = new Set();
      sets.set(key, s);
    }
    return s;
  }

  const expirations = new Map<string, number>();

  const client = {
    get: vi.fn(async (key: string) => keyValues.get(key) ?? null),

    set: vi.fn(async (key: string, value: string, opts?: { EX?: number }) => {
      keyValues.set(key, value);
      if (opts?.EX) {
        expirations.set(key, opts.EX);
      }
      return 'OK';
    }),

    del: vi.fn(async (key: string) => {
      const existed = keyValues.has(key);
      keyValues.delete(key);
      return existed ? 1 : 0;
    }),

    zAdd: vi.fn(async (key: string, entry: { score: number; value: string }) => {
      getSortedSet(key).set(entry.value, entry.score);
      return 1;
    }),

    zRange: vi.fn(async (key: string, _start: number, _stop: number) => {
      const ss = sortedSets.get(key);
      if (!ss) return [];
      return Array.from(ss.entries())
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
    }),

    zRangeByScore: vi.fn(async (key: string, min: number, max: number) => {
      const ss = sortedSets.get(key);
      if (!ss) return [];
      return Array.from(ss.entries())
        .filter(([, score]) => score >= min && score <= max)
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
    }),

    zRem: vi.fn(async (key: string, member: string) => {
      const ss = sortedSets.get(key);
      if (!ss) return 0;
      const existed = ss.has(member);
      ss.delete(member);
      return existed ? 1 : 0;
    }),

    zCard: vi.fn(async (key: string) => {
      const ss = sortedSets.get(key);
      return ss ? ss.size : 0;
    }),

    sAdd: vi.fn(async (key: string, member: string) => {
      getSet(key).add(member);
      return 1;
    }),

    sRem: vi.fn(async (key: string, member: string) => {
      const s = sets.get(key);
      if (!s) return 0;
      const existed = s.has(member);
      s.delete(member);
      return existed ? 1 : 0;
    }),

    sMembers: vi.fn(async (key: string) => {
      const s = sets.get(key);
      return s ? Array.from(s) : [];
    }),

    sCard: vi.fn(async (key: string) => {
      const s = sets.get(key);
      return s ? s.size : 0;
    }),

    multi: vi.fn(() => {
      const commands: Array<{ method: string; args: unknown[] }> = [];
      const pipeline = {
        get: (key: string) => {
          commands.push({ method: 'get', args: [key] });
          return pipeline;
        },
        exec: async () => {
          const results: Array<string | null> = [];
          for (const cmd of commands) {
            if (cmd.method === 'get') {
              results.push(keyValues.get(cmd.args[0] as string) ?? null);
            }
          }
          return results;
        },
      };
      return pipeline;
    }),

    // Expose internal data for test inspection
    _keyValues: keyValues,
    _sortedSets: sortedSets,
    _sets: sets,
    _expirations: expirations,
  };

  return client;
}

type MockRedisClient = ReturnType<typeof createMockRedisClient>;

// ---------------------------------------------------------------------------
// RedisJobStore tests
// ---------------------------------------------------------------------------

describe('RedisJobStore', () => {
  let client: MockRedisClient;
  let store: RedisJobStore;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createMockRedisClient();
    store = new RedisJobStore(client as unknown as import('redis').RedisClientType);
  });

  // -----------------------------------------------------------------------
  // get()
  // -----------------------------------------------------------------------

  describe('get()', () => {
    it('returns null for non-existent job', async () => {
      const result = await store.get('missing-id');
      expect(result).toBeNull();
    });

    it('returns the stored job', async () => {
      const job = makeJob({ id: 'test-get' });
      await store.set(job);

      const result = await store.get('test-get');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('test-get');
      expect(result!.type).toBe(job.type);
      expect(result!.status).toBe(job.status);
    });
  });

  // -----------------------------------------------------------------------
  // set()
  // -----------------------------------------------------------------------

  describe('set()', () => {
    it('stores a job in Redis', async () => {
      const job = makeJob({ id: 'set-test' });
      await store.set(job);

      expect(client.set).toHaveBeenCalled();
      const stored = client._keyValues.get('anno:job:set-test');
      expect(stored).toBeDefined();
      const parsed = JSON.parse(stored!) as JobRecord;
      expect(parsed.id).toBe('set-test');
    });

    it('adds job to sorted set and status index', async () => {
      const job = makeJob({ id: 'idx-test', status: 'queued' });
      await store.set(job);

      expect(client.zAdd).toHaveBeenCalled();
      expect(client.sAdd).toHaveBeenCalledWith('anno:jobs:status:queued', 'idx-test');
    });

    it('sets TTL for completed jobs', async () => {
      const job = makeJob({ id: 'ttl-test', status: 'completed' });
      await store.set(job);

      // Should have been called with EX option
      expect(client.set).toHaveBeenCalledWith(
        'anno:job:ttl-test',
        expect.any(String),
        expect.objectContaining({ EX: expect.any(Number) })
      );
    });

    it('sets TTL for failed jobs', async () => {
      const job = makeJob({ id: 'failed-ttl', status: 'failed' });
      await store.set(job);

      expect(client._expirations.has('anno:job:failed-ttl')).toBe(true);
    });

    it('sets TTL for cancelled jobs', async () => {
      const job = makeJob({ id: 'cancel-ttl', status: 'cancelled' });
      await store.set(job);

      expect(client._expirations.has('anno:job:cancel-ttl')).toBe(true);
    });

    it('does NOT set TTL for queued jobs', async () => {
      const job = makeJob({ id: 'no-ttl', status: 'queued' });
      await store.set(job);

      // The set call for non-terminal jobs should not have EX
      const calls = client.set.mock.calls;
      const relevantCall = calls.find((c: unknown[]) => c[0] === 'anno:job:no-ttl');
      expect(relevantCall).toBeDefined();
      expect(relevantCall![2]).toBeUndefined();
    });

    it('removes old status index when status changes', async () => {
      const job = makeJob({ id: 'status-change', status: 'queued' });
      await store.set(job);

      // Now update to running
      const updated = { ...job, status: 'running' };
      await store.set(updated);

      expect(client.sRem).toHaveBeenCalledWith('anno:jobs:status:queued', 'status-change');
      expect(client.sAdd).toHaveBeenCalledWith('anno:jobs:status:running', 'status-change');
    });

    it('does not remove status index when status is unchanged', async () => {
      const job = makeJob({ id: 'same-status', status: 'queued' });
      await store.set(job);

      // Update with same status
      const updated = { ...job, progress: 50 };
      await store.set(updated);

      // sRem should not have been called for the same status
      const sRemCalls = client.sRem.mock.calls.filter(
        (c: unknown[]) => c[0] === 'anno:jobs:status:queued' && c[1] === 'same-status'
      );
      expect(sRemCalls).toHaveLength(0);
    });

    it('respects custom completedTtlSeconds', async () => {
      const customStore = new RedisJobStore(
        client as unknown as import('redis').RedisClientType,
        { completedTtlSeconds: 3600 }
      );

      const job = makeJob({ id: 'custom-ttl', status: 'completed' });
      await customStore.set(job);

      expect(client.set).toHaveBeenCalledWith(
        'anno:job:custom-ttl',
        expect.any(String),
        { EX: 3600 }
      );
    });
  });

  // -----------------------------------------------------------------------
  // delete()
  // -----------------------------------------------------------------------

  describe('delete()', () => {
    it('returns false for non-existent job', async () => {
      const result = await store.delete('nonexistent');
      expect(result).toBe(false);
    });

    it('deletes an existing job and removes from indexes', async () => {
      const job = makeJob({ id: 'del-test', status: 'queued' });
      await store.set(job);

      const result = await store.delete('del-test');
      expect(result).toBe(true);

      // Verify removed from all indexes
      expect(client.del).toHaveBeenCalledWith('anno:job:del-test');
      expect(client.zRem).toHaveBeenCalledWith('anno:jobs:by_created', 'del-test');
      expect(client.sRem).toHaveBeenCalledWith('anno:jobs:status:queued', 'del-test');
    });

    it('get returns null after delete', async () => {
      const job = makeJob({ id: 'del-verify' });
      await store.set(job);
      await store.delete('del-verify');

      const result = await store.get('del-verify');
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // list()
  // -----------------------------------------------------------------------

  describe('list()', () => {
    it('returns empty array when no jobs exist', async () => {
      const result = await store.list();
      expect(result).toEqual([]);
    });

    it('returns all jobs sorted by createdAt descending', async () => {
      const t1 = '2025-01-01T00:00:00.000Z';
      const t2 = '2025-01-02T00:00:00.000Z';
      const t3 = '2025-01-03T00:00:00.000Z';

      await store.set(makeJob({ id: 'a', createdAt: t1 }));
      await store.set(makeJob({ id: 'b', createdAt: t3 }));
      await store.set(makeJob({ id: 'c', createdAt: t2 }));

      const jobs = await store.list();
      expect(jobs).toHaveLength(3);
      expect(jobs[0].id).toBe('b');
      expect(jobs[1].id).toBe('c');
      expect(jobs[2].id).toBe('a');
    });

    it('filters by status using the status index set', async () => {
      await store.set(makeJob({ id: 'q1', status: 'queued' }));
      await store.set(makeJob({ id: 'r1', status: 'running' }));
      await store.set(makeJob({ id: 'q2', status: 'queued' }));

      const queued = await store.list({ status: 'queued' });
      expect(queued).toHaveLength(2);
      expect(queued.every(j => j.status === 'queued')).toBe(true);
    });

    it('filters by type', async () => {
      await store.set(makeJob({ id: 'f1', type: 'fetch' }));
      await store.set(makeJob({ id: 'c1', type: 'crawl' }));
      await store.set(makeJob({ id: 'f2', type: 'fetch' }));

      const fetchJobs = await store.list({ type: 'fetch' });
      expect(fetchJobs).toHaveLength(2);
      expect(fetchJobs.every(j => j.type === 'fetch')).toBe(true);
    });

    it('applies pagination with limit', async () => {
      const t = (n: number) => `2025-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;
      for (let i = 1; i <= 5; i++) {
        await store.set(makeJob({ id: `p${i}`, createdAt: t(i) }));
      }

      const page = await store.list({ limit: 2 });
      expect(page).toHaveLength(2);
    });

    it('applies pagination with offset', async () => {
      const t = (n: number) => `2025-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;
      for (let i = 1; i <= 5; i++) {
        await store.set(makeJob({ id: `p${i}`, createdAt: t(i) }));
      }

      const page = await store.list({ offset: 3 });
      expect(page).toHaveLength(2);
    });

    it('applies pagination with limit + offset', async () => {
      const t = (n: number) => `2025-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;
      for (let i = 1; i <= 10; i++) {
        await store.set(makeJob({ id: `p${i}`, createdAt: t(i) }));
      }

      const page = await store.list({ offset: 3, limit: 3 });
      expect(page).toHaveLength(3);
    });

    it('returns empty when status set is empty', async () => {
      const result = await store.list({ status: 'nonexistent' });
      expect(result).toEqual([]);
    });

    it('handles combined status and type filter', async () => {
      await store.set(makeJob({ id: 'j1', type: 'crawl', status: 'queued' }));
      await store.set(makeJob({ id: 'j2', type: 'crawl', status: 'completed' }));
      await store.set(makeJob({ id: 'j3', type: 'fetch', status: 'queued' }));

      const result = await store.list({ status: 'queued', type: 'crawl' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('j1');
    });
  });

  // -----------------------------------------------------------------------
  // count()
  // -----------------------------------------------------------------------

  describe('count()', () => {
    it('returns 0 for empty store', async () => {
      expect(await store.count()).toBe(0);
    });

    it('uses zCard for total count (no filter)', async () => {
      await store.set(makeJob({ id: 'a' }));
      await store.set(makeJob({ id: 'b' }));
      await store.set(makeJob({ id: 'c' }));

      const count = await store.count();
      expect(count).toBe(3);
      expect(client.zCard).toHaveBeenCalled();
    });

    it('uses sCard for status-only filter (fast path)', async () => {
      await store.set(makeJob({ id: 'q1', status: 'queued' }));
      await store.set(makeJob({ id: 'q2', status: 'queued' }));
      await store.set(makeJob({ id: 'r1', status: 'running' }));

      const count = await store.count({ status: 'queued' });
      expect(count).toBe(2);
      expect(client.sCard).toHaveBeenCalledWith('anno:jobs:status:queued');
    });

    it('falls back to list() for combined status+type filter', async () => {
      await store.set(makeJob({ id: 'j1', type: 'crawl', status: 'queued' }));
      await store.set(makeJob({ id: 'j2', type: 'fetch', status: 'queued' }));

      const count = await store.count({ status: 'queued', type: 'crawl' });
      expect(count).toBe(1);
    });

    it('falls back to list() for type-only filter', async () => {
      await store.set(makeJob({ id: 'f1', type: 'fetch' }));
      await store.set(makeJob({ id: 'c1', type: 'crawl' }));

      const count = await store.count({ type: 'fetch' });
      expect(count).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // cleanup()
  // -----------------------------------------------------------------------

  describe('cleanup()', () => {
    it('returns 0 when no old jobs exist', async () => {
      const recentTime = new Date().toISOString();
      await store.set(makeJob({ id: 'recent', status: 'completed', createdAt: recentTime }));

      const removed = await store.cleanup(60 * 60 * 1000);
      expect(removed).toBe(0);
    });

    it('removes old completed/failed/cancelled jobs', async () => {
      const oldTime = '2024-01-01T00:00:00.000Z';
      const recentTime = new Date().toISOString();

      await store.set(makeJob({ id: 'old-completed', status: 'completed', createdAt: oldTime }));
      await store.set(makeJob({ id: 'old-failed', status: 'failed', createdAt: oldTime }));
      await store.set(makeJob({ id: 'old-cancelled', status: 'cancelled', createdAt: oldTime }));
      await store.set(makeJob({ id: 'recent-completed', status: 'completed', createdAt: recentTime }));

      const removed = await store.cleanup(60 * 60 * 1000);
      expect(removed).toBe(3);
    });

    it('preserves old queued and running jobs', async () => {
      const oldTime = '2024-01-01T00:00:00.000Z';

      await store.set(makeJob({ id: 'old-queued', status: 'queued', createdAt: oldTime }));
      await store.set(makeJob({ id: 'old-running', status: 'running', createdAt: oldTime }));
      await store.set(makeJob({ id: 'old-completed', status: 'completed', createdAt: oldTime }));

      const removed = await store.cleanup(60 * 60 * 1000);
      expect(removed).toBe(1);

      // Queued and running should still be there
      const queued = await store.get('old-queued');
      expect(queued).not.toBeNull();
      const running = await store.get('old-running');
      expect(running).not.toBeNull();
    });

    it('cleans up orphaned index entries when key is already expired', async () => {
      const oldTime = '2024-01-01T00:00:00.000Z';
      const timestamp = new Date(oldTime).getTime();

      // Manually add to sorted set but not to key-value store (simulates expired key)
      client._sortedSets.set('anno:jobs:by_created', new Map([['ghost-job', timestamp]]));

      const removed = await store.cleanup(60 * 60 * 1000);
      expect(removed).toBe(1);
      expect(client.zRem).toHaveBeenCalledWith('anno:jobs:by_created', 'ghost-job');
    });
  });
});

// ---------------------------------------------------------------------------
// createJobStore factory
// ---------------------------------------------------------------------------

describe('createJobStore factory', () => {
  const mockConnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
  const mockPing = vi.hoisted(() => vi.fn().mockResolvedValue('PONG'));
  const mockOn = vi.hoisted(() => vi.fn().mockReturnThis());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns InMemoryJobStore when Redis is disabled', async () => {
    vi.doMock('../config/env', () => ({
      config: {
        redis: { enabled: false, url: 'redis://localhost:6379' },
      },
    }));

    vi.resetModules();

    vi.doMock('../utils/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const { createJobStore, InMemoryJobStore } = await import('../services/job-store');
    const store: JobStore = await createJobStore();

    expect(store).toBeInstanceOf(InMemoryJobStore);
  });

  it('returns InMemoryJobStore when Redis connection fails', async () => {
    vi.doMock('../config/env', () => ({
      config: {
        redis: { enabled: true, url: 'redis://localhost:6379' },
      },
    }));

    vi.doMock('redis', () => ({
      createClient: () => ({
        on: vi.fn().mockReturnThis(),
        connect: vi.fn().mockRejectedValue(new Error('Connection refused')),
        ping: vi.fn(),
      }),
    }));

    vi.resetModules();

    vi.doMock('../utils/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const { createJobStore, InMemoryJobStore } = await import('../services/job-store');
    const store: JobStore = await createJobStore();

    expect(store).toBeInstanceOf(InMemoryJobStore);
  });

  it('returns RedisJobStore when Redis connection succeeds', async () => {
    vi.doMock('../config/env', () => ({
      config: {
        redis: { enabled: true, url: 'redis://localhost:6379' },
      },
    }));

    vi.doMock('redis', () => ({
      createClient: () => ({
        on: mockOn,
        connect: mockConnect,
        ping: mockPing,
      }),
    }));

    vi.resetModules();

    vi.doMock('../utils/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const { createJobStore, RedisJobStore: RedisJobStoreCls } = await import('../services/job-store');
    const store: JobStore = await createJobStore();

    expect(store).toBeInstanceOf(RedisJobStoreCls);
  });
});
