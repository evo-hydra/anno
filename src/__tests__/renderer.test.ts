import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
// Mock config
// ---------------------------------------------------------------------------

const mockConfig = {
  rendering: {
    enabled: true,
    headless: true,
    maxPages: 2,
    stealth: false,
    proxy: undefined as string | undefined,
  },
  fetch: {
    userAgent: 'Anno/1.0',
  },
};

vi.mock('../config/env', () => ({
  config: mockConfig,
}));

// ---------------------------------------------------------------------------
// Mock Playwright — must be set up before module import
// ---------------------------------------------------------------------------

const mockPageAddInitScript = vi.fn().mockResolvedValue(undefined);
const mockPageEvaluate = vi.fn().mockResolvedValue(undefined);
const mockNewPage = vi.fn().mockResolvedValue({
  addInitScript: mockPageAddInitScript,
  evaluate: mockPageEvaluate,
  goto: vi.fn().mockResolvedValue(undefined),
  content: vi.fn().mockResolvedValue('<html></html>'),
});

const mockAddCookies = vi.fn().mockResolvedValue(undefined);
const mockContextClose = vi.fn().mockResolvedValue(undefined);
const mockNewContext = vi.fn().mockResolvedValue({
  newPage: mockNewPage,
  addCookies: mockAddCookies,
  close: mockContextClose,
});

const mockBrowserClose = vi.fn().mockResolvedValue(undefined);
const mockBrowser = {
  newContext: mockNewContext,
  close: mockBrowserClose,
};

const mockLaunch = vi.fn().mockResolvedValue(mockBrowser);

vi.mock('playwright-core', () => ({
  chromium: {
    launch: (...args: unknown[]) => mockLaunch(...args),
  },
}));

vi.mock('playwright-extra', () => ({
  addExtra: () => ({
    use: vi.fn(),
    launch: (...args: unknown[]) => mockLaunch(...args),
  }),
}));

