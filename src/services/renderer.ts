import { chromium, type Browser, type Page, type BrowserContext } from 'playwright-core';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { config } from '../config/env';
import { STEALTH_USER_AGENTS } from '../config/user-agents';
import { logger } from '../utils/logger';

// Add stealth plugin to playwright
const chromiumStealth = addExtra(chromium);
chromiumStealth.use(StealthPlugin());

// Stealth scripts as strings to avoid tsx/esbuild __name helper injection.
// When passed as arrow functions, the transpiler wraps them with helpers
// that reference `__name` — which doesn't exist in the browser context.
const STEALTH_INIT_SCRIPT = `
  // Override navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });

  // Remove automation indicators
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
  delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

  // Add realistic plugins
  Object.defineProperty(navigator, 'plugins', {
    get: function() { return [1, 2, 3, 4, 5]; }
  });

  // Mock languages
  Object.defineProperty(navigator, 'languages', {
    get: function() { return ['en-US', 'en']; }
  });

  // Mock realistic Chrome properties
  Object.defineProperty(navigator, 'platform', {
    get: function() { return 'Win32'; }
  });

  Object.defineProperty(navigator, 'vendor', {
    get: function() { return 'Google Inc.'; }
  });

  // Mock permissions
  var originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
  window.navigator.permissions.query = function(parameters) {
    return parameters.name === 'notifications'
      ? Promise.resolve({ state: 'denied' })
      : originalQuery(parameters);
  };

  // Add realistic navigator properties
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: function() { return 8; }
  });

  Object.defineProperty(navigator, 'deviceMemory', {
    get: function() { return 8; }
  });

  // Mock connection
  Object.defineProperty(navigator, 'connection', {
    get: function() {
      return { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false };
    }
  });

  // WebGL fingerprinting protection
  var origGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return origGetParameter.call(this, parameter);
  };

  // Canvas fingerprinting protection (noise injection)
  var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function() {
    var ctx = this.getContext('2d');
    if (ctx) {
      var imageData = ctx.getImageData(0, 0, this.width, this.height);
      for (var i = 0; i < imageData.data.length; i += 4) {
        imageData.data[i] += Math.floor(Math.random() * 3) - 1;
      }
      ctx.putImageData(imageData, 0, 0);
    }
    return origToDataURL.apply(this, arguments);
  };

  // Audio fingerprinting protection
  var audioContext = window.AudioContext || window.webkitAudioContext;
  if (audioContext) {
    var origGetChannelData = audioContext.prototype.getChannelData;
    audioContext.prototype.getChannelData = function() {
      var buffer = origGetChannelData.apply(this, arguments);
      for (var i = 0; i < buffer.length; i++) {
        buffer[i] += Math.random() * 0.0001;
      }
      return buffer;
    };
  }
`;

// Random mouse movements for human-like behavior
const MOUSE_MOVEMENT_SCRIPT = `
  var mouseX = 0;
  var mouseY = 0;
  var moveRandomly = function() {
    mouseX += (Math.random() - 0.5) * 100;
    mouseY += (Math.random() - 0.5) * 100;
    mouseX = Math.max(0, Math.min(window.innerWidth, mouseX));
    mouseY = Math.max(0, Math.min(window.innerHeight, mouseY));
  };
  setInterval(moveRandomly, 5000 + Math.random() * 5000);
`;

class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    this.available = max;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      if (resolve) {
        resolve();
      }
      return;
    }

    this.available = Math.min(this.available + 1, this.max);
  }

  snapshot(): { available: number; pending: number; max: number } {
    return {
      available: this.available,
      pending: this.queue.length,
      max: this.max
    };
  }
}

class RendererManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly semaphore: Semaphore;

  constructor() {
    this.semaphore = new Semaphore(Math.max(1, config.rendering.maxPages));
  }

  async init(): Promise<void> {
    if (!config.rendering.enabled) {
      return;
    }

    if (this.browser) {
      return;
    }

    if (!this.launching) {
      const launchOptions = {
        headless: config.rendering.headless,
        args: [
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled'
        ],
        ...(config.rendering.proxy && {
          proxy: {
            server: config.rendering.proxy
          }
        })
      };

      const browserEngine = config.rendering.stealth ? chromiumStealth : chromium;
      const mode = config.rendering.stealth ? 'playwright-stealth' : 'playwright';

      this.launching = browserEngine
        .launch(launchOptions)
        .then((browser) => {
          this.browser = browser;
          logger.info('renderer launched', {
            mode,
            headless: config.rendering.headless,
            stealth: config.rendering.stealth,
            proxy: config.rendering.proxy ? 'enabled' : 'disabled'
          });
          return browser;
        })
        .catch((error) => {
          logger.error('renderer launch failed', { error: (error as Error).message });
          this.launching = null;
          throw error;
        });
    }

    await this.launching.catch((error) => {
      throw error;
    });
  }

  async withPage<T>(
    handler: (page: Page, context: BrowserContext) => Promise<T>,
    options?: WithPageOptions
  ): Promise<{ result: T; status: RendererStatus }> {
    await this.init();

    if (!this.browser) {
      throw new Error('renderer unavailable');
    }

    await this.semaphore.acquire();

    let context: BrowserContext | null = null;
    try {
      // Random viewport for anti-detection
      const viewportWidth = 1920 + Math.floor(Math.random() * 200 - 100);
      const viewportHeight = 1080 + Math.floor(Math.random() * 200 - 100);

      // Enhanced user agents for stealth
      const userAgents = config.rendering.stealth
        ? STEALTH_USER_AGENTS
        : [config.fetch.userAgent];

      const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

      // Build context options including extra HTTP headers if provided
      const contextOptions: Parameters<Browser['newContext']>[0] = {
        userAgent: randomUserAgent,
        viewport: { width: viewportWidth, height: viewportHeight },
        locale: 'en-US',
        timezoneId: 'America/New_York'
      };

      // Add custom headers if provided
      if (options?.headers) {
        contextOptions.extraHTTPHeaders = options.headers;
      }

      context = await this.browser.newContext(contextOptions);

      // Add cookies if provided
      if (options?.cookies && options.cookies.length > 0) {
        const playwrightCookies = options.cookies.map(cookie => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain || '',
          path: cookie.path || '/',
          expires: cookie.expires,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite
        }));
        await context.addCookies(playwrightCookies);
        logger.debug('Added cookies to renderer context', {
          count: options.cookies.length,
          domains: [...new Set(options.cookies.map(c => c.domain).filter(Boolean))]
        });
      }

      const page = await context.newPage();

      // Additional stealth measures (COMPETITION KILLER MODE)
      // NOTE: Scripts are passed as strings to avoid tsx/esbuild injecting
      // __name helpers that don't exist in the browser context.
      if (config.rendering.stealth) {
        await page.addInitScript({ content: STEALTH_INIT_SCRIPT });
        await page.evaluate(MOUSE_MOVEMENT_SCRIPT);
      }

      const result = await handler(page, context);
      return { result, status: this.getStatus() };
    } finally {
      if (context) {
        await context.close();
      }
      this.semaphore.release();
    }
  }

  async dispose(): Promise<void> {
    const launch = this.launching;
    if (launch) {
      await launch.catch(() => null);
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    this.launching = null;
  }

  getStatus(): RendererStatus {
    return {
      enabled: config.rendering.enabled,
      initialized: Boolean(this.browser),
      concurrency: this.semaphore.snapshot()
    };
  }

  /**
   * Get browser instance (for persistent sessions)
   * Only use this if you need to manage contexts manually
   */
  async getBrowser(): Promise<Browser> {
    await this.init();
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }
    return this.browser;
  }
}

export interface RendererStatus {
  enabled: boolean;
  initialized: boolean;
  concurrency: {
    available: number;
    pending: number;
    max: number;
  };
}

/**
 * Cookie format for renderer sessions
 */
export interface RendererCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Options for withPage method
 */
export interface WithPageOptions {
  cookies?: RendererCookie[];
  headers?: Record<string, string>;
  timeout?: number;
}

export const rendererManager = new RendererManager();

export const initRenderer = async (): Promise<{ launched: boolean; error?: string }> => {
  if (!config.rendering.enabled) {
    return { launched: false, error: 'disabled' };
  }

  try {
    await rendererManager.init();
    return { launched: true };
  } catch (error) {
    return { launched: false, error: (error as Error).message };
  }
};

export const shutdownRenderer = async (): Promise<void> => {
  await rendererManager.dispose();
};

export const getRendererStatus = (): RendererStatus => rendererManager.getStatus();
