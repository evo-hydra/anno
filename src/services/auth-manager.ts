/**
 * AuthManager — Credential Profile Management with Auto-Login Workflows
 *
 * Builds on top of SessionManager to provide:
 * - Encrypted credential profile storage (AES-256-GCM, same scheme as sessions)
 * - CRUD operations for auth profiles
 * - Auto-login: navigate to login page, fill credentials, verify success
 * - Cookie-based session reuse with automatic re-authentication on expiry
 *
 * Profile files are stored as `data/auth/{profileName}.profile.enc`.
 *
 * @module services/auth-manager
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync
} from 'node:crypto';
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger';
import { getSessionManager } from './session-manager';
import { interactionManager } from './interaction-manager';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthProfile {
  /** Unique identifier for this profile. */
  name: string;
  /** Target domain, e.g. "github.com". */
  domain: string;
  /** Full URL to the login page, e.g. "https://github.com/login". */
  loginUrl: string;
  /** Credentials to fill during the login flow. */
  credentials: AuthCredentials;
  /** Ordered actions to execute on the login page. */
  loginSteps: LoginStep[];
  /** CSS selector that exists on the page when the user is logged in. */
  verifySelector: string;
  /** URL pattern that indicates successful login (optional). */
  verifyUrl?: string;
  /** ISO timestamp of last successful authentication. */
  lastUsed?: string;
  /** Current status of the profile. */
  status: 'active' | 'expired' | 'error';
}

export interface AuthCredentials {
  username?: string;
  password?: string;
  /** Custom fields for non-standard forms, keyed by placeholder name. */
  fields?: Record<string, string>;
}

export interface LoginStep {
  /** Action to perform. */
  action: 'fill' | 'click' | 'wait' | 'type';
  /** CSS / Playwright selector for the target element. */
  selector: string;
  /** Value for fill/type actions. Supports {{username}}, {{password}}, and {{fieldName}} placeholders. */
  value?: string;
  /** Condition for wait steps (CSS selector or timeout in ms as string). */
  waitCondition?: string;
  /** Timeout in ms for this specific step. */
  timeout?: number;
}

export interface AuthResult {
  success: boolean;
  sessionId: string;
  profile: string;
  error?: string;
  /** Time taken for the login flow in milliseconds. */
  loginDuration: number;
}

// ---------------------------------------------------------------------------
// Internal: stored profile (credentials are encrypted on disk)
// ---------------------------------------------------------------------------

interface StoredProfile {
  name: string;
  domain: string;
  loginUrl: string;
  credentials: AuthCredentials; // plaintext in memory, encrypted on disk
  loginSteps: LoginStep[];
  verifySelector: string;
  verifyUrl?: string;
  lastUsed?: string;
  status: 'active' | 'expired' | 'error';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_DATA_DIR = join(__dirname, '..', '..', 'data', 'auth');
const AUTH_KEY_FILE = join(AUTH_DATA_DIR, '.auth-key');
const PROFILE_SUFFIX = '.profile.enc';

// Encryption constants — identical to session-manager
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

// Login defaults
const DEFAULT_STEP_TIMEOUT = 30_000;
const DEFAULT_VERIFY_TIMEOUT = 15_000;
const DEFAULT_SESSION_TTL = 3600; // 1 hour for auth sessions

// ---------------------------------------------------------------------------
// AuthManager
// ---------------------------------------------------------------------------

export class AuthManager {
  private encryptionKey: Buffer | null = null;
  private initialised = false;

  // -----------------------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------------------

  /**
   * Ensure the auth data directory exists and load (or generate) the
   * encryption key. Must be called before any profile operations.
   */
  async init(): Promise<void> {
    if (this.initialised) return;

    await this.ensureDataDir();
    await this.loadOrCreateEncryptionKey();
    this.initialised = true;

    logger.info('AuthManager initialised', { dataDir: AUTH_DATA_DIR });
  }

  // -----------------------------------------------------------------------
  // Profile CRUD
  // -----------------------------------------------------------------------

