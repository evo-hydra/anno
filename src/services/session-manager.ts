/**
 * Session Manager — Persistent Browser Sessions with Cookie Persistence
 *
 * Manages long-lived Playwright browser contexts with:
 * - UUID-based session identification
 * - AES-256-GCM encrypted cookie persistence to disk
 * - TTL-based auto-expiry with configurable timeouts
 * - LRU eviction when max concurrent session limit is reached
 * - Graceful shutdown with cookie save on process exit
 *
 * @module services/session-manager
 */

import {
  type Browser,
  type BrowserContext,
  type Page
} from 'playwright-core';
import {
  randomUUID,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync
} from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger';
import { rendererManager } from './renderer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionOptions {
  name?: string;
  ttl?: number; // seconds, default 1800 (30 min)
  userAgent?: string;
  viewport?: { width: number; height: number };
  proxy?: { server: string; username?: string; password?: string };
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path?: string;
  }>;
}

export interface SessionInfo {
  id: string;
  name?: string;
  status: 'active' | 'idle' | 'expired';
  createdAt: string; // ISO timestamp
  lastAccessedAt: string; // ISO timestamp
  ttl: number; // seconds
  currentUrl?: string;
  pageCount: number;
}

// ---------------------------------------------------------------------------
// Internal session record
// ---------------------------------------------------------------------------

interface SessionRecord {
  id: string;
  name?: string;
  context: BrowserContext;
  pages: Page[];
  createdAt: Date;
  lastAccessedAt: Date;
  ttl: number; // seconds
  status: 'active' | 'idle' | 'expired';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 1800; // 30 minutes
const DEFAULT_MAX_SESSIONS = 5;
const CLEANUP_INTERVAL_MS = 60_000; // 60 seconds
const SESSION_DATA_DIR = join(__dirname, '..', '..', 'data', 'sessions');
const SESSION_KEY_FILE = join(SESSION_DATA_DIR, '.session-key');

// Encryption constants
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private sessions: Map<string, SessionRecord> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private encryptionKey: Buffer | null = null;
  private maxSessions: number;
  private shutdownRegistered = false;

  constructor(maxSessions: number = DEFAULT_MAX_SESSIONS) {
    this.maxSessions = maxSessions;
  }

  // -----------------------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------------------

  /**
   * Ensure data directory exists and load (or generate) the encryption key.
   * Must be called before any cookie persistence operations.
   */
  async init(): Promise<void> {
    await this.ensureDataDir();
    await this.loadOrCreateEncryptionKey();
    this.startCleanupTimer();
    this.registerShutdownHooks();
    logger.info('SessionManager initialised', {
      maxSessions: this.maxSessions,
      dataDir: SESSION_DATA_DIR
    });
  }

  // -----------------------------------------------------------------------
  // Session CRUD
  // -----------------------------------------------------------------------

