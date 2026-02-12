import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockDistillContent = vi.hoisted(() => vi.fn());
const mockScrollFn = vi.hoisted(() => vi.fn());
const mockComputeContentQuality = vi.hoisted(() => vi.fn());

vi.mock('../services/distiller', () => ({
  distillContent: mockDistillContent,
}));

vi.mock('../services/interaction-manager', () => ({
  interactionManager: {
    scroll: mockScrollFn,
  },
}));

vi.mock('../core/confidence-scorer', () => ({
  confidenceScorer: {
    computeContentQuality: mockComputeContentQuality,
  },
}));

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
  startSpan: () => ({ end: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { AgenticExtractor } from '../services/agentic-extractor';
import type { DistillationResult } from '../services/distiller';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDistillationResult(overrides: Partial<DistillationResult> = {}): DistillationResult {
  return {
    title: 'Test Article',
    byline: null,
    excerpt: null,
    lang: 'en',
    siteName: null,
    contentText: overrides.contentText ?? 'A decent length paragraph. '.repeat(20),
    contentLength: overrides.contentLength ?? 500,
    nodes: overrides.nodes ?? [
      { id: '1', order: 1, type: 'paragraph', text: 'Paragraph 1.' },
      { id: '2', order: 2, type: 'heading', text: 'Heading 1' },
    ],
    fallbackUsed: false,
    extractionMethod: overrides.extractionMethod ?? 'readability',
    extractionConfidence: overrides.extractionConfidence,
    confidenceBreakdown: overrides.confidenceBreakdown,
    ...overrides,
  };
}

function makeMockPage(overrides: Record<string, unknown> = {}) {
  return {
    url: vi.fn().mockReturnValue('https://example.com/article'),
    content: vi.fn().mockResolvedValue('<html><body>Test</body></html>'),
    evaluate: vi.fn().mockResolvedValue(0),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({
      first: vi.fn().mockReturnValue({
        isVisible: vi.fn().mockResolvedValue(false),
      }),
    }),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgenticExtractor', () => {
  let extractor: AgenticExtractor;

  beforeEach(() => {
    vi.clearAllMocks();
    extractor = new AgenticExtractor();
    mockComputeContentQuality.mockReturnValue(0.5);
  });

  describe('extract - quality threshold met on first attempt', () => {
    it('returns immediately when confidence and content length meet thresholds', async () => {
      const result = makeDistillationResult({
        contentText: 'A '.repeat(200),
        extractionConfidence: 0.9,
        extractionMethod: 'readability',
      });
      mockDistillContent.mockResolvedValue(result);

      const page = makeMockPage();

      const output = await extractor.extract(page, {
        confidenceThreshold: 0.7,
        minContentLength: 200,
        maxAttempts: 3,
      });

      expect(output.confidence).toBe(0.9);
      expect(output.finalMethod).toBe('readability');
      expect(output.attempts.length).toBe(1);
      expect(output.improvements).toHaveLength(0);
      expect(output.totalDuration).toBeGreaterThanOrEqual(0);
      expect(output.distillationResult).toBeDefined();

      // Should have only called distillContent once
      expect(mockDistillContent).toHaveBeenCalledTimes(1);
    });
  });

  describe('extract - uses confidenceBreakdown.overall when available', () => {
    it('prefers confidenceBreakdown.overall over extractionConfidence', async () => {
      const result = makeDistillationResult({
        contentText: 'A '.repeat(200),
        extractionConfidence: 0.5,
        confidenceBreakdown: {
          extraction: 0.8,
          contentQuality: 0.85,
          metadata: 0.9,
          sourceCredibility: 0.7,
          consensus: 0.6,
          overall: 0.95,
        },
      });
      mockDistillContent.mockResolvedValue(result);

      const page = makeMockPage();

      const output = await extractor.extract(page, {
        confidenceThreshold: 0.9,
        minContentLength: 100,
      });

      expect(output.confidence).toBe(0.95);
      expect(output.attempts.length).toBe(1);
    });
  });

  describe('extract - fallback heuristic confidence', () => {
    it('uses computeContentQuality when no confidence scores provided', async () => {
      mockComputeContentQuality.mockReturnValue(0.85);

      const result = makeDistillationResult({
        contentText: 'Content paragraph. '.repeat(30),
        extractionConfidence: undefined,
        confidenceBreakdown: undefined,
      });
      mockDistillContent.mockResolvedValue(result);

      const page = makeMockPage();

      const output = await extractor.extract(page, {
        confidenceThreshold: 0.7,
        minContentLength: 100,
      });

      expect(mockComputeContentQuality).toHaveBeenCalled();
      expect(output.confidence).toBe(0.85);
    });
  });

  describe('extract - multiple attempts with improvement strategies', () => {
    it('tries scrolling when first attempt does not meet threshold', async () => {
      // First attempt: low confidence
      const lowResult = makeDistillationResult({
        contentText: 'short',
        extractionConfidence: 0.3,
      });

      // Second attempt: high confidence after scroll
      const highResult = makeDistillationResult({
        contentText: 'A '.repeat(300),
        extractionConfidence: 0.9,
      });

      mockDistillContent
        .mockResolvedValueOnce(lowResult)
        .mockResolvedValueOnce(highResult);

      const page = makeMockPage({
        evaluate: vi.fn()
          .mockResolvedValueOnce(1000) // initial height
          .mockResolvedValueOnce(2000) // new height after scroll
          .mockResolvedValue(false),   // other evaluations
      });

      mockScrollFn.mockResolvedValue(undefined);

      const output = await extractor.extract(page, {
        confidenceThreshold: 0.7,
        minContentLength: 5,
        maxAttempts: 3,
        enableScrolling: true,
        enableInteraction: false,
        enableAlternateExtraction: false,
      });

      expect(output.attempts.length).toBe(2);
      expect(output.confidence).toBe(0.9);
      expect(mockScrollFn).toHaveBeenCalled();
    });
  });

  describe('extract - max attempts reached', () => {
    it('stops after maxAttempts even if quality not met', async () => {
      const lowResult = makeDistillationResult({
        contentText: 'A '.repeat(200),
        extractionConfidence: 0.3,
      });
      mockDistillContent.mockResolvedValue(lowResult);

      const page = makeMockPage({
        evaluate: vi.fn().mockResolvedValue(0),
      });

      const output = await extractor.extract(page, {
        confidenceThreshold: 0.99,
        minContentLength: 200,
        maxAttempts: 1,
        enableScrolling: true,
        enableInteraction: true,
        enableAlternateExtraction: true,
      });

      expect(output.attempts.length).toBe(1);
      expect(output.confidence).toBe(0.3);
    });
  });

  describe('extract - no improvements possible', () => {
    it('stops when no strategy produces improvements', async () => {
      const lowResult = makeDistillationResult({
        contentText: 'A '.repeat(200),
        extractionConfidence: 0.3,
      });
      mockDistillContent.mockResolvedValue(lowResult);

      // Mock page where scroll height stays the same, no overlays, no show-more
      const page = makeMockPage({
        evaluate: vi.fn()
          .mockResolvedValueOnce(1000) // initial height
          .mockResolvedValueOnce(1000) // same height (no scroll growth)
          .mockResolvedValue(false),   // no buttons found, no interference
      });

      mockScrollFn.mockResolvedValue(undefined);

      const output = await extractor.extract(page, {
        confidenceThreshold: 0.99,
        minContentLength: 100,
        maxAttempts: 3,
        enableScrolling: true,
        enableInteraction: true,
        enableAlternateExtraction: true,
      });

      // Should stop after first or second attempt since no improvements
      expect(output.attempts.length).toBeLessThanOrEqual(2);
    });
  });

  describe('extract - timeout respected', () => {
    it('breaks loop when timeout exceeded', async () => {
      const lowResult = makeDistillationResult({
        contentText: 'A '.repeat(200),
        extractionConfidence: 0.3,
      });
      mockDistillContent.mockResolvedValue(lowResult);

      const page = makeMockPage();

      const output = await extractor.extract(page, {
        confidenceThreshold: 0.99,
        minContentLength: 200,
        maxAttempts: 100,
        timeout: 0, // already expired
      });

      // Timeout of 0 should break on the very first check
      expect(output.attempts.length).toBeLessThanOrEqual(1);
    });
  });

  describe('extract - default options', () => {
    it('uses default options when none provided', async () => {
      const result = makeDistillationResult({
        contentText: 'Good content. '.repeat(30),
        extractionConfidence: 0.8,
      });
      mockDistillContent.mockResolvedValue(result);

      const page = makeMockPage();

      const output = await extractor.extract(page);

      expect(output.confidence).toBe(0.8);
      expect(output.distillationResult).toBeDefined();
    });
  });

  describe('extract - handles null bestResult fallback', () => {
    it('performs final extraction when bestResult is null (edge case)', async () => {
      // This tests the fallback path at line 363: if (!bestResult)
      // We simulate this by having timeout 0 so the loop body is never entered,
      // meaning bestResult stays null
      const result = makeDistillationResult({
        contentText: 'Fallback content.',
        extractionConfidence: 0.6,
      });
      mockDistillContent.mockResolvedValue(result);

      const page = makeMockPage();

      const output = await extractor.extract(page, {
        maxAttempts: 3,
        timeout: 0,
      });

      expect(output.content).toBeDefined();
      expect(output.distillationResult).toBeDefined();
    });
  });

  describe('extract - attempt record structure', () => {
    it('creates correct attempt records', async () => {
      const result = makeDistillationResult({
        contentText: 'A '.repeat(200),
        extractionConfidence: 0.9,
        extractionMethod: 'dom-heuristic',
      });
      mockDistillContent.mockResolvedValue(result);

      const page = makeMockPage();

      const output = await extractor.extract(page, {
        confidenceThreshold: 0.8,
        minContentLength: 100,
      });

      expect(output.attempts[0]).toMatchObject({
        attempt: 1,
        method: 'dom-heuristic',
        confidence: 0.9,
        improved: true,
      });
      expect(output.attempts[0].actions).toContain('extracted via dom-heuristic');
    });
  });

  describe('extract - handles missing extractionMethod', () => {
    it('uses "unknown" when extractionMethod is undefined', async () => {
      const result = makeDistillationResult({
        contentText: 'A '.repeat(200),
        extractionConfidence: 0.9,
        extractionMethod: undefined,
      });
      mockDistillContent.mockResolvedValue(result);

      const page = makeMockPage();

      const output = await extractor.extract(page, {
        confidenceThreshold: 0.8,
        minContentLength: 100,
      });

      expect(output.finalMethod).toBe('unknown');
      expect(output.attempts[0].method).toBe('unknown');
    });
  });

  describe('extract - overlay dismissal strategy', () => {
    it('attempts to dismiss overlays when interaction enabled', async () => {
      const lowResult = makeDistillationResult({
        contentText: 'A '.repeat(200),
        extractionConfidence: 0.3,
      });
      const highResult = makeDistillationResult({
        contentText: 'A '.repeat(200),
        extractionConfidence: 0.9,
      });

      mockDistillContent
        .mockResolvedValueOnce(lowResult)
        .mockResolvedValueOnce(highResult);

      // Make overlay visible and dismiss button clickable
      const mockLocator = {
        first: vi.fn().mockReturnValue({
          isVisible: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
        }),
      };

      const page = makeMockPage({
        evaluate: vi.fn()
          .mockResolvedValueOnce(1000)  // initial height (scroll)
          .mockResolvedValueOnce(1000)  // same height
          .mockResolvedValueOnce(true)  // clickMatchingButton for dismiss
          .mockResolvedValue(false),
        locator: vi.fn().mockReturnValue(mockLocator),
      });

      mockScrollFn.mockResolvedValue(undefined);

      const output = await extractor.extract(page, {
        confidenceThreshold: 0.7,
        minContentLength: 100,
        maxAttempts: 3,
        enableScrolling: true,
        enableInteraction: true,
        enableAlternateExtraction: false,
      });

      expect(output.attempts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('extract - strategies disabled via options', () => {
    it('skips scrolling when enableScrolling is false', async () => {
      const lowResult = makeDistillationResult({
        contentText: 'A '.repeat(200),
        extractionConfidence: 0.3,
      });
      mockDistillContent.mockResolvedValue(lowResult);

      const page = makeMockPage({
        evaluate: vi.fn().mockResolvedValue(false),
      });

      await extractor.extract(page, {
        confidenceThreshold: 0.99,
        minContentLength: 100,
        maxAttempts: 2,
        enableScrolling: false,
        enableInteraction: false,
        enableAlternateExtraction: false,
      });

      expect(mockScrollFn).not.toHaveBeenCalled();
    });
  });

  describe('extract - scroll failure is handled gracefully', () => {
    it('catches scroll errors without crashing', async () => {
      const lowResult = makeDistillationResult({
        contentText: 'A '.repeat(200),
        extractionConfidence: 0.3,
      });
      mockDistillContent.mockResolvedValue(lowResult);

      const page = makeMockPage({
        evaluate: vi.fn().mockRejectedValue(new Error('evaluate failed')),
      });
      mockScrollFn.mockResolvedValue(undefined);

      const output = await extractor.extract(page, {
        confidenceThreshold: 0.99,
        minContentLength: 100,
        maxAttempts: 2,
        enableScrolling: true,
        enableInteraction: false,
        enableAlternateExtraction: false,
      });

      // Should not crash
      expect(output).toBeDefined();
      expect(output.confidence).toBe(0.3);
    });
  });
});
