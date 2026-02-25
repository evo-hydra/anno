/**
 * Detects challenge pages (CAPTCHAs, bot checks) and auth walls (login/paywall gates).
 *
 * Patterns are matched against the first 4KB of the body to avoid false positives
 * from sidebar CTAs, footers, and other ancillary page elements.
 */

export interface DetectionResult {
  reason: string;
  pattern: string;
}

const CHALLENGE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /captcha/i, reason: 'captcha' },
  { pattern: /verify you are human/i, reason: 'human_verification' },
  { pattern: /are you a robot/i, reason: 'robot_check' },
  { pattern: /access denied/i, reason: 'access_denied' },
  { pattern: /perimeterx/i, reason: 'perimeterx' },
  { pattern: /please enable javascript/i, reason: 'javascript_required' },
  { pattern: /unusual traffic/i, reason: 'unusual_traffic' },
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
