import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockMkdir,
  mockWriteFile,
  mockReadFile,
  mockReaddir,
  mockUnlink,
  mockExistsSync,
  mockPageGoto,
  mockPageWaitForSelector,
  mockPageUrl,
  mockPage$,
  _mockPage,
  mockGetSession,
  mockCreateSession,
  mockGetSessionPage,
  mockSaveCookies,
  mockSessionManager,
  mockInteractionFill,
  mockInteractionType,
  mockInteractionClick,
  mockInteractionWaitFor,
} = vi.hoisted(() => {
  const mockPageGoto = vi.fn().mockResolvedValue(undefined);
  const mockPageWaitForSelector = vi.fn().mockResolvedValue(undefined);
  const mockPageUrl = vi.fn().mockReturnValue('https://example.com/dashboard');
  const mockPage$ = vi.fn().mockResolvedValue(null);

  const mockPage = {
    goto: mockPageGoto,
    waitForSelector: mockPageWaitForSelector,
    url: mockPageUrl,
    $: mockPage$,
  };

  const mockGetSession = vi.fn().mockResolvedValue({ id: 'existing-session' });
  const mockCreateSession = vi.fn().mockResolvedValue({ id: 'new-session-id' });
  const mockGetSessionPage = vi.fn().mockResolvedValue(mockPage);
  const mockSaveCookies = vi.fn().mockResolvedValue(undefined);

  const mockSessionManager = {
    getSession: mockGetSession,
    createSession: mockCreateSession,
    getSessionPage: mockGetSessionPage,
    saveCookies: mockSaveCookies,
  };

  return {
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    mockReadFile: vi.fn().mockResolvedValue(Buffer.alloc(64)),
    mockReaddir: vi.fn().mockResolvedValue([]),
    mockUnlink: vi.fn().mockResolvedValue(undefined),
    mockExistsSync: vi.fn().mockReturnValue(false),
    mockPageGoto,
    mockPageWaitForSelector,
    mockPageUrl,
    mockPage$,
    _mockPage: mockPage,
    mockGetSession,
    mockCreateSession,
    mockGetSessionPage,
    mockSaveCookies,
    mockSessionManager,
    mockInteractionFill: vi.fn().mockResolvedValue(undefined),
    mockInteractionType: vi.fn().mockResolvedValue(undefined),
    mockInteractionClick: vi.fn().mockResolvedValue(undefined),
    mockInteractionWaitFor: vi.fn().mockResolvedValue(undefined),
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
  readdir: (...args: unknown[]) => mockReaddir(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

// ---------------------------------------------------------------------------
// Mock session-manager and interaction-manager
// ---------------------------------------------------------------------------

vi.mock('../services/session-manager', () => ({
  getSessionManager: vi.fn().mockResolvedValue(mockSessionManager),
}));

vi.mock('../services/interaction-manager', () => ({
  interactionManager: {
    fill: (...args: unknown[]) => mockInteractionFill(...args),
    type: (...args: unknown[]) => mockInteractionType(...args),
    click: (...args: unknown[]) => mockInteractionClick(...args),
    waitFor: (...args: unknown[]) => mockInteractionWaitFor(...args),
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { AuthManager } from '../services/auth-manager';
import type { AuthProfile } from '../services/auth-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return {
    name: 'test-profile',
    domain: 'example.com',
    loginUrl: 'https://example.com/login',
    credentials: {
      username: 'testuser',
      password: 'testpass',
    },
    loginSteps: [
      { action: 'fill', selector: '#username', value: '{{username}}' },
      { action: 'fill', selector: '#password', value: '{{password}}' },
      { action: 'click', selector: '#submit' },
    ],
    verifySelector: '.user-avatar',
    status: 'active',
    ...overrides,
  };
}

/**
 * Helper: create a profile then switch existsSync to true so subsequent
 * disk reads find the file. The AuthManager uses existsSync to check if
 * a profile file exists before loading/creating.
 */
async function createAndPersist(
  manager: AuthManager,
  profile: AuthProfile
): Promise<AuthProfile> {
  // existsSync must return false so createProfile doesn't think it already exists
  mockExistsSync.mockReturnValue(false);
  const result = await manager.createProfile(profile);
  // After creation the file is in our in-memory store — allow reads now
  mockExistsSync.mockReturnValue(true);
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthManager', () => {
  let manager: AuthManager;
  let fileStore: Map<string, Buffer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    fileStore = new Map();

    mockExistsSync.mockReturnValue(false);

    mockWriteFile.mockImplementation(async (path: string, data: Buffer) => {
      fileStore.set(path, Buffer.isBuffer(data) ? data : Buffer.from(data as string));
    });

    mockReadFile.mockImplementation(async (path: string) => {
      const data = fileStore.get(path);
      if (!data) throw new Error(`ENOENT: no such file: ${path}`);
      return data;
    });

    manager = new AuthManager();
    await manager.init();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // init
  // -----------------------------------------------------------------------

  describe('init()', () => {
    it('creates data directory if it does not exist', () => {
      expect(mockMkdir).toHaveBeenCalled();
    });

    it('generates an encryption key', () => {
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('does not re-init if already initialised', async () => {
      const callCount = mockMkdir.mock.calls.length;
      await manager.init();
      await manager.init();
      expect(mockMkdir.mock.calls.length).toBe(callCount);
    });
  });

  // -----------------------------------------------------------------------
  // createProfile
  // -----------------------------------------------------------------------

  describe('createProfile()', () => {
    it('creates and persists a profile', async () => {
      const result = await createAndPersist(manager, makeProfile());

      expect(result.name).toBe('test-profile');
      expect(result.domain).toBe('example.com');
      expect(result.loginUrl).toBe('https://example.com/login');
      expect(result.status).toBe('active');
    });

    it('returns profile with unmasked credentials', async () => {
      const result = await createAndPersist(manager, makeProfile());

      expect(result.credentials.username).toBe('testuser');
      expect(result.credentials.password).toBe('testpass');
    });

    it('throws on empty name', async () => {
      await expect(manager.createProfile(makeProfile({ name: '' }))).rejects.toThrow(
        'Profile name must be a non-empty string'
      );
    });

    it('throws on empty loginUrl', async () => {
      await expect(manager.createProfile(makeProfile({ loginUrl: '' }))).rejects.toThrow(
        'Profile loginUrl must be a non-empty string'
      );
    });

    it('throws on empty verifySelector', async () => {
      await expect(
        manager.createProfile(makeProfile({ verifySelector: '' }))
      ).rejects.toThrow('Profile verifySelector must be a non-empty string');
    });

    it('throws if profile already exists on disk', async () => {
      await createAndPersist(manager, makeProfile());
      // existsSync is now true, so second create with same name should fail
      await expect(
        manager.createProfile(makeProfile())
      ).rejects.toThrow('Profile already exists: test-profile');
    });

    it('defaults status to active', async () => {
      const profile = makeProfile();
      // @ts-expect-error testing undefined status
      delete profile.status;

      mockExistsSync.mockReturnValue(false);
      const result = await manager.createProfile(profile);
      expect(result.status).toBe('active');
    });
  });

  // -----------------------------------------------------------------------
  // getProfile
  // -----------------------------------------------------------------------

  describe('getProfile()', () => {
    it('retrieves a previously created profile', async () => {
      await createAndPersist(manager, makeProfile());

      const result = await manager.getProfile('test-profile');

      expect(result.name).toBe('test-profile');
      expect(result.credentials.username).toBe('testuser');
    });

    it('throws for non-existent profile', async () => {
      mockExistsSync.mockReturnValue(false);
      await expect(manager.getProfile('missing')).rejects.toThrow(
        'Profile not found: missing'
      );
    });
  });

  // -----------------------------------------------------------------------
  // listProfiles
  // -----------------------------------------------------------------------

  describe('listProfiles()', () => {
    it('returns empty array when no profiles', async () => {
      mockReaddir.mockResolvedValueOnce([]);
      const profiles = await manager.listProfiles();
      expect(profiles).toEqual([]);
    });

    it('lists profiles with masked credentials', async () => {
      await createAndPersist(manager, makeProfile());
      // The file name for "test-profile" after sanitization is "test-profile.profile.enc"
      mockReaddir.mockResolvedValueOnce(['test-profile.profile.enc']);

      const profiles = await manager.listProfiles();

      expect(profiles).toHaveLength(1);
      expect(profiles[0].name).toBe('test-profile');
      expect(profiles[0].credentials.username).toBe('****');
      expect(profiles[0].credentials.password).toBe('****');
    });

    it('skips unreadable profiles gracefully', async () => {
      mockReaddir.mockResolvedValueOnce(['bad.profile.enc']);
      mockExistsSync.mockReturnValue(false);

      const profiles = await manager.listProfiles();
      expect(profiles).toEqual([]);
    });

    it('filters only .profile.enc files', async () => {
      mockReaddir.mockResolvedValueOnce([
        'test.profile.enc',
        '.auth-key',
        'random.txt',
      ]);
      mockExistsSync.mockReturnValue(false);

      const profiles = await manager.listProfiles();
      expect(profiles).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // updateProfile
  // -----------------------------------------------------------------------

  describe('updateProfile()', () => {
    it('updates fields on an existing profile', async () => {
      await createAndPersist(manager, makeProfile());

      const updated = await manager.updateProfile('test-profile', {
        domain: 'new-domain.com',
        status: 'expired',
      });

      expect(updated.domain).toBe('new-domain.com');
      expect(updated.status).toBe('expired');
      expect(updated.name).toBe('test-profile');
    });

    it('merges credential updates', async () => {
      await createAndPersist(manager, makeProfile());

      const updated = await manager.updateProfile('test-profile', {
        credentials: { password: 'new-pass' },
      });

      expect(updated.credentials.username).toBe('testuser');
      expect(updated.credentials.password).toBe('new-pass');
    });

    it('replaces loginSteps when provided', async () => {
      await createAndPersist(manager, makeProfile());

      const newSteps = [{ action: 'click' as const, selector: '#login-btn' }];
      const updated = await manager.updateProfile('test-profile', {
        loginSteps: newSteps,
      });

      expect(updated.loginSteps).toEqual(newSteps);
    });

    it('throws for non-existent profile', async () => {
      mockExistsSync.mockReturnValue(false);
      await expect(
        manager.updateProfile('missing', { domain: 'x' })
      ).rejects.toThrow('Profile not found: missing');
    });
  });

  // -----------------------------------------------------------------------
  // deleteProfile
  // -----------------------------------------------------------------------

  describe('deleteProfile()', () => {
    it('deletes a profile from disk', async () => {
      mockExistsSync.mockReturnValue(true);
      await manager.deleteProfile('test-profile');
      expect(mockUnlink).toHaveBeenCalled();
    });

    it('throws for non-existent profile', async () => {
      mockExistsSync.mockReturnValue(false);
      await expect(manager.deleteProfile('missing')).rejects.toThrow(
        'Profile not found: missing'
      );
    });
  });

  // -----------------------------------------------------------------------
  // login
  // -----------------------------------------------------------------------

  describe('login()', () => {
    beforeEach(async () => {
      await createAndPersist(manager, makeProfile());
    });

    it('creates a new session when no sessionId provided', async () => {
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');
      mockPageWaitForSelector.mockResolvedValue(true);

      const result = await manager.login('test-profile');

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe('new-session-id');
      expect(result.profile).toBe('test-profile');
      expect(result.loginDuration).toBeGreaterThanOrEqual(0);
      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('reuses existing session when sessionId provided', async () => {
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');
      mockPageWaitForSelector.mockResolvedValue(true);

      const result = await manager.login('test-profile', 'existing-session');

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe('existing-session');
      expect(mockGetSession).toHaveBeenCalledWith('existing-session');
    });

    it('skips login when already authenticated via selector', async () => {
      mockPageUrl.mockReturnValue('about:blank');
      mockPage$.mockResolvedValue({ some: 'element' });

      const result = await manager.login('test-profile');

      expect(result.success).toBe(true);
      expect(mockInteractionFill).not.toHaveBeenCalled();
    });

    it('skips login when already authenticated via URL match', async () => {
      await createAndPersist(
        manager,
        makeProfile({ name: 'url-verify-profile', verifyUrl: '/dashboard' })
      );

      mockPageUrl.mockReturnValue('https://example.com/dashboard');
      mockPage$.mockResolvedValue(null);

      const result = await manager.login('url-verify-profile');
      expect(result.success).toBe(true);
    });

    it('executes login steps when not already authenticated', async () => {
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');
      mockPageWaitForSelector.mockResolvedValue(true);

      await manager.login('test-profile');

      expect(mockInteractionFill).toHaveBeenCalledTimes(2);
      expect(mockInteractionClick).toHaveBeenCalledTimes(1);
    });

    it('returns failure when verification fails', async () => {
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');
      mockPageWaitForSelector.mockRejectedValue(new Error('Timeout'));
      // After steps, URL doesn't match verifyUrl either
      mockPageUrl.mockReturnValue('https://example.com/login');

      const result = await manager.login('test-profile');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Login verification failed');
    });

    it('returns failure on general error', async () => {
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');
      // goto throws on both calls (checkAuthentication + actual login navigate)
      mockPageGoto.mockRejectedValue(new Error('Network error'));

      const result = await manager.login('test-profile');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');

      // Reset goto for subsequent tests
      mockPageGoto.mockResolvedValue(undefined);
    });

    it('saves cookies after successful login', async () => {
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');
      mockPageWaitForSelector.mockResolvedValue(true);

      await manager.login('test-profile');
      expect(mockSaveCookies).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // login step execution
  // -----------------------------------------------------------------------

  describe('login step execution', () => {
    it('handles fill step with credential interpolation', async () => {
      await createAndPersist(manager, makeProfile());
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');
      mockPageWaitForSelector.mockResolvedValue(true);

      await manager.login('test-profile');

      expect(mockInteractionFill).toHaveBeenCalledWith(
        expect.anything(),
        '#username',
        'testuser',
        expect.objectContaining({ timeout: 30_000 })
      );
      expect(mockInteractionFill).toHaveBeenCalledWith(
        expect.anything(),
        '#password',
        'testpass',
        expect.objectContaining({ timeout: 30_000 })
      );
    });

    it('handles type step', async () => {
      await createAndPersist(
        manager,
        makeProfile({
          name: 'type-test',
          loginSteps: [
            { action: 'type', selector: '#otp', value: '{{username}}' },
          ],
        })
      );
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');
      mockPageWaitForSelector.mockResolvedValue(true);

      await manager.login('type-test');

      expect(mockInteractionType).toHaveBeenCalledWith(
        expect.anything(),
        '#otp',
        'testuser',
        expect.objectContaining({ delay: 50 })
      );
    });

    it('handles wait step with numeric waitCondition (timeout)', async () => {
      await createAndPersist(
        manager,
        makeProfile({
          name: 'wait-num',
          loginSteps: [
            { action: 'wait', selector: '#el', waitCondition: '2000' },
          ],
        })
      );
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');
      mockPageWaitForSelector.mockResolvedValue(true);

      await manager.login('wait-num');

      expect(mockInteractionWaitFor).toHaveBeenCalledWith(
        expect.anything(),
        { kind: 'timeout', ms: 2000 },
        expect.anything()
      );
    });

    it('handles wait step with selector waitCondition', async () => {
      await createAndPersist(
        manager,
        makeProfile({
          name: 'wait-sel',
          loginSteps: [
            { action: 'wait', selector: '#el', waitCondition: '#loaded' },
          ],
        })
      );
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');
      mockPageWaitForSelector.mockResolvedValue(true);

      await manager.login('wait-sel');

      expect(mockInteractionWaitFor).toHaveBeenCalledWith(
        expect.anything(),
        { kind: 'selector', selector: '#loaded' },
        expect.anything()
      );
    });

    it('handles wait step with no waitCondition (uses step selector)', async () => {
      await createAndPersist(
        manager,
        makeProfile({
          name: 'wait-default',
          loginSteps: [
            { action: 'wait', selector: '#some-element' },
          ],
        })
      );
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');
      mockPageWaitForSelector.mockResolvedValue(true);

      await manager.login('wait-default');

      expect(mockInteractionWaitFor).toHaveBeenCalledWith(
        expect.anything(),
        { kind: 'selector', selector: '#some-element' },
        expect.anything()
      );
    });

    it('uses custom timeout from step', async () => {
      await createAndPersist(
        manager,
        makeProfile({
          name: 'custom-timeout',
          loginSteps: [
            { action: 'click', selector: '#btn', timeout: 5000 },
          ],
        })
      );
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');
      mockPageWaitForSelector.mockResolvedValue(true);

      await manager.login('custom-timeout');

      expect(mockInteractionClick).toHaveBeenCalledWith(
        expect.anything(),
        '#btn',
        expect.objectContaining({ timeout: 5000 })
      );
    });

    it('throws descriptive error when a login step fails', async () => {
      await createAndPersist(manager, makeProfile({ name: 'step-fail' }));
      mockInteractionFill.mockRejectedValueOnce(new Error('Element not found'));
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');

      const result = await manager.login('step-fail');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Login step 0');
      expect(result.error).toContain('fill');
      expect(result.error).toContain('Element not found');
    });

    it('interpolates custom field placeholders', async () => {
      await createAndPersist(
        manager,
        makeProfile({
          name: 'custom-fields',
          credentials: {
            username: 'user1',
            password: 'pass1',
            fields: { otp: '123456', company: 'acme' },
          },
          loginSteps: [
            { action: 'fill', selector: '#otp', value: '{{otp}}' },
            { action: 'fill', selector: '#company', value: '{{company}}' },
          ],
        })
      );
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');
      mockPageWaitForSelector.mockResolvedValue(true);

      await manager.login('custom-fields');

      expect(mockInteractionFill).toHaveBeenCalledWith(
        expect.anything(),
        '#otp',
        '123456',
        expect.anything()
      );
      expect(mockInteractionFill).toHaveBeenCalledWith(
        expect.anything(),
        '#company',
        'acme',
        expect.anything()
      );
    });
  });

  // -----------------------------------------------------------------------
  // isAuthenticated
  // -----------------------------------------------------------------------

  describe('isAuthenticated()', () => {
    it('returns true when verify selector is found', async () => {
      mockPage$.mockResolvedValueOnce({ some: 'element' });

      const result = await manager.isAuthenticated('sid', '.avatar');
      expect(result).toBe(true);
    });

    it('returns false when verify selector not found', async () => {
      mockPage$.mockResolvedValueOnce(null);

      const result = await manager.isAuthenticated('sid', '.avatar');
      expect(result).toBe(false);
    });

    it('returns false on error', async () => {
      mockGetSessionPage.mockRejectedValueOnce(new Error('Session gone'));

      const result = await manager.isAuthenticated('bad-id', '.avatar');
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // refreshAuth
  // -----------------------------------------------------------------------

  describe('refreshAuth()', () => {
    it('returns success immediately if still authenticated', async () => {
      await createAndPersist(manager, makeProfile());
      mockPage$.mockResolvedValue({ some: 'element' });

      const result = await manager.refreshAuth('test-profile', 'sid');

      expect(result.success).toBe(true);
      expect(result.loginDuration).toBe(0);
    });

    it('re-authenticates when session is expired', async () => {
      await createAndPersist(manager, makeProfile());
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');
      mockPageWaitForSelector.mockResolvedValue(true);

      const result = await manager.refreshAuth('test-profile', 'existing-session');

      expect(result.success).toBe(true);
      expect(mockGetSession).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // verifyLogin
  // -----------------------------------------------------------------------

  describe('verifyLogin (via login)', () => {
    it('falls back to verifyUrl check when selector times out', async () => {
      await createAndPersist(
        manager,
        makeProfile({ name: 'verify-url-fallback', verifyUrl: '/home' })
      );
      mockPage$.mockResolvedValue(null);
      mockPageUrl.mockReturnValue('about:blank');

      mockPageWaitForSelector.mockRejectedValue(new Error('Timeout'));
      mockPageUrl.mockReturnValue('https://example.com/home');

      const result = await manager.login('verify-url-fallback');
      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Profile file path sanitisation
  // -----------------------------------------------------------------------

  describe('profileFilePath sanitisation', () => {
    it('sanitises special characters in profile names', async () => {
      mockExistsSync.mockReturnValue(false);
      const profile = makeProfile({ name: 'my profile/with:special' });
      await manager.createProfile(profile);

      const writeCalls = mockWriteFile.mock.calls;
      const profileWriteCall = writeCalls.find((c: unknown[]) =>
        String(c[0]).includes('.profile.enc')
      );
      expect(profileWriteCall).toBeDefined();
      expect(String(profileWriteCall![0])).toContain('my_profile_with_special');
    });
  });

  // -----------------------------------------------------------------------
  // toAuthProfile masking
  // -----------------------------------------------------------------------

  describe('toAuthProfile masking (via listProfiles)', () => {
    it('masks custom fields in credentials', async () => {
      await createAndPersist(
        manager,
        makeProfile({
          credentials: {
            username: 'user',
            password: 'pass',
            fields: { apiKey: 'secret-key' },
          },
        })
      );

      mockReaddir.mockResolvedValueOnce(['test-profile.profile.enc']);

      const profiles = await manager.listProfiles();
      expect(profiles).toHaveLength(1);
      expect(profiles[0].credentials.fields).toEqual({ apiKey: '****' });
    });
  });
});
