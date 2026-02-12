import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockMkdir,
  mockWriteFile,
  mockReadFile,
  mockExistsSync,
  mockContextCookies,
  mockContextAddCookies,
  mockContextClose,
  mockPageGoto,
  mockPageClose,
  _mockPageWaitForLoadState,
  _mockPageViewportSize,
  mockPageMouse,
  mockPageLocator,
  mockPage,
  _mockNewPage,
  mockNewContext,
  mockBrowser,
} = vi.hoisted(() => {
  const mockContextCookies = vi.fn().mockResolvedValue([
    { name: 'sid', value: '123', domain: '.example.com' },
  ]);
  const mockContextAddCookies = vi.fn().mockResolvedValue(undefined);
  const mockContextClose = vi.fn().mockResolvedValue(undefined);

  const mockPageGoto = vi.fn().mockResolvedValue(undefined);
  const mockPageClose = vi.fn().mockResolvedValue(undefined);
  const mockPageWaitForLoadState = vi.fn().mockResolvedValue(undefined);
  const mockPageViewportSize = vi.fn().mockReturnValue({ width: 1920, height: 1080 });
  const mockPageMouse = { wheel: vi.fn().mockResolvedValue(undefined) };
  const mockPageLocator = vi.fn().mockReturnValue({
    all: vi.fn().mockResolvedValue([]),
    isVisible: vi.fn().mockResolvedValue(false),
    textContent: vi.fn().mockResolvedValue(''),
  });

  const mockPage = {
    goto: mockPageGoto,
    close: mockPageClose,
    waitForLoadState: mockPageWaitForLoadState,
    viewportSize: mockPageViewportSize,
    mouse: mockPageMouse,
    locator: mockPageLocator,
  };

  const mockNewPage = vi.fn().mockResolvedValue(mockPage);

  const mockNewContext = vi.fn().mockResolvedValue({
    newPage: mockNewPage,
    cookies: mockContextCookies,
    addCookies: mockContextAddCookies,
    close: mockContextClose,
  });

  const mockBrowser = {
    newContext: mockNewContext,
  };

  return {
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    mockReadFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    mockExistsSync: vi.fn().mockReturnValue(false),
    mockContextCookies,
    mockContextAddCookies,
    mockContextClose,
    mockPageGoto,
    mockPageClose,
    _mockPageWaitForLoadState: mockPageWaitForLoadState,
    _mockPageViewportSize: mockPageViewportSize,
    mockPageMouse,
    mockPageLocator,
    mockPage,
    _mockNewPage: mockNewPage,
    mockNewContext,
    mockBrowser,
  };
});

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
// Mock fs
// ---------------------------------------------------------------------------

