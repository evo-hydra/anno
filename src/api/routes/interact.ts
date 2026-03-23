/**
 * Interaction API Routes
 *
 * Exposes browser interaction capabilities (click, fill, scroll, screenshot, etc.)
 * through REST endpoints. Uses the InteractionManager with Playwright pages
 * obtained via the RendererManager.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { Page } from 'playwright-core';
import { rendererManager } from '../../services/renderer';
import { getSessionManager } from '../../services/session-manager';
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
  sessionId: z.string().optional().describe('Reuse a persistent browser session'),
  actions: z.array(browserActionSchema).min(0).default([]),
  extract: z.boolean().default(false),
  extractPolicy: z.string().default('default'),
  createSession: z.boolean().default(false).describe('Create a new persistent session and return its ID'),
});

const screenshotRequestSchema = z.object({
  url: z.string().url(),
  sessionId: z.string().optional(),
  actions: z.array(browserActionSchema).default([]),
  fullPage: z.boolean().default(false),
  createSession: z.boolean().default(false),
});

const pageStateRequestSchema = z.object({
  url: z.string().url(),
  sessionId: z.string().optional(),
  actions: z.array(browserActionSchema).default([]),
  createSession: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to a URL on the given page with a reasonable timeout.
 */
async function navigateToUrl(page: Page, url: string): Promise<void> {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000
  });
}

/**
 * Execute work on a browser page — either from a persistent session or an
 * ephemeral renderer page. Returns the sessionId when a session is used.
 */
async function withSessionOrPage<T>(
  options: { sessionId?: string; createSession?: boolean },
  fn: (page: Page) => Promise<T>,
): Promise<{ result: T; sessionId?: string }> {
  // If sessionId provided, use existing session
  if (options.sessionId) {
    const sm = await getSessionManager();
    const page = await sm.getSessionPage(options.sessionId);
    const result = await fn(page);
    return { result, sessionId: options.sessionId };
  }

  // If createSession requested, create a new persistent session
  if (options.createSession) {
    const sm = await getSessionManager();
    const session = await sm.createSession({ name: 'mcp-interact' });
    const page = await sm.getSessionPage(session.id);
    const result = await fn(page);
    return { result, sessionId: session.id };
  }

  // Default: ephemeral page via renderer
  const { result } = await rendererManager.withPage(async (page) => {
    return fn(page);
  });
  return { result };
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

  const { url, actions, extract, extractPolicy, sessionId, createSession } = parseResult.data;

  logger.info('interact: request received', {
    url,
    actionCount: actions.length,
    extract,
    extractPolicy,
    sessionId: sessionId ?? null,
    createSession,
  });

  const overallStart = Date.now();

  // Set a request-level timeout
  req.setTimeout(INTERACTION_TIMEOUT_MS);

  const { result, sessionId: resolvedSessionId } = await withSessionOrPage(
    { sessionId, createSession },
    async (page) => {
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
    },
  );

  logger.info('interact: request completed', {
    url,
    totalDuration: result.totalDuration,
    sessionId: resolvedSessionId ?? null,
  });

  res.json({ ...result, sessionId: resolvedSessionId });
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

  const { url, actions, fullPage, sessionId, createSession } = parseResult.data;

  logger.info('interact/screenshot: request received', {
    url,
    actionCount: actions.length,
    fullPage,
    sessionId: sessionId ?? null,
  });

  req.setTimeout(INTERACTION_TIMEOUT_MS);

  const { result, sessionId: resolvedSessionId } = await withSessionOrPage(
    { sessionId, createSession },
    async (page) => {
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
    },
  );

  logger.info('interact/screenshot: request completed', { url });

  res.json({ ...result, sessionId: resolvedSessionId });
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

  const { url, actions, sessionId, createSession } = parseResult.data;

  logger.info('interact/page-state: request received', {
    url,
    actionCount: actions.length,
    sessionId: sessionId ?? null,
  });

  req.setTimeout(INTERACTION_TIMEOUT_MS);

  const { result, sessionId: resolvedSessionId } = await withSessionOrPage(
    { sessionId, createSession },
    async (page) => {
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
    },
  );

  logger.info('interact/page-state: request completed', {
    url,
    elementCount: result.pageState.interactiveElements.length
  });

  res.json({ ...result, sessionId: resolvedSessionId });
}));

export const interactRouter = router;
