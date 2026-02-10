/**
 * Interaction API Routes
 *
 * Exposes browser interaction capabilities (click, fill, scroll, screenshot, etc.)
 * through REST endpoints. Uses the InteractionManager with Playwright pages
 * obtained via the RendererManager.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { rendererManager } from '../../services/renderer';
import { interactionManager, type BrowserAction, type PageState } from '../../services/interaction-manager';
import { distillContent } from '../../services/distiller';
import { asyncHandler } from '../../middleware/error-handler';
import { logger } from '../../utils/logger';

const router = Router();

// ---------------------------------------------------------------------------
// Request timeout for interaction endpoints (60s — interactions can be slow)
// ---------------------------------------------------------------------------

const INTERACTION_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const browserActionSchema = z.object({
  type: z.enum([
    'click', 'fill', 'select', 'scroll', 'hover',
    'waitFor', 'type', 'screenshot', 'evaluate', 'getPageState'
  ]),
  selector: z.string().optional(),
  value: z.string().optional(),
  values: z.array(z.string()).optional(),
  direction: z.enum(['up', 'down', 'top', 'bottom']).optional(),
  condition: z.object({
    kind: z.enum(['selector', 'timeout', 'networkidle', 'expression']),
    selector: z.string().optional(),
    ms: z.number().optional(),
    expression: z.string().optional()
  }).optional(),
  expression: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional()
});

const interactRequestSchema = z.object({
  url: z.string().url(),
  sessionId: z.string().optional(),
  actions: z.array(browserActionSchema).min(0).default([]),
  extract: z.boolean().default(false),
  extractPolicy: z.string().default('default')
});

const screenshotRequestSchema = z.object({
  url: z.string().url(),
  actions: z.array(browserActionSchema).default([]),
  fullPage: z.boolean().default(false)
});

const pageStateRequestSchema = z.object({
  url: z.string().url(),
  actions: z.array(browserActionSchema).default([])
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to a URL on the given page with a reasonable timeout.
 */
async function navigateToUrl(page: import('playwright-core').Page, url: string): Promise<void> {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000
  });
}

// ---------------------------------------------------------------------------
// POST /interact
// ---------------------------------------------------------------------------

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const parseResult = interactRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Request validation failed',
      details: parseResult.error.flatten(),
      timestamp: Date.now(),
      path: req.path
    });
    return;
  }

  const { url, actions, extract, extractPolicy } = parseResult.data;

  logger.info('interact: request received', {
    url,
    actionCount: actions.length,
    extract,
    extractPolicy
  });

  const overallStart = Date.now();

  // Set a request-level timeout
  req.setTimeout(INTERACTION_TIMEOUT_MS);

  const { result } = await rendererManager.withPage(async (page) => {
    // Navigate to the target URL
    await navigateToUrl(page, url);

    // Execute the action sequence
    const actionResults = actions.length > 0
      ? await interactionManager.executeActions(page, actions as BrowserAction[])
      : [];

    // Get final page state
    const pageState: PageState = await interactionManager.getPageState(page);

    // Optionally extract content from the final page
    let extraction = null;
    if (extract) {
      try {
        const html = await page.content();
        const finalUrl = page.url();
        extraction = await distillContent(html, finalUrl, extractPolicy);
        logger.info('interact: extraction completed', { url: finalUrl });
      } catch (err) {
        logger.warn('interact: extraction failed', {
          error: (err as Error).message
        });
        extraction = { error: (err as Error).message };
      }
    }

    const totalDuration = Date.now() - overallStart;

    return {
      success: true,
      results: actionResults,
      pageState,
      extraction,
      totalDuration
    };
  });

  logger.info('interact: request completed', {
    url,
    totalDuration: result.totalDuration
  });

  res.json(result);
}));

// ---------------------------------------------------------------------------
// POST /interact/screenshot
// ---------------------------------------------------------------------------

router.post('/screenshot', asyncHandler(async (req: Request, res: Response) => {
  const parseResult = screenshotRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Request validation failed',
      details: parseResult.error.flatten(),
      timestamp: Date.now(),
      path: req.path
    });
    return;
  }

  const { url, actions, fullPage } = parseResult.data;

  logger.info('interact/screenshot: request received', {
    url,
    actionCount: actions.length,
    fullPage
  });

  req.setTimeout(INTERACTION_TIMEOUT_MS);

  const { result } = await rendererManager.withPage(async (page) => {
    // Navigate to the target URL
    await navigateToUrl(page, url);

    // Execute any preparatory actions before the screenshot
    if (actions.length > 0) {
      await interactionManager.executeActions(page, actions as BrowserAction[]);
    }

    // Take the screenshot
    const screenshot = await interactionManager.screenshot(page, { fullPage });

    // Collect page state
    const pageUrl = page.url();
    const pageTitle = await page.title();

    return {
      success: true,
      screenshot,
      pageState: {
        url: pageUrl,
        title: pageTitle
      }
    };
  });

  logger.info('interact/screenshot: request completed', { url });

  res.json(result);
}));

// ---------------------------------------------------------------------------
// POST /interact/page-state
// ---------------------------------------------------------------------------

router.post('/page-state', asyncHandler(async (req: Request, res: Response) => {
  const parseResult = pageStateRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Request validation failed',
      details: parseResult.error.flatten(),
      timestamp: Date.now(),
      path: req.path
    });
    return;
  }

  const { url, actions } = parseResult.data;

  logger.info('interact/page-state: request received', {
    url,
    actionCount: actions.length
  });

  req.setTimeout(INTERACTION_TIMEOUT_MS);

  const { result } = await rendererManager.withPage(async (page) => {
    // Navigate to the target URL
    await navigateToUrl(page, url);

    // Execute any preparatory actions before inspecting state
    if (actions.length > 0) {
      await interactionManager.executeActions(page, actions as BrowserAction[]);
    }

    // Get the full interactive page state
    const pageState = await interactionManager.getPageState(page);

    return {
      success: true,
      pageState
    };
  });

  logger.info('interact/page-state: request completed', {
    url,
    elementCount: result.pageState.interactiveElements.length
  });

  res.json(result);
}));

export const interactRouter = router;
