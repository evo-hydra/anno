/**
 * Crawl API Routes
 *
 * Exposes the Crawler service through REST endpoints for starting, monitoring,
 * and retrieving results from background crawl jobs. Crawls are long-running
 * operations, so POST /crawl returns immediately with a job ID and the caller
 * polls for progress/results.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { createCrawler, type CrawlOptions, type CrawlResult } from '../../services/crawler';
import { asyncHandler } from '../../middleware/error-handler';
import { logger } from '../../utils/logger';

const router = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CrawlJob {
  jobId: string;
  status: 'running' | 'completed' | 'cancelled' | 'error';
  startUrl: string;
  startedAt: string;
  completedAt?: string;
  progress: {
    pagesCompleted: number;
    pagesTotal: number;
    currentUrl?: string;
  };
  result?: CrawlResult;
  abortController: AbortController;
  error?: string;
}

// ---------------------------------------------------------------------------
// Job store (in-memory, LRU-limited)
// ---------------------------------------------------------------------------

const MAX_COMPLETED_JOBS = 50;
const jobs = new Map<string, CrawlJob>();

/**
 * Evict oldest completed jobs when the store exceeds the limit.
 */
function evictCompletedJobs(): void {
  const completedJobs: Array<{ id: string; completedAt: string }> = [];

  for (const [id, job] of jobs) {
    if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'error') {
      completedJobs.push({ id, completedAt: job.completedAt ?? job.startedAt });
    }
  }

  if (completedJobs.length > MAX_COMPLETED_JOBS) {
    // Sort oldest first
    completedJobs.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
    const toRemove = completedJobs.length - MAX_COMPLETED_JOBS;
    for (let i = 0; i < toRemove; i++) {
      jobs.delete(completedJobs[i].id);
    }
  }
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const crawlRequestSchema = z.object({
  url: z.string().url(),
  options: z.object({
    maxDepth: z.number().int().min(0).max(10).default(2),
    maxPages: z.number().int().min(1).max(500).default(20),
    pathPrefix: z.string().optional(),
    includePatterns: z.array(z.string()).optional(),
    excludePatterns: z.array(z.string()).optional(),
    respectRobots: z.boolean().default(true),
    renderJs: z.boolean().default(false),
    extractContent: z.boolean().default(true),
    concurrency: z.number().int().min(1).max(10).default(2),
    strategy: z.enum(['bfs', 'dfs']).default('bfs'),
    sitemapUrl: z.string().url().optional(),
  }).default({
    maxDepth: 2,
    maxPages: 20,
    respectRobots: true,
    renderJs: false,
    extractContent: true,
    concurrency: 2,
    strategy: 'bfs' as const
  })
});

// ---------------------------------------------------------------------------
// POST /crawl  — Start a new crawl job
// ---------------------------------------------------------------------------

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const parseResult = crawlRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'invalid_request',
      details: parseResult.error.flatten()
    });
    return;
  }

  const { url, options } = parseResult.data;
  const jobId = crypto.randomUUID();
  const abortController = new AbortController();

  const crawlOptions: CrawlOptions = {
    ...options,
    signal: abortController.signal
  };

  const job: CrawlJob = {
    jobId,
    status: 'running',
    startUrl: url,
    startedAt: new Date().toISOString(),
    progress: {
      pagesCompleted: 0,
      pagesTotal: options.maxPages
    },
    abortController
  };

  jobs.set(jobId, job);

  logger.info('Crawl job started', { jobId, startUrl: url, options });

  // Return immediately — crawl runs in background
  res.status(202).json({
    jobId,
    status: 'running',
    startUrl: url,
    startedAt: job.startedAt
  });

  // Start crawl in the background (fire-and-forget)
  const crawler = createCrawler();

  crawler.on('page:fetched', (event: { url: string; depth: number; httpStatus: number }) => {
    const currentJob = jobs.get(jobId);
    if (currentJob) {
      currentJob.progress.pagesCompleted++;
      currentJob.progress.currentUrl = event.url;
    }
  });

  crawler.on('page:error', (event: { url: string; error: string }) => {
    const currentJob = jobs.get(jobId);
    if (currentJob) {
      currentJob.progress.pagesCompleted++;
      currentJob.progress.currentUrl = event.url;
    }
  });

  crawler.on('crawl:complete', (result: CrawlResult) => {
    const currentJob = jobs.get(jobId);
    if (currentJob) {
      currentJob.status = result.status === 'cancelled' ? 'cancelled' : 'completed';
      currentJob.completedAt = new Date().toISOString();
      currentJob.result = result;
      currentJob.progress.pagesCompleted = result.stats.totalPages;
      logger.info('Crawl job completed', {
        jobId,
        status: currentJob.status,
        totalPages: result.stats.totalPages,
        durationMs: result.stats.totalDuration
      });
      evictCompletedJobs();
    }
  });

  crawler.crawl(url, crawlOptions).catch((error) => {
    const currentJob = jobs.get(jobId);
    if (currentJob && currentJob.status === 'running') {
      currentJob.status = 'error';
      currentJob.completedAt = new Date().toISOString();
      currentJob.error = error instanceof Error ? error.message : 'unknown error';
      logger.error('Crawl job failed', { jobId, error: currentJob.error });
    }
  });
}));