vi.mock('fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

// ---------------------------------------------------------------------------
// Mock renderer
// ---------------------------------------------------------------------------

vi.mock('../services/renderer', () => ({
  rendererManager: {
    getBrowser: vi.fn().mockResolvedValue(mockBrowser),
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { PersistentSessionManager } from '../services/persistent-session-manager';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PersistentSessionManager', () => {
  let manager: PersistentSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Use fake timers so humanDelay calls resolve instantly via advanceTimersByTime
    vi.useFakeTimers();
    mockExistsSync.mockReturnValue(false);

    manager = new PersistentSessionManager({
      maxAge: 600_000, // 10 minutes — large enough that timer advancement during warming won't expire the session
      maxRequests: 5,
      warmingPages: 1,
      cookieStorePath: '/tmp/anno-test-sessions',
      sessionRotationDelay: 1000,
    });
  });

  afterEach(async () => {
    await manager.closeAll();
    vi.useRealTimers();
  });

  // Helper: getSession with warming needs timer advancement because
  // humanDelay uses setTimeout. We run all pending timers to completion.
  async function getSessionWithTimers(domain: string) {
    const p = manager.getSession(domain);
    // Repeatedly flush timers until the promise resolves
    // humanDelay creates short timeouts; we advance enough to clear them all
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    return p;
  }

  // -----------------------------------------------------------------------
  // constructor
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('creates storage directory if it does not exist', () => {
      expect(mockMkdir).toHaveBeenCalledWith(
        '/tmp/anno-test-sessions',
        { recursive: true }
      );
    });

    it('uses default config when none provided', () => {
      mockExistsSync.mockReturnValue(true);
      const defaultManager = new PersistentSessionManager();
      expect(defaultManager).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // getSession
  // -----------------------------------------------------------------------

  describe('getSession()', () => {
    it('creates a new session for a new domain', async () => {
      const context = await getSessionWithTimers('example.com');

      expect(context).toBeDefined();
      expect(mockNewContext).toHaveBeenCalled();
    });

    it('reuses existing valid session', async () => {
      await getSessionWithTimers('example.com');
      mockNewContext.mockClear();

      const context = await getSessionWithTimers('example.com');

      expect(context).toBeDefined();
      expect(mockNewContext).not.toHaveBeenCalled();
    });

    it('increments request count on reuse', async () => {
      await getSessionWithTimers('example.com');
      await getSessionWithTimers('example.com');

      const stats = manager.getStats();
      expect(stats['example.com'].requestCount).toBe(1);
    });

    it('replaces session that exceeded maxRequests', async () => {
      // maxRequests = 5; first call creates (count=0), each subsequent reuse increments.
      // After 6 calls: count = 5. The 7th call sees count >= 5 -> invalid -> creates new session.
      for (let i = 0; i < 6; i++) {
        await getSessionWithTimers('example.com');
      }
      mockNewContext.mockClear();

      await getSessionWithTimers('example.com');

      expect(mockNewContext).toHaveBeenCalled();
    });

    it('replaces session that exceeded maxAge', async () => {
      await getSessionWithTimers('example.com');
      mockNewContext.mockClear();

      // Advance time beyond maxAge (10 minutes)
      vi.advanceTimersByTime(601_000);

      await getSessionWithTimers('example.com');

      expect(mockNewContext).toHaveBeenCalled();
    });

    it('loads saved cookies when they exist', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify([{ name: 'sid', value: '123', domain: '.example.com' }])
      );

      await getSessionWithTimers('example.com');

      expect(mockContextAddCookies).toHaveBeenCalled();
    });

    it('handles cookie load failure gracefully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockRejectedValueOnce(new Error('read error'));

      const context = await getSessionWithTimers('example.com');
      expect(context).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // session warming
  // -----------------------------------------------------------------------

  describe('session warming', () => {
    it('navigates to the domain homepage during warming', async () => {
      await getSessionWithTimers('example.com');

      expect(mockPageGoto).toHaveBeenCalledWith(
        'https://www.example.com',
        expect.objectContaining({ waitUntil: 'networkidle' })
      );
    });

    it('scrolls the page naturally during warming', async () => {
      await getSessionWithTimers('example.com');

      expect(mockPageMouse.wheel).toHaveBeenCalled();
    });

    it('closes the warming page after completion', async () => {
      await getSessionWithTimers('example.com');

      expect(mockPageClose).toHaveBeenCalled();
    });

    it('closes warming page even if warming fails', async () => {
      mockPageGoto.mockRejectedValueOnce(new Error('Navigation failed'));

      let caught: Error | undefined;
      // Attach .catch immediately to prevent unhandled rejection warnings
      const p = manager.getSession('example.com').catch((err: Error) => {
        caught = err;
      });

      // Flush timers so the warming promise can settle
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }
      await p;

      expect(caught?.message).toBe('Navigation failed');
      expect(mockPageClose).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // isSessionValid
  // -----------------------------------------------------------------------

  describe('isSessionValid (via getSession)', () => {
    it('session is warmed after creation', async () => {
      await getSessionWithTimers('example.com');

      const stats = manager.getStats();
      expect(stats['example.com'].warmed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // closeSession
  // -----------------------------------------------------------------------

  describe('closeSession()', () => {
    it('saves cookies and closes context', async () => {
      await getSessionWithTimers('example.com');

      await manager.closeSession('example.com');

      expect(mockContextCookies).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();
      expect(mockContextClose).toHaveBeenCalled();
    });

    it('does nothing for non-existent session', async () => {
      await manager.closeSession('nonexistent.com');
    });

    it('handles close errors gracefully', async () => {
      await getSessionWithTimers('example.com');

      mockContextClose.mockRejectedValueOnce(new Error('close failed'));

      await manager.closeSession('example.com');
    });

    it('removes session from stats after close', async () => {
      await getSessionWithTimers('example.com');
      expect(manager.getStats()).toHaveProperty('example.com');

      await manager.closeSession('example.com');

      expect(manager.getStats()).not.toHaveProperty('example.com');
    });
  });

  // -----------------------------------------------------------------------
  // closeAll
  // -----------------------------------------------------------------------

  describe('closeAll()', () => {
    it('closes all active sessions', async () => {
      await getSessionWithTimers('a.com');
      await getSessionWithTimers('b.com');

      await manager.closeAll();

      expect(manager.getStats()).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // detectCaptcha
  // -----------------------------------------------------------------------

  describe('detectCaptcha()', () => {
    it('returns detected=false when no captcha found', async () => {
      mockPageLocator.mockReturnValue({
        isVisible: vi.fn().mockResolvedValue(false),
        textContent: vi.fn().mockResolvedValue('Normal page content'),
      });

      const result = await manager.detectCaptcha(mockPage as unknown);

      expect(result.detected).toBe(false);
    });

    it('detects recaptcha', async () => {
      mockPageLocator.mockImplementation((selector: string) => ({
        isVisible: vi.fn().mockResolvedValue(selector === '.g-recaptcha'),
        textContent: vi.fn().mockResolvedValue(''),
      }));

      const result = await manager.detectCaptcha(mockPage as unknown);

      expect(result.detected).toBe(true);
      expect(result.type).toBe('recaptcha');
    });

    it('detects perimeter-x captcha', async () => {
      mockPageLocator.mockImplementation((selector: string) => ({
        isVisible: vi.fn().mockResolvedValue(selector === '#px-captcha'),
        textContent: vi.fn().mockResolvedValue(''),
      }));

      const result = await manager.detectCaptcha(mockPage as unknown);

      expect(result.detected).toBe(true);
      expect(result.type).toBe('perimeter-x');
    });

    it('detects cloudflare challenge', async () => {
      mockPageLocator.mockImplementation((selector: string) => ({
        isVisible: vi.fn().mockResolvedValue(selector === '.challenge-form'),
        textContent: vi.fn().mockResolvedValue(''),
      }));

      const result = await manager.detectCaptcha(mockPage as unknown);

      expect(result.detected).toBe(true);
      expect(result.type).toBe('cloudflare');
    });

    it('detects challenge text indicators', async () => {
      mockPageLocator.mockImplementation((selector: string) => {
        if (selector === 'body') {
          return {
            isVisible: vi.fn().mockResolvedValue(false),
            textContent: vi.fn().mockResolvedValue(
              'Please verify you are human to continue'
            ),
          };
        }
        return {
          isVisible: vi.fn().mockResolvedValue(false),
          textContent: vi.fn().mockResolvedValue(''),
        };
      });

      const result = await manager.detectCaptcha(mockPage as unknown);

      expect(result.detected).toBe(true);
      expect(result.type).toBe('unknown');
    });

    it('handles isVisible errors gracefully', async () => {
      mockPageLocator.mockImplementation((selector: string) => {
        if (selector === 'body') {
          return {
            isVisible: vi.fn().mockRejectedValue(new Error('detached')),
            textContent: vi.fn().mockResolvedValue(''),
          };
        }
        return {
          isVisible: vi.fn().mockRejectedValue(new Error('detached')),
          textContent: vi.fn().mockResolvedValue(''),
        };
      });

      const result = await manager.detectCaptcha(mockPage as unknown);

      expect(result.detected).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // handleCaptcha
  // -----------------------------------------------------------------------

  describe('handleCaptcha()', () => {
    it('closes the session for the challenged domain', async () => {
      await getSessionWithTimers('example.com');

      const promise = manager.handleCaptcha('example.com', {
        detected: true,
        type: 'recaptcha',
      });

      // Advance past the cooldown (10-20 minutes)
      await vi.advanceTimersByTimeAsync(21 * 60 * 1000);
      await promise;

      expect(mockContextClose).toHaveBeenCalled();
      expect(manager.getStats()).not.toHaveProperty('example.com');
    });
  });

  // -----------------------------------------------------------------------
  // getStats
  // -----------------------------------------------------------------------

  describe('getStats()', () => {
    it('returns empty object when no sessions', () => {
      expect(manager.getStats()).toEqual({});
    });

    it('returns stats for active sessions', async () => {
      await getSessionWithTimers('example.com');

      const stats = manager.getStats();

      expect(stats['example.com']).toBeDefined();
      expect(stats['example.com'].age).toBeGreaterThanOrEqual(0);
      expect(stats['example.com'].requestCount).toBe(0);
      expect(stats['example.com'].warmed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // saveCookies (via closeSession)
  // -----------------------------------------------------------------------

  describe('saveCookies (via closeSession)', () => {
    it('saves cookies to the correct path', async () => {
      await getSessionWithTimers('example.com');
      await manager.closeSession('example.com');

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('example.com.json'),
        expect.any(String)
      );
    });

    it('handles save failure gracefully', async () => {
      await getSessionWithTimers('example.com');
      mockWriteFile.mockRejectedValueOnce(new Error('write failed'));

      await manager.closeSession('example.com');
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent session warming
  // -----------------------------------------------------------------------

  describe('concurrent warming', () => {
    it('does not create duplicate sessions for same domain', async () => {
      const promise1 = manager.getSession('example.com');
      const promise2 = manager.getSession('example.com');

      // Advance timers for warming delays
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }

      const [ctx1, ctx2] = await Promise.all([promise1, promise2]);

      expect(ctx1).toBe(ctx2);
      expect(mockNewContext).toHaveBeenCalledTimes(1);
    });
  });
});
