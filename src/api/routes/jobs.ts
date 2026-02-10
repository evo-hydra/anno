/**
 * Jobs API Routes
 *
 * REST endpoints for the async job queue. Supports submitting jobs,
 * polling for status, listing/filtering jobs, cancellation, and
 * Server-Sent Events (SSE) for real-time progress streaming.
 *
 * Endpoints:
 *   POST   /v1/jobs              Submit a new job
 *   GET    /v1/jobs              List jobs (with optional ?status=&type= filters)
 *   GET    /v1/jobs/:jobId       Get job status and progress
 *   DELETE /v1/jobs/:jobId       Cancel a job
 *   GET    /v1/jobs/:jobId/stream  SSE progress stream
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getJobQueue } from '../../services/job-queue';
import { asyncHandler } from '../../middleware/error-handler';
import { logger } from '../../utils/logger';
import type { JobStatus, JobType } from '../../services/job-queue';

const router = Router();

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const jobOptionsSchema = z.object({
  priority: z.number().int().min(1).max(10).default(5).optional(),
  webhookUrl: z.string().url().optional(),
  retries: z.number().int().min(0).max(10).default(0).optional(),
  timeout: z.number().int().min(1000).max(3_600_000).default(300_000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).optional();

const submitJobSchema = z.object({
  type: z.enum(['fetch', 'crawl', 'extract', 'workflow', 'research']),
  payload: z.unknown(),
  options: jobOptionsSchema,
});

const VALID_STATUSES: JobStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled'];
const VALID_TYPES: JobType[] = ['fetch', 'crawl', 'extract', 'workflow', 'research'];

// ---------------------------------------------------------------------------
// POST /  — Submit a new job
// ---------------------------------------------------------------------------

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const parseResult = submitJobSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Job submission validation failed',
      details: parseResult.error.flatten(),
      timestamp: Date.now(),
      path: req.path,
    });
    return;
  }

  const { type, payload, options } = parseResult.data;
  const queue = getJobQueue();

  const jobId = queue.enqueue(type, payload, options ?? undefined);

  logger.info('Job submitted via API', { jobId, type });

  res.status(202).json({
    jobId,
    status: 'queued',
  });
}));

// ---------------------------------------------------------------------------
// GET /  — List jobs with optional filters
// ---------------------------------------------------------------------------

router.get('/', (_req: Request, res: Response) => {
  const queue = getJobQueue();

  // Parse query filters
  const statusParam = _req.query.status;
  const typeParam = _req.query.type;

  const filter: { status?: JobStatus; type?: JobType } = {};

  if (typeof statusParam === 'string' && VALID_STATUSES.includes(statusParam as JobStatus)) {
    filter.status = statusParam as JobStatus;
  }

  if (typeof typeParam === 'string' && VALID_TYPES.includes(typeParam as JobType)) {
    filter.type = typeParam as JobType;
  }

  const jobs = queue.listJobs(Object.keys(filter).length > 0 ? filter : undefined);

  res.json({
    jobs,
    count: jobs.length,
    stats: queue.getStats(),
  });
});

// ---------------------------------------------------------------------------
// GET /:jobId  — Get job status and progress
// ---------------------------------------------------------------------------

router.get('/:jobId', (req: Request, res: Response) => {
  const { jobId } = req.params;
  const queue = getJobQueue();
  const job = queue.getJob(jobId);

  if (!job) {
    res.status(404).json({
      error: 'job_not_found',
      message: `Job '${jobId}' not found`,
      timestamp: Date.now(),
      path: req.path,
    });
    return;
  }

  res.json(job);
});

// ---------------------------------------------------------------------------
// DELETE /:jobId  — Cancel a job
// ---------------------------------------------------------------------------

router.delete('/:jobId', (req: Request, res: Response) => {
  const { jobId } = req.params;
  const queue = getJobQueue();

  const job = queue.getJob(jobId);
  if (!job) {
    res.status(404).json({
      error: 'job_not_found',
      message: `Job '${jobId}' not found`,
      timestamp: Date.now(),
      path: req.path,
    });
    return;
  }

  const cancelled = queue.cancel(jobId);
  if (!cancelled) {
    res.status(409).json({
      error: 'cannot_cancel',
      message: `Job '${jobId}' is in status '${job.status}' and cannot be cancelled`,
      timestamp: Date.now(),
      path: req.path,
    });
    return;
  }

  logger.info('Job cancelled via API', { jobId });

  res.json({
    jobId,
    status: 'cancelled',
    message: 'Job has been cancelled',
  });
});

// ---------------------------------------------------------------------------
// GET /:jobId/stream  — SSE progress stream
// ---------------------------------------------------------------------------

router.get('/:jobId/stream', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  const queue = getJobQueue();
  const job = queue.getJob(jobId);

  if (!job) {
    res.status(404).json({
      error: 'job_not_found',
      message: `Job '${jobId}' not found`,
      timestamp: Date.now(),
      path: req.path,
    });
    return;
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // Disable nginx buffering
  });

  // Send initial comment to establish connection
  res.write(':ok\n\n');

  let closed = false;

  // Handle client disconnect
  req.on('close', () => {
    closed = true;
  });

  try {
    const stream = queue.streamProgress(jobId);

    for await (const event of stream) {
      if (closed) break;

      const eventLine = `event: ${event.event}\n`;
      const dataLine = `data: ${JSON.stringify(event.data)}\n\n`;

      res.write(eventLine);
      res.write(dataLine);
    }
  } catch (err) {
    if (!closed) {
      logger.warn('SSE stream error', { jobId, error: (err as Error).message });
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'stream_error' })}\n\n`);
    }
  }

  // End the response
  if (!closed) {
    res.end();
  }
});

export const jobsRouter = router;
