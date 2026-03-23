import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { rendererManager } from '../../services/renderer';
import { detectChallengePage, detectChallengeSelectors } from '../../core/wall-detector';
import { logger } from '../../utils/logger';
import { extractErrorMessage } from '../../utils/error';
import { config } from '../../config/env';

const router = Router();

const sessionAuthSchema = z.object({
  domain: z.string().min(1),
  url: z.string().url(),
  cookies: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string(),
      })
    )
    .optional(),
  waitFor: z.string().optional(),
});

/**
 * POST /v1/session/auth
 *
 * Navigate to a URL with a real browser (Playwright + stealth),
 * injecting seed cookies. Solves Cloudflare challenges and returns
 * the full cookie jar — including cf_clearance.
 */
router.post('/auth', async (req: Request, res: Response) => {
  const parseResult = sessionAuthSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'Invalid request',
      details: parseResult.error.issues,
    });
    return;
  }

  const { domain, url, cookies: seedCookies, waitFor } = parseResult.data;

  // If rendering is disabled, return seed cookies unchanged (graceful degradation)
  if (!config.rendering.enabled) {
    logger.warn('session-auth: rendering disabled — returning seed cookies only', { domain });
    res.json({
      success: true,
      cookies: (seedCookies ?? []).map((c) => ({
        ...c,
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax' as const,
      })),
      challengeDetected: false,
      rendered: false,
    });
    return;
  }

  try {
    const { result } = await rendererManager.withPage(
      async (page, context) => {
        // Navigate to the URL — Playwright solves Cloudflare challenge
        const response = await page.goto(url, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        });

        // Check for challenge via both text patterns AND DOM selectors
        const bodyText = await page.content();
        const textChallenge = detectChallengePage(bodyText);
        const selectorChallenge = await detectChallengeSelectors(page);
        const challengeDetected = textChallenge !== null || selectorChallenge !== null;

        if (challengeDetected) {
          const reason = textChallenge?.reason ?? selectorChallenge?.reason;
          logger.info('session-auth: challenge detected, waiting for resolution', {
            domain,
            reason,
            method: textChallenge ? 'text' : 'selector',
          });

          // Wait for challenge to resolve (Cloudflare typically redirects after solving)
          try {
            await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15_000 });
          } catch {
            logger.debug('session-auth: navigation wait timed out — checking cookies anyway');
          }
        }

        // Wait for optional selector if provided
        if (waitFor) {
          try {
            await page.waitForSelector(waitFor, { timeout: 10_000 });
          } catch {
            logger.debug('session-auth: waitFor selector not found', { waitFor });
          }
        }

        // Extract all cookies from the browser context
        const allCookies = await context.cookies();

        return {
          cookies: allCookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite,
          })),
          challengeDetected,
          statusCode: response?.status() ?? 0,
        };
      },
      {
        cookies: seedCookies?.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: '/',
          secure: true,
          sameSite: 'Lax' as const,
        })),
      }
    );

    const hasCfClearance = result.cookies.some((c) => c.name === 'cf_clearance');

    logger.info('session-auth: completed', {
      domain,
      cookieCount: result.cookies.length,
      challengeDetected: result.challengeDetected,
      cfClearanceObtained: hasCfClearance,
      statusCode: result.statusCode,
    });

    res.json({
      success: true,
      cookies: result.cookies,
      challengeDetected: result.challengeDetected,
      rendered: true,
    });
  } catch (error) {
    const message = extractErrorMessage(error);
    logger.error('session-auth: failed', { domain, error: message });

    // If renderer fails, fall back to returning seed cookies
    if (message.includes('renderer unavailable')) {
      res.json({
        success: true,
        cookies: (seedCookies ?? []).map((c) => ({
          ...c,
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: 'Lax' as const,
        })),
        challengeDetected: false,
        rendered: false,
      });
      return;
    }

    res.status(500).json({
      error: 'Session auth failed',
      details: message,
    });
  }
});

export const sessionAuthRouter = router;
