/**
 * Persistent Job Store
 *
 * Provides a Redis-backed persistent store for job records with graceful
 * fallback to an in-memory Map when Redis is unavailable.
 *
 * Redis key patterns:
 * - `anno:job:{id}` — individual job record (JSON string)
 * - `anno:jobs:by_created` — sorted set of job IDs scored by creation timestamp
 * - `anno:jobs:status:{status}` — set of job IDs with a given status
 *
 * @module services/job-store
 */

import { createClient, RedisClientType } from 'redis';
import { config } from '../config/env';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobRecord {
  id: string;
  type: string;
  status: string;
  payload: unknown;
  options: Record<string, unknown>;
  progress: number;
  statusMessage?: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  attempts: number;
}

export interface JobStore {
  get(jobId: string): Promise<JobRecord | null>;
  set(job: JobRecord): Promise<void>;
  delete(jobId: string): Promise<boolean>;
  list(filter?: { status?: string; type?: string; limit?: number; offset?: number }): Promise<JobRecord[]>;
  count(filter?: { status?: string; type?: string }): Promise<number>;
  cleanup(maxAge: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'anno:job:';
const SORTED_SET_KEY = 'anno:jobs:by_created';
const STATUS_SET_PREFIX = 'anno:jobs:status:';
const DEFAULT_COMPLETED_TTL = 24 * 60 * 60; // 24 hours in seconds

// ---------------------------------------------------------------------------
// RedisJobStore
// ---------------------------------------------------------------------------

export class RedisJobStore implements JobStore {
  private client: RedisClientType;
  private completedTtlSeconds: number;

  constructor(client: RedisClientType, options?: { completedTtlSeconds?: number }) {
    this.client = client;
    this.completedTtlSeconds = options?.completedTtlSeconds ?? DEFAULT_COMPLETED_TTL;
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const data = await this.client.get(`${KEY_PREFIX}${jobId}`);
    if (!data) return null;
    return JSON.parse(data) as JobRecord;
  }

  async set(job: JobRecord): Promise<void> {
    const key = `${KEY_PREFIX}${job.id}`;
    const json = JSON.stringify(job);
    const createdTimestamp = new Date(job.createdAt).getTime();

    // Determine if this job already exists so we can remove old status index
    const existing = await this.client.get(key);
    if (existing) {
      const oldJob = JSON.parse(existing) as JobRecord;
      if (oldJob.status !== job.status) {
        await this.client.sRem(`${STATUS_SET_PREFIX}${oldJob.status}`, job.id);
      }
    }

    const isTerminal = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';

    if (isTerminal) {
      await this.client.set(key, json, { EX: this.completedTtlSeconds });
    } else {
      await this.client.set(key, json);
    }

    // Add to sorted set for ordering
    await this.client.zAdd(SORTED_SET_KEY, { score: createdTimestamp, value: job.id });

    // Add to status index
    await this.client.sAdd(`${STATUS_SET_PREFIX}${job.status}`, job.id);
  }

  async delete(jobId: string): Promise<boolean> {
    const key = `${KEY_PREFIX}${jobId}`;
    const data = await this.client.get(key);
    if (!data) return false;

    const job = JSON.parse(data) as JobRecord;

    await this.client.del(key);
    await this.client.zRem(SORTED_SET_KEY, jobId);
    await this.client.sRem(`${STATUS_SET_PREFIX}${job.status}`, jobId);

    return true;
  }

  async list(filter?: { status?: string; type?: string; limit?: number; offset?: number }): Promise<JobRecord[]> {
    let jobIds: string[];

    if (filter?.status) {
      // Use the status index set
      jobIds = await this.client.sMembers(`${STATUS_SET_PREFIX}${filter.status}`);
    } else {
      // Get all job IDs from sorted set (ordered by creation time)
      jobIds = await this.client.zRange(SORTED_SET_KEY, 0, -1);
    }

    if (jobIds.length === 0) return [];

    // Fetch all job records
    const pipeline = this.client.multi();
    for (const id of jobIds) {
      pipeline.get(`${KEY_PREFIX}${id}`);
    }
    const results = await pipeline.exec();

    const jobs: JobRecord[] = [];
    for (const result of results) {
      if (typeof result === 'string') {
        const job = JSON.parse(result) as JobRecord;

        // Apply type filter if specified
        if (filter?.type && job.type !== filter.type) continue;

        jobs.push(job);
      }
    }

    // Sort by createdAt descending (newest first)
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // Apply pagination
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? jobs.length;
    return jobs.slice(offset, offset + limit);
  }

  async count(filter?: { status?: string; type?: string }): Promise<number> {
    if (filter?.status && !filter?.type) {
      // Fast path: use status set cardinality
      return await this.client.sCard(`${STATUS_SET_PREFIX}${filter.status}`);
    }

    if (!filter?.status && !filter?.type) {
      // Fast path: use sorted set cardinality
      return await this.client.zCard(SORTED_SET_KEY);
    }

    // Slow path: need to filter by type — must fetch and filter
    const jobs = await this.list(filter);
    return jobs.length;
  }

  async cleanup(maxAge: number): Promise<number> {
    const cutoff = Date.now() - maxAge;
    let removed = 0;

    // Get all job IDs created before the cutoff
    const oldJobIds = await this.client.zRangeByScore(SORTED_SET_KEY, 0, cutoff);

    for (const jobId of oldJobIds) {
      const data = await this.client.get(`${KEY_PREFIX}${jobId}`);
      if (!data) {
        // Key expired already; clean up indexes
        await this.client.zRem(SORTED_SET_KEY, jobId);
        removed++;
        continue;
      }

      const job = JSON.parse(data) as JobRecord;

      // Only remove completed/failed/cancelled jobs
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        await this.client.del(`${KEY_PREFIX}${jobId}`);
        await this.client.zRem(SORTED_SET_KEY, jobId);
        await this.client.sRem(`${STATUS_SET_PREFIX}${job.status}`, jobId);
        removed++;
      }
    }

    return removed;
  }
}

// ---------------------------------------------------------------------------
// InMemoryJobStore
// ---------------------------------------------------------------------------

export class InMemoryJobStore implements JobStore {
  private store = new Map<string, JobRecord>();

