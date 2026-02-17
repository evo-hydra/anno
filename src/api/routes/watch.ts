/**
 * Watch API Routes — URL Change Monitoring
 *
 * Provides endpoints for registering, managing, and querying
 * URL watches that detect content changes over time.
 *
 * @module api/routes/watch
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { watchManager } from '../../services/watch-manager';
import { diffEngine } from '../../services/diff-engine';
import { logger } from '../../utils/logger';

const router = Router();

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const createWatchSchema = z.object({
  url: z.string().url(),
  interval: z.number().int().min(60).default(3600),
  webhookUrl: z.string().url().optional(),
  changeThreshold: z.number().min(0).max(100).default(1),
  extractPolicy: z.string().optional(),
});

// ---------------------------------------------------------------------------
// POST /v1/watch — Register a URL to watch
// ---------------------------------------------------------------------------

router.post('/', async (req: Request, res: Response) => {
  const parseResult = createWatchSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'invalid_request',
      details: parseResult.error.flatten(),
    });
    return;
  }

  const { url, interval, webhookUrl, changeThreshold, extractPolicy } = parseResult.data;

  try {
    const watch = await watchManager.addWatch(url, {
      interval,
      webhookUrl,
      changeThreshold,
      extractPolicy,
    });

    res.status(201).json(watch);
  } catch (err) {
    logger.error('Failed to create watch', {
      url,
      error: err instanceof Error ? err.message : 'unknown',
    });
    res.status(500).json({
      error: 'watch_creation_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/watch — List all watches
// ---------------------------------------------------------------------------

router.get('/', (_req: Request, res: Response) => {
  const watches = watchManager.listWatches();
  res.json({ watches, total: watches.length });
});

// ---------------------------------------------------------------------------
// GET /v1/watch/:watchId — Get watch status + recent events
// ---------------------------------------------------------------------------

router.get('/:watchId', async (req: Request, res: Response) => {
  const watchId = String(req.params.watchId);
  const watch = watchManager.getWatch(watchId);

  if (!watch) {
    res.status(404).json({ error: 'watch_not_found', watchId });
    return;
  }

  try {
    const events = await watchManager.getEvents(watchId, 10);
    res.json({ watch, recentEvents: events });
  } catch (err) {
    logger.error('Failed to get watch events', {
      watchId,
      error: err instanceof Error ? err.message : 'unknown',
    });
    res.json({ watch, recentEvents: [] });
  }
});

// ---------------------------------------------------------------------------
// DELETE /v1/watch/:watchId — Stop watching
// ---------------------------------------------------------------------------

router.delete('/:watchId', async (req: Request, res: Response) => {
  const watchId = String(req.params.watchId);

  const removed = await watchManager.removeWatch(watchId);
  if (!removed) {
    res.status(404).json({ error: 'watch_not_found', watchId });
    return;
  }

  res.json({ status: 'removed', watchId });
});

// ---------------------------------------------------------------------------
// PUT /v1/watch/:watchId/pause — Pause monitoring
// ---------------------------------------------------------------------------

router.put('/:watchId/pause', async (req: Request, res: Response) => {
  const watchId = String(req.params.watchId);

  const watch = await watchManager.pauseWatch(watchId);
  if (!watch) {
    res.status(404).json({ error: 'watch_not_found', watchId });
    return;
  }

  res.json(watch);
});

// ---------------------------------------------------------------------------
// PUT /v1/watch/:watchId/resume — Resume monitoring
// ---------------------------------------------------------------------------

router.put('/:watchId/resume', async (req: Request, res: Response) => {
  const watchId = String(req.params.watchId);

  const watch = await watchManager.resumeWatch(watchId);
  if (!watch) {
    res.status(404).json({ error: 'watch_not_found', watchId });
    return;
  }

  res.json(watch);
});

// ---------------------------------------------------------------------------
// GET /v1/watch/:watchId/events — Get change events
// ---------------------------------------------------------------------------

router.get('/:watchId/events', async (req: Request, res: Response) => {
  const watchId = String(req.params.watchId);
  const watch = watchManager.getWatch(watchId);

  if (!watch) {
    res.status(404).json({ error: 'watch_not_found', watchId });
    return;
  }

  const limitRaw = req.query.limit;
  const limit = typeof limitRaw === 'string' ? Math.min(Math.max(parseInt(limitRaw, 10) || 50, 1), 500) : 50;

  try {
    const events = await watchManager.getEvents(watchId, limit);
    res.json({ watchId, events, total: events.length });
  } catch (err) {
    logger.error('Failed to get watch events', {
      watchId,
      error: err instanceof Error ? err.message : 'unknown',
    });
    res.status(500).json({
      error: 'events_retrieval_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/watch/:watchId/history — Get change history from diff engine
// ---------------------------------------------------------------------------

router.get('/:watchId/history', async (req: Request, res: Response) => {
  const watchId = String(req.params.watchId);
  const watch = watchManager.getWatch(watchId);

  if (!watch) {
    res.status(404).json({ error: 'watch_not_found', watchId });
    return;
  }

  try {
    const history = await diffEngine.getHistory(watch.url);
    res.json({ watchId, url: watch.url, history });
  } catch (err) {
    logger.error('Failed to get watch history', {
      watchId,
      error: err instanceof Error ? err.message : 'unknown',
    });
    res.status(500).json({
      error: 'history_retrieval_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const watchRouter = router;
