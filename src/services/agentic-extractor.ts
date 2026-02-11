/**
 * Agentic Extraction Quality Feedback Loop
 *
 * Instead of a fixed extraction pipeline, the agentic extractor:
 * 1. Extracts content using the standard distiller pipeline
 * 2. Evaluates the result (confidence score, content length, structure quality)
 * 3. Decides if the result is good enough or needs improvement
 * 4. Acts to improve: scroll to load more, click "show more"/"read more",
 *    dismiss overlays, try alternate extraction methods
 * 5. Repeats until quality threshold is met or max attempts reached
 */

import type { Page } from 'playwright-core';
import { distillContent, type DistillationResult } from './distiller';
import { interactionManager } from './interaction-manager';
import { confidenceScorer } from '../core/confidence-scorer';
import { logger, startSpan } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgenticExtractionOptions {
  /** Minimum acceptable confidence score (0-1). Default 0.7. */
  confidenceThreshold?: number;
  /** Minimum extracted content character count. Default 200. */
  minContentLength?: number;
  /** Maximum number of retry cycles. Default 3. */
  maxAttempts?: number;
  /** Try scrolling to load lazy/infinite-scroll content. Default true. */
  enableScrolling?: boolean;
  /** Try clicking show-more/dismiss overlays. Default true. */
  enableInteraction?: boolean;
  /** Try different extraction methods on re-extract. Default true. */
  enableAlternateExtraction?: boolean;
  /** Overall timeout in milliseconds. Default 30000. */
  timeout?: number;
}

export interface AgenticExtractionResult {
  /** The final extracted content text. */
  content: string;
  /** The final confidence score (0-1). */
  confidence: number;
  /** Record of every extraction attempt. */
  attempts: AttemptRecord[];
  /** The extraction method that produced the final result. */
  finalMethod: string;
  /** Human-readable list of improvements the agent performed. */
  improvements: string[];
  /** Total wall-clock duration in milliseconds. */
  totalDuration: number;
  /** The full distillation result from the final successful extraction. */
  distillationResult: DistillationResult;
}

export interface AttemptRecord {
  /** 1-based attempt number. */
  attempt: number;
  /** Extraction method used. */
  method: string;
  /** Confidence score achieved. */
  confidence: number;
  /** Character count of extracted content. */
  contentLength: number;
  /** Actions tried during this attempt. */
  actions: string[];
  /** Whether this attempt improved over the previous best. */
  improved: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: Required<AgenticExtractionOptions> = {
  confidenceThreshold: 0.7,
  minContentLength: 200,
  maxAttempts: 3,
  enableScrolling: true,
  enableInteraction: true,
  enableAlternateExtraction: true,
  timeout: 30_000,
};

/** Selectors for common overlay / popup containers. */
const OVERLAY_SELECTORS = [
  '.modal',
  '[role="dialog"]',
  '#cookie-consent',
  '.cookie-banner',
  '.cookie-notice',
  '.consent-banner',
  '.gdpr-banner',
  '[class*="cookie"]',
  '[class*="consent"]',
  '[id*="cookie"]',
  '[class*="overlay"]',
  '.popup',
];

/** Text patterns on dismiss / close / accept buttons (case-insensitive). */
const DISMISS_BUTTON_PATTERNS = [
  'accept',
  'agree',
  'got it',
  'ok',
  'close',
  'dismiss',
  'no thanks',
  'reject',
  'decline',
  'i understand',
];

/** Text patterns on "show more" / "expand" buttons (case-insensitive). */
const SHOW_MORE_PATTERNS = [
  'show more',
  'read more',
  'continue reading',
  'load more',
  'expand',
  'see more',
  'view more',
  'see all',
  'view all',
];

/** Selectors for loading indicators. */
const LOADING_SELECTORS = [
  '.loading',
  '.spinner',
  '[aria-busy="true"]',
  '.skeleton',
  '[class*="loading"]',
  '[class*="spinner"]',
];

/** Selectors for elements that interfere with extraction. */
const INTERFERENCE_SELECTORS = [
  'header[class*="fixed"]',
  'header[class*="sticky"]',
  'nav[class*="fixed"]',
  'nav[class*="sticky"]',
  '[class*="sticky-nav"]',
  '[class*="fixed-header"]',
  'footer[class*="fixed"]',
  '[class*="ad-container"]',
  '[class*="advertisement"]',
  '[id*="ad-"]',
  '[class*="sidebar"]',
  '.social-share',
  '[class*="social-share"]',
];

// ---------------------------------------------------------------------------
// AgenticExtractor
// ---------------------------------------------------------------------------

export class AgenticExtractor {
  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Run the agentic extraction feedback loop on a live browser page.
   *
   * The method repeatedly extracts, evaluates, and attempts improvements
   * until the quality threshold is met or the attempt budget is exhausted.
   */
  async extract(
    page: Page,
    options?: AgenticExtractionOptions,
  ): Promise<AgenticExtractionResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const span = startSpan('agentic-extractor:extract');
    const startTime = Date.now();