  /**
   * Create and persist a new auth profile.
   * Throws if a profile with the same name already exists.
   */
  async createProfile(profile: AuthProfile): Promise<AuthProfile> {
    await this.ensureInit();

    if (!profile.name || typeof profile.name !== 'string') {
      throw new Error('Profile name must be a non-empty string');
    }
    if (!profile.loginUrl || typeof profile.loginUrl !== 'string') {
      throw new Error('Profile loginUrl must be a non-empty string');
    }
    if (!profile.verifySelector || typeof profile.verifySelector !== 'string') {
      throw new Error('Profile verifySelector must be a non-empty string');
    }

    const filePath = this.profileFilePath(profile.name);
    if (existsSync(filePath)) {
      throw new Error(`Profile already exists: ${profile.name}`);
    }

    const stored: StoredProfile = {
      name: profile.name,
      domain: profile.domain,
      loginUrl: profile.loginUrl,
      credentials: profile.credentials,
      loginSteps: profile.loginSteps,
      verifySelector: profile.verifySelector,
      verifyUrl: profile.verifyUrl,
      lastUsed: profile.lastUsed,
      status: profile.status ?? 'active',
    };

    await this.saveProfileToDisk(stored);

    logger.info('auth:createProfile', { name: profile.name, domain: profile.domain });
    return this.toAuthProfile(stored);
  }

  /**
   * Retrieve a profile by name with credentials decrypted.
   */
  async getProfile(name: string): Promise<AuthProfile> {
    await this.ensureInit();

    const stored = await this.loadProfileFromDisk(name);
    return this.toAuthProfile(stored);
  }

  /**
   * List all stored profiles. Credentials are masked in the output.
   */
  async listProfiles(): Promise<AuthProfile[]> {
    await this.ensureInit();
    await this.ensureDataDir();

    const files = await readdir(AUTH_DATA_DIR);
    const profileFiles = files.filter((f) => f.endsWith(PROFILE_SUFFIX));

    const profiles: AuthProfile[] = [];

    for (const file of profileFiles) {
      const name = file.slice(0, -PROFILE_SUFFIX.length);
      try {
        const stored = await this.loadProfileFromDisk(name);
        profiles.push(this.toAuthProfile(stored, true /* mask credentials */));
      } catch (err) {
        logger.warn('auth:listProfiles failed to load profile', {
          file,
          error: (err as Error).message,
        });
      }
    }

    logger.debug('auth:listProfiles', { count: profiles.length });
    return profiles;
  }

  /**
   * Update fields on an existing profile. Merges provided updates with
   * the existing profile data.
   */
  async updateProfile(
    name: string,
    updates: Partial<Omit<AuthProfile, 'name'>>
  ): Promise<AuthProfile> {
    await this.ensureInit();

    const existing = await this.loadProfileFromDisk(name);

    const updated: StoredProfile = {
      ...existing,
      ...updates,
      name: existing.name, // name is immutable
      credentials: updates.credentials
        ? { ...existing.credentials, ...updates.credentials }
        : existing.credentials,
      loginSteps: updates.loginSteps ?? existing.loginSteps,
    };

    await this.saveProfileToDisk(updated);

    logger.info('auth:updateProfile', { name, updatedFields: Object.keys(updates) });
    return this.toAuthProfile(updated);
  }

  /**
   * Delete a profile from disk.
   */
  async deleteProfile(name: string): Promise<void> {
    await this.ensureInit();

    const filePath = this.profileFilePath(name);
    if (!existsSync(filePath)) {
      throw new Error(`Profile not found: ${name}`);
    }

    await unlink(filePath);
    logger.info('auth:deleteProfile', { name });
  }

  // -----------------------------------------------------------------------
  // Auto-login
  // -----------------------------------------------------------------------

