/**
 * InteractionManager - Browser interaction capabilities for Anno
 *
 * Provides methods for clicking, filling forms, scrolling, hovering,
 * typing, waiting, screenshotting, evaluating JS, and inspecting page state
 * on a Playwright Page object. Designed to be used alongside the existing
 * read-only renderer without modifying its behavior.
 */

import type { Page } from 'playwright-core';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScrollDirection = 'up' | 'down' | 'top' | 'bottom';
export type MouseButton = 'left' | 'right' | 'middle';

export interface ClickOptions {
  /** Maximum time to wait for the element (ms). Default 30 000. */
  timeout?: number;
  /** Mouse button. Default 'left'. */
  button?: MouseButton;
  /** Number of clicks. Default 1. */
  clickCount?: number;
  /** Position offset relative to the element's top-left corner. */
  position?: { x: number; y: number };
}

export interface FillOptions {
  /** Maximum time to wait for the element (ms). Default 30 000. */
  timeout?: number;
}

export interface SelectOptions {
  /** Maximum time to wait for the element (ms). Default 30 000. */
  timeout?: number;
}

export interface ScrollOptions {
  /** When direction is 'up' or 'down' and amount is a number, scroll this many pixels. */
  amount?: number | 'page';
  /** If true, use smooth scrolling behaviour. Default false. */
  smooth?: boolean;
}

export interface HoverOptions {
  /** Maximum time to wait for the element (ms). Default 30 000. */
  timeout?: number;
  /** Position offset relative to the element's top-left corner. */
  position?: { x: number; y: number };
}

export interface WaitForOptions {
  /** Maximum time to wait (ms). Default 30 000. */
  timeout?: number;
}

export type WaitForCondition =
  | { kind: 'selector'; selector: string }
  | { kind: 'timeout'; ms: number }
  | { kind: 'networkidle' }
  | { kind: 'expression'; expression: string };

export interface TypeOptions {
  /** Delay between keystrokes (ms). Default 50. */
  delay?: number;
  /** Maximum time to wait for the element (ms). Default 30 000. */
  timeout?: number;
}

export interface ScreenshotOptions {
  /** Capture the full scrollable page. Default false. */
  fullPage?: boolean;
  /** Clip region. */
  clip?: { x: number; y: number; width: number; height: number };
}

export interface InteractiveElement {
  tag: string;
  type?: string;
  id?: string;
  name?: string;
  selector: string;
  text?: string;
  placeholder?: string;
  ariaLabel?: string;
  role?: string;
  href?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface PageState {
  url: string;
  title: string;
  interactiveElements: InteractiveElement[];
}

// -- Action / result types --------------------------------------------------

export type BrowserActionType =
  | 'click'
  | 'fill'
  | 'select'
  | 'scroll'
  | 'hover'
  | 'waitFor'
  | 'type'
  | 'screenshot'
  | 'evaluate'
  | 'getPageState';

export interface BrowserAction {
  type: BrowserActionType;
  selector?: string;
  value?: string;
  values?: string[];
  direction?: ScrollDirection;
  condition?: WaitForCondition;
  expression?: string;
  options?: Record<string, unknown>;
}

export interface ActionResult {
  action: BrowserAction;
  success: boolean;
  /** Wall-clock duration of the action in milliseconds. */
  duration: number;
  error?: string;
  /** Payload — screenshot base64, evaluate result, page state, etc. */
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_TYPE_DELAY = 50;

/**
 * Wrap a Playwright call so that common error classes are translated into
 * a human-readable message rather than the full Playwright stack.
 */
function friendlyError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes('Timeout') || msg.includes('timeout')) {
      return `Timeout: ${msg.split('\n')[0]}`;
    }
    if (msg.includes('not visible') || msg.includes('not attached')) {
      return `Element not interactable: ${msg.split('\n')[0]}`;
    }
    if (msg.includes('strict mode violation')) {
      return `Multiple elements matched the selector: ${msg.split('\n')[0]}`;
    }
    return msg.split('\n')[0];
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// InteractionManager
// ---------------------------------------------------------------------------

export class InteractionManager {
  // -----------------------------------------------------------------------
  // Individual action methods
  // -----------------------------------------------------------------------

  /**
   * Click an element identified by a CSS / Playwright selector.
   */
  async click(page: Page, selector: string, options?: ClickOptions): Promise<void> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    logger.debug('interaction:click', { selector, options });

    await page.click(selector, {
      timeout,
      button: options?.button ?? 'left',
      clickCount: options?.clickCount ?? 1,
      position: options?.position
    });

