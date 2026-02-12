import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

vi.mock('../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { InteractionManager } from '../services/interaction-manager';
import type {
  BrowserAction,
  WaitForCondition,
} from '../services/interaction-manager';

// ---------------------------------------------------------------------------
// Helpers: mock Playwright Page
// ---------------------------------------------------------------------------

function createMockPage() {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(['opt1']),
    evaluate: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('PNG-DATA')),
    url: vi.fn().mockReturnValue('https://example.com'),
    title: vi.fn().mockReturnValue('Example Page'),
    viewportSize: vi.fn().mockReturnValue({ width: 1920, height: 1080 }),
    mouse: {
      wheel: vi.fn().mockResolvedValue(undefined),
    },
    locator: vi.fn().mockReturnValue({
      all: vi.fn().mockResolvedValue([]),
      isVisible: vi.fn().mockResolvedValue(false),
      textContent: vi.fn().mockResolvedValue(''),
    }),
  } as unknown;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InteractionManager', () => {
  let manager: InteractionManager;
  let page: ReturnType<typeof createMockPage>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new InteractionManager();
    page = createMockPage();
  });

  // -----------------------------------------------------------------------
  // click
  // -----------------------------------------------------------------------

  describe('click()', () => {
    it('clicks an element with default options', async () => {
      await manager.click(page, '#submit');

      expect(page.click).toHaveBeenCalledWith('#submit', {
        timeout: 30_000,
        button: 'left',
        clickCount: 1,
        position: undefined,
      });
    });

    it('passes custom options through', async () => {
      await manager.click(page, '.btn', {
        timeout: 5000,
        button: 'right',
        clickCount: 2,
        position: { x: 10, y: 20 },
      });

      expect(page.click).toHaveBeenCalledWith('.btn', {
        timeout: 5000,
        button: 'right',
        clickCount: 2,
        position: { x: 10, y: 20 },
      });
    });

    it('propagates errors from page.click', async () => {
      page.click.mockRejectedValueOnce(new Error('Element not found'));

      await expect(manager.click(page, '#missing')).rejects.toThrow(
        'Element not found'
      );
    });
  });

  // -----------------------------------------------------------------------
  // fill
  // -----------------------------------------------------------------------

  describe('fill()', () => {
    it('fills a field with the given value', async () => {
      await manager.fill(page, '#email', 'test@example.com');

      expect(page.fill).toHaveBeenCalledWith('#email', 'test@example.com', {
        timeout: 30_000,
      });
    });

    it('uses custom timeout', async () => {
      await manager.fill(page, '#input', 'val', { timeout: 1000 });

      expect(page.fill).toHaveBeenCalledWith('#input', 'val', {
        timeout: 1000,
      });
    });
  });

  // -----------------------------------------------------------------------
  // select
  // -----------------------------------------------------------------------

  describe('select()', () => {
    it('selects options and returns selected values', async () => {
      page.selectOption.mockResolvedValueOnce(['a', 'b']);

      const result = await manager.select(page, 'select#country', ['a', 'b']);

      expect(result).toEqual(['a', 'b']);
      expect(page.selectOption).toHaveBeenCalledWith(
        'select#country',
        ['a', 'b'],
        { timeout: 30_000 }
      );
    });

    it('uses custom timeout', async () => {
      await manager.select(page, 'select', ['x'], { timeout: 500 });

      expect(page.selectOption).toHaveBeenCalledWith('select', ['x'], {
        timeout: 500,
      });
    });
  });

  // -----------------------------------------------------------------------
  // scroll
  // -----------------------------------------------------------------------

  describe('scroll()', () => {
    it('scrolls down by default', async () => {
      await manager.scroll(page, 'down');

      expect(page.evaluate).toHaveBeenCalledTimes(1);
      const args = page.evaluate.mock.calls[0];
      // Second argument is the params object
      expect(args[1]).toEqual({
        direction: 'down',
        amount: undefined,
        behaviour: 'auto',
      });
    });

    it('uses smooth scrolling when requested', async () => {
      await manager.scroll(page, 'top', { smooth: true });

      const args = page.evaluate.mock.calls[0];
      expect(args[1]).toEqual({
        direction: 'top',
        amount: undefined,
        behaviour: 'smooth',
      });
    });

    it('passes pixel amount for up direction', async () => {
      await manager.scroll(page, 'up', { amount: 300 });

      const args = page.evaluate.mock.calls[0];
      expect(args[1]).toEqual({
        direction: 'up',
        amount: 300,
        behaviour: 'auto',
      });
    });

    it('passes page amount for bottom direction', async () => {
      await manager.scroll(page, 'bottom', { amount: 'page' });

      const args = page.evaluate.mock.calls[0];
      expect(args[1].amount).toBe('page');
    });
  });

  // -----------------------------------------------------------------------
  // hover
  // -----------------------------------------------------------------------

  describe('hover()', () => {
    it('hovers over an element', async () => {
      await manager.hover(page, '.tooltip-trigger');

      expect(page.hover).toHaveBeenCalledWith('.tooltip-trigger', {
        timeout: 30_000,
        position: undefined,
      });
    });

    it('passes position offset', async () => {
      await manager.hover(page, '#el', {
        timeout: 2000,
        position: { x: 5, y: 5 },
      });

      expect(page.hover).toHaveBeenCalledWith('#el', {
        timeout: 2000,
        position: { x: 5, y: 5 },
      });
    });
  });

  // -----------------------------------------------------------------------
  // waitFor
  // -----------------------------------------------------------------------

  describe('waitFor()', () => {
    it('waits for a selector', async () => {
      const condition: WaitForCondition = {
        kind: 'selector',
        selector: '#loaded',
      };
      await manager.waitFor(page, condition);

      expect(page.waitForSelector).toHaveBeenCalledWith('#loaded', {
        timeout: 30_000,
        state: 'visible',
      });
    });

    it('waits for a timeout', async () => {
      const condition: WaitForCondition = { kind: 'timeout', ms: 500 };
      await manager.waitFor(page, condition);

      expect(page.waitForTimeout).toHaveBeenCalledWith(500);
    });

    it('waits for networkidle', async () => {
      const condition: WaitForCondition = { kind: 'networkidle' };
      await manager.waitFor(page, condition);

      expect(page.waitForLoadState).toHaveBeenCalledWith('networkidle', {
        timeout: 30_000,
      });
    });

    it('waits for a JS expression', async () => {
      const condition: WaitForCondition = {
        kind: 'expression',
        expression: 'window.ready === true',
      };
      await manager.waitFor(page, condition, { timeout: 5000 });

      expect(page.waitForFunction).toHaveBeenCalledWith(
        'window.ready === true',
        undefined,
        { timeout: 5000 }
      );
    });
  });

  // -----------------------------------------------------------------------
  // type
  // -----------------------------------------------------------------------

  describe('type()', () => {
    it('clicks the element, then types character-by-character', async () => {
      await manager.type(page, '#input', 'hello');

      expect(page.click).toHaveBeenCalledWith('#input', { timeout: 30_000 });
      expect(page.type).toHaveBeenCalledWith('#input', 'hello', { delay: 50 });
    });

    it('uses custom delay and timeout', async () => {
      await manager.type(page, '#input', 'abc', {
        delay: 100,
        timeout: 2000,
      });

      expect(page.click).toHaveBeenCalledWith('#input', { timeout: 2000 });
      expect(page.type).toHaveBeenCalledWith('#input', 'abc', { delay: 100 });
    });
  });

  // -----------------------------------------------------------------------
  // screenshot
  // -----------------------------------------------------------------------

  describe('screenshot()', () => {
    it('takes a screenshot and returns base64', async () => {
      const result = await manager.screenshot(page);

      expect(page.screenshot).toHaveBeenCalledWith({
        type: 'png',
        fullPage: false,
        clip: undefined,
      });
      expect(typeof result).toBe('string');
      expect(result).toBe(Buffer.from('PNG-DATA').toString('base64'));
    });

    it('passes fullPage and clip options', async () => {
      const clip = { x: 0, y: 0, width: 100, height: 100 };
      await manager.screenshot(page, { fullPage: true, clip });

      expect(page.screenshot).toHaveBeenCalledWith({
        type: 'png',
        fullPage: true,
        clip,
      });
    });
  });

  // -----------------------------------------------------------------------
  // evaluate
  // -----------------------------------------------------------------------

  describe('evaluate()', () => {
    it('evaluates an expression and returns the result', async () => {
      page.evaluate.mockResolvedValueOnce(42);

      const result = await manager.evaluate(page, '1 + 1');

      expect(result).toBe(42);
      expect(page.evaluate).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // getPageState
  // -----------------------------------------------------------------------

  describe('getPageState()', () => {
    it('returns url, title, and interactive elements', async () => {
      page.url.mockReturnValue('https://example.com/page');
      page.title.mockResolvedValue('My Page');
      page.evaluate.mockResolvedValueOnce([
        { tag: 'button', selector: '#btn', text: 'Click Me' },
      ]);

      const state = await manager.getPageState(page);

      expect(state.url).toBe('https://example.com/page');
      expect(state.title).toBe('My Page');
      expect(state.interactiveElements).toEqual([
        { tag: 'button', selector: '#btn', text: 'Click Me' },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // executeActions — batch execution
  // -----------------------------------------------------------------------

  describe('executeActions()', () => {
    it('executes multiple actions sequentially', async () => {
      const actions: BrowserAction[] = [
        { type: 'click', selector: '#btn' },
        { type: 'fill', selector: '#input', value: 'test' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(page.click).toHaveBeenCalledTimes(1);
      expect(page.fill).toHaveBeenCalledTimes(1);
    });

    it('records duration for each action', async () => {
      const actions: BrowserAction[] = [{ type: 'click', selector: '#btn' }];

      const results = await manager.executeActions(page, actions);

      expect(results[0].duration).toBeGreaterThanOrEqual(0);
    });

    it('continues after a failed action', async () => {
      page.click.mockRejectedValueOnce(new Error('Timeout'));

      const actions: BrowserAction[] = [
        { type: 'click', selector: '#bad' },
        { type: 'fill', selector: '#good', value: 'test' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Timeout');
      expect(results[1].success).toBe(true);
    });

    it('handles select action', async () => {
      const actions: BrowserAction[] = [
        { type: 'select', selector: 'select#c', values: ['val1'] },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
      expect(results[0].data).toEqual(['opt1']);
    });

    it('handles scroll action with direction', async () => {
      const actions: BrowserAction[] = [
        { type: 'scroll', direction: 'up' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
    });

    it('handles scroll action with value as amount', async () => {
      const actions: BrowserAction[] = [
        { type: 'scroll', direction: 'down', value: '500' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
    });

    it('handles scroll action with value=page', async () => {
      const actions: BrowserAction[] = [
        { type: 'scroll', direction: 'down', value: 'page' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
    });

    it('handles scroll with options amount and smooth', async () => {
      const actions: BrowserAction[] = [
        {
          type: 'scroll',
          direction: 'down',
          options: { amount: 300, smooth: true },
        },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
    });

    it('defaults scroll direction to down', async () => {
      const actions: BrowserAction[] = [{ type: 'scroll' }];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
    });

    it('handles hover action', async () => {
      const actions: BrowserAction[] = [
        { type: 'hover', selector: '.item' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
    });

    it('handles waitFor action with explicit condition', async () => {
      const actions: BrowserAction[] = [
        {
          type: 'waitFor',
          condition: { kind: 'selector', selector: '#done' },
        },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
    });

    it('handles waitFor action inferred from selector', async () => {
      const actions: BrowserAction[] = [
        { type: 'waitFor', selector: '#done' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
      expect(page.waitForSelector).toHaveBeenCalled();
    });

    it('handles waitFor action inferred from numeric value (timeout)', async () => {
      const actions: BrowserAction[] = [
        { type: 'waitFor', value: '1000' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
      expect(page.waitForTimeout).toHaveBeenCalledWith(1000);
    });

    it('handles waitFor action inferred from expression value', async () => {
      const actions: BrowserAction[] = [
        { type: 'waitFor', value: 'document.ready' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
      expect(page.waitForFunction).toHaveBeenCalled();
    });

    it('handles waitFor with expression field', async () => {
      const actions: BrowserAction[] = [
        { type: 'waitFor', expression: 'window.loaded' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
      expect(page.waitForFunction).toHaveBeenCalled();
    });

    it('handles waitFor fallback to networkidle', async () => {
      const actions: BrowserAction[] = [{ type: 'waitFor' }];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
      expect(page.waitForLoadState).toHaveBeenCalledWith(
        'networkidle',
        expect.anything()
      );
    });

    it('handles waitFor with networkidle option', async () => {
      const actions: BrowserAction[] = [
        { type: 'waitFor', options: { networkidle: true } },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
      expect(page.waitForLoadState).toHaveBeenCalled();
    });

    it('handles type action', async () => {
      const actions: BrowserAction[] = [
        { type: 'type', selector: '#input', value: 'hello' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
    });

    it('handles screenshot action', async () => {
      const actions: BrowserAction[] = [{ type: 'screenshot' }];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
      expect(typeof results[0].data).toBe('string');
    });

    it('handles evaluate action via expression field', async () => {
      page.evaluate.mockResolvedValueOnce('result');

      const actions: BrowserAction[] = [
        { type: 'evaluate', expression: '1 + 1' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
      expect(results[0].data).toBe('result');
    });

    it('handles evaluate action via value field', async () => {
      page.evaluate.mockResolvedValueOnce(99);

      const actions: BrowserAction[] = [
        { type: 'evaluate', value: 'return 99' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
      expect(results[0].data).toBe(99);
    });

    it('handles getPageState action', async () => {
      page.url.mockReturnValue('https://example.com');
      page.title.mockResolvedValue('Title');
      page.evaluate.mockResolvedValueOnce([]);

      const actions: BrowserAction[] = [{ type: 'getPageState' }];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
      expect(results[0].data).toHaveProperty('url');
    });

    // Error cases for validation

    it('fails click without selector', async () => {
      const actions: BrowserAction[] = [{ type: 'click' }];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('click requires a selector');
    });

    it('fails fill without selector', async () => {
      const actions: BrowserAction[] = [
        { type: 'fill', value: 'text' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('fill requires a selector');
    });

    it('fails fill without value', async () => {
      const actions: BrowserAction[] = [
        { type: 'fill', selector: '#x' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('fill requires a value');
    });

    it('fails select without selector', async () => {
      const actions: BrowserAction[] = [
        { type: 'select', values: ['a'] },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('select requires a selector');
    });

    it('fails select without values', async () => {
      const actions: BrowserAction[] = [
        { type: 'select', selector: '#s' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('select requires values');
    });

    it('select uses value as single-element array if values not provided', async () => {
      const actions: BrowserAction[] = [
        { type: 'select', selector: '#s', value: 'one' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(true);
      expect(page.selectOption).toHaveBeenCalledWith(
        '#s',
        ['one'],
        expect.anything()
      );
    });

    it('fails hover without selector', async () => {
      const actions: BrowserAction[] = [{ type: 'hover' }];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('hover requires a selector');
    });

    it('fails type without selector', async () => {
      const actions: BrowserAction[] = [
        { type: 'type', value: 'x' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('type requires a selector');
    });

    it('fails type without value', async () => {
      const actions: BrowserAction[] = [
        { type: 'type', selector: '#s' },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('type requires a value');
    });

    it('fails evaluate without expression or value', async () => {
      const actions: BrowserAction[] = [{ type: 'evaluate' }];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain(
        'evaluate requires an expression or value'
      );
    });

    it('fails on unknown action type', async () => {
      const actions: BrowserAction[] = [
        { type: 'unknownAction' as unknown },
      ];

      const results = await manager.executeActions(page, actions);

      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Unknown action type');
    });

    it('returns empty results for empty actions array', async () => {
      const results = await manager.executeActions(page, []);

      expect(results).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // friendlyError translation (tested through executeActions)
  // -----------------------------------------------------------------------

  describe('friendlyError (via executeActions)', () => {
    it('translates Timeout errors', async () => {
      page.click.mockRejectedValueOnce(
        new Error('Timeout 30000ms exceeded.\nwaiting for selector')
      );

      const results = await manager.executeActions(page, [
        { type: 'click', selector: '#x' },
      ]);

      expect(results[0].error).toMatch(/^Timeout:/);
    });

    it('translates not visible errors', async () => {
      page.click.mockRejectedValueOnce(
        new Error('Element is not visible\nmore details')
      );

      const results = await manager.executeActions(page, [
        { type: 'click', selector: '#x' },
      ]);

      expect(results[0].error).toMatch(/^Element not interactable:/);
    });

    it('translates not attached errors', async () => {
      page.click.mockRejectedValueOnce(
        new Error('Element is not attached to the DOM\nmore info')
      );

      const results = await manager.executeActions(page, [
        { type: 'click', selector: '#x' },
      ]);

      expect(results[0].error).toMatch(/^Element not interactable:/);
    });

    it('translates strict mode violation errors', async () => {
      page.click.mockRejectedValueOnce(
        new Error('strict mode violation: found 3 elements\ndetails')
      );

      const results = await manager.executeActions(page, [
        { type: 'click', selector: 'div' },
      ]);

      expect(results[0].error).toMatch(/^Multiple elements matched/);
    });

    it('handles non-Error throwables', async () => {
      page.click.mockRejectedValueOnce('string error');

      const results = await manager.executeActions(page, [
        { type: 'click', selector: '#x' },
      ]);

      expect(results[0].error).toBe('string error');
    });
  });
});