  async get(jobId: string): Promise<JobRecord | null> {
    const job = this.store.get(jobId);
    return job ? { ...job } : null;
  }

  async set(job: JobRecord): Promise<void> {
    this.store.set(job.id, { ...job });
  }

  async delete(jobId: string): Promise<boolean> {
    return this.store.delete(jobId);
  }

  async list(filter?: { status?: string; type?: string; limit?: number; offset?: number }): Promise<JobRecord[]> {
    const jobs: JobRecord[] = [];

    for (const job of this.store.values()) {
      if (filter?.status && job.status !== filter.status) continue;
      if (filter?.type && job.type !== filter.type) continue;
      jobs.push({ ...job });
    }

    // Sort by createdAt descending (newest first)
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // Apply pagination
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? jobs.length;
    return jobs.slice(offset, offset + limit);
  }

  async count(filter?: { status?: string; type?: string }): Promise<number> {
    if (!filter?.status && !filter?.type) {
      return this.store.size;
    }

    let count = 0;
    for (const job of this.store.values()) {
      if (filter?.status && job.status !== filter.status) continue;
      if (filter?.type && job.type !== filter.type) continue;
      count++;
    }
    return count;
  }

  async cleanup(maxAge: number): Promise<number> {
    const cutoff = Date.now() - maxAge;
    let removed = 0;

    for (const [id, job] of this.store) {
      const createdTime = new Date(job.createdAt).getTime();
      if (createdTime <= cutoff) {
        // Only remove terminal jobs
        if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
          this.store.delete(id);
          removed++;
        }
      }
    }

    return removed;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a JobStore instance. Attempts to use Redis if enabled and reachable;
 * falls back to InMemoryJobStore otherwise.
 */
export async function createJobStore(options?: { completedTtlSeconds?: number }): Promise<JobStore> {
  if (!config.redis.enabled) {
    logger.info('JobStore: Redis disabled, using in-memory store');
    return new InMemoryJobStore();
  }

  try {
    const client = createClient({
      url: config.redis.url || 'redis://localhost:6379',
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: (retries) => {
          if (retries > 3) {
            logger.error('JobStore: Redis max reconnection attempts reached');
            return false;
          }
          return Math.min(retries * 100, 3000);
        },
      },
    });

    client.on('error', (err) => {
      logger.error('JobStore Redis client error', { error: (err as Error).message });
    });

    await client.connect();

    // Verify connectivity with a PING
    await client.ping();

    logger.info('JobStore: Using Redis-backed persistent store', { url: config.redis.url });
    return new RedisJobStore(client as RedisClientType, options);
  } catch (error: unknown) {
    logger.warn('JobStore: Redis unavailable, falling back to in-memory store', {
      error: (error as Error).message,
    });
    return new InMemoryJobStore();
  }
}
