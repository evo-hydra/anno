/**
 * SSRF (Server-Side Request Forgery) URL Validator
 *
 * Validates URLs before outbound requests to prevent SSRF attacks.
 * Blocks requests to private/internal IP ranges, link-local addresses,
 * and cloud metadata endpoints.
 *
 * @module core/url-validator
 */

import { promises as dns } from 'dns';
import net from 'net';
import { config } from '../config/env';
import { AppError, ErrorCode } from '../middleware/error-handler';
import { logger } from '../utils/logger';

/**
 * Check whether an IP address belongs to a private/reserved range.
 *
 * Blocked ranges:
 * - 127.0.0.0/8 (loopback)
 * - 10.0.0.0/8 (private)
 * - 172.16.0.0/12 (private)
 * - 192.168.0.0/16 (private)
 * - 169.254.0.0/16 (link-local, includes AWS metadata 169.254.169.254)
 * - 0.0.0.0/8 (unspecified)
 * - ::1 (IPv6 loopback)
 * - fc00::/7 (IPv6 unique local)
 * - fe80::/10 (IPv6 link-local)
 * - ::ffff:x.x.x.x (IPv4-mapped IPv6 — extracts and re-checks IPv4)
 */
export function isPrivateIP(ip: string): boolean {
  // Handle IPv4-mapped IPv6 (::ffff:x.x.x.x)
  if (ip.startsWith('::ffff:')) {
    const ipv4Part = ip.slice(7);
    if (net.isIPv4(ipv4Part)) {
      return isPrivateIP(ipv4Part);
    }
  }

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;

    // 0.0.0.0/8
    if (a === 0) return true;
    // 127.0.0.0/8
    if (a === 127) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;

    return false;
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();

    // ::1 (loopback)
    if (normalized === '::1') return true;

    // fc00::/7 (unique local: fc00:: - fdff::)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

    // fe80::/10 (link-local: fe80:: - febf::)
    if (normalized.startsWith('fe80') || normalized.startsWith('fe9') ||
        normalized.startsWith('fea') || normalized.startsWith('feb')) return true;

    return false;
  }

  // Unknown format — treat as private (fail-closed)
  return true;
}

/**
 * Validate a URL for SSRF safety. Throws AppError with SSRF_BLOCKED if unsafe.
 *
 * Checks performed (in order):
 * 1. Skip all checks if SSRF protection is disabled
 * 2. Reject non-HTTP(S) schemes
 * 3. Reject if hostname is in blockedHosts
 * 4. Allow early if hostname is in allowedHosts
 * 5. Check IP literal hostnames against private ranges
 * 6. DNS-resolve hostnames and check all resolved IPs
 * 7. Explicit localhost check
 */
export async function validateUrl(url: string): Promise<void> {
  if (!config.ssrf.enabled) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError(
      ErrorCode.SSRF_BLOCKED,
      `SSRF protection: invalid URL — ${url}`,
      403
    );
  }

  // Reject non-HTTP(S) schemes
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(
      ErrorCode.SSRF_BLOCKED,
      `SSRF protection: scheme '${parsed.protocol}' is not allowed — only http: and https: are permitted`,
      403
    );
  }

  const hostname = parsed.hostname;

  // Check blockedHosts
  if (config.ssrf.blockedHosts.length > 0) {
    const blocked = config.ssrf.blockedHosts.some(
      h => h.toLowerCase() === hostname.toLowerCase()
    );
    if (blocked) {
      throw new AppError(
        ErrorCode.SSRF_BLOCKED,
        `SSRF protection: hostname '${hostname}' is explicitly blocked`,
        403
      );
    }
  }

  // Check allowedHosts — if listed, skip remaining checks
  if (config.ssrf.allowedHosts.length > 0) {
    const allowed = config.ssrf.allowedHosts.some(
      h => h.toLowerCase() === hostname.toLowerCase()
    );
    if (allowed) return;
  }

  // Explicit localhost check (some systems don't resolve it via DNS)
  if (hostname.toLowerCase() === 'localhost') {
    if (!config.ssrf.allowPrivateIPs) {
      throw new AppError(
        ErrorCode.SSRF_BLOCKED,
        `SSRF protection: 'localhost' is not allowed`,
        403
      );
    }
    return;
  }

  // Check IP-literal hostnames
  // Strip brackets from IPv6 literals: [::1] → ::1
  const bareIP = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  if (net.isIPv4(bareIP) || net.isIPv6(bareIP)) {
    if (isPrivateIP(bareIP) && !config.ssrf.allowPrivateIPs) {
      throw new AppError(
        ErrorCode.SSRF_BLOCKED,
        `SSRF protection: private IP address '${hostname}' is not allowed`,
        403
      );
    }
    return;
  }

  // DNS resolve and check all IPs
  try {
    const addresses = await dns.lookup(hostname, { all: true });

    for (const addr of addresses) {
      if (isPrivateIP(addr.address) && !config.ssrf.allowPrivateIPs) {
        logger.warn('SSRF protection: DNS resolved to private IP', {
          hostname,
          resolvedIP: addr.address,
        });
        throw new AppError(
          ErrorCode.SSRF_BLOCKED,
          `SSRF protection: hostname '${hostname}' resolves to private IP '${addr.address}'`,
          403
        );
      }
    }
  } catch (error) {
    // Re-throw AppError (our own SSRF blocks)
    if (error instanceof AppError) throw error;

    // DNS failure — fail closed
    logger.warn('SSRF protection: DNS resolution failed, blocking request', {
      hostname,
      error: error instanceof Error ? error.message : 'unknown',
    });
    throw new AppError(
      ErrorCode.SSRF_BLOCKED,
      `SSRF protection: DNS resolution failed for '${hostname}'`,
      403
    );
  }
}

/**
 * Validate a webhook URL. Wrapper with webhook-specific error context.
 */
export async function validateWebhookUrl(url: string): Promise<void> {
  try {
    await validateUrl(url);
  } catch (error) {
    if (error instanceof AppError && error.code === ErrorCode.SSRF_BLOCKED) {
      throw new AppError(
        ErrorCode.SSRF_BLOCKED,
        `Webhook ${error.message}`,
        403
      );
    }
    throw error;
  }
}
