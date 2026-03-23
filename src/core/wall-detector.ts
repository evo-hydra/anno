/**
 * Detects challenge pages (CAPTCHAs, bot checks) and auth walls (login/paywall gates).
 *
 * Two detection modes:
 * - Text-based: regex against first 4KB of body (fast, no DOM needed)
 * - Selector-based: DOM element visibility check (requires Playwright Page)
 *
 * Centralizes all challenge detection — PersistentSessionManager and session-auth
 * delegate to these functions rather than maintaining their own pattern lists.
 */

import type { Page } from 'playwright-core';

export interface DetectionResult {
  reason: string;
  pattern: string;
}

// ---------------------------------------------------------------------------
// Text-based detection (regex against raw body text)
// ---------------------------------------------------------------------------

const CHALLENGE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /captcha/i, reason: 'captcha' },
  { pattern: /verify you are human/i, reason: 'human_verification' },
  { pattern: /are you a robot/i, reason: 'robot_check' },
  { pattern: /access denied/i, reason: 'access_denied' },
  { pattern: /perimeterx/i, reason: 'perimeterx' },
  { pattern: /please enable javascript/i, reason: 'javascript_required' },
  { pattern: /unusual traffic/i, reason: 'unusual_traffic' },
  // Cloudflare-specific (previously only in PersistentSessionManager)
  { pattern: /challenge-form/i, reason: 'cloudflare_challenge' },
  { pattern: /checking your browser/i, reason: 'cloudflare_check' },
  { pattern: /security check/i, reason: 'security_check' },
  { pattern: /automated requests/i, reason: 'automated_detection' },
];

const AUTH_WALL_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Generic login/signup walls — these require action verbs + intent to gate content
  { pattern: /sign\s*in\s+to\s+(view|read|access|continue)/i, reason: 'sign_in_required' },
  { pattern: /log\s*in\s+to\s+(view|read|access|continue)/i, reason: 'login_required' },
  { pattern: /sign\s*up\s+to\s+(view|read|access|continue|unlock)/i, reason: 'signup_required' },
  { pattern: /subscribe\s+to\s+(read|view|access|unlock|continue)/i, reason: 'paywall' },
  // LinkedIn-specific (these appear in <title> or primary content, low false-positive risk)
  { pattern: /authwall/i, reason: 'linkedin_authwall' },
  { pattern: /join\s+linkedin/i, reason: 'linkedin_join' },
  { pattern: /sign\s+in.*linkedin/i, reason: 'linkedin_signin' },
];

/** Maximum bytes of the body to scan. Keeps detection focused on primary content. */
const SCAN_LIMIT = 4096;

const matchPatterns = (
  body: string,
  patterns: ReadonlyArray<{ pattern: RegExp; reason: string }>,
): DetectionResult | null => {
  const scanWindow = body.slice(0, SCAN_LIMIT);
  for (const { pattern, reason } of patterns) {
    if (pattern.test(scanWindow)) {
      return { reason, pattern: pattern.source };
    }
  }
  return null;
};

export const detectChallengePage = (body: string): DetectionResult | null =>
  matchPatterns(body, CHALLENGE_PATTERNS);

export const detectAuthWall = (body: string): DetectionResult | null =>
  matchPatterns(body, AUTH_WALL_PATTERNS);

/** Returns true if the page looks like it's gated (challenge OR auth wall). */
export const isGatedPage = (body: string): boolean =>
  detectChallengePage(body) !== null || detectAuthWall(body) !== null;

// ---------------------------------------------------------------------------
// Selector-based detection (DOM visibility check — requires Playwright Page)
// ---------------------------------------------------------------------------

const CHALLENGE_SELECTORS: ReadonlyArray<{ selector: string; reason: string }> = [
  { selector: '#px-captcha', reason: 'perimeter-x' },
  { selector: '.g-recaptcha', reason: 'recaptcha' },
  { selector: 'iframe[src*="recaptcha"]', reason: 'recaptcha' },
  { selector: 'iframe[src*="hcaptcha"]', reason: 'hcaptcha' },
  { selector: '.challenge-form', reason: 'cloudflare' },
  { selector: '#challenge-form', reason: 'cloudflare' },
  { selector: '[id*="captcha"]', reason: 'unknown_captcha' },
];

/**
 * Check for visible challenge elements in the DOM.
 * Requires a Playwright Page instance.
 */
export const detectChallengeSelectors = async (page: Page): Promise<DetectionResult | null> => {
  for (const { selector, reason } of CHALLENGE_SELECTORS) {
    try {
      const element = page.locator(selector);
      const visible = await element.isVisible({ timeout: 1000 });
      if (visible) {
        return { reason, pattern: selector };
      }
    } catch {
      // Element not found — continue
    }
  }
  return null;
};