  /**
   * Execute the full login workflow for a profile:
   * 1. Create or reuse a browser session
   * 2. Try loading existing cookies — skip login if already authenticated
   * 3. Navigate to loginUrl
   * 4. Execute loginSteps (fill, click, type, wait)
   * 5. Verify login via verifySelector
   * 6. Save cookies for future reuse
   *
   * Returns an AuthResult indicating success/failure and the session ID.
   */
  async login(profileName: string, sessionId?: string): Promise<AuthResult> {
    await this.ensureInit();
    const startTime = Date.now();

    const stored = await this.loadProfileFromDisk(profileName);
    const sessionManager = await getSessionManager();

    let sid: string;

    try {
      // Reuse existing session or create a new one
      if (sessionId) {
        // Verify the session exists
        await sessionManager.getSession(sessionId);
        sid = sessionId;
        logger.debug('auth:login reusing session', { sessionId: sid, profile: profileName });
      } else {
        const sessionInfo = await sessionManager.createSession({
          name: `auth:${profileName}`,
          ttl: DEFAULT_SESSION_TTL,
        });
        sid = sessionInfo.id;
        logger.debug('auth:login created session', { sessionId: sid, profile: profileName });
      }

      const page = await sessionManager.getSessionPage(sid);

      // Check if already authenticated via cookies
      const alreadyAuthenticated = await this.checkAuthentication(
        page,
        stored.verifySelector,
        stored.verifyUrl,
        stored.loginUrl
      );

      if (alreadyAuthenticated) {
        logger.info('auth:login already authenticated via cookies', {
          profile: profileName,
          sessionId: sid,
        });

        // Update lastUsed
        stored.lastUsed = new Date().toISOString();
        stored.status = 'active';
        await this.saveProfileToDisk(stored);

        return {
          success: true,
          sessionId: sid,
          profile: profileName,
          loginDuration: Date.now() - startTime,
        };
      }

      // Navigate to login page
      logger.info('auth:login navigating to login page', {
        profile: profileName,
        loginUrl: stored.loginUrl,
      });

      await page.goto(stored.loginUrl, { waitUntil: 'domcontentloaded' });

      // Execute login steps
      await this.executeLoginSteps(stored.loginSteps, stored.credentials, page);

      // Verify login was successful
      const verified = await this.verifyLogin(page, stored.verifySelector, stored.verifyUrl);

      if (!verified) {
        stored.status = 'error';
        await this.saveProfileToDisk(stored);

        logger.warn('auth:login verification failed', {
          profile: profileName,
          verifySelector: stored.verifySelector,
        });

        return {
          success: false,
          sessionId: sid,
          profile: profileName,
          error: `Login verification failed: selector "${stored.verifySelector}" not found after login`,
          loginDuration: Date.now() - startTime,
        };
      }

      // Save cookies for future reuse
      await sessionManager.saveCookies(sid);

      // Update profile status and lastUsed
      stored.lastUsed = new Date().toISOString();
      stored.status = 'active';
      await this.saveProfileToDisk(stored);

      logger.info('auth:login succeeded', {
        profile: profileName,
        sessionId: sid,
        duration: Date.now() - startTime,
      });

      return {
        success: true,
        sessionId: sid,
        profile: profileName,
        loginDuration: Date.now() - startTime,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Update profile status on error
      try {
        stored.status = 'error';
        await this.saveProfileToDisk(stored);
      } catch {
        // Best-effort status update
      }

      logger.error('auth:login failed', {
        profile: profileName,
        error: errorMsg,
      });

      return {
        success: false,
        sessionId: sessionId ?? '',
        profile: profileName,
        error: errorMsg,
        loginDuration: Date.now() - startTime,
      };
    }
  }

  /**
   * Check whether a session is still authenticated by navigating to a
   * relevant page and looking for the verify selector.
   */
  async isAuthenticated(sessionId: string, verifySelector: string): Promise<boolean> {
    try {
      const sessionManager = await getSessionManager();
      const page = await sessionManager.getSessionPage(sessionId);

      const element = await page.$(verifySelector);
      if (element) {
        return true;
      }

      // Element not found on the current page — could be on a different page.
      // We do a lightweight check without navigation.
      return false;
    } catch (err) {
      logger.debug('auth:isAuthenticated check failed', {
        sessionId,
        error: (err as Error).message,
      });
      return false;
    }
  }

  /**
   * Re-authenticate a session if it has expired. Loads the profile and
   * re-runs the login workflow on the given session.
   */
  async refreshAuth(profileName: string, sessionId: string): Promise<AuthResult> {
    await this.ensureInit();

    const stored = await this.loadProfileFromDisk(profileName);

    // Check if still authenticated
    const authenticated = await this.isAuthenticated(sessionId, stored.verifySelector);
    if (authenticated) {
      logger.info('auth:refreshAuth session still authenticated', {
        profile: profileName,
        sessionId,
      });

      return {
        success: true,
        sessionId,
        profile: profileName,
        loginDuration: 0,
      };
    }

    // Re-login using the same session
    logger.info('auth:refreshAuth re-authenticating', {
      profile: profileName,
      sessionId,
    });

    return this.login(profileName, sessionId);
  }

  // -----------------------------------------------------------------------
  // Private: Login Step Execution
  // -----------------------------------------------------------------------

  /**
   * Execute the ordered login steps, substituting credential placeholders.
   */
  private async executeLoginSteps(
    steps: LoginStep[],
    credentials: AuthCredentials,
    page: import('playwright-core').Page
  ): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const timeout = step.timeout ?? DEFAULT_STEP_TIMEOUT;

      logger.debug('auth:executeLoginStep', {
        index: i,
        action: step.action,
        selector: step.selector,
      });

      try {
        switch (step.action) {
          case 'fill': {
            const value = this.interpolateCredentials(step.value ?? '', credentials);
            await interactionManager.fill(page, step.selector, value, { timeout });
            break;
          }

          case 'type': {
            const value = this.interpolateCredentials(step.value ?? '', credentials);
            await interactionManager.type(page, step.selector, value, {
              timeout,
              delay: 50,
            });
            break;
          }

          case 'click': {
            await interactionManager.click(page, step.selector, { timeout });
            break;
          }

          case 'wait': {
            if (step.waitCondition) {
              // If the waitCondition looks like a number, treat as timeout
              const num = Number(step.waitCondition);
              if (!isNaN(num)) {
                await interactionManager.waitFor(
                  page,
                  { kind: 'timeout', ms: num },
                  { timeout }
                );
              } else {
                // Treat as a CSS selector to wait for
                await interactionManager.waitFor(
                  page,
                  { kind: 'selector', selector: step.waitCondition },
                  { timeout }
                );
              }
            } else {
              // Default: wait for the step's selector to appear
              await interactionManager.waitFor(
                page,
                { kind: 'selector', selector: step.selector },
                { timeout }
              );
            }
            break;
          }

          default:
            throw new Error(`Unknown login step action: ${step.action}`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Login step ${i} (${step.action} on "${step.selector}") failed: ${errMsg}`
        );
      }
    }
  }

  /**
   * Replace {{username}}, {{password}}, and {{fieldName}} placeholders
   * in a step value string with actual credentials.
   */
  private interpolateCredentials(template: string, credentials: AuthCredentials): string {
    let result = template;

    if (credentials.username !== undefined) {
      result = result.replace(/\{\{username\}\}/g, credentials.username);
    }
    if (credentials.password !== undefined) {
      result = result.replace(/\{\{password\}\}/g, credentials.password);
    }

    // Replace custom field placeholders
    if (credentials.fields) {
      for (const [key, value] of Object.entries(credentials.fields)) {
        const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
        result = result.replace(pattern, value);
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Private: Authentication Verification
  // -----------------------------------------------------------------------

  /**
   * Check if a page is already showing authenticated state.
   * Navigates to the login URL first to ensure we're on the right domain,
   * then checks for the verifySelector.
   */
  private async checkAuthentication(
    page: import('playwright-core').Page,
    verifySelector: string,
    verifyUrl?: string,
    loginUrl?: string
  ): Promise<boolean> {
    try {
      const currentUrl = page.url();

      // If we're on about:blank or no page loaded yet, navigate to login URL
      // to let cookies take effect
      if (currentUrl === 'about:blank' && loginUrl) {
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
      }

      // Check if URL matches the verify pattern (redirect after cookie auth)
      if (verifyUrl) {
        const pageUrl = page.url();
        if (pageUrl.includes(verifyUrl)) {
          return true;
        }
      }

      // Check if the verify selector exists on the page
      const element = await page.$(verifySelector);
      return element !== null;
    } catch {
      return false;
    }
  }

  /**
   * After login steps are executed, verify that login was successful.
   * Waits for the verifySelector to appear with a timeout.
   */
  private async verifyLogin(
    page: import('playwright-core').Page,
    verifySelector: string,
    verifyUrl?: string
  ): Promise<boolean> {
    try {
      // Wait for either the selector to appear or a URL change
      await page.waitForSelector(verifySelector, {
        state: 'visible',
        timeout: DEFAULT_VERIFY_TIMEOUT,
      });
      return true;
    } catch {
      // Selector didn't appear — check URL as fallback
      if (verifyUrl) {
        const currentUrl = page.url();
        if (currentUrl.includes(verifyUrl)) {
          return true;
        }
      }
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Private: Encryption (same AES-256-GCM scheme as SessionManager)
  // -----------------------------------------------------------------------

  private encrypt(plaintext: string, key: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
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
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Load the auth encryption key from disk, or generate + persist a new one.
   * Uses the same [salt | derived-key] format as session-manager.
   */
  private async loadOrCreateEncryptionKey(): Promise<void> {
    await this.ensureDataDir();

    if (existsSync(AUTH_KEY_FILE)) {
      const raw = await readFile(AUTH_KEY_FILE);
      // Key file stores: [salt (32)] [derived-key (32)]
      if (raw.length === SALT_LENGTH + KEY_LENGTH) {
        this.encryptionKey = raw.subarray(SALT_LENGTH, SALT_LENGTH + KEY_LENGTH);
        logger.debug('auth encryption key loaded from disk');
        return;
      }
      logger.warn('auth encryption key file invalid, regenerating');
    }

    // Generate fresh key material
    const salt = randomBytes(SALT_LENGTH);
    const secret = randomBytes(64);
    const derived = scryptSync(secret, salt, KEY_LENGTH);
    this.encryptionKey = derived as Buffer;

    await writeFile(AUTH_KEY_FILE, Buffer.concat([salt, derived]));
    logger.info('new auth encryption key generated and stored');
  }

  private async getEncryptionKey(): Promise<Buffer> {
    if (!this.encryptionKey) {
      await this.loadOrCreateEncryptionKey();
    }
    return this.encryptionKey!;
  }

  // -----------------------------------------------------------------------
  // Private: Profile Persistence
  // -----------------------------------------------------------------------

  /**
   * Serialize and encrypt a profile, then write to disk.
   */
  private async saveProfileToDisk(profile: StoredProfile): Promise<void> {
    const key = await this.getEncryptionKey();
    const plaintext = JSON.stringify(profile);
    const encrypted = this.encrypt(plaintext, key);

    await this.ensureDataDir();
    const filePath = this.profileFilePath(profile.name);
    await writeFile(filePath, encrypted);

    logger.debug('auth:saveProfileToDisk', { name: profile.name, path: filePath });
  }

  /**
   * Read an encrypted profile from disk and decrypt it.
   */
  private async loadProfileFromDisk(name: string): Promise<StoredProfile> {
    const filePath = this.profileFilePath(name);

    if (!existsSync(filePath)) {
      throw new Error(`Profile not found: ${name}`);
    }

    const key = await this.getEncryptionKey();
    const encrypted = await readFile(filePath);
    const plaintext = this.decrypt(encrypted, key);
    const profile: StoredProfile = JSON.parse(plaintext);

    logger.debug('auth:loadProfileFromDisk', { name });
    return profile;
  }

  // -----------------------------------------------------------------------
  // Private: Helpers
  // -----------------------------------------------------------------------

  private profileFilePath(name: string): string {
    // Sanitize profile name for use as filename
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(AUTH_DATA_DIR, `${safeName}${PROFILE_SUFFIX}`);
  }

  private async ensureDataDir(): Promise<void> {
    if (!existsSync(AUTH_DATA_DIR)) {
      await mkdir(AUTH_DATA_DIR, { recursive: true });
    }
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialised) {
      await this.init();
    }
  }

  /**
   * Convert an internal StoredProfile to the public AuthProfile type.
   * When maskCredentials is true, sensitive values are replaced with asterisks.
   */
  private toAuthProfile(stored: StoredProfile, maskCredentials = false): AuthProfile {
    const credentials: AuthCredentials = maskCredentials
      ? {
          username: stored.credentials.username ? '****' : undefined,
          password: stored.credentials.password ? '****' : undefined,
          fields: stored.credentials.fields
            ? Object.fromEntries(
                Object.keys(stored.credentials.fields).map((k) => [k, '****'])
              )
            : undefined,
        }
      : { ...stored.credentials };

    return {
      name: stored.name,
      domain: stored.domain,
      loginUrl: stored.loginUrl,
      credentials,
      loginSteps: stored.loginSteps,
      verifySelector: stored.verifySelector,
      verifyUrl: stored.verifyUrl,
      lastUsed: stored.lastUsed,
      status: stored.status,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let instance: AuthManager | null = null;

/**
 * Return the singleton AuthManager instance. The instance is lazily
 * created and initialised on first call.
 */
export async function getAuthManager(): Promise<AuthManager> {
  if (!instance) {
    instance = new AuthManager();
    await instance.init();
  }
  return instance;
}
