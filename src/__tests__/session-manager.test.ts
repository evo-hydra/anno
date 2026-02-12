import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — these variables are available in vi.mock() factories
// ---------------------------------------------------------------------------

const {
  mockMkdir,
  mockWriteFile,
  mockReadFile,
  mockExistsSync,
  mockPageClose,
  mockPageIsClosed,
  mockPageUrl,
  mockContextCookies,
  mockContextAddCookies,
  mockContextClose,
  mockContextNewPage,
  mockNewContext,
  mockBrowser,
} = vi.hoisted(() => {
  const mockPageClose = vi.fn().mockResolvedValue(undefined);
  const mockPageIsClosed = vi.fn().mockReturnValue(false);
  const mockPageUrl = vi.fn().mockReturnValue('https://example.com');

  const createMockPage = () => ({
    close: mockPageClose,
    isClosed: mockPageIsClosed,
    url: mockPageUrl,
  });

  const mockContextCookies = vi.fn().mockResolvedValue([]);
  const mockContextAddCookies = vi.fn().mockResolvedValue(undefined);
  const mockContextClose = vi.fn().mockResolvedValue(undefined);
  const mockContextNewPage = vi.fn().mockResolvedValue(createMockPage());

  const mockNewContext = vi.fn().mockResolvedValue({
    newPage: mockContextNewPage,
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
    mockReadFile: vi.fn().mockResolvedValue(Buffer.alloc(64)),
    mockExistsSync: vi.fn().mockReturnValue(false),
    mockPageClose,
    mockPageIsClosed,
    mockPageUrl,
    mockContextCookies,
    mockContextAddCookies,
    mockContextClose,
    mockContextNewPage,
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
// Mock node:fs/promises and node:fs
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

vi.mock('node:fs', () => ({
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

import { SessionManager } from '../services/session-manager';

// ---------------------------------------------------------------------------
// Helper to create a fresh mock page
// ---------------------------------------------------------------------------

function createMockPage() {
  return {
    close: mockPageClose,
    isClosed: mockPageIsClosed,
    url: mockPageUrl,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockPageIsClosed.mockReturnValue(false);
    mockPageUrl.mockReturnValue('https://example.com');
    mockContextNewPage.mockResolvedValue(createMockPage());
    mockContextCookies.mockResolvedValue([]);
    mockContextClose.mockResolvedValue(undefined);
    manager = new SessionManager(3);
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  // -----------------------------------------------------------------------
  // init
  // -----------------------------------------------------------------------

  describe('init()', () => {
    it('creates data directory if it does not exist', async () => {
      expect(mockMkdir).toHaveBeenCalled();
    });

    it('generates encryption key when key file does not exist', async () => {
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('loads existing encryption key when file exists and is correct length', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValueOnce(Buffer.alloc(64, 0xAB));

      const mgr = new SessionManager();
      await mgr.init();

      expect(mockReadFile).toHaveBeenCalled();
      await mgr.shutdown();
    });

    it('regenerates key if file is invalid length', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValueOnce(Buffer.alloc(10));

      const mgr = new SessionManager();
      await mgr.init();

      expect(mockWriteFile).toHaveBeenCalled();
      await mgr.shutdown();
    });
  });

  // -----------------------------------------------------------------------
  // createSession
  // -----------------------------------------------------------------------

  describe('createSession()', () => {
    it('creates a session and returns session info', async () => {
      const info = await manager.createSession({ name: 'test-session' });

      expect(info.id).toBeTruthy();
      expect(info.name).toBe('test-session');
      expect(info.status).toBe('active');
      expect(info.ttl).toBe(1800);
      expect(info.createdAt).toBeTruthy();
      expect(info.lastAccessedAt).toBeTruthy();
    });

    it('uses custom TTL', async () => {
      const info = await manager.createSession({ ttl: 600 });

      expect(info.ttl).toBe(600);
    });

    it('creates context with proxy when provided', async () => {
      await manager.createSession({
        proxy: { server: 'http://proxy:8080', username: 'u', password: 'p' },
      });

      expect(mockNewContext).toHaveBeenCalledWith(
        expect.objectContaining({
          proxy: {
            server: 'http://proxy:8080',
            username: 'u',
            password: 'p',
          },
        })
      );
    });

    it('injects initial cookies when provided', async () => {
      await manager.createSession({
        cookies: [{ name: 'sid', value: 'abc', domain: 'example.com' }],
      });

      expect(mockContextAddCookies).toHaveBeenCalledWith([
        { name: 'sid', value: 'abc', domain: 'example.com', path: '/' },
      ]);
    });

    it('does not inject cookies when none provided', async () => {
      await manager.createSession();

      expect(mockContextAddCookies).not.toHaveBeenCalled();
    });

    it('evicts oldest session when at capacity', async () => {
      await manager.createSession();
      await manager.createSession();
      await manager.createSession();

      const info = await manager.createSession();
      expect(info.id).toBeTruthy();
    });

    it('uses custom user agent when provided', async () => {
      await manager.createSession({ userAgent: 'CustomBot/1.0' });

      expect(mockNewContext).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: 'CustomBot/1.0',
        })
      );
    });

    it('uses custom viewport when provided', async () => {
      await manager.createSession({
        viewport: { width: 1024, height: 768 },
      });

      expect(mockNewContext).toHaveBeenCalledWith(
        expect.objectContaining({
          viewport: { width: 1024, height: 768 },
        })
      );
    });
  });

  // -----------------------------------------------------------------------
  // getSession
  // -----------------------------------------------------------------------

  describe('getSession()', () => {
    it('returns session info and marks as accessed', async () => {
      const created = await manager.createSession({ name: 'test' });

      const info = await manager.getSession(created.id);

      expect(info.id).toBe(created.id);
      expect(info.status).toBe('active');
    });

    it('throws for non-existent session', async () => {
      await expect(manager.getSession('nonexistent-id')).rejects.toThrow(
        'Session not found: nonexistent-id'
      );
    });
  });

  // -----------------------------------------------------------------------
  // getSessionPage
  // -----------------------------------------------------------------------

  describe('getSessionPage()', () => {
    it('returns a page for the session', async () => {
      const created = await manager.createSession();

      const page = await manager.getSessionPage(created.id);

      expect(page).toBeDefined();
      expect(mockContextNewPage).toHaveBeenCalled();
    });

    it('reuses existing open page', async () => {
      const created = await manager.createSession();

      const page1 = await manager.getSessionPage(created.id);
      const page2 = await manager.getSessionPage(created.id);

      expect(page1).toBe(page2);
    });

    it('creates new page if existing pages are all closed', async () => {
      const created = await manager.createSession();

      await manager.getSessionPage(created.id);

      mockPageIsClosed.mockReturnValue(true);

      const newMockPage = createMockPage();
      mockContextNewPage.mockResolvedValueOnce(newMockPage);

      const page2 = await manager.getSessionPage(created.id);
      expect(page2).toBeDefined();
    });

    it('throws for non-existent session', async () => {
      await expect(
        manager.getSessionPage('nonexistent')
      ).rejects.toThrow('Session not found: nonexistent');
    });
  });

  // -----------------------------------------------------------------------
  // listSessions
  // -----------------------------------------------------------------------

  describe('listSessions()', () => {
    it('returns empty array when no sessions', () => {
      expect(manager.listSessions()).toEqual([]);
    });

    it('returns all sessions', async () => {
      await manager.createSession({ name: 'a' });
      await manager.createSession({ name: 'b' });

      const list = manager.listSessions();

      expect(list).toHaveLength(2);
      expect(list.map((s) => s.name).sort()).toEqual(['a', 'b']);
    });
  });

  // -----------------------------------------------------------------------
  // closeSession
  // -----------------------------------------------------------------------

  describe('closeSession()', () => {
    it('closes session and removes from map', async () => {
      const info = await manager.createSession({ name: 'closing' });

      await manager.closeSession(info.id);

      expect(manager.listSessions()).toHaveLength(0);
    });

    it('closes all pages before closing context', async () => {
      const info = await manager.createSession();
      await manager.getSessionPage(info.id);

      await manager.closeSession(info.id);

      expect(mockPageClose).toHaveBeenCalled();
      expect(mockContextClose).toHaveBeenCalled();
    });

    it('does not throw for unknown session', async () => {
      await expect(
        manager.closeSession('unknown-id')
      ).resolves.toBeUndefined();
    });

    it('handles page close error gracefully', async () => {
      const info = await manager.createSession();
      await manager.getSessionPage(info.id);

      mockPageClose.mockRejectedValueOnce(new Error('page gone'));

      await manager.closeSession(info.id);
    });

    it('handles context close error gracefully', async () => {
      const info = await manager.createSession();

      mockContextClose.mockRejectedValueOnce(new Error('context gone'));

      await manager.closeSession(info.id);
    });
  });

  // -----------------------------------------------------------------------
  // closeAllSessions
  // -----------------------------------------------------------------------

  describe('closeAllSessions()', () => {
    it('closes all sessions', async () => {
      await manager.createSession();
      await manager.createSession();
      expect(manager.listSessions()).toHaveLength(2);

      await manager.closeAllSessions();

      expect(manager.listSessions()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // refreshSession
  // -----------------------------------------------------------------------

  describe('refreshSession()', () => {
    it('resets the session TTL timer', async () => {
      const info = await manager.createSession();

      manager.refreshSession(info.id);

      const refreshed = await manager.getSession(info.id);
      expect(refreshed.status).toBe('active');
    });

    it('throws for non-existent session', () => {
      expect(() => manager.refreshSession('bad-id')).toThrow(
        'Session not found: bad-id'
      );
    });
  });

  // -----------------------------------------------------------------------
  // saveCookies
  // -----------------------------------------------------------------------

  describe('saveCookies()', () => {
    it('encrypts and writes cookies to disk', async () => {
      mockContextCookies.mockResolvedValueOnce([
        { name: 'sid', value: '123', domain: '.example.com' },
      ]);

      const info = await manager.createSession();
      await manager.saveCookies(info.id);

      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('does not write when there are no cookies', async () => {
      mockContextCookies.mockResolvedValueOnce([]);

      const info = await manager.createSession();
      mockWriteFile.mockClear();

      await manager.saveCookies(info.id);

      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('throws for non-existent session', async () => {
      await expect(manager.saveCookies('nope')).rejects.toThrow(
        'Session not found: nope'
      );
    });
  });

  // -----------------------------------------------------------------------
  // loadCookies
  // -----------------------------------------------------------------------

  describe('loadCookies()', () => {
    it('does nothing when no cookie file exists', async () => {
      mockExistsSync.mockReturnValue(false);

      const mockContext = {
        addCookies: vi.fn().mockResolvedValue(undefined),
      } as unknown;

      await manager.loadCookies('some-session', mockContext);

      expect(mockContext.addCookies).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // shutdown
  // -----------------------------------------------------------------------

  describe('shutdown()', () => {
    it('stops cleanup timer and closes all sessions', async () => {
      await manager.createSession();
      await manager.createSession();

      await manager.shutdown();

      expect(manager.listSessions()).toHaveLength(0);
    });

    it('can be called multiple times safely', async () => {
      await manager.shutdown();
      await manager.shutdown();
    });
  });

  // -----------------------------------------------------------------------
  // toSessionInfo (via getSession)
  // -----------------------------------------------------------------------

  describe('toSessionInfo (via getSession)', () => {
    it('includes pageCount of live pages', async () => {
      const info = await manager.createSession();
      await manager.getSessionPage(info.id);

      const session = await manager.getSession(info.id);

      expect(session.pageCount).toBe(1);
    });

    it('includes currentUrl from the last page', async () => {
      const info = await manager.createSession();
      await manager.getSessionPage(info.id);

      const session = await manager.getSession(info.id);

      expect(session.currentUrl).toBe('https://example.com');
    });

    it('handles page.url() throwing gracefully', async () => {
      const info = await manager.createSession();
      await manager.getSessionPage(info.id);

      mockPageUrl.mockImplementation(() => {
        throw new Error('page crashed');
      });

      const session = await manager.getSession(info.id);

      expect(session.currentUrl).toBeUndefined();
    });
  });
});
