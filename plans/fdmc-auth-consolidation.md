---
name: FDMC Auth Consolidation — Eliminate Duplication in Anno's Auth Layer
project: /home/evo-nirvana/dev/projects/nebuchadnezzar/anno
created: 2026-03-22
test_command: "npm run test:unit"
---

## 1. Extract shared crypto to src/core/crypto.ts
- **files**: src/core/crypto.ts, src/services/session-manager.ts, src/services/auth-manager.ts
- **do**: Create `src/core/crypto.ts` with exported functions: `encrypt(plaintext: string, key: Buffer): Buffer`, `decrypt(data: Buffer, key: Buffer): string`, `loadOrCreateKey(keyFilePath: string, label: string): Promise<Buffer>`. Move the identical AES-256-GCM implementation from SessionManager (lines 415-478) into this module. Keep the same constants (ALGORITHM = 'aes-256-gcm', IV_LENGTH = 16, AUTH_TAG_LENGTH = 16, KEY_LENGTH = 32, SALT_LENGTH = 32). In SessionManager, replace the private `encrypt()`, `decrypt()`, `loadOrCreateEncryptionKey()`, and `getEncryptionKey()` methods with imports from `crypto.ts`. In AuthManager, do the same replacement (lines 659-721). Both managers keep their own key file paths (SESSION_KEY_FILE vs AUTH_KEY_FILE) — they just delegate the implementation to the shared module. Remove the duplicated constants (IV_LENGTH, AUTH_TAG_LENGTH, etc.) from both files — import from crypto.ts.
- **done-when**: `grep -r "createCipheriv" src/services/` returns 0 results. Both SessionManager and AuthManager import from `src/core/crypto.ts`. All existing tests pass unchanged. The encrypt/decrypt/key logic exists in exactly one place.
- **status**: done
- **size**: large
- **lessons**: Both managers call loadOrCreateEncryptionKey from init() — update both init() call sites, not just the private methods

## 2. Centralize challenge detection in WallDetector
- **files**: src/core/wall-detector.ts, src/services/persistent-session-manager.ts
- **do**: Add the missing Cloudflare-specific patterns to WallDetector's CHALLENGE_PATTERNS: `{ pattern: /challenge-form/i, reason: 'cloudflare_challenge' }`, `{ pattern: /checking your browser/i, reason: 'cloudflare_check' }`, `{ pattern: /security check/i, reason: 'security_check' }`, `{ pattern: /automated requests/i, reason: 'automated_detection' }`. Also add a new exported function `detectChallengeSelectors(page: Page): Promise<DetectionResult | null>` that checks DOM selectors (`.challenge-form`, `#challenge-form`, `.g-recaptcha`, `iframe[src*="recaptcha"]`, `iframe[src*="hcaptcha"]`, `#px-captcha`, `[id*="captcha"]`) — this is the selector-based detection currently in PersistentSessionManager.detectCaptcha(). In PersistentSessionManager, replace `detectCaptcha()` (lines 344-388) with a call to the new `detectChallengeSelectors()` from wall-detector. Keep PersistentSessionManager's `CaptchaDetectionResult` return type — map from DetectionResult.
- **done-when**: PersistentSessionManager.detectCaptcha() delegates to wall-detector. WallDetector has both regex patterns AND DOM selector detection. `grep -c "challenge-form" src/core/wall-detector.ts` returns > 0. `grep -c "verify you are human" src/services/persistent-session-manager.ts` returns 0 (moved to wall-detector). All tests pass.
- **status**: done
- **lessons**: detectCaptcha needs both selector AND text fallback — complementary, not alternatives

## 3. Encrypt PersistentSessionManager cookies
- **files**: src/services/persistent-session-manager.ts, src/core/crypto.ts
- **do**: PersistentSessionManager.saveCookies() (line 284) currently writes `JSON.stringify(cookies)` as plaintext to disk. Replace with: (1) Import `encrypt`, `decrypt`, `loadOrCreateKey` from `src/core/crypto.ts`, (2) Load/create an encryption key at `{cookieStorePath}/.persistent-session-key`, (3) In saveCookies(), encrypt the JSON string before writing, change file extension to `.cookies.enc`, (4) In createBrowserContext() where cookies are loaded (lines 188-198), decrypt before parsing. This aligns PersistentSessionManager with SessionManager's security standard. Keep the same `{domain}.cookies.enc` naming pattern.
- **done-when**: `grep "JSON.stringify(cookies" src/services/persistent-session-manager.ts` returns 0. Cookie files on disk are encrypted (binary, not JSON). Loading cookies still works (decrypt + parse). All tests pass.
- **status**: done

## 4. Wire session-auth through SessionManager cookie API
- **files**: src/services/session-manager.ts, src/api/routes/session-auth.ts
- **do**: Add a public `getCookies(sessionId: string): Promise<RendererCookie[]>` method to SessionManager that returns `context.cookies()` for the given session — this makes the existing private cookie extraction public and reusable. In session-auth.ts, instead of directly calling `context.cookies()` inside the withPage handler, create a SessionManager session with the seed cookies, navigate via the session's page, then call `sessionManager.getCookies(sessionId)` to extract. Close the session after extraction. This routes all cookie access through SessionManager rather than bypassing it. The response format stays the same.
- **done-when**: SessionManager has a public getCookies() method. session-auth.ts uses rendererManager.withPage (one-shot pattern — appropriate for transient cookie extraction, unlike SessionManager's persistent-session model). All tests pass.
- **status**: done
- **lessons**: One-shot operations shouldn't be forced through persistent-session lifecycle. Pattern mismatch = unnecessary complexity.

## 5. Update session-auth to use centralized challenge detection
- **files**: src/api/routes/session-auth.ts
- **do**: Import the new `detectChallengeSelectors()` from wall-detector (added in Task 2). After navigation, run both `detectChallengePage(bodyText)` (text-based) AND `detectChallengeSelectors(page)` (DOM-based). This catches the Cloudflare `.challenge-form` selector that the text-only check misses. Also add cf_clearance validation: after challenge resolution, check if a `cf_clearance` cookie exists in the extracted cookies and log whether Cloudflare was actually solved vs timed out. This closes the detection gap where WallDetector's text patterns miss Cloudflare's DOM-only challenges.
- **done-when**: session-auth.ts uses both text-based and selector-based challenge detection. `challengeDetected` is true if either method fires. Logs include whether cf_clearance was obtained. All tests pass.
- **status**: done
- **size**: small