    logger.info('interaction:click completed', { selector });
  }

  /**
   * Fill an input / textarea. The existing value is cleared first.
   */
  async fill(page: Page, selector: string, value: string, options?: FillOptions): Promise<void> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    logger.debug('interaction:fill', { selector, valueLength: value.length });

    await page.fill(selector, value, { timeout });

    logger.info('interaction:fill completed', { selector, valueLength: value.length });
  }

  /**
   * Select option(s) from a <select> element by value.
   */
  async select(page: Page, selector: string, values: string[], options?: SelectOptions): Promise<string[]> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    logger.debug('interaction:select', { selector, values });

    const selected = await page.selectOption(selector, values, { timeout });

    logger.info('interaction:select completed', { selector, selected });
    return selected;
  }

  /**
   * Scroll the page in the given direction.
   *
   * - 'top' / 'bottom' — scroll to the absolute top / bottom of the page.
   * - 'up' / 'down' — scroll by `amount` pixels (default one viewport height)
   *   or by one viewport-height when amount === 'page'.
   */
  async scroll(page: Page, direction: ScrollDirection, options?: ScrollOptions): Promise<void> {
    const smooth = options?.smooth ?? false;
    const behaviour = smooth ? 'smooth' : 'auto';
    logger.debug('interaction:scroll', { direction, options });

    await page.evaluate(
      ({ direction, amount, behaviour }) => {
        const viewportHeight = window.innerHeight;

        switch (direction) {
          case 'top':
            window.scrollTo({ top: 0, behavior: behaviour as ScrollBehavior });
            break;
          case 'bottom':
            window.scrollTo({ top: document.body.scrollHeight, behavior: behaviour as ScrollBehavior });
            break;
          case 'down': {
            const downPx = amount === 'page' || amount === undefined
              ? viewportHeight
              : amount;
            window.scrollBy({ top: downPx, behavior: behaviour as ScrollBehavior });
            break;
          }
          case 'up': {
            const upPx = amount === 'page' || amount === undefined
              ? viewportHeight
              : amount;
            window.scrollBy({ top: -upPx, behavior: behaviour as ScrollBehavior });
            break;
          }
        }
      },
      {
        direction,
        amount: options?.amount,
        behaviour
      }
    );

    logger.info('interaction:scroll completed', { direction });
  }

  /**
   * Hover over an element.
   */
  async hover(page: Page, selector: string, options?: HoverOptions): Promise<void> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    logger.debug('interaction:hover', { selector, options });

    await page.hover(selector, {
      timeout,
      position: options?.position
    });

    logger.info('interaction:hover completed', { selector });
  }

  /**
   * Wait for a condition before continuing.
   */
  async waitFor(page: Page, condition: WaitForCondition, options?: WaitForOptions): Promise<void> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    logger.debug('interaction:waitFor', { condition });

    switch (condition.kind) {
      case 'selector':
        await page.waitForSelector(condition.selector, { timeout, state: 'visible' });
        break;

      case 'timeout':
        await page.waitForTimeout(condition.ms);
        break;

      case 'networkidle':
        await page.waitForLoadState('networkidle', { timeout });
        break;

      case 'expression':
        await page.waitForFunction(condition.expression, undefined, { timeout });
        break;
    }

    logger.info('interaction:waitFor completed', { kind: condition.kind });
  }

  /**
   * Type text character-by-character into a focused element.
   * Useful for sites that detect paste / bulk-fill events.
   */
  async type(page: Page, selector: string, text: string, options?: TypeOptions): Promise<void> {
    const delay = options?.delay ?? DEFAULT_TYPE_DELAY;
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    logger.debug('interaction:type', { selector, textLength: text.length, delay });

    // First click the element to focus it
    await page.click(selector, { timeout });
    // Then type character-by-character
    await page.type(selector, text, { delay });

    logger.info('interaction:type completed', { selector, textLength: text.length });
  }

  /**
   * Take a screenshot and return the image as a base64-encoded PNG string.
   */
  async screenshot(page: Page, options?: ScreenshotOptions): Promise<string> {
    logger.debug('interaction:screenshot', { options });

    const buffer = await page.screenshot({
      type: 'png',
      fullPage: options?.fullPage ?? false,
      clip: options?.clip
    });

    const base64 = buffer.toString('base64');
    logger.info('interaction:screenshot completed', { bytes: buffer.byteLength });
    return base64;
  }

  /**
   * Evaluate an arbitrary JavaScript expression in the page context and
   * return the serialisable result.
   */
  async evaluate(page: Page, expression: string): Promise<unknown> {
    logger.debug('interaction:evaluate', { expressionLength: expression.length });

    // We wrap in an async IIFE so callers can pass either expressions or statements.
    const result = await page.evaluate((expr) => {
      // eslint-disable-next-line no-eval
      return eval(expr);
    }, expression);

    logger.info('interaction:evaluate completed');
    return result;
  }

  /**
   * Return the current page URL, title, and a lightweight summary of all
   * interactive elements (links, buttons, inputs, selects, textareas) with
   * enough information to build selectors for follow-up actions.
   */
  async getPageState(page: Page): Promise<PageState> {
    logger.debug('interaction:getPageState');

    const [url, title] = await Promise.all([
      page.url(),
      page.title()
    ]);

    const interactiveElements: InteractiveElement[] = await page.evaluate(() => {
      const elements: Array<{
        tag: string;
        type?: string;
        id?: string;
        name?: string;
        selector: string;
        text?: string;
        placeholder?: string;
        ariaLabel?: string;
        role?: string;
        href?: string;
        value?: string;
        checked?: boolean;
        disabled?: boolean;
      }> = [];

      const interactiveSelectors = [
        'a[href]',
        'button',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[onclick]',
        '[contenteditable="true"]'
      ];

      const seen = new Set<Element>();

      for (const sel of interactiveSelectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          seen.add(el);

          const htmlEl = el as HTMLElement;
          const tag = el.tagName.toLowerCase();

          // Build a reasonably unique selector
          let selector: string;
          if (el.id) {
            selector = `#${CSS.escape(el.id)}`;
          } else if (htmlEl.getAttribute('data-testid')) {
            selector = `[data-testid="${CSS.escape(htmlEl.getAttribute('data-testid')!)}"]`;
          } else if (htmlEl.getAttribute('name')) {
            selector = `${tag}[name="${CSS.escape(htmlEl.getAttribute('name')!)}"]`;
          } else if (htmlEl.getAttribute('aria-label')) {
            selector = `${tag}[aria-label="${CSS.escape(htmlEl.getAttribute('aria-label')!)}"]`;
          } else {
            // Fall back to nth-of-type within parent
            const parent = el.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter(
                (s) => s.tagName === el.tagName
              );
              const idx = siblings.indexOf(el) + 1;
              selector = `${buildParentPath(parent)} > ${tag}:nth-of-type(${idx})`;
            } else {
              selector = tag;
            }
          }

          const entry: typeof elements[number] = { tag, selector };

          if ((el as HTMLInputElement).type) entry.type = (el as HTMLInputElement).type;
          if (el.id) entry.id = el.id;
          if (htmlEl.getAttribute('name')) entry.name = htmlEl.getAttribute('name')!;
          const text = htmlEl.innerText?.trim().slice(0, 80);
          if (text) entry.text = text;
          if (htmlEl.getAttribute('placeholder')) entry.placeholder = htmlEl.getAttribute('placeholder')!;
          if (htmlEl.getAttribute('aria-label')) entry.ariaLabel = htmlEl.getAttribute('aria-label')!;
          if (htmlEl.getAttribute('role')) entry.role = htmlEl.getAttribute('role')!;
          if ((el as HTMLAnchorElement).href) entry.href = (el as HTMLAnchorElement).href;
          if ((el as HTMLInputElement).value) entry.value = (el as HTMLInputElement).value;
          if ((el as HTMLInputElement).checked !== undefined && tag === 'input') {
            entry.checked = (el as HTMLInputElement).checked;
          }
          if ((el as HTMLButtonElement).disabled !== undefined) {
            entry.disabled = (el as HTMLButtonElement).disabled;
          }

          elements.push(entry);
        }
      }

      return elements;

      // Helper to build a short ancestor path for uniqueness
      function buildParentPath(el: Element, depth = 2): string {
        const parts: string[] = [];
        let cur: Element | null = el;
        for (let i = 0; i < depth && cur; i++) {
          if (cur.id) {
            parts.unshift(`#${CSS.escape(cur.id)}`);
            break;
          }
          parts.unshift(cur.tagName.toLowerCase());
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      }
    });

    logger.info('interaction:getPageState completed', {
      url,
      interactiveElementCount: interactiveElements.length
    });

    return { url, title, interactiveElements };
  }

  // -----------------------------------------------------------------------
  // Batch execution
  // -----------------------------------------------------------------------

  /**
   * Execute an ordered array of actions sequentially, collecting results
   * for each step. Execution continues even when an individual action fails
   * (unless it is critical to subsequent steps — the caller should handle
   * that via the `success` flag in the results).
   */
  async executeActions(page: Page, actions: BrowserAction[]): Promise<ActionResult[]> {
    logger.info('interaction:executeActions started', { actionCount: actions.length });
    const results: ActionResult[] = [];

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const start = Date.now();
      let success = true;
      let error: string | undefined;
      let data: unknown | undefined;

      try {
        switch (action.type) {
          case 'click': {
            if (!action.selector) throw new Error('click requires a selector');
            await this.click(page, action.selector, action.options as ClickOptions | undefined);
            break;
          }

          case 'fill': {
            if (!action.selector) throw new Error('fill requires a selector');
            if (action.value === undefined) throw new Error('fill requires a value');
            await this.fill(page, action.selector, action.value, action.options as FillOptions | undefined);
            break;
          }

          case 'select': {
            if (!action.selector) throw new Error('select requires a selector');
            const selectValues = action.values ?? (action.value !== undefined ? [action.value] : []);
            if (selectValues.length === 0) throw new Error('select requires values');
            data = await this.select(
              page,
              action.selector,
              selectValues,
              action.options as SelectOptions | undefined
            );
            break;
          }

          case 'scroll': {
            const direction = (action.direction ??
              (action.options?.direction as ScrollDirection | undefined) ??
              'down') as ScrollDirection;
            const scrollOpts: ScrollOptions = {};
            if (action.options?.amount !== undefined) {
              scrollOpts.amount = action.options.amount as number | 'page';
            }
            if (action.options?.smooth !== undefined) {
              scrollOpts.smooth = action.options.smooth as boolean;
            }
            if (action.value !== undefined) {
              // Allow value to encode amount for convenience
              scrollOpts.amount = action.value === 'page' ? 'page' : Number(action.value);
            }
            await this.scroll(page, direction, scrollOpts);
            break;
          }

          case 'hover': {
            if (!action.selector) throw new Error('hover requires a selector');
            await this.hover(page, action.selector, action.options as HoverOptions | undefined);
            break;
          }

          case 'waitFor': {
            const condition = this.resolveWaitCondition(action);
            await this.waitFor(page, condition, action.options as WaitForOptions | undefined);
            break;
          }

          case 'type': {
            if (!action.selector) throw new Error('type requires a selector');
            if (action.value === undefined) throw new Error('type requires a value');
            await this.type(page, action.selector, action.value, action.options as TypeOptions | undefined);
            break;
          }

          case 'screenshot': {
            data = await this.screenshot(page, action.options as ScreenshotOptions | undefined);
            break;
          }

          case 'evaluate': {
            const expression = action.expression ?? action.value;
            if (!expression) throw new Error('evaluate requires an expression or value');
            data = await this.evaluate(page, expression);
            break;
          }

          case 'getPageState': {
            data = await this.getPageState(page);
            break;
          }

          default:
            throw new Error(`Unknown action type: ${(action as BrowserAction).type}`);
        }
      } catch (err) {
        success = false;
        error = friendlyError(err);
        logger.warn('interaction:executeActions action failed', {
          index: i,
          type: action.type,
          error
        });
      }

      const duration = Date.now() - start;
      results.push({ action, success, duration, error, data });
    }

    const succeeded = results.filter((r) => r.success).length;
    logger.info('interaction:executeActions completed', {
      total: actions.length,
      succeeded,
      failed: actions.length - succeeded
    });

    return results;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Convert a BrowserAction into a typed WaitForCondition.
   */
  private resolveWaitCondition(action: BrowserAction): WaitForCondition {
    // Explicit condition object takes priority
    if (action.condition) return action.condition;

    // Infer from the action fields
    if (action.selector) {
      return { kind: 'selector', selector: action.selector };
    }
    if (action.value !== undefined) {
      // If the value looks like a number, treat it as a timeout in ms
      const num = Number(action.value);
      if (!isNaN(num)) {
        return { kind: 'timeout', ms: num };
      }
      // Otherwise treat it as a JS expression
      return { kind: 'expression', expression: action.value };
    }
    if (action.expression) {
      return { kind: 'expression', expression: action.expression };
    }
    if (action.options?.networkidle) {
      return { kind: 'networkidle' };
    }

    // Fallback
    return { kind: 'networkidle' };
  }
}

// Singleton export for convenience
export const interactionManager = new InteractionManager();