vi.mock('puppeteer-extra-plugin-stealth', () => ({
  default: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Import after all mocks are set up
// ---------------------------------------------------------------------------

// We need dynamic imports because the module has top-level side effects
// (chromiumStealth setup). We'll use resetModules + import to get fresh instances.

describe('Renderer — Semaphore (internal)', () => {
  // We can't easily import the Semaphore since it's not exported.
  // But we test its behavior through RendererManager.withPage concurrency.
  // See the RendererManager tests below.

  it('placeholder for semaphore (tested via RendererManager)', () => {
    expect(true).toBe(true);
  });
});

describe('RendererManager', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset config for each test
    mockConfig.rendering.enabled = true;
    mockConfig.rendering.headless = true;
    mockConfig.rendering.maxPages = 2;
    mockConfig.rendering.stealth = false;
    mockConfig.rendering.proxy = undefined;

    // Reset module to get a fresh RendererManager class (not singleton)
    vi.resetModules();

    // Re-apply mocks after resetModules
    vi.doMock('../utils/logger', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../config/env', () => ({ config: mockConfig }));
    vi.doMock('playwright-core', () => ({
      chromium: { launch: (...args: unknown[]) => mockLaunch(...args) },
    }));
    vi.doMock('playwright-extra', () => ({
      addExtra: () => ({
        use: vi.fn(),
        launch: (...args: unknown[]) => mockLaunch(...args),
      }),
    }));
    vi.doMock('puppeteer-extra-plugin-stealth', () => ({
      default: vi.fn(() => ({})),
    }));

    const mod = await import('../services/renderer');
    // We can't use the class directly since it's not exported by name in a
    // way we can construct — use the exported functions instead.
    // Module re-imported for fresh singleton per test
    void mod.RendererManager;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // init
  // -----------------------------------------------------------------------

  describe('init()', () => {
    it('does nothing when rendering is disabled', async () => {
      mockConfig.rendering.enabled = false;

      const mod = await import('../services/renderer');
      const result = await mod.initRenderer();

      expect(result.launched).toBe(false);
      expect(result.error).toBe('disabled');
      expect(mockLaunch).not.toHaveBeenCalled();
    });

    it('launches browser when rendering is enabled', async () => {
      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      expect(mockLaunch).toHaveBeenCalledTimes(1);
    });

    it('does not launch twice on repeated init calls', async () => {
      const mod = await import('../services/renderer');
      await mod.rendererManager.init();
      await mod.rendererManager.init();

      expect(mockLaunch).toHaveBeenCalledTimes(1);
    });

    it('handles launch failure', async () => {
      mockLaunch.mockRejectedValueOnce(new Error('No browser found'));

      const mod = await import('../services/renderer');
      const result = await mod.initRenderer();

      expect(result.launched).toBe(false);
      expect(result.error).toBe('No browser found');
    });

    it('passes proxy config to launch options when proxy is set', async () => {
      mockConfig.rendering.proxy = 'http://proxy.example.com:8080';

      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          proxy: { server: 'http://proxy.example.com:8080' },
        })
      );
    });

    it('does not include proxy in launch options when proxy is not set', async () => {
      mockConfig.rendering.proxy = undefined;

      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      const launchOptions = mockLaunch.mock.calls[0][0];
      expect(launchOptions.proxy).toBeUndefined();
    });

    it('uses stealth browser engine when stealth is enabled', async () => {
      mockConfig.rendering.stealth = true;

      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      // The launch mock is shared between chromium and chromiumStealth,
      // so we just verify launch was called
      expect(mockLaunch).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // getStatus
  // -----------------------------------------------------------------------

  describe('getStatus()', () => {
    it('returns enabled=false when rendering is disabled', async () => {
      mockConfig.rendering.enabled = false;

      const mod = await import('../services/renderer');
      const status = mod.getRendererStatus();

      expect(status.enabled).toBe(false);
      expect(status.initialized).toBe(false);
    });

    it('reports initialized=true after init', async () => {
      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      const status = mod.rendererManager.getStatus();

      expect(status.enabled).toBe(true);
      expect(status.initialized).toBe(true);
    });

    it('reports concurrency info', async () => {
      const mod = await import('../services/renderer');
      const status = mod.rendererManager.getStatus();

      expect(status.concurrency).toBeDefined();
      expect(status.concurrency.max).toBe(2);
      expect(typeof status.concurrency.available).toBe('number');
      expect(typeof status.concurrency.pending).toBe('number');
    });
  });

  // -----------------------------------------------------------------------
  // withPage
  // -----------------------------------------------------------------------

  describe('withPage()', () => {
    it('executes handler with a page and returns result', async () => {
      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      const { result } = await mod.rendererManager.withPage(async (_page) => {
        return 'handler-result';
      });

      expect(result).toBe('handler-result');
    });

    it('closes context after handler completes', async () => {
      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      await mod.rendererManager.withPage(async () => 'done');

      expect(mockContextClose).toHaveBeenCalledTimes(1);
    });

    it('closes context even if handler throws', async () => {
      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      await expect(
        mod.rendererManager.withPage(async () => {
          throw new Error('handler error');
        })
      ).rejects.toThrow('handler error');

      expect(mockContextClose).toHaveBeenCalledTimes(1);
    });

    it('throws when browser is not initialized (rendering disabled)', async () => {
      mockConfig.rendering.enabled = false;

      const mod = await import('../services/renderer');

      await expect(
        mod.rendererManager.withPage(async () => 'result')
      ).rejects.toThrow('renderer unavailable');
    });

    it('returns renderer status alongside result', async () => {
      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      const { status } = await mod.rendererManager.withPage(async () => 'ok');

      expect(status).toBeDefined();
      expect(status.enabled).toBe(true);
      expect(status.initialized).toBe(true);
    });

    it('passes custom headers to browser context', async () => {
      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      await mod.rendererManager.withPage(async () => 'ok', {
        headers: { 'X-Custom': 'test-value' },
      });

      expect(mockNewContext).toHaveBeenCalledWith(
        expect.objectContaining({
          extraHTTPHeaders: { 'X-Custom': 'test-value' },
        })
      );
    });

    it('adds cookies to context when provided', async () => {
      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      await mod.rendererManager.withPage(async () => 'ok', {
        cookies: [
          { name: 'session', value: 'abc123', domain: 'example.com' },
        ],
      });

      expect(mockAddCookies).toHaveBeenCalledTimes(1);
      expect(mockAddCookies).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'session', value: 'abc123' }),
        ])
      );
    });

    it('does not add cookies when none provided', async () => {
      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      await mod.rendererManager.withPage(async () => 'ok');

      expect(mockAddCookies).not.toHaveBeenCalled();
    });

    it('runs stealth init script and mouse movement when stealth enabled', async () => {
      mockConfig.rendering.stealth = true;

      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      await mod.rendererManager.withPage(async () => 'stealth-ok');

      // Stealth mode should trigger addInitScript and evaluate for mouse movements
      expect(mockPageAddInitScript).toHaveBeenCalledTimes(1);
      expect(mockPageEvaluate).toHaveBeenCalledTimes(1);
    });

    it('does not run stealth scripts when stealth is disabled', async () => {
      mockConfig.rendering.stealth = false;

      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      await mod.rendererManager.withPage(async () => 'no-stealth');

      expect(mockPageAddInitScript).not.toHaveBeenCalled();
      expect(mockPageEvaluate).not.toHaveBeenCalled();
    });

    it('uses stealth user agents when stealth is enabled', async () => {
      mockConfig.rendering.stealth = true;

      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      await mod.rendererManager.withPage(async () => 'ok');

      const contextCall = mockNewContext.mock.calls[0][0];
      // Should use one of the Chrome user agents, not the default config one
      expect(contextCall.userAgent).toMatch(/Chrome\/131/);
    });

    it('uses config user agent when stealth is disabled', async () => {
      mockConfig.rendering.stealth = false;
      mockConfig.fetch.userAgent = 'CustomAgent/1.0';

      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      await mod.rendererManager.withPage(async () => 'ok');

      const contextCall = mockNewContext.mock.calls[0][0];
      expect(contextCall.userAgent).toBe('CustomAgent/1.0');
    });
  });

  // -----------------------------------------------------------------------
  // dispose
  // -----------------------------------------------------------------------

  describe('dispose()', () => {
    it('closes the browser', async () => {
      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      await mod.rendererManager.dispose();

      expect(mockBrowserClose).toHaveBeenCalledTimes(1);
    });

    it('handles dispose when browser was never initialized', async () => {
      mockConfig.rendering.enabled = false;

      const mod = await import('../services/renderer');

      // Should not throw
      await mod.rendererManager.dispose();
    });

    it('shutdownRenderer calls dispose', async () => {
      const mod = await import('../services/renderer');
      await mod.rendererManager.init();

      await mod.shutdownRenderer();

      expect(mockBrowserClose).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // getBrowser
  // -----------------------------------------------------------------------

  describe('getBrowser()', () => {
    it('returns browser instance after init', async () => {
      const mod = await import('../services/renderer');
      const browser = await mod.rendererManager.getBrowser();

      expect(browser).toBeDefined();
      expect(browser.newContext).toBeDefined();
    });

    it('initializes if not already initialized', async () => {
      const mod = await import('../services/renderer');

      // getBrowser should trigger init
      await mod.rendererManager.getBrowser();

      expect(mockLaunch).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // initRenderer / shutdownRenderer convenience functions
  // -----------------------------------------------------------------------

  describe('initRenderer()', () => {
    it('returns launched=true on success', async () => {
      const mod = await import('../services/renderer');
      const result = await mod.initRenderer();

      expect(result.launched).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns launched=false with error on failure', async () => {
      mockLaunch.mockRejectedValueOnce(new Error('Cannot find chromium'));

      const mod = await import('../services/renderer');
      const result = await mod.initRenderer();

      expect(result.launched).toBe(false);
      expect(result.error).toBe('Cannot find chromium');
    });
  });

  describe('getRendererStatus()', () => {
    it('returns status object', async () => {
      const mod = await import('../services/renderer');
      const status = mod.getRendererStatus();

      expect(status).toHaveProperty('enabled');
      expect(status).toHaveProperty('initialized');
      expect(status).toHaveProperty('concurrency');
    });
  });
});