    const attempts: AttemptRecord[] = [];
    const improvements: string[] = [];

    let bestResult: DistillationResult | null = null;
    let bestConfidence = 0;
    let bestContentLength = 0;

    // Track which strategies have been tried so we do not repeat them.
    const triedStrategies = new Set<string>();

    logger.info('agentic-extractor: starting extraction loop', {
      confidenceThreshold: opts.confidenceThreshold,
      minContentLength: opts.minContentLength,
      maxAttempts: opts.maxAttempts,
      timeout: opts.timeout,
    });

    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      // Abort if overall timeout exceeded
      if (Date.now() - startTime >= opts.timeout) {
        logger.warn('agentic-extractor: overall timeout reached', {
          attempt,
          elapsed: Date.now() - startTime,
        });
        break;
      }

      const attemptActions: string[] = [];

      // ------ Step 1: Extract ------
      const url = page.url();
      const html = await page.content();
      const result = await distillContent(html, url);

      const confidence = this.evaluateConfidence(result);
      const contentLength = result.contentText.length;

      const isImproved =
        confidence > bestConfidence || contentLength > bestContentLength;

      if (isImproved) {
        bestResult = result;
        bestConfidence = confidence;
        bestContentLength = contentLength;
      }

      attemptActions.push(`extracted via ${result.extractionMethod ?? 'unknown'}`);

      logger.info('agentic-extractor: attempt result', {
        attempt,
        method: result.extractionMethod,
        confidence: confidence.toFixed(4),
        contentLength,
        improved: isImproved,
      });

      attempts.push({
        attempt,
        method: result.extractionMethod ?? 'unknown',
        confidence,
        contentLength,
        actions: [...attemptActions],
        improved: isImproved,
      });

      // ------ Step 2: Evaluate quality ------
      if (
        confidence >= opts.confidenceThreshold &&
        contentLength >= opts.minContentLength
      ) {
        logger.info('agentic-extractor: quality threshold met', {
          attempt,
          confidence: confidence.toFixed(4),
          contentLength,
        });
        break;
      }

      // ------ Step 3: If this is the last attempt, skip improvements ------
      if (attempt >= opts.maxAttempts) {
        logger.info('agentic-extractor: max attempts reached', { attempt });
        break;
      }

      // ------ Step 4: Try improvement strategies (in order) ------
      let anyImprovement = false;

      // Strategy 1: Scroll to load lazy content
      if (opts.enableScrolling && !triedStrategies.has('scroll')) {
        const scrolled = await this.tryScrollToLoadMore(page, opts);
        if (scrolled) {
          anyImprovement = true;
          improvements.push('Scrolled to load lazy/dynamic content');
          attemptActions.push('scrolled page');
        }
        triedStrategies.add('scroll');
      }

      // Strategy 2: Dismiss overlays / popups
      if (opts.enableInteraction && !triedStrategies.has('dismiss-overlays')) {
        const dismissed = await this.tryDismissOverlays(page);
        if (dismissed) {
          anyImprovement = true;
          improvements.push('Dismissed overlay/popup/cookie banner');
          attemptActions.push('dismissed overlays');
        }
        triedStrategies.add('dismiss-overlays');
      }

      // Strategy 3: Click "show more" / "read more"
      if (opts.enableInteraction && !triedStrategies.has('show-more')) {
        const clicked = await this.tryClickShowMore(page);
        if (clicked) {
          anyImprovement = true;
          improvements.push('Clicked "show more"/"read more" to expand content');
          attemptActions.push('clicked show-more');
        }
        triedStrategies.add('show-more');
      }

      // Strategy 4: Wait for dynamic content
      if (!triedStrategies.has('wait-loading')) {
        const waited = await this.tryWaitForDynamicContent(page);
        if (waited) {
          anyImprovement = true;
          improvements.push('Waited for dynamic content to finish loading');
          attemptActions.push('waited for loading');
        }
        triedStrategies.add('wait-loading');
      }