// ---------------------------------------------------------------------------
// GET /crawl/jobs  — List all crawl jobs
// ---------------------------------------------------------------------------

router.get('/jobs', (_req: Request, res: Response) => {
  const jobList = Array.from(jobs.values()).map((job) => {
    const elapsed = job.completedAt
      ? new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()
      : Date.now() - new Date(job.startedAt).getTime();

    return {
      jobId: job.jobId,
      status: job.status,
      startUrl: job.startUrl,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      elapsed,
      progress: job.progress,
      ...(job.error ? { error: job.error } : {}),
      ...(job.result ? {
        stats: job.result.stats
      } : {})
    };
  });

  res.json({ jobs: jobList });
});

// ---------------------------------------------------------------------------
// GET /crawl/:jobId  — Get crawl job status and progress
// ---------------------------------------------------------------------------

router.get('/:jobId', (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: 'job_not_found', jobId });
    return;
  }

  const elapsed = job.completedAt
    ? new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()
    : Date.now() - new Date(job.startedAt).getTime();

  const response: Record<string, unknown> = {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    startUrl: job.startUrl,
    startedAt: job.startedAt,
    elapsed
  };

  if (job.completedAt) {
    response.completedAt = job.completedAt;
  }

  if (job.error) {
    response.error = job.error;
  }

  if (job.status === 'completed' && job.result) {
    response.stats = job.result.stats;
  }

  res.json(response);
});

// ---------------------------------------------------------------------------
// GET /crawl/:jobId/results  — Get full crawl results
// ---------------------------------------------------------------------------

router.get('/:jobId/results', (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: 'job_not_found', jobId });
    return;
  }

  if (job.status === 'running') {
    res.status(409).json({
      error: 'crawl_in_progress',
      message: 'Crawl is still running. Poll GET /crawl/:jobId for progress.',
      progress: job.progress
    });
    return;
  }

  if (!job.result) {
    res.status(404).json({
      error: 'no_results',
      message: `Crawl finished with status '${job.status}' but no results are available.`,
      ...(job.error ? { crawlError: job.error } : {})
    });
    return;
  }

  res.json(job.result);
});

// ---------------------------------------------------------------------------
// DELETE /crawl/:jobId  — Cancel a running crawl
// ---------------------------------------------------------------------------

router.delete('/:jobId', (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: 'job_not_found', jobId });
    return;
  }

  if (job.status !== 'running') {
    res.status(409).json({
      error: 'not_running',
      message: `Crawl job is already '${job.status}' and cannot be cancelled.`
    });
    return;
  }

  // Signal cancellation via AbortController
  job.abortController.abort();
  job.status = 'cancelled';
  job.completedAt = new Date().toISOString();

  logger.info('Crawl job cancelled', { jobId });

  res.json({
    jobId: job.jobId,
    status: 'cancelled',
    message: 'Crawl job has been cancelled.',
    progress: job.progress
  });
});

export const crawlRouter = router;
