import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { runPipeline } from '../../core/pipeline';
import { logger } from '../../utils/logger';
import { config } from '../../config/env';

const router = Router();

const requestSchema = z.object({
  url: z.string().url(),
  options: z
    .object({
      useCache: z.boolean().default(true),
      maxNodes: z.number().int().min(1).max(100).default(60),
      render: z.boolean().default(config.rendering.enabled)
    })
    .default({ useCache: true, maxNodes: 60, render: config.rendering.enabled })
});

const batchRequestSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(10),
  options: z
    .object({
      useCache: z.boolean().default(true),
      maxNodes: z.number().int().min(1).max(100).default(60),
      render: z.boolean().default(config.rendering.enabled),
      parallel: z.number().int().min(1).max(5).default(3)
    })
    .default({ useCache: true, maxNodes: 60, render: config.rendering.enabled, parallel: 3 })
});

const sendEvent = (res: Response, event: unknown): boolean => {
  // Check if response is still writable before attempting to write
  if (res.writableEnded || res.destroyed) {
    return false;
  }

  try {
    return res.write(`${JSON.stringify(event)}\n`);
  } catch (error) {
    // Catch EPIPE and other write errors (client disconnected)
    if ((error as NodeJS.ErrnoException).code === 'EPIPE' ||
        (error as NodeJS.ErrnoException).code === 'ERR_STREAM_DESTROYED') {
      logger.debug('client disconnected during response', {
        error: (error as Error).message
      });
    } else {
      logger.error('failed to write event', {
        error: (error as Error).message
      });
    }
    return false;
  }
};

router.post('/fetch', async (req: Request, res: Response) => {
  const parseResult = requestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'invalid_request',
      details: parseResult.error.flatten()
    });
    return;
  }

  const {
    url,
    options: { useCache, maxNodes, render }
  } = parseResult.data;

  res.setHeader('Content-Type', 'application/x-ndjson');

  // Handle client disconnect gracefully
  let clientDisconnected = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      logger.debug('client disconnected before response complete', { url });
    }
  });

  res.on('error', (error: Error) => {
    clientDisconnected = true;
    logger.debug('response stream error', { url, error: error.message });
  });

  try {
    for await (const event of runPipeline({ url, useCache, maxNodes, mode: render ? 'rendered' : 'http' })) {
      if (clientDisconnected) {
        break;
      }
      const written = sendEvent(res, event);
      if (!written || res.writableEnded) {
        // Client disconnected or response ended
        break;
      }
    }
  } catch (error) {
    if (!clientDisconnected) {
      logger.error('pipeline error', { url, error: (error as Error).message });
      sendEvent(res, {
        type: 'error',
        payload: {
          message: (error as Error).message
        }
      });
    }
  } finally {
    if (!res.writableEnded && !clientDisconnected) {
      try {
        res.end();
      } catch (error) {
        // Ignore EPIPE on res.end() - client already disconnected
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
          logger.error('failed to end response', { url, error: (error as Error).message });
        }
      }
    }
  }
});

/**
 * Batch fetch multiple URLs in parallel
 * Returns NDJSON stream with batch_start, source_start, events, source_end, batch_end
 */
router.post('/batch-fetch', async (req: Request, res: Response) => {
  const parseResult = batchRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'invalid_request',
      details: parseResult.error.flatten()
    });
    return;
  }

  const {
    urls,
    options: { useCache, maxNodes, render, parallel }
  } = parseResult.data;

  res.setHeader('Content-Type', 'application/x-ndjson');

  // Send batch start event
  sendEvent(res, {
    type: 'batch_start',
    payload: {
      totalUrls: urls.length,
      parallelism: parallel,
      timestamp: Date.now()
    }
  });

  try {
    // Process URLs in parallel batches
    for (let i = 0; i < urls.length; i += parallel) {
      const batch = urls.slice(i, i + parallel);

      await Promise.all(
        batch.map(async (url, batchIndex) => {
          const urlIndex = i + batchIndex;

          // Send source start event
          sendEvent(res, {
            type: 'source_start',
            payload: {
              url,
              index: urlIndex,
              timestamp: Date.now()
            }
          });

          try {
            // Stream all events for this URL
            for await (const event of runPipeline({ url, useCache, maxNodes, mode: render ? 'rendered' : 'http' })) {
              // Wrap the event with source metadata
              sendEvent(res, {
                type: 'source_event',
                payload: {
                  url,
                  index: urlIndex,
                  event
                }
              });

              if (res.writableEnded) {
                break;
              }
            }

            // Send source end event
            sendEvent(res, {
              type: 'source_end',
              payload: {
                url,
                index: urlIndex,
                status: 'success',
                timestamp: Date.now()
              }
            });
          } catch (error) {
            logger.error('batch pipeline error', { url, error: (error as Error).message });

            // Send source error event
            sendEvent(res, {
              type: 'source_end',
              payload: {
                url,
                index: urlIndex,
                status: 'error',
                error: (error as Error).message,
                timestamp: Date.now()
              }
            });
          }
        })
      );
    }

    // Send batch end event
    sendEvent(res, {
      type: 'batch_end',
      payload: {
        totalUrls: urls.length,
        timestamp: Date.now()
      }
    });
  } catch (error) {
    logger.error('batch fetch error', { error: (error as Error).message });
    sendEvent(res, {
      type: 'batch_error',
      payload: {
        message: (error as Error).message
      }
    });
  } finally {
    res.end();
  }
});

export const contentRouter = router;