      // Strategy 5: Strip interference
      if (opts.enableInteraction && !triedStrategies.has('strip-interference')) {
        const stripped = await this.tryStripInterference(page);
        if (stripped) {
          anyImprovement = true;
          improvements.push(
            'Stripped fixed headers/footers, ad containers, and sticky navs',
          );
          attemptActions.push('stripped interference elements');
        }
        triedStrategies.add('strip-interference');
      }

      // Strategy 6: Try alternate extraction via direct <main>/<article>
      if (
        opts.enableAlternateExtraction &&
        !triedStrategies.has('alternate-extraction')
      ) {
        const altResult = await this.tryAlternateExtraction(page, url);
        if (altResult) {
          const altConfidence = this.evaluateConfidence(altResult);
          const altLength = altResult.contentText.length;

          if (altConfidence > bestConfidence || altLength > bestContentLength) {
            bestResult = altResult;
            bestConfidence = altConfidence;
            bestContentLength = altLength;
            anyImprovement = true;
            improvements.push(
              `Used alternate extraction from <${altResult.extractionMethod ?? 'article/main'}> element`,
            );
            attemptActions.push('alternate extraction');
          }
        }
        triedStrategies.add('alternate-extraction');
      }

      // Update the last attempt record with the actions we took
      const lastAttempt = attempts[attempts.length - 1];
      lastAttempt.actions = [...attemptActions];

      if (!anyImprovement) {
        logger.info('agentic-extractor: no improvements made, stopping', {
          attempt,
        });
        break;
      }
    }

    // ------ Build final result ------
    const totalDuration = Date.now() - startTime;

    // If we never got any result (shouldn't happen), do one last extraction
    if (!bestResult) {
      const html = await page.content();
      bestResult = await distillContent(html, page.url());
      bestConfidence = this.evaluateConfidence(bestResult);
    }

    span.end({
      confidence: bestConfidence,
      contentLength: bestResult.contentText.length,
      attempts: attempts.length,
      improvements: improvements.length,
      totalDuration,
    });

    logger.info('agentic-extractor: extraction complete', {
      confidence: bestConfidence.toFixed(4),
      contentLength: bestResult.contentText.length,
      attempts: attempts.length,
      improvements,
      totalDuration,
    });

