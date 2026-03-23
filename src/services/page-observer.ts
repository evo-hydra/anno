/**
 * PageObserver — Structured page comprehension for AI agents
 *
 * Combines interactive element discovery, content classification, and
 * pattern detection into a single "what am I looking at?" response.
 * This is the comprehension layer — the thing nobody else does.
 *
 * @module services/page-observer
 */

import type { Page } from 'playwright-core';
import { interactionManager, type PageState } from './interaction-manager';
import { detectChallengePage, detectChallengeSelectors, detectAuthWall } from '../core/wall-detector';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PageType =
  | 'login'
  | 'search-results'
  | 'article'
  | 'product'
  | 'checkout'
  | 'form'
  | 'dashboard'
  | 'listing'
  | 'error'
  | 'unknown';

export interface NavigationOption {
  text: string;
  href: string;
  selector: string;
}

export interface DetectedPattern {
  type: 'captcha' | 'paywall' | 'cookie-consent' | 'auth-wall' | 'popup' | 'age-gate';
  reason: string;
  selector?: string;
}

export interface PageObservation {
  url: string;
  title: string;
  pageType: PageType;
  confidence: number;
  interactiveElements: {
    buttons: number;
    links: number;
    inputs: number;
    selects: number;
    textareas: number;
    total: number;
  };
  navigation: NavigationOption[];
  detectedPatterns: DetectedPattern[];
  contentSummary: {
    headings: string[];
    textLength: number;
    imageCount: number;
    formCount: number;
  };
  pageState: PageState;
}

// ---------------------------------------------------------------------------
// Page type classification signals
// ---------------------------------------------------------------------------

interface ClassificationSignal {
  type: PageType;
  weight: number;
}