  /**
   * Create a new persistent browser session.
   */
  async createSession(options?: SessionOptions): Promise<SessionInfo> {
    // Evict oldest idle session if at capacity
    if (this.sessions.size >= this.maxSessions) {
      await this.evictOldestIdle();
    }

    // If still at capacity after eviction attempt, reject
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `Maximum concurrent sessions reached (${this.maxSessions}). Close a session first.`
      );
    }

    const id = randomUUID();
    const ttl = options?.ttl ?? DEFAULT_TTL_SECONDS;
    const now = new Date();

    // Obtain browser from shared renderer
    const browser: Browser = await rendererManager.getBrowser();

    // Build context options
    const contextOptions: Parameters<Browser['newContext']>[0] = {
      userAgent:
        options?.userAgent ??
        this.randomUserAgent(),
      viewport: options?.viewport ?? {
        width: 1920 + Math.floor(Math.random() * 200 - 100),
        height: 1080 + Math.floor(Math.random() * 200 - 100)
      },
      locale: 'en-US',
      timezoneId: 'America/New_York'
    };

    if (options?.proxy) {
      contextOptions.proxy = {
        server: options.proxy.server,
        username: options.proxy.username,
        password: options.proxy.password
      };
    }

    const context = await browser.newContext(contextOptions);

    // Restore cookies from previous encrypted file if it exists
    const cookieFile = this.cookieFilePath(id);
    if (existsSync(cookieFile)) {
      await this.loadCookies(id, context);
    }

    // Inject initial cookies from options
    if (options?.cookies && options.cookies.length > 0) {
      const playwrightCookies = options.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path ?? '/'
      }));
      await context.addCookies(playwrightCookies);
      logger.debug('injected initial cookies', {
        sessionId: id,
        count: options.cookies.length
      });
    }

    const record: SessionRecord = {
      id,
      name: options?.name,
      context,
      pages: [],
      createdAt: now,
      lastAccessedAt: now,
      ttl,
      status: 'active'
    };

    this.sessions.set(id, record);

    logger.info('session created', {
      sessionId: id,
      name: options?.name,
      ttl,
      activeSessions: this.sessions.size
    });

    return this.toSessionInfo(record);
  }

  /**
   * Retrieve session metadata and mark as accessed.
   */
  async getSession(sessionId: string): Promise<SessionInfo> {
    const record = this.requireSession(sessionId);
    record.lastAccessedAt = new Date();
    record.status = 'active';
    return this.toSessionInfo(record);
  }

  /**
   * Get (or create) a Page inside the session's browser context.
   */
  async getSessionPage(sessionId: string): Promise<Page> {
    const record = this.requireSession(sessionId);
    record.lastAccessedAt = new Date();
    record.status = 'active';

    // Return existing page if one is open, otherwise create
    if (record.pages.length > 0) {
      const existingPage = record.pages[record.pages.length - 1];
      if (!existingPage.isClosed()) {
        return existingPage;
      }
      // Remove closed pages
      record.pages = record.pages.filter((p) => !p.isClosed());
    }

    const page = await record.context.newPage();
    record.pages.push(page);

    logger.debug('session page created', {
      sessionId,
      pageCount: record.pages.filter((p) => !p.isClosed()).length
    });

    return page;
  }

  /**
   * Return metadata for all active sessions (no browser objects).
   */
  listSessions(): SessionInfo[] {
    const infos: SessionInfo[] = [];
    for (const record of this.sessions.values()) {
      infos.push(this.toSessionInfo(record));
    }
    return infos;
  }

  // -----------------------------------------------------------------------
  // Session lifecycle
  // -----------------------------------------------------------------------

  /**
   * Close a session: save cookies, close context, remove from map.
   */
  async closeSession(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      logger.warn('close requested for unknown session', { sessionId });
      return;
    }

    logger.info('closing session', {
      sessionId,
      name: record.name,
      ageSeconds: Math.round(
        (Date.now() - record.createdAt.getTime()) / 1000
      )
    });

    // Save cookies before closing
    try {
      await this.saveCookies(sessionId);
    } catch (err) {
      logger.error('failed to save cookies on close', {
        sessionId,
        error: (err as Error).message
      });
    }

    // Close all pages
    for (const page of record.pages) {
      if (!page.isClosed()) {
        await page.close().catch(() => {});
      }
    }

    // Close browser context
    try {
      await record.context.close();
    } catch (err) {
      logger.error('failed to close browser context', {
        sessionId,
        error: (err as Error).message
      });
    }

    record.status = 'expired';
    this.sessions.delete(sessionId);

    logger.info('session closed', {
      sessionId,
      activeSessions: this.sessions.size
    });
  }

  /**
   * Close every active session, saving cookies for each.
   */
  async closeAllSessions(): Promise<void> {
    logger.info('closing all sessions', { count: this.sessions.size });
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.closeSession(id)));
  }

  /**
   * Reset a session's TTL timer.
   */
  refreshSession(sessionId: string): void {
    const record = this.requireSession(sessionId);
    record.lastAccessedAt = new Date();
    record.status = 'active';
    logger.debug('session refreshed', { sessionId });
  }

  // -----------------------------------------------------------------------
  // Cookie persistence (AES-256-GCM encrypted)
  // -----------------------------------------------------------------------

  /**
   * Extract cookies from the session's browser context, encrypt, and write
   * to disk as `{sessionId}.cookies.enc`.
   */
  async saveCookies(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const key = await this.getEncryptionKey();
    const cookies = await record.context.cookies();

    if (cookies.length === 0) {
      logger.debug('no cookies to save', { sessionId });
      return;
    }

    const plaintext = JSON.stringify(cookies);
    const encrypted = this.encrypt(plaintext, key);

    await this.ensureDataDir();
    const filePath = this.cookieFilePath(sessionId);
    await writeFile(filePath, encrypted);

    logger.debug('cookies saved', {
      sessionId,
      count: cookies.length,
      path: filePath
    });
  }

  /**
   * Load encrypted cookies from disk and inject into the given browser context.
   */
  async loadCookies(
    sessionId: string,
    context: BrowserContext
  ): Promise<void> {
    const filePath = this.cookieFilePath(sessionId);

    if (!existsSync(filePath)) {
      logger.debug('no cookie file found', { sessionId, path: filePath });
      return;
    }

    const key = await this.getEncryptionKey();
    const encrypted = await readFile(filePath);
    const plaintext = this.decrypt(encrypted, key);
    const cookies = JSON.parse(plaintext);

    await context.addCookies(cookies);

    logger.debug('cookies loaded', {
      sessionId,
      count: cookies.length
    });
  }

  // -----------------------------------------------------------------------
  // Encryption helpers
  // -----------------------------------------------------------------------

  private encrypt(plaintext: string, key: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    // Layout: [iv (16)] [authTag (16)] [ciphertext (...)]
    return Buffer.concat([iv, authTag, encrypted]);
  }

  private decrypt(data: Buffer, key: Buffer): string {
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Load the encryption key from disk, or generate + persist a new one.
   */
  private async loadOrCreateEncryptionKey(): Promise<void> {
    await this.ensureDataDir();

    if (existsSync(SESSION_KEY_FILE)) {
      const raw = await readFile(SESSION_KEY_FILE);
      // The key file stores: [salt (32)] [derived-key (32)]
      if (raw.length === SALT_LENGTH + KEY_LENGTH) {
        this.encryptionKey = raw.subarray(SALT_LENGTH, SALT_LENGTH + KEY_LENGTH);
        logger.debug('encryption key loaded from disk');
        return;
      }
      // If the file is corrupt or wrong length, regenerate
      logger.warn('encryption key file invalid, regenerating');
    }

    // Generate fresh key material
    const salt = randomBytes(SALT_LENGTH);
    const secret = randomBytes(64); // random master secret
    const derived = scryptSync(secret, salt, KEY_LENGTH);
    this.encryptionKey = derived as Buffer;

    // Persist [salt | derived-key] so we can decrypt later
    await writeFile(SESSION_KEY_FILE, Buffer.concat([salt, derived]));
    logger.info('new encryption key generated and stored');
  }

  private async getEncryptionKey(): Promise<Buffer> {
    if (!this.encryptionKey) {
      await this.loadOrCreateEncryptionKey();
    }
    return this.encryptionKey!;
  }

  // -----------------------------------------------------------------------
  // Auto-expiry & LRU eviction
  // -----------------------------------------------------------------------

  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions().catch((err) => {
        logger.error('session cleanup error', {
          error: (err as Error).message
        });
      });
    }, CLEANUP_INTERVAL_MS);

    // Allow the process to exit even if the timer is still active
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Scan sessions and close any that have exceeded their TTL.
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, record] of this.sessions.entries()) {
      const elapsedSinceAccess =
        (now - record.lastAccessedAt.getTime()) / 1000;

      if (elapsedSinceAccess >= record.ttl) {
        record.status = 'expired';
        expiredIds.push(id);
      } else if (elapsedSinceAccess >= record.ttl / 2) {
        // Mark as idle when past half the TTL without access
        record.status = 'idle';
      }
    }

    if (expiredIds.length > 0) {
      logger.info('expiring sessions', {
        count: expiredIds.length,
        ids: expiredIds
      });
      await Promise.all(expiredIds.map((id) => this.closeSession(id)));
    }
  }

  /**
   * Evict the oldest idle session (LRU). If no idle session, evict the
   * overall least-recently-accessed session.
   */
  private async evictOldestIdle(): Promise<void> {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    // Prefer idle sessions
    for (const [id, record] of this.sessions.entries()) {
      if (
        record.status === 'idle' &&
        record.lastAccessedAt.getTime() < oldestTime
      ) {
        oldestTime = record.lastAccessedAt.getTime();
        oldestId = id;
      }
    }

    // Fall back to any session if none are idle
    if (!oldestId) {
      for (const [id, record] of this.sessions.entries()) {
        if (record.lastAccessedAt.getTime() < oldestTime) {
          oldestTime = record.lastAccessedAt.getTime();
          oldestId = id;
        }
      }
    }

    if (oldestId) {
      logger.info('evicting session (LRU)', { sessionId: oldestId });
      await this.closeSession(oldestId);
    }
  }

  // -----------------------------------------------------------------------
  // Graceful shutdown
  // -----------------------------------------------------------------------

  private registerShutdownHooks(): void {
    if (this.shutdownRegistered) {
      return;
    }

    const shutdown = async () => {
      logger.info('SessionManager: graceful shutdown triggered');
      this.stopCleanupTimer();
      await this.closeAllSessions();
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.once('beforeExit', shutdown);

    this.shutdownRegistered = true;
  }

  /**
   * Explicit shutdown — call from the application shutdown handler.
   */
  async shutdown(): Promise<void> {
    this.stopCleanupTimer();
    await this.closeAllSessions();
    logger.info('SessionManager shut down');
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return record;
  }

  private toSessionInfo(record: SessionRecord): SessionInfo {
    const livePages = record.pages.filter((p) => !p.isClosed());

    // Try to get the current URL from the most recent page
    let currentUrl: string | undefined;
    if (livePages.length > 0) {
      try {
        currentUrl = livePages[livePages.length - 1].url();
      } catch {
        // Page may be in a bad state; swallow
      }
    }

    return {
      id: record.id,
      name: record.name,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      lastAccessedAt: record.lastAccessedAt.toISOString(),
      ttl: record.ttl,
      currentUrl,
      pageCount: livePages.length
    };
  }

  private cookieFilePath(sessionId: string): string {
    return join(SESSION_DATA_DIR, `${sessionId}.cookies.enc`);
  }

  private async ensureDataDir(): Promise<void> {
    if (!existsSync(SESSION_DATA_DIR)) {
      await mkdir(SESSION_DATA_DIR, { recursive: true });
    }
  }

  private randomUserAgent(): string {
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    ];
    return agents[Math.floor(Math.random() * agents.length)];
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let instance: SessionManager | null = null;

/**
 * Return the singleton SessionManager instance. The instance is lazily
 * created and initialised on first call.
 */
export async function getSessionManager(): Promise<SessionManager> {
  if (!instance) {
    instance = new SessionManager();
    await instance.init();
  }
  return instance;
}
