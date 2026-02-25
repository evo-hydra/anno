/**
 * Browser-like User-Agent strings for HTTP and stealth rendering.
 *
 * Single source of truth — update the Chrome version here when a new
 * stable release ships. All three strings share the same version so
 * a find-and-replace on the version number is sufficient.
 */

const CHROME_VERSION = '131.0.0.0';

/** Default UA used for plain HTTP fetches. */
export const DEFAULT_USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

/** Pool of realistic UAs rotated per Playwright context for stealth rendering. */
export const STEALTH_USER_AGENTS: readonly string[] = [
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`,
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`,
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`,
];