function classifyPage(
  html: string,
  title: string,
  pageState: PageState,
  url: string,
): { type: PageType; confidence: number } {
  const signals: ClassificationSignal[] = [];
  const lower = html.slice(0, 10000).toLowerCase();
  const titleLower = title.toLowerCase();
  const urlLower = url.toLowerCase();

  // Login page signals
  if (pageState.interactiveElements.some((el) => el.tag === 'input' && el.type === 'password')) {
    signals.push({ type: 'login', weight: 0.4 });
  }
  if (/log\s*in|sign\s*in/i.test(titleLower)) {
    signals.push({ type: 'login', weight: 0.3 });
  }
  if (/login|signin|auth/i.test(urlLower)) {
    signals.push({ type: 'login', weight: 0.2 });
  }

  // Search results signals
  if (/search results|results for/i.test(titleLower) || /search|results/i.test(lower)) {
    signals.push({ type: 'search-results', weight: 0.3 });
  }
  if (/[?&]q=|[?&]query=|[?&]search=/i.test(urlLower)) {
    signals.push({ type: 'search-results', weight: 0.3 });
  }

  // Article signals
  if (lower.includes('<article') || lower.includes('class="article') || lower.includes('role="article"')) {
    signals.push({ type: 'article', weight: 0.3 });
  }
  if (lower.includes('byline') || lower.includes('author') || lower.includes('published')) {
    signals.push({ type: 'article', weight: 0.2 });
  }

  // Product signals
  if (/price|add.to.cart|buy.now|\$\d+/i.test(lower)) {
    signals.push({ type: 'product', weight: 0.3 });
  }
  if (/product|item|sku/i.test(urlLower)) {
    signals.push({ type: 'product', weight: 0.2 });
  }

  // Checkout signals
  if (/checkout|payment|billing|shipping address/i.test(lower)) {
    signals.push({ type: 'checkout', weight: 0.4 });
  }

  // Form signals (many inputs without password = generic form)
  const inputCount = pageState.interactiveElements.filter((el) => el.type === 'input').length;
  const hasPassword = pageState.interactiveElements.some((el) => el.tag === 'input' && el.type === 'password');
  if (inputCount >= 3 && !hasPassword) {
    signals.push({ type: 'form', weight: 0.2 });
  }

  // Dashboard signals
  if (/dashboard|admin|panel|overview/i.test(titleLower + ' ' + urlLower)) {
    signals.push({ type: 'dashboard', weight: 0.3 });
  }

  // Listing signals (many similar items)
  if (/listing|catalog|browse|category/i.test(urlLower)) {
    signals.push({ type: 'listing', weight: 0.3 });
  }

  // Error page signals
  if (/404|not found|error|forbidden|500/i.test(titleLower)) {
    signals.push({ type: 'error', weight: 0.4 });
  }

  // Aggregate signals by type
  const scores = new Map<PageType, number>();
  for (const signal of signals) {
    scores.set(signal.type, (scores.get(signal.type) ?? 0) + signal.weight);
  }

  // Find the highest scoring type
  let bestType: PageType = 'unknown';
  let bestScore = 0;
  for (const [type, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  // Confidence is the normalized score (capped at 0.95)
  const confidence = Math.min(0.95, Math.max(0.1, bestScore));

  return { type: bestType, confidence };
}

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------

async function detectPatterns(page: Page, html: string): Promise<DetectedPattern[]> {
  const patterns: DetectedPattern[] = [];

  // Challenge/captcha detection (reuse wall-detector)
  const challenge = detectChallengePage(html);
  if (challenge) {
    patterns.push({ type: 'captcha', reason: challenge.reason });
  }

  const selectorChallenge = await detectChallengeSelectors(page);
  if (selectorChallenge) {
    patterns.push({ type: 'captcha', reason: selectorChallenge.reason, selector: selectorChallenge.pattern });
  }

  // Auth wall detection
  const authWall = detectAuthWall(html);
  if (authWall) {
    patterns.push({ type: 'auth-wall', reason: authWall.reason });
  }

  // Cookie consent detection
  const cookieConsentSelectors = [
    '[class*="cookie-consent"]',
    '[class*="cookie-banner"]',
    '[id*="cookie"]',
    '[class*="gdpr"]',
    '#onetrust-banner-sdk',
    '.cc-window',
  ];
  for (const sel of cookieConsentSelectors) {
    try {
      const visible = await page.locator(sel).first().isVisible({ timeout: 500 });
      if (visible) {
        patterns.push({ type: 'cookie-consent', reason: 'cookie_banner_visible', selector: sel });
        break;
      }
    } catch {
      // Selector not found — skip
    }
  }

  // Popup/modal detection
  const popupSelectors = [
    '[class*="modal"][class*="overlay"]',
    '[class*="popup"]',
    '[role="dialog"]',
  ];
  for (const sel of popupSelectors) {
    try {
      const visible = await page.locator(sel).first().isVisible({ timeout: 500 });
      if (visible) {
        patterns.push({ type: 'popup', reason: 'modal_or_popup_visible', selector: sel });
        break;
      }
    } catch {
      // Selector not found — skip
    }
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Main observe function
// ---------------------------------------------------------------------------

export async function observePage(page: Page): Promise<PageObservation> {
  const url = page.url();
  const title = await page.title();
  const html = await page.content();

  // Get interactive element inventory
  const pageState = await interactionManager.getPageState(page);

  // Classify the page type
  const { type: pageType, confidence } = classifyPage(html, title, pageState, url);

  // Detect patterns (captcha, paywall, cookie consent, etc.)
  const detectedPatterns = await detectPatterns(page, html);

  // Extract navigation options (top-level links)
  const navigation: NavigationOption[] = [];
  try {
    const navLinks = await page.$$eval('nav a[href], header a[href]', (links) =>
      links.slice(0, 20).map((a) => ({
        text: (a as HTMLAnchorElement).textContent?.trim() ?? '',
        href: (a as HTMLAnchorElement).href,
        selector: '', // filled below
      }))
    );
    for (let i = 0; i < navLinks.length; i++) {
      if (navLinks[i].text) {
        navigation.push({
          ...navLinks[i],
          selector: `nav a[href]:nth-of-type(${i + 1}), header a[href]:nth-of-type(${i + 1})`,
        });
      }
    }
  } catch {
    // No nav found — fine
  }

  // Content summary
  const headings: string[] = [];
  try {
    const h = await page.$$eval('h1, h2, h3', (els) =>
      els.slice(0, 10).map((el) => el.textContent?.trim() ?? '')
    );
    headings.push(...h.filter(Boolean));
  } catch {
    // OK
  }

  const textLength = await page.evaluate(() => document.body?.innerText?.length ?? 0);
  const imageCount = await page.evaluate(() => document.querySelectorAll('img').length);
  const formCount = await page.evaluate(() => document.querySelectorAll('form').length);

  // Summarize interactive elements
  const elements = pageState.interactiveElements;
  const interactiveElements = {
    buttons: elements.filter((e) => e.type === 'button' || e.type === 'submit').length,
    links: elements.filter((e) => e.type === 'link').length,
    inputs: elements.filter((e) => e.type === 'input' || e.type === 'text' || e.type === 'email' || e.type === 'number').length,
    selects: elements.filter((e) => e.type === 'select').length,
    textareas: elements.filter((e) => e.type === 'textarea').length,
    total: elements.length,
  };

  logger.info('page-observer: observation complete', {
    url,
    pageType,
    confidence,
    patternCount: detectedPatterns.length,
    elementCount: interactiveElements.total,
  });

  return {
    url,
    title,
    pageType,
    confidence,
    interactiveElements,
    navigation,
    detectedPatterns,
    contentSummary: {
      headings,
      textLength,
      imageCount,
      formCount,
    },
    pageState,
  };
}