    return {
      content: bestResult.contentText,
      confidence: bestConfidence,
      attempts,
      finalMethod: bestResult.extractionMethod ?? 'unknown',
      improvements,
      totalDuration,
      distillationResult: bestResult,
    };
  }

  // -----------------------------------------------------------------------
  // Confidence evaluation
  // -----------------------------------------------------------------------

  /**
   * Evaluate the confidence of a distillation result.
   *
   * If the result already contains a Bayesian confidence breakdown we use it
   * directly. Otherwise we compute a lightweight heuristic proxy based on
   * content length, heading count, and paragraph count.
   */
  private evaluateConfidence(result: DistillationResult): number {
    // Prefer the full Bayesian score when available
    if (result.confidenceBreakdown?.overall != null) {
      return result.confidenceBreakdown.overall;
    }

    // Prefer the extraction-level confidence when available
    if (result.extractionConfidence != null) {
      return result.extractionConfidence;
    }

    // Fallback: lightweight heuristic proxy
    const paragraphCount = result.nodes.filter(
      (n) => n.type === 'paragraph',
    ).length;
    const headingCount = result.nodes.filter(
      (n) => n.type === 'heading',
    ).length;

    return confidenceScorer.computeContentQuality(
      result.contentText,
      paragraphCount + headingCount,
    );
  }

  // -----------------------------------------------------------------------
  // Improvement strategies
  // -----------------------------------------------------------------------

  /**
   * Strategy 1: Scroll down in increments to trigger lazy-loading.
   * Returns true if scrolling resulted in new content appearing.
   */
  private async tryScrollToLoadMore(
    page: Page,
    opts: Required<AgenticExtractionOptions>,
  ): Promise<boolean> {
    const span = startSpan('agentic-extractor:scroll');
    try {
      const initialHeight = await page.evaluate(
        () => document.body.scrollHeight,
      );

      // Scroll down in 3 increments
      const scrollSteps = 3;
      for (let i = 0; i < scrollSteps; i++) {
        if (Date.now() - opts.timeout > 0) break; // Respect overall timeout

        await interactionManager.scroll(page, 'down', { amount: 'page' });

        // Wait briefly for content to load
        await page.waitForTimeout(800);
      }

      const newHeight = await page.evaluate(
        () => document.body.scrollHeight,
      );

      // Scroll back to top for clean extraction
      await interactionManager.scroll(page, 'top');
      await page.waitForTimeout(300);

      const grew = newHeight > initialHeight;
      logger.info('agentic-extractor:scroll result', {
        initialHeight,
        newHeight,
        grew,
      });

      span.end({ grew, initialHeight, newHeight });
      return grew;
    } catch (err) {
      logger.warn('agentic-extractor:scroll failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      span.end({ error: true });
      return false;
    }
  }

  /**
   * Strategy 2: Find and dismiss common overlays, modals, and cookie banners.
   * Returns true if at least one overlay was dismissed.
   */
  private async tryDismissOverlays(page: Page): Promise<boolean> {
    const span = startSpan('agentic-extractor:dismiss-overlays');
    let dismissed = false;

    try {
      for (const overlaySelector of OVERLAY_SELECTORS) {
        // Check if the overlay is visible
        const overlayVisible = await page
          .locator(overlaySelector)
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false);

        if (!overlayVisible) continue;

        logger.debug('agentic-extractor: overlay found', { overlaySelector });

        // Try to find a dismiss button inside the overlay
        const clicked = await this.clickMatchingButton(
          page,
          overlaySelector,
          DISMISS_BUTTON_PATTERNS,
        );

        if (clicked) {
          dismissed = true;
          logger.info('agentic-extractor: overlay dismissed', {
            overlaySelector,
          });
          await page.waitForTimeout(500);
          break; // One overlay dismissed per round
        }

        // If no button found, try clicking an X / close icon
        const closeClicked = await this.tryClickCloseIcon(
          page,
          overlaySelector,
        );
        if (closeClicked) {
          dismissed = true;
          logger.info('agentic-extractor: overlay closed via icon', {
            overlaySelector,
          });
          await page.waitForTimeout(500);
          break;
        }
      }
    } catch (err) {
      logger.warn('agentic-extractor:dismiss-overlays failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    span.end({ dismissed });
    return dismissed;
  }

  /**
   * Strategy 3: Find and click "show more" / "read more" / "expand" buttons.
   * Returns true if a button was clicked.
   */
  private async tryClickShowMore(page: Page): Promise<boolean> {
    const span = startSpan('agentic-extractor:click-show-more');
    let clicked = false;

    try {
      // Search for matching buttons/links in the full page
      clicked = await this.clickMatchingButton(
        page,
        'body',
        SHOW_MORE_PATTERNS,
      );

      if (clicked) {
        // Wait for new content to render
        await page.waitForTimeout(1000);
        logger.info('agentic-extractor: show-more button clicked');
      }
    } catch (err) {
      logger.warn('agentic-extractor:click-show-more failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    span.end({ clicked });
    return clicked;
  }

  /**
   * Strategy 4: Wait for loading indicators to disappear.
   * Returns true if a loading indicator was detected and resolved.
   */
  private async tryWaitForDynamicContent(page: Page): Promise<boolean> {
    const span = startSpan('agentic-extractor:wait-dynamic');
    let waited = false;

    try {
      for (const selector of LOADING_SELECTORS) {
        const isVisible = await page
          .locator(selector)
          .first()
          .isVisible({ timeout: 300 })
          .catch(() => false);

        if (isVisible) {
          logger.info('agentic-extractor: loading indicator found', {
            selector,
          });

          // Wait for the loading indicator to disappear (up to 5s)
          try {
            await page.waitForSelector(selector, {
              state: 'hidden',
              timeout: 5000,
            });
            waited = true;
            logger.info('agentic-extractor: loading indicator resolved', {
              selector,
            });
          } catch {
            // Timed out waiting, continue anyway
            logger.warn(
              'agentic-extractor: loading indicator did not resolve',
              { selector },
            );
          }
          break;
        }
      }
    } catch (err) {
      logger.warn('agentic-extractor:wait-dynamic failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    span.end({ waited });
    return waited;
  }

  /**
   * Strategy 5: Remove fixed headers, sticky navs, ad containers, and other
   * elements that pollute extraction. Returns true if elements were removed.
   */
  private async tryStripInterference(page: Page): Promise<boolean> {
    const span = startSpan('agentic-extractor:strip-interference');
    let stripped = false;

    try {
      const removedCount = await page.evaluate((selectors: string[]) => {
        let count = 0;
        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          elements.forEach((el) => {
            el.remove();
            count++;
          });
        }
        return count;
      }, INTERFERENCE_SELECTORS);

      stripped = removedCount > 0;

      logger.info('agentic-extractor:strip-interference result', {
        removedCount,
      });
    } catch (err) {
      logger.warn('agentic-extractor:strip-interference failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    span.end({ stripped });
    return stripped;
  }

  /**
   * Strategy 6: Try extracting from <main> or <article> elements directly
   * by isolating their innerHTML and running distillContent on that subset.
   * Returns the best alternate result, or null if nothing useful was found.
   */
  private async tryAlternateExtraction(
    page: Page,
    url: string,
  ): Promise<DistillationResult | null> {
    const span = startSpan('agentic-extractor:alternate-extraction');
    let bestAlt: DistillationResult | null = null;
    let bestAltConfidence = 0;

    try {
      // Try extracting from semantic containers
      const containerSelectors = ['article', 'main', '[role="main"]', '.post-content', '.article-body', '.entry-content'];

      for (const selector of containerSelectors) {
        const containerHtml = await page
          .evaluate((sel: string) => {
            const el = document.querySelector(sel);
            return el ? el.innerHTML : null;
          }, selector)
          .catch(() => null);

        if (!containerHtml || containerHtml.length < 100) continue;

        // Wrap in a minimal HTML document so distillContent can parse it
        const wrappedHtml = `<!DOCTYPE html><html><head><title></title></head><body>${containerHtml}</body></html>`;
        const altResult = await distillContent(wrappedHtml, url);
        const altConfidence = this.evaluateConfidence(altResult);

        logger.debug('agentic-extractor:alternate-extraction candidate', {
          selector,
          confidence: altConfidence.toFixed(4),
          contentLength: altResult.contentText.length,
        });

        if (altConfidence > bestAltConfidence) {
          bestAlt = altResult;
          bestAltConfidence = altConfidence;
        }
      }
    } catch (err) {
      logger.warn('agentic-extractor:alternate-extraction failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    span.end({
      found: bestAlt !== null,
      confidence: bestAltConfidence,
    });
    return bestAlt;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Find and click a button or link inside `parentSelector` whose visible
   * text matches one of the given patterns (case-insensitive).
   * Returns true if a match was found and clicked.
   */
  private async clickMatchingButton(
    page: Page,
    parentSelector: string,
    textPatterns: string[],
  ): Promise<boolean> {
    try {
      const clicked = await page.evaluate(
        ({
          parentSel,
          patterns,
        }: {
          parentSel: string;
          patterns: string[];
        }) => {
          const parent = document.querySelector(parentSel);
          if (!parent) return false;

          // Gather all clickable elements
          const clickables = parent.querySelectorAll(
            'button, a, [role="button"], input[type="button"], input[type="submit"]',
          );

          for (const el of clickables) {
            const text = (
              (el as HTMLElement).innerText ||
              (el as HTMLInputElement).value ||
              el.getAttribute('aria-label') ||
              ''
            )
              .trim()
              .toLowerCase();

            for (const pattern of patterns) {
              if (text.includes(pattern.toLowerCase())) {
                (el as HTMLElement).click();
                return true;
              }
            }
          }
          return false;
        },
        { parentSel: parentSelector, patterns: textPatterns },
      );

      return clicked;
    } catch {
      return false;
    }
  }

  /**
   * Try to click a close icon (X button, aria-label="close", etc.) inside
   * the given container. Returns true if successful.
   */
  private async tryClickCloseIcon(
    page: Page,
    containerSelector: string,
  ): Promise<boolean> {
    try {
      const clicked = await page.evaluate((containerSel: string) => {
        const container = document.querySelector(containerSel);
        if (!container) return false;

        // Common close-icon selectors
        const closeSelectors = [
          '[aria-label="close"]',
          '[aria-label="Close"]',
          '.close',
          '.close-btn',
          '.close-button',
          '[class*="close"]',
          'button[class*="dismiss"]',
        ];

        for (const sel of closeSelectors) {
          const btn = container.querySelector(sel) as HTMLElement | null;
          if (btn) {
            btn.click();
            return true;
          }
        }
        return false;
      }, containerSelector);

      return clicked;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export (matches codebase pattern)
// ---------------------------------------------------------------------------

export const agenticExtractor = new AgenticExtractor();
